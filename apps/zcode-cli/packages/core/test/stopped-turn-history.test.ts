import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import {
  confirmStoppedTurnWithdrawal,
  INTERRUPTED_TOOL_RESULT,
  STOPPED_TURN_PROVIDER_DISPOSITION,
  STOPPED_TURN_PROVIDER_TEXT,
  assertNoUnresolvedAnyAgentInputs,
  tagPreRecordedTurnInput,
  withdrawStoppedTurnFromLiveHistory,
} from "../src/agent/stopped-turn-history.js";

test("stopping a live turn withdraws its prompt and partial answer but keeps completed tool facts", () => {
  const history = new MessageHistoryImpl();
  history.addUser("earlier completed prompt");
  history.addAssistant("earlier completed answer");
  history.addUser("SOURCE_SECRET_INSTRUCTION: write 120 lines", {
    source: "real_user",
    turnId: "source-turn",
  });
  history.addAssistant("partial source answer", [
    { id: "tool-1", name: "Write", input: {} },
    { id: "tool-2", name: "Bash", input: {} },
  ]);
  history.addToolResult("tool-1", "Write", "file was written", true);

  // Both microcompact and turn-guide context refresh replace the entry array.
  history.replaceMessages([
    { message: { role: "system", content: "refreshed prefix" } },
    ...history.toRuntimeEntries(),
  ]);
  withdrawStoppedTurnFromLiveHistory(history, "source-turn");
  history.addUser("NEXT_INPUT: answer with NEXT_ONLY");
  const entries = history.toRuntimeEntries();
  const providerText = JSON.stringify(entries);
  assert.equal(providerText.includes("SOURCE_SECRET_INSTRUCTION"), false);
  assert.equal(providerText.includes("partial source answer"), false);
  assert.equal(providerText.includes(STOPPED_TURN_PROVIDER_TEXT), true);
  assert.equal(providerText.includes("file was written"), true);
  assert.equal(providerText.includes(INTERRUPTED_TOOL_RESULT), true);
  assert.equal(
    entries.filter((entry) => entry.kind !== "attachment" && entry.message.role === "tool").length,
    2,
  );
  assert.equal(providerText.includes("NEXT_INPUT"), true);
});

test("memory-only runtime can withdraw a stopped turn without a session store", async () => {
  const history = new MessageHistoryImpl();
  history.addUser("MEMORY_ONLY_SECRET", { source: "real_user", turnId: "memory-turn" });
  await assert.doesNotReject(
    confirmStoppedTurnWithdrawal({
      history,
      sessionId: "memory-session" as never,
      turnId: "memory-turn",
      holdQueue() {
        assert.fail("live withdrawal should succeed");
      },
    }),
  );
  assert.equal(JSON.stringify(history.toRuntimeEntries()).includes("MEMORY_ONLY_SECRET"), false);
});

test("cold hydration withdraws the same stopped turn without altering native transcript", async () => {
  const nativeMessages = [
    {
      info: {
        id: "source-user",
        role: "user",
        metadata: { providerHistoryDisposition: STOPPED_TURN_PROVIDER_DISPOSITION },
        anchor: { turnId: "source-turn" },
      },
      parts: [{ id: "source-part", type: "text", text: "SOURCE_SECRET_INSTRUCTION" }],
    },
    {
      info: { id: "source-assistant", role: "assistant", anchor: { turnId: "source-turn" } },
      parts: [
        { id: "source-answer", type: "text", text: "partial source answer" },
        {
          id: "completed-tool",
          type: "tool",
          callID: "tool-1",
          tool: "Write",
          state: { status: "completed", input: {}, output: "file was written" },
        },
        {
          id: "pending-tool",
          type: "tool",
          callID: "tool-2",
          tool: "Bash",
          state: { status: "pending", input: {} },
        },
      ],
    },
    {
      info: {
        id: "source-plugin-notice",
        role: "user",
        source: "plugin_reference",
        anchor: { turnId: "source-turn" },
      },
      parts: [{ id: "plugin-part", type: "text", text: "SYNTHETIC_SOURCE_INSTRUCTION" }],
    },
    {
      info: { id: "next-user", role: "user", anchor: { turnId: "next-turn" } },
      parts: [{ id: "next-part", type: "text", text: "NEXT_INPUT" }],
    },
  ];
  const history = new MessageHistoryImpl();
  await hydrateMessageHistoryFromSession({ history, messages: nativeMessages as never });
  const providerText = JSON.stringify(history.toRuntimeEntries());
  assert.equal(providerText.includes("SOURCE_SECRET_INSTRUCTION"), false);
  assert.equal(providerText.includes("partial source answer"), false);
  assert.equal(providerText.includes("SYNTHETIC_SOURCE_INSTRUCTION"), false);
  assert.equal(providerText.includes(STOPPED_TURN_PROVIDER_TEXT), true);
  assert.equal(providerText.includes("file was written"), true);
  assert.equal(providerText.includes(INTERRUPTED_TOOL_RESULT), true);
  assert.equal(providerText.includes("NEXT_INPUT"), true);
  assert.equal(nativeMessages[0]!.parts[0]!.text, "SOURCE_SECRET_INSTRUCTION");
});

