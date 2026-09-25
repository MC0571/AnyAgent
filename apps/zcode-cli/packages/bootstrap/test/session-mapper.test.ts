import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionEventType } from "@zcode/contracts";
import { zcodeSessionEventSchema } from "@zcode/shared";
import {
  mapSessionEventForProtocol,
  shouldExposeSessionEventToProtocol,
} from "../src/zcode-protocol/session-mapper.js";

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

test("native full-access hint cannot discard the legacy permission gate", () => {
  const event = {
    id: "approval-event",
    sessionId: "session-a",
    turnId: "turn-a",
    type: SessionEventType.PermissionRequested,
    timestamp: new Date(),
    traceId: "trace-a",
    sequenceNumber: 1,
    payload: {
      requestId: "approval-a",
      toolCallId: "tool-a",
      toolName: "Write",
      riskLevel: "medium",
      reason: "write a test file",
      input: { file_path: "test.txt" },
      fullAccessSupported: true,
    },
  } as Parameters<typeof mapSessionEventForProtocol>[0];
  const mapped = mapSessionEventForProtocol(event);
  assert.ok(mapped);
  const parsed = zcodeSessionEventSchema.parse(mapped);
  assert.equal(parsed.type, "permission.requested");
  assert.equal("fullAccessSupported" in parsed.payload, false);
  assert.ok(parsed.payload.options.length > 0);
});

test("resumed Goal status survives strict native session event validation", () => {
  const event = {
    id: "resume-goal-event",
    sessionId: "session-a",
    type: SessionEventType.SessionResumed,
    timestamp: new Date(),
    traceId: "trace-a",
    sequenceNumber: 2,
    payload: {
      directory: "/tmp/workspace",
      interruptedToolCount: 0,
      messageCount: 2,
      partCount: 2,
      resumedTarget: "complete",
    },
  } as Parameters<typeof mapSessionEventForProtocol>[0];
  const mapped = mapSessionEventForProtocol(event);
  assert.ok(mapped);
  const parsed = zcodeSessionEventSchema.parse(mapped);
  assert.equal(parsed.type, "session.resumed");
  assert.equal(parsed.payload.resumedTarget, "complete");
});
