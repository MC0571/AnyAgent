import {
  EngineContractError,
  type CapabilityStatus,
  type EngineAdapter,
  type EngineApprovalReceipt,
  type EngineApprovalRef,
  type EngineCapability,
  type EngineCapabilitySnapshot,
  type EngineCommandReceipt,
  type EngineEvent,
  type EngineEventInput,
  type EngineExecutionRef,
  type EngineSessionRef,
  type EngineUserInputReceipt,
  type EngineUserInputRef,
} from "./types.js";
import {
  AsyncEventQueue,
  CAPABILITIES,
  DEFAULT_SCRIPT,
  type EventOverrides,
  type ExecutionRecord,
  type FakeEngineOptions,
  type FakeEngineStep,
} from "./fake-engine-support.js";
import { createFakeStepPayload } from "./fake-engine-steps.js";
import {
  emitFakeEvent,
  fakeEvidence,
  findFakeApproval,
  findFakeUserInput,
  requireFakeCapability,
  requireFakeExecution,
} from "./fake-engine-events.js";

export type { FakeEngineOptions, FakeEngineStep } from "./fake-engine-support.js";

export class FakeEngine implements EngineAdapter {
  readonly #autoAdvance: boolean;
  readonly #now: () => number;
  readonly #script: readonly FakeEngineStep[];
  readonly #sessions = new Set<EngineSessionRef>();
  readonly #executions = new Map<EngineExecutionRef, ExecutionRecord>();
  readonly #capabilities = new Map<EngineCapability, CapabilityStatus>();
  readonly #snapshot: Omit<EngineCapabilitySnapshot, "capabilities">;
  #sessionSequence = 0;
  #executionSequence = 0;

  constructor(options: FakeEngineOptions = {}) {
    this.#autoAdvance = options.autoAdvance ?? false;
    this.#now = options.now ?? (() => 0);
    this.#script = options.script ?? DEFAULT_SCRIPT;
    this.#snapshot = {
      engineId: options.engineId ?? "fake",
      adapterVersion: options.adapterVersion ?? "0.1.0",
      engineVersion: options.engineVersion ?? "fake-1",
      configurationVersion: options.configurationVersion ?? "fake-config-1",
      environment: options.environment ?? "controlled-test",
    };

