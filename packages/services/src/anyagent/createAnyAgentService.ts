import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { FakeEngine, type EngineAdapter } from "@anyagent/engine-contract";
import {
  createTaskRuntime,
  RuntimeEligibilityError,
  type RuntimeAuthorization,
  type RuntimeEnvironment,
} from "@anyagent/runtime";
import type { ModelSelection } from "@zcode/shared/zcode-protocol-v4";
import { Emitter } from "@zcode/rpc";
import { getConversationWorkspaceDir, getDataBaseDir } from "../paths.js";
import type { IPromptAttachmentTransferService } from "../prompt-attachment-transfer/promptAttachmentTransfer.js";
import type { IConversationShareService } from "../conversation-share/conversationShare.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import { createZCodeAgentConnectionScope } from "../zcode-agent/zcodeAgentConnectionScope.js";
import { createSharedContextImporter } from "./sharedContextImporter.js";
import { createZCodeAdapter } from "./zcodeAdapter.js";
import type { IAnyAgentService } from "./anyAgentService.js";

/** One Host-owned Runtime behind the desktop product channel. */
export function createAnyAgentService(
  agent: IZCodeAgentService,
  readZCodeConfigurationVersion?: () => Promise<string>,
  validateModelSelection?: (selection: ModelSelection) => Promise<string | undefined>,
  attachmentTransferService?: IPromptAttachmentTransferService,
  conversationShareService?: IConversationShareService,
): {
  service: IAnyAgentService;
  close(): void;
} {
  const workDirectory = getConversationWorkspaceDir();
  const agentScope = createZCodeAgentConnectionScope(agent, {
    connectionId: `anyagent-host-${randomUUID()}`,
    clientMode: "desktop-continuous",
    role: "trusted-host-relay",
  });
  const databasePath = join(getDataBaseDir(), "anyagent-m1.sqlite");
  mkdirSync(workDirectory, { recursive: true });
  mkdirSync(dirname(databasePath), { recursive: true });
  const fakeStepDelayMs = Number(process.env.ANYAGENT_FAKE_STEP_DELAY_MS ?? 0);
  function environmentFor(workspace?: { workspacePath?: string; workspaceIdentity?: string }) {
    if (workspace?.workspaceIdentity)
      throw new RuntimeEligibilityError("M1 Harness 目前仅支持本地工作区。");
    const path = workspace?.workspacePath ?? workDirectory;
    let isDirectory = false;
    try {
      isDirectory = isAbsolute(path) && statSync(path).isDirectory();
    } catch {
      // A removed project must reject new work without hiding its saved Task history.
    }
    if (!isDirectory) throw new RuntimeEligibilityError("Harness 工作区必须是现有的本地绝对路径。");
    return {
      id: `local:${path}`,
      kind: "workspace",
      label: "AnyAgent local workspace",
      workDirectory: path,
      provenance: { source: "desktop-local-host" },
    } satisfies RuntimeEnvironment;
  }
  const environment = environmentFor();
  const enginesByEnvironment = new Map<
    string,
    { fake: FakeEngine; zcode: ReturnType<typeof createZCodeAdapter> }
  >();
  function enginesFor(target: RuntimeEnvironment) {
    let engines = enginesByEnvironment.get(target.id);
    if (!engines) {
      const path = target.workDirectory;
      if (!path || target.id !== `local:${path}`) {
        throw new RuntimeEligibilityError("Harness Task 的工作区身份无效。");
      }
      engines = {
        fake: new FakeEngine({
          environment: target.id,
          now: Date.now,
          autoAdvance: true,
          stepDelayMs:
            Number.isFinite(fakeStepDelayMs) && fakeStepDelayMs > 0 ? fakeStepDelayMs : 0,
        }),
        zcode: createZCodeAdapter({
          agent: agentScope.service,
          workspacePath: path,
          readConfigurationVersion: readZCodeConfigurationVersion,
          validateModelSelection,
        }),
      };
      enginesByEnvironment.set(target.id, engines);
    }
    return engines;
  }
  const defaultEngines = enginesFor(environment);
  function hostAuthorization(environmentId: string): RuntimeAuthorization {
    return {
      id: `authorization_${randomUUID()}`,
      environmentId,
      issuer: "host",
      expiresAt: null,
      scopes: [
        "session.create",
        "session.fork",
        "session.compact",
        "execution.run",
        "execution.revise",
        "assistant.feedback",
        "workspace.file-rewind",
        "approval.respond",
        "user-input.respond",
        "execution.interrupt",
      ],
    };
  }
  const runtime = createTaskRuntime({
    databasePath,
    engines: new Map<string, EngineAdapter>([
      ["fake", defaultEngines.fake],
      ["zcode", defaultEngines.zcode],
    ]),
    engineForEnvironment: (engineId, target) => {
      const engines = enginesFor(target);
      return engineId === "fake" ? engines.fake : engineId === "zcode" ? engines.zcode : undefined;
    },
    ...(attachmentTransferService
      ? {
          stageAttachment: async (request) => {
            const workspacePath = request.environment.workDirectory;
            if (
              request.environment.kind !== "workspace" ||
              !workspacePath ||
              request.environment.id !== `local:${workspacePath}` ||
              !isAbsolute(request.localPath)
            ) {
              throw new RuntimeEligibilityError(
                "Harness attachments require a local file and the Task's local workspace.",
                "unsupported",
              );
            }
            const staged = await attachmentTransferService.stage({
              operationId: request.attachmentId,
              sessionId: request.nativeSessionId,
              workspacePath,
              localPath: request.localPath,
              fileName: request.fileName,
              mime: request.mimeType,
              sizeBytes: request.sizeBytes,
            });
            if (staged.operationId !== request.attachmentId)
              throw new RuntimeEligibilityError(
                "Host attachment staging returned a mismatched ID.",
              );
            return { locator: staged.ref, sizeBytes: staged.bytes };
          },
        }
      : {}),
  });
  const changes = new Emitter<Parameters<Parameters<typeof runtime.subscribe>[0]>[0]>();
  const unsubscribe = runtime.subscribe((change) => changes.fire(change));
  const engineRefreshInFlight = new Map<string, ReturnType<IAnyAgentService["listEngines"]>>();
  function listEngines(
    workspace?: Parameters<IAnyAgentService["listEngines"]>[0],
  ): ReturnType<IAnyAgentService["listEngines"]> {
    const target = environmentFor(workspace);
    const pending = engineRefreshInFlight.get(target.id);
    if (pending) return pending;
    const refresh = runtime.refreshEngines(target);
    let shared: typeof refresh;
    shared = refresh.finally(() => {
      if (engineRefreshInFlight.get(target.id) === shared) engineRefreshInFlight.delete(target.id);
    });
    engineRefreshInFlight.set(target.id, shared);
    return shared;
  }
  const importSharedContext = createSharedContextImporter({
    conversationShareService,
    environmentFor,
    listEngines,
    hostAuthorization,
    runtime,
    agent: agentScope.service,
    registerPendingSharedContext(target, sessionId, contextId) {
      enginesFor(target).zcode.registerPendingSharedContext(sessionId, contextId);
    },
  });
  const service: IAnyAgentService = {
    onDidChange: changes.event,
    async getCreateTaskContext(workspace) {
      return {
        environment: environmentFor(workspace),
        credentialSource: { kind: "unknown", label: "Selected Engine" },
      };
    },
    listEngines,
    async listTasks() {
      return runtime.listTasks();
    },
    async getTask(taskId) {
      return runtime.getTask(taskId);
    },
    async getHistory(taskId) {
      return runtime.getHistory(taskId);
    },
    async getTaskSkillReferenceCatalog(input) {
      const catalog = await runtime.readQualifiedTaskSession(input, async (target) => {
        if (target.engineId !== "zcode")
          throw new RuntimeEligibilityError(
            "Session Skill catalogs are available only for ZCode Tasks.",
            "unsupported",
          );
        const workspacePath = target.environment.workDirectory;
        if (target.environment.kind !== "workspace" || !workspacePath)
          throw new RuntimeEligibilityError(
            "The Task does not have a readable workspace for its Session Skill catalog.",
            "unsupported",
          );
        return agentScope.service.getSkillReferenceCatalog({
          workspacePath,
          sessionId: target.nativeSessionId,
        });
      });
      if (catalog.authority !== "session")
        throw new RuntimeEligibilityError(
          "The native Engine did not verify this Skill catalog against the Task Session.",
          "ownership",
        );
      return {
        skills: catalog.skills.map(({ name, description, scope, pluginName }) => ({
          name,
          description,
          scope,
          ...(pluginName ? { pluginName } : {}),
        })),
      };
    },
    async getTaskPluginCatalog(input) {
      const catalog = await runtime.readQualifiedTaskSession(input, async (target) => {
        if (target.engineId !== "zcode")
          throw new RuntimeEligibilityError(
            "CLI plugin catalogs are available only for ZCode Tasks.",
            "unsupported",
          );
        const workspacePath = target.environment.workDirectory;
        if (target.environment.kind !== "workspace" || !workspacePath)
          throw new RuntimeEligibilityError(
            "The Task does not have a local workspace for its CLI plugin catalog.",
            "unsupported",
          );
        return agentScope.service.listPlugins({ workspacePath });
      });
      return {
        plugins: catalog.plugins.map(({ id, name, enabled, source, marketplace, version }) => ({
          id,
          name,
          enabled,
          source,
          marketplace,
          ...(version ? { version } : {}),
        })),
      };
    },
    async getTaskGoalStatus(input) {
      return runtime.readQualifiedTaskSession(input, async (target) => {
        if (target.engineId !== "zcode")
          throw new RuntimeEligibilityError(
            "Session goals are available only for ZCode Tasks.",
            "unsupported",
          );
        return enginesFor(target.environment).zcode.readSessionGoal(target.nativeSessionId);
      });
    },
    async restoreTaskSession(input) {
      return runtime.restoreTaskSession(input);
    },
    async reconcileExecution(input) {
      return runtime.reconcileExecution(input);
    },
    async reconcileInput(input) {
      return runtime.reconcileInput(input);
    },
    async getAssistantFeedback(taskId) {
      const task = runtime.getTask(taskId);
      if (!task || task.engine.engineId !== "zcode" || !task.session.nativeSessionId)
        return { state: "unknown", reason: "No attached ZCode Session belongs to this Task." };
      const history = runtime.getHistory(taskId);
      const messageIds = [
        ...new Set(
          history?.events
            .filter(
              (event) =>
                event.type === "message.delta" &&
                event.source === "engine" &&
                event.duplicateOf === null &&
                typeof event.payload.messageId === "string",
            )
            .map((event) => event.payload.messageId as string) ?? [],
        ),
      ];
      return enginesFor(task.environment).zcode.readAssistantFeedback(
        task.session.nativeSessionId,
        messageIds,
      );
    },
    createTask: ({ engineId, ...workspace }) => {
      const target = environmentFor(workspace);
      return runtime.createTask({
        engineId,
        environment: target,
        authorization: hostAuthorization(target.id),
        credentialSource:
          engineId === "fake"
            ? { kind: "none", label: "Controlled Fake Engine" }
            : { kind: "engine", label: "ZCode provider configuration in AnyAgent home" },
      });
    },
    importSharedContext,
    async forkTask(input) {
      const source = runtime.getTask(input.taskId);
      if (!source) throw new RuntimeEligibilityError("Fork source Task does not exist.");
      return runtime.forkTask({
        ...input,
        authorization: hostAuthorization(source.environment.id),
      });
    },
    async stageAttachment(input) {
      return runtime.stageAttachment(input);
    },
    async submitInput(input) {
      const task = runtime.getTask(input.taskId);
      if (task?.engine.engineId === "zcode" && task.sharedContext && task.session.nativeSessionId) {
        const history = runtime.getHistory(task.id);
        if (
          history &&
          !history.inputs.some((entry) => entry.acceptedAt !== null || entry.status === "unknown")
        )
          enginesFor(task.environment).zcode.registerPendingSharedContext(
            task.session.nativeSessionId,
            task.sharedContext.contextId,
          );
      }
      await runtime.submitInput(input);
    },
    async cancelQueuedInput(input) {
      runtime.cancelQueuedInput(input);
    },
    async moveQueuedInput(input) {
      runtime.moveQueuedInput(input);
    },
    async resumeQueuedInputs(input) {
      await runtime.resumeQueuedInputs(input);
    },
    async sendQueuedInputNow(input) {
      return runtime.sendQueuedInputNow(input);
    },
    async reviseTurn(input) {
      await runtime.reviseTurn(input);
    },
    async setAssistantFeedback(input) {
      return runtime.setAssistantFeedback(input);
    },
    async getExecutionFileChanges(input) {
      return runtime.getExecutionFileChanges(input);
    },
    async previewFileRewind(input) {
      return runtime.previewFileRewind(input);
    },
    async applyFileRewind(input) {
      return runtime.applyFileRewind(input);
    },
    async compactSession(input) {
      return runtime.compactSession(input);
    },
    async replyToApproval(input) {
      await runtime.replyToApproval(input);
    },
    async replyToUserInput(input) {
      await runtime.replyToUserInput(input);
    },
    async requestStop(input) {
      await runtime.requestStop(input);
    },
  };
  return {
    service,
    close() {
      unsubscribe();
      changes.dispose();
      for (const engines of enginesByEnvironment.values()) engines.zcode.dispose();
      void agentScope.dispose();
      runtime.close();
    },
  };
}
