import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EngineContractError } from "@anyagent/engine-contract";
import type {
  EngineAdapter,
  EngineAttachment,
  EngineAssistantFeedbackReceipt,
  EngineApprovalReceipt,
  EngineCapability,
  EngineCapabilitySnapshot,
  EngineCommandReceipt,
  EngineCompactReceipt,
  EngineEvent,
  EngineEventInput,
  EngineExecutionRef,
  EngineExecutionReconciliation,
  EngineJsonObject,
  EngineRun,
  EngineSessionRef,
  EngineUserInputReceipt,
  CapabilityStatus,
} from "@anyagent/engine-contract";
import {
  createTaskRuntime,
  type RuntimeAuthorization,
  type RuntimeAttachmentStageRequest,
  type RuntimeEnvironment,
} from "../src/index.js";

class EventQueue implements AsyncIterable<EngineEvent> {
  readonly #events: EngineEvent[] = [];
  readonly #waiters: ((result: IteratorResult<EngineEvent>) => void)[] = [];
  #closed = false;

  [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    return {
      next: () => {
        const value = this.#events.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }

  push(event: EngineEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.#events.push(event);
  }

  close(): void {
    this.#closed = true;
    for (const resolve of this.#waiters.splice(0)) resolve({ done: true, value: undefined });
  }
}

class ManualEngine implements EngineAdapter {
  readonly sessions: EngineSessionRef[] = [];
  readonly runs: {
    session: EngineSessionRef;
    input: string;
    commandId?: string;
    submissionConfig?: EngineJsonObject;
    attachments?: readonly EngineAttachment[];
    revision?: Parameters<EngineAdapter["run"]>[0]["revision"];
    executionId: EngineExecutionRef;
    events: EventQueue;
    sourceSequence: number;
    deliverySequence: number;
  }[] = [];
  readonly capabilities = Object.fromEntries(
    [
      "session.create",
      "session.resume",
      "session.fork",
      "session.compact",
      "session.close",
      "execution.run",
      "execution.revise",
      "execution.interrupt",
      "execution.reconcile",
      "events.stream",
      "events.tool",
      "events.file",
      "approval.respond",
      "user-input.respond",
      "assistant.feedback",
      "workspace.file-rewind",
    ].map((name) => [
      name,
      {
        support: name === "execution.reconcile" ? "unsupported" : "supported",
        availability: "available",
      },
    ]),
  ) as Record<EngineCapability, CapabilityStatus>;
  #nextSession = 0;
  createSessionCalls = 0;
  readonly resumeCalls: Parameters<NonNullable<EngineAdapter["resumeSession"]>>[0][] = [];
  resumeResult: EngineSessionRef | null = null;
  resumeHandler: (() => Promise<void>) | null = null;
  readonly reconcileCalls: Parameters<NonNullable<EngineAdapter["reconcileExecution"]>>[0][] = [];
  reconcileResult: EngineExecutionReconciliation = {
    status: "unknown",
    reason: "no native evidence configured",
  };
  reconcileHandler:
    | ((
        input: Parameters<NonNullable<EngineAdapter["reconcileExecution"]>>[0],
      ) => Promise<EngineExecutionReconciliation>)
    | null = null;
  readonly forkCalls: Parameters<NonNullable<EngineAdapter["forkSession"]>>[0][] = [];
  forkFailure: Error | null = null;
  readonly compactCalls: Parameters<NonNullable<EngineAdapter["compactSession"]>>[0][] = [];
  compactReceipt: EngineCompactReceipt = {
    status: "completed",
    evidence: { source: "engine", evidenceId: "compact-terminal" },
  };
  compactHandler:
    | ((
        input: Parameters<NonNullable<EngineAdapter["compactSession"]>>[0],
      ) => Promise<EngineCompactReceipt>)
    | null = null;
  runFailure: Error | null = null;
  beforeRunDispatch: (() => Promise<void>) | null = null;
  #nextExecution = 0;
  adapterVersion = "test";
  configurationVersion = "test";
  refreshHandler: (() => Promise<EngineCapabilitySnapshot>) | null = null;
  approvalReplies = 0;
  userInputReplies = 0;
  interrupts = 0;
  readonly feedbackCalls: Parameters<NonNullable<EngineAdapter["setAssistantFeedback"]>>[0][] = [];
  feedbackEffects = 0;
  beforeFeedbackDispatch: (() => Promise<void>) | null = null;
  readonly feedbackByTarget = new Map<string, "like" | "dislike" | null>();
  interruptStatus: EngineCommandReceipt["status"] = "requested";
  fileRewindEffects = 0;
  fileRewindStatus: "applied" | "unknown" = "applied";
  beforeFileDispatch: (() => Promise<void>) | null = null;

  getCapabilities(): EngineCapabilitySnapshot {
    return {
      engineId: "manual",
      adapterVersion: this.adapterVersion,
      engineVersion: "test",
      configurationVersion: this.configurationVersion,
      environment: "workspace-a",
      capabilities: { ...this.capabilities },
    };
  }

  async refreshCapabilities(): Promise<EngineCapabilitySnapshot> {
    return this.refreshHandler ? this.refreshHandler() : this.getCapabilities();
  }

  setCapability(capability: EngineCapability, status: CapabilityStatus): void {
    this.capabilities[capability] = status;
  }

  async createSession(): Promise<EngineSessionRef> {
    this.createSessionCalls++;
    const session = `native-session-${++this.#nextSession}` as EngineSessionRef;
    this.sessions.push(session);
    return session;
  }

  async resumeSession(
    input: Parameters<NonNullable<EngineAdapter["resumeSession"]>>[0],
  ): Promise<EngineSessionRef> {
    input.beforeDispatch?.();
    this.resumeCalls.push(input);
    if (!this.sessions.includes(input.session))
      throw new Error("The native Session does not belong to this Engine instance.");
    await this.resumeHandler?.();
    return this.resumeResult ?? input.session;
  }

  async reconcileExecution(
    input: Parameters<NonNullable<EngineAdapter["reconcileExecution"]>>[0],
  ): Promise<EngineExecutionReconciliation> {
    input.beforeDispatch?.();
    this.reconcileCalls.push(input);
    return this.reconcileHandler ? this.reconcileHandler(input) : this.reconcileResult;
  }

  async forkSession(input: Parameters<NonNullable<EngineAdapter["forkSession"]>>[0]) {
    input.beforeDispatch?.();
    this.forkCalls.push(input);
    if (this.forkFailure) throw this.forkFailure;
    const session = `native-fork-${++this.#nextSession}` as EngineSessionRef;
    this.sessions.push(session);
    return session;
  }

  async compactSession(
    input: Parameters<NonNullable<EngineAdapter["compactSession"]>>[0],
  ): Promise<EngineCompactReceipt> {
    input.beforeDispatch?.();
    this.compactCalls.push(input);
    const acceptedEvidence = {
      source: "engine" as const,
      evidenceId: `${input.commandId}:accepted`,
    };
    input.onAccepted?.(acceptedEvidence);
    return this.compactHandler ? this.compactHandler(input) : this.compactReceipt;
  }

  async run(request: Parameters<EngineAdapter["run"]>[0]): Promise<EngineRun> {
    await this.beforeRunDispatch?.();
    request.beforeDispatch?.();
    if (this.runFailure) throw this.runFailure;
    const { session, input, commandId, submissionConfig, attachments, revision } = request;
    const executionId = (revision?.commandId ??
      `native-execution-${++this.#nextExecution}`) as EngineExecutionRef;
    const events = new EventQueue();
    this.runs.push({
      session,
      input,
      ...(commandId ? { commandId } : {}),
      ...(submissionConfig ? { submissionConfig } : {}),
      ...(attachments ? { attachments } : {}),
      ...(revision ? { revision } : {}),
      executionId,
      events,
      sourceSequence: 0,
      deliverySequence: 0,
    });
    return { executionId, events };
  }

  async replyToApproval(
    input: Parameters<EngineAdapter["replyToApproval"]>[0],
  ): Promise<EngineApprovalReceipt> {
    input.beforeDispatch?.();
    this.approvalReplies++;
    return { status: "forwarded" };
  }
  async replyToUserInput(
    input: Parameters<EngineAdapter["replyToUserInput"]>[0],
  ): Promise<EngineUserInputReceipt> {
    input.beforeDispatch?.();
    this.userInputReplies++;
    return { status: "forwarded" };
  }
  async interrupt(): Promise<EngineCommandReceipt> {
    this.interrupts++;
    return {
      status: this.interruptStatus,
      ...(this.interruptStatus === "requested"
        ? { evidence: { source: "engine" as const, evidenceId: `interrupt-${this.interrupts}` } }
        : {}),
    };
  }
  async setAssistantFeedback(
    input: Parameters<NonNullable<EngineAdapter["setAssistantFeedback"]>>[0],
  ): Promise<EngineAssistantFeedbackReceipt> {
    await this.beforeFeedbackDispatch?.();
    input.beforeDispatch?.();
    this.feedbackCalls.push(input);
    const target = JSON.stringify([input.session, input.executionId, input.messageId]);
    const current = this.feedbackByTarget.get(target) ?? null;
    if (current === input.feedback) return { status: "unchanged" };
    this.feedbackByTarget.set(target, input.feedback);
    this.feedbackEffects++;
    return {
      status: "updated",
      evidence: { source: "engine", evidenceId: `feedback-${this.feedbackEffects}` },
    };
  }
  async closeSession(): Promise<EngineCommandReceipt> {
    return { status: "closed" };
  }
  async getFileChanges() {
    return {
      files: 1,
      additions: 1,
      deletions: 0,
      state: "active" as const,
      canRewind: true,
      items: [],
    };
  }
  async previewFileRewind() {
    return {
      canApply: true,
      safeFiles: [
        {
          action: "delete" as const,
          operationCount: 1,
          path: "/work/project-a/changed.txt",
          toolNames: ["Write"],
        },
      ],
      unsafeFiles: [],
      ignoredFiles: [],
    };
  }
  async applyFileRewind(input: Parameters<NonNullable<EngineAdapter["applyFileRewind"]>>[0]) {
    await this.beforeFileDispatch?.();
    input.beforeDispatch?.();
    this.fileRewindEffects++;
    return {
      status: this.fileRewindStatus,
      evidence: { source: "engine" as const, evidenceId: input.commandId },
    };
  }

  emit(
    runIndex: number,
    payload: EngineEventInput,
    overrides: { eventId?: string; sourceSequence?: number | null; streamId?: string } = {},
  ): EngineEvent {
    const run = this.runs[runIndex]!;
    const event = {
      ...payload,
      eventId: overrides.eventId ?? `event-${runIndex}-${Date.now()}-${Math.random()}`,
      streamId: overrides.streamId ?? `stream-${runIndex}`,
      sourceSequence:
        overrides.sourceSequence === undefined ? ++run.sourceSequence : overrides.sourceSequence,
      deliverySequence: ++run.deliverySequence,
      observedAt: Date.now(),
      source: "engine",
      session: run.session,
      executionId: run.executionId,
    } as EngineEvent;
    run.events.push(event);
    return event;
  }

  closeEvents(runIndex: number): void {
    this.runs[runIndex]!.events.close();
  }
}

test("Runtime persists and forwards generic submission JSON without interpreting Engine keys", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  const submissionConfig = {
    mode: "engine-specific-mode",
    modelSelection: {
      providerId: "configured-provider",
      modelId: "configured-model",
      options: { reasoningLevel: "custom-level" },
    },
    engineExtension: { enabled: true },
  } satisfies EngineJsonObject;
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const input = await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
      text: "use adapter-owned config",
      submissionConfig,
    });
    assert.deepEqual(input.submissionConfig, submissionConfig);
    assert.deepEqual(runtime.getHistory(task.id)?.inputs[0]?.submissionConfig, submissionConfig);
    assert.deepEqual(engine.runs[0]?.submissionConfig, submissionConfig);
  } finally {
    runtime.close();
  }
});

test("Runtime queues text as Input history and promotes FIFO only after terminal evidence", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "A" });
    const queued = await runtime.submitInput({
      ...identity,
      text: "B",
      delivery: "queue",
      idempotencyKey: "request-b",
    });
    const duplicate = await runtime.submitInput({
      ...identity,
      text: "B",
      delivery: "queue",
      idempotencyKey: "request-b",
    });
    const third = await runtime.submitInput({
      ...identity,
      text: "C",
      delivery: "queue",
    });

    assert.equal(duplicate.id, queued.id);
    assert.equal(queued.status, "queued");
    assert.equal(third.status, "queued");
    assert.equal(engine.runs.length, 1);
    assert.equal(runtime.getHistory(task.id)?.executions.length, 0);
    await assert.rejects(
      runtime.submitInput({
        ...identity,
        text: "different B",
        delivery: "queue",
        idempotencyKey: "request-b",
      }),
      /idempotency key was already used/i,
    );

    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "A-accepted" },
    });
    engine.emit(0, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "A-started" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    engine.emit(0, {
      type: "execution.completed",
      evidence: { source: "engine", evidenceId: "A-completed" },
    });
    await until(() => engine.runs.length === 2);
    assert.equal(engine.runs[1]?.input, "B");
    assert.equal(engine.runs[1]?.commandId, queued.id);
    assert.equal(
      runtime.getHistory(task.id)?.inputs.find((input) => input.id === queued.id)?.status,
      "received",
    );
    assert.equal(
      runtime.getHistory(task.id)?.inputs.find((input) => input.id === third.id)?.status,
      "queued",
    );
    assert.equal(runtime.getHistory(task.id)?.executions.length, 1);

    const executionA = runtime.getHistory(task.id)!.executions[0]!;
    engine.emit(0, {
      type: "message.delta",
      text: "late A event",
      messageId: "late-a-message",
    });
    await until(() =>
      runtime
        .getHistory(task.id)!
        .events.some((event) => event.payload.messageId === "late-a-message"),
    );
    const lateEvent = runtime
      .getHistory(task.id)!
      .events.find((event) => event.payload.messageId === "late-a-message");
    assert.equal(lateEvent?.executionId, executionA.id);

    engine.emit(1, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "B-accepted" },
    });
    engine.emit(1, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "B-started" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 2);
    engine.emit(1, {
      type: "execution.completed",
      evidence: { source: "engine", evidenceId: "B-completed" },
    });
    await until(() => engine.runs.length === 3);
    assert.equal(engine.runs[2]?.input, "C");
    assert.equal(engine.runs[2]?.commandId, third.id);
  } finally {
    runtime.close();
  }
});

test("Runtime serializes duplicate idempotency keys in SQLite before creating another Input", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const request = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
      text: "same request",
      delivery: "queue" as const,
      idempotencyKey: "same-request-key",
    };
    const [first, duplicate] = await Promise.all([
      runtime.submitInput(request),
      runtime.submitInput(request),
    ]);
    assert.equal(first.id, duplicate.id);
    assert.equal(runtime.getHistory(task.id)?.inputs.length, 1);
    assert.equal(engine.runs.length, 1);
  } finally {
    runtime.close();
  }
});

