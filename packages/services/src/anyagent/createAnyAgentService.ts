import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { FakeEngine, type EngineAdapter } from "@anyagent/engine-contract";
import {
  createTaskRuntime,
  RuntimeEligibilityError,
  type RuntimeEnvironment,
} from "@anyagent/runtime";
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
          agent,
          workspacePath: path,
          readConfigurationVersion: readZCodeConfigurationVersion,
        }),
      };
      enginesByEnvironment.set(target.id, engines);
    }
    return engines;
  }
  const defaultEngines = enginesFor(environment);
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
    createTask: ({ engineId, ...workspace }) => {
      const target = environmentFor(workspace);
      return runtime.createTask({
        engineId,
        environment: target,
        authorization: {
          id: `authorization_${randomUUID()}`,
          environmentId: target.id,
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
      });
    },
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
      for (const engines of enginesByEnvironment.values()) engines.zcode.dispose();
      runtime.close();
    },
  };
}
