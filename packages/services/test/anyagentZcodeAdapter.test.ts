import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineContractError } from "@anyagent/engine-contract";
import { createTaskRuntime } from "@anyagent/runtime";
import { WORKFLOW_REFINE_PERMISSION_OPTION_ID, zcodeSessionEventSchema } from "@zcode/shared";
import { parseCommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { createZCodeAdapter } from "../src/anyagent/zcodeAdapter.js";

type AgentPort = Parameters<typeof createZCodeAdapter>[0]["agent"];
const DEFAULT_MODEL_SELECTION = { providerId: "provider-a", modelId: "model-a" };

interface NativeAssistantRow {
  rowId: number;
  entityId?: string;
  kind: string;
  feedback?: "like" | "dislike";
  turnId?: string;
  sourceCommandId?: string;
  state?: string;
  marker?: { type: string; status?: string };
  actions?: { canFork?: true; canEdit?: true; canRetry?: true };
}

function harness({
  earlyStart = false,
  delayedAck = false,
  useDefaultModelSelection = true,
  rows = [],
  pageWatermarks = [],
  feedbackCommandStatus = "accepted",
  forkCommandStatus = "accepted",
  forkSendFails = false,
  forkQueryUnknown = false,
  revisionSendFails = false,
  revisionQueryUnknown = false,
  compactAckStatus = "accepted",
  compactSendFails = false,
  compactQueryUnknown = false,
  nativeActiveTurnId = null,
  nativePendingRequestIds = [],
  nativeSessionStatus = "idle",
  validateModelSelection,
  beforeRows,
}: {
  earlyStart?: boolean;
  delayedAck?: boolean;
  useDefaultModelSelection?: boolean;
  rows?: NativeAssistantRow[];
  pageWatermarks?: Array<{ atRevision: number; atLogEpoch: string }>;
  feedbackCommandStatus?: "accepted" | "stale";
  forkCommandStatus?: "accepted" | "stale";
  forkSendFails?: boolean;
  forkQueryUnknown?: boolean;
  revisionSendFails?: boolean;
  revisionQueryUnknown?: boolean;
  compactAckStatus?: "accepted" | "duplicate";
  compactSendFails?: boolean;
  compactQueryUnknown?: boolean;
  nativeActiveTurnId?: string | null;
  nativePendingRequestIds?: string[];
  nativeSessionStatus?: string;
  validateModelSelection?: NonNullable<
    Parameters<typeof createZCodeAdapter>[0]["validateModelSelection"]
  >;
  beforeRows?: () => Promise<void>;
} = {}) {
  const listeners = new Set<(event: unknown) => void>();
  let lifecycleListener: ((event: unknown) => void) | undefined;
  let releaseSendText: (() => void) | undefined;
  let inputNumber = 0;
  const commands: Array<{
    type: string;
    commandId: string;
    payload: unknown;
    baseRevision?: number;
    baseLogEpoch?: string;
  }> = [];
  const rowQueries: Array<{ beforeRowId?: number; limit: number }> = [];
  const remainingWatermarks = [...pageWatermarks];
  const agent = {
    initialize: async () => ({ available: true, workspaceKey: "/tmp/workspace" }),
    onDynamicSessionEvent: () => (receive: (event: unknown) => void) => {
      listeners.add(receive);
      return {
        dispose() {
          listeners.delete(receive);
        },
      };
    },
    onAgentRuntimeLifecycle: (receive: (event: unknown) => void) => {
      lifecycleListener = receive;
      return { dispose: () => (lifecycleListener = undefined) };
    },
    readSession: async () => ({
      runtime: { activeTurnId: nativeActiveTurnId, pendingRequestIds: nativePendingRequestIds },
      session: { status: nativeSessionStatus },
    }),
    sendConversationCommandV4: async ({
      envelope,
    }: {
      envelope: {
        type: string;
        commandId: string;
        payload: unknown;
        baseRevision?: number;
        baseLogEpoch?: string;
      };
    }) => {
      commands.push(envelope);
      if (envelope.type === "createSession") {
        return {
          status: "accepted",
          commandId: envelope.commandId,
          result: { type: "createSession", sessionId: "native-session" },
        };
      }
      if (envelope.type === "sendText") {
        const inputId = ++inputNumber === 1 ? "native-input" : `native-input-${inputNumber}`;
        if (delayedAck)
          await new Promise<void>((resolve) => {
            releaseSendText = resolve;
          });
        if (earlyStart)
          for (const listener of listeners)
            listener({
              type: "session.event",
              event: {
                eventId: "early-start",
                seq: 1,
                sessionId: "native-session",
                turnId: "early-turn",
                timestamp: 1,
                type: "turn.started",
                payload: { inputId, foregroundExecutionId: "native-work" },
              },
            });
        return {
          status: "accepted",
          commandId: envelope.commandId,
          result: { type: "inputAccepted", inputId, delivery: "startNow" },
        };
      }
      if (envelope.type === "compact") {
        if (compactSendFails) throw new Error("native compact ACK lost");
        return { status: compactAckStatus, commandId: envelope.commandId };
      }
      if (envelope.type === "setAssistantFeedback") {
        if (feedbackCommandStatus === "stale")
          return {
            status: "stale",
            commandId: envelope.commandId,
            reasonCode: "proto.staleRevision",
          };
        const payload = envelope.payload as {
          target?: { rowId?: unknown; entityId?: unknown };
          feedback?: unknown;
        };
        const row = rows.find(
          (candidate) =>
            candidate.rowId === payload.target?.rowId &&
            candidate.entityId === payload.target?.entityId,
        );
        if (row) {
          if (payload.feedback === null) delete row.feedback;
          else if (payload.feedback === "like" || payload.feedback === "dislike")
            row.feedback = payload.feedback;
        }
      }
      if (envelope.type === "forkAssistant") {
        if (forkSendFails) throw new Error("native reply lost");
        if (forkCommandStatus === "stale")
          return {
            status: "stale",
            commandId: envelope.commandId,
            reasonCode: "proto.staleRevision",
          };
        return {
          status: "accepted",
          commandId: envelope.commandId,
          result: { type: "forkAssistant", sessionId: "native-fork-child" },
        };
      }
      if (envelope.type === "editUserQuery" || envelope.type === "retryTurn") {
        if (revisionSendFails) throw new Error("native revision reply lost");
        return {
          status: "accepted",
          commandId: envelope.commandId,
          ...(envelope.type === "editUserQuery"
            ? {
                result: {
                  type: "editUserQuery",
                  disposition: "rewind",
                  sessionId: "native-session",
                },
              }
            : {}),
        };
      }
      return { status: "accepted", commandId: envelope.commandId };
    },
    queryConversationCommandsV4: async ({
      commands: keys,
    }: {
      commands: Array<{ sessionId: string; commandId: string }>;
    }) => ({
      results: keys.map((key) => ({
        key,
        result:
          forkQueryUnknown || revisionQueryUnknown || compactQueryUnknown
            ? "unknown"
            : {
                status: "accepted",
                commandId: key.commandId,
                revisionAtDecision: 0,
                result: revisionSendFails
                  ? { type: "editUserQuery", disposition: "rewind", sessionId: "native-session" }
                  : { type: "forkAssistant", sessionId: "native-fork-child" },
              },
      })),
    }),
    conversationRowsRangeV4: async ({
      beforeRowId,
      limit,
    }: {
      beforeRowId?: number;
      limit: number;
    }) => {
      rowQueries.push({ ...(beforeRowId === undefined ? {} : { beforeRowId }), limit });
      await beforeRows?.();
      const watermark = remainingWatermarks.shift() ?? {
        atRevision: 0,
        atLogEpoch: "test-log-epoch",
      };
      const eligible = rows
        .filter((row) => beforeRowId === undefined || row.rowId < beforeRowId)
        .sort((left, right) => left.rowId - right.rowId);
      const pageRows = eligible.slice(-limit);
      return {
        rows: pageRows,
        atSeq: 0,
        ...watermark,
        hasMore: eligible.length > pageRows.length,
      };
    },
  } as unknown as AgentPort;
  const nativeAdapter = createZCodeAdapter({
    agent,
    workspacePath: "/tmp/workspace",
    validateModelSelection: validateModelSelection ?? (() => undefined),
  });
  const adapter = useDefaultModelSelection
    ? {
        ...nativeAdapter,
        run(input: Parameters<typeof nativeAdapter.run>[0]) {
          return nativeAdapter.run({
            ...input,
            submissionConfig: input.submissionConfig ?? { modelSelection: DEFAULT_MODEL_SELECTION },
          });
        },
      }
    : nativeAdapter;
  return {
    adapter,
    commands,
    rowQueries,
    rows,
    emit(event: unknown) {
      for (const listener of listeners) listener(event);
    },
    disconnect() {
      lifecycleListener?.({ workspaceKey: "/tmp/workspace", state: "unavailable" });
    },
    releaseSendText() {
      releaseSendText?.();
    },
  };
}

function completeNativeSource(fixture: ReturnType<typeof harness>) {
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "source-start",
      seq: 1,
      sessionId: "native-session",
      turnId: "source-turn",
      timestamp: 1,
      type: "turn.started",
      payload: { inputId: "native-input", foregroundExecutionId: "native-work" },
    },
  });
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "source-complete",
      seq: 2,
      sessionId: "native-session",
      turnId: "source-turn",
      timestamp: 2,
      type: "turn.completed",
      payload: { inputId: "native-input", resultType: "success", response: "source answer" },
    },
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Timed out waiting for ZCode adapter state to update.");
}