test("compact-preserved orphan assistant still withdraws partial stopped output on restart", async () => {
  const messages = [
    {
      info: {
        id: "source-user",
        role: "user",
        anchor: { turnId: "source-turn" },
        metadata: { providerHistoryDisposition: STOPPED_TURN_PROVIDER_DISPOSITION },
        semantics: { providerVisibility: "hidden" },
      },
      parts: [{ id: "source-part", type: "text", text: "SOURCE_SECRET_INSTRUCTION" }],
    },
    {
      info: { id: "source-assistant", role: "assistant", anchor: { turnId: "source-turn" } },
      parts: [{ id: "source-answer", type: "text", text: "partial source answer" }],
    },
    {
      info: { id: "compact", role: "user" },
      parts: [
        {
          id: "compact-part",
          type: "compaction",
          compactBoundary: {
            preservedSegment: {
              anchorMessageId: "compact",
              headMessageId: "source-assistant",
              tailMessageId: "source-assistant",
            },
          },
        },
      ],
    },
  ];
  const history = new MessageHistoryImpl();
  await hydrateMessageHistoryFromSession({ history, messages: messages as never });
  const providerText = JSON.stringify(history.toRuntimeEntries());
  assert.equal(providerText.includes("SOURCE_SECRET_INSTRUCTION"), false);
  assert.equal(providerText.includes("partial source answer"), false);
  assert.equal(providerText.includes(STOPPED_TURN_PROVIDER_TEXT), true);
});

test("failed durable withdrawal holds a queued next Input without a terminal claim", async () => {
  const history = new MessageHistoryImpl();
  history.addUser("SOURCE_SECRET_INSTRUCTION", { source: "real_user", turnId: "source-turn" });
  const sourceInfo = {
    id: "source-user",
    role: "user",
    anchor: { turnId: "source-turn" },
    metadata: {},
  };
  const queued = ["NEXT_INPUT"];
  let autoDrain = true;
  let externalDrain = true;
  let terminalClaimed = false;
  const store = {
    async messageWithParts() {
      return { info: sourceInfo, parts: [] };
    },
    async messages() {
      return [{ info: sourceInfo, parts: [] }];
    },
    async saveMessage() {
      throw new Error("injected SQLite write failure");
    },
    async listSessionInputs() {
      return [
        {
          kind: "sendText",
          status: "promoted",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "source-input" } },
        },
      ];
    },
    async sessionEntries() {
      return []; // Failure happened before TurnComplete could write terminal provenance.
    },
  };
  await assert.rejects(
    confirmStoppedTurnWithdrawal({
      history,
      sessionId: "test-session" as never,
      turnId: "source-turn",
      userMessageId: "source-user" as never,
      sessionStore: store as never,
      holdQueue() {
        autoDrain = false;
        externalDrain = false;
      },
    }).then(() => {
      terminalClaimed = true;
    }),
    /provider context is unconfirmed; queue held/,
  );
  if (autoDrain || externalDrain) queued.shift();
  assert.deepEqual(queued, ["NEXT_INPUT"]);
  assert.equal(terminalClaimed, false);
  assert.equal(
    JSON.stringify(history.toRuntimeEntries()).includes("SOURCE_SECRET_INSTRUCTION"),
    false,
  );
  await assert.rejects(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
    /Native Input result is unresolved/,
  );
});

