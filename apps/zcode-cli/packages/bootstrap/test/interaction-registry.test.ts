import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { interactionBackgroundHandlers } from "../src/zcode-protocol-v4/commands/handlers/interaction-background.js";
import { V4CommandNoopError } from "../src/zcode-protocol-v4/v4-gateway.js";
import {
  V4InteractionRegistry,
  type V4InteractionAnswer,
} from "../src/zcode-protocol-v4/interaction-registry.js";
import type { V4CommandCoreHost } from "../src/zcode-protocol-v4/commands/types.js";

function resolveEnvelope(
  sessionId: string | null,
  interactionId: string,
  answer: V4InteractionAnswer,
): CommandEnvelope {
  return {
    type: "resolveInteraction",
    sessionId,
    payload: { interactionId, answer },
    commandId: `command-${interactionId}`,
    clientId: "anyagent-m1-host",
    issuedAt: Date.now(),
  };
}

function hostWith(registry: V4InteractionRegistry): V4CommandCoreHost {
  return { interactions: registry } as unknown as V4CommandCoreHost;
}

test("interaction registry reports delivery, late answer, and cross-session miss distinctly", () => {
  const registry = new V4InteractionRegistry();
  const delivered: V4InteractionAnswer[] = [];
  registry.register("request-1", (answer) => delivered.push(answer), {
    sessionId: "session-A",
    kind: "other",
  });

  assert.equal(registry.resolve("request-1", { optionId: "deny" }, "session-B"), "not-found");
  assert.deepEqual(delivered, []);
  assert.equal(registry.resolve("request-1", { optionId: "deny" }, "session-A"), "delivered");
  assert.deepEqual(delivered, [{ optionId: "deny" }]);
  assert.equal(
    registry.resolve("request-1", { optionId: "allowOnce" }, "session-A"),
    "already-resolved",
  );
  assert.equal(
    registry.resolve("request-1", { optionId: "allowOnce" }, "session-B"),
    "not-found",
  );
  assert.throws(
    () => registry.register("request-1", () => {}, { sessionId: "session-A", kind: "other" }),
    /cannot be registered again/,
  );
});

test("a retired interaction ID cannot bind a later execution", () => {
  const registry = new V4InteractionRegistry();
  const unregister = registry.register("reused-request", () => {}, {
    sessionId: "session-A",
    kind: "other",
  });
  unregister();

  assert.equal(
    registry.resolve("reused-request", { optionId: "deny" }, "session-A"),
    "not-found",
  );
  assert.throws(
    () => registry.register("reused-request", () => {}, { sessionId: "session-A", kind: "other" }),
    /cannot be registered again/,
  );
});

test("resolveInteraction ACK reports true delivery and rejects stale or cross-session answers", async () => {
  const registry = new V4InteractionRegistry();
  const delivered: V4InteractionAnswer[] = [];
  registry.register("request-2", (answer) => delivered.push(answer), {
    sessionId: "session-A",
    kind: "other",
  });
  const handler = interactionBackgroundHandlers.resolveInteraction;

  assert.deepEqual(
    await handler(
      hostWith(registry),
      resolveEnvelope("session-A", "request-2", { optionId: "deny" }),
    ),
    {
      type: "resolveInteraction",
      resolvedBy: { clientId: "anyagent-m1-host", optionId: "deny" },
    },
  );
  assert.deepEqual(delivered, [{ optionId: "deny" }]);

  await assert.rejects(
    handler(hostWith(registry), resolveEnvelope("session-A", "request-2", { optionId: "allow" })),
    (error: unknown) =>
      error instanceof V4CommandNoopError && error.reasonCode === "proto.alreadyResolved",
  );
  await assert.rejects(
    handler(hostWith(registry), resolveEnvelope("session-B", "request-2", { optionId: "allow" })),
    (error: unknown) =>
      error instanceof V4CommandNoopError && error.reasonCode === "proto.interactionNotFound",
  );
  assert.deepEqual(delivered, [{ optionId: "deny" }]);
});

test("a rejected approval is delivered as denial and never grants the protected operation", () => {
  const registry = new V4InteractionRegistry();
  let decision: "allow" | "deny" | undefined;
  let protectedOperationExecutions = 0;
  registry.register(
    "reject-request",
    (answer) => {
      decision = answer.optionId === "deny" ? "deny" : "allow";
      if (decision === "allow") protectedOperationExecutions += 1;
    },
    { sessionId: "session-A", kind: "other" },
  );

  assert.equal(registry.resolve("reject-request", { optionId: "deny" }, "session-A"), "delivered");
  assert.equal(decision, "deny");
  assert.equal(protectedOperationExecutions, 0);
});
