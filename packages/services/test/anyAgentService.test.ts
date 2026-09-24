import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAnyAgentService } from "../src/anyagent/createAnyAgentService.js";
import { setDataBaseDir } from "../src/paths.js";
import type { IPromptAttachmentTransferService } from "../src/prompt-attachment-transfer/promptAttachmentTransfer.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import { readTrustedZCodeAgentV4Connection } from "../src/zcode-agent/zcodeAgentConnectionScope.js";

async function waitForCompleted(
  service: ReturnType<typeof createAnyAgentService>["service"],
  taskId: string,
  count: number,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const history = await service.getHistory(taskId);
    if (
      history?.executions.length === count &&
      history.executions.every((run) => run.status === "completed")
    )
      return history;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const history = await service.getHistory(taskId);
  assert.fail(
    `Fake Engine did not complete through the Host service: ${JSON.stringify({
      inputs: history?.inputs.map((item) => item.status),
      executions: history?.executions.map((item) => item.status),
      issues: history?.integrityIssues.map((item) => item.type),
    })}`,
  );
}

test("one Host service drives Fake multiround and reports ZCode unavailability without fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-host-"));
  setDataBaseDir(directory);
  const host = createAnyAgentService({} as IZCodeAgentService);
  let changes = 0;
  const subscription = host.service.onDidChange(() => changes++);
  try {
    const engines = await host.service.listEngines();
    const fakeEngine = engines.find((item) => item.engineId === "fake")!;
    assert.equal(fakeEngine.capabilities["execution.run"].availability, "available");
    assert.equal(fakeEngine.capabilities["session.compact"].support, "unsupported");
    assert.equal(fakeEngine.state, "current");
    assert.notEqual(fakeEngine.observedAt, null);
    assert.equal(
      engines.find((item) => item.engineId === "zcode")?.capabilities["execution.run"].availability,
      "temporarily-unavailable",
    );
    await assert.rejects(host.service.createTask({ engineId: "zcode" }));

    const task = await host.service.createTask({ engineId: "fake" });
    assert.equal(task.engine.capabilities["execution.run"].availability, "available");
    assert.equal(task.currentEngine.state, "current");
    assert.equal(task.currentEngine.capabilities["execution.run"].availability, "available");
    assert.deepEqual((await host.service.getTask(task.id))?.engine, task.engine);
    assert.deepEqual((await host.service.getTask(task.id))?.currentEngine, task.currentEngine);
    assert.equal(task.environment.workDirectory, join(directory, ".zcode", "workspace", "default"));
    assert.equal(task.credentialSource.kind, "none");
    const input = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await assert.rejects(
      host.service.compactSession(input),
      /no native Session compaction command/i,
    );
    assert.deepEqual((await host.service.getHistory(task.id))?.compactOperations, []);
    await host.service.submitInput({ ...input, text: "first" });
    await waitForCompleted(host.service, task.id, 1);
    await host.service.submitInput({ ...input, text: "second" });
    const history = await waitForCompleted(host.service, task.id, 2);
    assert.deepEqual(
      history.inputs.map((item) => item.sessionId),
      [task.session.id, task.session.id],
    );
    assert.ok(changes > 0);

    const other = await host.service.createTask({ engineId: "fake" });
    assert.notEqual(other.participant.id, task.participant.id);
    assert.notEqual(other.session.id, task.session.id);
    await assert.rejects(
      host.service.submitInput({ ...input, taskId: other.id, text: "wrong session" }),
    );
  } finally {
    subscription.dispose();
    host.close();
    setDataBaseDir(null);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host service forwards text queue intent and cancellation to persisted Runtime inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-host-queue-"));
  setDataBaseDir(directory);
  const host = createAnyAgentService({} as IZCodeAgentService);
  try {
    const task = await host.service.createTask({ engineId: "fake" });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await Promise.all([
      host.service.submitInput({ ...identity, text: "A" }),
      host.service.submitInput({
        ...identity,
        text: "B",
        delivery: "queue",
        idempotencyKey: "service-queue-b",
      }),
    ]);
    const queued = (await host.service.getHistory(task.id))?.inputs.find(
      (input) => input.text === "B",
    );
    assert.ok(queued);
    assert.equal(queued.status, "queued");
    await host.service.cancelQueuedInput({ ...identity, inputId: queued.id });
    assert.equal(
      (await host.service.getHistory(task.id))?.inputs.find((input) => input.id === queued.id)
        ?.status,
      "cancelled",
    );
    const history = await waitForCompleted(host.service, task.id, 1);
    assert.equal(history.inputs.length, 2);
    assert.equal(history.executions.length, 1);
  } finally {
    host.close();
    setDataBaseDir(null);
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent engine list refreshes share only the in-flight probe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-engine-refresh-"));
  setDataBaseDir(directory);
  let initializeCalls = 0;
  let rejectInitialProbe!: (error: Error) => void;
  const host = createAnyAgentService({
    initialize: () => {
      initializeCalls++;
      if (initializeCalls === 1) {
        return new Promise((_, reject) => {
          rejectInitialProbe = reject;
        });
      }
      return Promise.resolve({ available: true, workspaceKey: "test-workspace" });
    },
  } as unknown as IZCodeAgentService);
  try {
    const first = host.service.listEngines();
    const joined = host.service.listEngines();
    assert.strictEqual(joined, first);
    assert.equal(initializeCalls, 1);

    rejectInitialProbe(new Error("probe transport failed"));
    const [firstResult, joinedResult] = await Promise.all([first, joined]);
    assert.strictEqual(joinedResult, firstResult);
    assert.equal(firstResult.find((engine) => engine.engineId === "zcode")?.state, "current");
    assert.equal(
      firstResult.find((engine) => engine.engineId === "zcode")?.capabilities["execution.run"]
        .availability,
      "temporarily-unavailable",
    );

    const recovered = await host.service.listEngines();
    assert.equal(initializeCalls, 2);
    assert.equal(recovered.find((engine) => engine.engineId === "zcode")?.state, "current");
    assert.equal(
      recovered.find((engine) => engine.engineId === "zcode")?.capabilities["execution.run"]
        .availability,
      "available",
    );

    await host.service.listEngines();
    assert.equal(initializeCalls, 3);
  } finally {
    host.close();
    setDataBaseDir(null);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host stages a renderer-selected local path through the existing transfer service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-host-attachment-"));
  setDataBaseDir(directory);
  let stagedParams: Parameters<IPromptAttachmentTransferService["stage"]>[0] | undefined;
  const transferService = {
    stage: async (params: Parameters<IPromptAttachmentTransferService["stage"]>[0]) => {
      stagedParams = params;
      return {
        operationId: params.operationId,
        ref: `host-resolved:${params.localPath}`,
        bytes: 17,
        staged: false,
      };
    },
  } as unknown as IPromptAttachmentTransferService;
  const host = createAnyAgentService(
    {} as IZCodeAgentService,
    undefined,
    undefined,
    transferService,
  );
  try {
    const task = await host.service.createTask({ engineId: "fake" });
    const attachment = await host.service.stageAttachment({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
      localPath: "/tmp/selected.md",
      fileName: "selected.md",
      mimeType: "text/markdown",
      sizeBytes: 0,
    });
    assert.equal(stagedParams?.localPath, "/tmp/selected.md");
    assert.equal(stagedParams?.workspacePath, task.environment.workDirectory);
    assert.equal(stagedParams?.sessionId, task.session.nativeSessionId);
    assert.equal(stagedParams?.operationId, attachment.id);
    assert.deepEqual(attachment, {
      id: attachment.id,
      fileName: "selected.md",
      mimeType: "text/markdown",
      sizeBytes: 17,
    });
    assert.equal(JSON.stringify(attachment).includes("/tmp/selected.md"), false);

    await host.service.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
      text: "summarize selected.md",
      attachments: [attachment],
    });
    const history = await waitForCompleted(host.service, task.id, 1);
    assert.deepEqual(history.inputs[0]?.attachments, [attachment]);
  } finally {
    host.close();
    setDataBaseDir(null);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Harness tasks use their selected project workspace without changing another Task's routing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-project-workspace-"));
  const project = join(directory, "project");
  await mkdir(project);
  setDataBaseDir(directory);
  const nativeWorkspaces: string[] = [];
  const host = createAnyAgentService({
    initialize: async ({ workspacePath }: { workspacePath: string }) => ({
      available: true,
      workspaceKey: workspacePath,
    }),
    sendConversationCommandV4: async ({ workspacePath }: { workspacePath: string }) => {
      nativeWorkspaces.push(workspacePath);
      return {
        status: "accepted",
        result: { type: "createSession", sessionId: `native-${nativeWorkspaces.length}` },
      };
    },
  } as unknown as IZCodeAgentService);
  try {
    const defaultTask = await host.service.createTask({ engineId: "fake" });
    const projectTask = await host.service.createTask({
      engineId: "zcode",
      workspacePath: project,
    });
    assert.equal(projectTask.environment.workDirectory, project);
    assert.equal(projectTask.session.nativeSessionId, "native-1");
    assert.deepEqual(nativeWorkspaces, [project]);
    assert.notEqual(defaultTask.session.id, projectTask.session.id);
    assert.notEqual(defaultTask.participant.id, projectTask.participant.id);

    const projectEngines = await host.service.listEngines({ workspacePath: project });
    const defaultEngines = await host.service.listEngines();
    assert.equal(
      projectEngines.find((item) => item.engineId === "zcode")?.environment,
      `local:${project}`,
    );
    assert.equal(
      defaultEngines.find((item) => item.engineId === "zcode")?.environment,
      `local:${join(directory, ".zcode", "workspace", "default")}`,
    );
    assert.equal(
      (await host.service.getTask(projectTask.id))?.engine.environment,
      `local:${project}`,
    );
    assert.equal((await host.service.getTask(projectTask.id))?.currentEngine.state, "current");

    const anotherDefaultTask = await host.service.createTask({ engineId: "fake" });
    const input = {
      taskId: defaultTask.id,
      participantId: defaultTask.participant.id,
      sessionId: defaultTask.session.id,
      authorizationId: defaultTask.authorizationId,
    };
    await host.service.submitInput({ ...input, text: "after project" });
    await waitForCompleted(host.service, defaultTask.id, 1);
    assert.equal(anotherDefaultTask.environment.id, defaultTask.environment.id);
    assert.equal((await host.service.getTask(projectTask.id))?.environment.workDirectory, project);
    await assert.rejects(
      host.service.submitInput({ ...input, taskId: projectTask.id, text: "wrong Task" }),
    );
    await rm(project, { recursive: true });
    await assert.rejects(
      async () => host.service.createTask({ engineId: "zcode", workspacePath: project }),
      /Harness 工作区必须是现有的本地绝对路径/,
    );
    assert.equal((await host.service.getTask(projectTask.id))?.environment.workDirectory, project);
    assert.ok((await host.service.listTasks()).some((task) => task.id === projectTask.id));
  } finally {
    host.close();
    setDataBaseDir(null);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host-owned Harness reads native assistant rows through a trusted ZCode connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-feedback-connection-"));
  setDataBaseDir(directory);
  let receiveEvent: ((event: unknown) => void) | undefined;
  let rowReads = 0;
  const host = createAnyAgentService(
    {
      initialize: async () => ({ available: true, workspaceKey: directory }),
      onDynamicSessionEvent: () => (listener: (event: unknown) => void) => {
        receiveEvent = listener;
        return { dispose: () => (receiveEvent = undefined) };
      },
      onAgentRuntimeLifecycle: () => ({ dispose() {} }),
      sendConversationCommandV4: async ({
        envelope,
      }: {
        envelope: { type: string; commandId: string };
      }) =>
        envelope.type === "createSession"
          ? {
              status: "accepted",
              commandId: envelope.commandId,
              result: { type: "createSession", sessionId: "native-feedback-session" },
            }
          : {
              status: "accepted",
              commandId: envelope.commandId,
              result: {
                type: "inputAccepted",
                inputId: "native-feedback-input",
                delivery: "startNow",
              },
            },
      conversationRowsRangeV4: async (params: unknown) => {
        assert.equal(readTrustedZCodeAgentV4Connection(params)?.clientMode, "desktop-continuous");
        rowReads++;
        return {
          rows: [
            {
              rowId: 1,
              entityId: "native-feedback-message",
              kind: "assistantText",
              feedback: "like",
            },
          ],
          atSeq: 1,
          atRevision: 1,
          atLogEpoch: "native-log",
          hasMore: false,
        };
      },
    } as unknown as IZCodeAgentService,
    undefined,
    async () => undefined,
  );
  try {
    const task = await host.service.createTask({ engineId: "zcode" });
    await host.service.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
      text: "reply",
      submissionConfig: { modelSelection: { providerId: "provider-a", modelId: "model-a" } },
    });
    const emit = (eventId: string, seq: number, type: string, payload: unknown) =>
      receiveEvent?.({
        type: "session.event",
        event: {
          eventId,
          seq,
          sessionId: "native-feedback-session",
          turnId: "native-feedback-turn",
          timestamp: seq,
          type,
          payload,
        },
      });
    emit("start", 1, "turn.started", {
      inputId: "native-feedback-input",
      foregroundExecutionId: "native-feedback-work",
    });
    emit("delta", 2, "model.streaming", {
      kind: "text_delta",
      delta: "done",
      assistantMessageId: "native-feedback-message",
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        (await host.service.getHistory(task.id))?.events.some(
          (event) => event.type === "message.delta",
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.deepEqual(await host.service.getAssistantFeedback(task.id), {
      state: "current",
      values: { "native-feedback-message": "like" },
    });
    assert.equal(rowReads, 1);
  } finally {
    host.close();
    setDataBaseDir(null);
    await rm(directory, { recursive: true, force: true });
  }
});