test("ZCode compaction waits for lifecycle evidence after a duplicate ACK", async () => {
  const fixture = harness({ compactAckStatus: "duplicate" });
  try {
    const session = await fixture.adapter.createSession();
    let accepted = 0;
    let settled = false;
    const commandId = "product-compact-stable-id";
    const pending = fixture.adapter.compactSession!({
      session,
      commandId,
      onAccepted: () => accepted++,
    }).then((receipt) => {
      settled = true;
      return receipt;
    });
    await waitUntil(() => accepted === 1);
    assert.equal(settled, false, "ACK must not be treated as compaction completion");
    const command = fixture.commands.find((entry) => entry.type === "compact");
    assert.equal(command?.commandId, commandId);
    fixture.rows.push({
      rowId: 1,
      kind: "timelineMarker",
      sourceCommandId: commandId,
      marker: { type: "compact", status: "success" },
    });
    fixture.emit({ type: "session.event", event: { sessionId: "native-session", seq: 1 } });
    const receipt = await pending;
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.evidence?.evidenceId, commandId);
    assert.equal(fixture.commands.filter((entry) => entry.type === "compact").length, 1);
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode unknown compaction ACK is recorded as unknown and never resent", async () => {
  const fixture = harness({ compactSendFails: true, compactQueryUnknown: true });
  try {
    const session = await fixture.adapter.createSession();
    const commandId = "product-compact-unknown-id";
    const receipt = await fixture.adapter.compactSession!({ session, commandId });
    assert.equal(receipt.status, "unknown");
    assert.match(receipt.reason ?? "", /will not be resent/i);
    assert.equal(fixture.commands.filter((entry) => entry.type === "compact").length, 1);
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode keeps compaction terminal outcomes distinct and rejects busy Sessions", async () => {
  const fixture = harness();
  try {
    const session = await fixture.adapter.createSession();
    const cases = [
      ["noop", "skipped"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ] as const;
    for (const [nativeStatus, expected] of cases) {
      const commandId = `compact-${nativeStatus}`;
      let accepted = false;
      const pending = fixture.adapter.compactSession!({
        session,
        commandId,
        onAccepted: () => (accepted = true),
      });
      await waitUntil(() => accepted);
      fixture.rows.push({
        rowId: fixture.rows.length + 1,
        kind: "timelineMarker",
        sourceCommandId: commandId,
        marker: { type: "compact", status: nativeStatus },
      });
      fixture.emit({ type: "session.event", event: { sessionId: "native-session" } });
      const receipt = await pending;
      assert.equal(receipt.status, expected);
    }
  } finally {
    fixture.adapter.dispose();
  }

  const busyFixture = harness({ nativeActiveTurnId: "active-turn" });
  try {
    const session = await busyFixture.adapter.createSession();
    await assert.rejects(
      busyFixture.adapter.compactSession!({ session, commandId: "compact-busy" }),
      /queued promotion is not integrated/i,
    );
    assert.equal(busyFixture.commands.filter((entry) => entry.type === "compact").length, 0);
  } finally {
    busyFixture.adapter.dispose();
  }
});

test("Runtime preserves each input configuration and ZCode sends it through the active Session", async () => {
  const modelSelection = {
    providerId: "provider-a",
    modelId: "model-b",
    options: { reasoningLevel: "high" },
  };
  const fixture = harness({
    validateModelSelection: async (selection) => {
      assert.deepEqual(selection, modelSelection);
      return undefined;
    },
  });
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["zcode", fixture.adapter]]),
  });
  const environment = {
    id: "local:/tmp/workspace",
    kind: "workspace" as const,
    workDirectory: "/tmp/workspace",
  };
  try {
    const task = await runtime.createTask({
      engineId: "zcode",
      environment,
      authorization: {
        id: "host-grant",
        environmentId: environment.id,
        issuer: "host",
        expiresAt: null,
        scopes: ["session.create", "execution.run"],
      },
    });
    await runtime.submitInput({
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
      text: "run with selected configuration",
      submissionConfig: { mode: "yolo", planEnabled: true, modelSelection },
    });

    assert.deepEqual(runtime.getHistory(task.id)?.inputs[0]?.submissionConfig, {
      mode: "yolo",
      planEnabled: true,
      modelSelection,
    });
    assert.deepEqual(fixture.commands.find((entry) => entry.type === "sendText")?.payload, {
      text: "run with selected configuration",
      requestedDelivery: "startNow",
      mode: "yolo",
      planEnabled: true,
      modelSelection,
    });
  } finally {
    runtime.close();
    fixture.adapter.dispose();
  }
});

test("ZCode maps Host-resolved Engine attachments to native sendText references", async () => {
  const fixture = harness();
  try {
    const session = await fixture.adapter.createSession();
    await fixture.adapter.run({
      session,
      input: "summarize this file",
      attachments: [
        {
          id: "attachment_ticket_1",
          locator: "/tmp/selected.md",
          fileName: "selected.md",
          mimeType: "text/markdown",
          sizeBytes: 17,
        },
      ],
    });
    assert.deepEqual(fixture.commands.find((entry) => entry.type === "sendText")?.payload, {
      text: "summarize this file",
      requestedDelivery: "startNow",
      modelSelection: DEFAULT_MODEL_SELECTION,
      attachments: [
        {
          ref: "/tmp/selected.md",
          fileName: "selected.md",
          mime: "text/markdown",
          bytes: 17,
        },
      ],
    });
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode rejects an unsupported adapter-specific mode before native dispatch", async () => {
  const fixture = harness();
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["zcode", fixture.adapter]]),
  });
  const environment = {
    id: "local:/tmp/workspace",
    kind: "workspace" as const,
    workDirectory: "/tmp/workspace",
  };
  try {
    const task = await runtime.createTask({
      engineId: "zcode",
      environment,
      authorization: {
        id: "host-grant",
        environmentId: environment.id,
        issuer: "host",
        expiresAt: null,
        scopes: ["session.create", "execution.run"],
      },
    });
    await assert.rejects(
      runtime.submitInput({
        taskId: task.id,
        participantId: task.participant.id,
        sessionId: task.session.id,
        authorizationId: task.authorizationId,
        text: "must not dispatch an unknown mode",
        submissionConfig: { mode: "unknown-mode" },
      }),
      (error: unknown) => {
        assert.equal((error as EngineContractError).failure.sideEffects, "none");
        return true;
      },
    );
    const history = runtime.getHistory(task.id);
    assert.equal(history?.inputs[0]?.status, "rejected");
    assert.deepEqual(history?.inputs[0]?.submissionConfig, { mode: "unknown-mode" });
    assert.equal(history?.executions.length, 0);
    assert.equal(
      fixture.commands.some((entry) => entry.type === "sendText"),
      false,
    );
  } finally {
    runtime.close();
    fixture.adapter.dispose();
  }
});

test("an invalid configured model leaves a rejected input without native dispatch or Execution", async () => {
  const modelSelection = { providerId: "removed-provider", modelId: "removed-model" };
  const fixture = harness({
    validateModelSelection: async () => "所选模型配置无效：provider-not-found",
  });
  const runtime = createTaskRuntime({
    databasePath: ":memory:",
    engines: new Map([["zcode", fixture.adapter]]),
  });
  const environment = {
    id: "local:/tmp/workspace",
    kind: "workspace" as const,
    workDirectory: "/tmp/workspace",
  };
  try {
    const task = await runtime.createTask({
      engineId: "zcode",
      environment,
      authorization: {
        id: "host-grant",
        environmentId: environment.id,
        issuer: "host",
        expiresAt: null,
        scopes: ["session.create", "execution.run"],
      },
    });
    await assert.rejects(
      runtime.submitInput({
        taskId: task.id,
        participantId: task.participant.id,
        sessionId: task.session.id,
        authorizationId: task.authorizationId,
        text: "must not dispatch",
        submissionConfig: { modelSelection },
      }),
      (error: unknown) => {
        assert.equal((error as EngineContractError).failure.sideEffects, "none");
        return true;
      },
    );

    const history = runtime.getHistory(task.id);
    assert.equal(history?.inputs.length, 1);
    assert.equal(history?.inputs[0]?.status, "rejected");
    assert.deepEqual(history?.inputs[0]?.submissionConfig, { modelSelection });
    assert.equal(history?.executions.length, 0);
    assert.equal(
      fixture.commands.some((entry) => entry.type === "sendText"),
      false,
    );
  } finally {
    runtime.close();
    fixture.adapter.dispose();
  }
});