test("queued Input is rejected when its Task freezes or authorization expires before promotion", async () => {
  {
    const engine = new ManualEngine();
    const runtime = createTaskRuntime({
      databasePath: ":memory:",
      engines: new Map([["manual", engine]]),
    });
    try {
      const task = await runtime.createTask({ engineId: "manual", environment, authorization });
      const identity = {
        taskId: task.id,
        participantId: task.participant.id,
        sessionId: task.session.id,
        authorizationId: task.authorizationId,
      };
      await runtime.submitInput({ ...identity, text: "A" });
      const queued = await runtime.submitInput({ ...identity, text: "B", delivery: "queue" });
      runtime.freezeTask({ ...identity, reason: "pause before promotion" });
      assert.equal(
        runtime.getHistory(task.id)?.inputs.find((input) => input.id === queued.id)?.status,
        "rejected",
      );
      assert.match(
        runtime.getHistory(task.id)?.inputs.find((input) => input.id === queued.id)?.error ?? "",
        /Task frozen/i,
      );
      engine.emit(0, {
        type: "input.accepted",
        evidence: { source: "engine", evidenceId: "freeze-A-accepted" },
      });
      engine.emit(0, {
        type: "execution.started",
        evidence: { source: "engine", evidenceId: "freeze-A-started" },
      });
      engine.emit(0, {
        type: "execution.completed",
        evidence: { source: "engine", evidenceId: "freeze-A-completed" },
      });
      await until(() => runtime.getHistory(task.id)!.executions[0]?.status === "completed");
      assert.equal(engine.runs.length, 1);
    } finally {
      runtime.close();
    }
  }

  {
    const engine = new ManualEngine();
    let now = 0;
    const runtime = createTaskRuntime({
      databasePath: ":memory:",
      engines: new Map([["manual", engine]]),
      now: () => now,
    });
    try {
      const task = await runtime.createTask({
        engineId: "manual",
        environment,
        authorization: { ...authorization, id: "expires-before-promotion", expiresAt: 5 },
      });
      const identity = {
        taskId: task.id,
        participantId: task.participant.id,
        sessionId: task.session.id,
        authorizationId: task.authorizationId,
      };
      await runtime.submitInput({ ...identity, text: "A" });
      const queued = await runtime.submitInput({ ...identity, text: "B", delivery: "queue" });
      now = 10;
      engine.emit(0, {
        type: "input.accepted",
        evidence: { source: "engine", evidenceId: "expiry-A-accepted" },
      });
      engine.emit(0, {
        type: "execution.started",
        evidence: { source: "engine", evidenceId: "expiry-A-started" },
      });
      engine.emit(0, {
        type: "execution.completed",
        evidence: { source: "engine", evidenceId: "expiry-A-completed" },
      });
      await until(
        () =>
          runtime.getHistory(task.id)!.inputs.find((input) => input.id === queued.id)?.status ===
          "rejected",
      );
      assert.match(
        runtime.getHistory(task.id)?.inputs.find((input) => input.id === queued.id)?.error ?? "",
        /expired/i,
      );
      assert.equal(engine.runs.length, 1);
    } finally {
      runtime.close();
    }
  }
});

test("Runtime restart holds queued text until original reconciliation, native restore, and explicit resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-runtime-queue-restart-"));
  const databasePath = join(directory, "runtime.sqlite");
  const engine = new ManualEngine();
  let runtime = createTaskRuntime({
    databasePath,
    engines: new Map([["manual", engine]]),
  });
  let taskId = "";
  let queuedId = "";
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    taskId = task.id;
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "A" });
    queuedId = (await runtime.submitInput({ ...identity, text: "B", delivery: "queue" })).id;
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "queue-restart-A-accepted" },
    });
    engine.emit(0, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "queue-restart-A-started" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]?.status === "started");
    runtime.close();

    runtime = createTaskRuntime({
      databasePath,
      engines: new Map([["manual", engine]]),
    });
    const history = runtime.getHistory(taskId)!;
    assert.equal(history.inputs.find((input) => input.text === "A")?.status, "unknown");
    assert.equal(history.inputs.find((input) => input.id === queuedId)?.status, "queued");
    assert.equal(runtime.getTask(taskId)?.session.queuePaused, true);
    assert.equal(engine.runs.length, 1);
    await assert.rejects(runtime.resumeQueuedInputs(identity), /Session is unknown/i);
    await assert.rejects(runtime.restoreTaskSession(identity), /unresolved native work/i);
    const executionId = history.executions[0]?.id;
    assert.ok(executionId);
    engine.setCapability("execution.reconcile", {
      support: "supported",
      availability: "available",
    });
    engine.reconcileResult = {
      status: "completed",
      result: "original finished",
      evidence: { source: "engine", evidenceId: "queue-restart-original-completed" },
    };
    await runtime.reconcileExecution({ ...identity, executionId });
    assert.equal(engine.runs.length, 1);
    const restored = await runtime.restoreTaskSession(identity);
    assert.equal(restored.session.queuePaused, true);
    assert.equal(
      engine.runs.length,
      1,
      "restoring the native Session cannot auto-dispatch queued work",
    );
    await runtime.resumeQueuedInputs(identity);
    await until(() => engine.runs.length === 2);
    assert.equal(engine.runs[1]?.input, "B");
    assert.equal(engine.runs[1]?.commandId, queuedId);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Execution reconciliation rechecks authorization after a delayed native read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-runtime-reconcile-expiry-"));
  const databasePath = join(directory, "runtime.sqlite");
  const engine = new ManualEngine();
  let now = 1;
  let runtime = createTaskRuntime({
    databasePath,
    engines: new Map([["manual", engine]]),
    now: () => now,
  });
  try {
    const task = await runtime.createTask({
      engineId: "manual",
      environment,
      authorization: { ...authorization, id: "reconcile-expiring-grant", expiresAt: 20 },
    });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "tool side effect may have occurred" });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "reconcile-expiry-accepted" },
    });
    engine.emit(0, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "reconcile-expiry-started" },
    });
    await until(() => runtime.getHistory(task.id)?.executions[0]?.status === "started");
    runtime.close();
    runtime = createTaskRuntime({
      databasePath,
      engines: new Map([["manual", engine]]),
      now: () => now,
    });
    const executionId = runtime.getHistory(task.id)!.executions[0]!.id;
    engine.setCapability("execution.reconcile", {
      support: "supported",
      availability: "available",
    });
    let nativeReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      nativeReadStarted = resolve;
    });
    let finishNativeRead!: () => void;
    const nativeRead = new Promise<void>((resolve) => {
      finishNativeRead = resolve;
    });
    engine.reconcileHandler = async () => {
      nativeReadStarted();
      await nativeRead;
      return {
        status: "completed",
        result: "late terminal",
        evidence: { source: "engine", evidenceId: "reconcile-expiry-terminal" },
      };
    };
    const reconcile = runtime.reconcileExecution({ ...identity, executionId });
    await readStarted;
    now = 21;
    finishNativeRead();
    await assert.rejects(reconcile, /Authorization has expired/i);
    assert.equal(runtime.getHistory(task.id)?.executions[0]?.status, "unknown");
    assert.equal(runtime.getHistory(task.id)?.inputs[0]?.status, "unknown");
    assert.equal(engine.runs.length, 1);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Runtime cold restore reattaches the same Session for an active Task after multiple turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-runtime-session-restore-"));
  const databasePath = join(directory, "runtime.sqlite");
  const engine = new ManualEngine();
  let runtime = createTaskRuntime({ databasePath, engines: new Map([["manual", engine]]) });
  let identity!: {
    taskId: string;
    participantId: string;
    sessionId: string;
    authorizationId: string;
  };
  let otherTask!: Awaited<ReturnType<typeof runtime.createTask>>;
  let nativeSessionId!: EngineSessionRef;
  const completeTurn = async (text: string) => {
    const before = engine.runs.length;
    await runtime.submitInput({ ...identity, text });
    const runIndex = before;
    engine.emit(runIndex, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: `${text}-accepted` },
    });
    engine.emit(runIndex, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: `${text}-started` },
    });
    engine.emit(runIndex, {
      type: "execution.completed",
      evidence: { source: "engine", evidenceId: `${text}-completed` },
    });
    await until(
      () =>
        runtime
          .getHistory(identity.taskId)
          ?.inputs.some((input) => input.text === text && input.status === "completed") === true,
    );
  };
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    nativeSessionId = task.session.nativeSessionId as EngineSessionRef;
    otherTask = await runtime.createTask({ engineId: "manual", environment, authorization });
    await completeTurn("first turn");
    await completeTurn("second turn");
    assert.equal(runtime.getHistory(task.id)?.inputs.length, 2);
    assert.equal(runtime.getHistory(task.id)?.executions.length, 2);
    runtime.close();

    runtime = createTaskRuntime({ databasePath, engines: new Map([["manual", engine]]) });
    const recovered = runtime.getTask(identity.taskId)!;
    assert.equal(recovered.participant.id, identity.participantId);
    assert.equal(recovered.session.id, identity.sessionId);
    assert.equal(recovered.session.status, "unknown");
    assert.equal(recovered.session.nativeSessionId, nativeSessionId);
    assert.deepEqual(
      runtime.getHistory(identity.taskId)?.integrityIssues,
      [],
      "completed rounds require reattachment, but have no interrupted native work",
    );
    await assert.rejects(
      runtime.restoreTaskSession({ ...identity, sessionId: otherTask.session.id }),
      /Session ownership|participant/i,
    );
    assert.equal(engine.resumeCalls.length, 0);

    const restored = await runtime.restoreTaskSession(identity);
    assert.equal(restored.id, identity.taskId);
    assert.equal(restored.participant.id, identity.participantId);
    assert.equal(restored.session.id, identity.sessionId);
    assert.equal(restored.session.nativeSessionId, nativeSessionId);
    assert.equal(restored.session.status, "active");
    assert.deepEqual(
      engine.resumeCalls.map((call) => call.session),
      [nativeSessionId],
    );
    assert.equal(engine.createSessionCalls, 2);
    assert.equal(runtime.getHistory(identity.taskId)?.inputs.length, 2);
    assert.equal(runtime.getHistory(identity.taskId)?.executions.length, 2);

    await runtime.submitInput({ ...identity, text: "third turn" });
    assert.equal(engine.runs.length, 3);
    assert.equal(engine.runs[2]?.session, nativeSessionId);
    assert.equal(engine.createSessionCalls, 2);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Runtime restart records an interrupted native turn once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-runtime-restart-issue-"));
  const databasePath = join(directory, "runtime.sqlite");
  const engine = new ManualEngine();
  let runtime = createTaskRuntime({ databasePath, engines: new Map([["manual", engine]]) });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "still running at quit" });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "restart-input-accepted" },
    });
    engine.emit(0, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "restart-execution-started" },
    });
    await until(() => runtime.getHistory(task.id)?.executions[0]?.status === "started");
    runtime.close();

    runtime = createTaskRuntime({ databasePath, engines: new Map([["manual", engine]]) });
    const first = runtime.getHistory(task.id)!;
    assert.equal(first.inputs[0]?.status, "unknown");
    assert.equal(first.executions[0]?.status, "unknown");
    assert.deepEqual(
      first.integrityIssues.map((issue) => issue.type),
      ["stream-ended-unknown"],
    );
    assert.equal(runtime.getTask(task.id)?.session.nativeSessionId, task.session.nativeSessionId);
    assert.equal(engine.runs.length, 1);
    runtime.close();

    runtime = createTaskRuntime({ databasePath, engines: new Map([["manual", engine]]) });
    assert.deepEqual(
      runtime.getHistory(task.id)?.integrityIssues.map((issue) => issue.id),
      first.integrityIssues.map((issue) => issue.id),
      "restarting an already unknown turn must not invent another interruption",
    );
    assert.equal(engine.runs.length, 1);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Runtime cold restore rejects expired authorization, stale configuration, and terminal Tasks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-runtime-restore-eligibility-"));
  let now = 10;
  const expiredDb = join(directory, "expired.sqlite");
  const expiredEngine = new ManualEngine();
  let runtime = createTaskRuntime({
    databasePath: expiredDb,
    engines: new Map([["manual", expiredEngine]]),
    now: () => now,
  });
  const expiredTask = await runtime.createTask({
    engineId: "manual",
    environment,
    authorization: { ...authorization, id: "expiring-restore-grant", expiresAt: 20 },
  });
  const expiredIdentity = {
    taskId: expiredTask.id,
    participantId: expiredTask.participant.id,
    sessionId: expiredTask.session.id,
    authorizationId: expiredTask.authorizationId,
  };
  runtime.close();
  now = 21;
  runtime = createTaskRuntime({
    databasePath: expiredDb,
    engines: new Map([["manual", expiredEngine]]),
    now: () => now,
  });
  try {
    await assert.rejects(runtime.restoreTaskSession(expiredIdentity), /Authorization has expired/i);
    assert.equal(expiredEngine.resumeCalls.length, 0);
  } finally {
    runtime.close();
  }

  const staleDb = join(directory, "stale-config.sqlite");
  const staleEngine = new ManualEngine();
  runtime = createTaskRuntime({
    databasePath: staleDb,
    engines: new Map([["manual", staleEngine]]),
  });
  const staleTask = await runtime.createTask({ engineId: "manual", environment, authorization });
  const staleIdentity = {
    taskId: staleTask.id,
    participantId: staleTask.participant.id,
    sessionId: staleTask.session.id,
    authorizationId: staleTask.authorizationId,
  };
  runtime.close();
  staleEngine.configurationVersion = "changed-after-authorization";
  runtime = createTaskRuntime({
    databasePath: staleDb,
    engines: new Map([["manual", staleEngine]]),
  });
  try {
    await assert.rejects(runtime.restoreTaskSession(staleIdentity), /configuration changed/i);
    assert.equal(staleEngine.resumeCalls.length, 0);
  } finally {
    runtime.close();
  }

  const terminalDb = join(directory, "terminal.sqlite");
  const terminalEngine = new ManualEngine();
  runtime = createTaskRuntime({
    databasePath: terminalDb,
    engines: new Map([["manual", terminalEngine]]),
  });
  const terminalTask = await runtime.createTask({ engineId: "manual", environment, authorization });
  const terminalIdentity = {
    taskId: terminalTask.id,
    participantId: terminalTask.participant.id,
    sessionId: terminalTask.session.id,
    authorizationId: terminalTask.authorizationId,
  };
  runtime.closeTask({ ...terminalIdentity, outcome: "completed" });
  runtime.close();
  runtime = createTaskRuntime({
    databasePath: terminalDb,
    engines: new Map([["manual", terminalEngine]]),
  });
  try {
    await assert.rejects(runtime.restoreTaskSession(terminalIdentity), /completed|active task/i);
    assert.equal(terminalEngine.resumeCalls.length, 0);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Runtime cold restore rechecks configuration after native resume before attaching the saved Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-runtime-restore-config-race-"));
  const databasePath = join(directory, "runtime.sqlite");
  const engine = new ManualEngine();
  let runtime = createTaskRuntime({ databasePath, engines: new Map([["manual", engine]]) });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    const nativeSessionId = task.session.nativeSessionId;
    runtime.close();
    runtime = createTaskRuntime({ databasePath, engines: new Map([["manual", engine]]) });
    engine.resumeHandler = async () => {
      engine.configurationVersion = "changed-during-native-resume";
    };

    await assert.rejects(runtime.restoreTaskSession(identity), /configuration changed/i);
    assert.equal(engine.resumeCalls.length, 1);
    assert.equal(runtime.getTask(task.id)?.session.status, "unknown");
    assert.equal(runtime.getTask(task.id)?.session.nativeSessionId, nativeSessionId);
    assert.equal(engine.createSessionCalls, 1);
    assert.deepEqual(runtime.getHistory(task.id)?.inputs, []);
    await assert.rejects(runtime.submitInput({ ...identity, text: "must not send yet" }));
    assert.equal(engine.runs.length, 0);

    engine.resumeHandler = null;
    engine.configurationVersion = "test";
    const restored = await runtime.restoreTaskSession(identity);
    assert.equal(restored.session.nativeSessionId, nativeSessionId);
    assert.equal(restored.session.status, "active");
    assert.equal(engine.createSessionCalls, 1);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Runtime reconciles persisted unknown work from native evidence without resending its Input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-runtime-reconcile-"));
  const databasePath = join(directory, "runtime.sqlite");
  const engine = new ManualEngine();
  let runtime = createTaskRuntime({ databasePath, engines: new Map([["manual", engine]]) });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    const input = await runtime.submitInput({ ...identity, text: "do not repeat this operation" });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "reconcile-input-accepted" },
    });
    await until(() => runtime.getHistory(task.id)?.executions.length === 1);
    const originalExecutionId = runtime.getHistory(task.id)?.executions[0]?.id;
    assert.ok(originalExecutionId);
    assert.equal(engine.runs.length, 1);
    runtime.close();

    runtime = createTaskRuntime({ databasePath, engines: new Map([["manual", engine]]) });
    engine.setCapability("execution.reconcile", {
      support: "supported",
      availability: "available",
    });
    engine.reconcileResult = {
      status: "completed",
      result: "native result",
      evidence: { source: "engine", evidenceId: "reconcile-completed" },
    };
    const reconciled = await runtime.reconcileExecution({
      ...identity,
      executionId: originalExecutionId,
    });
    assert.equal(reconciled.id, originalExecutionId);
    assert.equal(reconciled.status, "completed");
    assert.equal(reconciled.result, "native result");
    assert.equal(reconciled.reconciliationEvidence?.evidenceId, "reconcile-completed");
    assert.equal(
      runtime.getHistory(task.id)?.inputs.find((item) => item.id === input.id)?.status,
      "completed",
    );
    assert.equal(engine.reconcileCalls.length, 1);
    assert.equal(engine.runs.length, 1);
    assert.equal(engine.reconcileCalls[0]?.executionId, "native-execution-1");
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cold-start reconciliation keeps running work queryable until terminal evidence, then restores the same Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-runtime-reconcile-running-"));
  const databasePath = join(directory, "runtime.sqlite");
  const engine = new ManualEngine();
  let runtime = createTaskRuntime({ databasePath, engines: new Map([["manual", engine]]) });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "do not duplicate this operation" });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "running-reconcile-input" },
    });
    await until(() => runtime.getHistory(task.id)?.executions.length === 1);
    engine.closeEvents(0);
    await until(() => runtime.getHistory(task.id)?.executions[0]?.status === "unknown");
    const executionId = runtime.getHistory(task.id)!.executions[0]!.id;
    assert.equal(engine.runs.length, 1);
    runtime.close();

    runtime = createTaskRuntime({ databasePath, engines: new Map([["manual", engine]]) });
    engine.setCapability("execution.reconcile", {
      support: "supported",
      availability: "available",
    });
    engine.reconcileResult = {
      status: "running",
      evidence: { source: "engine", evidenceId: "running-native-turn" },
    };
    const running = await runtime.reconcileExecution({ ...identity, executionId });
    assert.equal(running.status, "unknown");
    assert.equal(running.reconciliationEvidence?.evidenceId, "running-native-turn");
    assert.equal(
      runtime
        .getHistory(task.id)
        ?.inputs.find((input) => input.text === "do not duplicate this operation")?.status,
      "unknown",
    );
    assert.equal(engine.reconcileCalls.length, 1);

    engine.reconcileResult = {
      status: "completed",
      result: "the original operation finished",
      evidence: { source: "engine", evidenceId: "terminal-native-turn" },
    };
    const terminal = await runtime.reconcileExecution({ ...identity, executionId });
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.result, "the original operation finished");
    assert.equal(engine.reconcileCalls.length, 2);
    assert.equal(engine.runs.length, 1);
    assert.equal(engine.createSessionCalls, 1);

    await runtime.restoreTaskSession(identity);
    assert.equal(engine.resumeCalls.length, 1);
    assert.equal(engine.resumeCalls[0]?.session, task.session.nativeSessionId);
    assert.equal(engine.createSessionCalls, 1);
    assert.equal(engine.runs.length, 1);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued Input rechecks the current Engine capability after the preceding turn ends", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "A" });
    const queued = await runtime.submitInput({ ...identity, text: "B", delivery: "queue" });
    engine.setCapability("execution.run", {
      support: "unsupported",
      availability: "available",
      reason: "execution was disabled while B waited",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "capability-A-accepted" },
    });
    engine.emit(0, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "capability-A-started" },
    });
    engine.emit(0, {
      type: "execution.completed",
      evidence: { source: "engine", evidenceId: "capability-A-completed" },
    });
    await until(
      () =>
        runtime.getHistory(task.id)!.inputs.find((input) => input.id === queued.id)?.status ===
        "rejected",
    );
    assert.match(
      runtime.getHistory(task.id)?.inputs.find((input) => input.id === queued.id)?.error ?? "",
      /execution was disabled/i,
    );
    assert.equal(engine.runs.length, 1);
  } finally {
    runtime.close();
  }
});

