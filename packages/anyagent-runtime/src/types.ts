import type {
  CapabilityStatus,
  EngineCapability,
  EngineApprovalOption,
  EngineApprovalPresentation,
  EngineUserInputAnswer,
  EngineEvent,
  EngineEvidence,
  EngineJsonObject,
  EngineUserInputPresentation,
} from "@anyagent/engine-contract";
import type {
  SubmitInput,
  RuntimeAttachmentStageRequest,
  RuntimeCompactOperation,
  RuntimeFileRewindOperation,
  SetAssistantFeedback,
  RuntimeAssistantFeedbackResult,
} from "./runtime-operation-types.js";

export type {
  CompactSession,
  RuntimeAttachmentStageRequest,
  RuntimeCompactOperation,
  RuntimeFileRewindOperation,
  ExecutionFileTarget,
  ApplyFileRewind,
  RuntimeExecutionFileChanges,
  RuntimeFileRewindPreview,
  SetAssistantFeedback,
  RuntimeAssistantFeedbackResult,
  ReconcileExecution,
  TaskLifecycleRequest,
  SubmitInput,
} from "./runtime-operation-types.js";

export type RuntimeSubmissionConfig = EngineJsonObject;

/** Safe input metadata plus an opaque ID minted by a Host attachment staging path. */
export interface RuntimeAttachmentReference {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** Renderer-selected source passed directly to the Host stager and never persisted. */
export interface StageRuntimeAttachmentInput {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly localPath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface RuntimeAttachmentStageResult {
  readonly locator: string;
  readonly sizeBytes: number;
}

export type RuntimeAttachmentStager = (
  request: RuntimeAttachmentStageRequest,
) => Promise<RuntimeAttachmentStageResult | undefined>;

export type RuntimeIdKind =
  | "task"
  | "fork"
  | "revision"
  | "participant"
  | "session"
  | "authorization"
  | "input"
  | "attachment"
  | "compact"
  | "file-rewind"
  | "execution"
  | "event"
  | "approval"
  | "user-input"
  | "stop"
  | "issue";
export type RuntimeTaskStatus =
  | "active"
  | "frozen"
  | "completed"
  | "failed"
  | "stopped"
  | "abandoned";
export type RuntimeSessionStatus = "creating" | "active" | "unknown" | "failed" | "closed";
export type RuntimeInputStatus =
  | "queued"
  | "received"
  | "native-accepted"
  | "started"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown"
  | "rejected"
  | "cancelled";
export type RuntimeExecutionStatus =
  | "accepted"
  | "started"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";
export type RuntimeAuthorizationScope =
  | "session.create"
  | "session.fork"
  | "session.compact"
  | "execution.run"
  | "execution.revise"
  | "assistant.feedback"
  | "workspace.file-rewind"
  | "approval.respond"
  | "user-input.respond"
  | "execution.interrupt"
  | "session.close"
  | "task.freeze"
  | "task.close";

export interface RuntimeEnvironment {
  readonly id: string;
  readonly kind: "workspace" | "remote" | "unknown";
  readonly label?: string;
  readonly workDirectory?: string;
  readonly provenance?: Readonly<Record<string, string>>;
}

/** A display-only, secret-free snapshot of where the Host obtained credentials. */
export interface RuntimeCredentialSource {
  readonly kind: "host" | "engine" | "none" | "unknown";
  readonly label?: string;
  readonly provenance?: Readonly<Record<string, string>>;
}

/** Authorization is a Host-issued grant reference and contains no credential material. */
export interface RuntimeAuthorization {
  readonly id: string;
  readonly environmentId: string;
  readonly scopes: readonly RuntimeAuthorizationScope[];
  readonly expiresAt: number | null;
  readonly issuer: "host";
}

export interface RuntimeEngineProjection {
  readonly engineId: string;
  readonly adapterVersion: string;
  readonly engineVersion: string | null;
  readonly configurationVersion: string | null;
  readonly environment: string | null;
  readonly capabilities: Readonly<Record<EngineCapability, CapabilityStatus>>;
}

/** Latest in-memory observation; never persisted over a Task's historical snapshot. */
export interface RuntimeCurrentEngineProjection {
  readonly engineId: string;
  readonly adapterVersion: string | null;
  readonly engineVersion: string | null;
  readonly configurationVersion: string | null;
  readonly environment: string | null;
  readonly capabilities: Readonly<Record<EngineCapability, CapabilityStatus>>;
  readonly state: "current" | "unknown";
  readonly observedAt: number | null;
  readonly source: "active-probe" | "unknown";
}

export interface RuntimeParticipant {
  readonly id: string;
  readonly status: "active" | "closed";
  readonly createdAt: number;
}

export interface RuntimeSession {
  readonly id: string;
  /** Native handle for diagnostics and hiding a duplicate adapter-owned sidebar row. */
  readonly nativeSessionId?: string | null;
  readonly status: RuntimeSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly environmentId: string;
}

export interface RuntimeTask {
  readonly id: string;
  /** Opaque Host grant identifier; it contains no credential material. */
  readonly authorizationId: string;
  readonly status: RuntimeTaskStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
  readonly closeReason: string | null;
  /** Read-only source link; inherited rows keep their original Task ownership. */
  readonly forkedFrom?: {
    readonly taskId: string;
    readonly inputId: string;
    readonly executionId: string;
  };
  /** Immutable Engine/configuration/capability evidence captured when this Task was created. */
  readonly engine: RuntimeEngineProjection;
  /** Latest Host probe for this Engine; unknown until the current Host has checked it. */
  readonly currentEngine: RuntimeCurrentEngineProjection;
  readonly environment: RuntimeEnvironment;
  readonly credentialSource: RuntimeCredentialSource;
  readonly participant: RuntimeParticipant;
  readonly session: RuntimeSession;
}

export interface RuntimeInput {
  readonly id: string;
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly text: string;
  /** A replacement turn preserves, rather than rewrites, the original product records. */
  readonly revisionOf?: {
    readonly kind: "edit" | "retry";
    readonly inputId: string;
    readonly executionId: string;
  };
  readonly submissionConfig?: RuntimeSubmissionConfig;
  readonly attachments?: readonly RuntimeAttachmentReference[];
  readonly status: RuntimeInputStatus;
  readonly receivedAt: number;
  readonly acceptedAt: number | null;
  readonly startedAt: number | null;
  readonly terminalAt: number | null;
  readonly error: string | null;
}

export interface RuntimeExecution {
  readonly id: string;
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly revisionOf?: RuntimeInput["revisionOf"];
  readonly status: RuntimeExecutionStatus;
  readonly acceptedAt: number;
  readonly startedAt: number | null;
  readonly terminalAt: number | null;
  readonly result: string | null;
  readonly error: string | null;
  /** Last native state query; unknown remains explicit until native evidence resolves it. */
  readonly reconciledAt?: number;
  readonly reconciliationEvidence?: EngineEvidence;
  readonly reconciliationReason?: string;
}

/** Event delivery history keeps original ownership and native provenance. */
export interface RuntimeEvent {
  readonly id: string;
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly inputId: string | null;
  readonly executionId: string | null;
  readonly nativeEventId: string;
  readonly streamId: string;
  readonly sourceSequence: number | null;
  readonly deliverySequence: number;
  readonly observedAt: number;
  readonly source: EngineEvent["source"];
  readonly type: EngineEvent["type"];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly duplicateOf: string | null;
}

export interface RuntimeApproval {
  readonly id: string;
  /** Product event that first requested this approval; absent for older records. */
  readonly requestEventId?: string;
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly operation: string;
  readonly scope: string | null;
  readonly options: readonly EngineApprovalOption[];
  readonly presentation?: EngineApprovalPresentation;
  readonly expiresAt: number | null;
  readonly status:
    | "pending"
    | "forwarded"
    | "expired"
    | "unknown"
    | "already-answered"
    | "unsupported"
    | "rejected";
  readonly repliedOptionId: string | null;
}

export interface RuntimeUserInput {
  readonly id: string;
  /** Product event that first requested this input; absent for older records. */
  readonly requestEventId?: string;
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly prompt: string;
  readonly inputKind: "text" | "choice" | "form";
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly presentation?: EngineUserInputPresentation;
  readonly expiresAt: number | null;
  readonly status:
    | "pending"
    | "forwarded"
    | "expired"
    | "unknown"
    | "already-answered"
    | "unsupported"
    | "rejected";
  readonly response: EngineUserInputAnswer | null;
}

type StopUnavailable = "unsupported" | "temporarily-unavailable" | "authorization-required";
type StopStatus = "requested" | StopUnavailable | "unknown" | "confirmed";

export interface RuntimeStopRequest {
  readonly id: string;
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly requestedAt: number;
  readonly status: StopStatus;
  /** Whether the native Engine confirmed delivery of this interrupt request. */
  readonly deliveryStatus: "pending" | "delivered" | "not-delivered" | "unknown" | "not-requested";
  readonly deliveryEvidence: EngineEvidence | null;
  /** Native evidence that the Execution stopped; a request ACK alone never fills this field. */
  readonly stopEvidence: EngineEvidence | null;
  readonly reason: string | null;
}

export interface RuntimeIntegrityIssue {
  readonly id: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly type:
    | "duplicate-event"
    | "event-conflict"
    | "sequence-gap"
    | "out-of-order-event"
    | "late-event"
    | "contradictory-terminal"
    | "unmatched-event"
    | "stream-ended-unknown"
    | "adapter-error";
  readonly occurredAt: number;
  readonly eventId: string | null;
  readonly detail: string;
}

export interface TaskHistory {
  readonly taskId: string;
  readonly inputs: readonly RuntimeInput[];
  readonly executions: readonly RuntimeExecution[];
  readonly events: readonly RuntimeEvent[];
  readonly approvals: readonly RuntimeApproval[];
  readonly userInputs: readonly RuntimeUserInput[];
  readonly stopRequests: readonly RuntimeStopRequest[];
  readonly compactOperations: readonly RuntimeCompactOperation[];
  readonly fileRewindOperations?: readonly RuntimeFileRewindOperation[];
  readonly integrityIssues: readonly RuntimeIntegrityIssue[];
}

export type RuntimeChangeKind =
  | "task"
  | "input"
  | "execution"
  | "event"
  | "approval"
  | "user-input"
  | "stop-request"
  | "compact-operation"
  | "file-rewind-operation"
  | "integrity-issue";
export interface RuntimeChange {
  readonly kind: RuntimeChangeKind;
  readonly taskId: string;
  readonly entityId: string;
  readonly occurredAt: number;
  readonly task: RuntimeTask | null;
  readonly history: TaskHistory | null;
}

export interface CreateTaskInput {
  readonly engineId: string;
  readonly environment: RuntimeEnvironment;
  readonly authorization: RuntimeAuthorization;
  readonly credentialSource?: RuntimeCredentialSource;
}

export interface ForkTaskInput {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly executionId: string;
  /** Fresh Host-issued grant for the child Task. */
  readonly authorization: RuntimeAuthorization;
}

export interface ReviseTurn {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly sourceExecutionId: string;
  readonly kind: "edit" | "retry";
  /** Required for edit; retry reuses the canonical original input. */
  readonly text?: string;
  /** Exact source attachments retained by an edit; omitted keeps all for older callers. */
  readonly retainedAttachmentIds?: readonly string[];
  /** Newly staged attachments to append to the retained source list. */
  readonly attachments?: readonly RuntimeAttachmentReference[];
}

export type StageAttachment = StageRuntimeAttachmentInput;

export interface ReplyToApproval {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly approvalId: string;
  readonly optionId: string;
  readonly feedback?: string;
}

export interface ReplyToUserInput {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly requestId: string;
  readonly response: EngineUserInputAnswer;
}

export interface RequestStop {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly executionId: string;
}