test("same-turn auto compact blocks queue when its summary may include the stopped instruction", async () => {
  const history = new MessageHistoryImpl();
  history.addUser("SOURCE_SECRET_INSTRUCTION", { source: "real_user", turnId: "source-turn" });
  let held = false;
  let saved = false;
  await assert.rejects(
    confirmStoppedTurnWithdrawal({
      history,
      sessionId: "test-session" as never,
      turnId: "source-turn",
      userMessageId: "source-user" as never,
      sessionStore: {
        async messageWithParts() {
          return {
            info: { id: "source-user", role: "user", anchor: { turnId: "source-turn" } },
            parts: [],
          };
        },
        async messages() {
          return [
            {
              info: { id: "summary", role: "user" },
              parts: [{ type: "compaction", compactBoundary: { turnId: "source-turn" } }],
            },
          ];
        },
        async saveMessage() {
          saved = true;
        },
      } as never,
      holdQueue() {
        held = true;
      },
    }),
    /provider context is unconfirmed; queue held/,
  );
  assert.equal(held, true);
  assert.equal(saved, false);
});

test("unknown native tool outcome holds queue and blocks cold resume", async () => {
  const history = new MessageHistoryImpl();
  history.addUser("SOURCE_WITH_WRITE", { source: "real_user", turnId: "source-turn" });
  let held = false;
  const messages = [
    {
      info: { id: "source-user", role: "user", anchor: { turnId: "source-turn" } },
      parts: [],
    },
    {
      info: { id: "assistant", role: "assistant", anchor: { turnId: "source-turn" } },
      parts: [{ type: "tool", state: { status: "running" } }],
    },
  ];
  await assert.rejects(
    confirmStoppedTurnWithdrawal({
      history,
      sessionId: "test-session" as never,
      turnId: "source-turn",
      userMessageId: "source-user" as never,
      sessionStore: {
        async messageWithParts() {
          return messages[0];
        },
        async messages() {
          return messages;
        },
      } as never,
      holdQueue() {
        held = true;
      },
    }),
    /provider context is unconfirmed; queue held/,
  );
  assert.equal(held, true);
  const store = {
    async listSessionInputs() {
      return [
        {
          kind: "sendText",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "source-input" } },
        },
      ];
    },
    async sessionEntries(input: { type: string }) {
      if (input.type === "runtime/native_turn_started") return [];
      return [
        { data: { inputId: "source-input", resultType: "cancelled", turnId: "source-turn" } },
      ];
    },
    async messages() {
      return [
        {
          info: {
            ...messages[0]!.info,
            metadata: { providerHistoryDisposition: STOPPED_TURN_PROVIDER_DISPOSITION },
          },
          parts: [],
        },
        messages[1],
      ];
    },
  };
  await assert.rejects(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
    /tool outcome is unknown/,
  );
});

test("cold resume requires terminal provenance for promoted text and goal inputs", async () => {
  const store = {
    async listSessionInputs() {
      return [
        {
          kind: "sendText",
          status: "promoted",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "source-input" } },
        },
        {
          kind: "sendGoalCommand",
          status: "promoted",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "goal-input" } },
        },
      ];
    },
    async sessionEntries() {
      return [{ data: { inputId: "source-input", resultType: "success" } }];
    },
  };
  await assert.rejects(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
    /Native Input result is unresolved/,
  );
  await assert.doesNotReject(
    assertNoUnresolvedAnyAgentInputs({} as never, "legacy-session" as never),
  );
  await assert.doesNotReject(
    assertNoUnresolvedAnyAgentInputs(
      {
        async listSessionInputs() {
          return [
            {
              kind: "sendText",
              status: "promoted",
              payload: { intent: { clientId: "legacy-cli", sourceCommandId: "legacy-input" } },
            },
          ];
        },
      } as never,
      "m0-session" as never,
    ),
  );
});

test("cold resume blocks legacy cancelled turn without durable withdrawal marker", async () => {
  const store = {
    async listSessionInputs() {
      return [
        {
          kind: "sendText",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "source-input" } },
        },
      ];
    },
    async sessionEntries() {
      return [
        { data: { inputId: "source-input", resultType: "cancelled", turnId: "source-turn" } },
      ];
    },
    async messages() {
      return [{ info: { role: "user", anchor: { turnId: "source-turn" } }, parts: [] }];
    },
  };
  await assert.rejects(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
    /lacks provider withdrawal/,
  );
  await assert.doesNotReject(
    assertNoUnresolvedAnyAgentInputs(
      {
        ...store,
        async messages() {
          return [
            {
              info: {
                role: "user",
                anchor: { turnId: "source-turn" },
                metadata: { providerHistoryDisposition: STOPPED_TURN_PROVIDER_DISPOSITION },
              },
              parts: [],
            },
          ];
        },
      } as never,
      "test-session" as never,
    ),
  );
});

