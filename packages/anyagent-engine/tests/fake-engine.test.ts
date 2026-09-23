import assert from "node:assert/strict";
import test from "node:test";
import { EngineContractError, FakeEngine, type EngineEvent } from "../src/index.js";

test("fake streams accepted, started, public tool/file, and completed evidence in order", async () => {
  const fake = new FakeEngine();
  const session = await fake.createSession();
  const run = await fake.run({ session, input: "change the file" });
  const events = run.events[Symbol.asyncIterator]();
  const observed: EngineEvent[] = [];

  for (let i = 0; i < 8; i += 1) {
    const next = events.next();
    assert.equal(fake.advance(run.executionId), true);
    observed.push((await next).value!);
  }

  assert.deepEqual(
    observed.map((event) => event.type),
    [
      "input.accepted",
      "execution.started",
      "message.delta",
      "tool.started",
      "file.changed",
      "tool.completed",
      "message.delta",
      "execution.completed",
    ],
  );
  const accepted = observed[0];
  const started = observed[1];
  assert.equal(accepted?.type, "input.accepted");
  assert.equal(started?.type, "execution.started");
  if (accepted?.type !== "input.accepted" || started?.type !== "execution.started")
    assert.fail("expected start evidence");
  assert.equal(accepted.evidence.source, "engine");
  assert.equal(started.evidence.source, "engine");
  assert.equal(observed[4]?.type, "file.changed");
  assert.equal(observed[7]?.type, "execution.completed");
  assert.deepEqual(
    observed.map((event) => event.deliverySequence),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.ok(observed.every((event) => event.streamId === observed[0]?.streamId));
  assert.ok(observed.every((event) => event.observedAt === 0));

  fake.closeEventStream(run.executionId);
  assert.equal((await events.next()).done, true);
});

test("approval options are preserved, reject/expiry do not claim execution stopped", async () => {
  let now = 5;
  const fake = new FakeEngine({
    now: () => now,
    script: [
      { type: "input.accepted" },
      { type: "execution.started" },
      {
        type: "approval.requested",
        operation: "write-file",
        options: [
          { id: "allowOnce", label: "Allow once", decision: "approve" },
          { id: "deny", label: "Deny", decision: "reject" },
        ],
        expiresAt: 10,
      },
    ],
  });
  const session = await fake.createSession();
  const run = await fake.run({ session, input: "write a file" });
  const events = run.events[Symbol.asyncIterator]();

  for (let i = 0; i < 3; i += 1) {
    const next = events.next();
    assert.equal(fake.advance(run.executionId), true);
    await next;
  }
  const approvalRequest = await fake.lastApprovalRequest(run.executionId);
  assert.deepEqual(
    approvalRequest.options.map((option) => option.id),
    ["allowOnce", "deny"],
  );

  const rejectedEvent = events.next();
  assert.equal(
    (
      await fake.replyToApproval({
        session,
        approvalId: approvalRequest.approvalId,
        optionId: "not-an-option",
      })
    ).status,
    "unsupported",
  );
  const rejected = fake.replyToApproval({
    session,
    approvalId: approvalRequest.approvalId,
    optionId: "deny",
  });
  assert.equal((await rejected).status, "forwarded");
  const rejectionEvent = (await rejectedEvent).value!;
  assert.equal(rejectionEvent.type, "approval.response");
  assert.equal(rejectionEvent.decision, "reject");
  assert.notEqual(rejectionEvent.type, "execution.stopped");
  assert.equal(
    (
      await fake.replyToApproval({
        session,
        approvalId: approvalRequest.approvalId,
        optionId: "deny",
      })
    ).status,
    "already-answered",
  );

  fake.closeEventStream(run.executionId);

  const expiring = new FakeEngine({
    now: () => now,
    script: [
      {
        type: "approval.requested",
        operation: "run-command",
        options: [{ id: "allowOnce", label: "Allow once", decision: "approve" }],
        expiresAt: 10,
      },
    ],
  });
  const expirySession = await expiring.createSession();
  const expiryRun = await expiring.run({ session: expirySession, input: "run command" });
  const expiryEvents = expiryRun.events[Symbol.asyncIterator]();
  const requestNext = expiryEvents.next();
  assert.equal(expiring.advance(expiryRun.executionId), true);
  const requestEvent = (await requestNext).value!;
  assert.equal(requestEvent.type, "approval.requested");
  now = 10;
  assert.equal(
    (
      await expiring.replyToApproval({
        session: expirySession,
        approvalId: requestEvent.approvalId,
        optionId: "allowOnce",
      })
    ).status,
    "expired",
  );
  const expiredEvent = (await expiryEvents.next()).value!;
  assert.equal(expiredEvent.type, "approval.response");
  assert.equal(expiredEvent.status, "expired");
  assert.notEqual(expiredEvent.type, "execution.stopped");
  expiring.closeEventStream(expiryRun.executionId);
});

test("user input prompts are independent from approvals and are answered by request ID", async () => {
  const fake = new FakeEngine({
    script: [
      {
        type: "user-input.requested",
        prompt: "Which branch should I use?",
        inputKind: "choice",
        options: [
          { id: "main", label: "main" },
          { id: "release", label: "release" },
        ],
        expiresAt: null,
      },
    ],
  });
  const session = await fake.createSession();
  const run = await fake.run({ session, input: "prepare a release" });
  const events = run.events[Symbol.asyncIterator]();
  const requestNext = events.next();
  assert.equal(fake.advance(run.executionId), true);
  const request = (await requestNext).value!;
  assert.equal(request.type, "user-input.requested");
  assert.equal(
    (await fake.replyToUserInput({ session, requestId: request.requestId, response: "release" }))
      .status,
    "forwarded",
  );
  const response = (await events.next()).value!;
  assert.equal(response.type, "user-input.response");
  fake.closeEventStream(run.executionId);
});

test("interrupt request is separate from engine stop evidence", async () => {
  const fake = new FakeEngine({
    script: [{ type: "input.accepted" }, { type: "execution.started" }],
  });
  const session = await fake.createSession();
  const run = await fake.run({ session, input: "long task" });
  const events = run.events[Symbol.asyncIterator]();

  for (let i = 0; i < 2; i += 1) {
    const next = events.next();
    assert.equal(fake.advance(run.executionId), true);
    await next;
  }
  assert.equal(
    (await fake.interrupt({ session, executionId: run.executionId })).status,
    "requested",
  );
  const interruption = (await events.next()).value!;
  assert.equal(interruption.type, "execution.interruption-requested");
  assert.equal(interruption.status, "requested");

  const stoppedNext = events.next();
  assert.equal(fake.confirmStopped(run.executionId), true);
  const stopped = (await stoppedNext).value!;
  assert.equal(stopped.type, "execution.stopped");
  assert.equal(stopped.evidence.source, "engine");
  fake.closeEventStream(run.executionId);
});

test("disconnect is unknown; reconnect stream ID, duplicate IDs, and late source sequences remain injectable", async () => {
  const fake = new FakeEngine({
    script: [{ type: "input.accepted" }, { type: "execution.started" }],
  });
  const session = await fake.createSession();
  const run = await fake.run({ session, input: "remote task" });
  const events = run.events[Symbol.asyncIterator]();

  for (let i = 0; i < 2; i += 1) {
    const next = events.next();
    assert.equal(fake.advance(run.executionId), true);
    await next;
  }
  const oldStreamId = fake.currentStreamId(run.executionId);
  const disconnected = events.next();
  fake.disconnect(run.executionId, "transport closed");
  const connectionEvent = (await disconnected).value!;
  assert.equal(connectionEvent.type, "connection.disconnected");
  const unknown = (await events.next()).value!;
  assert.equal(unknown.type, "execution.unknown");

  fake.reconnect(run.executionId);
  assert.notEqual(fake.currentStreamId(run.executionId), oldStreamId);
  const lateNext = events.next();
  const late = fake.injectEvent(
    run.executionId,
    {
      type: "execution.completed",
      result: "completed while disconnected",
      evidence: { source: "engine", evidenceId: "late-completion" },
    },
    { sourceSequence: 2, eventId: "late-completion-event" },
  );
  assert.equal((await lateNext).value?.eventId, late.eventId);
  assert.equal(late.sourceSequence, 2);
  assert.notEqual(late.streamId, oldStreamId);

  const duplicateNext = events.next();
  const duplicate = fake.duplicateEvent(run.executionId, late.eventId);
  const duplicateDelivery = (await duplicateNext).value!;
  assert.equal(duplicateDelivery.eventId, late.eventId);
  assert.equal(duplicateDelivery.deliverySequence, duplicate.deliverySequence);
  assert.equal(duplicateDelivery.sourceSequence, late.sourceSequence);
  fake.closeEventStream(run.executionId);
});

test("capability support and current availability remain independent and refreshable", async () => {
  const fake = new FakeEngine();
  fake.setCapability("execution.run", {
    support: "supported",
    availability: "unknown",
    reason: "workspace combination not probed",
  });
  const initial = fake.getCapabilities();
  assert.equal(initial.engineId, "fake");
  assert.equal(initial.configurationVersion, "fake-config-1");
  assert.deepEqual(initial.capabilities["execution.run"], {
    support: "supported",
    availability: "unknown",
    reason: "workspace combination not probed",
  });

  fake.setCapability("execution.run", { support: "supported", availability: "available" });
  assert.equal(
    (await fake.refreshCapabilities()).capabilities["execution.run"]?.availability,
    "available",
  );

  const unverified = new FakeEngine({
    capabilities: {
      "execution.run": { support: "unknown", availability: "unknown", reason: "not probed" },
    },
  });
  const session = await unverified.createSession();
  await assert.rejects(
    unverified.run({ session, input: "must not dispatch yet" }),
    (error: unknown) =>
      error instanceof EngineContractError && error.failure.kind === "result-unknown",
  );
});

test("auto advance runs the script, waits for replies, and emits explicit stop evidence", async () => {
  const fake = new FakeEngine({
    autoAdvance: true,
    script: [
      { type: "input.accepted" },
      { type: "execution.started" },
      {
        type: "approval.requested",
        operation: "write-file",
        options: [{ id: "allowOnce", label: "Allow once", decision: "approve" }],
      },
      { type: "user-input.requested", prompt: "Which file?", inputKind: "text" },
      { type: "execution.completed", result: "finished" },
    ],
  });
  const session = await fake.createSession();
  const run = await fake.run({ session, input: "finish without a UI advance button" });
  const events = run.events[Symbol.asyncIterator]();
  const nextEvent = async () => {
    const item = await events.next();
    assert.equal(item.done, false);
    return item.value!;
  };

  assert.equal((await nextEvent()).type, "input.accepted");
  assert.equal((await nextEvent()).type, "execution.started");
  const approval = await nextEvent();
  assert.equal(approval.type, "approval.requested");
  assert.equal(fake.advance(run.executionId), false);
  const approvalResponse = events.next();
  assert.equal(
    (
      await fake.replyToApproval({
        session,
        approvalId: approval.approvalId,
        optionId: "allowOnce",
      })
    ).status,
    "forwarded",
  );
  assert.equal((await approvalResponse).value?.type, "approval.response");

  const question = await nextEvent();
  assert.equal(question.type, "user-input.requested");
  const userInputResponse = events.next();
  assert.equal(
    (
      await fake.replyToUserInput({
        session,
        requestId: question.requestId,
        response: "README.md",
      })
    ).status,
    "forwarded",
  );
  assert.equal((await userInputResponse).value?.type, "user-input.response");
  const completed = await nextEvent();
  assert.equal(completed.type, "execution.completed");
  fake.closeEventStream(run.executionId);

  const stoppable = new FakeEngine({
    autoAdvance: true,
    script: [{ type: "input.accepted" }, { type: "execution.started" }],
  });
  const stopSession = await stoppable.createSession();
  const stopRun = await stoppable.run({ session: stopSession, input: "stop me" });
  const stopEvents = stopRun.events[Symbol.asyncIterator]();
  assert.equal((await stopEvents.next()).value?.type, "input.accepted");
  assert.equal((await stopEvents.next()).value?.type, "execution.started");
  assert.equal(
    (await stoppable.interrupt({ session: stopSession, executionId: stopRun.executionId })).status,
    "requested",
  );
  assert.equal((await stopEvents.next()).value?.type, "execution.interruption-requested");
  const stopped = (await stopEvents.next()).value!;
  assert.equal(stopped.type, "execution.stopped");
  assert.equal(stopped.evidence.source, "engine");
  stoppable.closeEventStream(stopRun.executionId);
});