test("ZCode fork resolves a stable native turn and adopts one distinct child Session", async () => {
  const rows: NativeAssistantRow[] = [];
  const fixture = harness({ rows });
  try {
    const session = await fixture.adapter.createSession();
    const run = await fixture.adapter.run({ session, input: "source round" });
    rows.push(
      {
        rowId: 10,
        kind: "turnHeader",
        turnId: "turn-1",
        sourceCommandId: run.executionId,
        state: "completedSuccess",
      },
      {
        rowId: 11,
        entityId: "native-answer-1",
        kind: "assistantText",
        turnId: "turn-1",
        state: "complete",
        actions: { canFork: true },
      },
      {
        rowId: 12,
        entityId: "native-answer-2",
        kind: "assistantText",
        turnId: "turn-2",
        state: "complete",
        actions: { canFork: true },
      },
    );
    const child = await fixture.adapter.forkSession!({
      session,
      sourceExecutionId: run.executionId,
      commandId: "host-fork-command-1",
    });
    assert.equal(child, "native-fork-child");
    assert.notEqual(child, session);
    const fork = fixture.commands.find((entry) => entry.type === "forkAssistant")!;
    assert.equal(fork.commandId, "host-fork-command-1");
    assert.equal(fork.baseRevision, 0);
    assert.equal(fork.baseLogEpoch, "test-log-epoch");
    assert.deepEqual(fork.payload, { target: { rowId: 11, entityId: "native-answer-1" } });
    assert.equal(
      parseCommandEnvelope({
        ...fork,
        clientId: "host",
        sessionId: session,
        issuedAt: 1,
      }).ok,
      true,
    );
    await fixture.adapter.run({ session: child, input: "child round" });
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode fork never guesses an absent target and reconciles a lost native ACK by command ID", async () => {
  const rows: NativeAssistantRow[] = [];
  const fixture = harness({ rows, forkSendFails: true });
  try {
    const session = await fixture.adapter.createSession();
    const run = await fixture.adapter.run({ session, input: "source round" });
    const request = {
      session,
      sourceExecutionId: run.executionId,
      commandId: "host-fork-command-2",
    };
    await assert.rejects(
      () => fixture.adapter.forkSession!(request),
      /stable native assistant fork target/,
    );
    assert.equal(fixture.commands.filter((entry) => entry.type === "forkAssistant").length, 0);
    rows.push(
      {
        rowId: 10,
        kind: "turnHeader",
        turnId: "turn-1",
        sourceCommandId: run.executionId,
        state: "completedSuccess",
      },
      {
        rowId: 11,
        entityId: "native-answer",
        kind: "assistantText",
        turnId: "turn-1",
        state: "complete",
        actions: { canFork: true },
      },
    );
    assert.equal(await fixture.adapter.forkSession!(request), "native-fork-child");
    assert.equal(fixture.commands.filter((entry) => entry.type === "forkAssistant").length, 1);
  } finally {
    fixture.adapter.dispose();
  }
  const unknown = harness({ rows, forkSendFails: true, forkQueryUnknown: true });
  try {
    const session = await unknown.adapter.createSession();
    const run = await unknown.adapter.run({ session, input: "source round" });
    rows[0]!.sourceCommandId = run.executionId;
    await assert.rejects(
      () =>
        unknown.adapter.forkSession!({
          session,
          sourceExecutionId: run.executionId,
          commandId: "host-fork-command-3",
        }),
      (error: unknown) =>
        error instanceof EngineContractError && error.failure.kind === "result-unknown",
    );
    assert.equal(unknown.commands.filter((entry) => entry.type === "forkAssistant").length, 1);
  } finally {
    unknown.adapter.dispose();
  }
});

test("ZCode checks Host eligibility after asynchronous model validation", async () => {
  let validationEntered!: () => void;
  let finishValidation!: () => void;
  const started = new Promise<void>((resolve) => {
    validationEntered = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    finishValidation = resolve;
  });
  const fixture = harness({
    validateModelSelection: async () => {
      validationEntered();
      await delayed;
      return undefined;
    },
  });
  try {
    const session = await fixture.adapter.createSession();
    const dispatch = fixture.adapter.run({
      session,
      input: "must not dispatch after freeze",
      beforeDispatch: () => {
        throw new Error("Task is frozen");
      },
    });
    await started;
    finishValidation();
    await assert.rejects(dispatch, /Task is frozen/);
    assert.equal(
      fixture.commands.some((entry) => entry.type === "sendText"),
      false,
    );
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode checks Host eligibility after asynchronous revision row lookup", async () => {
  const rows: NativeAssistantRow[] = [];
  let queryEntered!: () => void;
  let finishQuery!: () => void;
  const started = new Promise<void>((resolve) => {
    queryEntered = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    finishQuery = resolve;
  });
  const fixture = harness({
    rows,
    beforeRows: async () => {
      queryEntered();
      await delayed;
    },
  });
  try {
    const session = await fixture.adapter.createSession();
    const source = await fixture.adapter.run({ session, input: "source round" });
    completeNativeSource(fixture);
    rows.push(
      { rowId: 10, kind: "turnHeader", turnId: "source-turn", sourceCommandId: source.executionId },
      {
        rowId: 11,
        entityId: "source-user",
        kind: "userInput",
        turnId: "source-turn",
        actions: { canEdit: true },
      },
    );
    const dispatch = fixture.adapter.run({
      session,
      input: "edited text",
      revision: { kind: "edit", sourceExecutionId: source.executionId, commandId: "blocked-edit" },
      beforeDispatch: () => {
        throw new Error("Authorization expired");
      },
    });
    await started;
    finishQuery();
    await assert.rejects(dispatch, /Authorization expired/);
    assert.equal(
      fixture.commands.some((entry) => entry.type === "editUserQuery"),
      false,
    );
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode checks Host eligibility after asynchronous fork row lookup", async () => {
  let queryEntered!: () => void;
  let finishQuery!: () => void;
  const started = new Promise<void>((resolve) => {
    queryEntered = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    finishQuery = resolve;
  });
  const fixture = harness({
    rows: [
      {
        rowId: 10,
        kind: "turnHeader",
        turnId: "source-turn",
        sourceCommandId: "native-source",
        state: "completedSuccess",
      },
      {
        rowId: 11,
        entityId: "source-answer",
        kind: "assistantText",
        turnId: "source-turn",
        actions: { canFork: true },
      },
    ],
    beforeRows: async () => {
      queryEntered();
      await delayed;
    },
  });
  try {
    const session = await fixture.adapter.createSession();
    const dispatch = fixture.adapter.forkSession!({
      session,
      sourceExecutionId: "native-source" as never,
      commandId: "blocked-fork",
      beforeDispatch: () => {
        throw new Error("Task is frozen");
      },
    });
    await started;
    finishQuery();
    await assert.rejects(dispatch, /Task is frozen/);
    assert.equal(
      fixture.commands.some((entry) => entry.type === "forkAssistant"),
      false,
    );
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode edit and retry resolve only their native source turn and preserve a stable command ID", async () => {
  for (const kind of ["edit", "retry"] as const) {
    const rows: NativeAssistantRow[] = [];
    const fixture = harness({ rows });
    try {
      const session = await fixture.adapter.createSession();
      const source = await fixture.adapter.run({ session, input: "source round" });
      completeNativeSource(fixture);
      rows.push(
        {
          rowId: 10,
          kind: "turnHeader",
          turnId: "source-turn",
          sourceCommandId: source.executionId,
          state: "completedSuccess",
        },
        {
          rowId: 11,
          entityId: "source-user",
          kind: "userInput",
          turnId: "source-turn",
          actions: { canEdit: true },
        },
        {
          rowId: 12,
          entityId: "source-answer",
          kind: "assistantText",
          turnId: "source-turn",
          actions: { canRetry: true },
        },
        {
          rowId: 13,
          entityId: "unrelated-answer",
          kind: "assistantText",
          turnId: "other-turn",
          actions: { canRetry: true },
        },
      );
      const commandId = `host-${kind}-command`;
      const revised = await fixture.adapter.run({
        session,
        input: kind === "edit" ? "edited text" : "source round",
        revision: { kind, sourceExecutionId: source.executionId, commandId },
      });
      assert.equal(revised.executionId, commandId);
      const native = fixture.commands.find((entry) => entry.commandId === commandId)!;
      assert.equal(native.type, kind === "edit" ? "editUserQuery" : "retryTurn");
      assert.equal(native.baseRevision, 0);
      assert.equal(native.baseLogEpoch, "test-log-epoch");
      assert.deepEqual(native.payload, {
        target:
          kind === "edit"
            ? { rowId: 11, entityId: "source-user" }
            : { rowId: 12, entityId: "source-answer" },
        ...(kind === "edit" ? { newText: "edited text", workspaceMode: "preserve" } : {}),
      });
      assert.equal(
        parseCommandEnvelope({ ...native, clientId: "host", sessionId: session, issuedAt: 1 }).ok,
        true,
      );
    } finally {
      fixture.adapter.dispose();
    }
  }
});

test("ZCode revision reconciles a lost ACK once and rejects absent native targets", async () => {
  const rows: NativeAssistantRow[] = [];
  const fixture = harness({ rows, revisionSendFails: true });
  try {
    const session = await fixture.adapter.createSession();
    const source = await fixture.adapter.run({ session, input: "source round" });
    completeNativeSource(fixture);
    const request = {
      session,
      input: "edited text",
      revision: {
        kind: "edit" as const,
        sourceExecutionId: source.executionId,
        commandId: "stable-edit",
      },
    };
    await assert.rejects(() => fixture.adapter.run(request), /unique native revision target/);
    assert.equal(fixture.commands.filter((entry) => entry.type === "editUserQuery").length, 0);
    rows.push(
      { rowId: 10, kind: "turnHeader", turnId: "source-turn", sourceCommandId: source.executionId },
      {
        rowId: 11,
        kind: "userInput",
        turnId: "source-turn",
        entityId: "source-user",
        actions: { canEdit: true },
      },
    );
    const revised = await fixture.adapter.run(request);
    assert.equal(revised.executionId, "stable-edit");
    assert.equal(fixture.commands.filter((entry) => entry.type === "editUserQuery").length, 1);
  } finally {
    fixture.adapter.dispose();
  }
  const unknownRows: NativeAssistantRow[] = [];
  const unknown = harness({
    rows: unknownRows,
    revisionSendFails: true,
    revisionQueryUnknown: true,
  });
  try {
    const session = await unknown.adapter.createSession();
    const source = await unknown.adapter.run({ session, input: "source round" });
    completeNativeSource(unknown);
    unknownRows.push(
      { rowId: 10, kind: "turnHeader", turnId: "source-turn", sourceCommandId: source.executionId },
      {
        rowId: 11,
        kind: "userInput",
        turnId: "source-turn",
        entityId: "source-user",
        actions: { canEdit: true },
      },
    );
    await assert.rejects(
      () =>
        unknown.adapter.run({
          session,
          input: "edited",
          revision: {
            kind: "edit",
            sourceExecutionId: source.executionId,
            commandId: "unknown-edit",
          },
        }),
      /unknown/u,
    );
    assert.equal(unknown.commands.filter((entry) => entry.type === "editUserQuery").length, 1);
  } finally {
    unknown.adapter.dispose();
  }
});

test("after different models in one Harness Session only the latest canonical turn can be edited", async () => {
  const rows: NativeAssistantRow[] = [];
  const fixture = harness({ rows });
  try {
    const session = await fixture.adapter.createSession();
    const first = await fixture.adapter.run({
      session,
      input: "first model",
      submissionConfig: { modelSelection: { providerId: "provider-a", modelId: "model-a" } },
    });
    completeNativeSource(fixture);
    const second = await fixture.adapter.run({
      session,
      input: "second model",
      submissionConfig: { modelSelection: { providerId: "provider-a", modelId: "model-b" } },
    });
    fixture.emit({
      type: "session.event",
      event: {
        eventId: "second-start",
        seq: 3,
        sessionId: "native-session",
        turnId: "second-turn",
        timestamp: 3,
        type: "turn.started",
        payload: { inputId: "native-input-2", foregroundExecutionId: "native-work-2" },
      },
    });
    fixture.emit({
      type: "session.event",
      event: {
        eventId: "second-complete",
        seq: 4,
        sessionId: "native-session",
        turnId: "second-turn",
        timestamp: 4,
        type: "turn.completed",
        payload: { inputId: "native-input-2", resultType: "success", response: "second answer" },
      },
    });
    rows.push(
      { rowId: 10, kind: "turnHeader", turnId: "first-turn", sourceCommandId: first.executionId },
      { rowId: 11, kind: "userInput", turnId: "first-turn", entityId: "first-user" },
      { rowId: 20, kind: "turnHeader", turnId: "second-turn", sourceCommandId: second.executionId },
      {
        rowId: 21,
        kind: "userInput",
        turnId: "second-turn",
        entityId: "second-user",
        actions: { canEdit: true },
      },
    );
    await assert.rejects(
      () =>
        fixture.adapter.run({
          session,
          input: "old edit",
          revision: { kind: "edit", sourceExecutionId: first.executionId, commandId: "old-edit" },
        }),
      /unique native revision target/,
    );
    const revised = await fixture.adapter.run({
      session,
      input: "new edit",
      submissionConfig: { modelSelection: { providerId: "provider-a", modelId: "model-b" } },
      revision: { kind: "edit", sourceExecutionId: second.executionId, commandId: "latest-edit" },
    });
    assert.equal(revised.executionId, "latest-edit");
    const nativeInputs = fixture.commands.filter((entry) => entry.type === "sendText");
    assert.deepEqual(
      nativeInputs.map(
        (entry) =>
          (entry.payload as { modelSelection: { modelId: string } }).modelSelection.modelId,
      ),
      ["model-a", "model-b"],
    );
    assert.equal(fixture.commands.filter((entry) => entry.type === "editUserQuery").length, 1);
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode assistant feedback resolves and updates the exact current native row", async () => {
  const rows: NativeAssistantRow[] = [
    { rowId: 13, entityId: "assistant-message-13", kind: "assistantText" },
  ];
  const fixture = harness({ rows });
  try {
    const session = await fixture.adapter.createSession();
    const run = await fixture.adapter.run({ session, input: "produce a reply" });
    const request = {
      session,
      executionId: run.executionId,
      messageId: "assistant-message-13",
      feedback: "like" as const,
    };

    assert.equal((await fixture.adapter.setAssistantFeedback!(request)).status, "updated");
    const firstCommand = fixture.commands.find((entry) => entry.type === "setAssistantFeedback");
    assert.deepEqual(firstCommand?.payload, {
      target: { rowId: 13, entityId: "assistant-message-13" },
      feedback: "like",
    });
    assert.equal((await fixture.adapter.setAssistantFeedback!(request)).status, "unchanged");
    assert.equal(
      fixture.commands.filter((entry) => entry.type === "setAssistantFeedback").length,
      1,
    );

    assert.equal(
      (await fixture.adapter.setAssistantFeedback!({ ...request, feedback: "dislike" })).status,
      "updated",
    );
    assert.equal(
      (await fixture.adapter.setAssistantFeedback!({ ...request, feedback: null })).status,
      "updated",
    );
    assert.equal(
      (await fixture.adapter.setAssistantFeedback!({ ...request, feedback: null })).status,
      "unchanged",
    );
    assert.equal(rows[0]?.feedback, undefined);
    assert.deepEqual(
      fixture.commands
        .filter((entry) => entry.type === "setAssistantFeedback")
        .map((entry) => (entry.payload as { feedback: unknown }).feedback),
      ["like", "dislike", null],
    );
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode feedback pages to the exact old row and fails closed for missing or ambiguous targets", async () => {
  const rows: NativeAssistantRow[] = [
    { rowId: 1, entityId: "old-assistant-message", kind: "assistantText" },
    ...Array.from({ length: 200 }, (_, index) => ({
      rowId: index + 2,
      kind: "userInput",
    })),
  ];
  const fixture = harness({
    rows,
    pageWatermarks: [
      { atRevision: 7, atLogEpoch: "native-log-7" },
      { atRevision: 7, atLogEpoch: "native-log-7" },
    ],
  });
  try {
    const session = await fixture.adapter.createSession();
    const run = await fixture.adapter.run({ session, input: "another reply" });
    assert.equal(
      (
        await fixture.adapter.setAssistantFeedback!({
          session,
          executionId: run.executionId,
          messageId: "old-assistant-message",
          feedback: "like",
        })
      ).status,
      "updated",
    );
    assert.deepEqual(fixture.rowQueries, [{ limit: 200 }, { beforeRowId: 2, limit: 200 }]);
    const command = fixture.commands.find((entry) => entry.type === "setAssistantFeedback");
    assert.ok(command);
    assert.deepEqual((command.payload as { target: { rowId: number; entityId: string } }).target, {
      rowId: 1,
      entityId: "old-assistant-message",
    });
    assert.equal(command?.baseRevision, 7);
    assert.equal(command?.baseLogEpoch, "native-log-7");
    assert.equal(parseCommandEnvelope(command).ok, true);
  } finally {
    fixture.adapter.dispose();
  }

  const ambiguousFixture = harness({
    rows: [
      { rowId: 1, entityId: "duplicate-message", kind: "assistantText" },
      { rowId: 201, entityId: "duplicate-message", kind: "assistantText" },
      ...Array.from({ length: 199 }, (_, index) => ({
        rowId: index + 2,
        kind: "userInput",
      })),
    ],
  });
  try {
    const session = await ambiguousFixture.adapter.createSession();
    const run = await ambiguousFixture.adapter.run({ session, input: "ambiguous reply" });
    assert.equal(
      (
        await ambiguousFixture.adapter.setAssistantFeedback!({
          session,
          executionId: run.executionId,
          messageId: "duplicate-message",
          feedback: "like",
        })
      ).status,
      "unsupported",
    );
    assert.equal(
      ambiguousFixture.commands.some((entry) => entry.type === "setAssistantFeedback"),
      false,
    );
  } finally {
    ambiguousFixture.adapter.dispose();
  }
});

test("ZCode feedback refuses pagination across projection revisions before sending a row command", async () => {
  const fixture = harness({
    rows: [
      { rowId: 1, entityId: "old-assistant-message", kind: "assistantText" },
      ...Array.from({ length: 200 }, (_, index) => ({
        rowId: index + 2,
        kind: "userInput",
      })),
    ],
    pageWatermarks: [
      { atRevision: 7, atLogEpoch: "native-log-7" },
      { atRevision: 8, atLogEpoch: "native-log-7" },
    ],
  });
  try {
    const session = await fixture.adapter.createSession();
    const run = await fixture.adapter.run({ session, input: "resolve after concurrent change" });
    const result = await fixture.adapter.setAssistantFeedback!({
      session,
      executionId: run.executionId,
      messageId: "old-assistant-message",
      feedback: "like",
    });
    assert.equal(result.status, "temporarily-unavailable");
    assert.equal(
      fixture.commands.some((entry) => entry.type === "setAssistantFeedback"),
      false,
    );
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode maps a native stale-revision feedback ACK to a retryable result", async () => {
  const fixture = harness({
    rows: [{ rowId: 13, entityId: "assistant-message-13", kind: "assistantText" }],
    feedbackCommandStatus: "stale",
  });
  try {
    const session = await fixture.adapter.createSession();
    const run = await fixture.adapter.run({ session, input: "feedback races another row update" });
    const result = await fixture.adapter.setAssistantFeedback!({
      session,
      executionId: run.executionId,
      messageId: "assistant-message-13",
      feedback: "like",
    });
    assert.equal(result.status, "temporarily-unavailable");
    assert.equal(fixture.rows[0]?.feedback, undefined);
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode feedback returns unknown without an attached Session and does not guess row IDs", async () => {
  const fixture = harness();
  try {
    const result = await fixture.adapter.setAssistantFeedback!({
      session: "session-from-before-adapter-restart" as never,
      executionId: "native-execution" as never,
      messageId: "assistant-message",
      feedback: "like",
    });
    assert.equal(result.status, "unknown");
    assert.equal(
      fixture.commands.some((entry) => entry.type === "setAssistantFeedback"),
      false,
    );

    const session = await fixture.adapter.createSession();
    const run = await fixture.adapter.run({ session, input: "row not yet materialized" });
    const noRow = await fixture.adapter.setAssistantFeedback!({
      session,
      executionId: run.executionId,
      messageId: "missing-assistant-message",
      feedback: "like",
    });
    assert.equal(noRow.status, "unsupported");
    assert.equal(
      fixture.commands.some((entry) => entry.type === "setAssistantFeedback"),
      false,
    );
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode pins the first selected Provider while allowing same-Provider model changes", async () => {
  const fixture = harness();
  try {
    const session = await fixture.adapter.createSession();
    await fixture.adapter.run({
      session,
      input: "first provider selection",
      submissionConfig: {
        modelSelection: { providerId: "provider-a", modelId: "model-a" },
      },
    });
    fixture.emit({
      type: "session.event",
      event: {
        eventId: "pin-turn-start",
        seq: 1,
        sessionId: "native-session",
        turnId: "pin-turn",
        timestamp: 1,
        type: "turn.started",
        payload: { inputId: "native-input", foregroundExecutionId: "native-work" },
      },
    });
    fixture.emit({
      type: "session.event",
      event: {
        eventId: "pin-turn-complete",
        seq: 2,
        sessionId: "native-session",
        turnId: "pin-turn",
        timestamp: 2,
        type: "turn.completed",
        payload: { inputId: "native-input", resultType: "success", response: "done" },
      },
    });

    const second = await fixture.adapter.run({
      session,
      input: "change model within the Provider",
      submissionConfig: {
        modelSelection: {
          providerId: "provider-a",
          modelId: "model-b",
          options: { reasoningLevel: "high" },
        },
      },
    });
    assert.ok(second.executionId);
    const beforeCrossProvider = fixture.commands.filter(
      (entry) => entry.type === "sendText",
    ).length;
    await assert.rejects(
      () =>
        fixture.adapter.run({
          session,
          input: "must not switch Provider",
          submissionConfig: {
            modelSelection: { providerId: "provider-b", modelId: "model-c" },
          },
        }),
      (error: unknown) => {
        assert.equal((error as EngineContractError).failure.kind, "unsupported");
        assert.equal((error as EngineContractError).failure.sideEffects, "none");
        return true;
      },
    );
    assert.equal(
      fixture.commands.filter((entry) => entry.type === "sendText").length,
      beforeCrossProvider,
    );
  } finally {
    fixture.adapter.dispose();
  }
});

test("ZCode requires explicit model selection before pinning a Session Provider", async () => {
  const fixture = harness({ useDefaultModelSelection: false });
  try {
    const session = await fixture.adapter.createSession();
    await assert.rejects(
      () => fixture.adapter.run({ session, input: "missing model selection" }),
      (error: unknown) => {
        assert.equal((error as EngineContractError).failure.kind, "unsupported");
        assert.equal((error as EngineContractError).failure.sideEffects, "none");
        return true;
      },
    );
    assert.equal(
      fixture.commands.some((entry) => entry.type === "sendText"),
      false,
    );
    await fixture.adapter.run({
      session,
      input: "first explicit provider",
      submissionConfig: {
        modelSelection: { providerId: "provider-b", modelId: "model-c" },
      },
    });
    const command = fixture.commands.find((entry) => entry.type === "sendText");
    assert.ok(command);
    assert.equal(
      (command.payload as { modelSelection: { providerId: string } }).modelSelection.providerId,
      "provider-b",
    );
  } finally {
    fixture.adapter.dispose();
  }
});

test("CLI loss before sendText ACK leaves the command outcome unknown", async () => {
  const fixture = harness({ delayedAck: true });
  const session = await fixture.adapter.createSession();
  const pending = fixture.adapter.run({ session, input: "work" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  fixture.disconnect();
  fixture.releaseSendText();
  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as EngineContractError).kind, "result-unknown");
    return true;
  });
  fixture.adapter.dispose();
});

test("ZCode capability refresh reads the existing provider configuration revision", async () => {
  let revision = "provider-config-1";
  const agent = {
    initialize: async () => ({ available: true, workspaceKey: "/tmp/workspace" }),
    onDynamicSessionEvent: () => () => ({ dispose() {} }),
    onAgentRuntimeLifecycle: () => ({ dispose() {} }),
    sendConversationCommandV4: async () => ({ status: "accepted" }),
  } as unknown as AgentPort;
  const adapter = createZCodeAdapter({
    agent,
    workspacePath: "/tmp/workspace",
    readConfigurationVersion: async () => revision,
  });
  const first = await adapter.refreshCapabilities();
  revision = "provider-config-2";
  const second = await adapter.refreshCapabilities();
  assert.equal(first.configurationVersion, "provider-config-1");
  assert.equal(second.configurationVersion, "provider-config-2");
  adapter.dispose();
});

test("a late ZCode capability probe cannot replace newer provider state", async () => {
  let releaseOlder!: (revision: string) => void;
  let reads = 0;
  const agent = {
    initialize: async () => ({ available: true, workspaceKey: "/tmp/workspace" }),
    onDynamicSessionEvent: () => () => ({ dispose() {} }),
    onAgentRuntimeLifecycle: () => ({ dispose() {} }),
    sendConversationCommandV4: async () => ({ status: "accepted" }),
  } as unknown as AgentPort;
  const adapter = createZCodeAdapter({
    agent,
    workspacePath: "/tmp/workspace",
    readConfigurationVersion: () =>
      ++reads === 1
        ? new Promise<string>((resolve) => {
            releaseOlder = resolve;
          })
        : Promise.resolve("provider-config-2"),
  });
  const older = adapter.refreshCapabilities();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const newer = await adapter.refreshCapabilities();
  assert.equal(newer.configurationVersion, "provider-config-2");
  releaseOlder("provider-config-1");
  await older;
  assert.equal(adapter.getCapabilities().configurationVersion, "provider-config-2");
  adapter.dispose();
});

test("the native protocol accepts scheduled display and started capability evidence", () => {
  const event = (eventId: string, payload: Record<string, unknown>) => ({
    eventId,
    sessionId: "native-session",
    turnId: "native-turn",
    seq: 1,
    timestamp: 1,
    type: "tool.updated",
    payload,
  });
  assert.equal(
    zcodeSessionEventSchema.safeParse(
      event("scheduled", {
        kind: "scheduled",
        toolCallId: "tool-read",
        toolName: "Read",
        input: { filePath: "README.md" },
        display: { kind: "file_read" },
      }),
    ).success,
    true,
  );
  assert.equal(
    zcodeSessionEventSchema.safeParse(
      event("started", {
        kind: "started",
        toolCallId: "tool-bash",
        toolName: "Bash",
        startedAt: 1,
        readOnly: true,
        sideEffectScope: "none",
      }),
    ).success,
    true,
  );
});

test("ZCode tool cards retain native name and input without inventing a start", async () => {
  const fixture = harness();
  const session = await fixture.adapter.createSession();
  const run = await fixture.adapter.run({ session, input: "work" });
  const events = [];
  const reading = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  const emit = (eventId: string, seq: number, type: string, payload: unknown) =>
    fixture.emit({
      type: "session.event",
      event: {
        eventId,
        seq,
        sessionId: "native-session",
        turnId: "native-turn",
        timestamp: seq,
        type,
        payload,
      },
    });
  emit("turn", 1, "turn.started", { inputId: "native-input" });
  emit("read-input", 2, "model.streaming", {
    kind: "tool_call",
    toolCallId: "read-call",
    toolName: "Read",
    input: { file_path: "README.md" },
  });
  emit("read-scheduled", 3, "tool.updated", {
    kind: "scheduled",
    toolCallId: "read-call",
    toolName: "Read",
    inputOmitted: true,
    inputRef: "model_stream",
  });
  emit("read-error", 4, "tool.updated", {
    kind: "error",
    toolCallId: "read-call",
    error: { message: "File does not exist" },
  });
  emit("bash-scheduled", 5, "tool.updated", {
    kind: "scheduled",
    toolCallId: "bash-call",
    toolName: "Bash",
    input: { command: "pwd" },
  });
  emit("bash-started", 6, "tool.updated", {
    kind: "started",
    toolCallId: "bash-call",
    startedAt: 6,
    readOnly: true,
    sideEffectScope: "none",
  });
  emit("bash-result", 7, "tool.updated", {
    kind: "result",
    toolCallId: "bash-call",
    result: { success: true, content: "/tmp/workspace" },
  });
  fixture.adapter.dispose();
  await reading;
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("tool.")).map((event) => event.type),
    ["tool.failed", "tool.started", "tool.completed"],
  );
  const failed = events.find((event) => event.type === "tool.failed");
  const started = events.find((event) => event.type === "tool.started");
  const completed = events.find((event) => event.type === "tool.completed");
  assert.equal(failed?.type === "tool.failed" && failed.name, "Read");
  assert.deepEqual(failed?.type === "tool.failed" && failed.input, { file_path: "README.md" });
  assert.equal(started?.type === "tool.started" && started.name, "Bash");
  assert.deepEqual(started?.type === "tool.started" && started.input, { command: "pwd" });
  assert.equal(completed?.type === "tool.completed" && completed.name, "Bash");
});

test("late native event stays with its completed run until CLI loss", async () => {
  const fixture = harness();
  const session = await fixture.adapter.createSession();
  const run = await fixture.adapter.run({ session, input: "work" });
  const events = [];
  const reading = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "completed-start",
      seq: 1,
      sessionId: "native-session",
      turnId: "turn-done",
      timestamp: 1,
      type: "turn.started",
      payload: { inputId: "native-input", foregroundExecutionId: "native-work" },
    },
  });
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "completed-end",
      seq: 2,
      sessionId: "native-session",
      turnId: "turn-done",
      timestamp: 2,
      type: "turn.completed",
      payload: { inputId: "native-input", resultType: "success", response: "done" },
    },
  });
  const nextRun = await fixture.adapter.run({ session, input: "next" });
  const nextEvents = [];
  const nextReading = (async () => {
    for await (const event of nextRun.events) nextEvents.push(event);
  })();
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "next-start",
      seq: 3,
      sessionId: "native-session",
      turnId: "turn-next",
      timestamp: 3,
      type: "turn.started",
      payload: { inputId: "native-input-2", foregroundExecutionId: "native-work-2" },
    },
  });
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "late-tool",
      seq: 4,
      sessionId: "native-session",
      turnId: "turn-done",
      timestamp: 4,
      type: "tool.updated",
      payload: { kind: "started", toolCallId: "late-tool-1", toolName: "read" },
    },
  });
  fixture.emit({
    type: "permission.request",
    request: {
      sessionId: "native-session",
      requestId: "late-unscoped-approval",
      toolCallId: "tool-late",
      toolName: "write",
      reason: "late request from an unknown turn",
      options: [{ optionId: "allow", kind: "allowOnce", name: "Allow" }],
    },
  });
  fixture.emit({
    type: "userInput.request",
    request: {
      sessionId: "native-session",
      requestId: "late-unscoped-input",
      prompt: "late request from an unknown turn",
    },
  });
  assert.equal(
    (
      await fixture.adapter.replyToApproval({
        session,
        approvalId: "late-unscoped-approval" as never,
        optionId: "allow",
      })
    ).status,
    "unsupported",
  );
  assert.equal(
    (
      await fixture.adapter.replyToUserInput({
        session,
        requestId: "late-unscoped-input" as never,
        response: "yes",
      })
    ).status,
    "unsupported",
  );
  fixture.disconnect();
  await reading;
  await nextReading;
  assert.deepEqual(
    events.map((event) => event.type),
    ["input.accepted", "execution.started", "execution.completed", "tool.started"],
  );
  assert.deepEqual(
    nextEvents.map((event) => event.type),
    ["input.accepted", "execution.started", "execution.unknown"],
  );
  fixture.adapter.dispose();
});