test("cold resume permits a second turn stopped before its user Input was persisted", async () => {
  const store = {
    async listSessionInputs() {
      return [
        {
          kind: "sendText",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "first-input" } },
        },
        {
          kind: "sendText",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "second-input" } },
        },
      ];
    },
    async sessionEntries(input: { type: string }) {
      if (input.type === "runtime/native_turn_started") {
        return [
          { data: { turnId: "first-turn", messageId: "first-user", inputId: "first-input" } },
          { data: { turnId: "second-turn", messageId: "second-user", inputId: "second-input" } },
        ];
      }
      return [
        { data: { inputId: "first-input", resultType: "success", turnId: "first-turn" } },
        { data: { inputId: "second-input", resultType: "cancelled", turnId: "second-turn" } },
      ];
    },
    async messages() {
      return [
        {
          info: { id: "first-user", role: "user", anchor: { turnId: "first-turn" } },
          parts: [{ type: "text", text: "FIRST_COMPLETED_INPUT" }],
        },
      ];
    },
  };
  await assert.doesNotReject(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
  );
  await assert.rejects(
    assertNoUnresolvedAnyAgentInputs(
      {
        ...store,
        async messages() {
          return [
            ...(await store.messages()),
            {
              info: { id: "second-user", role: "user", anchor: { turnId: "second-turn" } },
              parts: [{ type: "text", text: "SECOND_PERSISTED_INPUT" }],
            },
          ];
        },
      } as never,
      "test-session" as never,
    ),
    /lacks provider withdrawal/,
  );
});

for (const control of ["compact", "rewind", "fork", "fork latest"] as const) {
  test(`cancelled ${control} control turn needs no provider withdrawal marker`, async () => {
    const store = {
      async listSessionInputs() {
        return [
          {
            kind: "sendText",
            payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "first-input" } },
          },
          {
            kind: control === "compact" ? "compact" : "sendText",
            payload: {
              text:
                control === "compact"
                  ? "/compact"
                  : control === "rewind"
                    ? "/rewind status"
                    : control === "fork"
                      ? "/fork"
                      : "/fork latest",
              intent: { sourceCommandId: `${control}-input` },
            },
          },
        ];
      },
      async sessionEntries(input: { type: string }) {
        if (input.type === "runtime/native_turn_started") {
          return [{ data: { turnId: "first-turn", messageId: "first-user" } }];
        }
        return [
          { data: { inputId: "first-input", resultType: "success", turnId: "first-turn" } },
          {
            data: {
              inputId: `${control}-input`,
              resultType: "cancelled",
              turnId: `${control}-turn`,
            },
          },
        ];
      },
      async messages() {
        return [
          {
            info: { id: "first-user", role: "user", anchor: { turnId: "first-turn" } },
            parts: [{ type: "text", text: "FIRST_COMPLETED_INPUT" }],
          },
        ];
      },
    };
    await assert.doesNotReject(
      assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
    );
  });
}

test("old /rewind followed by tab is a regular prompt and cannot bypass withdrawal", async () => {
  const store = {
    async listSessionInputs() {
      return [
        {
          kind: "sendText",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "first-input" } },
        },
        {
          kind: "sendText",
          payload: {
            text: "/rewind\tstatus",
            intent: { clientId: "anyagent-m1-host", sourceCommandId: "tab-input" },
          },
        },
      ];
    },
    async sessionEntries(input: { type: string }) {
      if (input.type === "runtime/native_turn_started") return [];
      return [
        { data: { inputId: "first-input", resultType: "success", turnId: "first-turn" } },
        { data: { inputId: "tab-input", resultType: "cancelled", turnId: "tab-turn" } },
      ];
    },
    async messages() {
      return [
        {
          info: { id: "tab-user", role: "user", anchor: { turnId: "tab-turn" } },
          parts: [{ type: "text", text: "/rewind\tstatus" }],
        },
      ];
    },
  };
  await assert.rejects(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
    /lacks provider withdrawal/,
  );
});