test("an unknown queued dispatch blocks later Inputs without resending the command", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "A" });
    const queued = await runtime.submitInput({
      ...identity,
      text: "B",
      delivery: "queue",
      idempotencyKey: "unknown-b",
    });
    const later = await runtime.submitInput({ ...identity, text: "C", delivery: "queue" });
    engine.runFailure = new EngineContractError({
      kind: "result-unknown",
      operation: "execution.run",
      message: "native sendText ACK was lost",
      sideEffects: "possible",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "unknown-A-accepted" },
    });
    engine.emit(0, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "unknown-A-started" },
    });
    engine.emit(0, {
      type: "execution.completed",
      evidence: { source: "engine", evidenceId: "unknown-A-completed" },
    });
    await until(
      () =>
        runtime.getHistory(task.id)!.inputs.find((input) => input.id === queued.id)?.status ===
        "unknown",
    );
    const history = runtime.getHistory(task.id)!;
    assert.equal(history.inputs.find((input) => input.id === later.id)?.status, "rejected");
    assert.match(
      history.inputs.find((input) => input.id === queued.id)?.error ?? "",
      /ACK was lost/i,
    );
    assert.match(
      history.inputs.find((input) => input.id === later.id)?.error ?? "",
      /unknown native result/i,
    );
    assert.equal(engine.runs.length, 1);
    assert.equal(history.executions.length, 1);
    assert.equal(
      (
        await runtime.submitInput({
          ...identity,
          text: "B",
          delivery: "queue",
          idempotencyKey: "unknown-b",
        })
      ).status,
      "unknown",
    );
    assert.equal(engine.runs.length, 1);
  } finally {
    runtime.close();
  }
});

test("Runtime rejects busy queued attachments and records queue cancellation", async () => {
  const engine = new ManualEngine();
  let now = 0;
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
    now: () => now,
  });
  try {
    const task = await runtime.createTask({
      engineId: "manual",
      environment,
      authorization: { ...authorization, id: "expiring-queue-grant", expiresAt: 5 },
    });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "A" });
    await assert.rejects(
      runtime.submitInput({
        ...identity,
        text: "queued with file",
        delivery: "queue",
        attachments: [
          { id: "attachment-1", fileName: "note.txt", mimeType: "text/plain", sizeBytes: 4 },
        ],
      }),
      /support text only/i,
    );
    const queued = await runtime.submitInput({ ...identity, text: "cancel me", delivery: "queue" });
    now = 10;
    const cancelled = runtime.cancelQueuedInput({ ...identity, inputId: queued.id });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error, "Cancelled before native dispatch.");
    assert.equal(engine.runs.length, 1);
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "A-accepted" },
    });
    engine.emit(0, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "A-started" },
    });
    engine.emit(0, {
      type: "execution.completed",
      evidence: { source: "engine", evidenceId: "A-completed" },
    });
    await until(
      () =>
        runtime.getHistory(task.id)!.inputs.find((input) => input.id === queued.id)?.status ===
        "cancelled",
    );
    assert.equal(engine.runs.length, 1);
    assert.equal(runtime.getHistory(task.id)?.executions.length, 1);
  } finally {
    runtime.close();
  }
});

test("queued Inputs keep a persisted order and dispatch each exactly once", async () => {
  const engine = new ManualEngine();
  const directory = await mkdtemp(join(tmpdir(), "anyagent-queue-order-"));
  const databasePath = join(directory, "runtime.sqlite");
  const runtime = createTaskRuntime({
    databasePath,
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "A" });
    const b = await runtime.submitInput({ ...identity, text: "B", delivery: "queue" });
    await runtime.submitInput({ ...identity, text: "C", delivery: "queue" });
    const d = await runtime.submitInput({ ...identity, text: "D", delivery: "queue" });
    runtime.moveQueuedInput({ ...identity, inputId: d.id, beforeInputId: b.id });
    assert.deepEqual(
      runtime
        .getHistory(task.id)!
        .inputs.filter((input) => input.status === "queued")
        .sort((left, right) => left.queuePosition! - right.queuePosition!)
        .map((input) => input.text),
      ["D", "B", "C"],
    );
    const database = new DatabaseSync(databasePath);
    try {
      const stored = database
        .prepare("SELECT data FROM runtime_records WHERE kind = 'input' AND id = ?")
        .get(d.id) as { data: string };
      assert.equal(JSON.parse(stored.data).queuePosition, 0);
    } finally {
      database.close();
    }
    assert.throws(
      () =>
        runtime.moveQueuedInput({
          ...identity,
          inputId: d.id,
          beforeInputId: "missing",
        }),
      /anchor/i,
    );
    const finish = (runIndex: number, label: string) => {
      engine.emit(runIndex, {
        type: "input.accepted",
        evidence: { source: "engine", evidenceId: `${label}-accepted` },
      });
      engine.emit(runIndex, {
        type: "execution.started",
        evidence: { source: "engine", evidenceId: `${label}-started` },
      });
      engine.emit(runIndex, {
        type: "execution.completed",
        evidence: { source: "engine", evidenceId: `${label}-completed` },
      });
    };
    finish(0, "A");
    await until(() => engine.runs.length === 2);
    assert.equal(engine.runs[1]?.input, "D");
    finish(1, "D");
    await until(() => engine.runs.length === 3);
    assert.equal(engine.runs[2]?.input, "B");
    finish(2, "B");
    await until(() => engine.runs.length === 4);
    assert.equal(engine.runs[3]?.input, "C");
    finish(3, "C");
    await until(() =>
      runtime.getHistory(task.id)!.inputs.every((input) => input.status === "completed"),
    );
    assert.deepEqual(
      engine.runs.map((run) => run.input),
      ["A", "D", "B", "C"],
    );
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("send-now requests a real stop and waits for terminal evidence before promoting its target", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "A" });
    const b = await runtime.submitInput({ ...identity, text: "B", delivery: "queue" });
    const c = await runtime.submitInput({ ...identity, text: "C", delivery: "queue" });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "A-accepted" },
    });
    engine.emit(0, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "A-started" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]?.status === "started");
    const receipt = await runtime.sendQueuedInputNow({ ...identity, inputId: c.id });
    assert.equal(receipt.stopRequest?.status, "requested");
    assert.equal(engine.interrupts, 1);
    assert.equal(engine.runs.length, 1, "a stop delivery ACK is not terminal evidence");
    await assert.rejects(
      runtime.sendQueuedInputNow({ ...identity, inputId: b.id }),
      /unresolved StopRequest/i,
    );
    assert.equal(engine.interrupts, 1, "repeated send-now must not dispatch another stop");
    assert.deepEqual(
      runtime
        .getHistory(task.id)!
        .inputs.filter((input) => input.status === "queued")
        .sort((left, right) => left.queuePosition! - right.queuePosition!)
        .map((input) => input.text),
      ["C", "B"],
    );
    engine.emit(0, {
      type: "execution.stopped",
      evidence: { source: "engine", evidenceId: "A-native-stopped" },
    });
    await until(() => engine.runs.length === 2);
    assert.equal(engine.runs[1]?.input, "C");
    assert.equal(runtime.getHistory(task.id)!.stopRequests[0]?.status, "confirmed");
    assert.equal(
      runtime.getHistory(task.id)!.inputs.find((input) => input.id === b.id)?.status,
      "queued",
    );
  } finally {
    runtime.close();
  }
});

test("send-now restores queue order when stop qualification fails before delivery", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "A" });
    await runtime.submitInput({ ...identity, text: "B", delivery: "queue" });
    const c = await runtime.submitInput({ ...identity, text: "C", delivery: "queue" });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "A-accepted" },
    });
    engine.emit(0, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "A-started" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]?.status === "started");
    let probes = 0;
    engine.refreshHandler = async () => {
      if (++probes === 2) throw new Error("capability probe failed");
      return engine.getCapabilities();
    };
    await assert.rejects(
      runtime.sendQueuedInputNow({ ...identity, inputId: c.id }),
      /queue order was restored/i,
    );
    assert.equal(engine.interrupts, 0);
    assert.deepEqual(
      runtime
        .getHistory(task.id)!
        .inputs.filter((input) => input.status === "queued")
        .sort((left, right) => left.queuePosition! - right.queuePosition!)
        .map((input) => input.text),
      ["B", "C"],
    );
  } finally {
    runtime.close();
  }
});

const environment: RuntimeEnvironment = {
  id: "workspace-a",
  kind: "workspace",
  label: "Project A",
  workDirectory: "/work/project-a",
  provenance: { source: "host-workspace-picker", resourceId: "workspace-a" },
};

