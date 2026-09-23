export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export type CapabilityAvailability =
  | "available"
  | "temporarily-unavailable"
  | "authorization-required"
  | "unknown";

export interface CapabilityStatus {
  readonly support: CapabilitySupport;
  readonly availability: CapabilityAvailability;
  readonly reason?: string;
}

export type EngineCapability =
  | "session.create"
  | "session.close"
  | "execution.run"
  | "execution.interrupt"
  | "execution.reconcile"
  | "events.stream"
  | "events.tool"
  | "events.file"
  | "approval.respond"
  | "user-input.respond";

export interface EngineCapabilitySnapshot {
  /** Runtime adapter identifier; do not use as a persisted product identity. */
  readonly engineId: string;
  readonly adapterVersion: string;
  readonly engineVersion: string | null;
  readonly configurationVersion: string | null;
  readonly environment: string | null;
  readonly capabilities: Readonly<Record<EngineCapability, CapabilityStatus>>;
}

declare const sessionRefBrand: unique symbol;
declare const executionRefBrand: unique symbol;
declare const approvalRefBrand: unique symbol;
declare const userInputRefBrand: unique symbol;

/** Opaque adapter-owned handle for one live session; not a product session identity. */
export type EngineSessionRef = string & { readonly [sessionRefBrand]: true };

/** Opaque adapter-owned handle for one execution in the current process. */
export type EngineExecutionRef = string & { readonly [executionRefBrand]: true };

export type EngineApprovalRef = string & { readonly [approvalRefBrand]: true };

export type EngineUserInputRef = string & { readonly [userInputRefBrand]: true };

export type EvidenceSource = "engine" | "adapter" | "host";

export interface EngineEvidence {
  readonly source: EvidenceSource;
  readonly evidenceId: string;
  readonly detail?: string;
}

export type EngineOperation =
  | "session.create"
  | "session.close"
  | "execution.run"
  | "execution.interrupt"
  | "approval.respond";

export type EngineFailureKind =
  | "unsupported"
  | "temporarily-unavailable"
  | "authorization-required"
  | "execution-failed"
  | "result-unknown"
  | "protocol-error";

export type SideEffectKnowledge = "none" | "possible" | "known";

export interface EngineFailure {
  readonly kind: EngineFailureKind;
  readonly operation: EngineOperation;
  readonly message: string;
  readonly sideEffects: SideEffectKnowledge;
}

export class EngineContractError extends Error {
  readonly failure: EngineFailure;
  readonly kind: EngineFailureKind;

  constructor(failure: EngineFailure) {
    super(failure.message);
    this.name = "EngineContractError";
    this.failure = failure;
    this.kind = failure.kind;
  }
}

export interface EngineEventBase {
  readonly eventId: string;
  /** Changes when the adapter starts a new source stream generation. */
  readonly streamId: string;
  /** Native sequence when provided; null means the source has no usable cursor. */
  readonly sourceSequence: number | null;
  /** Monotonic only within this adapter event stream. */
  readonly deliverySequence: number;
  readonly observedAt: number;
  readonly source: EvidenceSource;
  readonly session: EngineSessionRef;
  /** Adapter-local handle; it is not a product Execution identity before acceptance. */
  readonly executionId: EngineExecutionRef;
}

export interface EngineApprovalOption {
  readonly id: string;
  readonly label: string;
  readonly decision: "approve" | "reject" | "other";
}

export interface EngineUserInputOption {
  readonly id: string;
  readonly label: string;
}