test("old M1 background notification Stop without start or marker blocks cold resume", async () => {
  const store = {
    async listSessionInputs() {
      return [
        {
          kind: "sendText",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "first-input" } },
        },
      ];
    },
    async sessionEntries(input: { type: string }) {
      if (input.type === "runtime/native_turn_started") return [];
      return [
        { data: { inputId: "first-input", resultType: "success", turnId: "first-turn" } },
        {
          data: {
            inputId: "background-notification-input",
            resultType: "cancelled",
            turnId: "notification-turn",
          },
        },
      ];
    },
    async messages() {
      return [
        {
          info: {
            id: "background-notice",
            role: "user",
            source: "background_task",
            anchor: { turnId: "earlier-tool-turn" },
          },
          parts: [{ type: "text", text: "BACKGROUND_NOTIFICATION_SECRET" }],
        },
        {
          info: { id: "partial", role: "assistant", anchor: { turnId: "notification-turn" } },
          parts: [{ type: "text", text: "partial notification answer" }],
        },
      ];
    },
  };
  await assert.rejects(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
    /lacks provider withdrawal/,
  );
});

test("M1 pre-recorded notification without terminal blocks cold resume after failed Stop persistence", async () => {
  const store = {
    async listSessionInputs() {
      return [
        {
          kind: "sendText",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "source-input" } },
        },
      ];
    },
    async sessionEntries(input: { type: string }) {
      if (input.type === "runtime/native_turn_started") {
        return [{ data: { turnId: "notification-turn", messageId: "notification-message" } }];
      }
      return [{ data: { inputId: "source-input", resultType: "success", turnId: "source-turn" } }];
    },
  };
  await assert.rejects(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
    /Native turn result is unresolved/,
  );
});

test("completed M1 background notification resumes with its independent native input ID", async () => {
  const store = {
    async listSessionInputs() {
      return [
        {
          kind: "sendText",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "source-input" } },
        },
      ];
    },
    async sessionEntries(input: { type: string }) {
      if (input.type === "runtime/native_turn_started") {
        return [{ data: { turnId: "notification-turn", messageId: "notification-message" } }];
      }
      return [
        { data: { inputId: "source-input", resultType: "success", turnId: "source-turn" } },
        {
          data: {
            inputId: "independent-notification-uuid",
            resultType: "success",
            turnId: "notification-turn",
          },
        },
      ];
    },
  };
  await assert.doesNotReject(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
  );
});

test("same input ID across goal continuations still needs each native turn terminal", async () => {
  let secondTerminal = false;
  const store = {
    async listSessionInputs() {
      return [
        {
          kind: "sendGoalCommand",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "goal-input" } },
        },
      ];
    },
    async sessionEntries(input: { type: string }) {
      if (input.type === "runtime/native_turn_started") {
        return [
          { data: { turnId: "goal-turn-one", inputId: "goal-input" } },
          { data: { turnId: "goal-turn-two", inputId: "goal-input" } },
        ];
      }
      return [
        { data: { inputId: "goal-input", resultType: "success", turnId: "goal-turn-one" } },
        ...(secondTerminal
          ? [{ data: { inputId: "goal-input", resultType: "success", turnId: "goal-turn-two" } }]
          : []),
      ];
    },
  };
  await assert.rejects(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
    /Native turn result is unresolved/,
  );
  secondTerminal = true;
  await assert.doesNotReject(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
  );
});

test("M1 cancelled notification terminal needs marker for its executing turn", async () => {
  let marked = false;
  const store = {
    async listSessionInputs() {
      return [
        {
          kind: "sendText",
          payload: { intent: { clientId: "anyagent-m1-host", sourceCommandId: "source-input" } },
        },
      ];
    },
    async sessionEntries(input: { type: string }) {
      if (input.type === "runtime/native_turn_started") {
        return [{ data: { turnId: "notification-turn", messageId: "notification-message" } }];
      }
      return [
        { data: { inputId: "source-input", resultType: "success", turnId: "source-turn" } },
        {
          data: {
            inputId: "notification-input",
            resultType: "cancelled",
            turnId: "notification-turn",
          },
        },
      ];
    },
    async messages() {
      return [
        {
          info: {
            id: "notification-message",
            role: "user",
            anchor: { turnId: "older-turn" },
            metadata: marked
              ? {
                  providerHistoryDisposition: STOPPED_TURN_PROVIDER_DISPOSITION,
                  providerWithdrawalTurnId: "notification-turn",
                }
              : {},
          },
          parts: [],
        },
      ];
    },
  };
  await assert.rejects(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
    /lacks provider withdrawal/,
  );
  marked = true;
  await assert.doesNotReject(
    assertNoUnresolvedAnyAgentInputs(store as never, "test-session" as never),
  );
});

