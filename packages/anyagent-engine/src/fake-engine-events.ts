import {
  EngineContractError,
  type CapabilityStatus,
  type EngineCapability,
  type EngineEvent,
  type EngineEventInput,
  type EngineExecutionRef,
  type EngineSessionRef,
  type EngineApprovalRef,
  type EngineUserInputRef,
} from "./types.js";
import type { EventOverrides, ExecutionRecord, PendingApproval } from "./fake-engine-support.js";

export function emitFakeEvent(
  record: ExecutionRecord,
  payload: EngineEventInput,
  overrides: EventOverrides,
  now: () => number,
  nextId: (prefix: string) => string,
): EngineEvent {
  if (record.closed) throw new Error("Event stream is closed.");
  record.deliverySequence += 1;
  const sourceSequence =
    overrides.sourceSequence === undefined ? ++record.sourceSequence : overrides.sourceSequence;
  if (sourceSequence !== null)
    record.sourceSequence = Math.max(record.sourceSequence, sourceSequence);
  const event: EngineEvent = {
    ...payload,
    eventId: overrides.eventId ?? nextId("event"),
    streamId: record.streamId,
    sourceSequence,
    deliverySequence: record.deliverySequence,
    observedAt: now(),
    source: overrides.source ?? "engine",
    session: record.session,
    executionId: record.executionId,
  } as EngineEvent;
  record.emitted.push(event);
  if (!record.events.push(event)) throw new Error("Event stream is closed.");
  return event;
}

export function fakeEvidence(record: ExecutionRecord, detail: string) {
  record.evidenceSequence += 1;
  return {
    source: "engine" as const,
    evidenceId: `fake-evidence-${record.evidenceSequence}`,
    detail,
  };
}

export function findFakeUserInput(
  executions: Iterable<ExecutionRecord>,
  session: EngineSessionRef,
  requestId: EngineUserInputRef,
): ExecutionRecord | undefined {
  return [...executions].find(
    (record) => record.session === session && record.userInputs.has(requestId),
  );
}

export function findFakeApproval(
  executions: Iterable<ExecutionRecord>,
  session: EngineSessionRef,
  approvalId: EngineApprovalRef,
): { record: ExecutionRecord; pending: PendingApproval } | undefined {
  const record = [...executions].find(
    (candidate) => candidate.session === session && candidate.approvals.has(approvalId),
  );
  const pending = record?.approvals.get(approvalId);
  return record && pending ? { record, pending } : undefined;
}

export function requireFakeCapability(
  capabilities: ReadonlyMap<EngineCapability, CapabilityStatus>,
  operation: "session.create" | "execution.run",
): void {
  const status = capabilities.get(operation)!;
  if (status.support === "supported" && status.availability === "available") return;
  const kind =
    status.support === "unsupported"
      ? "unsupported"
      : status.availability === "authorization-required"
        ? "authorization-required"
        : status.availability === "temporarily-unavailable"
          ? "temporarily-unavailable"
          : status.support === "unknown" || status.availability === "unknown"
            ? "result-unknown"
            : "temporarily-unavailable";
  throw new EngineContractError({
    kind,
    operation,
    message: status.reason ?? `Capability ${operation} is not currently available.`,
    sideEffects: "none",
  });
}

export function requireFakeExecution(
  executions: ReadonlyMap<EngineExecutionRef, ExecutionRecord>,
  executionId: EngineExecutionRef,
): ExecutionRecord {
  const record = executions.get(executionId);
  if (!record) throw new Error(`Unknown execution handle ${executionId}.`);
  return record;
}