test("CLI lifecycle loss ends an acknowledged run with unknown evidence", async () => {
  const fixture = harness();
  const session = await fixture.adapter.createSession();
  const run = await fixture.adapter.run({ session, input: "work" });
  const events = [];
  const reading = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "started-before-disconnect",
      seq: 1,
      sessionId: "native-session",
      turnId: "turn-loss",
      timestamp: 1,
      type: "turn.started",
      payload: { inputId: "native-input", foregroundExecutionId: "native-work" },
    },
  });
  fixture.disconnect();
  await reading;
  assert.deepEqual(
    events.map((event) => event.type),
    ["input.accepted", "execution.started", "execution.unknown"],
  );
  assert.equal(
    fixture.adapter.getCapabilities().capabilities["execution.run"].availability,
    "temporarily-unavailable",
  );
  fixture.adapter.dispose();
});

test("native start before sendText ACK uses the acknowledged input ID", async () => {
  const fixture = harness({ earlyStart: true });
  const session = await fixture.adapter.createSession();
  const run = await fixture.adapter.run({ session, input: "work" });
  const events = [];
  const reading = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  fixture.adapter.dispose();
  await reading;
  assert.deepEqual(
    events.map((event) => event.type),
    ["input.accepted", "execution.started"],
  );
});

test("native model text streams before completion without duplicate or reasoning content", async () => {
  const fixture = harness();
  const session = await fixture.adapter.createSession();
  const run = await fixture.adapter.run({ session, input: "work" });
  const events = [];
  const reading = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  const emit = (eventId: string, seq: number, type: string, payload: unknown) =>
    fixture.emit({
      type: "session.event",
      event: {
        eventId,
        seq,
        sessionId: "native-session",
        turnId: "turn-stream",
        timestamp: seq,
        type,
        payload,
      },
    });
  emit("start-stream", 1, "turn.started", {
    inputId: "native-input",
    foregroundExecutionId: "native-work",
  });
  emit("reasoning-stream", 2, "model.streaming", {
    kind: "reasoning_delta",
    delta: "private reasoning",
  });
  emit("text-start-1", 3, "model.streaming", {
    kind: "text_start",
    delta: "",
    assistantMessageId: "native-message",
  });
  emit("text-start-1", 3, "model.streaming", {
    kind: "text_start",
    delta: "",
    assistantMessageId: "native-message",
  });
  emit("text-stream-1", 4, "model.streaming", {
    kind: "text_delta",
    delta: "Hello ",
    assistantMessageId: "native-message",
  });
  emit("text-stream-1", 4, "model.streaming", {
    kind: "text_delta",
    delta: "Hello ",
    assistantMessageId: "native-message",
  });
  emit("text-stream-2", 5, "model.streaming", {
    kind: "text_delta",
    delta: "world",
    assistantMessageId: "native-message",
  });
  emit("text-end-1", 6, "model.streaming", {
    kind: "text_end",
    delta: "",
    assistantMessageId: "native-message",
  });
  emit("text-start-2", 7, "model.streaming", {
    kind: "text_start",
    delta: "",
    assistantMessageId: "native-message",
  });
  emit("text-stream-3", 8, "model.streaming", {
    kind: "text_delta",
    delta: "!",
    assistantMessageId: "native-message",
  });
  emit("text-end-2", 9, "model.streaming", {
    kind: "text_end",
    delta: "",
    assistantMessageId: "native-message",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.filter((event) => event.type === "message.delta").map((event) => event.text),
    ["Hello ", "world", "!"],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "message.delta")
      .map((event) => ({
        messageId: event.messageId,
        blockId: event.blockId,
      })),
    [
      { messageId: "native-message", blockId: "zcode-text-1" },
      { messageId: "native-message", blockId: "zcode-text-1" },
      { messageId: "native-message", blockId: "zcode-text-2" },
    ],
  );
  emit("end-stream", 10, "turn.completed", {
    inputId: "native-input",
    resultType: "success",
    response: "Hello world!",
  });
  fixture.adapter.dispose();
  await reading;
});

