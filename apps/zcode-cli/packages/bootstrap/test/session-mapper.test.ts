import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionEventType } from "@zcode/contracts";
import { shouldExposeSessionEventToProtocol } from "../src/zcode-protocol/session-mapper.js";

test("native text block boundaries reach the protocol stream", () => {
  const streaming = (kind: string, delta = "") =>
    ({
      type: SessionEventType.ModelStreaming,
      payload: { kind, delta, assistantMessageId: "native-message" },
    }) as Parameters<typeof shouldExposeSessionEventToProtocol>[0];
  assert.equal(shouldExposeSessionEventToProtocol(streaming("text_start")), true);
  assert.equal(shouldExposeSessionEventToProtocol(streaming("text_delta", "Hello")), true);
  assert.equal(shouldExposeSessionEventToProtocol(streaming("text_end")), true);
  assert.equal(shouldExposeSessionEventToProtocol(streaming("text_delta")), false);
});
