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
  | "session.fork"
  | "session.compact"
  | "session.close"
  | "execution.run"
  | "execution.revise"
  | "execution.interrupt"
  | "execution.reconcile"
  | "events.stream"
  | "events.tool"
  | "events.file"
  | "approval.respond"
  | "user-input.respond"
  | "assistant.feedback";

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
  | "session.fork"
  | "session.compact"
  | "session.close"
  | "execution.run"
  | "execution.revise"
  | "execution.interrupt"
  | "approval.respond"
  | "assistant.feedback";

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
  /** This option requires a non-empty user feedback string to be meaningful. */
  readonly requiresFeedback?: boolean;
  /** Engine-owned option semantics needed by a richer approval renderer. */
  readonly presentation?: EngineApprovalOptionPresentation;
}

/** JSON-only display details; command replies still use the Host-owned option ID. */
export interface EngineApprovalOptionPresentation {
  readonly kind: string;
  readonly description?: string;
  readonly response?: EngineJsonValue;
}

/** Generic preview metadata associated with the original approval request. */
export interface EngineApprovalPresentation {
  readonly toolCallId?: string;
  readonly input?: EngineJsonValue;
  readonly riskLevel?: "low" | "medium" | "high" | "critical";
  readonly origin?: EngineJsonValue;
}

export interface EngineUserInputOption {
  readonly id: string;
  readonly label: string;
}

export type EngineUserInputAnswer = string | EngineJsonObject;

/** A generic question form supplied by the Engine for a user-input request. */
export interface EngineUserInputQuestion {
  readonly question: string;
  readonly header: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
  }[];
  readonly multiSelect?: boolean;
}

/** Display-only, JSON-safe user-input structure; native Engine SDK types stay in its Adapter. */
export interface EngineUserInputPresentation {
  readonly questions: readonly EngineUserInputQuestion[];
  readonly origin?: EngineJsonValue;
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
      /** Source identities, when the Engine exposes them; absent identities stay unknown. */
      readonly messageId?: string;
      readonly blockId?: string;
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
      readonly name?: string;
      readonly input?: unknown;
      readonly result?: unknown;
      readonly sideEffects: SideEffectKnowledge;
    }
  | {
      readonly type: "tool.failed";
      readonly toolCallId: string;
      readonly name?: string;
      readonly input?: unknown;
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
      readonly presentation?: EngineApprovalPresentation;
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
      readonly presentation?: EngineUserInputPresentation;
      readonly expiresAt: number | null;
    }
  | {
      readonly type: "user-input.response";
      readonly requestId: EngineUserInputRef;
      readonly status:
        | "forwarded"
        | "expired"
        | "already-answered"
        | "unsupported"
        | "unknown"
        | "rejected";
      /** Native answer evidence, when the source includes the accepted response payload. */
      readonly response?: EngineJsonObject;
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

/** JSON-only adapter input configuration; each Adapter owns its supported keys and semantics. */
export type EngineJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly EngineJsonValue[]
  | { readonly [key: string]: EngineJsonValue };

export type EngineJsonObject = Readonly<Record<string, EngineJsonValue>>;

/** A Host-resolved attachment locator. Renderer supplied paths are never valid here. */
export interface EngineAttachment {
  /** Opaque Host-issued attachment identity used to retain the input association. */
  readonly id: string;
  /** Adapter-consumable locator resolved by the Host for this exact Task and Session. */
  readonly locator: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
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

export interface EngineAssistantFeedbackReceipt {
  readonly status: "updated" | "unchanged" | "unsupported" | "temporarily-unavailable" | "unknown";
  readonly evidence?: EngineEvidence;
  readonly reason?: string;
}

export interface EngineCompactReceipt {
  readonly status: "completed" | "skipped" | "failed" | "cancelled" | "unknown";
  readonly evidence?: EngineEvidence;
  readonly reason?: string;
}

export interface EngineAdapter {
  getCapabilities(): EngineCapabilitySnapshot;
  /** Recheck conditional availability when the adapter can actively probe it. */
  refreshCapabilities?(): Promise<EngineCapabilitySnapshot>;
  createSession(): Promise<EngineSessionRef>;
  /** Create a distinct native child Session from a proven source Execution. */
  forkSession?(input: {
    readonly session: EngineSessionRef;
    readonly sourceExecutionId: EngineExecutionRef;
    /** Host-persisted idempotency key; retries must reuse this value. */
    readonly commandId: string;
    /** Synchronous Host eligibility check immediately before native dispatch. */
    readonly beforeDispatch?: () => void;
  }): Promise<EngineSessionRef>;
  /** Compact the native Session without creating a product Input or Execution. */
  compactSession?(input: {
    readonly session: EngineSessionRef;
    /** Product-owned, persisted idempotency key; retries must reuse this value. */
    readonly commandId: string;
    /** Synchronous Host eligibility check immediately before native dispatch. */
    readonly beforeDispatch?: () => void;
    /** Command acceptance is evidence, never compaction completion. */
    readonly onAccepted?: (evidence: EngineEvidence) => void;
  }): Promise<EngineCompactReceipt>;
  run(input: {
    readonly session: EngineSessionRef;
    readonly input: string;
    readonly submissionConfig?: EngineJsonObject;
    readonly attachments?: readonly EngineAttachment[];
    /** Synchronous Host eligibility check immediately before native dispatch. */
    readonly beforeDispatch?: () => void;
    /** One product-owned replacement turn; the Adapter resolves its native target. */
    readonly revision?: {
      readonly kind: "edit" | "retry";
      readonly sourceExecutionId: EngineExecutionRef;
      readonly commandId: string;
    };
  }): Promise<EngineRun>;
  replyToApproval(input: {
    readonly session: EngineSessionRef;
    readonly approvalId: EngineApprovalRef;
    readonly optionId: string;
    readonly feedback?: string;
  }): Promise<EngineApprovalReceipt>;
  replyToUserInput(input: {
    readonly session: EngineSessionRef;
    readonly requestId: EngineUserInputRef;
    readonly response: EngineUserInputAnswer;
  }): Promise<EngineUserInputReceipt>;
  /** Set feedback on a source assistant message. Runtime must qualify its Execution first. */
  setAssistantFeedback?(input: {
    readonly session: EngineSessionRef;
    readonly executionId: EngineExecutionRef;
    readonly messageId: string;
    readonly feedback: "like" | "dislike" | null;
  }): Promise<EngineAssistantFeedbackReceipt>;
  interrupt(input: {
    readonly session: EngineSessionRef;
    readonly executionId: EngineExecutionRef;
  }): Promise<EngineCommandReceipt>;
  closeSession(input: { readonly session: EngineSessionRef }): Promise<EngineCommandReceipt>;
}

export type EngineEventInput = EngineEventPayload;