export type EngineEventPayload =
  | {
      readonly type: "input.accepted";
      readonly evidence: EngineEvidence;
    }
  | {
      readonly type: "execution.started";
      readonly evidence: EngineEvidence;
    }
  | {
      readonly type: "message.delta";
      readonly text: string;
    }
  | {
      readonly type: "tool.started";
      readonly toolCallId: string;
      readonly name: string;
      readonly input?: unknown;
    }
  | {
      readonly type: "tool.completed";
      readonly toolCallId: string;
      readonly result?: unknown;
      readonly sideEffects: SideEffectKnowledge;
    }
  | {
      readonly type: "tool.failed";
      readonly toolCallId: string;
      readonly failure: EngineFailure;
    }
  | {
      readonly type: "file.changed";
      readonly path: string;
      readonly operation: "created" | "modified" | "deleted";
      readonly diff?: string;
    }
  | {
      readonly type: "approval.requested";
      readonly approvalId: EngineApprovalRef;
      readonly operation: string;
      readonly scope?: string;
      readonly options: readonly EngineApprovalOption[];
      readonly expiresAt: number | null;
    }
  | {
      readonly type: "approval.response";
      readonly approvalId: EngineApprovalRef;
      readonly optionId: string;
      readonly decision: "approve" | "reject" | "other";
      readonly status:
        | "forwarded"
        | "expired"
        | "already-answered"
        | "unsupported"
        | "unknown"
        | "rejected";
      readonly evidence?: EngineEvidence;
    }
  | {
      readonly type: "user-input.requested";
      readonly requestId: EngineUserInputRef;
      readonly prompt: string;
      readonly inputKind: "text" | "choice" | "form";
      readonly options?: readonly EngineUserInputOption[];
      readonly expiresAt: number | null;
    }
  | {
      readonly type: "user-input.response";
      readonly requestId: EngineUserInputRef;
      readonly status: "forwarded" | "expired" | "already-answered" | "unsupported" | "unknown";
      readonly evidence?: EngineEvidence;
    }
  | {
      readonly type: "execution.interruption-requested";
      readonly status: "requested" | "unsupported" | "temporarily-unavailable" | "unknown";
      readonly evidence?: EngineEvidence;
    }
  | {
      readonly type: "execution.completed";
      readonly result?: string;
      readonly evidence: EngineEvidence;
    }
  | {
      readonly type: "execution.failed";
      readonly failure: EngineFailure;
      readonly evidence: EngineEvidence;
    }
  | {
      readonly type: "execution.stopped";
      /** Required: a request to interrupt alone is not stop confirmation. */
      readonly evidence: EngineEvidence;
    }
  | {
      readonly type: "execution.unknown";
      readonly reason: string;
    }
  | {
      readonly type: "connection.disconnected";
      readonly reason: string;
    };

export type EngineEvent = EngineEventPayload & EngineEventBase;

export interface EngineRun {
  /** Adapter-local control handle; not a product Execution identity before acceptance. */
  readonly executionId: EngineExecutionRef;
  readonly events: AsyncIterable<EngineEvent>;
}

export interface EngineCommandReceipt {
  readonly status:
    | "requested"
    | "closed"
    | "unsupported"
    | "temporarily-unavailable"
    | "authorization-required"
    | "unknown";
  readonly evidence?: EngineEvidence;
  readonly reason?: string;
}

export interface EngineApprovalReceipt {
  readonly status: "forwarded" | "expired" | "already-answered" | "unsupported" | "unknown";
  readonly evidence?: EngineEvidence;
}

export interface EngineUserInputReceipt {
  readonly status: "forwarded" | "expired" | "already-answered" | "unsupported" | "unknown";
  readonly evidence?: EngineEvidence;
}

export interface EngineAdapter {
  getCapabilities(): EngineCapabilitySnapshot;
  /** Recheck conditional availability when the adapter can actively probe it. */
  refreshCapabilities?(): Promise<EngineCapabilitySnapshot>;
  createSession(): Promise<EngineSessionRef>;
  run(input: { readonly session: EngineSessionRef; readonly input: string }): Promise<EngineRun>;
  replyToApproval(input: {
    readonly session: EngineSessionRef;
    readonly approvalId: EngineApprovalRef;
    readonly optionId: string;
  }): Promise<EngineApprovalReceipt>;
  replyToUserInput(input: {
    readonly session: EngineSessionRef;
    readonly requestId: EngineUserInputRef;
    readonly response: unknown;
  }): Promise<EngineUserInputReceipt>;
  interrupt(input: {
    readonly session: EngineSessionRef;
    readonly executionId: EngineExecutionRef;
  }): Promise<EngineCommandReceipt>;
  closeSession(input: { readonly session: EngineSessionRef }): Promise<EngineCommandReceipt>;
}

export type EngineEventInput = EngineEventPayload;
