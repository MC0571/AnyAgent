import {
  RuntimeEligibilityError,
  type RuntimeAuthorization,
  type RuntimeEnvironment,
  type RuntimeTask,
  type TaskRuntime,
} from "@anyagent/runtime";
import type { IConversationShareService } from "../conversation-share/conversationShare.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IAnyAgentService } from "./anyAgentService.js";

type ImportWorkspace = { workspacePath?: string; workspaceIdentity?: string };

interface SharedContextImporterOptions {
  conversationShareService?: IConversationShareService;
  environmentFor(workspace?: ImportWorkspace): RuntimeEnvironment;
  listEngines: IAnyAgentService["listEngines"];
  hostAuthorization(environmentId: string): RuntimeAuthorization;
  runtime: Pick<TaskRuntime, "listTasks" | "adoptImportedSession">;
  agent: Pick<IZCodeAgentService, "readSession">;
  registerPendingSharedContext(
    target: RuntimeEnvironment,
    sessionId: string,
    contextId: string,
  ): void;
}

/** Host boundary for importing native shared context and adopting its verified Session. */
export function createSharedContextImporter({
  conversationShareService,
  environmentFor,
  listEngines,
  hostAuthorization,
  runtime,
  agent,
  registerPendingSharedContext,
}: SharedContextImporterOptions): IAnyAgentService["importSharedContext"] {
  const importInFlight = new Map<
    string,
    Promise<Awaited<ReturnType<IAnyAgentService["importSharedContext"]>>>
  >();
  const adoptionInFlight = new Map<
    string,
    Promise<Awaited<ReturnType<typeof runtime.adoptImportedSession>>>
  >();

  return async (input) => {
    if (!conversationShareService)
      throw new RuntimeEligibilityError(
        "Conversation share import is unavailable in this Host.",
        "unsupported",
      );
    if (!input.shareCode.trim() || !input.clientRequestId.trim())
      throw new RuntimeEligibilityError("A share code and request identity are required.");
    const target = environmentFor({ workspacePath: input.workspacePath });
    const workspacePath = target.workDirectory;
    if (target.kind !== "workspace" || !workspacePath || target.id !== `local:${workspacePath}`)
      throw new RuntimeEligibilityError(
        "Shared-context imports require a validated local workspace.",
        "ownership",
      );
    const requestKey = `${target.id}\u0000${input.clientRequestId}\u0000${input.shareCode}`;
    const inFlight = importInFlight.get(requestKey);
    if (inFlight) return inFlight;

    const operation = (async () => {
      const current = (await listEngines({ workspacePath })).find(
        (engine) => engine.engineId === "zcode",
      );
      if (
        !current ||
        current.state !== "current" ||
        current.capabilities["session.create"]?.availability !== "available" ||
        current.capabilities["session.resume"]?.availability !== "available"
      )
        throw new RuntimeEligibilityError(
          "ZCode Session creation and recovery must be available before import.",
        );

      // Validate the local target and mint the Host grant before import writes native files.
      // Runtime independently rechecks the grant and resume capability during adoption.
      const authorization = hostAuthorization(target.id);
      const imported = await conversationShareService.importShare(
        {
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          targetWorkspacePath: workspacePath,
          ...(input.locale ? { locale: input.locale } : {}),
        },
        input.clientRequestId,
      );
      if (
        imported.workspacePath !== target.workDirectory ||
        imported.workspaceIdentity ||
        !imported.sessionId.startsWith("share-import-") ||
        !imported.contextId.trim() ||
        !imported.title.trim() ||
        !imported.shareUrl.trim()
      )
        throw new RuntimeEligibilityError(
          "Imported context did not remain in the selected local workspace.",
          "ownership",
        );

      const tasks = runtime.listTasks();
      const existing = tasks.find((task) => task.session.nativeSessionId === imported.sessionId);
      if (existing) {
        if (isMatchingOwner(existing, target.id, imported.sessionId, imported.contextId))
          return existing;
        throw new RuntimeEligibilityError(
          "The imported native Session belongs to another Task.",
          "ownership",
        );
      }
      if (tasks.some((task) => task.sharedContext?.contextId === imported.contextId))
        throw new RuntimeEligibilityError(
          "The imported context is already reserved by a Task whose native Session identity is unresolved.",
          "ownership",
        );

      const native = await agent.readSession({
        workspacePath,
        sessionId: imported.sessionId,
      });
      if (
        native.session.sessionId !== imported.sessionId ||
        native.projection.turnCount !== 0 ||
        !native.messages.some((message) => {
          const info = message.info;
          return (
            info.role === "user" &&
            info.source === "shared_context" &&
            info.visibility === "model-only" &&
            info.metadata?.contextId === imported.contextId
          );
        })
      )
        throw new RuntimeEligibilityError(
          "Native import provenance or pristine state could not be verified.",
          "ownership",
        );

      const adoptionKey = `${target.id}\u0000${imported.sessionId}`;
      const pendingAdoption = adoptionInFlight.get(adoptionKey);
      if (pendingAdoption) {
        const owner = await pendingAdoption;
        if (!isMatchingOwner(owner, target.id, imported.sessionId, imported.contextId))
          throw new RuntimeEligibilityError(
            "The native import is being adopted for another Task.",
            "ownership",
          );
        return owner;
      }

      const adoption = runtime.adoptImportedSession({
        engineId: "zcode",
        environment: target,
        authorization,
        credentialSource: {
          kind: "engine",
          label: "ZCode provider configuration in AnyAgent home",
        },
        nativeSessionId: imported.sessionId,
        sharedContext: {
          contextId: imported.contextId,
          title: imported.title,
          shareUrl: imported.shareUrl,
        },
      });
      adoptionInFlight.set(adoptionKey, adoption);
      let task: RuntimeTask;
      try {
        task = await adoption;
      } catch (error) {
        // Recover only an exact Task owner if another Host path claimed the native Session.
        const owner = runtime
          .listTasks()
          .find((candidate) => candidate.session.nativeSessionId === imported.sessionId);
        if (!owner || !isMatchingOwner(owner, target.id, imported.sessionId, imported.contextId))
          throw error;
        return owner;
      } finally {
        if (adoptionInFlight.get(adoptionKey) === adoption) adoptionInFlight.delete(adoptionKey);
      }

      registerPendingSharedContext(target, imported.sessionId, imported.contextId);
      return task;
    })();
    importInFlight.set(requestKey, operation);
    try {
      return await operation;
    } finally {
      if (importInFlight.get(requestKey) === operation) importInFlight.delete(requestKey);
    }
  };
}

function isMatchingOwner(
  task: RuntimeTask,
  environmentId: string,
  nativeSessionId: string,
  contextId: string,
): boolean {
  return (
    task.engine.engineId === "zcode" &&
    task.environment.id === environmentId &&
    task.session.nativeSessionId === nativeSessionId &&
    task.sharedContext?.contextId === contextId
  );
}
