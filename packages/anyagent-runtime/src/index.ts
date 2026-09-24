/* oxlint-disable eslint(max-lines) -- This module is the single owner of Task qualification and the SQLite-backed evidence transition state machine. */
import { randomUUID } from "node:crypto";
import {
  EngineContractError,
  type EngineAdapter,
  type EngineApprovalRef,
  type EngineCapability,
  type EngineCapabilitySnapshot,
  type EngineEvent,
  type EngineExecutionRef,
  type EngineSessionRef,
  type EngineUserInputRef,
} from "@anyagent/engine-contract";
import { RuntimeStore, type StoredRecord } from "./store.js";
import type {
  CreateTaskInput,
  ReplyToApproval,
  ReplyToUserInput,
  RequestStop,
  RuntimeApproval,
  RuntimeAuthorization,
  RuntimeAuthorizationScope,
  RuntimeChange,
  RuntimeCredentialSource,
  RuntimeCurrentEngineProjection,
  RuntimeEngineProjection,
  RuntimeEnvironment,
  RuntimeEvent,
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
}

interface TaskData {
  readonly engineId: string;
  readonly engine: RuntimeEngineProjection;
  readonly environment: RuntimeEnvironment;
  readonly credentialSource: RuntimeCredentialSource;
  readonly authorization: RuntimeAuthorization;
  readonly participantId: string;
  readonly sessionId: string;
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
type InputData = Mutable<RuntimeInput> & { nativeExecutionId: string | null };
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

const ACTIVE_INPUT_STATUSES = new Set(["received", "native-accepted", "started", "unknown"]);
const TERMINAL_EXECUTION_STATUSES = new Set(["completed", "failed", "stopped"]);

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
  readonly #now: () => number;
  readonly #idFactory: (kind: RuntimeIdKind) => string;
  readonly #listeners = new Set<(change: RuntimeChange) => void>();
  readonly #runs = new Map<string, RunTarget>();
  readonly #liveSessions = new Map<string, EngineSessionRef>();
  readonly #commandLocks = new Set<string>();
  readonly #capabilityRevisions = new Map<string, number>();
  readonly #currentEngines = new Map<string, CurrentEngineRecord>();
  #pendingChanges: { kind: RuntimeChange["kind"]; taskId: string; entityId: string }[] | null =
    null;
  #closed = false;

  constructor(options: CreateTaskRuntimeOptions) {
    this.#store = new RuntimeStore(options.databasePath);
    this.#engines = options.engines;
    this.#engineForEnvironment = options.engineForEnvironment;
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

  getHistory(taskId: string): TaskHistory | null {
    this.#assertOpen();
    if (!this.#store.get<TaskData>("task", taskId)) return null;
    return this.#history(taskId);
  }

  async createTask(input: CreateTaskInput): Promise<RuntimeTask> {
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
    this.#assertCapability(snapshot, input.engineId, input.environment.id, "session.create");

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
        "session.create",
        snapshot.configurationVersion,
        snapshot.adapterVersion,
      );
      const nativeSessionId = await engine.createSession();
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

  async submitInput(input: SubmitInput): Promise<RuntimeInput> {
    this.#assertOpen();
    const { task, session } = this.#qualify(
      input.taskId,
      input.participantId,
      input.sessionId,
      input.authorizationId,
      "execution.run",
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

    const pending = this.#store
      .list<InputData>("input", task.id)
      .find(
        (record) =>
          record.sessionId === input.sessionId &&
          record.status !== null &&
          ACTIVE_INPUT_STATUSES.has(record.status),
      );
    if (pending)
      throw new RuntimeEligibilityError(`Session already has unresolved input ${pending.id}.`);

    const id = this.#newId("input");
    const receivedAt = this.#now();
    const data: InputData = {
      id,
      taskId: task.id,
      participantId: input.participantId,
      sessionId: input.sessionId,
      text: input.text,
      status: "received",
      receivedAt,
      acceptedAt: null,
      startedAt: null,
      terminalAt: null,
      error: null,
      nativeExecutionId: null,
    };
    this.#store.transaction(() => {
      // Check and insert under one SQLite write transaction to serialize concurrent submissions.
      const active = this.#store
        .list<InputData>("input", task.id)
        .find(
          (record) =>
            record.sessionId === input.sessionId &&
            record.status !== null &&
            ACTIVE_INPUT_STATUSES.has(record.status),
        );
      if (active)
        throw new RuntimeEligibilityError(`Session already has unresolved input ${active.id}.`);
      this.#store.insert(
        this.#record("input", id, task.id, input.sessionId, id, data, data.status, receivedAt),
      );
    });
    this.#publish(task.id, "input", id);

