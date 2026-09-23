/* eslint-disable max-lines -- Fixed-version ZCode command and event mappings share one native session state. */
import { randomUUID } from "node:crypto";
import type {
  EngineAdapter,
  EngineApprovalOption,
  EngineApprovalReceipt,
  EngineApprovalRef,
  EngineCapability,
  EngineCapabilitySnapshot,
  EngineCommandReceipt,
  EngineEvent,
  EngineEventPayload,
  EngineExecutionRef,
  EngineRun,
  EngineSessionRef,
  EngineUserInputReceipt,
  EngineUserInputRef,
} from "@anyagent/engine-contract";
import { EngineContractError } from "@anyagent/engine-contract";
import type { ZCodeSessionEvent } from "@zcode/shared";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService, ZCodeAgentServiceEvent } from "../zcode-agent/zcodeAgent.js";

type AgentPort = Pick<
  IZCodeAgentService,
  "initialize" | "sendConversationCommandV4" | "onDynamicSessionEvent" | "onAgentRuntimeLifecycle"
>;

interface PendingRun {
  readonly streamId: string;
  readonly session: EngineSessionRef;
  readonly executionId: EngineExecutionRef;
  inputId: string;
  acknowledged: boolean;
  readonly pendingEvents: ZCodeAgentServiceEvent[];
  readonly pendingTurnControls: ZCodeAgentServiceEvent[];
  readonly queue: EngineEvent[];
  readonly seen: Set<string>;
  readonly approvals: Map<string, readonly EngineApprovalOption[]>;
  readonly approvalAnswers: Map<string, string>;
  readonly userInputIds: Set<string>;
  turnId: string | null;
  nativeForegroundExecutionId: string | null;
  lastSequence: number | null;
  deliverySequence: number;
  finished: boolean;
  wake?: () => void;
  dispose(): void;
}

const ENGINE_ID = "zcode";
const SOURCE_VERSION = "zcode-cli/0.16.9@872ad960de7ec172591f7e1952f7849229f94521";
const ADAPTER_VERSION = "m1.0";
const CLIENT_ID = "anyagent-m1-host";

function command(
  type: CommandEnvelope["type"],
  sessionId: string | null,
  payload: unknown,
): CommandEnvelope {
  return {
    type,
    sessionId,
    payload,
    commandId: randomUUID(),
    clientId: CLIENT_ID,
    issuedAt: Date.now(),
  };
}

function operationError(
  operation: "session.create" | "execution.run" | "approval.respond" | "execution.interrupt",
  message: string,
  kind: "temporarily-unavailable" | "execution-failed" | "result-unknown" | "protocol-error",
  sideEffects: "none" | "possible" = "possible",
): EngineContractError {
  return new EngineContractError({ kind, operation, message, sideEffects });
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function approvalOptions(raw: unknown): EngineApprovalOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): EngineApprovalOption[] => {
    const option = payloadRecord(entry);
    const id = text(option.optionId);
    if (!id) return [];
    const kind = text(option.kind)?.toLowerCase() ?? "";
    return [
      {
        id,
        label: text(option.name) ?? id,
        decision: kind.includes("deny") ? "reject" : kind.includes("allow") ? "approve" : "other",
      },
    ];
  });
}

function makeStream(run: PendingRun): AsyncIterable<EngineEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (!run.finished || run.queue.length > 0) {
          if (run.queue.length === 0) {
            await new Promise<void>((resolve) => {
              run.wake = resolve;
            });
            continue;
          }
          yield run.queue.shift()!;
        }
      } finally {
        run.dispose();
      }
    },
  };
}

