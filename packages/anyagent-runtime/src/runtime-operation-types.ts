import type { EngineEvidence, EngineSessionRef } from "@anyagent/engine-contract";
import type { RuntimeEnvironment, StageRuntimeAttachmentInput } from "./types.js";

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