    try {
      const nativeSessionId = session.data.nativeSessionId;
      if (!nativeSessionId)
        throw new RuntimeEligibilityError("The native Session handle is unavailable.");
      const latest = await this.#capabilities(engine);
      this.#assertCapability(
        latest,
        task.data.engineId,
        task.data.environment.id,
        "execution.run",
        task.data.engine.configurationVersion,
        task.data.engine.adapterVersion,
      );
      this.#qualify(
        input.taskId,
        input.participantId,
        input.sessionId,
        input.authorizationId,
        "execution.run",
      );
      const run = await engine.run({
        session: nativeSessionId as EngineSessionRef,
        input: input.text,
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
      if (resolved.data.status !== "pending") return this.#publicUserInput(resolved.data);
      const status = mapReplyStatus(receipt.status);
      const updated: UserInputData = {
        ...latest.data,
        status,
        response: this.#jsonSafe(input.response),
      };
      this.#save(
        "user-input",
        latest.id,
        task.id,
        input.sessionId,
        latest.executionId,
        updated,
        status,
        latest.createdAt,
        this.#now(),
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
        if (current.data.status === "confirmed") return current.data;
        request = {
          ...request,
          status: mapStopStatus(receipt.status),
          reason: receipt.reason ?? null,
        };
      } catch (error) {
        const current = this.#require<RuntimeStopRequest>("stop-request", id);
        if (current.data.status === "confirmed") return current.data;
        request = {
          ...request,
          status: error instanceof EngineContractError ? mapStopStatus(error.kind) : "unknown",
          reason: errorMessage(error),
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
      if (unresolvedInput || unresolvedExecution) {
        throw new RuntimeEligibilityError(
          "Cannot close a Task with unresolved input or Execution evidence; use abandoned to close without claiming an outcome.",
        );
      }
    }
    const closedAt = this.#now();
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
    this.#store.close();
  }

  async #consumeRun(target: RunTarget, events: AsyncIterable<EngineEvent>): Promise<void> {
    let gotTerminal = false;
    try {
      for await (const event of events) {
        const terminal = this.#processEvent(target, event);
        if (terminal) gotTerminal = true;
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
      }
    } finally {
      this.#runs.delete(runKey(target.sessionId, target.nativeExecutionId));
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
        terminalApplied = this.#applyEvent(target, current, event);
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
    } else if (event.type === "execution.failed") {
      if (event.evidence.source !== "engine")
        return this.#invalidTerminal(target, event, "Failure requires Engine evidence.");
      data.status = "failed";
      data.error = event.failure.message;
      data.terminalAt = now;
      input.data.status = "failed";
      input.data.error = event.failure.message;
      input.data.terminalAt = now;
    } else if (event.type === "execution.stopped") {
      if (event.evidence.source !== "engine")
        return this.#invalidTerminal(target, event, "Stop confirmation requires Engine evidence.");
      data.status = "stopped";
      data.terminalAt = now;
      input.data.status = "stopped";
      input.data.terminalAt = now;
      this.#confirmStopRequests(target.taskId, execution.id, now);
    } else if (event.type === "execution.unknown") {
      data.status = "unknown";
      data.error = event.reason;
      input.data.status = "unknown";
      input.data.error = event.reason;
    } else if (event.type === "approval.requested") {
      const id = this.#newId("approval");
      const approval: ApprovalData = {
        id,
        taskId: target.taskId,
        participantId: target.participantId,
        sessionId: target.sessionId,
        executionId: execution.id,
        nativeApprovalId: event.approvalId,
        operation: event.operation,
        scope: event.scope ?? null,
        options: this.#jsonSafe(event.options) as RuntimeApproval["options"],
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
        taskId: target.taskId,
        participantId: target.participantId,
        sessionId: target.sessionId,
        executionId: execution.id,
        nativeRequestId: event.requestId,
        prompt: event.prompt,
        inputKind: event.inputKind,
        options: this.#jsonSafe(event.options ?? []) as RuntimeUserInput["options"],
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
      if (latest) {
        latest.data.status =
          event.status === "temporarily-unavailable" ? "temporarily-unavailable" : event.status;
        latest.data.reason = null;
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

  #confirmStopRequests(taskId: string, executionId: string, observedAt: number): void {
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

  #qualify(
    taskId: string,
    participantId: string,
    sessionId: string,
    authorizationId: string,
    scope: RuntimeAuthorizationScope,
    allowNonActiveTask = false,
  ): { task: StoredRecord<TaskData>; session: StoredRecord<SessionData> } {
    const task = this.#require<TaskData>("task", taskId);
    const participant = this.#store.get<RuntimeParticipant>("participant", task.data.participantId);
    const session = this.#store.get<SessionData>("session", task.data.sessionId);
    if (
      !participant ||
      !session ||
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
      scope !== "execution.interrupt" &&
      scope !== "task.freeze" &&
      scope !== "task.close"
    ) {
      throw new RuntimeEligibilityError(`Session is ${session.data.projection.status}.`);
    }
    return { task, session };
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

  #requireActiveTask(task: StoredRecord<TaskData>): void {
    if (task.data.status !== "active")
      throw new RuntimeEligibilityError(`Task ${task.id} is ${task.data.status}.`);
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
        "Runtime restarted without Engine session reattachment or execution reconciliation support.",
      );
      for (const input of this.#store.list<InputData>("input", session.taskId)) {
        if (input.data.sessionId !== session.id || !ACTIVE_INPUT_STATUSES.has(input.data.status))
          continue;
        input.data.status = "unknown";
        input.data.error = "Runtime restarted; Engine state cannot be reattached or reconciled.";
        this.#save(
          "input",
          input.id,
          input.taskId,
          session.id,
          input.id,
          input.data,
          "unknown",
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
          "Runtime restarted; Engine state cannot be reattached or reconciled.";
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
      stopRequests: this.#store
        .list<RuntimeStopRequest>("stop-request", taskId)
        .map((record) => record.data),
      integrityIssues: this.#store
        .list<RuntimeIntegrityIssue>("integrity-issue", taskId)
        .map((record) => record.data),
    });
  }

  #publicInput(data: InputData): RuntimeInput {
    const { nativeExecutionId: _nativeExecutionId, ...projection } = data;
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
    status === "completed" || status === "failed" || status === "stopped" || status === "rejected"
  );
}

export type { RuntimeAuthorization, RuntimeEnvironment };