/** Fixed ZCode source adapter. All ZCode protocol types stay inside this module. */
export function createZCodeAdapter(options: {
  agent: AgentPort;
  workspacePath: string;
  workspaceIdentity?: string;
  configurationVersion?: string;
}): EngineAdapter & { dispose(): void } {
  const workspace = {
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
  };
  const sessions = new Set<string>();
  const runs = new Map<string, PendingRun>();
  // ponytail: retain per-run listeners for late evidence until Host disposal; use one
  // per-session fanout if long-lived, high-volume Sessions make listener count material.
  const allRuns = new Set<PendingRun>();
  const sessionSequence = new Map<string, number>();
  let availability: "unknown" | "available" | "temporarily-unavailable" | "authorization-required" =
    "unknown";
  let availabilityReason = "运行条件尚未探测";
  let nativeWorkspaceId = options.workspaceIdentity ?? options.workspacePath;

  function capabilities(): EngineCapabilitySnapshot {
    const status = (support: "supported" | "unsupported" | "unknown", reason?: string) => ({
      support,
      availability: support === "supported" ? availability : ("unknown" as const),
      ...(reason ? { reason } : availabilityReason ? { reason: availabilityReason } : {}),
    });
    const items: Record<EngineCapability, ReturnType<typeof status>> = {
      "session.create": status("supported"),
      "session.close": status(
        "unsupported",
        "当前固定版本的 closeSession 语义不能证明原生状态已关闭",
      ),
      "execution.run": status("supported"),
      "execution.interrupt": status("supported"),
      "execution.reconcile": status("unknown", "尚未验证断线后命令与执行对账"),
      "events.stream": status("supported"),
      "events.tool": status("supported"),
      "events.file": status("unknown", "公开文件差异需结合 v4 行查询，当前未完成映射"),
      "approval.respond": status("supported"),
      "user-input.respond": status("unknown", "仅已验证简单文本交互映射"),
    };
    return {
      engineId: ENGINE_ID,
      engineVersion: SOURCE_VERSION,
      adapterVersion: ADAPTER_VERSION,
      configurationVersion: options.configurationVersion ?? null,
      environment: options.workspaceIdentity ?? `local:${options.workspacePath}`,
      capabilities: items,
    };
  }

  async function refreshCapabilities(): Promise<EngineCapabilitySnapshot> {
    try {
      const result = await options.agent.initialize(workspace);
      if (result.available) nativeWorkspaceId = result.workspaceKey;
      availability = result.available
        ? "available"
        : result.reasonCode === "provider_not_ready"
          ? "authorization-required"
          : "temporarily-unavailable";
      availabilityReason = result.available
        ? ""
        : (result.reason ?? result.reasonCode ?? "ZCode Runtime 不可用");
    } catch (error) {
      availability = "temporarily-unavailable";
      availabilityReason = error instanceof Error ? error.message : String(error);
    }
    return capabilities();
  }

  function publish(run: PendingRun, payload: EngineEventPayload, native?: ZCodeSessionEvent): void {
    const eventId = native?.eventId ?? `adapter:${randomUUID()}`;
    if (run.seen.has(eventId)) return;
    run.seen.add(eventId);
    run.queue.push({
      ...payload,
      eventId,
      streamId: run.streamId,
      // Native seq covers events this adapter does not map; publishing it here
      // would make the product falsely report gaps between mapped events.
      sourceSequence: null,
      deliverySequence: ++run.deliverySequence,
      observedAt: Date.now(),
      source: native ? "engine" : "adapter",
      session: run.session,
      executionId: run.executionId,
    });
    run.wake?.();
    run.wake = undefined;
    if (
      payload.type === "execution.completed" ||
      payload.type === "execution.failed" ||
      payload.type === "execution.stopped"
    ) {
      if (runs.get(run.session) === run) runs.delete(run.session);
    }
  }

  const lifecycle = options.agent.onAgentRuntimeLifecycle?.((event) => {
    if (event.workspaceKey !== nativeWorkspaceId || event.state !== "unavailable") return;
    availability = "temporarily-unavailable";
    availabilityReason = "ZCode Runtime 已断开";
    for (const run of allRuns) {
      if (run.finished) continue;
      if (run.acknowledged && runs.get(run.session) === run)
        publish(run, {
          type: "execution.unknown",
          reason: "ZCode Runtime 在终态证据到达前断开",
        });
      run.finished = true;
      if (runs.get(run.session) === run) runs.delete(run.session);
      run.wake?.();
    }
  });

  function receive(run: PendingRun, incoming: ZCodeAgentServiceEvent): void {
    if (run.finished) return;
    if (!run.acknowledged) {
      run.pendingEvents.push(incoming);
      return;
    }
    if (incoming.type === "permission.request") {
      const request = incoming.request;
      if (request.sessionId !== run.session) return;
      if (request.turnId && !run.turnId) {
        run.pendingTurnControls.push(incoming);
        return;
      }
      if (request.turnId) {
        if (request.turnId !== run.turnId) return;
      } else if (runs.get(run.session) !== run) return;
      if (run.approvals.has(request.requestId)) return;
      const allowed = approvalOptions(request.options);
      run.approvals.set(request.requestId, allowed);
      publish(run, {
        type: "approval.requested",
        approvalId: request.requestId as EngineApprovalRef,
        operation: request.toolName,
        scope: request.reason,
        options: allowed,
        expiresAt: null,
      });
      return;
    }
    if (incoming.type === "userInput.response") {
      if (!run.userInputIds.has(incoming.requestId)) return;
      publish(run, {
        type: "user-input.response",
        requestId: incoming.requestId as EngineUserInputRef,
        status: "forwarded",
      });
      return;
    }
    if (incoming.type === "userInput.request") {
      if (incoming.request.sessionId !== run.session) return;
      if (incoming.request.turnId && !run.turnId) {
        run.pendingTurnControls.push(incoming);
        return;
      }
      if (incoming.request.turnId) {
        if (incoming.request.turnId !== run.turnId) return;
      } else if (runs.get(run.session) !== run) {
        // A request without turn provenance cannot be assigned to a prior run.
        return;
      }
      run.userInputIds.add(incoming.request.requestId);
      publish(run, {
        type: "user-input.requested",
        requestId: incoming.request.requestId as EngineUserInputRef,
        prompt: incoming.request.prompt ?? incoming.request.questions?.[0]?.question ?? "用户输入",
        inputKind: incoming.request.questions?.length ? "form" : "text",
        options: incoming.request.questions?.[0]?.options.map((option) => ({
          id: option.value,
          label: option.label,
        })),
        expiresAt: null,
      });
      return;
    }
    if (incoming.type !== "session.event") return;
    const event = incoming.event;
    if (event.sessionId !== run.session) return;
    const last = run.lastSequence;
    // ZCode's session subscription may omit native event types, so seq is a
    // resume cursor, not proof that every intervening event was delivered here.
    run.lastSequence = Math.max(last ?? 0, event.seq);
    sessionSequence.set(run.session, run.lastSequence);
    const data = payloadRecord(event.payload);
    if (event.type === "turn.started") {
      if (data.inputId !== run.inputId) return;
      run.turnId = event.turnId ?? text(data.turnId) ?? null;
      run.nativeForegroundExecutionId = text(data.foregroundExecutionId) ?? null;
      publish(
        run,
        { type: "execution.started", evidence: { source: "engine", evidenceId: event.eventId } },
        event,
      );
      for (const control of run.pendingTurnControls.splice(0)) receive(run, control);
      return;
    }
    if (!run.turnId || event.turnId !== run.turnId) return;
    switch (event.type) {
      case "part.delta":
        if (data.field === "text" && typeof data.delta === "string")
          publish(run, { type: "message.delta", text: data.delta }, event);
        break;
      case "tool.updated": {
        const toolCallId = text(data.toolCallId);
        if (!toolCallId) break;
        if (data.kind === "started")
          publish(
            run,
            { type: "tool.started", toolCallId, name: text(data.toolName) ?? "tool" },
            event,
          );
        if (data.kind === "result")
          publish(
            run,
            { type: "tool.completed", toolCallId, result: data.result, sideEffects: "possible" },
            event,
          );
        if (data.kind === "error")
          publish(
            run,
            {
              type: "tool.failed",
              toolCallId,
              failure: {
                kind: "execution-failed",
                operation: "execution.run",
                message: text(payloadRecord(data.error).message) ?? "工具失败",
                sideEffects: "possible",
              },
            },
            event,
          );
        break;
      }
      case "permission.requested": {
        const requestId = text(data.requestId) ?? `perm-${text(data.toolCallId) ?? event.eventId}`;
        if (run.approvals.has(requestId)) break;
        const toolName = text(data.toolName) ?? "tool";
        if (toolName === "AskUserQuestion" || toolName === "ExitPlanMode") {
          // ZCode emits a separate userInput.request with the actual prompt and response ID.
          break;
        }
        const allowed = approvalOptions(data.options);
        run.approvals.set(requestId, allowed);
        publish(
          run,
          {
            type: "approval.requested",
            approvalId: requestId as EngineApprovalRef,
            operation: toolName,
            scope: text(data.reason),
            options: allowed,
            expiresAt: null,
          },
          event,
        );
        break;
      }
      case "permission.resolved": {
        const requestId = text(data.requestId) ?? `perm-${text(data.toolCallId) ?? event.eventId}`;
        const options = run.approvals.get(requestId);
        if (!options) break;
        const selected = run.approvalAnswers.get(requestId);
        const nativeDecision = text(data.decision);
        const decision =
          nativeDecision === "deny" ? "reject" : nativeDecision === "allow" ? "approve" : "other";
        const option =
          options.find(
            (candidate) => candidate.id === selected && candidate.decision === decision,
          ) ?? options.find((candidate) => candidate.decision === decision);
        publish(
          run,
          {
            type: "approval.response",
            approvalId: requestId as EngineApprovalRef,
            optionId: option?.id ?? nativeDecision ?? "unknown",
            decision,
            status:
              decision === "reject" ? "rejected" : decision === "approve" ? "forwarded" : "unknown",
            evidence: { source: "engine", evidenceId: event.eventId },
          },
          event,
        );
        break;
      }
      case "turn.completed": {
        if (data.inputId && data.inputId !== run.inputId) break;
        const evidence = { source: "engine" as const, evidenceId: event.eventId };
        if (data.resultType === "cancelled")
          publish(run, { type: "execution.stopped", evidence }, event);
        else if (data.resultType === "success")
          publish(
            run,
            { type: "execution.completed", result: text(data.response), evidence },
            event,
          );
        else
          publish(
            run,
            {
              type: "execution.failed",
              failure: {
                kind: "execution-failed",
                operation: "execution.run",
                message: text(data.resultType) ?? "ZCode 执行失败",
                sideEffects: "possible",
              },
              evidence,
            },
            event,
          );
        break;
      }
      case "turn.failed":
        if (data.inputId && data.inputId !== run.inputId) break;
        publish(
          run,
          {
            type: "execution.failed",
            failure: {
              kind: "execution-failed",
              operation: "execution.run",
              message: text(payloadRecord(data.error).message) ?? "ZCode 执行失败",
              sideEffects: "possible",
            },
            evidence: { source: "engine", evidenceId: event.eventId },
          },
          event,
        );
        break;
    }
  }

  return {
    dispose() {
      lifecycle?.dispose();
      for (const run of allRuns) {
        run.finished = true;
        run.dispose();
        run.wake?.();
      }
      allRuns.clear();
      runs.clear();
    },
    getCapabilities: capabilities,
    refreshCapabilities,
    async createSession(): Promise<EngineSessionRef> {
      const state = await refreshCapabilities();
      if (state.capabilities["session.create"].availability !== "available") {
        throw operationError(
          "session.create",
          availabilityReason,
          "temporarily-unavailable",
          "none",
        );
      }
      const envelope = command("createSession", null, {
        workspaceId: nativeWorkspaceId,
      });
      let ack;
      try {
        ack = await options.agent.sendConversationCommandV4({ ...workspace, envelope });
      } catch (error) {
        throw operationError(
          "session.create",
          error instanceof Error ? error.message : String(error),
          "result-unknown",
        );
      }
      if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
        throw operationError(
          "session.create",
          ack.reasonCode ?? ack.message ?? `ZCode 建会话: ${ack.status}`,
          ack.status === "accepted" || ack.status === "failed"
            ? "result-unknown"
            : "execution-failed",
          ack.status === "rejected" ? "none" : "possible",
        );
      }
      const session = ack.result.sessionId as EngineSessionRef;
      sessions.add(session);
      return session;
    },
    async run({ session, input }): Promise<EngineRun> {
      if (!sessions.has(session))
        throw operationError(
          "execution.run",
          "未知或已失效的 ZCode Session",
          "protocol-error",
          "none",
        );
      if (runs.has(session))
        throw operationError(
          "execution.run",
          "同一 Session 已有进行中的执行",
          "temporarily-unavailable",
          "none",
        );
      const envelope = command("sendText", session, { text: input, requestedDelivery: "startNow" });
      const executionId = envelope.commandId as EngineExecutionRef;
      let disposable: { dispose(): void } | undefined;
      const run: PendingRun = {
        streamId: randomUUID(),
        session,
        executionId,
        inputId: envelope.commandId,
        acknowledged: false,
        pendingEvents: [],
        pendingTurnControls: [],
        queue: [],
        seen: new Set(),
        approvals: new Map(),
        approvalAnswers: new Map(),
        userInputIds: new Set(),
        turnId: null,
        nativeForegroundExecutionId: null,
        lastSequence: sessionSequence.get(session) ?? null,
        deliverySequence: 0,
        finished: false,
        dispose() {
          disposable?.dispose();
          disposable = undefined;
          allRuns.delete(run);
        },
      };
      runs.set(session, run);
      allRuns.add(run);
      disposable = options.agent.onDynamicSessionEvent({
        ...workspace,
        sessionId: session,
        deliveryKind: "desktop-continuous",
        ...(run.lastSequence !== null ? { afterSeq: run.lastSequence } : {}),
      })((event) => receive(run, event));
      let ack;
      try {
        ack = await options.agent.sendConversationCommandV4({ ...workspace, envelope });
      } catch (error) {
        runs.delete(session);
        run.dispose();
        allRuns.delete(run);
        throw operationError(
          "execution.run",
          error instanceof Error ? error.message : String(error),
          "result-unknown",
        );
      }
      if (run.finished) {
        run.dispose();
        throw operationError(
          "execution.run",
          "ZCode Runtime 在输入回执到达前断开",
          "result-unknown",
        );
      }
      if (
        ack.status !== "accepted" ||
        ack.result?.type !== "inputAccepted" ||
        ack.result.delivery !== "startNow"
      ) {
        runs.delete(session);
        run.dispose();
        allRuns.delete(run);
        throw operationError(
          "execution.run",
          ack.reasonCode ?? ack.message ?? `ZCode 输入未确认立即执行: ${ack.status}`,
          ack.status === "accepted" || ack.status === "failed"
            ? "result-unknown"
            : "execution-failed",
          ack.status === "rejected" ? "none" : "possible",
        );
      }
      run.inputId = ack.result.inputId;
      run.acknowledged = true;
      for (const event of run.pendingEvents.splice(0)) receive(run, event);
      run.queue.unshift({
        type: "input.accepted",
        evidence: {
          source: "engine",
          evidenceId: ack.commandId,
          detail: "v4 command ACK: startNow",
        },
        eventId: `ack:${ack.commandId}`,
        streamId: run.streamId,
        sourceSequence: null,
        deliverySequence: 0,
        observedAt: Date.now(),
        source: "engine",
        session,
        executionId,
      });
      run.wake?.();
      run.wake = undefined;
      return { executionId, events: makeStream(run) };
    },
    async replyToApproval({ session, approvalId, optionId }): Promise<EngineApprovalReceipt> {
      const run = runs.get(session);
      const optionsForRequest = run?.approvals.get(approvalId);
      if (!optionsForRequest?.some((option) => option.id === optionId))
        return { status: "unsupported" };
      const envelope = command("resolveInteraction", session, {
        interactionId: approvalId,
        answer: { optionId },
      });
      // The native permission.resolved event may arrive before the command ACK.
      run?.approvalAnswers.set(approvalId, optionId);
      try {
        const ack = await options.agent.sendConversationCommandV4({ ...workspace, envelope });
        if (ack.status === "accepted") {
          return { status: "forwarded", evidence: { source: "engine", evidenceId: ack.commandId } };
        }
        if (ack.reasonCode === "proto.alreadyResolved") {
          run?.approvalAnswers.delete(approvalId);
          return { status: "already-answered" };
        }
        run?.approvalAnswers.delete(approvalId);
        return { status: "unknown" };
      } catch {
        run?.approvalAnswers.delete(approvalId);
        return { status: "unknown" };
      }
    },
    async replyToUserInput({ session, requestId, response }): Promise<EngineUserInputReceipt> {
      if (!runs.get(session)?.userInputIds.has(requestId) || typeof response !== "string")
        return { status: "unsupported" };
      const envelope = command("resolveInteraction", session, {
        interactionId: requestId,
        answer: { freeText: response },
      });
      try {
        const ack = await options.agent.sendConversationCommandV4({ ...workspace, envelope });
        if (ack.status === "accepted")
          return { status: "forwarded", evidence: { source: "engine", evidenceId: ack.commandId } };
        if (ack.reasonCode === "proto.alreadyResolved") return { status: "already-answered" };
        return { status: "unknown" };
      } catch {
        return { status: "unknown" };
      }
    },
    async interrupt({ session, executionId }): Promise<EngineCommandReceipt> {
      if (runs.get(session)?.executionId !== executionId)
        return { status: "unsupported", reason: "执行标识不匹配" };
      const current = runs.get(session)!;
      if (!current.nativeForegroundExecutionId) {
        return {
          status: "temporarily-unavailable",
          reason: "尚无可防止误停后续执行的原生执行标识",
        };
      }
      const envelope = command("stop", session, {
        expectedForegroundExecutionId: current.nativeForegroundExecutionId,
      });
      try {
        const ack = await options.agent.sendConversationCommandV4({ ...workspace, envelope });
        if (ack.status === "accepted")
          return { status: "requested", evidence: { source: "engine", evidenceId: ack.commandId } };
        return {
          status: ack.status === "failed" ? "unknown" : "temporarily-unavailable",
          reason: ack.reasonCode ?? ack.message,
        };
      } catch (error) {
        return {
          status: "unknown",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async closeSession(): Promise<EngineCommandReceipt> {
      return { status: "unsupported", reason: "未核实固定版本的原生关闭语义" };
    },
  };
}