const authorization: RuntimeAuthorization = {
  id: "grant-a",
  environmentId: "workspace-a",
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
    "task.freeze",
    "task.close",
  ],
  expiresAt: null,
  issuer: "host",
};

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Timed out waiting for Runtime state to update.");
}

test("Runtime adopts a Host-authorized native Session once under a new product Task", async () => {
  const engine = new ManualEngine();
  const nativeSessionId = "share-import-session" as EngineSessionRef;
  engine.sessions.push(nativeSessionId);
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  const imported = {
    engineId: "manual",
    environment,
    authorization,
    nativeSessionId,
    sharedContext: {
      contextId: "shared-context-1",
      title: "Imported conversation",
      shareUrl: "https://example.test/share/abc",
    },
  };
  try {
    await assert.rejects(
      runtime.adoptImportedSession({
        ...imported,
        authorization: { ...authorization, scopes: ["execution.run"] },
      }),
      /Host authorization must include session\.create/,
    );
    assert.equal(engine.resumeCalls.length, 0);

    const task = await runtime.adoptImportedSession(imported);
    assert.equal(task.session.nativeSessionId, nativeSessionId);
    assert.deepEqual(task.sharedContext, imported.sharedContext);
    assert.equal(engine.createSessionCalls, 0);
    assert.equal(engine.resumeCalls.length, 1);

    await assert.rejects(runtime.adoptImportedSession(imported), /already belongs to a Task/);
    assert.equal(runtime.listTasks().length, 1);
    assert.equal(engine.resumeCalls.length, 1);
  } finally {
    runtime.close();
  }
});

test("Session compaction requires Task ownership and scope, records native terminal outcomes only", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const otherTask = await runtime.createTask({ engineId: "manual", environment, authorization });
    const noCompactScope = await runtime.createTask({
      engineId: "manual",
      environment,
      authorization: {
        ...authorization,
        id: "grant-without-compact",
        scopes: authorization.scopes.filter((scope) => scope !== "session.compact"),
      },
    });
    const request = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
      instructions: "Keep decisions and open questions",
    };

    await assert.rejects(
      runtime.compactSession({ ...request, participantId: otherTask.participant.id }),
      /participant|ownership/i,
    );
    await assert.rejects(
      runtime.compactSession({ ...request, sessionId: otherTask.session.id }),
      /participant|Session ownership/i,
    );
    await assert.rejects(
      runtime.compactSession({ ...request, authorizationId: noCompactScope.authorizationId }),
      /authorization/i,
    );
    await assert.rejects(
      runtime.compactSession({
        taskId: noCompactScope.id,
        participantId: noCompactScope.participant.id,
        sessionId: noCompactScope.session.id,
        authorizationId: noCompactScope.authorizationId,
      }),
      /session.compact scope/i,
    );
    assert.equal(engine.compactCalls.length, 0);

    for (const status of ["completed", "skipped", "failed", "cancelled"] as const) {
      const evidence = { source: "engine" as const, evidenceId: `terminal-${status}` };
      engine.compactReceipt = {
        status,
        evidence,
        ...(status === "failed" ? { reason: "native error" } : {}),
      };
      const operation = await runtime.compactSession(request);
      assert.equal(operation.status, status);
      assert.equal(operation.taskId, task.id);
      assert.equal(operation.participantId, task.participant.id);
      assert.equal(operation.sessionId, task.session.id);
      assert.equal(operation.acceptedEvidence?.evidenceId, `${operation.id}:accepted`);
      assert.equal(operation.terminalEvidence?.evidenceId, evidence.evidenceId);
      assert.ok(operation.terminalAt !== null);
    }

    const history = runtime.getHistory(task.id)!;
    assert.deepEqual(history.inputs, []);
    assert.deepEqual(history.executions, []);
    assert.deepEqual(
      history.compactOperations.map((operation) => operation.status),
      ["completed", "skipped", "failed", "cancelled"],
    );
    assert.equal(engine.compactCalls.length, 4);
    assert.equal(engine.compactCalls[0]?.commandId, history.compactOperations[0]?.id);
    assert.equal(engine.compactCalls[0]?.instructions, "Keep decisions and open questions");
    assert.equal("instructions" in history.compactOperations[0]!, false);
  } finally {
    runtime.close();
  }
});

test("Runtime restart marks a pending compaction unknown and never resends it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-compact-restart-"));
  const databasePath = join(directory, "runtime.sqlite");
  const engine = new ManualEngine();
  engine.compactHandler = () => new Promise<EngineCompactReceipt>(() => undefined);
  const options = { databasePath, engines: new Map([["manual", engine]]) };
  let runtime = createTaskRuntime(options);
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const request = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    const pending = runtime.compactSession(request);
    void pending.catch(() => undefined);
    await until(() => engine.compactCalls.length === 1);
    runtime.close();

    runtime = createTaskRuntime(options);
    const operation = runtime.getHistory(task.id)?.compactOperations[0];
    assert.equal(operation?.status, "unknown");
    assert.match(operation?.reason ?? "", /cannot be safely reattached or resent/i);
    assert.equal(operation?.unknownEvidence?.source, "host");
    await assert.rejects(() => runtime.compactSession(request), /Session is unknown/i);
    assert.equal(engine.compactCalls.length, 1);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates distinct Task ownership and persists serializable projections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-runtime-"));
  const databasePath = join(directory, "runtime.sqlite");
  const engine = new ManualEngine();
  const options = {
    databasePath,
    engines: new Map([["manual", engine]]),
    idFactory: (() => {
      let n = 0;
      return (kind: string) => `${kind}-${++n}`;
    })(),
  };
  try {
    const firstRuntime = createTaskRuntime(options);
    assert.equal(firstRuntime.listEngines()[0]?.state, "unknown");
    const first = await firstRuntime.createTask({
      engineId: "manual",
      environment,
      authorization,
      credentialSource: { kind: "host", label: "Desktop keychain" },
    });
    const second = await firstRuntime.createTask({
      engineId: "manual",
      environment,
      authorization,
      credentialSource: { kind: "host", label: "Desktop keychain" },
    });
    assert.notEqual(first.participant.id, second.participant.id);
    assert.notEqual(first.session.id, second.session.id);
    assert.equal(first.session.nativeSessionId, engine.sessions[0]);
    assert.notEqual(first.session.id, first.session.nativeSessionId);
    assert.equal(first.session.status, "active");
    assert.doesNotThrow(() => JSON.stringify(first));
    firstRuntime.close();

    const database = new DatabaseSync(databasePath);
    const storedSession = database
      .prepare("SELECT data FROM runtime_records WHERE kind = ? AND id = ?")
      .get("session", first.session.id) as { data: string };
    assert.equal(JSON.parse(storedSession.data).nativeSessionId, engine.sessions[0]);
    database.close();

    const restored = createTaskRuntime({ databasePath, engines: new Map() });
    assert.equal(restored.listTasks().length, 2);
    assert.equal(restored.getTask(first.id)?.session.status, "unknown");
    assert.equal(restored.getTask(first.id)?.environment.workDirectory, "/work/project-a");
    assert.equal(restored.getTask(first.id)?.credentialSource.label, "Desktop keychain");
    assert.equal(restored.getTask(first.id)?.currentEngine.state, "unknown");
    assert.equal(
      restored.getTask(first.id)?.engine.capabilities["execution.run"].availability,
      "available",
    );
    restored.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host-staged attachment tickets are Task-bound, one-use, and never persist local paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-attachment-runtime-"));
  const databasePath = join(directory, "runtime.sqlite");
  const engine = new ManualEngine();
  const stageRequests: RuntimeAttachmentStageRequest[] = [];
  const runtime = createTaskRuntime({
    databasePath,
    engines: new Map([["manual", engine]]),
    stageAttachment: async (request) => {
      stageRequests.push(request);
      return { locator: `host-resolved:${request.attachmentId}`, sizeBytes: 12 };
    },
  });
  try {
    const first = await runtime.createTask({ engineId: "manual", environment, authorization });
    const attachment = await runtime.stageAttachment({
      taskId: first.id,
      participantId: first.participant.id,
      sessionId: first.session.id,
      authorizationId: authorization.id,
      localPath: "/private/notes.md",
      fileName: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: 12,
    });
    assert.notEqual(attachment.id, "/private/notes.md");
    assert.equal(JSON.stringify(attachment).includes("/private/notes.md"), false);
    assert.equal(stageRequests[0]?.taskId, first.id);
    assert.equal(stageRequests[0]?.nativeSessionId, first.session.nativeSessionId);
    assert.equal(stageRequests[0]?.localPath, "/private/notes.md");

    const acceptedInput = await runtime.submitInput({
      taskId: first.id,
      participantId: first.participant.id,
      sessionId: first.session.id,
      authorizationId: authorization.id,
      text: "summarize this file",
      attachments: [attachment],
    });
    assert.deepEqual(acceptedInput.attachments, [attachment]);
    assert.deepEqual(runtime.getHistory(first.id)?.inputs[0]?.attachments, [attachment]);
    assert.deepEqual(engine.runs[0]?.attachments, [
      { ...attachment, locator: `host-resolved:${attachment.id}` },
    ]);
    assert.equal(JSON.stringify(runtime.getHistory(first.id)).includes("host-resolved:"), false);
    const database = new DatabaseSync(databasePath);
    const stored = database
      .prepare("SELECT data FROM runtime_records WHERE kind = ? AND id = ?")
      .get("attachment", attachment.id) as { data: string };
    assert.equal(stored.data.includes("/private/notes.md"), false);
    assert.equal(stored.data.includes("host-resolved:"), false);
    database.close();

    const second = await runtime.createTask({ engineId: "manual", environment, authorization });
    await assert.rejects(
      () =>
        runtime.submitInput({
          taskId: second.id,
          participantId: second.participant.id,
          sessionId: second.session.id,
          authorizationId: authorization.id,
          text: "reuse another Task's attachment",
          attachments: [attachment],
        }),
      /expired or does not belong to this Task and Session/i,
    );
    const rejected = runtime.getHistory(second.id)?.inputs[0];
    assert.equal(rejected?.status, "rejected");
    assert.deepEqual(rejected?.attachments, [attachment]);
    assert.equal(engine.runs.length, 1);
    assert.equal(stageRequests.length, 1);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Runtime rejects renderer-supplied attachment metadata without a Host-staged ticket", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const attachment = {
      id: "renderer-supplied-ticket",
      fileName: "secret.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
    };
    await assert.rejects(
      () =>
        runtime.submitInput({
          taskId: task.id,
          participantId: task.participant.id,
          sessionId: task.session.id,
          authorizationId: authorization.id,
          text: "do not dispatch an unverified attachment",
          attachments: [attachment],
        }),
      /expired or does not belong to this Task and Session/i,
    );
    assert.deepEqual(runtime.getHistory(task.id)?.inputs[0]?.attachments, [attachment]);
    assert.equal(runtime.getHistory(task.id)?.inputs[0]?.status, "rejected");
    assert.equal(engine.runs.length, 0);
  } finally {
    runtime.close();
  }
});

test("attachment staging rechecks Task eligibility after the capability probe", async () => {
  const engine = new ManualEngine();
  let entered!: () => void;
  let release!: () => void;
  const probeEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const heldProbe = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stageCalls = 0;
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
    stageAttachment: async () => {
      stageCalls += 1;
      return { locator: "staged", sizeBytes: 1 };
    },
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    engine.refreshHandler = async () => {
      entered();
      await heldProbe;
      return engine.getCapabilities();
    };
    const staging = runtime.stageAttachment({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
      localPath: "/private/file.txt",
      fileName: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
    });
    await probeEntered;
    runtime.freezeTask({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
      reason: "freeze during capability probe",
    });
    release();
    await assert.rejects(staging, /frozen/i);
    assert.equal(stageCalls, 0);
  } finally {
    runtime.close();
  }
});

test("concurrent attachment staging shares a capability check and dispatches both tickets", async () => {
  const engine = new ManualEngine();
  let releaseProbe!: () => void;
  const heldProbe = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let probes = 0;
  let stageCalls = 0;
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
    stageAttachment: async (request) => {
      stageCalls += 1;
      return { locator: `host:${request.attachmentId}`, sizeBytes: 1 };
    },
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    engine.refreshHandler = async () => {
      probes += 1;
      await heldProbe;
      return engine.getCapabilities();
    };
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    const staged = Promise.allSettled(
      ["one.txt", "two.txt"].map((fileName) =>
        runtime.stageAttachment({
          ...identity,
          localPath: `/private/${fileName}`,
          fileName,
          mimeType: "text/plain",
          sizeBytes: 1,
        }),
      ),
    );
    releaseProbe();
    const results = await staged;
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );
    assert.equal(probes, 1);
    assert.equal(stageCalls, 2);
    const attachments = results.map((result) => {
      assert.equal(result.status, "fulfilled");
      return result.value;
    });
    await runtime.submitInput({ ...identity, text: "read both", attachments });
    assert.deepEqual(
      engine.runs[0]?.attachments?.map((attachment) => attachment.fileName),
      ["one.txt", "two.txt"],
    );
  } finally {
    runtime.close();
  }
});

test("an adapter change during shared attachment probing cannot stage stale tickets", async () => {
  const engine = new ManualEngine();
  let releaseProbe!: () => void;
  const heldProbe = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let stageCalls = 0;
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
    stageAttachment: async () => {
      stageCalls += 1;
      return { locator: "staged", sizeBytes: 1 };
    },
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const oldSnapshot = engine.getCapabilities();
    engine.refreshHandler = async () => {
      await heldProbe;
      return oldSnapshot;
    };
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    const staging = Promise.allSettled(
      ["one.txt", "two.txt"].map((fileName) =>
        runtime.stageAttachment({
          ...identity,
          localPath: `/private/${fileName}`,
          fileName,
          mimeType: "text/plain",
          sizeBytes: 1,
        }),
      ),
    );
    engine.setCapability("execution.run", {
      support: "supported",
      availability: "temporarily-unavailable",
      reason: "provider went offline",
    });
    engine.refreshHandler = async () => engine.getCapabilities();
    const newer = await runtime.refreshEngines();
    assert.equal(newer[0]?.capabilities["execution.run"].availability, "temporarily-unavailable");
    releaseProbe();
    const results = await staging;
    assert.deepEqual(
      results.map((result) => result.status),
      ["rejected", "rejected"],
    );
    assert.equal(stageCalls, 0);
    assert.equal(
      runtime.getTask(task.id)?.currentEngine.capabilities["execution.run"].availability,
      "temporarily-unavailable",
    );
  } finally {
    runtime.close();
  }
});