test("ZCode ACK, native start, approval, stop request and terminal remain distinct", async () => {
  const fixture = harness();
  const session = await fixture.adapter.createSession();
  const run = await fixture.adapter.run({ session, input: "work" });
  const events = [];
  const reading = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  const inputId = "native-input";

  assert.equal(
    (await fixture.adapter.interrupt({ session, executionId: run.executionId })).status,
    "temporarily-unavailable",
  );
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "start",
      seq: 1,
      sessionId: "native-session",
      turnId: "turn-1",
      timestamp: 1,
      type: "turn.started",
      payload: { inputId, foregroundExecutionId: "native-work-1" },
    },
  });
  assert.equal(
    (await fixture.adapter.interrupt({ session, executionId: run.executionId })).status,
    "requested",
  );
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "ask",
      seq: 2,
      sessionId: "native-session",
      turnId: "turn-1",
      timestamp: 2,
      type: "permission.requested",
      payload: {
        requestId: "approval-1",
        toolCallId: "tool-1",
        toolName: "write",
        reason: "write a file",
        options: [
          { optionId: "allow-once", kind: "allowOnce", name: "Allow once" },
          { optionId: "deny", kind: "deny", name: "Deny" },
        ],
      },
    },
  });
  assert.equal(
    (
      await fixture.adapter.replyToApproval({
        session,
        approvalId: "approval-1" as never,
        optionId: "unknown",
      })
    ).status,
    "unsupported",
  );
  const reply = fixture.adapter.replyToApproval({
    session,
    approvalId: "approval-1" as never,
    optionId: "deny",
  });
  // A native resolution can race ahead of the v4 command ACK.
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "resolved",
      seq: 3,
      sessionId: "native-session",
      turnId: "turn-1",
      timestamp: 3,
      type: "permission.resolved",
      payload: { requestId: "approval-1", toolCallId: "tool-1", decision: "deny" },
    },
  });
  assert.equal((await reply).status, "forwarded");
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "delta",
      seq: 4,
      sessionId: "native-session",
      turnId: "turn-1",
      timestamp: 4,
      type: "part.delta",
      payload: { messageId: "native-message", partId: "native-part", field: "text", delta: "done" },
    },
  });
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "done",
      seq: 5,
      sessionId: "native-session",
      turnId: "turn-1",
      timestamp: 5,
      type: "turn.completed",
      payload: { inputId, resultType: "success", response: "done" },
    },
  });
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "late",
      seq: 6,
      sessionId: "native-session",
      turnId: "turn-1",
      timestamp: 6,
      type: "part.delta",
      payload: { field: "text", delta: "late detail" },
    },
  });
  fixture.adapter.dispose();
  await reading;

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "input.accepted",
      "execution.started",
      "approval.requested",
      "approval.response",
      "message.delta",
      "execution.completed",
      "message.delta",
    ],
  );
  assert.equal(events[3]?.type === "approval.response" && events[3].decision, "reject");
  assert.equal(events[3]?.type === "approval.response" && events[3].status, "rejected");
  assert.deepEqual(
    events[4]?.type === "message.delta"
      ? { messageId: events[4].messageId, blockId: events[4].blockId }
      : null,
    { messageId: "native-message", blockId: "native-part" },
  );
  assert.equal(
    events.some((event) => event.type === "execution.stopped"),
    false,
  );
  assert.equal(new Set(events.map((event) => event.streamId)).size, 1);
});

