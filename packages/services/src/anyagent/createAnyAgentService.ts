import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { FakeEngine, type EngineAdapter } from "@anyagent/engine-contract";
import { createTaskRuntime, type RuntimeEnvironment } from "@anyagent/runtime";
import { Emitter } from "@zcode/rpc";
import { getConversationWorkspaceDir, getDataBaseDir } from "../paths.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import { createZCodeAdapter } from "./zcodeAdapter.js";
import type { IAnyAgentService } from "./anyAgentService.js";

/** One Host-owned Runtime behind the desktop product channel. */
export function createAnyAgentService(
  agent: IZCodeAgentService,
  readZCodeConfigurationVersion?: () => Promise<string>,
): {
  service: IAnyAgentService;
  close(): void;
} {
  const workDirectory = getConversationWorkspaceDir();
  const databasePath = join(getDataBaseDir(), "anyagent-m1.sqlite");
  mkdirSync(workDirectory, { recursive: true });
  mkdirSync(dirname(databasePath), { recursive: true });
  const environment: RuntimeEnvironment = {
    id: `local:${workDirectory}`,
    kind: "workspace",
    label: "AnyAgent local workspace",
    workDirectory,
    provenance: { source: "desktop-local-host" },
  };
  const zcodeAdapter = createZCodeAdapter({
    agent,
    workspacePath: workDirectory,
    readConfigurationVersion: readZCodeConfigurationVersion,
  });
  const fakeStepDelayMs = Number(process.env.ANYAGENT_FAKE_STEP_DELAY_MS ?? 0);
  const runtime = createTaskRuntime({
    databasePath,
    engines: new Map<string, EngineAdapter>([
      [
        "fake",
        new FakeEngine({
          environment: environment.id,
          now: Date.now,
          autoAdvance: true,
          stepDelayMs:
            Number.isFinite(fakeStepDelayMs) && fakeStepDelayMs > 0 ? fakeStepDelayMs : 0,
        }),
      ],
      ["zcode", zcodeAdapter],
    ]),
  });
  const changes = new Emitter<Parameters<Parameters<typeof runtime.subscribe>[0]>[0]>();
  const unsubscribe = runtime.subscribe((change) => changes.fire(change));
  let engineRefreshInFlight: ReturnType<IAnyAgentService["listEngines"]> | null = null;
  function listEngines(): ReturnType<IAnyAgentService["listEngines"]> {
    if (engineRefreshInFlight) return engineRefreshInFlight;
    const refresh = runtime.refreshEngines();
    let shared: typeof refresh;
    shared = refresh.finally(() => {
      if (engineRefreshInFlight === shared) engineRefreshInFlight = null;
    });
    engineRefreshInFlight = shared;
    return shared;
  }
  const service: IAnyAgentService = {
    onDidChange: changes.event,
    async getCreateTaskContext() {
      return { environment, credentialSource: { kind: "unknown", label: "Selected Engine" } };
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
    createTask: ({ engineId }) =>
      runtime.createTask({
        engineId,
        environment,
        authorization: {
          id: `authorization_${randomUUID()}`,
          environmentId: environment.id,
          issuer: "host",
          expiresAt: null,
          scopes: [
            "session.create",
            "execution.run",
            "approval.respond",
            "user-input.respond",
            "execution.interrupt",
          ],
        },
        credentialSource:
          engineId === "fake"
            ? { kind: "none", label: "Controlled Fake Engine" }
            : { kind: "engine", label: "ZCode provider configuration in AnyAgent home" },
      }),
    async submitInput(input) {
      await runtime.submitInput(input);
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
      zcodeAdapter.dispose();
      runtime.close();
    },
  };
}
