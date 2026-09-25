import type {
  EngineAssistantFeedbackReceipt,
  EngineEvidence,
  EngineFileChanges,
  EngineFileRewindPreview,
  EngineSessionRef,
} from "@anyagent/engine-contract";
import type {
  RuntimeAttachmentReference,
  RuntimeEnvironment,
  RuntimeSubmissionConfig,
  StageRuntimeAttachmentInput,
} from "./types.js";

/** Qualified Host staging call. The source path must not leave this Host callback. */
export interface RuntimeAttachmentStageRequest extends StageRuntimeAttachmentInput {
  readonly attachmentId: string;
  readonly environment: RuntimeEnvironment;
  readonly engineId: string;
  readonly nativeSessionId: EngineSessionRef;
}

export interface CompactSession {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  /** Optional native summary instructions; never recorded as a product Input. */
  readonly instructions?: string;
}

export interface TaskLifecycleRequest {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
}

export interface ReconcileExecution extends TaskLifecycleRequest {
  readonly executionId: string;
}

/** Reconcile a persisted Input whose dispatch receipt was lost before Execution acceptance. */
export interface ReconcileInput extends TaskLifecycleRequest {
  readonly inputId: string;
}

export interface SubmitInput {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly text: string;
  readonly delivery?: "startNow" | "queue";
  readonly idempotencyKey?: string;
  readonly submissionConfig?: RuntimeSubmissionConfig;
  readonly attachments?: readonly RuntimeAttachmentReference[];
}

export interface RuntimeCompactOperation {
  readonly id: string;
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly status:
    | "requested"
    | "accepted"
    | "completed"
    | "skipped"
    | "failed"
    | "cancelled"
    | "unknown";
  readonly requestedAt: number;
  readonly acceptedAt: number | null;
  readonly terminalAt: number | null;
  readonly requestedEvidence: EngineEvidence;
  readonly acceptedEvidence: EngineEvidence | null;
  readonly terminalEvidence: EngineEvidence | null;
  readonly failureEvidence: EngineEvidence | null;
  readonly unknownEvidence: EngineEvidence | null;
  readonly reason: string | null;
}

export interface ExecutionFileTarget {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly executionId: string;
}

export interface ApplyFileRewind extends ExecutionFileTarget {
  /** The preview displayed to the user; the Adapter compares it with a fresh native preview. */
  readonly expectedPreview: EngineFileRewindPreview;
}

export type RuntimeExecutionFileChanges = EngineFileChanges;
export type RuntimeFileRewindPreview = EngineFileRewindPreview;

export interface RuntimeFileRewindOperation extends Omit<ExecutionFileTarget, "authorizationId"> {
  readonly id: string;
  readonly status: "requested" | "applied" | "rejected" | "unknown";
  readonly requestedAt: number;
  readonly terminalAt: number | null;
  readonly evidence: EngineEvidence | null;
  readonly reason: string | null;
}

export interface SetAssistantFeedback {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  /** Product Execution that emitted the selected assistant message. */
  readonly executionId: string;
  /** Opaque Engine message identity preserved on this Execution's delta event. */
  readonly messageId: string;
  readonly feedback: "like" | "dislike" | null;
}

export type RuntimeAssistantFeedbackResult = EngineAssistantFeedbackReceipt;