test("fork rechecks its source Task after the final capability probe", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const source = await runtime.createTask({ engineId: "manual", environment, authorization });
    await runtime.submitInput({
      taskId: source.id,
      participantId: source.participant.id,
      sessionId: source.session.id,
      authorizationId: source.authorizationId,
      text: "source round",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "fork-race-admit" },
    });
    await until(() => runtime.getHistory(source.id)!.executions.length === 1);
    const execution = runtime.getHistory(source.id)!.executions[0]!;
    engine.emit(0, {
      type: "execution.completed",
      result: "source answer",
      evidence: { source: "engine", evidenceId: "fork-race-complete" },
    });
    await until(() => runtime.getHistory(source.id)!.executions[0]!.status === "completed");

    let probeCount = 0;
    let entered!: () => void;
    let release!: () => void;
    const probeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const heldProbe = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.refreshHandler = async () => {
      probeCount += 1;
      if (probeCount === 3) {
        entered();
        await heldProbe;
      }
      return engine.getCapabilities();
    };
    const fork = runtime.forkTask({
      taskId: source.id,
      participantId: source.participant.id,
      sessionId: source.session.id,
      authorizationId: source.authorizationId,
      executionId: execution.id,
      authorization: { ...authorization, id: "grant-fork-race" },
    });
    await probeEntered;
    runtime.freezeTask({
      taskId: source.id,
      participantId: source.participant.id,
      sessionId: source.session.id,
      authorizationId: source.authorizationId,
      reason: "freeze during capability probe",
    });
    release();
    await assert.rejects(fork, /frozen/i);
    assert.equal(engine.forkCalls.length, 0);
  } finally {
    runtime.close();
  }
});

test("Adapter dispatch rechecks an authorization that expires while it waits", async () => {
  const engine = new ManualEngine();
  let now = 1;
  let entered!: () => void;
  let release!: () => void;
  const dispatchEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const heldDispatch = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
    now: () => now,
  });
  try {
    const grant = { ...authorization, expiresAt: 2 };
    const task = await runtime.createTask({
      engineId: "manual",
      environment,
      authorization: grant,
    });
    engine.beforeRunDispatch = async () => {
      entered();
      await heldDispatch;
    };
    const submission = runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
      text: "expires before native dispatch",
    });
    await dispatchEntered;
    now = 2;
    release();
    await assert.rejects(submission, /expired/i);
    assert.equal(engine.runs.length, 0);
    assert.equal(runtime.getHistory(task.id)?.inputs[0]?.status, "rejected");
  } finally {
    runtime.close();
  }
});

test("only native input.accepted evidence creates a product Execution", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const input = await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      text: "hello",
    });
    assert.equal(input.status, "received");
    assert.equal(runtime.getHistory(task.id)?.executions.length, 0);

    const acceptedEvent = engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "accepted-1" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    const execution = runtime.getHistory(task.id)!.executions[0]!;
    assert.equal(execution.inputId, input.id);
    assert.equal(execution.status, "accepted");

    engine.emit(0, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "started-1" },
    });
    const delta = engine.emit(0, {
      type: "message.delta",
      text: "streamed answer",
      messageId: "native-message-1",
      blockId: "native-block-1",
    });
    await until(() =>
      runtime.getHistory(task.id)!.events.some((event) => event.nativeEventId === delta.eventId),
    );
    assert.deepEqual(
      runtime.getHistory(task.id)!.events.find((event) => event.nativeEventId === delta.eventId)
        ?.payload,
      {
        type: "message.delta",
        text: "streamed answer",
        messageId: "native-message-1",
        blockId: "native-block-1",
      },
    );
    assert.throws(
      () =>
        runtime.closeTask({
          taskId: task.id,
          participantId: task.participant.id,
          sessionId: task.session.id,
          authorizationId: authorization.id,
          outcome: "completed",
        }),
      /unresolved/i,
    );
    engine.emit(0, {
      type: "execution.completed",
      result: "done",
      evidence: { source: "engine", evidenceId: "complete-1" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]!.status === "completed");
    assert.equal(runtime.getHistory(task.id)!.inputs[0]!.status, "completed");

    engine.emit(
      0,
      { type: "input.accepted", evidence: { source: "engine", evidenceId: "accepted-1" } },
      {
        eventId: acceptedEvent.eventId,
        sourceSequence: acceptedEvent.sourceSequence,
      },
    );
    await until(() =>
      runtime
        .getHistory(task.id)!
        .integrityIssues.some((issue) => issue.type === "duplicate-event"),
    );
    engine.emit(
      0,
      { type: "message.delta", text: "conflicting reuse" },
      {
        eventId: acceptedEvent.eventId,
        sourceSequence: acceptedEvent.sourceSequence,
      },
    );
    await until(() =>
      runtime.getHistory(task.id)!.integrityIssues.some((issue) => issue.type === "event-conflict"),
    );
    assert.equal(runtime.getHistory(task.id)!.executions[0]!.status, "completed");

    const secondInput = await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      text: "same Task, second round",
    });
    assert.equal(secondInput.status, "received");
    engine.emit(1, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "accepted-2" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 2);
    engine.emit(1, {
      type: "execution.completed",
      result: "round two",
      evidence: { source: "engine", evidenceId: "complete-2" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[1]!.status === "completed");

    runtime.closeTask({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      outcome: "completed",
    });
    const lateEvent = engine.emit(0, { type: "message.delta", text: "late message" });
    await until(() =>
      runtime.getHistory(task.id)!.integrityIssues.some((issue) => issue.type === "late-event"),
    );
    assert.equal(runtime.getTask(task.id)?.status, "completed");
    const storedLateEvent = runtime
      .getHistory(task.id)!
      .events.find((event) => event.nativeEventId === lateEvent.eventId);
    assert.equal(storedLateEvent?.taskId, task.id);
    assert.equal(storedLateEvent?.executionId, execution.id);
    await assert.rejects(
      () =>
        runtime.submitInput({
          taskId: task.id,
          participantId: task.participant.id,
          sessionId: task.session.id,
          authorizationId: authorization.id,
          text: "after close",
        }),
      /completed/i,
    );
  } finally {
    runtime.close();
  }
});

test("fork reserves a new Task and native child without reusing the source Session", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const source = await runtime.createTask({ engineId: "manual", environment, authorization });
    await runtime.submitInput({
      taskId: source.id,
      participantId: source.participant.id,
      sessionId: source.session.id,
      authorizationId: authorization.id,
      text: "source round",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "fork-admit" },
    });
    await until(() => runtime.getHistory(source.id)!.executions.length === 1);
    const execution = runtime.getHistory(source.id)!.executions[0]!;
    engine.emit(0, {
      type: "execution.completed",
      result: "source answer",
      evidence: { source: "engine", evidenceId: "fork-complete" },
    });
    await until(() => runtime.getHistory(source.id)!.executions[0]!.status === "completed");

    const childAuthorization = { ...authorization, id: "grant-fork-child" };
    const request = {
      taskId: source.id,
      participantId: source.participant.id,
      sessionId: source.session.id,
      authorizationId: authorization.id,
      executionId: execution.id,
      authorization: childAuthorization,
    };
    await assert.rejects(() => runtime.forkTask({ ...request, executionId: "wrong" }));
    await assert.rejects(() => runtime.forkTask({ ...request, authorizationId: "wrong" }));
    assert.equal(engine.forkCalls.length, 0);

    const child = await runtime.forkTask(request);
    assert.notEqual(child.id, source.id);
    assert.notEqual(child.participant.id, source.participant.id);
    assert.notEqual(child.session.id, source.session.id);
    assert.notEqual(child.session.nativeSessionId, source.session.nativeSessionId);
    assert.notEqual(child.authorizationId, source.authorizationId);
    assert.deepEqual(child.forkedFrom, {
      taskId: source.id,
      inputId: execution.inputId,
      executionId: execution.id,
    });
    assert.equal(engine.createSessionCalls, 1);
    assert.equal(engine.forkCalls.length, 1);
    assert.equal(engine.forkCalls[0]?.sourceExecutionId, engine.runs[0]?.executionId);
    assert.equal(runtime.getHistory(child.id)?.inputs.length, 0);
    assert.equal(runtime.getHistory(child.id)?.executions.length, 0);
    await runtime.submitInput({
      taskId: child.id,
      participantId: child.participant.id,
      sessionId: child.session.id,
      authorizationId: child.authorizationId,
      text: "child round",
    });
    assert.equal(engine.runs[1]?.session, child.session.nativeSessionId);
  } finally {
    runtime.close();
  }
});

test("uncertain native fork leaves one frozen child instead of creating another Session", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const source = await runtime.createTask({ engineId: "manual", environment, authorization });
    await runtime.submitInput({
      taskId: source.id,
      participantId: source.participant.id,
      sessionId: source.session.id,
      authorizationId: authorization.id,
      text: "source round",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "fork-unknown-admit" },
    });
    await until(() => runtime.getHistory(source.id)!.executions.length === 1);
    engine.emit(0, {
      type: "execution.completed",
      result: "source answer",
      evidence: { source: "engine", evidenceId: "fork-unknown-complete" },
    });
    await until(() => runtime.getHistory(source.id)!.executions[0]!.status === "completed");
    engine.forkFailure = new Error("reply lost after native side effect");
    await assert.rejects(
      () =>
        runtime.forkTask({
          taskId: source.id,
          participantId: source.participant.id,
          sessionId: source.session.id,
          authorizationId: source.authorizationId,
          executionId: runtime.getHistory(source.id)!.executions[0]!.id,
          authorization: { ...authorization, id: "grant-unknown-child" },
        }),
      /reply lost/,
    );
    const child = runtime.listTasks().find((task) => task.id !== source.id)!;
    assert.equal(child.status, "frozen");
    assert.equal(child.session.status, "unknown");
    assert.equal(child.session.nativeSessionId, null);
    assert.equal(engine.forkCalls.length, 1);
    assert.equal(engine.createSessionCalls, 1);
  } finally {
    runtime.close();
  }
});

test("edit and retry create new product Input and Execution in the same Task and Session", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
    stageAttachment: async () => ({ locator: "host:source-attachment", sizeBytes: 12 }),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    const completeRun = async (index: number, result: string) => {
      engine.emit(index, {
        type: "input.accepted",
        evidence: { source: "engine", evidenceId: `accept-${index}` },
      });
      await until(() => runtime.getHistory(task.id)!.executions.length === index + 1);
      engine.emit(index, {
        type: "execution.completed",
        result,
        evidence: { source: "engine", evidenceId: `complete-${index}` },
      });
      await until(() => runtime.getHistory(task.id)!.executions[index]!.status === "completed");
    };
    const attachment = await runtime.stageAttachment({
      ...identity,
      localPath: "/tmp/source.md",
      fileName: "source.md",
      mimeType: "text/markdown",
      sizeBytes: 12,
    });
    await runtime.submitInput({ ...identity, text: "original text", attachments: [attachment] });
    await completeRun(0, "original answer");
    const original = structuredClone(runtime.getHistory(task.id)!);
    await assert.rejects(() =>
      runtime.reviseTurn({
        ...identity,
        sourceExecutionId: "wrong",
        kind: "edit",
        text: "edited text",
      }),
    );
    assert.equal(engine.runs.length, 1);
    await assert.rejects(
      () =>
        runtime.reviseTurn({
          ...identity,
          sourceExecutionId: original.executions[0]!.id,
          kind: "edit",
          text: "unsafe edit",
          retainedAttachmentIds: ["attachment-from-another-task"],
        }),
      /does not belong to the source Input/u,
    );
    assert.equal(engine.runs.length, 1);

    const edited = await runtime.reviseTurn({
      ...identity,
      sourceExecutionId: original.executions[0]!.id,
      kind: "edit",
      text: "edited text",
      retainedAttachmentIds: [],
    });
    assert.equal(edited.text, "edited text");
    assert.deepEqual(edited.revisionOf, {
      kind: "edit",
      inputId: original.inputs[0]!.id,
      executionId: original.executions[0]!.id,
    });
    assert.equal(engine.runs[1]?.session, task.session.nativeSessionId);
    assert.equal(engine.runs[1]?.revision?.sourceExecutionId, engine.runs[0]?.executionId);
    assert.equal(engine.runs[1]?.executionId, engine.runs[1]?.revision?.commandId);
    assert.deepEqual(edited.attachments, []);
    assert.deepEqual(engine.runs[1]?.revision?.sourceAttachments, [
      {
        fileName: "source.md",
        mimeType: "text/markdown",
        sizeBytes: 12,
      },
    ]);
    assert.deepEqual(engine.runs[1]?.revision?.retainedAttachmentIndices, []);
    await completeRun(1, "edited answer");

    const retrySource = runtime.getHistory(task.id)!.executions[1]!;
    const retried = await runtime.reviseTurn({
      ...identity,
      sourceExecutionId: retrySource.id,
      kind: "retry",
    });
    assert.equal(retried.text, "edited text");
    assert.deepEqual(retried.revisionOf, {
      kind: "retry",
      inputId: edited.id,
      executionId: retrySource.id,
    });
    await completeRun(2, "retried answer");
    const final = runtime.getHistory(task.id)!;
    assert.equal(final.inputs.length, 3);
    assert.equal(final.executions.length, 3);
    assert.deepEqual(final.inputs[0], original.inputs[0]);
    assert.deepEqual(final.executions[0], original.executions[0]);
    assert.deepEqual(final.executions[1]?.revisionOf, edited.revisionOf);
    assert.deepEqual(final.executions[2]?.revisionOf, retried.revisionOf);
    assert.equal(runtime.listTasks().length, 1);
    assert.equal(engine.createSessionCalls, 1);
  } finally {
    runtime.close();
  }
});

test("retry preserves a failed source but rejects a turn that may have run tools", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    const fail = async (index: number, withTool: boolean) => {
      await runtime.submitInput({ ...identity, text: `failed turn ${index}` });
      engine.emit(index, {
        type: "input.accepted",
        evidence: { source: "engine", evidenceId: `accepted-${index}` },
      });
      await until(() => runtime.getHistory(task.id)!.executions.length === index + 1);
      if (withTool)
        engine.emit(index, { type: "tool.started", toolCallId: `tool-${index}`, name: "Write" });
      engine.emit(index, {
        type: "execution.failed",
        failure: {
          kind: "execution-failed",
          operation: "execution.run",
          message: "model failed",
          sideEffects: withTool ? "possible" : "none",
        },
        evidence: { source: "engine", evidenceId: `failed-${index}` },
      });
      await until(() => runtime.getHistory(task.id)!.executions[index]!.status === "failed");
      return runtime.getHistory(task.id)!.executions[index]!;
    };
    const source = await fail(0, false);
    const retry = await runtime.reviseTurn({
      ...identity,
      sourceExecutionId: source.id,
      kind: "retry",
    });
    assert.deepEqual(retry.revisionOf, {
      kind: "retry",
      inputId: source.inputId,
      executionId: source.id,
    });
    assert.equal(runtime.getHistory(task.id)!.executions[0]!.status, "failed");
    engine.emit(1, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "retry-accepted" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 2);
    engine.emit(1, {
      type: "execution.completed",
      result: "retry answer",
      evidence: { source: "engine", evidenceId: "retry-complete" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[1]!.status === "completed");
    const unsafe = await fail(2, true);
    await assert.rejects(
      () => runtime.reviseTurn({ ...identity, sourceExecutionId: unsafe.id, kind: "retry" }),
      /may have run tools/u,
    );
    assert.equal(engine.runs.length, 3);
  } finally {
    runtime.close();
  }
});