test("lost native command response is unknown and never auto retried", async () => {
  let sends = 0;
  const agent = {
    initialize: async () => ({ available: true, workspaceKey: "/tmp/workspace" }),
    sendConversationCommandV4: async () => {
      sends++;
      throw new Error("connection lost");
    },
    onDynamicSessionEvent: () => () => ({ dispose() {} }),
  } as unknown as AgentPort;
  const adapter = createZCodeAdapter({ agent, workspacePath: "/tmp/workspace" });
  await assert.rejects(adapter.createSession(), (error: unknown) => {
    assert.ok(error instanceof EngineContractError);
    assert.equal(error.failure.kind, "result-unknown");
    assert.equal(error.failure.sideEffects, "possible");
    return true;
  });
  assert.equal(sends, 1);
});

test("direct ZCode permission request keeps native options and can be rejected", async () => {
  const fixture = harness();
  const session = await fixture.adapter.createSession();
  const run = await fixture.adapter.run({ session, input: "edit" });
  const events = [];
  const reading = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  const inputId = "native-input";
  fixture.emit({
    type: "permission.request",
    request: {
      requestId: "direct-approval",
      sessionId: "native-session",
      turnId: "turn-direct",
      toolCallId: "tool-direct",
      toolName: "write",
      reason: "edit a file",
      riskLevel: "high",
      input: { file_path: "src/native.ts", content: "native body" },
      origin: {
        kind: "subagent",
        agentId: "agent-child",
        agentType: "worker",
        childSessionId: "child-session",
        parentSessionId: "native-session",
      },
      options: [
        {
          optionId: "allow",
          kind: "allowOnce",
          name: "Allow",
          description: "Allow this request once",
          response: { decision: "allow" },
        },
        {
          optionId: "deny",
          kind: "deny",
          name: "Deny",
          response: { decision: "deny" },
        },
      ],
    },
  });
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "start-direct",
      seq: 1,
      sessionId: "native-session",
      turnId: "turn-direct",
      timestamp: 1,
      type: "turn.started",
      payload: { inputId, foregroundExecutionId: "native-work-direct" },
    },
  });
  assert.equal(
    (
      await fixture.adapter.replyToApproval({
        session,
        approvalId: "direct-approval" as never,
        optionId: "deny",
      })
    ).status,
    "forwarded",
  );
  fixture.adapter.dispose();
  await reading;
  const approval = events.find((event) => event.type === "approval.requested");
  assert.equal(approval?.type === "approval.requested" && approval.options[1]?.decision, "reject");
  assert.deepEqual(approval?.type === "approval.requested" ? approval.presentation : null, {
    toolCallId: "tool-direct",
    input: { file_path: "src/native.ts", content: "native body" },
    riskLevel: "high",
    origin: {
      kind: "subagent",
      agentId: "agent-child",
      agentType: "worker",
      childSessionId: "child-session",
      parentSessionId: "native-session",
    },
  });
  assert.deepEqual(
    approval?.type === "approval.requested" ? approval.options[0]?.presentation : null,
    {
      kind: "allowOnce",
      description: "Allow this request once",
      response: { decision: "allow" },
    },
  );
});

