import type {
  EngineApprovalRef,
  EngineEventInput,
  EngineFailure,
  EngineUserInputRef,
} from "./types.js";
import type { ExecutionRecord, FakeEngineStep } from "./fake-engine-support.js";

function nextId(record: ExecutionRecord, prefix: string): string {
  record.idSequence += 1;
  return `fake-${prefix}-${record.idSequence}`;
}

function evidence(record: ExecutionRecord, detail: string) {
  record.evidenceSequence += 1;
  return {
    source: "engine" as const,
    evidenceId: `fake-evidence-${record.evidenceSequence}`,
    detail,
  };
}

export function createFakeStepPayload(
  record: ExecutionRecord,
  step: FakeEngineStep,
): EngineEventInput {
  switch (step.type) {
    case "input.accepted":
    case "execution.started":
      return { type: step.type, evidence: evidence(record, `fake engine ${step.type}`) };
    case "message.delta":
    case "tool.failed":
    case "file.changed":
      return step;
    case "tool.started":
      return {
        type: step.type,
        name: step.name,
        toolCallId: step.toolCallId ?? nextId(record, "tool"),
        ...(step.input === undefined ? {} : { input: step.input }),
      };
    case "tool.completed":
      return {
        type: step.type,
        toolCallId: step.toolCallId ?? "fake-tool-1",
        ...(step.result === undefined ? {} : { result: step.result }),
        sideEffects: step.sideEffects ?? "none",
      };
    case "approval.requested": {
      const approvalId = nextId(record, "approval") as EngineApprovalRef;
      const options = step.options ?? [
        { id: "allowOnce", label: "Allow once", decision: "approve" as const },
        { id: "deny", label: "Deny", decision: "reject" as const },
      ];
      const expiresAt = step.expiresAt ?? null;
      record.approvals.set(approvalId, { options, expiresAt, status: "pending" });
      return {
        type: step.type,
        approvalId,
        operation: step.operation,
        ...(step.scope === undefined ? {} : { scope: step.scope }),
        options,
        expiresAt,
      };
    }
    case "user-input.requested": {
      const requestId = nextId(record, "user-input") as EngineUserInputRef;
      const options = step.options ?? [];
      const expiresAt = step.expiresAt ?? null;
      record.userInputs.set(requestId, {
        inputKind: step.inputKind,
        options,
        expiresAt,
        status: "pending",
      });
      return {
        type: step.type,
        requestId,
        prompt: step.prompt,
        inputKind: step.inputKind,
        ...(step.options === undefined ? {} : { options }),
        expiresAt,
      };
    }
    case "execution.completed":
      record.terminal = true;
      return {
        type: step.type,
        ...(step.result === undefined ? {} : { result: step.result }),
        evidence: evidence(record, "fake engine completed execution"),
      };
    case "execution.failed":
      record.terminal = true;
      return {
        type: step.type,
        failure: {
          kind: "execution-failed",
          operation: "execution.run",
          message: step.message,
          sideEffects: "possible",
        } satisfies EngineFailure,
        evidence: evidence(record, "fake engine reported execution failure"),
      };
  }
}
