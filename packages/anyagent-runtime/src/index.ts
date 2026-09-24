/* oxlint-disable eslint(max-lines) -- This module is the single owner of Task qualification and the SQLite-backed evidence transition state machine. */
import { randomUUID } from "node:crypto";
import {
  EngineContractError,
  type EngineAdapter,
  type EngineAttachment,
  type EngineApprovalRef,
  type EngineCapability,
  type EngineCapabilitySnapshot,
  type EngineCommandReceipt,
  type EngineEvent,
  type EngineEvidence,
  type EngineExecutionRef,
  type EngineFileChanges,
  type EngineFileRewindPreview,
  type EngineJsonObject,
  type EngineJsonValue,
  type EngineSessionRef,
  type EngineUserInputRef,
} from "@anyagent/engine-contract";
import { RuntimeStore, type StoredRecord } from "./store.js";
import type {
  CompactSession,
  ApplyFileRewind,
  CreateTaskInput,
  AdoptImportedSessionInput,
  ExecutionFileTarget,
  ForkTaskInput,
  ReplyToApproval,
  ReplyToUserInput,
  ReconcileExecution,
  RequestStop,
  ReviseTurn,
  RuntimeApproval,
  RuntimeAuthorization,
  RuntimeAuthorizationScope,
  RuntimeChange,
  RuntimeCredentialSource,
  RuntimeCurrentEngineProjection,
  RuntimeEngineProjection,
  RuntimeEnvironment,
  RuntimeEvent,
  RuntimeFileRewindOperation,
  RuntimeAssistantFeedbackResult,
  RuntimeCompactOperation,
  RuntimeExecution,
  RuntimeIdKind,
  RuntimeInput,
  RuntimeIntegrityIssue,
  RuntimeParticipant,
  RuntimeSession,
  RuntimeStopRequest,
  RuntimeTask,
  RuntimeTaskStatus,
  RuntimeUserInput,
  SubmitInput,
  RuntimeAttachmentReference,
  RuntimeAttachmentStager,
  RuntimeAttachmentStageRequest,
  RuntimeAttachmentStageResult,
  StageRuntimeAttachmentInput,
  SetAssistantFeedback,
  TaskLifecycleRequest,
  TaskHistory,
} from "./types.js";

export * from "./types.js";

type EngineMap = ReadonlyMap<string, EngineAdapter>;

function engineStateKey(snapshot: EngineCapabilitySnapshot): string {
  return `${snapshot.engineId}\u0000${snapshot.environment ?? ""}`;
}

interface CurrentEngineRecord {
  readonly revision: number;
  /** Null until the current Adapter snapshot has been verified by this Host. */
  readonly snapshot: EngineCapabilitySnapshot | null;
  /** Last synchronous Adapter view, used to invalidate concurrent probes on drift. */
  readonly observedSnapshot: EngineCapabilitySnapshot;
  readonly projection: RuntimeCurrentEngineProjection;
}

export interface CreateTaskRuntimeOptions {
  readonly databasePath: string;
  readonly engines: EngineMap;
  readonly engineForEnvironment?: (
    engineId: string,
    environment: RuntimeEnvironment,
  ) => EngineAdapter | undefined;
  readonly now?: () => number;
  readonly idFactory?: (kind: RuntimeIdKind) => string;
  /** Stages user-selected files through a Host-owned path after Runtime qualification. */
  readonly stageAttachment?: RuntimeAttachmentStager;
}

interface TaskData {
  readonly engineId: string;
  readonly engine: RuntimeEngineProjection;
  readonly environment: RuntimeEnvironment;
  readonly credentialSource: RuntimeCredentialSource;
  readonly authorization: RuntimeAuthorization;
  readonly participantId: string;
  readonly sessionId: string;
  readonly forkedFrom?: RuntimeTask["forkedFrom"];
  readonly sharedContext?: RuntimeTask["sharedContext"];
  readonly nativeForkCommandId?: string;
  status: RuntimeTaskStatus;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  closeReason: string | null;
}

interface SessionData {
  projection: RuntimeSession;
  nativeSessionId: string | null;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type InputData = Mutable<RuntimeInput> & {
  readonly authorizationId: string;
  readonly idempotencyKey?: string;
  readonly requestedDelivery?: SubmitInput["delivery"];
  nativeExecutionId: string | null;
  nativeRevisionCommandId?: string;
};
interface AttachmentData {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly authorizationId: string;
  readonly environmentId: string;
  readonly engineId: string;
  readonly nativeSessionId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly expiresAt: number;
  inputId: string | null;
  status: "staged" | "claimed";
}
type ExecutionData = Mutable<RuntimeExecution> & { nativeExecutionId: string };
type ApprovalData = Mutable<RuntimeApproval> & { nativeApprovalId: string };
type UserInputData = Mutable<RuntimeUserInput> & { nativeRequestId: string };
type StopRequestData = Mutable<RuntimeStopRequest>;
type EventData = RuntimeEvent & { readonly canonicalPayload: string };

interface RunTarget {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly nativeSessionId: EngineSessionRef;
  readonly nativeExecutionId: EngineExecutionRef;
}

interface QualifiedTaskSessionReadTarget {
  readonly taskId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly engineId: string;
  readonly environment: RuntimeEnvironment;
  readonly nativeSessionId: EngineSessionRef;
}

const ACTIVE_INPUT_STATUSES = new Set([
  "queued",
  "received",
  "native-accepted",
  "started",
  "unknown",
]);
const DISPATCHED_INPUT_STATUSES = new Set(["received", "native-accepted", "started"]);
const ACTIVE_COMPACT_STATUSES = new Set(["requested", "accepted", "unknown"]);
const TERMINAL_EXECUTION_STATUSES = new Set(["completed", "failed", "stopped"]);
const MAX_SUBMISSION_CONFIG_BYTES = 16 * 1024;
const MAX_SUBMISSION_CONFIG_DEPTH = 8;
const MAX_SUBMISSION_CONFIG_NODES = 512;

interface SubmissionConfigBudget {
  nodes: number;
  readonly ancestors: Set<object>;
}

function cloneSubmissionConfigValue(
  value: unknown,
  budget: SubmissionConfigBudget,
  depth: number,
): EngineJsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_SUBMISSION_CONFIG_NODES || depth > MAX_SUBMISSION_CONFIG_DEPTH)
    throw new RuntimeEligibilityError("Submission configuration exceeds its structural limits.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 8_192)
      throw new RuntimeEligibilityError("Submission configuration string is too long.");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new RuntimeEligibilityError("Submission configuration numbers must be finite.");
    return value;
  }
  if (!value || typeof value !== "object")
    throw new RuntimeEligibilityError("Submission configuration must contain JSON values only.");
  if (budget.ancestors.has(value))
    throw new RuntimeEligibilityError("Submission configuration cannot contain cycles.");
  budget.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > 256 ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        throw new RuntimeEligibilityError("Submission configuration array is not JSON-compatible.");
      const items: EngineJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
          throw new RuntimeEligibilityError(
            "Submission configuration cannot contain sparse arrays.",
          );
        items.push(cloneSubmissionConfigValue(value[index], budget, depth + 1));
      }
      return Object.freeze(items);
    }
    const prototype = Object.getPrototypeOf(value);
    const keys = Object.keys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Reflect.ownKeys(value).length !== keys.length ||
      keys.length > 128
    )
      throw new RuntimeEligibilityError("Submission configuration object is not JSON-compatible.");
    const result: Record<string, EngineJsonValue> = {};
    for (const key of keys) {
      if (key.length > 256)
        throw new RuntimeEligibilityError("Submission configuration key is too long.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor))
        throw new RuntimeEligibilityError("Submission configuration cannot contain accessors.");
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneSubmissionConfigValue(descriptor.value, budget, depth + 1),
        writable: true,
      });
    }
    return Object.freeze(result);
  } finally {
    budget.ancestors.delete(value);
  }
}

function normalizeSubmissionConfig(value: unknown): EngineJsonObject | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RuntimeEligibilityError("Submission configuration must be a JSON object.");
  const normalized = cloneSubmissionConfigValue(value, { nodes: 0, ancestors: new Set() }, 0);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object")
    throw new RuntimeEligibilityError("Submission configuration must be a JSON object.");
  const encoded = JSON.stringify(normalized);
  if (new TextEncoder().encode(encoded).byteLength > MAX_SUBMISSION_CONFIG_BYTES)
    throw new RuntimeEligibilityError("Submission configuration exceeds 16 KiB.");
  return normalized as EngineJsonObject;
}

function normalizeAttachmentReferences(value: unknown): RuntimeAttachmentReference[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new RuntimeEligibilityError("Attachments must be an array of Host-issued references.");
  if (value.length > 8)
    throw new RuntimeEligibilityError("An input cannot contain more than 8 attachments.");

  const ids = new Set<string>();
  const attachments = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new RuntimeEligibilityError("Attachment reference must be an object.");
    const attachment = item as Record<string, unknown>;
    if (
      Object.keys(attachment).some(
        (key) => !["id", "fileName", "mimeType", "sizeBytes"].includes(key),
      )
    )
      throw new RuntimeEligibilityError("Attachment reference contains unsupported fields.");
    const id = typeof attachment.id === "string" ? attachment.id.trim() : "";
    const fileName = typeof attachment.fileName === "string" ? attachment.fileName.trim() : "";
    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    const sizeBytes = attachment.sizeBytes;
    if (!id || !fileName || !mimeType)
      throw new RuntimeEligibilityError(
        "Attachment reference requires an ID, name, and MIME type.",
      );
    if (ids.has(id)) throw new RuntimeEligibilityError("Attachment references must be unique.");
    if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0)
      throw new RuntimeEligibilityError("Attachment size must be a non-negative safe integer.");
    ids.add(id);
    return { id, fileName, mimeType, sizeBytes: sizeBytes as number };
  });
  return attachments.length ? attachments : undefined;
}

function normalizeStageAttachmentInput(
  value: StageRuntimeAttachmentInput,
): StageRuntimeAttachmentInput {
  if (!value || typeof value !== "object")
    throw new RuntimeEligibilityError("Attachment staging requires a selected local file.");
  const localPath = typeof value.localPath === "string" ? value.localPath.trim() : "";
  const fileName = typeof value.fileName === "string" ? value.fileName.trim() : "";
  const mimeType = typeof value.mimeType === "string" ? value.mimeType.trim() : "";
  if (
    !localPath ||
    localPath.length > 4_096 ||
    localPath.includes("\0") ||
    !fileName ||
    fileName.length > 255 ||
    /[\\/]|\p{Cc}/u.test(fileName) ||
    !mimeType ||
    mimeType.length > 255 ||
    /\p{Cc}/u.test(mimeType) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0
  ) {
    throw new RuntimeEligibilityError("Selected attachment metadata is invalid.");
  }
  return { ...value, localPath, fileName, mimeType, sizeBytes: value.sizeBytes };
}

function validateAttachmentStageResult(
  result: RuntimeAttachmentStageResult | undefined,
): RuntimeAttachmentStageResult {
  if (
    !result ||
    typeof result.locator !== "string" ||
    !result.locator.trim() ||
    !Number.isSafeInteger(result.sizeBytes) ||
    result.sizeBytes < 0
  )
    throw new RuntimeEligibilityError("The Host could not stage this attachment safely.");
  return { locator: result.locator, sizeBytes: result.sizeBytes };
}

export type RuntimeErrorKind =
  | "unsupported"
  | "temporarily-unavailable"
  | "authorization-required"
  | "result-unknown"
  | "invalid-request"
  | "ownership"
  | "terminal";

export class RuntimeEligibilityError extends Error {
  readonly kind: RuntimeErrorKind;

  constructor(message: string, kind: RuntimeErrorKind = "invalid-request") {
    super(message);
    this.name = "RuntimeEligibilityError";
    this.kind = kind;
  }
}

/**
 * Host-owned product Runtime. Adapter handles remain private; public projections
 * contain product IDs and JSON-safe history only.
 */
export class TaskRuntime {
  readonly #store: RuntimeStore;
  readonly #engines: EngineMap;
  readonly #engineForEnvironment: CreateTaskRuntimeOptions["engineForEnvironment"];
  readonly #stageAttachment: RuntimeAttachmentStager | undefined;
  readonly #attachmentLocators = new Map<string, string>();
  readonly #now: () => number;
  readonly #idFactory: (kind: RuntimeIdKind) => string;
  readonly #listeners = new Set<(change: RuntimeChange) => void>();
  readonly #runs = new Map<string, RunTarget>();
  readonly #queueDrainingSessions = new Set<string>();
  readonly #liveSessions = new Map<string, EngineSessionRef>();
  readonly #commandLocks = new Set<string>();
  readonly #assistantFeedbackInFlight = new Map<
    string,
    {
      readonly feedback: SetAssistantFeedback["feedback"];
      readonly promise: Promise<RuntimeAssistantFeedbackResult>;
    }
  >();
  readonly #capabilityRevisions = new Map<string, number>();
  readonly #currentEngines = new Map<string, CurrentEngineRecord>();
  #pendingChanges: { kind: RuntimeChange["kind"]; taskId: string; entityId: string }[] | null =
    null;
  #closed = false;

  constructor(options: CreateTaskRuntimeOptions) {
    this.#store = new RuntimeStore(options.databasePath);
    this.#engines = options.engines;
    this.#engineForEnvironment = options.engineForEnvironment;
    this.#stageAttachment = options.stageAttachment;
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? ((kind) => `${kind}_${randomUUID()}`);
    this.#markRecoveredStateUnknown();
  }