test("an edit appends a fresh Host-staged attachment without rewriting its source", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
    stageAttachment: async () => ({ locator: "host:new-attachment", sizeBytes: 7 }),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "source" });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "source-accepted" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    engine.emit(0, {
      type: "execution.completed",
      result: "source answer",
      evidence: { source: "engine", evidenceId: "source-completed" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]!.status === "completed");
    const source = runtime.getHistory(task.id)!;
    const attachment = await runtime.stageAttachment({
      ...identity,
      localPath: "/tmp/new.txt",
      fileName: "new.txt",
      mimeType: "text/plain",
      sizeBytes: 7,
    });
    const edited = await runtime.reviseTurn({
      ...identity,
      sourceExecutionId: source.executions[0]!.id,
      kind: "edit",
      text: "edited",
      retainedAttachmentIds: [],
      attachments: [attachment],
    });
    assert.deepEqual(edited.attachments, [attachment]);
    assert.equal(source.inputs[0]!.attachments, undefined);
    assert.deepEqual(engine.runs[1]?.attachments, [
      { ...attachment, locator: "host:new-attachment" },
    ]);
    assert.deepEqual(engine.runs[1]?.revision?.sourceAttachments, []);
  } finally {
    runtime.close();
  }
});

test("unknown native revision leaves its product Input and stable command intent recorded", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "original text" });
    engine.emit(0, { type: "input.accepted", evidence: { source: "engine", evidenceId: "admit" } });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    engine.emit(0, {
      type: "execution.completed",
      result: "done",
      evidence: { source: "engine", evidenceId: "done" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]?.status === "completed");
    const sourceExecutionId = runtime.getHistory(task.id)!.executions[0]!.id;
    engine.runFailure = new Error("native revision outcome unknown");
    await assert.rejects(
      () => runtime.reviseTurn({ ...identity, sourceExecutionId, kind: "retry" }),
      /unknown/,
    );
    const history = runtime.getHistory(task.id)!;
    assert.equal(history.inputs.length, 2);
    assert.equal(history.inputs[1]?.status, "unknown");
    assert.equal(history.executions.length, 1);
    assert.deepEqual(history.inputs[1]?.revisionOf, {
      kind: "retry",
      inputId: history.inputs[0]!.id,
      executionId: sourceExecutionId,
    });
    await assert.rejects(
      () => runtime.reviseTurn({ ...identity, sourceExecutionId, kind: "retry" }),
      /unresolved input/,
    );
  } finally {
    runtime.close();
  }
});

test("assistant feedback is bound to an Execution message and repeated updates are safe", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      text: "produce a reply",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "feedback-input-accepted" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    const execution = runtime.getHistory(task.id)!.executions[0]!;
    engine.emit(0, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "feedback-execution-started" },
    });
    engine.emit(0, {
      type: "message.delta",
      text: "answer",
      messageId: "assistant-message-1",
      blockId: "text-1",
    });
    await until(() =>
      runtime
        .getHistory(task.id)!
        .events.some(
          (event) =>
            event.executionId === execution.id && event.payload.messageId === "assistant-message-1",
        ),
    );
    const request = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      executionId: execution.id,
      messageId: "assistant-message-1",
      feedback: "like" as const,
    };
    await assert.rejects(
      () => runtime.setAssistantFeedback(request),
      /feedback requires a terminal Execution/i,
    );

    engine.emit(0, {
      type: "execution.completed",
      result: "answer",
      evidence: { source: "engine", evidenceId: "feedback-execution-completed" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]!.status === "completed");
    await assert.rejects(
      () => runtime.setAssistantFeedback({ ...request, messageId: "wrong-message" }),
      /not observed in this product Execution/i,
    );

    const [first, duplicate] = await Promise.all([
      runtime.setAssistantFeedback(request),
      runtime.setAssistantFeedback(request),
    ]);
    assert.deepEqual(first, {
      status: "updated",
      evidence: { source: "engine", evidenceId: "feedback-1" },
    });
    assert.deepEqual(duplicate, first);
    assert.equal(engine.feedbackCalls.length, 1);
    assert.equal(engine.feedbackEffects, 1);

    assert.equal((await runtime.setAssistantFeedback(request)).status, "unchanged");
    assert.equal(engine.feedbackEffects, 1);
    assert.equal(
      (await runtime.setAssistantFeedback({ ...request, feedback: "dislike" })).status,
      "updated",
    );
    assert.equal(
      (await runtime.setAssistantFeedback({ ...request, feedback: null })).status,
      "updated",
    );
    assert.equal(engine.feedbackEffects, 3);

    const otherTask = await runtime.createTask({ engineId: "manual", environment, authorization });
    await assert.rejects(
      () =>
        runtime.setAssistantFeedback({
          ...request,
          taskId: otherTask.id,
          participantId: otherTask.participant.id,
          sessionId: otherTask.session.id,
        }),
      /different Task, participant, or Session/i,
    );
    assert.equal(engine.feedbackEffects, 3);

    runtime.closeTask({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      outcome: "completed",
    });
    await assert.rejects(() => runtime.setAssistantFeedback(request), /Task .* is completed/i);
  } finally {
    engine.closeEvents(0);
    runtime.close();
  }
});

test("file rewind is scoped to one terminal Execution and records native outcome", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      text: "write a file",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "file-input-accepted" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    const execution = runtime.getHistory(task.id)!.executions[0]!;
    const target = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      executionId: execution.id,
    };
    await assert.rejects(() => runtime.previewFileRewind(target), /terminal Execution/u);
    engine.emit(0, {
      type: "execution.completed",
      result: "done",
      evidence: { source: "engine", evidenceId: "file-completed" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]!.status === "completed");
    assert.equal((await runtime.getExecutionFileChanges(target))?.files, 1);
    const preview = await runtime.previewFileRewind(target);
    const other = await runtime.createTask({ engineId: "manual", environment, authorization });
    await assert.rejects(
      () =>
        runtime.applyFileRewind({
          ...target,
          taskId: other.id,
          participantId: other.participant.id,
          sessionId: other.session.id,
          expectedPreview: preview,
        }),
      /different Task, participant, or Session/u,
    );
    const applied = await runtime.applyFileRewind({ ...target, expectedPreview: preview });
    assert.equal(applied.status, "applied");
    assert.equal(applied.executionId, execution.id);
    assert.equal(engine.fileRewindEffects, 1);
    assert.equal(runtime.getHistory(task.id)?.fileRewindOperations?.[0]?.status, "applied");

    let release!: () => void;
    engine.beforeFileDispatch = () => new Promise<void>((resolve) => (release = resolve));
    const pending = runtime.applyFileRewind({ ...target, expectedPreview: preview });
    await until(() => Boolean(release));
    await assert.rejects(
      () => runtime.submitInput({ ...target, text: "too early" }),
      /unresolved file rewind/u,
    );
    engine.setCapability("workspace.file-rewind", {
      support: "unsupported",
      availability: "unknown",
    });
    release();
    const rejected = await pending;
    assert.equal(rejected.status, "rejected");
    assert.equal(engine.fileRewindEffects, 1);
    assert.equal(runtime.getHistory(task.id)?.fileRewindOperations?.[1]?.status, "rejected");
    engine.setCapability("workspace.file-rewind", {
      support: "supported",
      availability: "available",
    });
    engine.beforeFileDispatch = null;
    engine.fileRewindStatus = "unknown";
    assert.equal(
      (await runtime.applyFileRewind({ ...target, expectedPreview: preview })).status,
      "unknown",
    );
    await assert.rejects(
      () => runtime.applyFileRewind({ ...target, expectedPreview: preview }),
      /unknown file rewind/u,
    );
  } finally {
    engine.closeEvents(0);
    runtime.close();
  }
});

test("assistant feedback requires its own authorization and current Engine capability", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const withoutFeedbackScope = await runtime.createTask({
      engineId: "manual",
      environment,
      authorization: {
        ...authorization,
        id: "grant-without-feedback",
        scopes: authorization.scopes.filter((scope) => scope !== "assistant.feedback"),
      },
    });
    await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      text: "produce a reply",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "feedback-scope-accepted" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    const execution = runtime.getHistory(task.id)!.executions[0]!;
    engine.emit(0, {
      type: "message.delta",
      text: "answer",
      messageId: "assistant-message-2",
      blockId: "text-2",
    });
    engine.emit(0, {
      type: "execution.completed",
      result: "answer",
      evidence: { source: "engine", evidenceId: "feedback-scope-completed" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]!.status === "completed");

    const request = {
      taskId: withoutFeedbackScope.id,
      participantId: withoutFeedbackScope.participant.id,
      sessionId: withoutFeedbackScope.session.id,
      authorizationId: withoutFeedbackScope.authorizationId,
      executionId: execution.id,
      messageId: "assistant-message-2",
      feedback: "like" as const,
    };
    await assert.rejects(
      () => runtime.setAssistantFeedback(request),
      /Authorization lacks assistant\.feedback scope/i,
    );

    engine.setCapability("assistant.feedback", {
      support: "unsupported",
      availability: "unknown",
      reason: "Feedback was disabled in this Engine configuration.",
    });
    await assert.rejects(
      () =>
        runtime.setAssistantFeedback({
          ...request,
          taskId: task.id,
          participantId: task.participant.id,
          sessionId: task.session.id,
          authorizationId: task.authorizationId,
        }),
      /Feedback was disabled in this Engine configuration/i,
    );
    assert.equal(engine.feedbackCalls.length, 0);
  } finally {
    engine.closeEvents(0);
    runtime.close();
  }
});

test("assistant feedback requalifies Task state after asynchronous Adapter row lookup", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  let queryEntered!: () => void;
  let finishQuery!: () => void;
  const started = new Promise<void>((resolve) => (queryEntered = resolve));
  const delayed = new Promise<void>((resolve) => (finishQuery = resolve));
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({ ...identity, text: "produce a reply" });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "feedback-race-accepted" },
    });
    engine.emit(0, {
      type: "execution.started",
      evidence: { source: "engine", evidenceId: "feedback-race-started" },
    });
    engine.emit(0, {
      type: "message.delta",
      text: "answer",
      messageId: "feedback-race-message",
    });
    engine.emit(0, {
      type: "execution.completed",
      evidence: { source: "engine", evidenceId: "feedback-race-completed" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]?.status === "completed");
    const execution = runtime.getHistory(task.id)!.executions[0]!;
    engine.beforeFeedbackDispatch = async () => {
      queryEntered();
      await delayed;
    };
    const pending = runtime.setAssistantFeedback({
      ...identity,
      executionId: execution.id,
      messageId: "feedback-race-message",
      feedback: "like",
    });
    await started;
    runtime.freezeTask({ ...identity, reason: "freeze during native row lookup" });
    finishQuery();
    await assert.rejects(pending, /Task .* is frozen/i);
    assert.equal(engine.feedbackCalls.length, 0);
    assert.equal(engine.feedbackEffects, 0);
  } finally {
    runtime.close();
  }
});

test("rejects cross-Task session reuse and blocks a second input while one is unresolved", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const first = await runtime.createTask({ engineId: "manual", environment, authorization });
    const second = await runtime.createTask({ engineId: "manual", environment, authorization });
    await assert.rejects(
      () =>
        runtime.submitInput({
          taskId: second.id,
          participantId: second.participant.id,
          sessionId: first.session.id,
          authorizationId: authorization.id,
          text: "misroute",
        }),
      /ownership|session/i,
    );
    await runtime.submitInput({
      taskId: first.id,
      participantId: first.participant.id,
      sessionId: first.session.id,
      authorizationId: authorization.id,
      text: "first",
    });
    await assert.rejects(
      () =>
        runtime.submitInput({
          taskId: first.id,
          participantId: first.participant.id,
          sessionId: first.session.id,
          authorizationId: authorization.id,
          text: "second",
        }),
      /in.flight|unresolved|active/i,
    );
  } finally {
    runtime.close();
  }
});

test("interruption request is not stop confirmation; only execution.stopped is terminal evidence", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const input = await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      text: "wait",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "accepted" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    const execution = runtime.getHistory(task.id)!.executions[0]!;
    runtime.freezeTask({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      reason: "Pause work.",
    });
    assert.equal(runtime.getHistory(task.id)?.taskId, task.id);
    await assert.rejects(
      () =>
        runtime.submitInput({
          taskId: task.id,
          participantId: task.participant.id,
          sessionId: task.session.id,
          authorizationId: authorization.id,
          text: "frozen task",
        }),
      /frozen/i,
    );
    engine.interruptStatus = "temporarily-unavailable";
    const earlyStop = await runtime.requestStop({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      executionId: execution.id,
    });
    assert.equal(earlyStop.status, "temporarily-unavailable");
    assert.equal(earlyStop.deliveryStatus, "not-delivered");
    engine.interruptStatus = "requested";
    const stop = await runtime.requestStop({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      executionId: execution.id,
    });
    assert.equal(stop.status, "requested");
    assert.equal(stop.deliveryStatus, "delivered");
    assert.equal(stop.deliveryEvidence?.evidenceId, "interrupt-2");
    assert.equal(stop.stopEvidence, null);
    assert.equal(engine.interrupts, 2);
    assert.equal(runtime.getHistory(task.id)!.executions[0]!.status, "accepted");
    engine.emit(0, {
      type: "execution.stopped",
      evidence: { source: "engine", evidenceId: "stopped" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]!.status === "stopped");
    assert.equal(runtime.getHistory(task.id)!.inputs[0]!.id, input.id);
    assert.equal(runtime.getHistory(task.id)!.stopRequests[0]!.status, "temporarily-unavailable");
    assert.equal(runtime.getHistory(task.id)!.stopRequests[1]!.status, "confirmed");
    assert.equal(runtime.getHistory(task.id)!.stopRequests[1]!.deliveryStatus, "delivered");
    assert.equal(runtime.getHistory(task.id)!.stopRequests[1]!.stopEvidence?.evidenceId, "stopped");
    const closed = runtime.closeTask({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      outcome: "stopped",
    });
    assert.equal(closed.status, "stopped");
  } finally {
    runtime.close();
  }
});