test("pre-recorded notification Stop uses executing turn identity in live and cold history", async () => {
  const history = new MessageHistoryImpl();
  history.addUser("BACKGROUND_NOTIFICATION_SECRET", {
    source: "real_user",
    nativeMessageId: "pre-recorded-user",
  });
  tagPreRecordedTurnInput(history, "pre-recorded-user", "notification-turn");
  history.addAssistant("partial notification answer");
  let saved: Record<string, unknown> | undefined;
  await confirmStoppedTurnWithdrawal({
    history,
    sessionId: "test-session" as never,
    turnId: "notification-turn",
    userMessageId: "pre-recorded-user" as never,
    allowPreRecordedMessage: true,
    sessionStore: {
      async messageWithParts() {
        return {
          info: {
            id: "pre-recorded-user",
            role: "user",
            anchor: { turnId: "original-queue-turn" },
          },
          parts: [],
        };
      },
      async messages() {
        return [];
      },
      async saveMessage(value: Record<string, unknown>) {
        saved = value;
      },
    } as never,
    holdQueue() {
      assert.fail("pre-recorded withdrawal should succeed");
    },
  });
  assert.equal(
    JSON.stringify(history.toRuntimeEntries()).includes("BACKGROUND_NOTIFICATION_SECRET"),
    false,
  );
  assert.equal(
    (saved as { metadata?: Record<string, unknown> }).metadata?.providerWithdrawalTurnId,
    "notification-turn",
  );
  const cold = new MessageHistoryImpl();
  await hydrateMessageHistoryFromSession({
    history: cold,
    messages: [
      {
        info: saved,
        parts: [{ id: "notice-part", type: "text", text: "BACKGROUND_NOTIFICATION_SECRET" }],
      },
      {
        info: { id: "partial", role: "assistant", anchor: { turnId: "notification-turn" } },
        parts: [{ id: "partial-part", type: "text", text: "partial notification answer" }],
      },
      {
        info: { id: "old", role: "user", anchor: { turnId: "original-queue-turn" } },
        parts: [{ id: "old-part", type: "text", text: "OLD_VALID_CONTENT" }],
      },
    ] as never,
  });
  const providerText = JSON.stringify(cold.toRuntimeEntries());
  assert.equal(providerText.includes("BACKGROUND_NOTIFICATION_SECRET"), false);
  assert.equal(providerText.includes("partial notification answer"), false);
  assert.equal(providerText.includes("OLD_VALID_CONTENT"), true);
});

test("model-only native turn can be withdrawn after user Stop", async () => {
  const history = new MessageHistoryImpl();
  history.addUser("GOAL_INTERNAL_SOURCE_INSTRUCTION", {
    source: "target_continuation",
    turnId: "goal-turn",
  });
  let saved: Record<string, unknown> | undefined;
  await confirmStoppedTurnWithdrawal({
    history,
    sessionId: "test-session" as never,
    turnId: "goal-turn",
    userMessageId: "goal-user" as never,
    sessionStore: {
      async messageWithParts() {
        return {
          info: {
            id: "goal-user",
            role: "user",
            anchor: { turnId: "goal-turn" },
            source: "goal-continuation",
          },
          parts: [],
        };
      },
      async messages() {
        return [];
      },
      async saveMessage(value: Record<string, unknown>) {
        saved = value;
      },
    } as never,
    holdQueue() {
      assert.fail("model-only withdrawal should succeed");
    },
  });
  assert.equal(
    JSON.stringify(history.toRuntimeEntries()).includes("GOAL_INTERNAL_SOURCE_INSTRUCTION"),
    false,
  );
  assert.equal(
    (saved as { metadata: Record<string, unknown> } | undefined)?.metadata
      ?.providerHistoryDisposition,
    STOPPED_TURN_PROVIDER_DISPOSITION,
  );
});