test("native permission denial wins over local answer and user-input marker is not a request", async () => {
  const fixture = harness();
  const session = await fixture.adapter.createSession();
  const run = await fixture.adapter.run({ session, input: "work" });
  const events = [];
  const reading = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  const inputId = "native-input";
  const envelope = (eventId: string, seq: number, type: string, payload: unknown) => ({
    type: "session.event",
    event: {
      eventId,
      seq,
      sessionId: "native-session",
      turnId: "turn-2",
      timestamp: seq,
      type,
      payload,
    },
  });
  fixture.emit(
    envelope("start-2", 1, "turn.started", { inputId, foregroundExecutionId: "work-2" }),
  );
  const request = (requestId: string) => ({
    requestId,
    toolName: "write",
    options: [
      { optionId: "allow", kind: "allowOnce", name: "Allow" },
      { optionId: "deny", kind: "deny", name: "Deny" },
    ],
  });
  fixture.emit(envelope("request-auto", 2, "permission.requested", request("auto")));
  fixture.emit(
    envelope("resolved-auto", 3, "permission.resolved", { requestId: "auto", decision: "deny" }),
  );
  fixture.emit(envelope("request-conflict", 4, "permission.requested", request("conflict")));
  await fixture.adapter.replyToApproval({
    session,
    approvalId: "conflict" as never,
    optionId: "allow",
  });
  fixture.emit(
    envelope("resolved-conflict", 5, "permission.resolved", {
      requestId: "conflict",
      decision: "deny",
    }),
  );
  fixture.emit(envelope("request-opposite", 6, "permission.requested", request("opposite")));
  await fixture.adapter.replyToApproval({
    session,
    approvalId: "opposite" as never,
    optionId: "deny",
  });
  fixture.emit(
    envelope("resolved-opposite", 7, "permission.resolved", {
      requestId: "opposite",
      decision: "allow",
    }),
  );
  fixture.emit(
    envelope("question-marker", 8, "permission.requested", {
      requestId: "marker",
      toolName: "AskUserQuestion",
    }),
  );
  fixture.emit({
    type: "userInput.request",
    request: {
      requestId: "real-question",
      sessionId: "native-session",
      turnId: "turn-2",
      prompt: "Which file?",
    },
  });
  fixture.adapter.dispose();
  await reading;
  const responses = events.filter((event) => event.type === "approval.response");
  assert.deepEqual(
    responses.map((event) => [event.optionId, event.decision, event.status]),
    [
      ["deny", "reject", "rejected"],
      ["deny", "reject", "rejected"],
      ["allow", "approve", "forwarded"],
    ],
  );
  const userInputs = events.filter((event) => event.type === "user-input.requested");
  assert.equal(userInputs.length, 1);
  assert.equal(
    userInputs[0]?.type === "user-input.requested" && userInputs[0].requestId,
    "real-question",
  );
});