test("native stop evidence before interrupt ACK keeps one confirmed StopRequest", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      text: "stop",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "accepted" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    const executionId = runtime.getHistory(task.id)!.executions[0]!.id;
    let releaseInterrupt: ((receipt: EngineCommandReceipt) => void) | undefined;
    engine.interrupt = () => new Promise((resolve) => (releaseInterrupt = resolve));
    const stopPromise = runtime.requestStop({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      executionId,
    });
    await until(() => !!releaseInterrupt && runtime.getHistory(task.id)!.stopRequests.length === 1);
    engine.emit(0, {
      type: "execution.stopped",
      evidence: { source: "engine", evidenceId: "stopped" },
    });
    await until(() => runtime.getHistory(task.id)!.stopRequests[0]!.status === "confirmed");
    releaseInterrupt!({
      status: "requested",
      evidence: { source: "engine", evidenceId: "stop-ack-after-event" },
    });
    assert.equal((await stopPromise).status, "confirmed");
    assert.equal(runtime.getHistory(task.id)!.stopRequests[0]!.deliveryStatus, "delivered");
    assert.equal(
      runtime.getHistory(task.id)!.stopRequests[0]!.deliveryEvidence?.evidenceId,
      "stop-ack-after-event",
    );
    assert.equal(runtime.getHistory(task.id)!.stopRequests[0]!.stopEvidence?.evidenceId, "stopped");
    assert.deepEqual(
      runtime.getHistory(task.id)!.stopRequests.map((request) => request.status),
      ["confirmed"],
    );
  } finally {
    runtime.close();
  }
});

test("an interrupt receipt without native delivery evidence stays unknown and cannot erase a terminal execution", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await runtime.submitInput({
      ...identity,
      text: "finish while stop acknowledgement is delayed",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "delayed-stop-input" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    const executionId = runtime.getHistory(task.id)!.executions[0]!.id;
    let releaseInterrupt: ((receipt: EngineCommandReceipt) => void) | undefined;
    engine.interrupt = () => new Promise((resolve) => (releaseInterrupt = resolve));
    const stopPromise = runtime.requestStop({ ...identity, executionId });
    await until(() => !!releaseInterrupt && runtime.getHistory(task.id)!.stopRequests.length === 1);
    engine.emit(0, {
      type: "execution.completed",
      result: "completed before stop was observed",
      evidence: { source: "engine", evidenceId: "completed-before-stop-ack" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]!.status === "completed");
    releaseInterrupt!({ status: "requested" });
    const stop = await stopPromise;
    assert.equal(stop.status, "unknown");
    assert.equal(stop.deliveryStatus, "unknown");
    assert.equal(stop.deliveryEvidence, null);
    assert.equal(stop.stopEvidence, null);
    assert.match(stop.reason ?? "", /completed/i);
    assert.equal(runtime.getHistory(task.id)!.executions[0]!.status, "completed");
  } finally {
    runtime.close();
  }
});

test("Execution completing during capability refresh is not interrupted", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      text: "finish",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "accepted" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    const executionId = runtime.getHistory(task.id)!.executions[0]!.id;
    let releaseCapabilities: (() => void) | undefined;
    engine.refreshCapabilities = () =>
      new Promise((resolve) => {
        releaseCapabilities = () => resolve(engine.getCapabilities());
      });
    const stopPromise = runtime.requestStop({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      executionId,
    });
    await until(() => !!releaseCapabilities);
    engine.emit(0, {
      type: "execution.completed",
      result: "done",
      evidence: { source: "engine", evidenceId: "completed" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]!.status === "completed");
    releaseCapabilities!();
    await assert.rejects(stopPromise, /already completed/);
    assert.equal(engine.interrupts, 0);
    assert.equal(runtime.getHistory(task.id)!.stopRequests.length, 0);
  } finally {
    runtime.close();
  }
});

test("unknown input delivery blocks retry without native acceptance evidence", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      text: "possibly delivered",
    });
    engine.closeEvents(0);
    await until(() => runtime.getHistory(task.id)!.inputs[0]!.status === "unknown");
    assert.equal(runtime.getHistory(task.id)?.executions.length, 0);
    await assert.rejects(
      () =>
        runtime.submitInput({
          taskId: task.id,
          participantId: task.participant.id,
          sessionId: task.session.id,
          authorizationId: authorization.id,
          text: "retry must not duplicate",
        }),
      /unresolved/i,
    );
    const abandoned = runtime.closeTask({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      outcome: "abandoned",
    });
    assert.equal(abandoned.status, "abandoned");
  } finally {
    runtime.close();
  }
});

test("rechecks current capability availability before dispatch", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    engine.setCapability("execution.run", {
      support: "supported",
      availability: "temporarily-unavailable",
      reason: "provider is offline",
    });
    await assert.rejects(
      () =>
        runtime.submitInput({
          taskId: task.id,
          participantId: task.participant.id,
          sessionId: task.session.id,
          authorizationId: authorization.id,
          text: "blocked",
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("provider is offline") &&
        "kind" in error &&
        error.kind === "temporarily-unavailable",
    );
    assert.equal(engine.runs.length, 0);
  } finally {
    runtime.close();
  }
});

test("Task keeps its historical capability snapshot while current state changes and recovers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-capabilities-"));
  const databasePath = join(directory, "runtime.sqlite");
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath,
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    assert.equal(task.currentEngine.state, "current");
    assert.equal(task.currentEngine.source, "active-probe");
    assert.equal(task.currentEngine.capabilities["execution.run"].availability, "available");
    const historicalSnapshot = task.engine;

    const changes: {
      status: CapabilityStatus;
      expectedKind: string;
    }[] = [
      {
        status: {
          support: "supported",
          availability: "temporarily-unavailable",
          reason: "provider is offline",
        },
        expectedKind: "temporarily-unavailable",
      },
      {
        status: {
          support: "supported",
          availability: "authorization-required",
          reason: "Engine credentials are missing",
        },
        expectedKind: "authorization-required",
      },
      {
        status: {
          support: "unknown",
          availability: "unknown",
          reason: "Engine probe did not identify execution support",
        },
        expectedKind: "result-unknown",
      },
      {
        status: {
          support: "unsupported",
          availability: "available",
          reason: "Engine does not implement execution.run",
        },
        expectedKind: "unsupported",
      },
    ];

    for (const { status, expectedKind } of changes) {
      Object.assign(engine.capabilities["execution.run"], status);
      const unprobedTask = runtime.getTask(task.id)!;
      assert.equal(unprobedTask.currentEngine.state, "unknown");
      assert.equal(unprobedTask.currentEngine.capabilities["execution.run"].support, "unknown");
      assert.equal(runtime.listEngines()[0]?.state, "unknown");
      assert.deepEqual(unprobedTask.engine, historicalSnapshot);
      const listed = await runtime.refreshEngines();
      assert.deepEqual(listed[0]?.capabilities["execution.run"], status);
      const refreshedTask = runtime.getTask(task.id)!;
      assert.deepEqual(refreshedTask.engine, historicalSnapshot);
      assert.deepEqual(refreshedTask.currentEngine, listed[0]);
      assert.equal(refreshedTask.currentEngine.state, "current");
      assert.notEqual(refreshedTask.currentEngine.observedAt, null);
      await assert.rejects(
        runtime.submitInput({
          taskId: task.id,
          participantId: task.participant.id,
          sessionId: task.session.id,
          authorizationId: authorization.id,
          text: "must remain gated",
        }),
        (error: unknown) =>
          error instanceof Error && "kind" in error && error.kind === expectedKind,
      );
      assert.equal(engine.runs.length, 0);
    }

    engine.configurationVersion = "test-v2";
    engine.setCapability("execution.run", { support: "supported", availability: "available" });
    assert.equal(runtime.getTask(task.id)!.currentEngine.state, "unknown");
    const changedConfiguration = (await runtime.refreshEngines())[0]!;
    assert.equal(changedConfiguration.configurationVersion, "test-v2");
    assert.equal(runtime.getTask(task.id)!.engine.configurationVersion, "test");
    await assert.rejects(
      runtime.submitInput({
        taskId: task.id,
        participantId: task.participant.id,
        sessionId: task.session.id,
        authorizationId: authorization.id,
        text: "stale authorization snapshot",
      }),
      (error: unknown) =>
        error instanceof Error && "kind" in error && error.kind === "authorization-required",
    );
    assert.equal(engine.runs.length, 0);

    engine.configurationVersion = "test";
    engine.adapterVersion = "test-v2";
    const changedAdapter = (await runtime.refreshEngines())[0]!;
    assert.equal(changedAdapter.adapterVersion, "test-v2");
    assert.equal(runtime.getTask(task.id)!.engine.adapterVersion, "test");
    await assert.rejects(
      runtime.submitInput({
        taskId: task.id,
        participantId: task.participant.id,
        sessionId: task.session.id,
        authorizationId: authorization.id,
        text: "stale adapter snapshot",
      }),
      (error: unknown) =>
        error instanceof Error && "kind" in error && error.kind === "authorization-required",
    );
    assert.equal(engine.runs.length, 0);

    engine.adapterVersion = "test";
    assert.equal(runtime.getTask(task.id)!.currentEngine.state, "unknown");
    const restored = (await runtime.refreshEngines())[0]!;
    assert.equal(restored.capabilities["execution.run"].availability, "available");
    assert.deepEqual(runtime.getTask(task.id)!.engine, historicalSnapshot);
    await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      text: "available again",
    });
    assert.equal(engine.runs.length, 1);

    const database = new DatabaseSync(databasePath);
    try {
      const stored = database
        .prepare("SELECT data FROM runtime_records WHERE kind = ? AND id = ?")
        .get("task", task.id) as { data: string };
      const taskData = JSON.parse(stored.data) as { engine: unknown; currentEngine?: unknown };
      assert.deepEqual(taskData.engine, historicalSnapshot);
      assert.equal("currentEngine" in taskData, false);
    } finally {
      database.close();
    }
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an Adapter without an active capability probe is never reported as current", async () => {
  const engine = new ManualEngine();
  Object.defineProperty(engine, "refreshCapabilities", { value: undefined });
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    assert.equal(runtime.listEngines()[0]?.state, "unknown");
    const refreshed = await runtime.refreshEngines();
    assert.equal(refreshed[0]?.state, "unknown");
    assert.equal(refreshed[0]?.capabilities["execution.run"].availability, "unknown");
    await assert.rejects(
      runtime.createTask({ engineId: "manual", environment, authorization }),
      (error: unknown) =>
        error instanceof Error && "kind" in error && error.kind === "temporarily-unavailable",
    );
    assert.equal(engine.sessions.length, 0);
  } finally {
    runtime.close();
  }
});

test("failed newer capability refresh stays unknown when an older refresh completes late", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const olderSnapshot = engine.getCapabilities();
    let resolveOlder!: (snapshot: EngineCapabilitySnapshot) => void;
    const olderResult = new Promise<EngineCapabilitySnapshot>((resolve) => {
      resolveOlder = resolve;
    });
    engine.refreshHandler = () => olderResult;
    const olderRefresh = runtime.refreshEngines();
    assert.equal(runtime.listEngines()[0]?.state, "unknown");
    engine.setCapability("execution.run", {
      support: "supported",
      availability: "temporarily-unavailable",
      reason: "provider is offline",
    });
    assert.equal(runtime.getTask(task.id)?.currentEngine.state, "unknown");

    engine.refreshHandler = async () => {
      throw new Error("probe transport failed");
    };
    const newerRefresh = await runtime.refreshEngines();
    assert.equal(newerRefresh[0]?.state, "unknown");
    assert.equal(newerRefresh[0]?.source, "unknown");
    assert.notEqual(newerRefresh[0]?.observedAt, null);
    assert.equal(newerRefresh[0]?.capabilities["execution.run"].support, "unknown");
    await assert.rejects(
      runtime.submitInput({
        taskId: task.id,
        participantId: task.participant.id,
        sessionId: task.session.id,
        authorizationId: authorization.id,
        text: "refresh failure must not use the historical snapshot",
      }),
      (error: unknown) =>
        error instanceof Error && "kind" in error && error.kind === "temporarily-unavailable",
    );
    assert.equal(engine.runs.length, 0);

    resolveOlder(olderSnapshot);
    const lateRefresh = await olderRefresh;
    assert.equal(lateRefresh[0]?.state, "unknown");
    assert.equal(runtime.getTask(task.id)?.currentEngine.state, "unknown");
    assert.equal(
      runtime.getTask(task.id)?.engine.capabilities["execution.run"].availability,
      "available",
    );

    engine.refreshHandler = null;
    engine.setCapability("execution.run", { support: "supported", availability: "available" });
    assert.equal(runtime.getTask(task.id)?.currentEngine.state, "unknown");
    const recovered = (await runtime.refreshEngines())[0]!;
    assert.equal(recovered.state, "current");
    assert.equal(recovered.capabilities["execution.run"].availability, "available");
    assert.equal(runtime.getTask(task.id)?.currentEngine.state, "current");
  } finally {
    runtime.close();
  }
});

test("approval response is scoped to its originating Task and native option", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const first = await runtime.createTask({ engineId: "manual", environment, authorization });
    const second = await runtime.createTask({ engineId: "manual", environment, authorization });
    await runtime.submitInput({
      taskId: first.id,
      participantId: first.participant.id,
      sessionId: first.session.id,
      authorizationId: authorization.id,
      text: "request a permission",
    });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "accepted" },
    });
    await until(() => runtime.getHistory(first.id)!.executions.length === 1);
    engine.emit(0, {
      type: "approval.requested",
      approvalId: "native-approval" as never,
      operation: "write file",
      options: [{ id: "allow", label: "Allow once", decision: "approve" }],
      expiresAt: null,
    });
    await until(() => runtime.getHistory(first.id)!.approvals.length === 1);
    const approval = runtime.getHistory(first.id)!.approvals[0]!;
    await assert.rejects(
      () =>
        runtime.replyToApproval({
          taskId: second.id,
          participantId: second.participant.id,
          sessionId: second.session.id,
          authorizationId: authorization.id,
          approvalId: approval.id,
          optionId: "allow",
        }),
      /different Task|ownership/i,
    );
    await assert.rejects(
      () =>
        runtime.replyToApproval({
          taskId: first.id,
          participantId: first.participant.id,
          sessionId: first.session.id,
          authorizationId: authorization.id,
          approvalId: approval.id,
          optionId: "forged-option",
        }),
      /option/i,
    );
    const response = await runtime.replyToApproval({
      taskId: first.id,
      participantId: first.participant.id,
      sessionId: first.session.id,
      authorizationId: authorization.id,
      approvalId: approval.id,
      optionId: "allow",
    });
    assert.equal(response.status, "forwarded");
  } finally {
    runtime.close();
  }
});

