import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConversationShareCodeInput } from "../src/lib/conversationShareCodeInput.js";

test("conversation share input accepts the code, share page, and M0 deep link forms", () => {
  assert.equal(parseConversationShareCodeInput("  share_123-~.  "), "share_123-~.");
  assert.equal(
    parseConversationShareCodeInput("https://zcode.z.ai/cn/share/share_123"),
    "share_123",
  );
  assert.equal(parseConversationShareCodeInput("zcode://share/import?code=share_123"), "share_123");
});

test("conversation share input rejects invalid paths and unsafe codes", () => {
  assert.equal(parseConversationShareCodeInput("https://example.com/not-a-share/share_123"), null);
  assert.equal(parseConversationShareCodeInput("https://zcode.z.ai/share/%2Fprivate"), null);
  assert.equal(parseConversationShareCodeInput("zcode://share/import?code=bad%20code"), null);
});