test("single-choice user input maps to a constrained native AskUserQuestion answer", async () => {
  const fixture = harness();
  assert.equal(
    fixture.adapter.getCapabilities().capabilities["user-input.respond"].support,
    "supported",
  );
  const session = await fixture.adapter.createSession();
  const run = await fixture.adapter.run({ session, input: "choose a file" });
  const events = [];
  const reading = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "choice-turn-start",
      seq: 1,
      sessionId: "native-session",
      turnId: "choice-turn",
      timestamp: 1,
      type: "turn.started",
      payload: { inputId: "native-input", foregroundExecutionId: "native-work-choice" },
    },
  });
  fixture.emit({
    type: "userInput.request",
    request: {
      requestId: "native-choice",
      sessionId: "native-session",
      turnId: "choice-turn",
      questions: [
        {
          question: "Which file should I update?",
          header: "File",
          options: [
            { value: "src/one.ts", label: "One" },
            { value: "src/two.ts", label: "Two" },
          ],
        },
      ],
    },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const request = events.find((event) => event.type === "user-input.requested");
  assert.deepEqual(
    request?.type === "user-input.requested"
      ? {
          prompt: request.prompt,
          inputKind: request.inputKind,
          options: request.options,
        }
      : null,
    {
      prompt: "Which file should I update?",
      inputKind: "choice",
      options: [
        { id: "src/one.ts", label: "One" },
        { id: "src/two.ts", label: "Two" },
      ],
    },
  );
  assert.equal(
    (
      await fixture.adapter.replyToUserInput({
        session,
        requestId: "native-choice" as never,
        response: "not-an-option",
      })
    ).status,
    "unsupported",
  );
  assert.equal(
    fixture.commands.some((item) => item.type === "resolveInteraction"),
    false,
  );
  assert.equal(
    (
      await fixture.adapter.replyToUserInput({
        session,
        requestId: "native-choice" as never,
        response: "src/two.ts",
      })
    ).status,
    "forwarded",
  );
  assert.deepEqual(fixture.commands.find((item) => item.type === "resolveInteraction")?.payload, {
    interactionId: "native-choice",
    answer: {
      action: "accept",
      content: { answers: { "Which file should I update?": "src/two.ts" } },
    },
  });

  fixture.adapter.dispose();
  await reading;
});

test("native user-input response preserves its answer and rejection action", async () => {
  const fixture = harness();
  const session = await fixture.adapter.createSession();
  const run = await fixture.adapter.run({ session, input: "wait for an answer" });
  const events = [];
  const reading = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "response-turn-start",
      seq: 1,
      sessionId: "native-session",
      turnId: "response-turn",
      timestamp: 1,
      type: "turn.started",
      payload: { inputId: "native-input", foregroundExecutionId: "native-work-response" },
    },
  });
  fixture.emit({
    type: "userInput.request",
    request: {
      requestId: "native-answer",
      sessionId: "native-session",
      turnId: "response-turn",
      prompt: "Question",
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const nativeResponse = {
    action: "accept",
    content: { answers: { Question: "selected value" } },
  };
  fixture.emit({
    type: "userInput.response",
    requestId: "native-answer",
    response: nativeResponse,
  });
  fixture.emit({
    type: "userInput.request",
    request: {
      requestId: "native-decline",
      sessionId: "native-session",
      turnId: "response-turn",
      prompt: "Another question",
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const nativeDecline = { action: "decline", reason: "not now" };
  fixture.emit({
    type: "userInput.response",
    requestId: "native-decline",
    response: nativeDecline,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const response = events.find((event) => event.type === "user-input.response");
  assert.deepEqual(
    response?.type === "user-input.response"
      ? { status: response.status, response: response.response }
      : null,
    { status: "forwarded", response: nativeResponse },
  );
  const decline = events.find(
    (event) => event.type === "user-input.response" && event.requestId === "native-decline",
  );
  assert.deepEqual(
    decline?.type === "user-input.response"
      ? { status: decline.status, response: decline.response }
      : null,
    { status: "rejected", response: nativeDecline },
  );

  fixture.adapter.dispose();
  await reading;
});

test("multi-question and multi-select input keeps only the request-bound v4 answer envelope", async () => {
  const fixture = harness();
  const session = await fixture.adapter.createSession();
  const run = await fixture.adapter.run({ session, input: "answer the questions" });
  const events = [];
  const reading = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "multi-question-start",
      seq: 1,
      sessionId: "native-session",
      turnId: "multi-question-turn",
      timestamp: 1,
      type: "turn.started",
      payload: { inputId: "native-input", foregroundExecutionId: "native-work-questions" },
    },
  });
  fixture.emit({
    type: "userInput.request",
    request: {
      requestId: "native-multi-question",
      sessionId: "native-session",
      turnId: "multi-question-turn",
      questions: [
        {
          question: "Which colors should I use?",
          header: "Colors",
          multiSelect: true,
          options: [
            { value: "red", label: "Red", description: "Warm" },
            { value: "blue", label: "Blue" },
          ],
        },
        {
          question: "Use a dark theme?",
          header: "Theme",
          options: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ],
        },
      ],
      origin: {
        kind: "subagent",
        agentId: "child-agent",
        agentType: "worker",
        childSessionId: "child-session",
        parentSessionId: "native-session",
      },
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const request = events.find((event) => event.type === "user-input.requested");
  assert.deepEqual(
    request?.type === "user-input.requested"
      ? {
          requestId: request.requestId,
          inputKind: request.inputKind,
          presentation: request.presentation,
        }
      : null,
    {
      requestId: "native-multi-question",
      inputKind: "form",
      presentation: {
        questions: [
          {
            question: "Which colors should I use?",
            header: "Colors",
            multiSelect: true,
            options: [
              { value: "red", label: "Red", description: "Warm" },
              { value: "blue", label: "Blue" },
            ],
          },
          {
            question: "Use a dark theme?",
            header: "Theme",
            options: [
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ],
          },
        ],
        origin: {
          kind: "subagent",
          agentId: "child-agent",
          agentType: "worker",
          childSessionId: "child-session",
          parentSessionId: "native-session",
        },
      },
    },
  );

  assert.equal(
    (
      await fixture.adapter.replyToUserInput({
        session,
        requestId: "native-multi-question" as never,
        response: {
          action: "accept",
          content: {
            answers: {
              "Which colors should I use?": "red, blue",
              "Use a dark theme?": "yes",
            },
            answer_0: ["red", "blue"],
            answer_1: "yes",
          },
        },
      })
    ).status,
    "forwarded",
  );
  assert.deepEqual(fixture.commands.find((item) => item.type === "resolveInteraction")?.payload, {
    interactionId: "native-multi-question",
    answer: {
      action: "accept",
      content: {
        answers: {
          "Which colors should I use?": "red, blue",
          "Use a dark theme?": "yes",
        },
        answer_0: ["red", "blue"],
        answer_1: "yes",
      },
    },
  });

  fixture.adapter.dispose();
  await reading;
});

test("workflow Refine is a request-scoped permission option and sends native freeText", async () => {
  const fixture = harness();
  const session = await fixture.adapter.createSession();
  const run = await fixture.adapter.run({ session, input: "run a workflow" });
  const events = [];
  const reading = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  fixture.emit({
    type: "session.event",
    event: {
      eventId: "workflow-refine-start",
      seq: 1,
      sessionId: "native-session",
      turnId: "workflow-refine-turn",
      timestamp: 1,
      type: "turn.started",
      payload: { inputId: "native-input", foregroundExecutionId: "native-workflow" },
    },
  });
  fixture.emit({
    type: "permission.request",
    request: {
      requestId: "native-workflow-approval",
      sessionId: "native-session",
      turnId: "workflow-refine-turn",
      toolCallId: "workflow-call",
      toolName: "CreateWorkflow",
      reason: "run the workflow",
      options: [
        { optionId: "allowOnce", kind: "allowOnce", name: "Allow once" },
        { optionId: "deny", kind: "deny", name: "Deny" },
      ],
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const approval = events.find((event) => event.type === "approval.requested");
  const refine =
    approval?.type === "approval.requested"
      ? approval.options.find((option) => option.id === WORKFLOW_REFINE_PERMISSION_OPTION_ID)
      : undefined;
  assert.equal(refine?.requiresFeedback, true);
  assert.equal(
    (
      await fixture.adapter.replyToApproval({
        session,
        approvalId: "native-workflow-approval" as never,
        optionId: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
      })
    ).status,
    "unsupported",
  );
  assert.equal(
    fixture.commands.some((item) => item.type === "resolveInteraction"),
    false,
  );

  assert.equal(
    (
      await fixture.adapter.replyToApproval({
        session,
        approvalId: "native-workflow-approval" as never,
        optionId: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
        feedback: "change the workflow order",
      })
    ).status,
    "forwarded",
  );
  assert.deepEqual(fixture.commands.find((item) => item.type === "resolveInteraction")?.payload, {
    interactionId: "native-workflow-approval",
    answer: {
      optionId: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
      freeText: "change the workflow order",
    },
  });

  fixture.adapter.dispose();
  await reading;
});
