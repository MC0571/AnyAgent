import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import {
  SESSION_ENTRY_NATIVE_TURN_TERMINAL,
  SessionEventType,
  createInMemorySessionEventStore,
  createProjectId,
  createRootTraceContext,
  createSessionEvent,
  createSessionId,
  createTurnId,
} from "@zcode/contracts";
import { appendEvent } from "../../core/src/runtime/methods/events.js";
import type { AgentRuntimeInternal } from "../../core/src/runtime/internal.js";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";

test("native terminal provenance survives SQLite reopen and excludes cold synthetic terminals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-native-terminal-"));
  const dbPath = join(directory, "session.sqlite");
  const sessionId = createSessionId("native-terminal-session");
  const durableInputId = "execution-with-native-terminal";
  const durableTurnId = createTurnId("turn-with-native-terminal");
  let store = new SqliteSessionStore({ dbPath });
  try {
    await store.createSession({
      id: sessionId,
      projectID: createProjectId("native-terminal-project"),
      slug: "native-terminal-session",
      directory,
      title: "Native terminal provenance test",
      version: "0.16.9",
    });
    const runtime = {
      sessionId,
      sessionStore: store,
      eventStore: createInMemorySessionEventStore(),
      notifyEventSinks: async () => undefined,
    } as unknown as AgentRuntimeInternal;
    const traceContext = createRootTraceContext({ sessionId, turnId: durableTurnId });
    const liveTerminal = createSessionEvent(
      SessionEventType.TurnComplete,
      sessionId,
      {
        duration: 48,
        historyRoundCount: 2,
        inputId: durableInputId,
        response: "native terminal response",
        resultType: "success",
        tokenCount: 12,
        toolCallCount: 0,
      },
      { turnId: durableTurnId },
    );
    await appendEvent.call(runtime, liveTerminal, traceContext);

    const missingInput = createSessionEvent(
      SessionEventType.TurnComplete,
      sessionId,
      {
        duration: 1,
        historyRoundCount: 1,
        response: "synthetic-like response",
        resultType: "success",
        tokenCount: 1,
        toolCallCount: 0,
      },
      { turnId: createTurnId("turn-terminal-without-input") },
    );
    await appendEvent.call(runtime, missingInput, traceContext);

    const missingTurn = createSessionEvent(
      SessionEventType.TurnError,
      sessionId,
      {
        error: { type: "runtime", message: "test failure" },
        inputId: "execution-terminal-without-turn",
        turnPhase: "model",
      },
    );
    await appendEvent.call(runtime, missingTurn, traceContext);

    store.close();
    store = new SqliteSessionStore({ dbPath });
    const entries = await store.sessionEntries({
      sessionID: sessionId,
      type: SESSION_ENTRY_NATIVE_TURN_TERMINAL,
    });
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]?.data, {
      eventId: liveTerminal.id,
      eventType: SessionEventType.TurnComplete,
      inputId: durableInputId,
      resultType: "success",
      sequenceNumber: 1,
      turnId: durableTurnId,
    });

    const coldEvents = [
      createColdTurnEvents({
        inputId: durableInputId,
        turnId: durableTurnId,
        sequenceBase: 1,
        response: "partially persisted answer",
      }),
      createColdTurnEvents({
        inputId: "legacy-terminal-without-provenance",
        turnId: createTurnId("legacy-terminal-turn"),
        sequenceBase: 3,
        response: "old transcript answer",
      }),
    ].flat();
    const gateway = createColdGateway(sessionId, coldEvents, () =>
      store.sessionEntries({ sessionID: sessionId, type: SESSION_ENTRY_NATIVE_TURN_TERMINAL }),
    );
    try {
      const durableRows = await gateway.rowsRange({
        sessionId,
        nativeTerminalSourceCommandId: durableInputId,
        limit: 20,
      });
      const durableHeader = durableRows.rows.find(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === durableInputId,
      );
      assert.equal(durableHeader?.kind, "turnHeader");
      if (durableHeader?.kind === "turnHeader") {
        assert.equal(durableHeader.state, "completedSuccess");
        assert.deepEqual(durableHeader.nativeTerminalEvidence, {
          eventId: liveTerminal.id,
          eventType: SessionEventType.TurnComplete,
          sourceCommandId: durableInputId,
          turnId: durableTurnId,
          resultType: "success",
        });
      }

      const oldRows = await gateway.rowsRange({
        sessionId,
        nativeTerminalSourceCommandId: "legacy-terminal-without-provenance",
        limit: 20,
      });
      const oldHeader = oldRows.rows.find(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === "legacy-terminal-without-provenance",
      );
      assert.equal(oldHeader?.kind, "turnHeader");
      if (oldHeader?.kind === "turnHeader") {
        assert.equal(oldHeader.state, "completedSuccess");
        assert.equal(oldHeader.nativeTerminalEvidence, undefined);
      }
    } finally {
      gateway.dispose();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function createColdTurnEvents(input: {
  inputId: string;
  turnId: ReturnType<typeof createTurnId>;
  sequenceBase: number;
  response: string;
}) {
  const started = createSessionEvent(
    SessionEventType.TurnStarted,
    createSessionId("native-terminal-session"),
    { input: "question", inputId: input.inputId, turnNumber: 1 },
    { turnId: input.turnId },
  );
  const completed = createSessionEvent(
    SessionEventType.TurnComplete,
    createSessionId("native-terminal-session"),
    {
      duration: 48,
      historyRoundCount: 2,
      inputId: input.inputId,
      response: input.response,
      resultType: "success",
      tokenCount: 12,
      toolCallCount: 0,
    },
    { turnId: input.turnId },
  );
  return [
    { ...started, id: `cold-start-${input.turnId}`, sequenceNumber: input.sequenceBase },
    { ...completed, id: `cold-complete-${input.turnId}`, sequenceNumber: input.sequenceBase + 1 },
  ];
}

function createColdGateway(
  sessionId: ReturnType<typeof createSessionId>,
  events: ReturnType<typeof createColdTurnEvents>[number][],
  loadNativeTerminalEntries: () => ReturnType<SqliteSessionStore["sessionEntries"]>,
) {
  const host = {
    sessionExists: (candidateSessionId: string) => candidateSessionId === sessionId,
    emitWireFrame: () => undefined,
    executeCommand: async () => undefined,
    loadPersistedEvents: async () => ({ events, synthesized: true, sourceEventSeq: 0 }),
    loadNativeTurnTerminalEntries: async () => await loadNativeTerminalEntries(),
  } as unknown as ConstructorParameters<typeof ConversationV4Gateway>[0];
  return new ConversationV4Gateway(host);
}