test("user-input attempts are not persisted without accepted receipt or native response evidence", async () => {
  for (const receiptStatus of ["expired", "unsupported", "unknown"] as const) {
    const engine = new ManualEngine();
    const runtime = createTaskRuntime({
      databasePath: ":memory:",
      engines: new Map([["manual", engine]]),
    });
    try {
      const task = await runtime.createTask({ engineId: "manual", environment, authorization });
      const scope = {
        taskId: task.id,
        participantId: task.participant.id,
        sessionId: task.session.id,
        authorizationId: authorization.id,
      };
      await runtime.submitInput({ ...scope, text: "request input" });
      engine.emit(0, {
        type: "input.accepted",
        evidence: { source: "engine", evidenceId: "accepted" },
      });
      await until(() => runtime.getHistory(task.id)!.executions.length === 1);
      engine.emit(0, {
        type: "user-input.requested",
        requestId: `native-input-${receiptStatus}` as never,
        prompt: "Question",
        inputKind: "text",
        expiresAt: null,
      });
      await until(() => runtime.getHistory(task.id)!.userInputs.length === 1);
      engine.replyToUserInput = async () => ({ status: receiptStatus });

      const [request] = runtime.getHistory(task.id)!.userInputs;
      const reply = await runtime.replyToUserInput({
        ...scope,
        requestId: request!.id,
        response: "attempt that was not accepted",
      });
      assert.equal(reply.status, receiptStatus);
      assert.equal(reply.response, null);
      assert.equal(runtime.getHistory(task.id)!.userInputs[0]!.response, null);
    } finally {
      runtime.close();
    }
  }
});

test("native user-input response evidence survives a conflicting command receipt", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const scope = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
    };
    await runtime.submitInput({ ...scope, text: "request input" });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "accepted" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    engine.emit(0, {
      type: "user-input.requested",
      requestId: "native-race-input" as never,
      prompt: "Question",
      inputKind: "choice",
      expiresAt: null,
    });
    await until(() => runtime.getHistory(task.id)!.userInputs.length === 1);
    const nativeResponse = {
      action: "accept",
      content: { answers: { Question: "native value" } },
    } as const;
    engine.replyToUserInput = async () => {
      engine.emit(0, {
        type: "user-input.response",
        requestId: "native-race-input" as never,
        status: "forwarded",
        response: nativeResponse,
      });
      await until(() => runtime.getHistory(task.id)!.userInputs[0]!.status === "forwarded");
      return { status: "unsupported" };
    };

    const request = runtime.getHistory(task.id)!.userInputs[0]!;
    const reply = await runtime.replyToUserInput({
      ...scope,
      requestId: request.id,
      response: "unaccepted local attempt",
    });
    assert.equal(reply.status, "forwarded");
    assert.deepEqual(reply.response, nativeResponse);
    assert.deepEqual(runtime.getHistory(task.id)!.userInputs[0]!.response, nativeResponse);
  } finally {
    runtime.close();
  }
});

test("expired or finished-Execution interactions never reach the Engine", async () => {
  let now = 5;
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
    now: () => now,
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const scope = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
    };
    await runtime.submitInput({ ...scope, text: "waiting" });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "accepted" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    engine.emit(0, {
      type: "approval.requested",
      approvalId: "expires" as never,
      operation: "write",
      options: [{ id: "allow", label: "Allow", decision: "approve" }],
      expiresAt: 10,
    });
    engine.emit(0, {
      type: "user-input.requested",
      requestId: "expires-input" as never,
      prompt: "Choose",
      inputKind: "text",
      expiresAt: 10,
    });
    await until(
      () =>
        runtime.getHistory(task.id)!.approvals.length === 1 &&
        runtime.getHistory(task.id)!.userInputs.length === 1,
    );
    const approval = runtime.getHistory(task.id)!.approvals[0]!;
    const request = runtime.getHistory(task.id)!.userInputs[0]!;
    const requestedEvents = runtime
      .getHistory(task.id)!
      .events.filter(
        (event) => event.type === "approval.requested" || event.type === "user-input.requested",
      );
    assert.equal(approval.requestEventId, requestedEvents[0]?.id);
    assert.equal(request.requestEventId, requestedEvents[1]?.id);
    now = 10;
    await assert.rejects(
      () => runtime.replyToApproval({ ...scope, approvalId: approval.id, optionId: "allow" }),
      /expired/i,
    );
    await assert.rejects(
      () => runtime.replyToUserInput({ ...scope, requestId: request.id, response: "yes" }),
      /expired/i,
    );
    assert.equal(runtime.getHistory(task.id)!.approvals[0]!.status, "expired");
    assert.equal(runtime.getHistory(task.id)!.userInputs[0]!.status, "expired");
    assert.equal(engine.approvalReplies, 0);
    assert.equal(engine.userInputReplies, 0);

    engine.emit(0, {
      type: "approval.requested",
      approvalId: "late" as never,
      operation: "write",
      options: [{ id: "allow", label: "Allow", decision: "approve" }],
      expiresAt: null,
    });
    engine.emit(0, {
      type: "user-input.requested",
      requestId: "late-input" as never,
      prompt: "Choose",
      inputKind: "text",
      expiresAt: null,
    });
    await until(
      () =>
        runtime.getHistory(task.id)!.approvals.length === 2 &&
        runtime.getHistory(task.id)!.userInputs.length === 2,
    );
    engine.emit(0, {
      type: "execution.completed",
      result: "done",
      evidence: { source: "engine", evidenceId: "done" },
    });
    await until(() => runtime.getHistory(task.id)!.executions[0]!.status === "completed");
    await until(
      () =>
        runtime.getHistory(task.id)!.approvals[1]!.status === "rejected" &&
        runtime.getHistory(task.id)!.userInputs[1]!.status === "rejected",
    );
    assert.equal(runtime.getHistory(task.id)!.approvals[1]!.requestEventId !== null, true);
    assert.equal(runtime.getHistory(task.id)!.userInputs[1]!.requestEventId !== null, true);
    await assert.rejects(
      () =>
        runtime.replyToApproval({
          ...scope,
          approvalId: runtime.getHistory(task.id)!.approvals[1]!.id,
          optionId: "allow",
        }),
      /rejected/i,
    );
    await assert.rejects(
      () =>
        runtime.replyToUserInput({
          ...scope,
          requestId: runtime.getHistory(task.id)!.userInputs[1]!.id,
          response: "yes",
        }),
      /rejected/i,
    );
    assert.equal(engine.approvalReplies, 0);
    assert.equal(engine.userInputReplies, 0);
  } finally {
    runtime.close();
  }
});

test("failed and stopped Executions retire pending interactions without native replies", async () => {
  for (const status of ["failed", "stopped"] as const) {
    const engine = new ManualEngine();
    const runtime = createTaskRuntime({
      databasePath: ":memory:",
      engines: new Map([["manual", engine]]),
    });
    try {
      const task = await runtime.createTask({ engineId: "manual", environment, authorization });
      const scope = {
        taskId: task.id,
        participantId: task.participant.id,
        sessionId: task.session.id,
        authorizationId: authorization.id,
      };
      await runtime.submitInput({ ...scope, text: `waiting for ${status}` });
      engine.emit(0, {
        type: "input.accepted",
        evidence: { source: "engine", evidenceId: "accepted" },
      });
      await until(() => runtime.getHistory(task.id)!.executions.length === 1);
      engine.emit(0, {
        type: "approval.requested",
        approvalId: `approval-${status}` as never,
        operation: "write",
        options: [{ id: "allow", label: "Allow", decision: "approve" }],
        expiresAt: null,
      });
      engine.emit(0, {
        type: "user-input.requested",
        requestId: `question-${status}` as never,
        prompt: "Continue?",
        inputKind: "text",
        expiresAt: null,
      });
      await until(
        () =>
          runtime.getHistory(task.id)!.approvals.length === 1 &&
          runtime.getHistory(task.id)!.userInputs.length === 1,
      );
      engine.emit(
        0,
        status === "failed"
          ? {
              type: "execution.failed",
              failure: {
                kind: "execution-failed",
                operation: "execution.run",
                message: "native failure",
                sideEffects: "none",
              },
              evidence: { source: "engine", evidenceId: "failed" },
            }
          : {
              type: "execution.stopped",
              evidence: { source: "engine", evidenceId: "stopped" },
            },
      );
      await until(() => runtime.getHistory(task.id)!.executions[0]!.status === status);
      const history = runtime.getHistory(task.id)!;
      assert.equal(history.approvals[0]?.status, "rejected");
      assert.equal(history.userInputs[0]?.status, "rejected");
      assert.equal(history.events.filter((event) => event.type.endsWith(".requested")).length, 2);
      await assert.rejects(
        () =>
          runtime.replyToApproval({
            ...scope,
            approvalId: history.approvals[0]!.id,
            optionId: "allow",
          }),
        /rejected/i,
      );
      await assert.rejects(
        () =>
          runtime.replyToUserInput({
            ...scope,
            requestId: history.userInputs[0]!.id,
            response: "yes",
          }),
        /rejected/i,
      );
      assert.equal(engine.approvalReplies, 0);
      assert.equal(engine.userInputReplies, 0);
    } finally {
      runtime.close();
    }
  }
});

test("approval and question answers recheck expiry immediately before native dispatch", async () => {
  for (const kind of ["approval", "question"] as const) {
    let now = 5;
    const engine = new ManualEngine();
    const runtime = createTaskRuntime({
      databasePath: ":memory:",
      engines: new Map([["manual", engine]]),
      now: () => now,
    });
    try {
      const task = await runtime.createTask({ engineId: "manual", environment, authorization });
      const scope = {
        taskId: task.id,
        participantId: task.participant.id,
        sessionId: task.session.id,
        authorizationId: authorization.id,
      };
      await runtime.submitInput({ ...scope, text: "waiting for interaction" });
      engine.emit(0, {
        type: "input.accepted",
        evidence: { source: "engine", evidenceId: `${kind}-accepted` },
      });
      await until(() => runtime.getHistory(task.id)!.executions.length === 1);
      if (kind === "approval") {
        engine.emit(0, {
          type: "approval.requested",
          approvalId: "expiring-approval" as never,
          operation: "write",
          options: [{ id: "allow", label: "Allow", decision: "approve" }],
          expiresAt: 10,
        });
      } else {
        engine.emit(0, {
          type: "user-input.requested",
          requestId: "expiring-question" as never,
          prompt: "Continue?",
          inputKind: "text",
          expiresAt: 10,
        });
      }
      await until(
        () =>
          (kind === "approval"
            ? runtime.getHistory(task.id)!.approvals
            : runtime.getHistory(task.id)!.userInputs
          ).length === 1,
      );

      let entered = false;
      let effects = 0;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      engine.replyToApproval = async (input) => {
        entered = true;
        await held;
        input.beforeDispatch?.();
        effects++;
        return { status: "forwarded" };
      };
      engine.replyToUserInput = async (input) => {
        entered = true;
        await held;
        input.beforeDispatch?.();
        effects++;
        return { status: "forwarded" };
      };
      const pending =
        kind === "approval"
          ? runtime.replyToApproval({
              ...scope,
              approvalId: runtime.getHistory(task.id)!.approvals[0]!.id,
              optionId: "allow",
            })
          : runtime.replyToUserInput({
              ...scope,
              requestId: runtime.getHistory(task.id)!.userInputs[0]!.id,
              response: "yes",
            });
      await until(() => entered);
      now = 10;
      release();
      await assert.rejects(pending, /expired/i);
      assert.equal(effects, 0, `${kind} must not reach native dispatch after expiry`);
      assert.equal(
        (kind === "approval"
          ? runtime.getHistory(task.id)!.approvals[0]
          : runtime.getHistory(task.id)!.userInputs[0]
        )?.status,
        "expired",
      );
    } finally {
      runtime.close();
    }
  }
});

test("new stream generation does not invent a source-sequence gap without a cursor baseline", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      text: "stream",
    });
    engine.emit(
      0,
      { type: "input.accepted", evidence: { source: "engine", evidenceId: "accepted" } },
      { sourceSequence: 4 },
    );
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    engine.emit(
      0,
      { type: "message.delta", text: "after reconnect" },
      { streamId: "stream-new", sourceSequence: 5 },
    );
    await until(() => runtime.getHistory(task.id)!.events.length === 2);
    assert.equal(
      runtime.getHistory(task.id)!.integrityIssues.some((issue) => issue.type === "sequence-gap"),
      false,
    );
  } finally {
    runtime.close();
  }
});

test("native denial before command receipt is not overwritten by forwarded ACK", async () => {
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
  });
  try {
    const task = await runtime.createTask({ engineId: "manual", environment, authorization });
    const scope = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
    };
    await runtime.submitInput({ ...scope, text: "permission" });
    engine.emit(0, {
      type: "input.accepted",
      evidence: { source: "engine", evidenceId: "accepted" },
    });
    await until(() => runtime.getHistory(task.id)!.executions.length === 1);
    engine.emit(0, {
      type: "approval.requested",
      approvalId: "native-race" as never,
      operation: "write",
      options: [{ id: "allow", label: "Allow", decision: "approve" }],
      expiresAt: null,
    });
    await until(() => runtime.getHistory(task.id)!.approvals.length === 1);
    engine.replyToApproval = async () => {
      engine.emit(0, {
        type: "approval.response",
        approvalId: "native-race" as never,
        optionId: "allow",
        decision: "reject",
        status: "rejected",
        evidence: { source: "engine", evidenceId: "native-deny" },
      });
      await until(() => runtime.getHistory(task.id)!.approvals[0]!.status === "rejected");
      return { status: "forwarded" };
    };
    const response = await runtime.replyToApproval({
      ...scope,
      approvalId: runtime.getHistory(task.id)!.approvals[0]!.id,
      optionId: "allow",
    });
    assert.equal(response.status, "rejected");
    assert.equal(runtime.getHistory(task.id)!.approvals[0]!.status, "rejected");
  } finally {
    runtime.close();
  }
});

test("Session-scoped reads reject expired or cross-Task authority and recheck after native reads", async () => {
  let now = 10;
  const engine = new ManualEngine();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["manual", engine]]),
    now: () => now,
  });
  let nativeReads = 0;
  try {
    const task = await runtime.createTask({
      engineId: "manual",
      environment,
      authorization: { ...authorization, id: "expiring-session-read", expiresAt: 20 },
    });
    const identity = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    const readCatalog = (request: typeof identity) =>
      runtime.readQualifiedTaskSession(request, async (target) => {
        nativeReads++;
        assert.equal(target.taskId, request.taskId);
        assert.equal(target.participantId, request.participantId);
        assert.equal(target.sessionId, request.sessionId);
        return target.nativeSessionId;
      });

    assert.equal(await readCatalog(identity), task.session.nativeSessionId);
    assert.equal(nativeReads, 1);

    const other = await runtime.createTask({ engineId: "manual", environment, authorization });
    await assert.rejects(
      readCatalog({ ...identity, sessionId: other.session.id }),
      /ownership do not match/i,
    );
    assert.equal(nativeReads, 1, "cross-Task Session identity must fail before native reads");

    now = 21;
    await assert.rejects(readCatalog(identity), /Authorization has expired/i);
    assert.equal(nativeReads, 1, "expired authorization must fail before native reads");

    now = 10;
    await assert.rejects(
      runtime.readQualifiedTaskSession(identity, async () => {
        nativeReads++;
        now = 21;
        return "catalog";
      }),
      /Authorization has expired/i,
    );
    assert.equal(nativeReads, 2, "a read that loses authorization must not return its result");
  } finally {
    runtime.close();
  }
});
