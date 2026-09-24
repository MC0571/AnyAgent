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
  createMessageId,
  createPartId,
  createProjectId,
  createRootTraceContext,
  createSessionEvent,
  createSessionId,
  createTurnId,
  type SessionEvent,
} from "@zcode/contracts";
import { appendEvent } from "../../core/src/runtime/methods/events.js";
import type { AgentRuntimeInternal } from "../../core/src/runtime/internal.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";
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
    await persistTranscriptTurn(store, {
      sessionId,
      inputId: durableInputId,
      nativeTurnId: durableTurnId,
      prompt: "question with durable native terminal",
      response: "partially persisted answer",
      createdAt: 1_700_000_000_000,
      historyRoundCount: 2,
      directory,
    });
    const partialInputId = "execution-without-native-terminal";
    await persistTranscriptTurn(store, {
      sessionId,
      inputId: partialInputId,
      nativeTurnId: createTurnId("turn-without-native-terminal"),
      prompt: "question with partial transcript only",
      response: "partial assistant answer",
      createdAt: 1_700_000_010_000,
      historyRoundCount: 3,
      directory,
    });

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

    const missingTurn = createSessionEvent(SessionEventType.TurnError, sessionId, {
      error: { type: "runtime", message: "test failure" },
      inputId: "execution-terminal-without-turn",
      turnPhase: "model",
    });
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

    const coldEvents = synthesizeEventsFromMessages(
      await store.messages({ sessionID: sessionId }),
      {
        sessionId,
      },
    );
    const hydratedStarted = coldEvents.find(
      (event) =>
        event.type === SessionEventType.TurnStarted &&
        (event.payload as { inputId?: string }).inputId === durableInputId,
    );
    assert.equal(hydratedStarted?.turnId, "hydrate-turn-1");
    assert.notEqual(hydratedStarted?.turnId, durableTurnId);
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
        assert.equal(durableHeader.turnId, createMessageId(`user-${durableInputId}`));
        assert.notEqual(durableHeader.turnId, durableTurnId);
        assert.equal(durableHeader.historyRoundCount, 2);
        assert.deepEqual(durableHeader.nativeTerminalEvidence, {
          eventId: liveTerminal.id,
          eventType: SessionEventType.TurnComplete,
          sourceCommandId: durableInputId,
          // Cold row IDs are synthetic; terminal provenance preserves the native ID.
          turnId: durableTurnId,
          resultType: "success",
        });
      }

      const oldRows = await gateway.rowsRange({
        sessionId,
        nativeTerminalSourceCommandId: partialInputId,
        limit: 20,
      });
      const oldHeader = oldRows.rows.find(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === partialInputId,
      );
      assert.equal(oldHeader?.kind, "turnHeader");
      if (oldHeader?.kind === "turnHeader") {
        assert.equal(oldHeader.state, "completedSuccess");
        assert.equal(oldHeader.historyRoundCount, 3);
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

async function persistTranscriptTurn(
  store: SqliteSessionStore,
  input: {
    sessionId: ReturnType<typeof createSessionId>;
    inputId: string;
    nativeTurnId: ReturnType<typeof createTurnId>;
    prompt: string;
    response: string;
    createdAt: number;
    historyRoundCount: number;
    directory: string;
  },
): Promise<void> {
  const userId = createMessageId(`user-${input.inputId}`);
  const assistantId = createMessageId(`assistant-${input.inputId}`);
  await store.saveMessage({
    id: userId,
    sessionID: input.sessionId,
    role: "user",
    time: { created: input.createdAt },
    agent: "test-agent",
    semantics: {
      origin: "real_user",
      kind: "user_prompt",
      uiVisibility: "visible",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    },
    anchor: { origin: "realUser", sourceCommandId: input.inputId },
  });
  await store.savePart({
    id: createPartId(`user-part-${input.inputId}`),
    sessionID: input.sessionId,
    messageID: userId,
    type: "text",
    text: input.prompt,
    time: { start: input.createdAt, end: input.createdAt + 1 },
  });
  await store.saveMessage({
    id: assistantId,
    sessionID: input.sessionId,
    role: "assistant",
    time: { created: input.createdAt + 2, completed: input.createdAt + 3 },
    parentID: userId,
    mode: "build",
    agent: "test-agent",
    path: { cwd: input.directory, root: input.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    anchor: { turnId: input.nativeTurnId, historyRoundCount: input.historyRoundCount },
  });
  await store.savePart({
    id: createPartId(`assistant-part-${input.inputId}`),
    sessionID: input.sessionId,
    messageID: assistantId,
    type: "text",
    text: input.response,
    time: { start: input.createdAt + 2, end: input.createdAt + 3 },
  });
}

function createColdGateway(
  sessionId: ReturnType<typeof createSessionId>,
  events: SessionEvent[],
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