    for (const capability of CAPABILITIES) {
      this.#capabilities.set(
        capability,
        options.capabilities?.[capability] ?? {
          support: capability === "execution.reconcile" ? "unsupported" : "supported",
          availability: capability === "execution.reconcile" ? "unknown" : "available",
          ...(capability === "execution.reconcile"
            ? { reason: "Fake Engine has no native reconciliation query." }
            : {}),
        },
      );
    }
  }

  getCapabilities(): EngineCapabilitySnapshot {
    return {
      ...this.#snapshot,
      capabilities: Object.fromEntries(this.#capabilities) as Record<
        EngineCapability,
        CapabilityStatus
      >,
    };
  }

  async refreshCapabilities(): Promise<EngineCapabilitySnapshot> {
    return this.getCapabilities();
  }

  setCapability(capability: EngineCapability, status: CapabilityStatus): void {
    this.#capabilities.set(capability, status);
  }

  async createSession(): Promise<EngineSessionRef> {
    this.#requireAvailable("session.create");
    this.#sessionSequence += 1;
    const session = `fake-session-${this.#sessionSequence}` as EngineSessionRef;
    this.#sessions.add(session);
    return session;
  }

  async run(input: { readonly session: EngineSessionRef; readonly input: string }) {
    this.#requireAvailable("execution.run");
    if (!this.#sessions.has(input.session)) {
      throw this.#error(
        "temporarily-unavailable",
        "execution.run",
        "Session is unknown or closed.",
        "none",
      );
    }

    this.#executionSequence += 1;
    const executionId = `fake-execution-${this.#executionSequence}` as EngineExecutionRef;
    const record: ExecutionRecord = {
      session: input.session,
      executionId,
      events: new AsyncEventQueue(),
      script: this.#script,
      emitted: [],
      approvals: new Map(),
      userInputs: new Map(),
      cursor: 0,
      sourceSequence: 0,
      deliverySequence: 0,
      streamGeneration: 1,
      streamId: `${executionId}-stream-1`,
      idSequence: 0,
      evidenceSequence: 0,
      connected: true,
      interruptRequested: false,
      closed: false,
      terminal: false,
      sessionClosed: false,
      autoAdvanceQueued: false,
    };
    this.#executions.set(executionId, record);
    void input.input;
    this.#scheduleAutoAdvance(record);
    return { executionId, events: record.events };
  }

  async replyToApproval(input: {
    readonly session: EngineSessionRef;
    readonly approvalId: EngineApprovalRef;
    readonly optionId: string;
  }): Promise<EngineApprovalReceipt> {
    const found = findFakeApproval(this.#executions.values(), input.session, input.approvalId);
    if (!found) return { status: "unknown" };
    const { record, pending } = found;
    if (pending.status !== "pending") return { status: "already-answered" };
    const capability = this.#capabilities.get("approval.respond")!;
    if (capability.support === "unsupported") return { status: "unsupported" };
    if (capability.support === "unknown") return { status: "unknown" };
    if (capability.availability !== "available") return { status: "unknown" };

    const option = pending.options.find((item) => item.id === input.optionId);
    if (!option) return { status: "unsupported" };
    const expired = pending.expiresAt !== null && this.#now() >= pending.expiresAt;
    pending.status = expired ? "expired" : "forwarded";
    const evidence = this.#evidence(
      record,
      expired ? "approval expired" : "approval response forwarded",
    );
    this.#emit(record, {
      type: "approval.response",
      approvalId: input.approvalId,
      optionId: option.id,
      decision: option.decision,
      status: expired ? "expired" : "forwarded",
      evidence,
    });
    this.#scheduleAutoAdvance(record);
    return { status: expired ? "expired" : "forwarded", evidence };
  }

  async replyToUserInput(input: {
    readonly session: EngineSessionRef;
    readonly requestId: EngineUserInputRef;
    readonly response: unknown;
  }): Promise<EngineUserInputReceipt> {
    const record = findFakeUserInput(this.#executions.values(), input.session, input.requestId);
    if (!record) return { status: "unknown" };
    const pending = record.userInputs.get(input.requestId)!;
    if (pending.status !== "pending") return { status: "already-answered" };
    const capability = this.#capabilities.get("user-input.respond")!;
    if (capability.support === "unsupported") return { status: "unsupported" };
    if (capability.support === "unknown") return { status: "unknown" };
    if (capability.availability !== "available") return { status: "unknown" };
    if (
      pending.inputKind === "choice" &&
      !pending.options.some(
        (option) => option.id === input.response || option.label === input.response,
      )
    ) {
      return { status: "unsupported" };
    }

    const expired = pending.expiresAt !== null && this.#now() >= pending.expiresAt;
    pending.status = expired ? "expired" : "forwarded";
    const evidence = this.#evidence(
      record,
      expired ? "user input expired" : "user input response forwarded",
    );
    this.#emit(record, {
      type: "user-input.response",
      requestId: input.requestId,
      status: expired ? "expired" : "forwarded",
      evidence,
    });
    this.#scheduleAutoAdvance(record);
    return { status: expired ? "expired" : "forwarded", evidence };
  }

  async interrupt(input: {
    readonly session: EngineSessionRef;
    readonly executionId: EngineExecutionRef;
  }): Promise<EngineCommandReceipt> {
    const record = this.#executions.get(input.executionId);
    if (!record || record.session !== input.session) {
      return { status: "unknown", reason: "Execution handle is unknown for this session." };
    }

    const capability = this.#capabilities.get("execution.interrupt")!;
    if (capability.support === "unsupported") {
      this.#emit(record, {
        type: "execution.interruption-requested",
        status: "unsupported",
        evidence: this.#evidence(record, "interrupt is unsupported"),
      });
      return { status: "unsupported", reason: capability.reason };
    }
    if (capability.support === "unknown") return { status: "unknown", reason: capability.reason };
    if (capability.availability !== "available") {
      const status =
        capability.availability === "authorization-required"
          ? "authorization-required"
          : capability.availability === "temporarily-unavailable"
            ? "temporarily-unavailable"
            : "unknown";
      return { status, reason: capability.reason };
    }
    if (record.terminal)
      return { status: "unknown", reason: "Execution already has a terminal observation." };

    record.interruptRequested = true;
    const evidence = this.#evidence(record, "interrupt request accepted by fake execution");
    this.#emit(record, { type: "execution.interruption-requested", status: "requested", evidence });
    if (this.#autoAdvance) queueMicrotask(() => this.confirmStopped(record.executionId));
    return { status: "requested", evidence };
  }

  async closeSession(input: { readonly session: EngineSessionRef }): Promise<EngineCommandReceipt> {
    const capability = this.#capabilities.get("session.close")!;
    if (capability.support === "unsupported")
      return { status: "unsupported", reason: capability.reason };
    if (capability.support === "unknown") return { status: "unknown", reason: capability.reason };
    if (!this.#sessions.has(input.session))
      return { status: "unknown", reason: "Session handle is unknown." };
    for (const record of this.#executions.values()) {
      if (record.session === input.session) record.sessionClosed = true;
    }
    this.#sessions.delete(input.session);
    return {
      status: "closed",
      evidence: { source: "engine", evidenceId: `fake-session-close-${input.session}` },
    };
  }

  advance(executionId: EngineExecutionRef): boolean {
    const record = this.#executions.get(executionId);
    if (
      !record ||
      record.closed ||
      !record.connected ||
      record.terminal ||
      record.interruptRequested
    )
      return false;
    if ([...record.approvals.values()].some((approval) => approval.status === "pending"))
      return false;
    if ([...record.userInputs.values()].some((request) => request.status === "pending"))
      return false;
    const step = record.script[record.cursor];
    if (!step) return false;
    record.cursor += 1;
    this.#emit(record, createFakeStepPayload(record, step));
    return true;
  }

  injectEvent(
    executionId: EngineExecutionRef,
    payload: EngineEventInput,
    overrides: EventOverrides = {},
  ): EngineEvent {
    const record = this.#record(executionId);
    const event = this.#emit(record, payload, overrides);
    if (
      payload.type === "execution.completed" ||
      payload.type === "execution.failed" ||
      payload.type === "execution.stopped"
    ) {
      record.terminal = true;
    }
    return event;
  }

  duplicateEvent(executionId: EngineExecutionRef, eventId: string): EngineEvent {
    const record = this.#record(executionId);
    const prior = [...record.emitted].reverse().find((event) => event.eventId === eventId);
    if (!prior) throw new Error(`No emitted event with ID ${eventId}.`);
    const {
      eventId: _eventId,
      streamId: _streamId,
      deliverySequence: _deliverySequence,
      observedAt: _observedAt,
      sourceSequence,
      source,
      session: _session,
      executionId: _executionId,
      ...payload
    } = prior;
    void _eventId;
    void _streamId;
    void _deliverySequence;
    void _observedAt;
    void _session;
    void _executionId;
    return this.#emit(record, payload as EngineEventInput, { eventId, sourceSequence, source });
  }

  disconnect(executionId: EngineExecutionRef, reason = "transport disconnected"): void {
    const record = this.#record(executionId);
    record.connected = false;
    this.#emit(record, { type: "connection.disconnected", reason }, { source: "adapter" });
    this.#emit(record, { type: "execution.unknown", reason }, { source: "adapter" });
  }

  reconnect(executionId: EngineExecutionRef): void {
    const record = this.#record(executionId);
    record.connected = true;
    record.streamGeneration += 1;
    record.streamId = `${record.executionId}-stream-${record.streamGeneration}`;
    record.deliverySequence = 0;
    this.#scheduleAutoAdvance(record);
  }

  confirmStopped(executionId: EngineExecutionRef): boolean {
    const record = this.#executions.get(executionId);
    if (!record || record.closed || record.terminal || !record.interruptRequested) return false;
    record.terminal = true;
    this.#emit(record, {
      type: "execution.stopped",
      evidence: this.#evidence(record, "fake engine confirmed execution stopped"),
    });
    return true;
  }

  closeEventStream(executionId: EngineExecutionRef): void {
    const record = this.#record(executionId);
    record.closed = true;
    record.events.close();
  }

  currentStreamId(executionId: EngineExecutionRef): string {
    return this.#record(executionId).streamId;
  }

  lastApprovalRequest(executionId: EngineExecutionRef) {
    const event = [...this.#record(executionId).emitted]
      .reverse()
      .find((item) => item.type === "approval.requested");
    if (!event || event.type !== "approval.requested")
      throw new Error("No approval request has been emitted.");
    return event;
  }

  #emit(
    record: ExecutionRecord,
    payload: EngineEventInput,
    overrides: EventOverrides = {},
  ): EngineEvent {
    return emitFakeEvent(record, payload, overrides, this.#now, (prefix) =>
      this.#nextId(record, prefix),
    );
  }

  #evidence(record: ExecutionRecord, detail: string) {
    return fakeEvidence(record, detail);
  }

  #nextId(record: ExecutionRecord, prefix: string): string {
    record.idSequence += 1;
    return `fake-${prefix}-${record.idSequence}`;
  }

  #scheduleAutoAdvance(record: ExecutionRecord): void {
    if (!this.#autoAdvance || record.autoAdvanceQueued || record.closed || record.terminal) return;
    record.autoAdvanceQueued = true;
    queueMicrotask(() => {
      record.autoAdvanceQueued = false;
      if (this.advance(record.executionId)) this.#scheduleAutoAdvance(record);
    });
  }

  #record(executionId: EngineExecutionRef): ExecutionRecord {
    return requireFakeExecution(this.#executions, executionId);
  }

  #requireAvailable(operation: "session.create" | "execution.run"): void {
    requireFakeCapability(this.#capabilities, operation);
  }

  #error(
    kind: ConstructorParameters<typeof EngineContractError>[0]["kind"],
    operation: ConstructorParameters<typeof EngineContractError>[0]["operation"],
    message: string,
    sideEffects: ConstructorParameters<typeof EngineContractError>[0]["sideEffects"],
  ): EngineContractError {
    return new EngineContractError({ kind, operation, message, sideEffects });
  }
}
