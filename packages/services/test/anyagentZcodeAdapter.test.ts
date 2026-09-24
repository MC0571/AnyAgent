import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineContractError } from "@anyagent/engine-contract";
import { zcodeSessionEventSchema } from "@zcode/shared";
import { createZCodeAdapter } from "../src/anyagent/zcodeAdapter.js";

type AgentPort = Parameters<typeof createZCodeAdapter>[0]["agent"];

function harness({
  earlyStart = false,
  delayedAck = false,
}: { earlyStart?: boolean; delayedAck?: boolean } = {}) {
  const listeners = new Set<(event: unknown) => void>();
  let lifecycleListener: ((event: unknown) => void) | undefined;
  let releaseSendText: (() => void) | undefined;
  let inputNumber = 0;
  const commands: Array<{ type: string; commandId: string; payload: unknown }> = [];
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
    sendConversationCommandV4: async ({
      envelope,
    }: {
      envelope: { type: string; commandId: string; payload: unknown };
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
      return { status: "accepted", commandId: envelope.commandId };
    },
  } as unknown as AgentPort;
  return {
    adapter: createZCodeAdapter({ agent, workspacePath: "/tmp/workspace" }),
    commands,
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

test("CLI loss before sendText ACK leaves the command outcome unknown", async () => {
  const fixture = harness({ delayedAck: true });
  const session = await fixture.adapter.createSession();
  const pending = fixture.adapter.run({ session, input: "work" });
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
  emit("read-scheduled", 2, "tool.updated", {
    kind: "scheduled",
    toolCallId: "read-call",
    toolName: "Read",
    input: { filePath: "README.md" },
  });
  emit("read-error", 3, "tool.updated", {
    kind: "error",
    toolCallId: "read-call",
    error: { message: "File does not exist" },
  });
  emit("bash-scheduled", 4, "tool.updated", {
    kind: "scheduled",
    toolCallId: "bash-call",
    toolName: "Bash",
    input: { command: "pwd" },
  });
  emit("bash-started", 5, "tool.updated", {
    kind: "started",
    toolCallId: "bash-call",
    startedAt: 5,
    readOnly: true,
    sideEffectScope: "none",
  });
  emit("bash-result", 6, "tool.updated", {
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
  assert.deepEqual(failed?.type === "tool.failed" && failed.input, { filePath: "README.md" });
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
      input: {},
      options: [
        { optionId: "allow", kind: "allowOnce", name: "Allow" },
        { optionId: "deny", kind: "deny", name: "Deny" },
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