  listEngines(environment?: RuntimeEnvironment): RuntimeCurrentEngineProjection[] {
    this.#assertOpen();
    return [...this.#engines].map(([engineId, defaultEngine]) =>
      this.#clone(
        this.#currentEngineProjection(
          environment
            ? (this.#engineForEnvironment?.(engineId, environment) ?? defaultEngine)
            : defaultEngine,
        ),
      ),
    );
  }

  async refreshEngines(
    environment?: RuntimeEnvironment,
  ): Promise<RuntimeCurrentEngineProjection[]> {
    this.#assertOpen();
    await Promise.all(
      [...this.#engines].map(([engineId, defaultEngine]) =>
        this.#capabilities(
          environment
            ? (this.#engineForEnvironment?.(engineId, environment) ?? defaultEngine)
            : defaultEngine,
        ).catch(() => undefined),
      ),
    );
    return this.listEngines(environment);
  }

  listTasks(): RuntimeTask[] {
    this.#assertOpen();
    return this.#store.list<TaskData>("task").map((record) => this.#taskProjection(record));
  }

  getTask(taskId: string): RuntimeTask | null {
    this.#assertOpen();
    const record = this.#store.get<TaskData>("task", taskId);
    return record ? this.#taskProjection(record) : null;
  }

  /** Run a Host-owned read against the current native Session only while its Task grant is valid. */
  async readQualifiedTaskSession<T>(
    input: TaskLifecycleRequest,
    read: (target: QualifiedTaskSessionReadTarget) => Promise<T>,
  ): Promise<T> {
    const initial = await this.#qualifiedTaskSessionReadTarget(input);
    const result = await read(initial);
    const latest = await this.#qualifiedTaskSessionReadTarget(input);
    if (
      initial.taskId !== latest.taskId ||
      initial.participantId !== latest.participantId ||
      initial.sessionId !== latest.sessionId ||
      initial.engineId !== latest.engineId ||
      initial.environment.id !== latest.environment.id ||
      initial.environment.workDirectory !== latest.environment.workDirectory ||
      initial.nativeSessionId !== latest.nativeSessionId
    )
      throw new RuntimeEligibilityError(
        "The Task or native Session changed while reading Session-scoped data.",
        "ownership",
      );
    return result;
  }

  getHistory(taskId: string): TaskHistory | null {
    this.#assertOpen();
    if (!this.#store.get<TaskData>("task", taskId)) return null;
    return this.#history(taskId);
  }

  /** Reattach the same native Session for an explicitly selected, active Task. */
  restoreTaskSession(input: TaskLifecycleRequest): Promise<RuntimeTask> {
    this.#assertOpen();
    return this.#withCommandLock(`session.resume:${input.sessionId}`, async () => {
      const identity = this.#qualify(
        input.taskId,
        input.participantId,
        input.sessionId,
        input.authorizationId,
        "execution.run",
        false,
        true,
      );
      const { task, session } = identity;
      if (task.data.status !== "active")
        throw new RuntimeEligibilityError(
          `Task ${task.id} is ${task.data.status}; its Session cannot be resumed for new work.`,
          "terminal",
        );
      const nativeSessionId = session.data.nativeSessionId;
      if (!nativeSessionId)
        throw new RuntimeEligibilityError(
          "The saved Task has no verified native Session identity; creating a replacement would not be recovery.",
          "ownership",
        );
      if (
        session.data.projection.status === "active" &&
        this.#liveSessions.get(session.id) === nativeSessionId
      )
        return this.#requireTaskProjection(task.id);
      if (
        session.data.projection.status !== "unknown" &&
        session.data.projection.status !== "active"
      )
        throw new RuntimeEligibilityError(
          `Session ${session.id} is ${session.data.projection.status}; it cannot be resumed.`,
          "terminal",
        );
      this.#assertNoUnresolvedSessionWork(task.id, session.id);

      const engine = this.#engineFor(task.data);
      if (!engine.resumeSession)
        throw new RuntimeEligibilityError(
          "This Engine cannot reattach to an existing native Session.",
          "unsupported",
        );
      const snapshot = await this.#capabilities(engine);
      this.#assertCapability(
        snapshot,
        task.data.engineId,
        task.data.environment.id,
        "session.resume",
        task.data.engine.configurationVersion,
        task.data.engine.adapterVersion,
      );

      const beforeResume = () => {
        const latest = this.#qualify(
          input.taskId,
          input.participantId,
          input.sessionId,
          input.authorizationId,
          "execution.run",
          false,
          true,
        );
        if (
          latest.task.data.status !== "active" ||
          latest.session.data.nativeSessionId !== nativeSessionId ||
          (latest.session.data.projection.status !== "unknown" &&
            latest.session.data.projection.status !== "active")
        )
          throw new RuntimeEligibilityError(
            "Task or Session eligibility changed before native recovery.",
            "ownership",
          );
        this.#assertNoUnresolvedSessionWork(task.id, session.id);
        this.#assertCapability(
          this.#clone(engine.getCapabilities()),
          task.data.engineId,
          task.data.environment.id,
          "session.resume",
          task.data.engine.configurationVersion,
          task.data.engine.adapterVersion,
        );
      };
      beforeResume();
      const resumedNativeSession = await engine.resumeSession({
        session: nativeSessionId as EngineSessionRef,
        beforeDispatch: beforeResume,
      });
      if (resumedNativeSession !== nativeSessionId)
        throw new RuntimeEligibilityError(
          "Engine recovery returned a different native Session; the saved Task remains unattached.",
          "ownership",
        );

      const current = await this.#capabilities(engine);
      this.#assertCapability(
        current,
        task.data.engineId,
        task.data.environment.id,
        "session.resume",
        task.data.engine.configurationVersion,
        task.data.engine.adapterVersion,
      );
      const latest = this.#qualify(
        input.taskId,
        input.participantId,
        input.sessionId,
        input.authorizationId,
        "execution.run",
        false,
        true,
      );
      if (
        latest.task.data.status !== "active" ||
        latest.session.data.nativeSessionId !== nativeSessionId
      )
        throw new RuntimeEligibilityError(
          "Task or native Session ownership changed during recovery.",
          "ownership",
        );
      this.#assertNoUnresolvedSessionWork(task.id, session.id);
      this.#liveSessions.set(session.id, nativeSessionId as EngineSessionRef);
      const restoredAt = this.#now();
      session.data.projection = {
        ...session.data.projection,
        status: "active",
        updatedAt: restoredAt,
      };
      this.#save(
        "session",
        session.id,
        task.id,
        session.id,
        null,
        session.data,
        "active",
        session.createdAt,
        restoredAt,
      );
      this.#publish(task.id, "task", task.id);
      return this.#requireTaskProjection(task.id);
    });
  }

  /** Reconcile one persisted unknown Execution using its original ownership and native handle. */
  reconcileExecution(input: ReconcileExecution): Promise<RuntimeExecution> {
    this.#assertOpen();
    return this.#withCommandLock(`execution.reconcile:${input.executionId}`, async () => {
      const { task, session } = this.#qualify(
        input.taskId,
        input.participantId,
        input.sessionId,
        input.authorizationId,
        "execution.run",
        true,
        true,
      );
      const execution = this.#require<ExecutionData>("execution", input.executionId);
      if (
        execution.taskId !== task.id ||
        execution.sessionId !== session.id ||
        execution.data.participantId !== input.participantId ||
        execution.data.status !== "unknown"
      )
        throw new RuntimeEligibilityError(
          "Reconciliation requires an unknown Execution owned by this Task, participant, and Session.",
          "ownership",
        );
      const sourceInput = this.#require<InputData>("input", execution.data.inputId);
      if (
        sourceInput.taskId !== task.id ||
        sourceInput.sessionId !== session.id ||
        sourceInput.data.participantId !== input.participantId ||
        sourceInput.data.status !== "unknown" ||
        !execution.data.nativeExecutionId
      )
        throw new RuntimeEligibilityError(
          "The source Input or native Execution identity cannot be safely reconciled.",
          "ownership",
        );
      const nativeSessionId = session.data.nativeSessionId;
      if (!nativeSessionId)
        throw new RuntimeEligibilityError(
          "The native Session identity is unavailable.",
          "ownership",
        );

      const engine = this.#engineFor(task.data);
      if (!engine.reconcileExecution)
        throw new RuntimeEligibilityError(
          "This Engine does not provide native Execution reconciliation.",
          "unsupported",
        );
      const snapshot = await this.#capabilities(engine);
      this.#assertCapability(
        snapshot,
        task.data.engineId,
        task.data.environment.id,
        "execution.reconcile",
        task.data.engine.configurationVersion,
        task.data.engine.adapterVersion,
      );
      const beforeReconcile = () => {
        const latest = this.#qualify(
          input.taskId,
          input.participantId,
          input.sessionId,
          input.authorizationId,
          "execution.run",
          true,
          true,
        );
        const currentExecution = this.#require<ExecutionData>("execution", input.executionId);
        const currentInput = this.#require<InputData>("input", execution.data.inputId);
        if (
          latest.task.id !== execution.taskId ||
          latest.session.data.nativeSessionId !== nativeSessionId ||
          currentExecution.data.status !== "unknown" ||
          currentExecution.data.nativeExecutionId !== execution.data.nativeExecutionId ||
          currentInput.data.status !== "unknown"
        )
          throw new RuntimeEligibilityError(
            "Execution ownership or state changed before native reconciliation.",
            "ownership",
          );
        this.#assertCapability(
          this.#clone(engine.getCapabilities()),
          task.data.engineId,
          task.data.environment.id,
          "execution.reconcile",
          task.data.engine.configurationVersion,
          task.data.engine.adapterVersion,
        );
      };
      beforeReconcile();
      const result = await engine.reconcileExecution({
        session: nativeSessionId as EngineSessionRef,
        executionId: execution.data.nativeExecutionId as EngineExecutionRef,
        beforeDispatch: beforeReconcile,
      });
      if (result.status !== "unknown" && result.evidence.source !== "engine")
        throw new RuntimeEligibilityError(
          "Execution reconciliation did not include native Engine evidence.",
          "result-unknown",
        );

      const observedAt = this.#now();
      const executionData = this.#clone(execution.data);
      const inputData = this.#clone(sourceInput.data);
      executionData.reconciledAt = observedAt;
      if (result.status === "unknown") {
        executionData.reconciliationEvidence = result.evidence;
        executionData.reconciliationReason = result.reason;
        executionData.error = result.reason;
        inputData.error = result.reason;
      } else {
        executionData.reconciliationEvidence = result.evidence;
        if (result.status === "running") {
          const reason = "Native evidence confirms the Execution is still running.";
          executionData.reconciliationReason = reason;
          executionData.error = reason;
          inputData.error = reason;
        } else {
          executionData.reconciliationReason = undefined;
          inputData.error = null;
          executionData.status = result.status;
          executionData.terminalAt = observedAt;
          inputData.status = result.status;
          inputData.terminalAt = observedAt;
          if (result.status === "completed") {
            executionData.result = result.result;
            executionData.error = null;
          } else if (result.status === "failed") {
            executionData.result = null;
            executionData.error = result.error;
            inputData.error = result.error;
          } else {
            executionData.result = null;
            executionData.error = null;
          }
        }
      }

      this.#pendingChanges = [];
      try {
        this.#store.transaction(() => {
          this.#save(
            "execution",
            execution.id,
            task.id,
            session.id,
            sourceInput.id,
            executionData,
            executionData.status,
            execution.createdAt,
            observedAt,
            execution.nativeKey,
            execution.id,
          );
          this.#save(
            "input",
            sourceInput.id,
            task.id,
            session.id,
            sourceInput.id,
            inputData,
            inputData.status,
            sourceInput.createdAt,
            observedAt,
          );
          if (result.status === "stopped")
            this.#confirmStopRequests(task.id, execution.id, observedAt, result.evidence);
          else if (result.status === "completed" || result.status === "failed")
            this.#markStopRequestsUnconfirmed(
              task.id,
              execution.id,
              observedAt,
              `Execution was reconciled as ${result.status} before native stop confirmation.`,
            );
          this.#publish(task.id, "execution", execution.id);
          this.#publish(task.id, "input", sourceInput.id);
        });
      } catch (error) {
        this.#pendingChanges = null;
        throw error;
      }
      const changes = this.#pendingChanges;
      this.#pendingChanges = null;
      for (const change of changes ?? [])
        this.#dispatchChange(change.taskId, change.kind, change.entityId);
      if (result.status === "unknown")
        this.#addIssue(
          task.id,
          session.id,
          "stream-ended-unknown",
          null,
          `Native Execution reconciliation remains unknown: ${result.reason}`,
        );
      return this.#publicExecution(executionData);
    });
  }

  async createTask(input: CreateTaskInput): Promise<RuntimeTask> {
    return this.#createTask(input);
  }

  /** Attach a Host-verified import to a fresh product Task without creating another native Session. */
  async adoptImportedSession(input: AdoptImportedSessionInput): Promise<RuntimeTask> {
    this.#assertOpen();
    if (!input.nativeSessionId.trim())
      throw new RuntimeEligibilityError(
        "An imported native Session identity is required.",
        "ownership",
      );
    return this.#withCommandLock(`session.adopt:${input.nativeSessionId}`, async () => {
      if (this.listTasks().some((task) => task.session.nativeSessionId === input.nativeSessionId))
        throw new RuntimeEligibilityError(
          "The imported native Session already belongs to a Task.",
          "ownership",
        );
      return this.#createTask(input, {
        capability: "session.resume",
        sharedContext: input.sharedContext,
        createNativeSession: async (engine) => {
          if (!engine.resumeSession)
            throw new RuntimeEligibilityError(
              "This Engine cannot attach the imported Session.",
              "unsupported",
            );
          const nativeSession = await engine.resumeSession({
            session: input.nativeSessionId as EngineSessionRef,
          });
          if (nativeSession !== input.nativeSessionId)
            throw new RuntimeEligibilityError(
              "Import recovery changed the native Session identity.",
              "ownership",
            );
          if (this.listTasks().some((task) => task.session.nativeSessionId === nativeSession))
            throw new RuntimeEligibilityError(
              "The imported native Session was claimed by another Task.",
              "ownership",
            );
          return nativeSession;
        },
      });
    });
  }

  async forkTask(input: ForkTaskInput): Promise<RuntimeTask> {
    this.#assertOpen();
    const { task, session } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      "session.fork",
    );
    const execution = this.#require<ExecutionData>("execution", input.executionId);
    if (
      execution.taskId !== task.id ||
      execution.sessionId !== session.id ||
      execution.data.participantId !== input.participantId ||
      execution.data.status !== "completed"
    )
      throw new RuntimeEligibilityError("Fork requires a completed Execution owned by this Task.");
    const nativeSessionId = session.data.nativeSessionId;
    if (!nativeSessionId || this.#liveSessions.get(session.id) !== nativeSessionId)
      throw new RuntimeEligibilityError("The source native Session is not attached in this Host.");
    const sourceInput = this.#require<InputData>("input", execution.data.inputId);
    if (
      sourceInput.taskId !== task.id ||
      sourceInput.sessionId !== session.id ||
      sourceInput.data.participantId !== input.participantId ||
      !execution.data.nativeExecutionId ||
      input.authorization.id === task.data.authorization.id
    )
      throw new RuntimeEligibilityError("Fork source or child authorization is invalid.");
    const nativeExecutionId = execution.data.nativeExecutionId as EngineExecutionRef;
    const forkedFrom = {
      taskId: task.id,
      inputId: sourceInput.id,
      executionId: execution.id,
    };
    const nativeForkCommandId = this.#newId("fork");
    return this.#createTask(
      {
        engineId: task.data.engineId,
        environment: task.data.environment,
        authorization: input.authorization,
        credentialSource: task.data.credentialSource,
      },
      {
        capability: "session.fork",
        forkedFrom,
        nativeForkCommandId,
        createNativeSession: async (engine) => {
          this.#assertCapability(
            await this.#capabilities(engine),
            task.data.engineId,
            task.data.environment.id,
            "session.fork",
            task.data.engine.configurationVersion,
            task.data.engine.adapterVersion,
          );
          if (!engine.forkSession)
            throw new RuntimeEligibilityError(
              "This Engine has no native fork command.",
              "unsupported",
            );
          const beforeDispatch = this.#dispatchGuard({
            taskId: input.taskId,
            participantId: input.participantId,
            sessionId: input.sessionId,
            authorizationId: input.authorizationId,
            capability: "session.fork",
            engine,
            nativeSessionId: nativeSessionId as EngineSessionRef,
          });
          const checkSourceExecution = () => {
            beforeDispatch();
            const current = this.#require<ExecutionData>("execution", input.executionId);
            if (
              current.taskId !== task.id ||
              current.sessionId !== session.id ||
              current.data.participantId !== input.participantId ||
              current.data.status !== "completed" ||
              current.data.nativeExecutionId !== nativeExecutionId
            )
              throw new RuntimeEligibilityError(
                "The source Execution changed before fork.",
                "ownership",
              );
            this.#validateEnvironmentAndAuthorization(
              task.data.environment,
              input.authorization,
              "session.create",
            );
          };
          checkSourceExecution();
          return engine.forkSession({
            session: nativeSessionId as EngineSessionRef,
            sourceExecutionId: nativeExecutionId,
            commandId: nativeForkCommandId,
            beforeDispatch: checkSourceExecution,
          });
        },
      },
    );
  }

  async #createTask(
    input: CreateTaskInput,
    creation?: {
      readonly capability: "session.fork" | "session.resume";
      readonly forkedFrom?: NonNullable<RuntimeTask["forkedFrom"]>;
      readonly nativeForkCommandId?: string;
      readonly sharedContext?: RuntimeTask["sharedContext"];
      readonly createNativeSession: (engine: EngineAdapter) => Promise<EngineSessionRef>;
    },
  ): Promise<RuntimeTask> {
    this.#assertOpen();
    const engine =
      this.#engineForEnvironment?.(input.engineId, input.environment) ??
      this.#engines.get(input.engineId);
    if (!engine) throw new RuntimeEligibilityError(`Engine ${input.engineId} is not registered.`);
    this.#validateEnvironmentAndAuthorization(
      input.environment,
      input.authorization,
      "session.create",
    );
    const snapshot = await this.#capabilities(engine);
    this.#assertCapability(
      snapshot,
      input.engineId,
      input.environment.id,
      creation?.capability ?? "session.create",
    );

    const createdAt = this.#now();
    const taskId = this.#newId("task");
    const participantId = this.#newId("participant");
    const sessionId = this.#newId("session");
    const environment = this.#clone(input.environment);
    const authorization = this.#clone(input.authorization);
    const credentialSource = this.#clone(input.credentialSource ?? { kind: "unknown" as const });
    const engineProjection = this.#toEngineProjection(snapshot);
    const taskData: TaskData = {
      engineId: input.engineId,
      engine: engineProjection,
      environment,
      credentialSource,
      authorization,
      participantId,
      sessionId,
      ...(creation?.forkedFrom ? { forkedFrom: creation.forkedFrom } : {}),
      ...(creation?.nativeForkCommandId
        ? { nativeForkCommandId: creation.nativeForkCommandId }
        : {}),
      ...(creation?.sharedContext ? { sharedContext: this.#clone(creation.sharedContext) } : {}),
      status: "active",
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
      closeReason: null,
    };
    const participant: RuntimeParticipant = { id: participantId, status: "active", createdAt };
    const session: RuntimeSession = {
      id: sessionId,
      status: "creating",
      createdAt,
      updatedAt: createdAt,
      environmentId: environment.id,
    };
    this.#store.transaction(() => {
      this.#store.insert(
        this.#record("task", taskId, taskId, null, null, taskData, taskData.status, createdAt),
      );
      this.#store.insert(
        this.#record(
          "participant",
          participantId,
          taskId,
          null,
          null,
          participant,
          participant.status,
          createdAt,
        ),
      );
      this.#store.insert(
        this.#record(
          "session",
          sessionId,
          taskId,
          sessionId,
          null,
          {
            projection: session,
            nativeSessionId: null,
          } satisfies SessionData,
          session.status,
          createdAt,
        ),
      );
    });

    try {
      // Capabilities are rechecked immediately before the external side effect.
      const latest = await this.#capabilities(engine);
      this.#validateEnvironmentAndAuthorization(environment, authorization, "session.create");
      this.#assertCapability(
        latest,
        input.engineId,
        environment.id,
        creation?.capability ?? "session.create",
        snapshot.configurationVersion,
        snapshot.adapterVersion,
      );
      const nativeSessionId = await (creation?.createNativeSession(engine) ??
        engine.createSession());
      this.#liveSessions.set(sessionId, nativeSessionId);
      const activeSession: RuntimeSession = {
        ...session,
        status: "active",
        updatedAt: this.#now(),
      };
      this.#save(
        "session",
        sessionId,
        taskId,
        sessionId,
        null,
        {
          projection: activeSession,
          nativeSessionId,
        } satisfies SessionData,
        activeSession.status,
        createdAt,
        activeSession.updatedAt,
      );
      this.#publish(taskId, "task", taskId);
      return this.#requireTaskProjection(taskId);
    } catch (error) {
      const status =
        isKnownNoSideEffect(error) || error instanceof RuntimeEligibilityError
          ? "failed"
          : "unknown";
      const failedAt = this.#now();
      this.#save(
        "session",
        sessionId,
        taskId,
        sessionId,
        null,
        {
          projection: { ...session, status, updatedAt: failedAt },
          nativeSessionId: null,
        } satisfies SessionData,
        status,
        createdAt,
        failedAt,
      );
      taskData.status = status === "unknown" ? "frozen" : "failed";
      taskData.updatedAt = failedAt;
      taskData.closedAt = status === "unknown" ? null : failedAt;
      taskData.closeReason =
        status === "unknown" ? "Session creation result is unknown." : "Session creation failed.";
      this.#save(
        "task",
        taskId,
        taskId,
        null,
        null,
        taskData,
        taskData.status,
        createdAt,
        failedAt,
      );
      this.#addIssue(
        taskId,
        sessionId,
        "adapter-error",
        null,
        `Session creation ${status}: ${errorMessage(error)}`,
      );
      this.#publish(taskId, "task", taskId);
      throw error;
    }
  }

  async stageAttachment(input: StageRuntimeAttachmentInput): Promise<RuntimeAttachmentReference> {
    this.#assertOpen();
    const source = normalizeStageAttachmentInput(input);
    const { task, session } = this.#qualify(
      source.taskId,
      source.participantId,
      source.sessionId,
      source.authorizationId,
      "execution.run",
    );
    this.#requireActiveTask(task);
    if (session.data.projection.status !== "active")
      throw new RuntimeEligibilityError(
        `Session ${source.sessionId} is ${session.data.projection.status}; attachments cannot be staged.`,
      );
    if (!this.#stageAttachment)
      throw new RuntimeEligibilityError(
        "This Host does not provide a safe local attachment staging path.",
        "unsupported",
      );
    if (
      this.#store
        .list<InputData>("input", task.id)
        .some(
          (record) =>
            record.sessionId === session.id &&
            record.status !== null &&
            ACTIVE_INPUT_STATUSES.has(record.status),
        )
    )
      throw new RuntimeEligibilityError("Cannot stage an attachment while this Session is busy.");
    this.#assertNoActiveCompact(task.id, session.id);

    const engine = this.#engineFor(task.data);
    const snapshot = await this.#capabilities(engine);
    this.#assertCapability(
      snapshot,
      task.data.engineId,
      task.data.environment.id,
      "execution.run",
      task.data.engine.configurationVersion,
      task.data.engine.adapterVersion,
    );
    const nativeSessionId = session.data.nativeSessionId;
    if (!nativeSessionId)
      throw new RuntimeEligibilityError("The native Session handle is unavailable.");

    const id = this.#newId("attachment");
    const stageRequest: RuntimeAttachmentStageRequest = {
      ...source,
      attachmentId: id,
      environment: task.data.environment,
      engineId: task.data.engineId,
      nativeSessionId: nativeSessionId as EngineSessionRef,
    };
    const beforeDispatch = this.#dispatchGuard({
      taskId: source.taskId,
      participantId: source.participantId,
      sessionId: source.sessionId,
      authorizationId: source.authorizationId,
      capability: "execution.run",
      engine,
      nativeSessionId: nativeSessionId as EngineSessionRef,
    });
    beforeDispatch();
    if (
      this.#store
        .list<InputData>("input", task.id)
        .some(
          (record) =>
            record.sessionId === session.id &&
            record.status !== null &&
            ACTIVE_INPUT_STATUSES.has(record.status),
        )
    )
      throw new RuntimeEligibilityError("Cannot stage an attachment while this Session is busy.");
    this.#assertNoActiveCompact(task.id, session.id);
    const staged = validateAttachmentStageResult(await this.#stageAttachment(stageRequest));

    // The stager may take long enough for the Task to be frozen or the Session to change.
    const latest = this.#qualify(
      source.taskId,
      source.participantId,
      source.sessionId,
      source.authorizationId,
      "execution.run",
    );
    this.#requireActiveTask(latest.task);
    if (
      latest.session.data.projection.status !== "active" ||
      latest.session.data.nativeSessionId !== nativeSessionId
    )
      throw new RuntimeEligibilityError("The Task or native Session changed while staging.");

    const createdAt = this.#now();
    const reference: RuntimeAttachmentReference = {
      id,
      fileName: source.fileName,
      mimeType: source.mimeType,
      sizeBytes: staged.sizeBytes,
    };
    const data: AttachmentData = {
      taskId: task.id,
      participantId: source.participantId,
      sessionId: session.id,
      authorizationId: task.data.authorization.id,
      environmentId: task.data.environment.id,
      engineId: task.data.engineId,
      nativeSessionId: nativeSessionId as EngineSessionRef,
      fileName: reference.fileName,
      mimeType: reference.mimeType,
      sizeBytes: reference.sizeBytes,
      expiresAt: createdAt + 10 * 60 * 1_000,
      inputId: null,
      status: "staged",
    };
    this.#store.insert(
      this.#record("attachment", id, task.id, session.id, null, data, data.status, createdAt),
    );
    this.#attachmentLocators.set(id, staged.locator);
    return this.#clone(reference);
  }

  async submitInput(input: SubmitInput): Promise<RuntimeInput> {
    return this.#submitInput(input);
  }

  cancelQueuedInput(input: TaskLifecycleRequest & { readonly inputId: string }): RuntimeInput {
    this.#assertOpen();
    const task = this.#require<TaskData>("task", input.taskId);
    const participant = this.#store.get<RuntimeParticipant>("participant", task.data.participantId);
    const session = this.#store.get<SessionData>("session", task.data.sessionId);
    if (
      !participant ||
      !session ||
      task.data.participantId !== input.participantId ||
      task.data.sessionId !== input.sessionId ||
      participant.id !== input.participantId ||
      participant.taskId !== task.id ||
      session.id !== input.sessionId ||
      session.taskId !== task.id ||
      task.data.authorization.id !== input.authorizationId ||
      task.data.authorization.environmentId !== task.data.environment.id ||
      session.data.projection.environmentId !== task.data.environment.id
    )
      throw new RuntimeEligibilityError(
        "Task, participant, Session, and authorization ownership do not match.",
        "ownership",
      );
    const record = this.#require<InputData>("input", input.inputId);
    this.#assertRelated(
      record.data.taskId,
      record.data.participantId,
      record.data.sessionId,
      input,
    );
    if (record.taskId !== task.id || record.sessionId !== session.id)
      throw new RuntimeEligibilityError(
        "Queued Input belongs to a different Task or Session.",
        "ownership",
      );
    if (record.data.status !== "queued")
      throw new RuntimeEligibilityError(
        `Input ${input.inputId} is ${record.data.status}; only a queued Input can be cancelled.`,
        "terminal",
      );
    const cancelledAt = this.#now();
    record.data.status = "cancelled";
    record.data.error = "Cancelled before native dispatch.";
    record.data.terminalAt = cancelledAt;
    this.#save(
      "input",
      record.id,
      task.id,
      session.id,
      record.id,
      record.data,
      "cancelled",
      record.createdAt,
      cancelledAt,
    );
    this.#publish(task.id, "input", record.id);
    return this.#publicInput(record.data);
  }

  async reviseTurn(input: ReviseTurn): Promise<RuntimeInput> {
    this.#assertOpen();
    const { task, session } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      "execution.revise",
    );
    const sourceExecution = this.#require<ExecutionData>("execution", input.sourceExecutionId);
    if (
      sourceExecution.taskId !== task.id ||
      sourceExecution.sessionId !== session.id ||
      sourceExecution.data.participantId !== input.participantId ||
      (sourceExecution.data.status !== "completed" &&
        !(input.kind === "retry" && sourceExecution.data.status === "failed")) ||
      !sourceExecution.data.nativeExecutionId
    )
      throw new RuntimeEligibilityError(
        "Revision requires a completed Execution, or a failed Execution for retry, owned by this Task.",
      );
    if (
      input.kind === "retry" &&
      this.#store
        .listInSession<RuntimeEvent>("event", session.id)
        .some(
          (record) =>
            record.data.executionId === sourceExecution.id &&
            ["tool.started", "tool.completed", "tool.failed"].includes(record.data.type),
        )
    )
      throw new RuntimeEligibilityError(
        "Retry cannot safely replay an Execution that may have run tools.",
        "unsupported",
      );
    const sourceInput = this.#require<InputData>("input", sourceExecution.data.inputId);
    if (
      sourceInput.taskId !== task.id ||
      sourceInput.sessionId !== session.id ||
      sourceInput.data.participantId !== input.participantId
    )
      throw new RuntimeEligibilityError("Revision source Input ownership does not match.");
    const text = input.kind === "retry" ? sourceInput.data.text : input.text?.trim();
    if (!text) throw new RuntimeEligibilityError("Edited input text must not be empty.");
    if (
      input.kind === "retry" &&
      (input.retainedAttachmentIds !== undefined || input.attachments !== undefined)
    )
      throw new RuntimeEligibilityError("Retry cannot change source attachments.");
    const sourceAttachments = sourceInput.data.attachments ?? [];
    const retainedIds = input.retainedAttachmentIds;
    if (
      retainedIds !== undefined &&
      (!Array.isArray(retainedIds) || retainedIds.some((id) => typeof id !== "string"))
    )
      throw new RuntimeEligibilityError("Retained attachments must be source attachment IDs.");
    const retained =
      retainedIds === undefined
        ? sourceAttachments
        : sourceAttachments.filter((attachment) => retainedIds.includes(attachment.id));
    if (
      retainedIds &&
      (new Set(retainedIds).size !== retainedIds.length || retained.length !== retainedIds.length)
    )
      throw new RuntimeEligibilityError(
        "An edited attachment does not belong to the source Input.",
        "ownership",
      );
    const newAttachments = normalizeAttachmentReferences(input.attachments);
    if (retained.length + (newAttachments?.length ?? 0) > 8)
      throw new RuntimeEligibilityError("An input cannot contain more than 8 attachments.");
    return this.#submitInput(
      {
        taskId: input.taskId,
        participantId: input.participantId,
        sessionId: input.sessionId,
        authorizationId: input.authorizationId,
        text,
        ...(newAttachments?.length ? { attachments: newAttachments } : {}),
        ...(sourceInput.data.submissionConfig
          ? { submissionConfig: sourceInput.data.submissionConfig }
          : {}),
      },
      {
        kind: input.kind,
        sourceExecutionId: sourceExecution.data.nativeExecutionId as EngineExecutionRef,
        commandId: this.#newId("revision"),
        revisionOf: {
          kind: input.kind,
          inputId: sourceInput.id,
          executionId: sourceExecution.id,
        },
        historicalAttachments: retained,
        sourceAttachments,
        retainedAttachmentIndices: retained.map((attachment) =>
          sourceAttachments.indexOf(attachment),
        ),
      },
    );
  }

  async #submitInput(
    input: SubmitInput,
    revision?: {
      readonly kind: "edit" | "retry";
      readonly sourceExecutionId: EngineExecutionRef;
      readonly commandId: string;
      readonly revisionOf: NonNullable<RuntimeInput["revisionOf"]>;
      readonly historicalAttachments?: readonly RuntimeAttachmentReference[];
      readonly sourceAttachments?: readonly RuntimeAttachmentReference[];
      readonly retainedAttachmentIndices?: readonly number[];
    },
    promotedInputId?: string,
  ): Promise<RuntimeInput> {
    this.#assertOpen();
    const capability = revision ? "execution.revise" : "execution.run";
    const { task, session } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      capability,
    );
    if (task.data.status !== "active")
      throw new RuntimeEligibilityError(
        `Task ${input.taskId} is ${task.data.status}; new input is not allowed.`,
      );
    if (session.data.projection.status !== "active")
      throw new RuntimeEligibilityError(
        `Session ${input.sessionId} is ${session.data.projection.status}; it cannot accept input.`,
      );
    if (typeof input.text !== "string" || input.text.length === 0)
      throw new RuntimeEligibilityError("Input text must not be empty.");
    if (input.delivery !== undefined && input.delivery !== "startNow" && input.delivery !== "queue")
      throw new RuntimeEligibilityError("Input delivery must be startNow or queue.");
    if (revision && input.delivery === "queue")
      throw new RuntimeEligibilityError("Revision inputs cannot be queued.", "unsupported");
    const submissionConfig = normalizeSubmissionConfig(input.submissionConfig);
    const attachments = normalizeAttachmentReferences(input.attachments);
    const recordedAttachments = revision?.historicalAttachments
      ? [...revision.historicalAttachments, ...(attachments ?? [])]
      : attachments;
    const idempotencyKey = input.idempotencyKey;
    if (
      idempotencyKey !== undefined &&
      (typeof idempotencyKey !== "string" ||
        idempotencyKey.length === 0 ||
        idempotencyKey.length > 256 ||
        idempotencyKey.trim() !== idempotencyKey)
    )
      throw new RuntimeEligibilityError("Input idempotency key is invalid.");
    if (idempotencyKey && !promotedInputId) {
      const duplicate = this.#store.findByNativeKey<InputData>("input", session.id, idempotencyKey);
      if (duplicate) {
        if (
          duplicate.data.participantId !== input.participantId ||
          duplicate.data.sessionId !== session.id ||
          duplicate.data.authorizationId !== input.authorizationId ||
          duplicate.data.text !== input.text ||
          (duplicate.data.requestedDelivery ?? "startNow") !== (input.delivery ?? "startNow") ||
          JSON.stringify(duplicate.data.submissionConfig ?? null) !==
            JSON.stringify(submissionConfig ?? null) ||
          JSON.stringify(duplicate.data.attachments ?? null) !== JSON.stringify(attachments ?? null)
        )
          throw new RuntimeEligibilityError(
            "Input idempotency key was already used for a different request.",
          );
        return this.#publicInput(duplicate.data);
      }
    }
    const engine = this.#engineFor(task.data);
    const id = promotedInputId ?? this.#newId("input");
    const receivedAt = this.#now();
    let queued = false;
    let data: InputData | null = null;
    const duplicateResult: { input: InputData | null } = { input: null };
    let resolvedAttachments: EngineAttachment[] | undefined;
    let attachmentClaimError: unknown;
    this.#store.transaction(() => {
      if (!promotedInputId && idempotencyKey) {
        const duplicate = this.#store.findByNativeKey<InputData>(
          "input",
          session.id,
          idempotencyKey,
        );
        if (duplicate) {
          duplicateResult.input = duplicate.data;
          data = duplicate.data;
          return;
        }
      }
      const records = this.#store
        .list<InputData>("input", task.id)
        .filter((record) => record.data.sessionId === session.id);
      if (promotedInputId) {
        const queuedRecords = records.filter((record) => record.data.status === "queued");
        const queuedRecord = this.#require<InputData>("input", promotedInputId);
        if (
          queuedRecord.taskId !== task.id ||
          queuedRecord.sessionId !== session.id ||
          queuedRecord.data.participantId !== input.participantId ||
          queuedRecord.data.authorizationId !== input.authorizationId ||
          queuedRecord.data.status !== "queued"
        )
          throw new RuntimeEligibilityError(
            "Queued Input ownership or state changed before promotion.",
            "ownership",
          );
        if (queuedRecords[0]?.id !== promotedInputId)
          throw new RuntimeEligibilityError("Queued Inputs must be promoted in FIFO order.");
        const unknown = records.find(
          (record) => record.id !== promotedInputId && record.data.status === "unknown",
        );
        if (unknown)
          throw new RuntimeEligibilityError(
            `Queued Input is blocked by unresolved Input ${unknown.id}; its native result is unknown.`,
            "result-unknown",
          );
        const unresolved = records.filter(
          (record) =>
            record.id !== promotedInputId && DISPATCHED_INPUT_STATUSES.has(record.data.status),
        );
        if (unresolved.length)
          throw new RuntimeEligibilityError(
            `Queued Input cannot be promoted while Input ${unresolved[0]!.id} is unresolved.`,
          );
        this.#assertNoActiveCompact(task.id, session.id);
        this.#assertNoActiveFileRewind(task.id, session.id);
        queuedRecord.data.status = "received";
        queuedRecord.data.error = null;
        data = queuedRecord.data;
        this.#save(
          "input",
          id,
          task.id,
          session.id,
          id,
          data,
          data.status,
          queuedRecord.createdAt,
          receivedAt,
        );
      } else {
        this.#assertNoActiveFileRewind(task.id, session.id);
        const queuedRecords = records.filter((record) => record.data.status === "queued");
        const dispatchedRecords = records.filter((record) =>
          DISPATCHED_INPUT_STATUSES.has(record.data.status),
        );
        const unknown = records.find((record) => record.data.status === "unknown");
        const compactRecords = this.#store
          .list<RuntimeCompactOperation>("compact-operation", task.id)
          .filter(
            (record) =>
              record.data.sessionId === session.id &&
              ACTIVE_COMPACT_STATUSES.has(record.data.status),
          );
        const mustQueue = queuedRecords.length > 0 || dispatchedRecords.length > 0;
        if (mustQueue && input.delivery === "queue") {
          if (unknown)
            throw new RuntimeEligibilityError(
              `Cannot queue behind Input ${unknown.id}; its native result is unknown.`,
              "result-unknown",
            );
          if (dispatchedRecords.length > 1)
            throw new RuntimeEligibilityError(
              "Cannot queue because the Session has multiple unresolved Inputs.",
            );
          if (compactRecords.length)
            throw new RuntimeEligibilityError(
              `Cannot queue while compaction ${compactRecords[0]!.id} is unresolved.`,
            );
          if (attachments?.length)
            throw new RuntimeEligibilityError(
              "Queued Inputs currently support text only; attachments cannot be queued.",
              "unsupported",
            );
          queued = true;
        } else {
          if (queuedRecords.length)
            throw new RuntimeEligibilityError(
              `Session has queued Input ${queuedRecords[0]!.id}; new input must also request queue delivery.`,
            );
          this.#assertSessionIdle(task.id, session.id);
        }
        data = {
          id,
          taskId: task.id,
          participantId: input.participantId,
          sessionId: session.id,
          text: input.text,
          authorizationId: input.authorizationId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          requestedDelivery: input.delivery ?? "startNow",
          ...(revision
            ? { revisionOf: revision.revisionOf, nativeRevisionCommandId: revision.commandId }
            : {}),
          ...(submissionConfig ? { submissionConfig } : {}),
          ...(recordedAttachments ? { attachments: recordedAttachments } : {}),
          status: queued ? "queued" : "received",
          receivedAt,
          acceptedAt: null,
          startedAt: null,
          terminalAt: null,
          error: null,
          nativeExecutionId: null,
        };
        this.#store.insert(
          this.#record(
            "input",
            id,
            task.id,
            session.id,
            id,
            data,
            data.status,
            receivedAt,
            receivedAt,
            idempotencyKey ?? null,
          ),
        );
        if (attachments && !queued) {
          try {
            resolvedAttachments = this.#claimAttachments(task, session, id, attachments);
          } catch (error) {
            attachmentClaimError = error;
          }
        }
      }
    });
    if (!data) throw new Error("Input was not persisted before dispatch.");
    const duplicateInput = duplicateResult.input;
    if (duplicateInput) {
      if (
        duplicateInput.participantId !== input.participantId ||
        duplicateInput.sessionId !== session.id ||
        duplicateInput.authorizationId !== input.authorizationId ||
        duplicateInput.text !== input.text ||
        (duplicateInput.requestedDelivery ?? "startNow") !== (input.delivery ?? "startNow") ||
        JSON.stringify(duplicateInput.submissionConfig ?? null) !==
          JSON.stringify(submissionConfig ?? null) ||
        JSON.stringify(duplicateInput.attachments ?? null) !== JSON.stringify(attachments ?? null)
      )
        throw new RuntimeEligibilityError(
          "Input idempotency key was already used for a different request.",
        );
      return this.#publicInput(duplicateInput);
    }
    if (resolvedAttachments)
      for (const attachment of resolvedAttachments) this.#attachmentLocators.delete(attachment.id);
    this.#publish(task.id, "input", id);
    if (queued) return this.#publicInput(data);

    try {
      if (attachmentClaimError) throw attachmentClaimError;
      const nativeSessionId = session.data.nativeSessionId;
      if (!nativeSessionId)
        throw new RuntimeEligibilityError("The native Session handle is unavailable.");
      const latest = await this.#capabilities(engine);
      this.#assertCapability(
        latest,
        task.data.engineId,
        task.data.environment.id,
        capability,
        task.data.engine.configurationVersion,
        task.data.engine.adapterVersion,
      );
      this.#qualify(
        input.taskId,
        input.participantId,
        input.sessionId,
        input.authorizationId,
        capability,
      );
      const beforeDispatch = this.#dispatchGuard({
        taskId: input.taskId,
        participantId: input.participantId,
        sessionId: input.sessionId,
        authorizationId: input.authorizationId,
        capability,
        engine,
        nativeSessionId: nativeSessionId as EngineSessionRef,
      });
      const checkDispatch = () => {
        beforeDispatch();
        if (revision) {
          const source = this.#require<ExecutionData>("execution", revision.revisionOf.executionId);
          if (
            source.taskId !== task.id ||
            source.sessionId !== session.id ||
            source.data.participantId !== input.participantId ||
            (source.data.status !== "completed" &&
              !(revision.kind === "retry" && source.data.status === "failed")) ||
            source.data.nativeExecutionId !== revision.sourceExecutionId
          )
            throw new RuntimeEligibilityError(
              "The source Execution changed before revision dispatch.",
              "ownership",
            );
          if (
            revision.kind === "retry" &&
            this.#store
              .listInSession<RuntimeEvent>("event", session.id)
              .some(
                (record) =>
                  record.data.executionId === source.id &&
                  ["tool.started", "tool.completed", "tool.failed"].includes(record.data.type),
              )
          )
            throw new RuntimeEligibilityError(
              "Retry cannot safely replay an Execution that may have run tools.",
              "unsupported",
            );
        }
        for (const attachment of resolvedAttachments ?? []) {
          const stored = this.#require<AttachmentData>("attachment", attachment.id);
          if (
            stored.data.status !== "claimed" ||
            stored.data.inputId !== id ||
            stored.data.taskId !== task.id ||
            stored.data.participantId !== input.participantId ||
            stored.data.sessionId !== session.id ||
            stored.data.authorizationId !== task.data.authorization.id ||
            stored.data.environmentId !== task.data.environment.id ||
            stored.data.engineId !== task.data.engineId ||
            stored.data.nativeSessionId !== nativeSessionId ||
            stored.data.fileName !== attachment.fileName ||
            stored.data.mimeType !== attachment.mimeType ||
            stored.data.sizeBytes !== attachment.sizeBytes
          )
            throw new RuntimeEligibilityError(
              "The claimed attachment changed before dispatch.",
              "ownership",
            );
        }
      };
      checkDispatch();
      const run = await engine.run({
        session: nativeSessionId as EngineSessionRef,
        input: input.text,
        ...(promotedInputId || input.delivery === "queue" ? { commandId: id } : {}),
        beforeDispatch: checkDispatch,
        ...(submissionConfig ? { submissionConfig } : {}),
        ...(resolvedAttachments ? { attachments: resolvedAttachments } : {}),
        ...(revision
          ? {
              revision: {
                kind: revision.kind,
                sourceExecutionId: revision.sourceExecutionId,
                commandId: revision.commandId,
                ...(revision.kind === "edit"
                  ? {
                      sourceAttachments: revision.sourceAttachments?.map(
                        ({ fileName, mimeType, sizeBytes }) => ({ fileName, mimeType, sizeBytes }),
                      ),
                      retainedAttachmentIndices: revision.retainedAttachmentIndices,
                    }
                  : {}),
              },
            }
          : {}),
      });
      const target: RunTarget = {
        taskId: task.id,
        participantId: input.participantId,
        sessionId: input.sessionId,
        inputId: id,
        nativeSessionId: nativeSessionId as EngineSessionRef,
        nativeExecutionId: run.executionId,
      };
      this.#runs.set(runKey(input.sessionId, run.executionId), target);
      void this.#consumeRun(target, run.events);
    } catch (error) {
      const status = isKnownNoSideEffect(error) ? "rejected" : "unknown";
      const updatedAt = this.#now();
      const current = this.#require<InputData>("input", id);
      current.data.status = status;
      current.data.error = errorMessage(error);
      this.#save(
        "input",
        id,
        task.id,
        input.sessionId,
        id,
        current.data,
        status,
        current.createdAt,
        updatedAt,
      );
      if (status === "unknown")
        this.#addIssue(
          task.id,
          input.sessionId,
          "adapter-error",
          null,
          `Input result is unknown: ${errorMessage(error)}`,
        );
      this.#publish(task.id, "input", id);
      if (status === "rejected") void this.#drainQueuedInputs(session.id);
      else
        void this.#rejectQueuedInputs(
          task.id,
          session.id,
          `Queue stopped because Input ${id} has an unknown native result.`,
        );
      throw error;
    }
    return this.#publicInput(this.#require<InputData>("input", id).data);
  }

  async replyToApproval(input: ReplyToApproval): Promise<RuntimeApproval> {
    this.#assertOpen();
    const { task, session } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      "approval.respond",
    );
    this.#requireActiveTask(task);
    const approval = this.#require<ApprovalData>("approval", input.approvalId);
    this.#assertRelated(
      approval.data.taskId,
      approval.data.participantId,
      approval.data.sessionId,
      input,
    );
    if (approval.data.status !== "pending")
      throw new RuntimeEligibilityError(`Approval ${input.approvalId} is ${approval.data.status}.`);
    if (!approval.data.options.some((option) => option.id === input.optionId))
      throw new RuntimeEligibilityError(
        `Option ${input.optionId} does not belong to Approval ${input.approvalId}.`,
      );
    return this.#withCommandLock(`approval:${approval.id}`, async () => {
      const current = this.#require<ApprovalData>("approval", input.approvalId);
      if (current.data.status !== "pending")
        throw new RuntimeEligibilityError(
          `Approval ${input.approvalId} is ${current.data.status}.`,
        );
      const engine = this.#engineFor(task.data);
      const snapshot = await this.#capabilities(engine);
      this.#assertCapability(
        snapshot,
        task.data.engineId,
        task.data.environment.id,
        "approval.respond",
        task.data.engine.configurationVersion,
        task.data.engine.adapterVersion,
      );
      this.#qualify(
        input.taskId,
        input.participantId,
        input.sessionId,
        input.authorizationId,
        "approval.respond",
      );
      const latest = this.#require<ApprovalData>("approval", input.approvalId);
      if (latest.data.status !== "pending")
        throw new RuntimeEligibilityError(`Approval ${input.approvalId} is ${latest.data.status}.`);
      const selectedOption = latest.data.options.find((option) => option.id === input.optionId);
      if (!selectedOption)
        throw new RuntimeEligibilityError(
          `Option ${input.optionId} does not belong to Approval ${input.approvalId}.`,
        );
      if (selectedOption.requiresFeedback) {
        if (!input.feedback?.trim())
          throw new RuntimeEligibilityError(
            `Option ${input.optionId} requires non-empty user feedback.`,
          );
        if (input.feedback.length > 4096)
          throw new RuntimeEligibilityError("Approval feedback exceeds the 4096 character limit.");
      } else if (input.feedback !== undefined) {
        throw new RuntimeEligibilityError(
          `Option ${input.optionId} does not accept user feedback.`,
        );
      }
      if (latest.data.expiresAt !== null && this.#now() >= latest.data.expiresAt) {
        const expired: ApprovalData = { ...latest.data, status: "expired" };
        this.#save(
          "approval",
          latest.id,
          task.id,
          input.sessionId,
          latest.executionId,
          expired,
          expired.status,
          latest.createdAt,
          this.#now(),
        );
        this.#publish(task.id, "approval", latest.id);
        throw new RuntimeEligibilityError(`Approval ${input.approvalId} has expired.`);
      }
      if (
        TERMINAL_EXECUTION_STATUSES.has(
          this.#require<ExecutionData>("execution", latest.data.executionId).data.status,
        )
      ) {
        const rejected: ApprovalData = { ...latest.data, status: "rejected" };
        this.#save(
          "approval",
          latest.id,
          task.id,
          input.sessionId,
          latest.executionId,
          rejected,
          rejected.status,
          latest.createdAt,
          this.#now(),
        );
        this.#publish(task.id, "approval", latest.id);
        throw new RuntimeEligibilityError(
          `Approval ${input.approvalId} belongs to a finished Execution.`,
        );
      }
      const receipt = await engine.replyToApproval({
        session: session.data.nativeSessionId as EngineSessionRef,
        approvalId: latest.data.nativeApprovalId as EngineApprovalRef,
        optionId: input.optionId,
        ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
      });
      const resolved = this.#require<ApprovalData>("approval", input.approvalId);
      if (resolved.data.status !== "pending") return this.#publicApproval(resolved.data);
      const status = mapReplyStatus(receipt.status);
      const updated: ApprovalData = { ...latest.data, status, repliedOptionId: input.optionId };
      this.#save(
        "approval",
        latest.id,
        task.id,
        input.sessionId,
        latest.executionId,
        updated,
        status,
        latest.createdAt,
        this.#now(),
      );
      this.#publish(task.id, "approval", latest.id);
      return this.#publicApproval(updated);
    });
  }

  async replyToUserInput(input: ReplyToUserInput): Promise<RuntimeUserInput> {
    this.#assertOpen();
    const { task, session } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      "user-input.respond",
    );
    this.#requireActiveTask(task);
    const request = this.#require<UserInputData>("user-input", input.requestId);
    this.#assertRelated(
      request.data.taskId,
      request.data.participantId,
      request.data.sessionId,
      input,
    );
    if (request.data.status !== "pending")
      throw new RuntimeEligibilityError(`User input ${input.requestId} is ${request.data.status}.`);
    return this.#withCommandLock(`user-input:${request.id}`, async () => {
      const current = this.#require<UserInputData>("user-input", input.requestId);
      if (current.data.status !== "pending")
        throw new RuntimeEligibilityError(
          `User input ${input.requestId} is ${current.data.status}.`,
        );
      const engine = this.#engineFor(task.data);
      const snapshot = await this.#capabilities(engine);
      this.#assertCapability(
        snapshot,
        task.data.engineId,
        task.data.environment.id,
        "user-input.respond",
        task.data.engine.configurationVersion,
        task.data.engine.adapterVersion,
      );
      this.#qualify(
        input.taskId,
        input.participantId,
        input.sessionId,
        input.authorizationId,
        "user-input.respond",
      );
      const latest = this.#require<UserInputData>("user-input", input.requestId);
      if (latest.data.status !== "pending")
        throw new RuntimeEligibilityError(
          `User input ${input.requestId} is ${latest.data.status}.`,
        );
      if (latest.data.expiresAt !== null && this.#now() >= latest.data.expiresAt) {
        const expired: UserInputData = { ...latest.data, status: "expired" };
        this.#save(
          "user-input",
          latest.id,
          task.id,
          input.sessionId,
          latest.executionId,
          expired,
          expired.status,
          latest.createdAt,
          this.#now(),
        );
        this.#publish(task.id, "user-input", latest.id);
        throw new RuntimeEligibilityError(`User input ${input.requestId} has expired.`);
      }
      if (
        TERMINAL_EXECUTION_STATUSES.has(
          this.#require<ExecutionData>("execution", latest.data.executionId).data.status,
        )
      ) {
        const rejected: UserInputData = { ...latest.data, status: "rejected" };
        this.#save(
          "user-input",
          latest.id,
          task.id,
          input.sessionId,
          latest.executionId,
          rejected,
          rejected.status,
          latest.createdAt,
          this.#now(),
        );
        this.#publish(task.id, "user-input", latest.id);
        throw new RuntimeEligibilityError(
          `User input ${input.requestId} belongs to a finished Execution.`,
        );
      }
      const receipt = await engine.replyToUserInput({
        session: session.data.nativeSessionId as EngineSessionRef,
        requestId: latest.data.nativeRequestId as EngineUserInputRef,
        response: input.response,
      });
      const resolved = this.#require<UserInputData>("user-input", input.requestId);
      // A native response event can overtake the command ACK. Preserve its more
      // authoritative status while still recording the answer this authorized
      // Runtime call sent; otherwise the selected value is lost on that race.
      const status =
        resolved.data.status === "pending" ? mapReplyStatus(receipt.status) : resolved.data.status;
      const response =
        resolved.data.response !== null
          ? resolved.data.response
          : receipt.status === "forwarded" && status === "forwarded"
            ? input.response
            : null;
      const updated: UserInputData = {
        ...resolved.data,
        status,
        response: this.#clone(response),
      };
      this.#save(
        "user-input",
        resolved.id,
        task.id,
        input.sessionId,
        resolved.executionId,
        updated,
        status,
        resolved.createdAt,
        this.#now(),
        resolved.nativeKey,
      );
      this.#publish(task.id, "user-input", latest.id);
      return this.#publicUserInput(updated);
    });
  }

  async requestStop(input: RequestStop): Promise<RuntimeStopRequest> {
    this.#assertOpen();
    const { task, session } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      "execution.interrupt",
      true,
    );
    return this.#withCommandLock(`stop:${input.executionId}`, async () => {
      const execution = this.#require<ExecutionData>("execution", input.executionId);
      this.#assertRelated(
        execution.data.taskId,
        execution.data.participantId,
        execution.data.sessionId,
        input,
      );
      if (TERMINAL_EXECUTION_STATUSES.has(execution.data.status))
        throw new RuntimeEligibilityError(
          `Execution ${input.executionId} is already ${execution.data.status}.`,
        );
      const unresolvedRequest = this.#store
        .list<RuntimeStopRequest>("stop-request", task.id)
        .find(
          (record) =>
            record.data.executionId === execution.id &&
            ["requested", "unknown"].includes(record.data.status),
        );
      if (unresolvedRequest)
        throw new RuntimeEligibilityError(
          `Execution ${execution.id} already has unresolved StopRequest ${unresolvedRequest.id}.`,
        );
      const id = this.#newId("stop");
      const requestedAt = this.#now();
      const nativeSession = this.#liveSessions.get(session.id);
      const currentSession = this.#store.get<SessionData>("session", session.id)!;
      if (!nativeSession || !currentSession.data.nativeSessionId) {
        const unknown: RuntimeStopRequest = {
          id,
          taskId: task.id,
          participantId: input.participantId,
          sessionId: session.id,
          executionId: execution.id,
          requestedAt,
          status: "unknown",
          deliveryStatus: "not-delivered",
          deliveryEvidence: null,
          stopEvidence: null,
          reason: "Native session is not attached in this Runtime process.",
        };
        this.#store.insert(
          this.#record(
            "stop-request",
            id,
            task.id,
            session.id,
            execution.id,
            unknown,
            unknown.status,
            requestedAt,
          ),
        );
        this.#publish(task.id, "stop-request", id);
        return unknown;
      }
      const engine = this.#engineFor(task.data);
      const snapshot = await this.#capabilities(engine);
      this.#assertCapability(
        snapshot,
        task.data.engineId,
        task.data.environment.id,
        "execution.interrupt",
        task.data.engine.configurationVersion,
        task.data.engine.adapterVersion,
      );
      this.#qualify(
        input.taskId,
        input.participantId,
        input.sessionId,
        input.authorizationId,
        "execution.interrupt",
        true,
      );
      const currentExecution = this.#require<ExecutionData>("execution", execution.id);
      if (TERMINAL_EXECUTION_STATUSES.has(currentExecution.data.status))
        throw new RuntimeEligibilityError(
          `Execution ${execution.id} is already ${currentExecution.data.status}.`,
        );
      let request: RuntimeStopRequest = {
        id,
        taskId: task.id,
        participantId: input.participantId,
        sessionId: session.id,
        executionId: execution.id,
        requestedAt,
        status: "requested",
        deliveryStatus: "pending",
        deliveryEvidence: null,
        stopEvidence: null,
        reason: null,
      };
      this.#store.insert(
        this.#record(
          "stop-request",
          id,
          task.id,
          session.id,
          execution.id,
          request,
          request.status,
          requestedAt,
        ),
      );
      this.#publish(task.id, "stop-request", id);
      try {
        const receipt = await engine.interrupt({
          session: nativeSession,
          executionId: currentExecution.data.nativeExecutionId as EngineExecutionRef,
        });
        const current = this.#require<RuntimeStopRequest>("stop-request", id);
        const latestExecution = this.#require<ExecutionData>("execution", execution.id);
        const terminal = TERMINAL_EXECUTION_STATUSES.has(latestExecution.data.status);
        const receiptDelivery = mapStopDelivery(receipt.status, receipt.evidence);
        request = {
          ...current.data,
          status:
            current.data.status === "confirmed"
              ? "confirmed"
              : terminal
                ? "unknown"
                : mapStopStatus(receipt.status),
          deliveryStatus: mergeStopDelivery(current.data.deliveryStatus, receiptDelivery),
          deliveryEvidence:
            receipt.evidence?.source === "engine"
              ? receipt.evidence
              : current.data.deliveryEvidence,
          reason:
            current.data.status === "confirmed"
              ? current.data.reason
              : terminal
                ? (current.data.reason ??
                  `Execution reached terminal state ${latestExecution.data.status} before native stop confirmation.`)
                : (receipt.reason ?? null),
        };
      } catch (error) {
        const current = this.#require<RuntimeStopRequest>("stop-request", id);
        const latestExecution = this.#require<ExecutionData>("execution", execution.id);
        const terminal = TERMINAL_EXECUTION_STATUSES.has(latestExecution.data.status);
        const deliveryStatus =
          error instanceof EngineContractError && error.failure.sideEffects === "none"
            ? "not-delivered"
            : "unknown";
        request = {
          ...current.data,
          status:
            current.data.status === "confirmed"
              ? "confirmed"
              : terminal
                ? "unknown"
                : error instanceof EngineContractError
                  ? mapStopStatus(error.kind)
                  : "unknown",
          deliveryStatus: mergeStopDelivery(current.data.deliveryStatus, deliveryStatus),
          reason:
            current.data.status === "confirmed"
              ? current.data.reason
              : terminal
                ? (current.data.reason ??
                  `Execution reached terminal state ${latestExecution.data.status} before native stop confirmation.`)
                : errorMessage(error),
        };
      }
      this.#save(
        "stop-request",
        id,
        task.id,
        session.id,
        execution.id,
        request,
        request.status,
        requestedAt,
        this.#now(),
      );
      this.#publish(task.id, "stop-request", id);
      return request;
    });
  }

  async compactSession(input: CompactSession): Promise<RuntimeCompactOperation> {
    this.#assertOpen();
    const instructions = input.instructions?.trim();
    const { task, session } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      "session.compact",
    );
    this.#requireActiveTask(task);
    this.#assertSessionIdle(task.id, session.id);
    const nativeSessionId = session.data.nativeSessionId;
    if (!nativeSessionId || this.#liveSessions.get(session.id) !== nativeSessionId)
      throw new RuntimeEligibilityError("The native Session is not attached in this Host.");

    const engine = this.#engineFor(task.data);
    const snapshot = await this.#capabilities(engine);
    this.#assertCapability(
      snapshot,
      task.data.engineId,
      task.data.environment.id,
      "session.compact",
      task.data.engine.configurationVersion,
      task.data.engine.adapterVersion,
    );
    if (!engine.compactSession)
      throw new RuntimeEligibilityError(
        "This Engine has no native Session compaction command.",
        "unsupported",
      );

    const operationId = this.#newId("compact");
    const requestedAt = this.#now();
    const operation: RuntimeCompactOperation = {
      id: operationId,
      taskId: task.id,
      participantId: input.participantId,
      sessionId: session.id,
      status: "requested",
      requestedAt,
      acceptedAt: null,
      terminalAt: null,
      requestedEvidence: {
        source: "host",
        evidenceId: operationId,
        detail: "Product Session compaction request recorded.",
      },
      acceptedEvidence: null,
      terminalEvidence: null,
      failureEvidence: null,
      unknownEvidence: null,
      reason: null,
    };
    this.#store.transaction(() => {
      const latest = this.#qualify(
        input.taskId,
        input.participantId,
        input.sessionId,
        input.authorizationId,
        "session.compact",
      );
      this.#requireActiveTask(latest.task);
      this.#assertSessionIdle(task.id, session.id);
      if (
        latest.session.data.nativeSessionId !== nativeSessionId ||
        this.#liveSessions.get(session.id) !== nativeSessionId
      )
        throw new RuntimeEligibilityError("The native Session changed before compaction request.");
      this.#store.insert(
        this.#record(
          "compact-operation",
          operationId,
          task.id,
          session.id,
          null,
          operation,
          operation.status,
          requestedAt,
          requestedAt,
          operationId,
        ),
      );
    });
    this.#publish(task.id, "compact-operation", operationId);

    const beforeDispatch = this.#dispatchGuard({
      taskId: input.taskId,
      participantId: input.participantId,
      sessionId: input.sessionId,
      authorizationId: input.authorizationId,
      capability: "session.compact",
      engine,
      nativeSessionId: nativeSessionId as EngineSessionRef,
    });
    const checkDispatch = () => {
      beforeDispatch();
      this.#assertSessionIdle(task.id, session.id, operationId);
      const current = this.#require<RuntimeCompactOperation>("compact-operation", operationId);
      if (current.data.status !== "requested")
        throw new RuntimeEligibilityError("Compaction request is no longer awaiting dispatch.");
    };
    try {
      const receipt = await engine.compactSession({
        session: nativeSessionId as EngineSessionRef,
        commandId: operationId,
        ...(instructions ? { instructions } : {}),
        beforeDispatch: checkDispatch,
        onAccepted: (evidence) => {
          const current = this.#require<RuntimeCompactOperation>("compact-operation", operationId);
          if (current.data.status === "requested")
            this.#updateCompactOperation(operationId, {
              status: "accepted",
              acceptedAt: this.#now(),
              acceptedEvidence: evidence,
            });
        },
      });
      if (receipt.status === "unknown")
        return this.#updateCompactOperation(operationId, {
          status: "unknown",
          unknownEvidence: receipt.evidence ?? {
            source: "adapter",
            evidenceId: `${operationId}:unknown`,
            detail: "Native compaction outcome is unknown.",
          },
          reason: receipt.reason ?? "Native compaction outcome is unknown.",
        });
      const terminalAt = this.#now();
      const failed = receipt.status === "failed";
      return this.#updateCompactOperation(operationId, {
        status: receipt.status,
        terminalAt,
        terminalEvidence: receipt.evidence ?? null,
        ...(failed ? { failureEvidence: receipt.evidence ?? null } : {}),
        reason: receipt.reason ?? null,
      });
    } catch (error) {
      const reason = errorMessage(error);
      const uncertain =
        error instanceof EngineContractError
          ? error.failure.sideEffects !== "none" || error.kind === "result-unknown"
          : !(error instanceof RuntimeEligibilityError);
      const evidence = {
        source: error instanceof EngineContractError ? ("adapter" as const) : ("host" as const),
        evidenceId: `${operationId}:${uncertain ? "unknown" : "failed"}`,
        detail: reason,
      };
      return this.#updateCompactOperation(operationId, {
        status: uncertain ? "unknown" : "failed",
        ...(uncertain ? { unknownEvidence: evidence } : { failureEvidence: evidence }),
        ...(!uncertain ? { terminalAt: this.#now() } : {}),
        reason,
      });
    }
  }

  async getExecutionFileChanges(input: ExecutionFileTarget): Promise<EngineFileChanges | null> {
    this.#assertOpen();
    const target = await this.#readyFileTarget(input);
    if (!target.engine.getFileChanges) return null;
    return target.engine.getFileChanges({
      session: target.nativeSession,
      executionId: target.nativeExecution,
    });
  }

  async previewFileRewind(input: ExecutionFileTarget): Promise<EngineFileRewindPreview> {
    this.#assertOpen();
    const target = await this.#readyFileTarget(input);
    this.#assertSessionIdle(target.task.id, target.session.id);
    if (!target.engine.previewFileRewind)
      throw new RuntimeEligibilityError("This Engine has no file rewind preview.", "unsupported");
    return target.engine.previewFileRewind({
      session: target.nativeSession,
      executionId: target.nativeExecution,
    });
  }

  async applyFileRewind(input: ApplyFileRewind): Promise<RuntimeFileRewindOperation> {
    this.#assertOpen();
    if (!input.expectedPreview?.canApply || input.expectedPreview.safeFiles.length === 0)
      throw new RuntimeEligibilityError("A safe file rewind preview is required.");
    const target = await this.#readyFileTarget(input);
    this.#assertSessionIdle(target.task.id, target.session.id);
    this.#assertNoUnknownFileRewind(input.taskId, input.executionId);
    if (!target.engine.applyFileRewind)
      throw new RuntimeEligibilityError("This Engine has no file rewind command.", "unsupported");

    const operationId = this.#newId("file-rewind");
    const requestedAt = this.#now();
    const operation: RuntimeFileRewindOperation = {
      id: operationId,
      taskId: input.taskId,
      participantId: input.participantId,
      sessionId: input.sessionId,
      executionId: input.executionId,
      status: "requested",
      requestedAt,
      terminalAt: null,
      evidence: { source: "host", evidenceId: operationId, detail: "File rewind requested." },
      reason: null,
    };
    this.#store.transaction(() => {
      const latest = this.#qualifyFileTarget(input);
      if (
        latest.nativeSession !== target.nativeSession ||
        latest.nativeExecution !== target.nativeExecution
      )
        throw new RuntimeEligibilityError("The native file rewind target changed.");
      this.#assertSessionIdle(latest.task.id, latest.session.id);
      this.#assertNoUnknownFileRewind(input.taskId, input.executionId);
      this.#store.insert(
        this.#record(
          "file-rewind-operation",
          operationId,
          input.taskId,
          input.sessionId,
          null,
          operation,
          operation.status,
          requestedAt,
          requestedAt,
          operationId,
          input.executionId,
        ),
      );
    });
    this.#publish(input.taskId, "file-rewind-operation", operationId);
    const guard = this.#dispatchGuard({
      taskId: input.taskId,
      participantId: input.participantId,
      sessionId: input.sessionId,
      authorizationId: input.authorizationId,
      capability: "workspace.file-rewind",
      engine: target.engine,
      nativeSessionId: target.nativeSession,
    });
    const beforeDispatch = () => {
      guard();
      const latest = this.#qualifyFileTarget(input);
      if (latest.nativeExecution !== target.nativeExecution)
        throw new RuntimeEligibilityError("The native Execution changed before file rewind.");
      this.#assertSessionIdle(input.taskId, input.sessionId, undefined, operationId);
    };
    try {
      const receipt = await target.engine.applyFileRewind({
        session: target.nativeSession,
        executionId: target.nativeExecution,
        expectedPreview: input.expectedPreview,
        commandId: operationId,
        beforeDispatch,
      });
      return this.#finishFileRewind(operationId, {
        status: receipt.status,
        terminalAt: receipt.status === "unknown" ? null : this.#now(),
        evidence: receipt.evidence ?? null,
        reason: receipt.reason ?? null,
      });
    } catch (error) {
      const unknown =
        error instanceof EngineContractError
          ? error.failure.sideEffects !== "none" || error.kind === "result-unknown"
          : !(error instanceof RuntimeEligibilityError);
      return this.#finishFileRewind(operationId, {
        status: unknown ? "unknown" : "rejected",
        terminalAt: unknown ? null : this.#now(),
        evidence: {
          source: unknown ? "adapter" : "host",
          evidenceId: `${operationId}:${unknown ? "unknown" : "rejected"}`,
          detail: errorMessage(error),
        },
        reason: errorMessage(error),
      });
    }
  }

  async setAssistantFeedback(input: SetAssistantFeedback): Promise<RuntimeAssistantFeedbackResult> {
    this.#assertOpen();
    const { session } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      "assistant.feedback",
    );
    const messageId = input.messageId;
    if (
      typeof messageId !== "string" ||
      messageId.length === 0 ||
      messageId.length > 512 ||
      messageId.trim() !== messageId
    ) {
      throw new RuntimeEligibilityError("Assistant feedback requires a valid message ID.");
    }
    if (input.feedback !== null && input.feedback !== "like" && input.feedback !== "dislike") {
      throw new RuntimeEligibilityError("Assistant feedback value is invalid.");
    }

    const execution = this.#require<ExecutionData>("execution", input.executionId);
    this.#assertRelated(
      execution.data.taskId,
      execution.data.participantId,
      execution.data.sessionId,
      input,
    );
    if (!TERMINAL_EXECUTION_STATUSES.has(execution.data.status))
      throw new RuntimeEligibilityError(
        `Execution ${input.executionId} is ${execution.data.status}; feedback requires a terminal Execution.`,
        "terminal",
      );
    const ownsMessage = this.#store
      .listInSession<RuntimeEvent>("event", session.id)
      .some(
        (record) =>
          record.status === "observed" &&
          record.data.executionId === execution.id &&
          record.data.source === "engine" &&
          record.data.type === "message.delta" &&
          record.data.duplicateOf === null &&
          record.data.payload.messageId === messageId,
      );
    if (!ownsMessage)
      throw new RuntimeEligibilityError(
        "The selected assistant message was not observed in this product Execution.",
        "ownership",
      );

    const lockKey = JSON.stringify([session.id, execution.id, messageId]);
    return this.#withAssistantFeedbackLock(lockKey, input.feedback, async () => {
      // Recheck all product authorization and provenance after waiting for an earlier action
      // or probing current Engine state, immediately before forwarding the native command.
      const currentOwnership = this.#qualify(
        input.taskId,
        input.participantId,
        input.sessionId,
        input.authorizationId,
        "assistant.feedback",
      );
      const currentExecution = this.#require<ExecutionData>("execution", execution.id);
      this.#assertRelated(
        currentExecution.data.taskId,
        currentExecution.data.participantId,
        currentExecution.data.sessionId,
        input,
      );
      if (!TERMINAL_EXECUTION_STATUSES.has(currentExecution.data.status))
        throw new RuntimeEligibilityError(
          `Execution ${input.executionId} is ${currentExecution.data.status}; feedback requires a terminal Execution.`,
          "terminal",
        );
      const stillOwnsMessage = this.#store
        .listInSession<RuntimeEvent>("event", currentOwnership.session.id)
        .some(
          (record) =>
            record.status === "observed" &&
            record.data.executionId === currentExecution.id &&
            record.data.source === "engine" &&
            record.data.type === "message.delta" &&
            record.data.duplicateOf === null &&
            record.data.payload.messageId === messageId,
        );
      if (!stillOwnsMessage)
        throw new RuntimeEligibilityError(
          "The selected assistant message is no longer attributable to this Execution.",
          "ownership",
        );

      const nativeSession = this.#liveSessions.get(currentOwnership.session.id);
      const storedNativeSession = currentOwnership.session.data.nativeSessionId;
      const nativeExecutionId = currentExecution.data.nativeExecutionId;
      if (!nativeSession || !storedNativeSession || nativeSession !== storedNativeSession)
        return {
          status: "unknown",
          reason: "The native Session is not attached in this Runtime process.",
        };
      if (!nativeExecutionId)
        return {
          status: "unknown",
          reason: "The product Execution has no verified native execution handle.",
        };

      const engine = this.#engineFor(currentOwnership.task.data);
      const snapshot = await this.#capabilities(engine);
      this.#assertCapability(
        snapshot,
        currentOwnership.task.data.engineId,
        currentOwnership.task.data.environment.id,
        "assistant.feedback",
        currentOwnership.task.data.engine.configurationVersion,
        currentOwnership.task.data.engine.adapterVersion,
      );
      if (!engine.setAssistantFeedback)
        return {
          status: "unsupported",
          reason: "The current Engine Adapter does not implement assistant feedback.",
        };

      const latestOwnership = this.#qualify(
        input.taskId,
        input.participantId,
        input.sessionId,
        input.authorizationId,
        "assistant.feedback",
      );
      const latestExecution = this.#require<ExecutionData>("execution", execution.id);
      this.#assertRelated(
        latestExecution.data.taskId,
        latestExecution.data.participantId,
        latestExecution.data.sessionId,
        input,
      );
      if (!TERMINAL_EXECUTION_STATUSES.has(latestExecution.data.status))
        throw new RuntimeEligibilityError(
          `Execution ${input.executionId} is ${latestExecution.data.status}; feedback requires a terminal Execution.`,
          "terminal",
        );
      const latestOwnsMessage = this.#store
        .listInSession<RuntimeEvent>("event", latestOwnership.session.id)
        .some(
          (record) =>
            record.status === "observed" &&
            record.data.executionId === latestExecution.id &&
            record.data.source === "engine" &&
            record.data.type === "message.delta" &&
            record.data.duplicateOf === null &&
            record.data.payload.messageId === messageId,
        );
      if (!latestOwnsMessage)
        throw new RuntimeEligibilityError(
          "The selected assistant message is no longer attributable to this Execution.",
          "ownership",
        );
      if (
        !latestExecution.data.nativeExecutionId ||
        latestExecution.data.nativeExecutionId !== nativeExecutionId
      ) {
        return {
          status: "unknown",
          reason: "The product Execution native handle changed before feedback was sent.",
        };
      }
      if (
        this.#liveSessions.get(latestOwnership.session.id) !== nativeSession ||
        latestOwnership.session.data.nativeSessionId !== nativeSession
      ) {
        return {
          status: "unknown",
          reason: "The native Session attachment changed before feedback was sent.",
        };
      }
      const beforeDispatch = this.#dispatchGuard({
        taskId: input.taskId,
        participantId: input.participantId,
        sessionId: input.sessionId,
        authorizationId: input.authorizationId,
        capability: "assistant.feedback",
        engine,
        nativeSessionId: nativeSession,
      });
      beforeDispatch();
      return engine.setAssistantFeedback({
        session: nativeSession,
        executionId: latestExecution.data.nativeExecutionId as EngineExecutionRef,
        messageId,
        feedback: input.feedback,
        beforeDispatch,
      });
    });
  }

  freezeTask(input: TaskLifecycleRequest & { readonly reason: string }): RuntimeTask {
    this.#assertOpen();
    const { task } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      "task.freeze",
      true,
    );
    if (task.data.status !== "active")
      throw new RuntimeEligibilityError(
        `Task ${input.taskId} is ${task.data.status}; only active Tasks can be frozen.`,
      );
    task.data.status = "frozen";
    task.data.updatedAt = this.#now();
    task.data.closeReason = input.reason;
    this.#save(
      "task",
      task.id,
      task.id,
      null,
      null,
      task.data,
      task.data.status,
      task.createdAt,
      task.data.updatedAt,
    );
    this.#rejectQueuedInputs(
      task.id,
      task.data.sessionId,
      "Task frozen before queued Input dispatch.",
    );
    this.#publish(task.id, "task", task.id);
    return this.#requireTaskProjection(input.taskId);
  }

  closeTask(
    input: TaskLifecycleRequest & {
      readonly outcome: Exclude<RuntimeTaskStatus, "active" | "frozen">;
    },
  ): RuntimeTask {
    this.#assertOpen();
    const { task } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      "task.close",
      true,
    );
    if (task.data.status !== "active" && task.data.status !== "frozen") {
      throw new RuntimeEligibilityError(
        `Task ${input.taskId} is already terminal (${task.data.status}).`,
      );
    }
    if (input.outcome !== "abandoned") {
      const unresolvedInput = this.#store
        .list<InputData>("input", task.id)
        .find((record) => ACTIVE_INPUT_STATUSES.has(record.data.status));
      const unresolvedExecution = this.#store
        .list<ExecutionData>("execution", task.id)
        .find((record) => !TERMINAL_EXECUTION_STATUSES.has(record.data.status));
      const unresolvedCompact = this.#store
        .list<RuntimeCompactOperation>("compact-operation", task.id)
        .find((record) => ACTIVE_COMPACT_STATUSES.has(record.data.status));
      if (unresolvedInput || unresolvedExecution || unresolvedCompact) {
        throw new RuntimeEligibilityError(
          "Cannot close a Task with unresolved Input, Execution, or Session maintenance evidence; use abandoned to close without claiming an outcome.",
        );
      }
    }
    const closedAt = this.#now();
    if (input.outcome === "abandoned")
      this.#rejectQueuedInputs(
        task.id,
        task.data.sessionId,
        "Task abandoned before queued Input dispatch.",
      );
    task.data.status = input.outcome;
    task.data.updatedAt = closedAt;
    task.data.closedAt = closedAt;
    task.data.closeReason = input.outcome;
    this.#save(
      "task",
      task.id,
      task.id,
      null,
      null,
      task.data,
      input.outcome,
      task.createdAt,
      closedAt,
    );
    this.#publish(task.id, "task", task.id);
    return this.#requireTaskProjection(input.taskId);
  }

  subscribe(listener: (change: RuntimeChange) => void): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#attachmentLocators.clear();
    this.#store.close();
  }

  async #consumeRun(target: RunTarget, events: AsyncIterable<EngineEvent>): Promise<void> {
    let gotTerminal = false;
    try {
      for await (const event of events) {
        const terminal = this.#processEvent(target, event);
        if (terminal) {
          gotTerminal = true;
          void this.#drainQueuedInputs(target.sessionId);
        }
      }
      const input = this.#store.get<InputData>("input", target.inputId);
      if (!gotTerminal && input && ACTIVE_INPUT_STATUSES.has(input.status ?? "")) {
        this.#setInputUnknown(target, "Engine event stream ended without terminal evidence.");
        const execution = this.#findExecution(target.sessionId, target.nativeExecutionId);
        if (execution && !TERMINAL_EXECUTION_STATUSES.has(execution.data.status)) {
          execution.data.status = "unknown";
          execution.data.error = "Event stream ended without terminal evidence.";
          this.#save(
            "execution",
            execution.id,
            target.taskId,
            target.sessionId,
            target.inputId,
            execution.data,
            "unknown",
            execution.createdAt,
            this.#now(),
          );
        }
        this.#addIssue(
          target.taskId,
          target.sessionId,
          "stream-ended-unknown",
          null,
          "Engine event stream ended without terminal evidence.",
        );
        this.#publish(target.taskId, "input", target.inputId);
        this.#rejectQueuedInputs(
          target.taskId,
          target.sessionId,
          `Queue stopped because Input ${target.inputId} ended without terminal evidence and is unknown.`,
        );
      }
    } catch (error) {
      if (!this.#closed) {
        this.#setInputUnknown(target, `Event stream failed: ${errorMessage(error)}`);
        const execution = this.#findExecution(target.sessionId, target.nativeExecutionId);
        if (execution && !TERMINAL_EXECUTION_STATUSES.has(execution.data.status)) {
          execution.data.status = "unknown";
          execution.data.error = errorMessage(error);
          this.#save(
            "execution",
            execution.id,
            target.taskId,
            target.sessionId,
            target.inputId,
            execution.data,
            "unknown",
            execution.createdAt,
            this.#now(),
          );
        }
        this.#addIssue(
          target.taskId,
          target.sessionId,
          "adapter-error",
          null,
          `Event stream failed: ${errorMessage(error)}`,
        );
        this.#rejectQueuedInputs(
          target.taskId,
          target.sessionId,
          `Queue stopped because Input ${target.inputId} has an unknown native result.`,
        );
      }
    } finally {
      this.#runs.delete(runKey(target.sessionId, target.nativeExecutionId));
    }
  }

  async #drainQueuedInputs(sessionId: string): Promise<void> {
    if (this.#closed || this.#queueDrainingSessions.has(sessionId)) return;
    this.#queueDrainingSessions.add(sessionId);
    try {
      const queued = this.#store
        .listInSession<InputData>("input", sessionId)
        .find((record) => record.data.status === "queued");
      if (!queued) return;

      const { taskId } = queued;
      const task = this.#store.get<TaskData>("task", taskId);
      const session = this.#store.get<SessionData>("session", sessionId);
      if (!task || task.data.status !== "active") {
        this.#rejectQueuedInputs(
          taskId,
          sessionId,
          `Queued Input was not sent because Task is ${task?.data.status ?? "missing"}.`,
        );
        return;
      }
      if (!session || session.data.projection.status !== "active") {
        this.#rejectQueuedInputs(
          taskId,
          sessionId,
          `Queued Input was not sent because Session is ${session?.data.projection.status ?? "missing"}.`,
        );
        return;
      }
      const records = this.#store.listInSession<InputData>("input", sessionId);
      const unknown = records.find(
        (record) => record.id !== queued.id && record.data.status === "unknown",
      );
      if (unknown) {
        this.#rejectQueuedInputs(
          taskId,
          sessionId,
          `Queue stopped because Input ${unknown.id} has an unknown native result; queued Inputs were not resent.`,
        );
        return;
      }
      const unresolved = records.find(
        (record) => record.id !== queued.id && DISPATCHED_INPUT_STATUSES.has(record.data.status),
      );
      if (unresolved) return;
      const compact = this.#store
        .list<RuntimeCompactOperation>("compact-operation", taskId)
        .find(
          (record) =>
            record.data.sessionId === sessionId && ACTIVE_COMPACT_STATUSES.has(record.data.status),
        );
      if (compact) {
        this.#rejectQueuedInputs(
          taskId,
          sessionId,
          `Queued Input was not sent because compaction ${compact.id} is unresolved.`,
        );
        return;
      }
      const data = queued.data;
      try {
        await this.#submitInput(
          {
            taskId,
            participantId: data.participantId,
            sessionId,
            authorizationId: data.authorizationId,
            text: data.text,
            delivery: "queue",
            ...(data.idempotencyKey ? { idempotencyKey: data.idempotencyKey } : {}),
            ...(data.submissionConfig ? { submissionConfig: data.submissionConfig } : {}),
          },
          undefined,
          queued.id,
        );
      } catch (error) {
        const latest = this.#store.get<InputData>("input", queued.id);
        const reason = errorMessage(error);
        if (latest?.data.status === "unknown") {
          this.#rejectQueuedInputs(
            taskId,
            sessionId,
            `Queue stopped because Input ${queued.id} has an unknown native result; queued Inputs were not resent.`,
          );
        } else {
          this.#rejectQueuedInputs(
            taskId,
            sessionId,
            `Queue stopped because Input ${queued.id} could not be dispatched: ${reason}`,
          );
        }
      }
    } catch (error) {
      if (!this.#closed) {
        const queued = this.#store
          .listInSession<InputData>("input", sessionId)
          .find((record) => record.data.status === "queued");
        if (queued)
          this.#rejectQueuedInputs(
            queued.taskId,
            sessionId,
            `Queued Input could not be requalified: ${errorMessage(error)}`,
          );
      }
    } finally {
      this.#queueDrainingSessions.delete(sessionId);
    }
  }

  #rejectQueuedInputs(taskId: string, sessionId: string, reason: string): void {
    for (const record of this.#store.list<InputData>("input", taskId)) {
      if (record.data.sessionId !== sessionId || record.data.status !== "queued") continue;
      const rejectedAt = this.#now();
      record.data.status = "rejected";
      record.data.error = reason;
      record.data.terminalAt = rejectedAt;
      this.#save(
        "input",
        record.id,
        taskId,
        sessionId,
        record.id,
        record.data,
        "rejected",
        record.createdAt,
        rejectedAt,
      );
      this.#publish(taskId, "input", record.id);
    }
  }

  #processEvent(target: RunTarget, event: EngineEvent): boolean {
    this.#pendingChanges = [];
    let terminal = false;
    try {
      this.#store.transaction(() => {
        terminal = this.#processEventTransaction(target, event);
      });
    } catch (error) {
      this.#pendingChanges = null;
      throw error;
    }
    const changes = this.#pendingChanges;
    this.#pendingChanges = null;
    for (const change of changes ?? [])
      this.#dispatchChange(change.taskId, change.kind, change.entityId);
    return terminal;
  }

  #processEventTransaction(target: RunTarget, event: EngineEvent): boolean {
    if (this.#closed) return false;
    const inputRecord = this.#store.get<InputData>("input", target.inputId);
    const taskRecord = this.#store.get<TaskData>("task", target.taskId);
    if (!inputRecord || !taskRecord) return false;
    const executionRecord = this.#findExecution(target.sessionId, target.nativeExecutionId);
    const nativeMatches =
      event.session === target.nativeSessionId && event.executionId === target.nativeExecutionId;
    const payload = eventPayload(event);
    const nativeKey = JSON.stringify([target.nativeExecutionId, event.source, event.eventId]);
    const prior = this.#store.findByNativeKey<EventData>("event", target.sessionId, nativeKey);
    const priorSameSequence =
      event.sourceSequence === null
        ? null
        : this.#store.findBySequence<RuntimeEvent>(
            target.sessionId,
            event.streamId,
            event.source,
            event.sourceSequence,
          );
    const canonicalPayload = JSON.stringify({
      source: event.source,
      sourceSequence: event.sourceSequence,
      payload: this.#jsonSafe(payload),
    });
    const duplicate = prior !== null;
    const payloadEqual = duplicate && prior.data.canonicalPayload === canonicalPayload;
    const sequenceConflict =
      !duplicate &&
      priorSameSequence !== null &&
      priorSameSequence.data.nativeEventId !== event.eventId;
    const latestSequence = this.#store
      .listInSession<RuntimeEvent>("event", target.sessionId)
      .filter(
        (record) => record.data.streamId === event.streamId && record.data.source === event.source,
      )
      .reduce<number | null>((max, record) => {
        const sequence = record.data.sourceSequence;
        return typeof sequence === "number"
          ? max === null
            ? sequence
            : Math.max(max, sequence)
          : max;
      }, null);
    const gap =
      !duplicate &&
      !sequenceConflict &&
      event.sourceSequence !== null &&
      latestSequence !== null &&
      event.sourceSequence > latestSequence + 1;
    const outOfOrder =
      !duplicate &&
      !sequenceConflict &&
      event.sourceSequence !== null &&
      latestSequence !== null &&
      event.sourceSequence < latestSequence;

    const eventId = this.#newId("event");
    const eventProjection: EventData = {
      id: eventId,
      taskId: target.taskId,
      participantId: target.participantId,
      sessionId: target.sessionId,
      inputId: target.inputId,
      executionId: executionRecord?.id ?? null,
      nativeEventId: event.eventId,
      streamId: event.streamId,
      sourceSequence: event.sourceSequence,
      deliverySequence: event.deliverySequence,
      observedAt: event.observedAt,
      source: event.source,
      type: event.type,
      payload: this.#publicEventPayload(payload),
      duplicateOf: prior?.id ?? null,
      canonicalPayload,
    };
    this.#store.insert(
      this.#record(
        "event",
        eventId,
        target.taskId,
        target.sessionId,
        target.inputId,
        eventProjection,
        duplicate ? "duplicate" : sequenceConflict ? "conflict" : "observed",
        event.observedAt,
        event.observedAt,
        nativeKey,
        executionRecord?.id ?? null,
      ),
    );

    let issueAdded = false;
    if (duplicate) {
      this.#addIssue(
        target.taskId,
        target.sessionId,
        payloadEqual ? "duplicate-event" : "event-conflict",
        event.eventId,
        payloadEqual
          ? `Duplicate native event ${event.eventId}; first delivery is retained.`
          : `Native event ID ${event.eventId} was reused with a different payload.`,
      );
      issueAdded = true;
    }
    if (sequenceConflict) {
      this.#addIssue(
        target.taskId,
        target.sessionId,
        "event-conflict",
        event.eventId,
        `Native source sequence ${event.sourceSequence} conflicts with event ${priorSameSequence!.data.nativeEventId}.`,
      );
      issueAdded = true;
    }
    if (gap) {
      this.#addIssue(
        target.taskId,
        target.sessionId,
        "sequence-gap",
        event.eventId,
        `Native source sequence gap before ${event.sourceSequence} in stream ${event.streamId}.`,
      );
      issueAdded = true;
    }
    if (outOfOrder) {
      this.#addIssue(
        target.taskId,
        target.sessionId,
        "out-of-order-event",
        event.eventId,
        `Native source sequence ${event.sourceSequence} arrived after a larger sequence in stream ${event.streamId}.`,
      );
      issueAdded = true;
    }
    if (!nativeMatches) {
      this.#addIssue(
        target.taskId,
        target.sessionId,
        "unmatched-event",
        event.eventId,
        "Event session or execution handle does not match the originating run; its original Task attribution is retained.",
      );
      issueAdded = true;
    }

    const taskIsTerminal = !["active", "frozen"].includes(taskRecord.data.status);
    const executionIsTerminal =
      executionRecord !== null && TERMINAL_EXECUTION_STATUSES.has(executionRecord.data.status);
    if (taskIsTerminal || (executionIsTerminal && !isTerminalEvent(event.type))) {
      this.#addIssue(
        target.taskId,
        target.sessionId,
        "late-event",
        event.eventId,
        `Late ${event.type} event retained for its original Task without reopening terminal state.`,
      );
      issueAdded = true;
    }

    if (duplicate || sequenceConflict || !nativeMatches) {
      this.#publish(target.taskId, "event", eventId);
      return false;
    }

    let terminalApplied = false;
    if (event.type === "input.accepted") {
      if (executionRecord) {
        if (executionRecord.data.nativeExecutionId !== event.executionId) {
          this.#addIssue(
            target.taskId,
            target.sessionId,
            "event-conflict",
            event.eventId,
            "Input acceptance conflicts with the persisted Engine execution mapping.",
          );
          return false;
        }
        this.#addIssue(
          target.taskId,
          target.sessionId,
          "duplicate-event",
          event.eventId,
          "A second acceptance event refers to an already accepted native Execution.",
        );
        issueAdded = true;
      } else if (event.evidence.source !== "engine") {
        this.#setInputUnknown(target, "Input acceptance did not include Engine evidence.");
        this.#addIssue(
          target.taskId,
          target.sessionId,
          "unmatched-event",
          event.eventId,
          "Input acceptance requires native Engine evidence.",
        );
        this.#publish(target.taskId, "event", eventId);
        return false;
      } else {
        const acceptedAt = event.observedAt;
        const createdId = this.#newId("execution");
        const execution: ExecutionData = {
          id: createdId,
          taskId: target.taskId,
          participantId: target.participantId,
          sessionId: target.sessionId,
          inputId: target.inputId,
          ...(this.#require<InputData>("input", target.inputId).data.revisionOf
            ? { revisionOf: this.#require<InputData>("input", target.inputId).data.revisionOf }
            : {}),
          status: "accepted",
          acceptedAt,
          startedAt: null,
          terminalAt: null,
          result: null,
          error: null,
          nativeExecutionId: target.nativeExecutionId,
        };
        this.#store.insert(
          this.#record(
            "execution",
            createdId,
            target.taskId,
            target.sessionId,
            target.inputId,
            execution,
            "accepted",
            acceptedAt,
            acceptedAt,
            String(target.nativeExecutionId),
            createdId,
          ),
        );
        const storedEvent = this.#require<EventData>("event", eventId);
        this.#save(
          "event",
          eventId,
          target.taskId,
          target.sessionId,
          target.inputId,
          { ...storedEvent.data, executionId: createdId },
          "observed",
          storedEvent.createdAt,
          storedEvent.updatedAt,
          nativeKey,
          createdId,
        );
        const updatedInput = this.#require<InputData>("input", target.inputId);
        updatedInput.data.status = "native-accepted";
        updatedInput.data.acceptedAt = acceptedAt;
        updatedInput.data.nativeExecutionId = target.nativeExecutionId;
        this.#save(
          "input",
          target.inputId,
          target.taskId,
          target.sessionId,
          target.inputId,
          updatedInput.data,
          updatedInput.data.status,
          updatedInput.createdAt,
          acceptedAt,
        );
      }
    } else if (!executionRecord) {
      this.#setInputUnknown(target, `Received ${event.type} before input.accepted evidence.`);
      this.#addIssue(
        target.taskId,
        target.sessionId,
        "unmatched-event",
        event.eventId,
        `${event.type} cannot create a product Execution before input.accepted evidence.`,
      );
      issueAdded = true;
    } else if (executionRecord) {
      const current = this.#require<ExecutionData>("execution", executionRecord.id);
      if (TERMINAL_EXECUTION_STATUSES.has(current.data.status) && isTerminalEvent(event.type)) {
        const incomingStatus = terminalStatus(event.type);
        if (incomingStatus && incomingStatus !== current.data.status) {
          this.#addIssue(
            target.taskId,
            target.sessionId,
            "contradictory-terminal",
            event.eventId,
            `Execution already has terminal status ${current.data.status}; conflicting ${incomingStatus} evidence was retained.`,
          );
          issueAdded = true;
        }
      } else if (!TERMINAL_EXECUTION_STATUSES.has(current.data.status)) {
        terminalApplied = this.#applyEvent(target, current, event, eventId);
      }
    }

    if (issueAdded || event.type === "input.accepted" || executionRecord) {
      this.#publish(target.taskId, "event", eventId);
    }
    return terminalApplied;
  }

  #applyEvent(
    target: RunTarget,
    execution: StoredRecord<ExecutionData>,
    event: EngineEvent,
    productEventId: string,
  ): boolean {
    const now = event.observedAt;
    const data = execution.data;
    const input = this.#require<InputData>("input", target.inputId);
    if (event.type === "execution.started") {
      if (event.evidence.source !== "engine") {
        this.#setInputUnknown(target, "Execution start lacks Engine evidence.");
        this.#addIssue(
          target.taskId,
          target.sessionId,
          "unmatched-event",
          event.eventId,
          "Execution start lacks Engine evidence.",
        );
        return false;
      }
      data.status = "started";
      data.startedAt ??= now;
      input.data.status = "started";
      input.data.startedAt ??= now;
    } else if (event.type === "execution.completed") {
      if (event.evidence.source !== "engine")
        return this.#invalidTerminal(target, event, "Completion requires Engine evidence.");
      data.status = "completed";
      data.result = event.result ?? null;
      data.terminalAt = now;
      input.data.status = "completed";
      input.data.terminalAt = now;
      this.#markStopRequestsUnconfirmed(
        target.taskId,
        execution.id,
        now,
        "Execution completed before native stop confirmation.",
      );
    } else if (event.type === "execution.failed") {
      if (event.evidence.source !== "engine")
        return this.#invalidTerminal(target, event, "Failure requires Engine evidence.");
      data.status = "failed";
      data.error = event.failure.message;
      data.terminalAt = now;
      input.data.status = "failed";
      input.data.error = event.failure.message;
      input.data.terminalAt = now;
      this.#markStopRequestsUnconfirmed(
        target.taskId,
        execution.id,
        now,
        "Execution failed before native stop confirmation.",
      );
    } else if (event.type === "execution.stopped") {
      if (event.evidence.source !== "engine")
        return this.#invalidTerminal(target, event, "Stop confirmation requires Engine evidence.");
      data.status = "stopped";
      data.terminalAt = now;
      input.data.status = "stopped";
      input.data.terminalAt = now;
      this.#confirmStopRequests(target.taskId, execution.id, now, event.evidence);
    } else if (event.type === "execution.unknown") {
      data.status = "unknown";
      data.error = event.reason;
      input.data.status = "unknown";
      input.data.error = event.reason;
      this.#markStopRequestsUnconfirmed(target.taskId, execution.id, now, event.reason);
    } else if (event.type === "approval.requested") {
      const id = this.#newId("approval");
      const approval: ApprovalData = {
        id,
        requestEventId: productEventId,
        taskId: target.taskId,
        participantId: target.participantId,
        sessionId: target.sessionId,
        executionId: execution.id,
        nativeApprovalId: event.approvalId,
        operation: event.operation,
        scope: event.scope ?? null,
        options: this.#jsonSafe(event.options) as RuntimeApproval["options"],
        ...(event.presentation
          ? {
              presentation: this.#jsonSafe(event.presentation) as RuntimeApproval["presentation"],
            }
          : {}),
        expiresAt: event.expiresAt,
        status: "pending",
        repliedOptionId: null,
      };
      this.#store.insert(
        this.#record(
          "approval",
          id,
          target.taskId,
          target.sessionId,
          execution.id,
          approval,
          "pending",
          now,
          now,
          controlKey(execution.data.nativeExecutionId, event.approvalId),
        ),
      );
      this.#publish(target.taskId, "approval", id);
    } else if (event.type === "approval.response") {
      const approval = this.#store.findByNativeKey<ApprovalData>(
        "approval",
        target.sessionId,
        controlKey(execution.data.nativeExecutionId, event.approvalId),
      );
      if (approval) {
        approval.data.status = mapReplyStatus(event.status);
        approval.data.repliedOptionId = event.optionId;
        this.#save(
          "approval",
          approval.id,
          target.taskId,
          target.sessionId,
          execution.id,
          approval.data,
          approval.data.status,
          approval.createdAt,
          now,
          approval.nativeKey,
        );
      }
    } else if (event.type === "user-input.requested") {
      const id = this.#newId("user-input");
      const request: UserInputData = {
        id,
        requestEventId: productEventId,
        taskId: target.taskId,
        participantId: target.participantId,
        sessionId: target.sessionId,
        executionId: execution.id,
        nativeRequestId: event.requestId,
        prompt: event.prompt,
        inputKind: event.inputKind,
        options: this.#jsonSafe(event.options ?? []) as RuntimeUserInput["options"],
        ...(event.presentation
          ? {
              presentation: this.#jsonSafe(event.presentation) as RuntimeUserInput["presentation"],
            }
          : {}),
        expiresAt: event.expiresAt,
        status: "pending",
        response: null,
      };
      this.#store.insert(
        this.#record(
          "user-input",
          id,
          target.taskId,
          target.sessionId,
          execution.id,
          request,
          "pending",
          now,
          now,
          controlKey(execution.data.nativeExecutionId, event.requestId),
        ),
      );
      this.#publish(target.taskId, "user-input", id);
    } else if (event.type === "user-input.response") {
      const request = this.#store.findByNativeKey<UserInputData>(
        "user-input",
        target.sessionId,
        controlKey(execution.data.nativeExecutionId, event.requestId),
      );
      if (request) {
        request.data.status = mapReplyStatus(event.status);
        if (event.response !== undefined) request.data.response = this.#clone(event.response);
        this.#save(
          "user-input",
          request.id,
          target.taskId,
          target.sessionId,
          execution.id,
          request.data,
          request.data.status,
          request.createdAt,
          now,
          request.nativeKey,
        );
      }
    } else if (event.type === "execution.interruption-requested") {
      const latest = this.#store
        .list<StopRequestData>("stop-request", target.taskId)
        .filter((record) => record.data.executionId === execution.id)
        .at(-1);
      if (latest && latest.data.deliveryStatus !== "not-requested") {
        if (latest.data.status !== "confirmed") latest.data.status = mapStopStatus(event.status);
        latest.data.deliveryStatus = mergeStopDelivery(
          latest.data.deliveryStatus,
          mapStopEventDelivery(event.status, event.evidence),
        );
        if (event.evidence?.source === "engine") latest.data.deliveryEvidence = event.evidence;
        latest.data.reason =
          event.status === "requested"
            ? null
            : "Engine did not confirm delivery of the stop request.";
        this.#save(
          "stop-request",
          latest.id,
          target.taskId,
          target.sessionId,
          execution.id,
          latest.data,
          latest.data.status,
          latest.createdAt,
          now,
        );
      }
      // Request acknowledgement is deliberately not a terminal execution transition.
    }
    this.#save(
      "execution",
      execution.id,
      target.taskId,
      target.sessionId,
      target.inputId,
      data,
      data.status,
      execution.createdAt,
      now,
      String(data.nativeExecutionId),
      execution.id,
    );
    this.#save(
      "input",
      target.inputId,
      target.taskId,
      target.sessionId,
      target.inputId,
      input.data,
      input.data.status,
      input.createdAt,
      now,
    );
    return TERMINAL_EXECUTION_STATUSES.has(data.status) && isTerminalEvent(event.type);
  }

  #invalidTerminal(target: RunTarget, event: EngineEvent, detail: string): false {
    this.#setInputUnknown(target, detail);
    this.#addIssue(target.taskId, target.sessionId, "unmatched-event", event.eventId, detail);
    return false;
  }

  #confirmStopRequests(
    taskId: string,
    executionId: string,
    observedAt: number,
    evidence: EngineEvidence,
  ): void {
    const allRequests = this.#store
      .list<StopRequestData>("stop-request", taskId)
      .filter((record) => record.data.executionId === executionId);
    const requests = allRequests.filter((record) =>
      ["requested", "unknown"].includes(record.data.status),
    );
    if (
      requests.length === 0 &&
      !allRequests.some((record) => record.data.status === "confirmed")
    ) {
      const execution = this.#require<ExecutionData>("execution", executionId);
      const id = this.#newId("stop");
      const confirmed: RuntimeStopRequest = {
        id,
        taskId,
        participantId: execution.data.participantId,
        sessionId: execution.data.sessionId,
        executionId,
        requestedAt: observedAt,
        status: "confirmed",
        deliveryStatus: "not-requested",
        deliveryEvidence: null,
        stopEvidence: evidence,
        reason: "Engine reported that the Execution stopped.",
      };
      this.#store.insert(
        this.#record(
          "stop-request",
          id,
          taskId,
          execution.data.sessionId,
          executionId,
          confirmed,
          "confirmed",
          observedAt,
        ),
      );
      this.#publish(taskId, "stop-request", id);
      return;
    }
    for (const record of requests) {
      record.data.status = "confirmed";
      record.data.deliveryStatus = record.data.deliveryStatus ?? "unknown";
      record.data.deliveryEvidence = record.data.deliveryEvidence ?? null;
      record.data.stopEvidence = evidence;
      record.data.reason = "Engine confirmed execution stopped.";
      this.#save(
        "stop-request",
        record.id,
        taskId,
        record.sessionId,
        executionId,
        record.data,
        "confirmed",
        record.createdAt,
        observedAt,
      );
      this.#publish(taskId, "stop-request", record.id);
    }
  }

  #markStopRequestsUnconfirmed(
    taskId: string,
    executionId: string,
    observedAt: number,
    reason: string,
  ): void {
    const requests = this.#store
      .list<StopRequestData>("stop-request", taskId)
      .filter(
        (record) =>
          record.data.executionId === executionId &&
          (record.data.status === "requested" || record.data.status === "unknown"),
      );
    for (const record of requests) {
      record.data.status = "unknown";
      if (!record.data.deliveryStatus || record.data.deliveryStatus === "pending")
        record.data.deliveryStatus = "unknown";
      record.data.deliveryEvidence = record.data.deliveryEvidence ?? null;
      record.data.stopEvidence = record.data.stopEvidence ?? null;
      record.data.reason = reason;
      this.#save(
        "stop-request",
        record.id,
        taskId,
        record.sessionId,
        executionId,
        record.data,
        "unknown",
        record.createdAt,
        observedAt,
      );
      this.#publish(taskId, "stop-request", record.id);
    }
  }

  #setInputUnknown(target: RunTarget, reason: string): void {
    const input = this.#store.get<InputData>("input", target.inputId);
    if (input && !TERMINAL_INPUT(input.data.status)) {
      input.data.status = "unknown";
      input.data.error = reason;
      this.#save(
        "input",
        input.id,
        target.taskId,
        target.sessionId,
        input.id,
        input.data,
        "unknown",
        input.createdAt,
        this.#now(),
      );
    }
    const execution = this.#findExecution(target.sessionId, target.nativeExecutionId);
    if (execution && !TERMINAL_EXECUTION_STATUSES.has(execution.data.status)) {
      execution.data.status = "unknown";
      execution.data.error = reason;
      this.#save(
        "execution",
        execution.id,
        target.taskId,
        target.sessionId,
        execution.data.inputId,
        execution.data,
        "unknown",
        execution.createdAt,
        this.#now(),
        execution.nativeKey,
        execution.id,
      );
    }
  }

  #findExecution(
    sessionId: string,
    nativeExecutionId: EngineExecutionRef,
  ): StoredRecord<ExecutionData> | null {
    return this.#store.findByNativeKey<ExecutionData>(
      "execution",
      sessionId,
      String(nativeExecutionId),
    );
  }

  #claimAttachments(
    task: StoredRecord<TaskData>,
    session: StoredRecord<SessionData>,
    inputId: string,
    references: readonly RuntimeAttachmentReference[],
  ): EngineAttachment[] {
    const now = this.#now();
    const claims = references.map((reference) => {
      const record = this.#store.get<AttachmentData>("attachment", reference.id);
      const data = record?.data;
      const locator = this.#attachmentLocators.get(reference.id);
      if (
        !record ||
        !data ||
        record.status !== "staged" ||
        data.status !== "staged" ||
        data.expiresAt <= now ||
        data.inputId !== null ||
        record.taskId !== task.id ||
        record.sessionId !== session.id ||
        data.taskId !== task.id ||
        data.participantId !== task.data.participantId ||
        data.sessionId !== session.id ||
        data.authorizationId !== task.data.authorization.id ||
        data.environmentId !== task.data.environment.id ||
        data.engineId !== task.data.engineId ||
        data.nativeSessionId !== session.data.nativeSessionId ||
        data.fileName !== reference.fileName ||
        data.mimeType !== reference.mimeType ||
        data.sizeBytes !== reference.sizeBytes ||
        !locator?.trim()
      ) {
        throw new RuntimeEligibilityError(
          "Attachment reference is expired or does not belong to this Task and Session.",
          "ownership",
        );
      }
      return { record, data, locator, reference };
    });
    for (const claim of claims) {
      claim.data.status = "claimed";
      claim.data.inputId = inputId;
      this.#store.update(
        this.#record(
          "attachment",
          claim.record.id,
          task.id,
          session.id,
          inputId,
          claim.data,
          "claimed",
          claim.record.createdAt,
          now,
        ),
      );
    }
    return claims.map(({ reference, locator }) => ({ ...reference, locator }));
  }

  async #qualifiedTaskSessionReadTarget(
    input: TaskLifecycleRequest,
  ): Promise<QualifiedTaskSessionReadTarget> {
    this.#assertOpen();
    const { task, session } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      "execution.run",
    );
    this.#requireActiveTask(task);
    if (session.data.projection.status !== "active")
      throw new RuntimeEligibilityError(`Session ${session.id} is not active.`, "terminal");
    const nativeSessionId = session.data.nativeSessionId;
    if (!nativeSessionId || this.#liveSessions.get(session.id) !== nativeSessionId)
      throw new RuntimeEligibilityError(
        "The Task has no verified native Session identity.",
        "ownership",
      );
    const qualifiedNativeSessionId = nativeSessionId as EngineSessionRef;

    const engine = this.#engineFor(task.data);
    const snapshot = await this.#capabilities(engine);
    this.#assertCapability(
      snapshot,
      task.data.engineId,
      task.data.environment.id,
      "execution.run",
      task.data.engine.configurationVersion,
      task.data.engine.adapterVersion,
    );
    this.#dispatchGuard({
      taskId: input.taskId,
      participantId: input.participantId,
      sessionId: input.sessionId,
      authorizationId: input.authorizationId,
      capability: "execution.run",
      engine,
      nativeSessionId: qualifiedNativeSessionId,
    })();
    return {
      taskId: task.id,
      participantId: task.data.participantId,
      sessionId: session.id,
      engineId: task.data.engineId,
      environment: this.#clone(task.data.environment),
      nativeSessionId: qualifiedNativeSessionId,
    };
  }

  #qualify(
    taskId: string,
    participantId: string,
    sessionId: string,
    authorizationId: string,
    scope: RuntimeAuthorizationScope,
    allowNonActiveTask = false,
    allowUnknownSession = false,
  ): { task: StoredRecord<TaskData>; session: StoredRecord<SessionData> } {
    const task = this.#require<TaskData>("task", taskId);
    const participant = this.#store.get<RuntimeParticipant>("participant", task.data.participantId);
    const session = this.#store.get<SessionData>("session", task.data.sessionId);
    if (
      !participant ||
      !session ||
      participant.status !== "active" ||
      task.data.participantId !== participantId ||
      task.data.sessionId !== sessionId ||
      participant.id !== participantId ||
      session.id !== sessionId ||
      task.id !== taskId ||
      session.taskId !== taskId ||
      participant.taskId !== taskId
    ) {
      throw new RuntimeEligibilityError("Task, participant, and Session ownership do not match.");
    }
    if (!allowNonActiveTask && task.data.status !== "active")
      throw new RuntimeEligibilityError(`Task ${taskId} is ${task.data.status}.`);
    const grant = task.data.authorization;
    if (
      grant.id !== authorizationId ||
      grant.environmentId !== task.data.environment.id ||
      grant.environmentId !== session.data.projection.environmentId
    ) {
      throw new RuntimeEligibilityError("Authorization does not belong to this Task environment.");
    }
    if (!grant.scopes.includes(scope))
      throw new RuntimeEligibilityError(`Authorization lacks ${scope} scope.`);
    if (grant.expiresAt !== null && this.#now() >= grant.expiresAt)
      throw new RuntimeEligibilityError("Authorization has expired.");
    if (
      session.data.projection.status !== "active" &&
      !(allowUnknownSession && session.data.projection.status === "unknown") &&
      scope !== "execution.interrupt" &&
      scope !== "task.freeze" &&
      scope !== "task.close"
    ) {
      throw new RuntimeEligibilityError(`Session is ${session.data.projection.status}.`);
    }
    return { task, session };
  }

  #assertNoUnresolvedSessionWork(taskId: string, sessionId: string): void {
    const input = this.#store
      .list<InputData>("input", taskId)
      .find(
        (record) =>
          record.sessionId === sessionId &&
          record.status !== null &&
          ACTIVE_INPUT_STATUSES.has(record.status),
      );
    const execution = this.#store
      .list<ExecutionData>("execution", taskId)
      .find(
        (record) =>
          record.data.sessionId === sessionId &&
          !TERMINAL_EXECUTION_STATUSES.has(record.data.status),
      );
    const compact = this.#store
      .list<RuntimeCompactOperation>("compact-operation", taskId)
      .find(
        (record) =>
          record.data.sessionId === sessionId && ACTIVE_COMPACT_STATUSES.has(record.data.status),
      );
    const fileRewind = this.#store
      .list<RuntimeFileRewindOperation>("file-rewind-operation", taskId)
      .find(
        (record) =>
          record.data.sessionId === sessionId &&
          (record.data.status === "requested" || record.data.status === "unknown"),
      );
    if (input || execution || compact || fileRewind)
      throw new RuntimeEligibilityError(
        `Session has unresolved native work${execution ? ` in Execution ${execution.id}` : input ? ` for Input ${input.id}` : compact ? ` in compaction ${compact.id}` : ` in file rewind ${fileRewind!.id}`}; reconcile it before restoring or submitting new work.`,
        "result-unknown",
      );
  }

  #dispatchGuard(input: {
    readonly taskId: string;
    readonly participantId: string;
    readonly sessionId: string;
    readonly authorizationId: string;
    readonly capability: EngineCapability & RuntimeAuthorizationScope;
    readonly engine: EngineAdapter;
    readonly nativeSessionId: EngineSessionRef;
  }): () => void {
    return () => {
      this.#assertOpen();
      const { task, session } = this.#qualify(
        input.taskId,
        input.participantId,
        input.sessionId,
        input.authorizationId,
        input.capability,
      );
      if (
        session.data.nativeSessionId !== input.nativeSessionId ||
        this.#liveSessions.get(session.id) !== input.nativeSessionId
      )
        throw new RuntimeEligibilityError(
          "The native Session is no longer attached to this Host.",
          "ownership",
        );

      const current = this.#currentEngineProjection(input.engine);
      if (current.state !== "current")
        throw new RuntimeEligibilityError(
          current.capabilities[input.capability].reason ??
            "Engine capability state is no longer current.",
          "temporarily-unavailable",
        );
      this.#assertCapability(
        this.#clone(input.engine.getCapabilities()),
        task.data.engineId,
        task.data.environment.id,
        input.capability,
        task.data.engine.configurationVersion,
        task.data.engine.adapterVersion,
      );
    };
  }

  #assertRelated(
    taskId: string,
    participantId: string,
    sessionId: string,
    input: { readonly taskId: string; readonly participantId: string; readonly sessionId: string },
  ): void {
    if (
      taskId !== input.taskId ||
      participantId !== input.participantId ||
      sessionId !== input.sessionId
    ) {
      throw new RuntimeEligibilityError(
        "The requested record belongs to a different Task, participant, or Session.",
      );
    }
  }

  #qualifyFileTarget(input: ExecutionFileTarget) {
    const { task, session } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      "workspace.file-rewind",
    );
    const execution = this.#require<ExecutionData>("execution", input.executionId);
    this.#assertRelated(
      execution.data.taskId,
      execution.data.participantId,
      execution.data.sessionId,
      input,
    );
    if (!TERMINAL_EXECUTION_STATUSES.has(execution.data.status))
      throw new RuntimeEligibilityError("File rewind requires a terminal Execution.", "terminal");
    const nativeSession = session.data.nativeSessionId;
    if (!nativeSession || this.#liveSessions.get(session.id) !== nativeSession)
      throw new RuntimeEligibilityError("The native Session is not attached in this Host.");
    const nativeExecution = execution.data.nativeExecutionId;
    if (!nativeExecution)
      throw new RuntimeEligibilityError("The Execution has no verified native handle.");
    return {
      task,
      session,
      execution,
      engine: this.#engineFor(task.data),
      nativeSession: nativeSession as EngineSessionRef,
      nativeExecution: nativeExecution as EngineExecutionRef,
    };
  }

  async #readyFileTarget(input: ExecutionFileTarget) {
    const initial = this.#qualifyFileTarget(input);
    const snapshot = await this.#capabilities(initial.engine);
    this.#assertCapability(
      snapshot,
      initial.task.data.engineId,
      initial.task.data.environment.id,
      "workspace.file-rewind",
      initial.task.data.engine.configurationVersion,
      initial.task.data.engine.adapterVersion,
    );
    const latest = this.#qualifyFileTarget(input);
    if (
      latest.nativeSession !== initial.nativeSession ||
      latest.nativeExecution !== initial.nativeExecution
    )
      throw new RuntimeEligibilityError("The native file rewind target changed.");
    return latest;
  }

  #requireActiveTask(task: StoredRecord<TaskData>): void {
    if (task.data.status !== "active")
      throw new RuntimeEligibilityError(`Task ${task.id} is ${task.data.status}.`);
  }

  #assertSessionIdle(
    taskId: string,
    sessionId: string,
    exceptCompactId?: string,
    exceptFileRewindId?: string,
  ): void {
    const pendingInput = this.#store
      .list<InputData>("input", taskId)
      .find(
        (record) =>
          record.sessionId === sessionId &&
          record.status !== null &&
          ACTIVE_INPUT_STATUSES.has(record.status),
      );
    if (pendingInput)
      throw new RuntimeEligibilityError(`Session already has unresolved input ${pendingInput.id}.`);
    this.#assertNoActiveCompact(taskId, sessionId, exceptCompactId);
    this.#assertNoActiveFileRewind(taskId, sessionId, exceptFileRewindId);
  }

  #assertNoActiveFileRewind(taskId: string, sessionId: string, exceptFileRewindId?: string): void {
    const pendingRewind = this.#store
      .list<RuntimeFileRewindOperation>("file-rewind-operation", taskId)
      .find(
        (record) =>
          record.data.sessionId === sessionId &&
          record.id !== exceptFileRewindId &&
          record.data.status === "requested",
      );
    if (pendingRewind)
      throw new RuntimeEligibilityError(
        `Session already has unresolved file rewind ${pendingRewind.id}.`,
      );
  }

  #assertNoUnknownFileRewind(taskId: string, executionId: string): void {
    const unknown = this.#store
      .list<RuntimeFileRewindOperation>("file-rewind-operation", taskId)
      .find(
        (record) => record.data.executionId === executionId && record.data.status === "unknown",
      );
    if (unknown)
      throw new RuntimeEligibilityError(
        `Execution has an unknown file rewind ${unknown.id}; native state needs reconciliation.`,
      );
  }

  #assertNoActiveCompact(taskId: string, sessionId: string, exceptCompactId?: string): void {
    const pendingCompact = this.#store
      .list<RuntimeCompactOperation>("compact-operation", taskId)
      .find(
        (record) =>
          record.data.sessionId === sessionId &&
          record.id !== exceptCompactId &&
          ACTIVE_COMPACT_STATUSES.has(record.data.status),
      );
    if (pendingCompact)
      throw new RuntimeEligibilityError(
        `Session already has unresolved compaction ${pendingCompact.id}.`,
      );
  }

  #validateEnvironmentAndAuthorization(
    environment: RuntimeEnvironment,
    authorization: RuntimeAuthorization,
    scope: RuntimeAuthorizationScope,
  ): void {
    if (!environment.id || authorization.environmentId !== environment.id)
      throw new RuntimeEligibilityError("Authorization and Task environment do not match.");
    if (
      authorization.issuer !== "host" ||
      !authorization.id ||
      !authorization.scopes.includes(scope)
    ) {
      throw new RuntimeEligibilityError(`Host authorization must include ${scope}.`);
    }
    if (authorization.expiresAt !== null && this.#now() >= authorization.expiresAt)
      throw new RuntimeEligibilityError("Authorization has expired.");
  }

  async #capabilities(engine: EngineAdapter): Promise<EngineCapabilitySnapshot> {
    const baseline = this.#clone(engine.getCapabilities());
    const engineId = baseline.engineId;
    const key = engineStateKey(baseline);
    const revision = (this.#capabilityRevisions.get(key) ?? 0) + 1;
    this.#capabilityRevisions.set(key, revision);
    this.#currentEngines.set(key, {
      revision,
      snapshot: null,
      observedSnapshot: baseline,
      projection: this.#unknownEngineProjection(
        engineId,
        Object.keys(baseline.capabilities) as EngineCapability[],
        "Capability state is being checked.",
        null,
      ),
    });

    if (!engine.refreshCapabilities) {
      if (this.#capabilityRevisions.get(key) === revision) {
        this.#currentEngines.set(key, {
          revision,
          snapshot: null,
          observedSnapshot: baseline,
          projection: this.#unknownEngineProjection(
            engineId,
            Object.keys(baseline.capabilities) as EngineCapability[],
            "Adapter does not provide an active capability probe; current status is unknown.",
            this.#now(),
          ),
        });
      }
      throw new RuntimeEligibilityError(
        "Engine capability status cannot be verified without an active probe.",
        "temporarily-unavailable",
      );
    }

    let snapshot: EngineCapabilitySnapshot;
    try {
      snapshot = this.#clone(await engine.refreshCapabilities());
    } catch {
      if (this.#capabilityRevisions.get(key) === revision) {
        this.#currentEngines.set(key, {
          revision,
          snapshot: null,
          observedSnapshot: baseline,
          projection: this.#unknownEngineProjection(
            engineId,
            Object.keys(baseline.capabilities) as EngineCapability[],
            "Capability refresh failed; current support and availability are unknown.",
            this.#now(),
          ),
        });
      }
      const latest = this.#currentEngines.get(key);
      if (latest?.snapshot && this.#currentEngineProjection(engine).state === "current") {
        const confirmed = this.#currentEngines.get(key);
        if (confirmed?.snapshot) return confirmed.snapshot;
      }
      throw new RuntimeEligibilityError(
        "Engine capability status could not be verified.",
        "temporarily-unavailable",
      );
    }

    if (this.#capabilityRevisions.get(key) !== revision) {
      const latest = this.#currentEngines.get(key);
      if (latest?.snapshot && this.#currentEngineProjection(engine).state === "current") {
        const confirmed = this.#currentEngines.get(key);
        if (confirmed?.snapshot) return confirmed.snapshot;
      }
      throw new RuntimeEligibilityError(
        "A newer Engine capability check is still unresolved.",
        "temporarily-unavailable",
      );
    }

    const observedSnapshot = this.#clone(engine.getCapabilities());
    if (!sameCapabilitySnapshot(snapshot, observedSnapshot)) {
      this.#currentEngines.set(key, {
        revision,
        snapshot: null,
        observedSnapshot,
        projection: this.#unknownEngineProjection(
          engineId,
          Object.keys(observedSnapshot.capabilities) as EngineCapability[],
          "Adapter state changed during capability refresh; a new probe is required.",
          this.#now(),
        ),
      });
      throw new RuntimeEligibilityError(
        "Engine capability state changed during refresh; retry after a new probe.",
        "temporarily-unavailable",
      );
    }

    this.#currentEngines.set(key, {
      revision,
      snapshot,
      observedSnapshot,
      projection: this.#toCurrentEngineProjection(snapshot),
    });
    return snapshot;
  }

  #assertCapability(
    snapshot: ReturnType<EngineAdapter["getCapabilities"]>,
    expectedEngineId: string,
    environmentId: string,
    capability: EngineCapability,
    expectedConfigurationVersion?: string | null,
    expectedAdapterVersion?: string,
  ): void {
    if (snapshot.engineId !== expectedEngineId || snapshot.environment !== environmentId) {
      throw new RuntimeEligibilityError(
        `Engine identity or environment changed (expected ${expectedEngineId}/${environmentId}).`,
        "result-unknown",
      );
    }
    if (
      expectedConfigurationVersion !== undefined &&
      snapshot.configurationVersion !== expectedConfigurationVersion
    ) {
      throw new RuntimeEligibilityError(
        "Engine configuration changed; the Task authorization snapshot is stale.",
        "authorization-required",
      );
    }
    if (
      expectedAdapterVersion !== undefined &&
      snapshot.adapterVersion !== expectedAdapterVersion
    ) {
      throw new RuntimeEligibilityError(
        "Engine adapter changed; the Task authorization snapshot is stale.",
        "authorization-required",
      );
    }
    const status = snapshot.capabilities[capability];
    if (status.support !== "supported" || status.availability !== "available") {
      const kind: RuntimeErrorKind =
        status.support === "unsupported"
          ? "unsupported"
          : status.availability === "temporarily-unavailable"
            ? "temporarily-unavailable"
            : status.availability === "authorization-required"
              ? "authorization-required"
              : "result-unknown";
      throw new RuntimeEligibilityError(
        status.reason ??
          `Engine capability ${capability} is ${status.support}/${status.availability}.`,
        kind,
      );
    }
  }

  #engineFor(task: TaskData): EngineAdapter {
    const engine =
      this.#engineForEnvironment?.(task.engineId, task.environment) ??
      this.#engines.get(task.engineId);
    if (!engine)
      throw new RuntimeEligibilityError(`Engine ${task.engineId} is not registered in this Host.`);
    return engine;
  }

  #markRecoveredStateUnknown(): void {
    const recoveredAt = this.#now();
    for (const session of this.#store.list<SessionData>("session")) {
      if (
        session.data.projection.status !== "active" &&
        session.data.projection.status !== "creating"
      )
        continue;
      session.data.projection = {
        ...session.data.projection,
        status: "unknown",
        updatedAt: recoveredAt,
      };
      this.#save(
        "session",
        session.id,
        session.taskId,
        session.id,
        null,
        session.data,
        "unknown",
        session.createdAt,
        recoveredAt,
      );
      this.#addIssue(
        session.taskId,
        session.id,
        "stream-ended-unknown",
        null,
        "Runtime restarted before this native Session could be reattached; verify its execution state before continuing.",
      );
      for (const input of this.#store.list<InputData>("input", session.taskId)) {
        if (input.data.sessionId !== session.id) continue;
        if (input.data.status === "queued") {
          input.data.status = "rejected";
          input.data.error =
            "Runtime restarted before this queued Input was dispatched; it was not sent.";
          input.data.terminalAt = recoveredAt;
        } else if (ACTIVE_INPUT_STATUSES.has(input.data.status)) {
          input.data.status = "unknown";
          input.data.error =
            "Runtime restarted; explicit native Execution reconciliation is required before continuing.";
        } else continue;
        this.#save(
          "input",
          input.id,
          input.taskId,
          session.id,
          input.id,
          input.data,
          input.data.status,
          input.createdAt,
          recoveredAt,
        );
      }
      for (const execution of this.#store.list<ExecutionData>("execution", session.taskId)) {
        if (
          execution.data.sessionId !== session.id ||
          TERMINAL_EXECUTION_STATUSES.has(execution.data.status)
        )
          continue;
        execution.data.status = "unknown";
        execution.data.error =
          "Runtime restarted; explicit native Execution reconciliation is required before continuing.";
        this.#save(
          "execution",
          execution.id,
          execution.taskId,
          session.id,
          execution.data.inputId,
          execution.data,
          "unknown",
          execution.createdAt,
          recoveredAt,
          execution.nativeKey,
          execution.id,
        );
      }
      for (const operation of this.#store.list<RuntimeCompactOperation>(
        "compact-operation",
        session.taskId,
      )) {
        if (
          operation.data.sessionId !== session.id ||
          !ACTIVE_COMPACT_STATUSES.has(operation.data.status)
        )
          continue;
        const data: RuntimeCompactOperation = {
          ...operation.data,
          status: "unknown",
          unknownEvidence: {
            source: "host",
            evidenceId: `${operation.id}:restart`,
            detail: "Runtime restarted before native compaction reached terminal evidence.",
          },
          reason: "Runtime restarted; native compaction cannot be safely reattached or resent.",
        };
        this.#save(
          "compact-operation",
          operation.id,
          operation.taskId,
          session.id,
          null,
          data,
          data.status,
          operation.createdAt,
          recoveredAt,
          operation.id,
        );
      }
      for (const operation of this.#store.list<RuntimeFileRewindOperation>(
        "file-rewind-operation",
        session.taskId,
      )) {
        if (operation.data.sessionId !== session.id || operation.data.status !== "requested")
          continue;
        const data: RuntimeFileRewindOperation = {
          ...operation.data,
          status: "unknown",
          evidence: {
            source: "host",
            evidenceId: `${operation.id}:restart`,
            detail: "Runtime restarted before native file rewind result was known.",
          },
          reason: "Native file rewind cannot be automatically resent after restart.",
        };
        this.#save(
          "file-rewind-operation",
          operation.id,
          operation.taskId,
          session.id,
          null,
          data,
          data.status,
          operation.createdAt,
          recoveredAt,
          operation.id,
          data.executionId,
        );
      }
    }
  }

  #taskProjection(record: StoredRecord<TaskData>): RuntimeTask {
    const participant = this.#store.get<RuntimeParticipant>(
      "participant",
      record.data.participantId,
    );
    const session = this.#store.get<SessionData>("session", record.data.sessionId);
    if (!participant || !session)
      throw new Error(`Task ${record.id} has incomplete ownership records.`);
    return this.#clone({
      id: record.id,
      authorizationId: record.data.authorization.id,
      status: record.data.status,
      createdAt: record.data.createdAt,
      updatedAt: record.data.updatedAt,
      closedAt: record.data.closedAt,
      closeReason: record.data.closeReason,
      ...(record.data.forkedFrom ? { forkedFrom: record.data.forkedFrom } : {}),
      ...(record.data.sharedContext ? { sharedContext: record.data.sharedContext } : {}),
      engine: record.data.engine,
      currentEngine: this.#engines.has(record.data.engineId)
        ? this.#currentEngineProjection(this.#engineFor(record.data))
        : this.#unknownEngineProjection(
            record.data.engineId,
            Object.keys(record.data.engine.capabilities) as EngineCapability[],
            "Engine adapter is not loaded in this Host.",
            null,
          ),
      environment: record.data.environment,
      credentialSource: record.data.credentialSource,
      participant: participant.data,
      session: { ...session.data.projection, nativeSessionId: session.data.nativeSessionId },
    });
  }

  #history(taskId: string): TaskHistory {
    return this.#clone({
      taskId,
      inputs: this.#store
        .list<InputData>("input", taskId)
        .map((record) => this.#publicInput(record.data)),
      executions: this.#store
        .list<ExecutionData>("execution", taskId)
        .map((record) => this.#publicExecution(record.data)),
      events: this.#store
        .list<EventData>("event", taskId)
        .map((record) => this.#publicEvent(record.data)),
      approvals: this.#store
        .list<ApprovalData>("approval", taskId)
        .map((record) => this.#publicApproval(record.data)),
      userInputs: this.#store
        .list<UserInputData>("user-input", taskId)
        .map((record) => this.#publicUserInput(record.data)),
      stopRequests: this.#store.list<RuntimeStopRequest>("stop-request", taskId).map((record) => ({
        ...record.data,
        deliveryStatus: record.data.deliveryStatus ?? legacyStopDeliveryStatus(record.data),
        deliveryEvidence: record.data.deliveryEvidence ?? null,
        stopEvidence: record.data.stopEvidence ?? null,
      })),
      compactOperations: this.#store
        .list<RuntimeCompactOperation>("compact-operation", taskId)
        .map((record) => record.data),
      fileRewindOperations: this.#store
        .list<RuntimeFileRewindOperation>("file-rewind-operation", taskId)
        .map((record) => record.data),
      integrityIssues: this.#store
        .list<RuntimeIntegrityIssue>("integrity-issue", taskId)
        .map((record) => record.data),
    });
  }

  #publicInput(data: InputData): RuntimeInput {
    const {
      nativeExecutionId: _nativeExecutionId,
      nativeRevisionCommandId: _nativeRevisionCommandId,
      authorizationId: _authorizationId,
      idempotencyKey: _idempotencyKey,
      requestedDelivery: _requestedDelivery,
      ...projection
    } = data;
    return projection;
  }

  #publicEvent(data: EventData): RuntimeEvent {
    const { canonicalPayload: _canonicalPayload, ...projection } = data;
    return projection;
  }

  #publicExecution(data: ExecutionData): RuntimeExecution {
    const { nativeExecutionId: _nativeExecutionId, ...projection } = data;
    return projection;
  }

  #publicApproval(data: ApprovalData): RuntimeApproval {
    const { nativeApprovalId: _nativeApprovalId, ...projection } = data;
    return this.#clone(projection);
  }

  #publicUserInput(data: UserInputData): RuntimeUserInput {
    const { nativeRequestId: _nativeRequestId, ...projection } = data;
    return this.#clone(projection);
  }

  #publicEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const safe = this.#jsonSafe(payload) as Record<string, unknown>;
    delete safe.session;
    delete safe.executionId;
    delete safe.approvalId;
    delete safe.requestId;
    return safe;
  }

  #toEngineProjection(
    snapshot: ReturnType<EngineAdapter["getCapabilities"]>,
  ): RuntimeEngineProjection {
    return this.#clone({
      engineId: snapshot.engineId,
      adapterVersion: snapshot.adapterVersion,
      engineVersion: snapshot.engineVersion,
      configurationVersion: snapshot.configurationVersion,
      environment: snapshot.environment,
      capabilities: snapshot.capabilities,
    });
  }

  #toCurrentEngineProjection(snapshot: EngineCapabilitySnapshot): RuntimeCurrentEngineProjection {
    return this.#clone({
      ...this.#toEngineProjection(snapshot),
      state: "current" as const,
      observedAt: this.#now(),
      source: "active-probe" as const,
    });
  }

  #unknownEngineProjection(
    engineId: string,
    capabilityNames: readonly EngineCapability[],
    reason: string,
    observedAt: number | null,
  ): RuntimeCurrentEngineProjection {
    const capabilities = Object.fromEntries(
      capabilityNames.map((name) => [
        name,
        { support: "unknown", availability: "unknown", reason },
      ]),
    ) as RuntimeCurrentEngineProjection["capabilities"];
    return {
      engineId,
      adapterVersion: null,
      engineVersion: null,
      configurationVersion: null,
      environment: null,
      capabilities,
      state: "unknown",
      observedAt,
      source: "unknown",
    };
  }

  #currentEngineProjection(engine: EngineAdapter): RuntimeCurrentEngineProjection {
    const current = this.#clone(engine.getCapabilities());
    const key = engineStateKey(current);
    const record = this.#currentEngines.get(key);
    if (!record) {
      return this.#unknownEngineProjection(
        current.engineId,
        Object.keys(current.capabilities) as EngineCapability[],
        "Capability state has not been checked in this Host.",
        null,
      );
    }

    if (!sameCapabilitySnapshot(current, record.snapshot ?? record.observedSnapshot)) {
      const revision = (this.#capabilityRevisions.get(key) ?? record.revision) + 1;
      this.#capabilityRevisions.set(key, revision);
      const projection = this.#unknownEngineProjection(
        current.engineId,
        Object.keys(current.capabilities) as EngineCapability[],
        "Adapter state changed since its last probe; a new probe is required.",
        this.#now(),
      );
      this.#currentEngines.set(key, {
        revision,
        snapshot: null,
        observedSnapshot: current,
        projection,
      });
      return projection;
    }

    return record.projection;
  }

  #requireTaskProjection(taskId: string): RuntimeTask {
    const task = this.#store.get<TaskData>("task", taskId);
    if (!task) throw new Error(`Missing Task ${taskId}.`);
    return this.#taskProjection(task);
  }

  #require<T>(kind: string, id: string): StoredRecord<T> {
    const record = this.#store.get<T>(kind, id);
    if (!record) throw new RuntimeEligibilityError(`${kind} ${id} does not exist.`);
    return record;
  }

  #record<T>(
    kind: string,
    id: string,
    taskId: string,
    sessionId: string | null,
    inputId: string | null,
    data: T,
    status: string | null,
    createdAt: number,
    updatedAt = createdAt,
    nativeKey: string | null = null,
    executionId: string | null = null,
  ): StoredRecord<T> {
    return {
      kind,
      id,
      taskId,
      sessionId,
      inputId,
      executionId,
      nativeKey,
      status,
      createdAt,
      updatedAt,
      data,
    };
  }

  #save<T>(
    kind: string,
    id: string,
    taskId: string,
    sessionId: string | null,
    inputId: string | null,
    data: T,
    status: string | null,
    createdAt: number,
    updatedAt: number,
    nativeKey?: string | null,
    executionId?: string | null,
  ): void {
    const previous = this.#store.get<T>(kind, id);
    const record = this.#record(
      kind,
      id,
      taskId,
      sessionId,
      inputId,
      data,
      status,
      createdAt,
      updatedAt,
      nativeKey === undefined ? (previous?.nativeKey ?? null) : nativeKey,
      executionId === undefined ? (previous?.executionId ?? null) : executionId,
    );
    if (previous) this.#store.update(record);
    else this.#store.insert(record);
  }

  #updateCompactOperation(
    id: string,
    changes: Partial<RuntimeCompactOperation>,
  ): RuntimeCompactOperation {
    const record = this.#require<RuntimeCompactOperation>("compact-operation", id);
    const data = { ...record.data, ...changes };
    const updatedAt = this.#now();
    this.#save(
      "compact-operation",
      id,
      record.taskId,
      record.sessionId,
      null,
      data,
      data.status,
      record.createdAt,
      updatedAt,
      id,
    );
    this.#publish(record.taskId, "compact-operation", id);
    return this.#clone(data);
  }

  #finishFileRewind(
    id: string,
    changes: Pick<RuntimeFileRewindOperation, "status" | "terminalAt" | "evidence" | "reason">,
  ): RuntimeFileRewindOperation {
    const record = this.#require<RuntimeFileRewindOperation>("file-rewind-operation", id);
    const data = { ...record.data, ...changes };
    this.#save(
      "file-rewind-operation",
      id,
      record.taskId,
      record.sessionId,
      null,
      data,
      data.status,
      record.createdAt,
      this.#now(),
      id,
      data.executionId,
    );
    this.#publish(record.taskId, "file-rewind-operation", id);
    return this.#clone(data);
  }

  #addIssue(
    taskId: string,
    sessionId: string,
    type: RuntimeIntegrityIssue["type"],
    eventId: string | null,
    detail: string,
  ): void {
    const id = this.#newId("issue");
    const occurredAt = this.#now();
    const issue: RuntimeIntegrityIssue = {
      id,
      taskId,
      sessionId,
      type,
      occurredAt,
      eventId,
      detail,
    };
    this.#store.insert(
      this.#record("integrity-issue", id, taskId, sessionId, null, issue, type, occurredAt),
    );
    this.#publish(taskId, "integrity-issue", id);
  }

  #publish(taskId: string, kind: RuntimeChange["kind"], entityId: string): void {
    if (this.#closed) return;
    if (this.#pendingChanges) {
      this.#pendingChanges.push({ taskId, kind, entityId });
      return;
    }
    this.#dispatchChange(taskId, kind, entityId);
  }

  #dispatchChange(taskId: string, kind: RuntimeChange["kind"], entityId: string): void {
    if (this.#closed) return;
    const change: RuntimeChange = this.#clone({
      kind,
      taskId,
      entityId,
      occurredAt: this.#now(),
      task: this.getTask(taskId),
      history: this.getHistory(taskId),
    });
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch {
        /* Subscribers cannot change Runtime state. */
      }
    }
  }

  #newId(kind: RuntimeIdKind): string {
    const id = this.#idFactory(kind);
    if (!id || typeof id !== "string")
      throw new Error(`ID factory returned an invalid ${kind} ID.`);
    return id;
  }

  async #withCommandLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.#commandLocks.has(key))
      throw new RuntimeEligibilityError(`Command ${key} is already in progress.`);
    this.#commandLocks.add(key);
    try {
      return await operation();
    } finally {
      this.#commandLocks.delete(key);
    }
  }

  #withAssistantFeedbackLock(
    key: string,
    feedback: SetAssistantFeedback["feedback"],
    operation: () => Promise<RuntimeAssistantFeedbackResult>,
  ): Promise<RuntimeAssistantFeedbackResult> {
    const existing = this.#assistantFeedbackInFlight.get(key);
    if (existing?.feedback === feedback) return existing.promise;
    let request!: {
      readonly feedback: SetAssistantFeedback["feedback"];
      readonly promise: Promise<RuntimeAssistantFeedbackResult>;
    };
    const previous = existing?.promise.catch(() => undefined) ?? Promise.resolve(undefined);
    const promise = previous.then(operation).then(
      (result) => {
        if (this.#assistantFeedbackInFlight.get(key) === request)
          this.#assistantFeedbackInFlight.delete(key);
        return result;
      },
      (error: unknown) => {
        if (this.#assistantFeedbackInFlight.get(key) === request)
          this.#assistantFeedbackInFlight.delete(key);
        throw error;
      },
    );
    request = { feedback, promise };
    this.#assistantFeedbackInFlight.set(key, request);
    return promise;
  }

  #clone<T>(value: T): T {
    return this.#jsonSafe(value) as T;
  }

  #jsonSafe(value: unknown): unknown {
    const seen = new WeakSet<object>();
    const visit = (item: unknown): unknown => {
      if (item === null || typeof item === "string" || typeof item === "boolean") return item;
      if (typeof item === "number") return Number.isFinite(item) ? item : null;
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "undefined") return null;
      if (typeof item !== "object") return String(item);
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
      if (Array.isArray(item)) return item.map(visit);
      if (item instanceof Date) return item.toISOString();
      if (item instanceof Map)
        return Object.fromEntries(
          [...item.entries()].map(([key, nested]) => [String(key), visit(nested)]),
        );
      if (item instanceof Set) return [...item].map(visit);
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, visit(nested)]));
    };
    return visit(value);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("TaskRuntime is closed.");
  }
}

