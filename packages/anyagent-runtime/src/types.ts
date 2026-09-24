import type { CapabilityStatus, EngineCapability, EngineEvent } from "@anyagent/engine-contract";

export type RuntimeIdKind =
  | "task"
  | "participant"
  | "session"
  | "authorization"
  | "input"
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
  | "received"
  | "native-accepted"
  | "started"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown"
  | "rejected";
export type RuntimeExecutionStatus =
  | "accepted"
  | "started"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";
export type RuntimeAuthorizationScope =
  | "session.create"
  | "execution.run"
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
  readonly status: RuntimeExecutionStatus;
  readonly acceptedAt: number;
  readonly startedAt: number | null;
  readonly terminalAt: number | null;
  readonly result: string | null;
  readonly error: string | null;
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
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly operation: string;
  readonly scope: string | null;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly decision: "approve" | "reject" | "other";
  }[];
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
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly prompt: string;
  readonly inputKind: "text" | "choice" | "form";
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly expiresAt: number | null;
  readonly status:
    | "pending"
    | "forwarded"
    | "expired"
    | "unknown"
    | "already-answered"
    | "unsupported"
    | "rejected";
  readonly response: unknown;
}

export interface RuntimeStopRequest {
  readonly id: string;
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly requestedAt: number;
  readonly status:
    | "requested"
    | "unsupported"
    | "temporarily-unavailable"
    | "authorization-required"
    | "unknown"
    | "confirmed";
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

export interface SubmitInput {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly text: string;
}

export interface ReplyToApproval {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly approvalId: string;
  readonly optionId: string;
}

export interface ReplyToUserInput {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly requestId: string;
  readonly response: unknown;
}

export interface RequestStop {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly executionId: string;
}

export interface TaskLifecycleRequest {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
}
