import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAnyAgentService } from "../src/anyagent/createAnyAgentService.js";
import { setDataBaseDir } from "../src/paths.js";
import type { IConversationShareService } from "../src/conversation-share/conversationShare.js";
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
    const reattached = await host.service.restoreTaskSession(input);
    assert.equal(reattached.id, task.id);
    assert.equal(reattached.participant.id, task.participant.id);
    assert.equal(reattached.session.id, task.session.id);
    assert.equal(reattached.session.nativeSessionId, task.session.nativeSessionId);
    assert.equal((await host.service.getHistory(task.id))?.inputs.length, 2);
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

test("Host cold ZCode recovery keeps Task ownership and waits for compatible configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-host-zcode-restore-"));
  setDataBaseDir(directory);
  let configurationVersion = "provider-config-original";
  let nextNativeSession = 0;
  let nativeResumeCalls = 0;
  const commands: string[] = [];
  const agent = {
    initialize: async ({ workspacePath }: { workspacePath: string }) => ({
      available: true,
      workspaceKey: workspacePath,
    }),
    onDynamicSessionEvent: () => (_listener: (event: unknown) => void) => ({ dispose() {} }),
    onAgentRuntimeLifecycle: () => ({ dispose() {} }),
    resumeSession: async ({ sessionId }: { sessionId: string }) => {
      nativeResumeCalls++;
      return {
        session: { sessionId },
        settings: { model: { current: { providerId: "provider-a" } } },
      };
    },
    sendConversationCommandV4: async ({
      envelope,
    }: {
      envelope: { type: string; commandId: string };
    }) => {
      commands.push(envelope.type);
      if (envelope.type === "createSession")
        return {
          status: "accepted",
          commandId: envelope.commandId,
          result: { type: "createSession", sessionId: `native-session-${++nextNativeSession}` },
        };
      return {
        status: "accepted",
        commandId: envelope.commandId,
        result: { type: "inputAccepted", inputId: "native-input", delivery: "startNow" },
      };
    },
  } as unknown as IZCodeAgentService;
  const createHost = () =>
    createAnyAgentService(
      agent,
      async () => configurationVersion,
      async () => undefined,
    );
  let host = createHost();
  try {
    const first = await host.service.createTask({ engineId: "zcode" });
    const second = await host.service.createTask({ engineId: "zcode" });
    assert.notEqual(first.session.nativeSessionId, second.session.nativeSessionId);
    const identity = {
      taskId: first.id,
      participantId: first.participant.id,
      sessionId: first.session.id,
      authorizationId: first.authorizationId,
    };
    host.close();
    configurationVersion = "provider-config-changed";
    host = createHost();
    assert.equal((await host.service.getTask(first.id))?.session.status, "unknown");
    await assert.rejects(host.service.restoreTaskSession(identity), /configuration changed/i);
    await assert.rejects(
      host.service.restoreTaskSession({ ...identity, taskId: second.id }),
      /Task|participant|Session/i,
    );
    assert.equal(nativeResumeCalls, 0);
    assert.deepEqual(commands, ["createSession", "createSession"]);
    assert.equal(
      (await host.service.getTask(first.id))?.session.nativeSessionId,
      first.session.nativeSessionId,
    );
    assert.equal(
      (await host.service.getTask(second.id))?.session.nativeSessionId,
      second.session.nativeSessionId,
    );

    configurationVersion = "provider-config-original";
    const restored = await host.service.restoreTaskSession(identity);
    assert.equal(restored.session.nativeSessionId, first.session.nativeSessionId);
    assert.equal(restored.participant.id, first.participant.id);
    assert.equal(nativeResumeCalls, 1);
    await host.service.submitInput({
      ...identity,
      text: "a newly authorized turn after explicit recovery",
      submissionConfig: { modelSelection: { providerId: "provider-a", modelId: "model-a" } },
    });
    assert.deepEqual(commands, ["createSession", "createSession", "sendText"]);
    assert.equal((await host.service.getHistory(first.id))?.inputs.length, 1);
    assert.equal((await host.service.getHistory(second.id))?.inputs.length, 0);
  } finally {
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

test("Host adopts a persisted share import and sends its context ref on the first Task Input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-share-adoption-"));
  const project = join(directory, "project");
  await mkdir(project);
  setDataBaseDir(directory);
  const nativeSessionId = "share-import-persisted-session";
  const contextId = "shared-context-persisted";
  const shareUrl = "https://example.test/share/abc123";
  let importCalls = 0;
  let resumeCalls = 0;
  let inputNumber = 0;
  const nativeCommands: Array<{ type: string; commandId: string; payload?: unknown }> = [];
  const conversationShareService = {
    importShare: async (input: { targetWorkspacePath?: string }, operationId: string) => {
      importCalls++;
      assert.equal(
        operationId,
        importCalls === 1 ? "share-request-before-restart" : "share-request-after-restart",
      );
      return {
        workspacePath: input.targetWorkspacePath,
        sessionId: nativeSessionId,
        contextId,
        shareUrl,
        title: "Shared source conversation",
        reused: importCalls > 1,
      };
    },
  } as unknown as IConversationShareService;
  const createHost = () =>
    createAnyAgentService(
      {
        initialize: async ({ workspacePath }: { workspacePath: string }) => ({
          available: true,
          workspaceKey: workspacePath,
        }),
        onDynamicSessionEvent: () => (listener: (event: unknown) => void) => ({
          dispose() {
            void listener;
          },
        }),
        onAgentRuntimeLifecycle: () => ({ dispose() {} }),
        readSession: async ({ sessionId }: { sessionId: string }) => ({
          session: { sessionId },
          projection: { turnCount: 0 },
          messages: [
            {
              info: {
                role: "user",
                source: "shared_context",
                visibility: "model-only",
                metadata: { contextId },
              },
              parts: [],
            },
          ],
        }),
        resumeSession: async ({ sessionId }: { sessionId: string }) => {
          resumeCalls++;
          return {
            session: { sessionId },
            settings: { model: { current: { providerId: "provider-a" } } },
          };
        },
        sendConversationCommandV4: async ({
          envelope,
        }: {
          envelope: { type: string; commandId: string; payload?: unknown };
        }) => {
          nativeCommands.push(envelope);
          if (envelope.type === "sendText") {
            inputNumber++;
            return {
              status: "accepted",
              commandId: envelope.commandId,
              result: {
                type: "inputAccepted",
                inputId: `native-input-${inputNumber}`,
                delivery: "startNow",
              },
            };
          }
          return {
            status: "accepted",
            commandId: envelope.commandId,
            result: { type: "createSession", sessionId: "unexpected-new-session" },
          };
        },
      } as unknown as IZCodeAgentService,
      undefined,
      async () => undefined,
      undefined,
      conversationShareService,
    );

  let host = createHost();
  try {
    const firstImport = await host.service.importSharedContext({
      shareCode: "abc123",
      clientRequestId: "share-request-before-restart",
      workspacePath: project,
    });
    assert.equal(firstImport.session.nativeSessionId, nativeSessionId);
    assert.equal(firstImport.sharedContext?.contextId, contextId);
    assert.equal(firstImport.environment.workDirectory, project);
    assert.equal(resumeCalls, 1);
    assert.equal((await host.service.getHistory(firstImport.id))?.inputs.length, 0);
    host.close();

    host = createHost();
    const restoredImport = await host.service.importSharedContext({
      shareCode: "abc123",
      clientRequestId: "share-request-after-restart",
      workspacePath: project,
    });
    assert.equal(restoredImport.id, firstImport.id);
    assert.equal(restoredImport.session.nativeSessionId, nativeSessionId);
    assert.equal((await host.service.listTasks()).length, 1);
    assert.equal((await host.service.getHistory(restoredImport.id))?.inputs.length, 0);

    const identity = {
      taskId: restoredImport.id,
      participantId: restoredImport.participant.id,
      sessionId: restoredImport.session.id,
      authorizationId: restoredImport.authorizationId,
    };
    const restored = await host.service.restoreTaskSession(identity);
    assert.equal(restored.session.nativeSessionId, nativeSessionId);
    assert.equal((await host.service.getHistory(restored.id))?.inputs.length, 0);
    await host.service.submitInput({
      ...identity,
      text: "Continue from this shared context",
      submissionConfig: { modelSelection: { providerId: "provider-a", modelId: "model-a" } },
    });
    const send = nativeCommands.find((command) => command.type === "sendText");
    assert.ok(send);
    assert.deepEqual((send.payload as { context_refs?: unknown }).context_refs, [
      { kind: "shared_context_import", context_id: contextId },
    ]);
    assert.equal(nativeCommands.filter((command) => command.type === "createSession").length, 0);
    assert.equal((await host.service.getHistory(restored.id))?.inputs.length, 1);
    assert.equal(importCalls, 2);
    assert.equal(resumeCalls, 2);
  } finally {
    host.close();
    setDataBaseDir(null);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host coalesces only the same import request and adopts a shared native Session once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-share-concurrent-"));
  const project = join(directory, "project");
  await mkdir(project);
  setDataBaseDir(directory);
  const nativeSessionId = "share-import-concurrent-session";
  const contextId = "shared-context-concurrent";
  let importCalls = 0;
  let resumeCalls = 0;
  let releaseImport!: () => void;
  const importGate = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });
  const conversationShareService = {
    importShare: async (
      input: { targetWorkspacePath?: string; clientRequestId: string },
      operationId: string,
    ) => {
      importCalls++;
      assert.equal(operationId, input.clientRequestId);
      await importGate;
      return {
        workspacePath: input.targetWorkspacePath,
        sessionId: nativeSessionId,
        contextId,
        shareUrl: "https://example.test/share/concurrent",
        title: "Concurrent shared source",
        reused: importCalls > 1,
      };
    },
  } as unknown as IConversationShareService;
  const host = createAnyAgentService(
    {
      initialize: async ({ workspacePath }: { workspacePath: string }) => ({
        available: true,
        workspaceKey: workspacePath,
      }),
      onDynamicSessionEvent: () => (listener: (event: unknown) => void) => ({
        dispose() {
          void listener;
        },
      }),
      onAgentRuntimeLifecycle: () => ({ dispose() {} }),
      readSession: async ({ sessionId }: { sessionId: string }) => ({
        session: { sessionId },
        projection: { turnCount: 0 },
        messages: [
          {
            info: {
              role: "user",
              source: "shared_context",
              visibility: "model-only",
              metadata: { contextId },
            },
            parts: [],
          },
        ],
      }),
      resumeSession: async ({ sessionId }: { sessionId: string }) => {
        resumeCalls++;
        return {
          session: { sessionId },
          settings: { model: { current: { providerId: "provider-a" } } },
        };
      },
      sendConversationCommandV4: async () => ({ status: "accepted" }),
    } as unknown as IZCodeAgentService,
    undefined,
    async () => undefined,
    undefined,
    conversationShareService,
  );
  try {
    const request = (clientRequestId: string) => ({
      shareCode: "concurrent",
      clientRequestId,
      workspacePath: project,
    });
    const first = host.service.importSharedContext(request("request-one"));
    const second = host.service.importSharedContext(request("request-two"));
    for (let attempt = 0; importCalls < 2 && attempt < 100; attempt++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(importCalls, 2);
    releaseImport();
    const [firstTask, secondTask] = await Promise.all([first, second]);
    assert.equal(firstTask.id, secondTask.id);
    assert.equal((await host.service.listTasks()).length, 1);
    assert.equal(resumeCalls, 1);

    const sameRequest = request("request-three");
    const duplicateOne = host.service.importSharedContext(sameRequest);
    const duplicateTwo = host.service.importSharedContext(sameRequest);
    const [duplicateTaskOne, duplicateTaskTwo] = await Promise.all([duplicateOne, duplicateTwo]);
    assert.equal(duplicateTaskOne.id, firstTask.id);
    assert.equal(duplicateTaskTwo.id, firstTask.id);
    assert.equal(importCalls, 3);
    assert.equal((await host.service.listTasks()).length, 1);
    assert.equal(resumeCalls, 1);
  } finally {
    host.close();
    setDataBaseDir(null);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host Skill catalog reads require the matching active Task Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-host-skill-catalog-"));
  const project = join(directory, "project");
  await mkdir(project);
  setDataBaseDir(directory);
  const nativeCatalogReads: Array<Record<string, unknown>> = [];
  const nativeGoalReads: Array<Record<string, unknown>> = [];
  let nativeSessionSequence = 0;
  let catalogAuthority: "session" | "workspace" = "session";
  const host = createAnyAgentService({
    initialize: async ({ workspacePath }: { workspacePath: string }) => ({
      available: true,
      workspaceKey: workspacePath,
    }),
    onDynamicSessionEvent: () => (listener: (event: unknown) => void) => ({
      dispose() {
        void listener;
      },
    }),
    onAgentRuntimeLifecycle: () => ({ dispose() {} }),
    getSkillReferenceCatalog: async (params: { workspacePath: string; sessionId?: string }) => {
      nativeCatalogReads.push(params);
      return {
        authority: catalogAuthority,
        skills: [
          {
            id: "review",
            name: "review",
            description: "Review code changes",
            path: `${project}/.agents/skills/review/SKILL.md`,
            scope: "workspace" as const,
            enabled: true as const,
          },
        ],
      };
    },
    readSession: async (params: Record<string, unknown>) => {
      nativeGoalReads.push(params);
      return {
        session: {
          sessionId: params.sessionId,
          target: {
            sessionId: params.sessionId,
            objective: "Review the current workspace",
            status: "active",
            tokensUsed: 24,
            tokenBudget: 100,
          },
        },
      };
    },
    sendConversationCommandV4: async ({
      envelope,
    }: {
      envelope: { type: string; commandId: string };
    }) => {
      nativeSessionSequence++;
      return {
        status: "accepted" as const,
        commandId: envelope.commandId,
        result: {
          type: "createSession" as const,
          sessionId: `native-skill-${nativeSessionSequence}`,
        },
      };
    },
  } as unknown as IZCodeAgentService);
  try {
    const first = await host.service.createTask({ engineId: "zcode", workspacePath: project });
    const second = await host.service.createTask({ engineId: "zcode", workspacePath: project });
    const identity = {
      taskId: first.id,
      participantId: first.participant.id,
      sessionId: first.session.id,
      authorizationId: first.authorizationId,
    };

    await assert.rejects(
      host.service.getTaskSkillReferenceCatalog({ ...identity, sessionId: second.session.id }),
      /ownership do not match/i,
    );
    assert.equal(nativeCatalogReads.length, 0, "cross-Task product Sessions must not reach ZCode");

    const catalog = await host.service.getTaskSkillReferenceCatalog(identity);
    assert.deepEqual(catalog, {
      skills: [
        {
          name: "review",
          description: "Review code changes",
          scope: "workspace",
        },
      ],
    });
    assert.deepEqual(nativeCatalogReads[0], {
      workspacePath: project,
      sessionId: first.session.nativeSessionId,
    });
    await assert.rejects(
      host.service.getTaskGoalStatus({ ...identity, sessionId: second.session.id }),
      /ownership do not match/i,
    );
    assert.equal(nativeGoalReads.length, 0);
    assert.deepEqual(await host.service.getTaskGoalStatus(identity), {
      objective: "Review the current workspace",
      status: "active",
      tokensUsed: 24,
      tokenBudget: 100,
    });
    assert.deepEqual(nativeGoalReads[0], {
      workspacePath: project,
      sessionId: first.session.nativeSessionId,
      runtimePolicy: "existing-only",
    });

    catalogAuthority = "workspace";
    await assert.rejects(
      host.service.getTaskSkillReferenceCatalog(identity),
      /did not verify this Skill catalog/i,
    );
  } finally {
    host.close();
    setDataBaseDir(null);
    await rm(directory, { recursive: true, force: true });
  }
});
