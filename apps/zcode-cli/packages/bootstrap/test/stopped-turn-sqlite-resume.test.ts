import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import {
  SessionEventType,
  createInMemorySessionEventStore,
  createMessageId,
  createPartId,
  createProjectId,
  createRootTraceContext,
  createSessionEvent,
  createSessionId,
  createTurnId,
  type SessionStorePort,
} from "@zcode/contracts";
import { MessageHistoryImpl } from "../../core/src/agent/message-history.js";
import {
  NATIVE_TURN_STARTED_ENTRY,
  STOPPED_TURN_PROVIDER_DISPOSITION,
  confirmStoppedTurnWithdrawal,
} from "../../core/src/agent/stopped-turn-history.js";
import { AgentRuntime } from "../../core/src/runtime/agent-runtime.js";
import { appendEvent } from "../../core/src/runtime/methods/events.js";
import type { AgentRuntimeInternal } from "../../core/src/runtime/internal.js";

for (const failsWithdrawalWrite of [true, false]) {
  test(`SQLite Stop withdrawal ${failsWithdrawalWrite ? "failure blocks" : "success permits"} new Runtime resume`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-stop-resume-"));
    const dbPath = join(directory, "session.sqlite");
    const sessionId = createSessionId("stopped-turn-session");
    const turnId = createTurnId("stopped-turn");
    const messageId = createMessageId("stopped-user");
    const inputId = "anyagent-input";
    let store = new SqliteSessionStore({ dbPath });
    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("stop-resume-project"),
        slug: "stopped-turn-session",
        directory,
        title: "Stopped turn resume test",
        version: "0.16.9",
      });
      await store.saveSessionInput({
        id: inputId,
        sessionID: sessionId,
        kind: "sendText",
        delivery: "startNow",
        payload: {
          text: "SOURCE_WITHDRAW_ME",
          intent: { clientId: "anyagent-m1-host", sourceCommandId: inputId },
        },
      });
      await store.saveMessage({
        id: messageId,
        sessionID: sessionId,
        role: "user",
        agent: "test-agent",
        time: { created: Date.now() },
        anchor: { turnId },
      });
      await store.savePart({
        id: createPartId("stopped-user-part"),
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text: "SOURCE_WITHDRAW_ME",
        time: { start: Date.now(), end: Date.now() },
      });
      await store.markSessionInputPromoted({
        id: inputId,
        sessionID: sessionId,
        promotedMessageID: messageId,
      });
      await store.saveSessionEntry({
        id: "native-turn-started:stopped-turn",
        sessionID: sessionId,
        type: NATIVE_TURN_STARTED_ENTRY,
        time: { created: Date.now(), updated: Date.now() },
        data: { turnId, messageId, inputId },
      });
      const history = new MessageHistoryImpl();
      history.addUser("SOURCE_WITHDRAW_ME", { source: "real_user", turnId: String(turnId) });
      let queueHeld = false;
      const withdrawalStore = failsWithdrawalWrite
        ? ({
            messageWithParts: store.messageWithParts.bind(store),
            messages: store.messages.bind(store),
            saveMessage: async () => {
              throw new Error("injected SQLite saveMessage failure");
            },
          } as unknown as SessionStorePort)
        : store;
      const withdraw = confirmStoppedTurnWithdrawal({
        history,
        sessionStore: withdrawalStore,
        sessionId,
        turnId: String(turnId),
        userMessageId: messageId,
        holdQueue() {
          queueHeld = true;
        },
      });
      if (failsWithdrawalWrite) {
        await assert.rejects(withdraw, /provider context is unconfirmed; queue held/);
        assert.equal(queueHeld, true);
      } else {
        await assert.doesNotReject(withdraw);
        assert.equal(queueHeld, false);
      }
      // Deliberately persist a cancelled terminal even on failure. The cold
      // guard must reject the missing marker despite an apparent terminal.
      const traceContext = createRootTraceContext({ sessionId, turnId });
      const event = createSessionEvent(
        SessionEventType.TurnComplete,
        sessionId,
        {
          duration: 1,
          historyRoundCount: 0,
          inputId,
          response: "",
          resultType: "cancelled",
          tokenCount: 0,
          toolCallCount: 0,
        },
        { turnId },
      );
      await appendEvent.call(
        {
          sessionId,
          sessionStore: store,
          eventStore: createInMemorySessionEventStore(),
          notifyEventSinks: async () => undefined,
        } as unknown as AgentRuntimeInternal,
        event,
        traceContext,
      );
      assert.equal(
        (await store.messageWithParts({ sessionID: sessionId, messageID: messageId }))?.info
          .metadata?.providerHistoryDisposition,
        failsWithdrawalWrite ? undefined : STOPPED_TURN_PROVIDER_DISPOSITION,
      );
      store.close();
      store = new SqliteSessionStore({ dbPath });
      const runtime = new AgentRuntime(
        sessionId,
        { workingDirectory: directory },
        {
          eventStore: createInMemorySessionEventStore(),
          sessionStore: store,
          modelFactory: () => {
            throw new Error("resume must not create a model");
          },
        },
      );
      if (failsWithdrawalWrite) {
        await assert.rejects(runtime.resumeFromStore(), /lacks provider withdrawal/);
      } else {
        await assert.doesNotReject(runtime.resumeFromStore());
      }
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