export function createTaskRuntime(options: CreateTaskRuntimeOptions): TaskRuntime {
  return new TaskRuntime(options);
}

function sameCapabilitySnapshot(
  left: EngineCapabilitySnapshot,
  right: EngineCapabilitySnapshot,
): boolean {
  if (
    left.engineId !== right.engineId ||
    left.adapterVersion !== right.adapterVersion ||
    left.engineVersion !== right.engineVersion ||
    left.configurationVersion !== right.configurationVersion ||
    left.environment !== right.environment
  ) {
    return false;
  }
  const names = Object.keys(left.capabilities) as EngineCapability[];
  return (
    names.length === Object.keys(right.capabilities).length &&
    names.every((name) => {
      const first = left.capabilities[name];
      const second = right.capabilities[name];
      if (!second) return false;
      return (
        first.support === second.support &&
        first.availability === second.availability &&
        first.reason === second.reason
      );
    })
  );
}

function runKey(sessionId: string, executionId: EngineExecutionRef): string {
  return `${sessionId}\u0000${executionId}`;
}

function controlKey(executionId: string, controlId: string): string {
  return JSON.stringify([executionId, controlId]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isKnownNoSideEffect(error: unknown): boolean {
  return (
    error instanceof RuntimeEligibilityError ||
    (error instanceof EngineContractError && error.failure.sideEffects === "none")
  );
}

function mapStopStatus(status: string): RuntimeStopRequest["status"] {
  if (status === "requested") return "requested";
  if (status === "unsupported") return "unsupported";
  if (status === "temporarily-unavailable") return "temporarily-unavailable";
  if (status === "authorization-required") return "authorization-required";
  return "unknown";
}

function mapStopDelivery(
  status: EngineCommandReceipt["status"],
  evidence: EngineEvidence | undefined,
): RuntimeStopRequest["deliveryStatus"] {
  if (status === "requested") return evidence?.source === "engine" ? "delivered" : "unknown";
  if (
    status === "closed" ||
    status === "unsupported" ||
    status === "temporarily-unavailable" ||
    status === "authorization-required"
  )
    return "not-delivered";
  return "unknown";
}

function mapStopEventDelivery(
  status: Extract<EngineEvent, { readonly type: "execution.interruption-requested" }>["status"],
  evidence: EngineEvidence | undefined,
): RuntimeStopRequest["deliveryStatus"] {
  if (status === "requested") return evidence?.source === "engine" ? "delivered" : "unknown";
  if (status === "unsupported" || status === "temporarily-unavailable") return "not-delivered";
  return "unknown";
}

function mergeStopDelivery(
  current: RuntimeStopRequest["deliveryStatus"] | undefined,
  incoming: RuntimeStopRequest["deliveryStatus"],
): RuntimeStopRequest["deliveryStatus"] {
  if (current === "not-requested") return current;
  if (incoming === "delivered" || current === "delivered") return "delivered";
  if (incoming === "not-delivered") return "not-delivered";
  if (incoming !== "pending") return incoming;
  return current ?? "pending";
}

function legacyStopDeliveryStatus(
  request: Pick<RuntimeStopRequest, "status" | "reason">,
): RuntimeStopRequest["deliveryStatus"] {
  if (request.reason === "Engine reported that the Execution stopped.") return "not-requested";
  if (
    request.status === "unsupported" ||
    request.status === "temporarily-unavailable" ||
    request.status === "authorization-required"
  )
    return "not-delivered";
  return "unknown";
}

function mapReplyStatus(status: string): RuntimeApproval["status"] {
  if (status === "forwarded") return "forwarded";
  if (status === "expired") return "expired";
  if (status === "unknown") return "unknown";
  if (status === "unsupported") return "unsupported";
  if (status === "already-answered") return "already-answered";
  return "rejected";
}

function isTerminalEvent(type: EngineEvent["type"]): boolean {
  return (
    type === "execution.completed" || type === "execution.failed" || type === "execution.stopped"
  );
}

function terminalStatus(type: EngineEvent["type"]): RuntimeExecution["status"] | null {
  if (type === "execution.completed") return "completed";
  if (type === "execution.failed") return "failed";
  if (type === "execution.stopped") return "stopped";
  return null;
}

function eventPayload(event: EngineEvent): Record<string, unknown> {
  const {
    eventId: _eventId,
    streamId: _streamId,
    sourceSequence: _sourceSequence,
    deliverySequence: _deliverySequence,
    observedAt: _observedAt,
    source: _source,
    session: _session,
    executionId: _executionId,
    ...payload
  } = event;
  return payload as Record<string, unknown>;
}

function TERMINAL_INPUT(status: RuntimeInput["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "stopped" ||
    status === "rejected" ||
    status === "cancelled"
  );
}

export type { RuntimeAuthorization, RuntimeEnvironment };
