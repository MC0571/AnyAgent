import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import {
  INTERRUPTED_TOOL_RESULT,
  STOPPED_TURN_PROVIDER_DISPOSITION,
  STOPPED_TURN_PROVIDER_TEXT,
  withdrawStoppedTurnFromLiveHistory,
} from "../src/agent/stopped-turn-history.js";

test("stopping a live turn withdraws its prompt and partial answer but keeps completed tool facts", () => {
  const history = new MessageHistoryImpl();
  history.addUser("earlier completed prompt");
  history.addAssistant("earlier completed answer");
  const startIndex = history.getMessageCount();
  history.addUser("SOURCE_SECRET_INSTRUCTION: write 120 lines");
  history.addAssistant("partial source answer", [
    { id: "tool-1", name: "Write", input: {} },
    { id: "tool-2", name: "Bash", input: {} },
  ]);
  history.addToolResult("tool-1", "Write", "file was written", true);

  withdrawStoppedTurnFromLiveHistory(history, startIndex);
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
      info: { id: "next-user", role: "user", anchor: { turnId: "next-turn" } },
      parts: [{ id: "next-part", type: "text", text: "NEXT_INPUT" }],
    },
  ];
  const history = new MessageHistoryImpl();
  await hydrateMessageHistoryFromSession({ history, messages: nativeMessages as never });
  const providerText = JSON.stringify(history.toRuntimeEntries());
  assert.equal(providerText.includes("SOURCE_SECRET_INSTRUCTION"), false);
  assert.equal(providerText.includes("partial source answer"), false);
  assert.equal(providerText.includes(STOPPED_TURN_PROVIDER_TEXT), true);
  assert.equal(providerText.includes("file was written"), true);
  assert.equal(providerText.includes(INTERRUPTED_TOOL_RESULT), true);
  assert.equal(providerText.includes("NEXT_INPUT"), true);
  assert.equal(nativeMessages[0]!.parts[0]!.text, "SOURCE_SECRET_INSTRUCTION");
});
