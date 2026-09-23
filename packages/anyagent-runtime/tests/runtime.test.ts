import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  EngineAdapter,
  EngineApprovalReceipt,
  EngineCapability,
  EngineCapabilitySnapshot,
  EngineCommandReceipt,
  EngineEvent,
  EngineEventInput,
  EngineExecutionRef,
  EngineRun,
  EngineSessionRef,
  EngineUserInputReceipt,
} from "@anyagent/engine-contract";
import {
  createTaskRuntime,
  type RuntimeAuthorization,
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
    executionId: EngineExecutionRef;
    events: EventQueue;
    sourceSequence: number;
    deliverySequence: number;
  }[] = [];
  readonly capabilities = Object.fromEntries(
    [
      "session.create",
      "session.close",
      "execution.run",
      "execution.interrupt",
      "execution.reconcile",
      "events.stream",
      "events.tool",
      "events.file",
      "approval.respond",
      "user-input.respond",
    ].map((name) => [
      name,
      {
        support: name === "execution.reconcile" ? "unsupported" : "supported",
        availability: "available",
      },
    ]),
  ) as Record<
    EngineCapability,
    {
      support: "supported" | "unsupported";
      availability: "available" | "unknown" | "temporarily-unavailable" | "authorization-required";
      reason?: string;
    }
  >;
  #nextSession = 0;
  #nextExecution = 0;
  approvalReplies = 0;
  userInputReplies = 0;
  interrupts = 0;
  interruptStatus: EngineCommandReceipt["status"] = "requested";

  getCapabilities(): EngineCapabilitySnapshot {
    return {
      engineId: "manual",
      adapterVersion: "test",
      engineVersion: "test",
      configurationVersion: "test",
      environment: "workspace-a",
      capabilities: this.capabilities,
    };
  }

  async refreshCapabilities(): Promise<EngineCapabilitySnapshot> {
    return this.getCapabilities();
  }

  setCapability(
    capability: EngineCapability,
    status: {
      support: "supported" | "unsupported";
      availability: "available" | "unknown" | "temporarily-unavailable" | "authorization-required";
      reason?: string;
    },
  ): void {
    this.capabilities[capability] = status;
  }

  async createSession(): Promise<EngineSessionRef> {
    const session = `native-session-${++this.#nextSession}` as EngineSessionRef;
    this.sessions.push(session);
    return session;
  }

  async run({ session }: { session: EngineSessionRef; input: string }): Promise<EngineRun> {
    const executionId = `native-execution-${++this.#nextExecution}` as EngineExecutionRef;
    const events = new EventQueue();
    this.runs.push({ session, executionId, events, sourceSequence: 0, deliverySequence: 0 });
    return { executionId, events };
  }

  async replyToApproval(): Promise<EngineApprovalReceipt> {
    this.approvalReplies++;
    return { status: "forwarded" };
  }
  async replyToUserInput(): Promise<EngineUserInputReceipt> {
    this.userInputReplies++;
    return { status: "forwarded" };
  }
  async interrupt(): Promise<EngineCommandReceipt> {
    this.interrupts++;
    return { status: this.interruptStatus };
  }
  async closeSession(): Promise<EngineCommandReceipt> {
    return { status: "closed" };
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
    "execution.run",
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
    assert.equal(first.session.status, "active");
    assert.doesNotThrow(() => JSON.stringify(first));
    firstRuntime.close();

    const database = new DatabaseSync(databasePath);
    const storedSession = database
      .prepare("SELECT data FROM runtime_records WHERE kind = ? AND id = ?")
      .get("session", first.session.id) as { data: string };
    assert.equal(JSON.parse(storedSession.data).nativeSessionId, engine.sessions[0]);
    database.close();

    const restored = createTaskRuntime({ databasePath, engines: new Map([["manual", engine]]) });
    assert.equal(restored.listTasks().length, 2);
    assert.equal(restored.getTask(first.id)?.session.status, "unknown");
    assert.equal(restored.getTask(first.id)?.environment.workDirectory, "/work/project-a");
    assert.equal(restored.getTask(first.id)?.credentialSource.label, "Desktop keychain");
    restored.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
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
    engine.interruptStatus = "requested";
    const stop = await runtime.requestStop({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: authorization.id,
      executionId: execution.id,
    });
    assert.equal(stop.status, "requested");
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
    releaseInterrupt!({ status: "requested" });
    assert.equal((await stopPromise).status, "confirmed");
    assert.deepEqual(
      runtime.getHistory(task.id)!.stopRequests.map((request) => request.status),
      ["confirmed"],
    );
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
    await assert.rejects(
      () =>
        runtime.replyToApproval({
          ...scope,
          approvalId: runtime.getHistory(task.id)!.approvals[1]!.id,
          optionId: "allow",
        }),
      /finished Execution/i,
    );
    await assert.rejects(
      () =>
        runtime.replyToUserInput({
          ...scope,
          requestId: runtime.getHistory(task.id)!.userInputs[1]!.id,
          response: "yes",
        }),
      /finished Execution/i,
    );
    assert.equal(engine.approvalReplies, 0);
    assert.equal(engine.userInputReplies, 0);
  } finally {
    runtime.close();
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
