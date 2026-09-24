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
  EngineCompactReceipt,
  EngineAssistantFeedbackReceipt,
  EngineEvent,
  EngineEventPayload,
  EngineExecutionRef,
  EngineApprovalPresentation,
  EngineApprovalOptionPresentation,
  EngineJsonObject,
  EngineJsonValue,
  EngineRun,
  EngineSessionRef,
  EngineUserInputOption,
  EngineUserInputPresentation,
  EngineUserInputReceipt,
  EngineUserInputRef,
} from "@anyagent/engine-contract";
import {
  MAX_PERMISSION_FEEDBACK_CHARS,
  modelSelectionSchema,
  type ModelSelection,
} from "@zcode/shared/zcode-protocol-v4";
import { EngineContractError } from "@anyagent/engine-contract";
import { WORKFLOW_REFINE_PERMISSION_OPTION_ID, type ZCodeSessionEvent } from "@zcode/shared";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService, ZCodeAgentServiceEvent } from "../zcode-agent/zcodeAgent.js";

type AgentPort = Pick<
  IZCodeAgentService,
  | "readSession"
  | "initialize"
  | "sendConversationCommandV4"
  | "conversationRowsRangeV4"
  | "onDynamicSessionEvent"
  | "onAgentRuntimeLifecycle"
> &
  Partial<Pick<IZCodeAgentService, "queryConversationCommandsV4">>;

function compactTerminalFromRows(
  rows: Awaited<ReturnType<AgentPort["conversationRowsRangeV4"]>>["rows"],
  commandId: string,
): EngineCompactReceipt | null {
  const markers = rows.filter(
    (row) => row.kind === "timelineMarker" && row.sourceCommandId === commandId,
  );
  if (markers.length > 1)
    return {
      status: "unknown",
      reason: "Multiple native compaction markers use the same command ID.",
      evidence: { source: "adapter", evidenceId: `${commandId}:duplicate-markers` },
    };
  const marker = markers[0];
  if (!marker || marker.kind !== "timelineMarker" || marker.marker.type !== "compact") return null;
  if (marker.marker.status === "running") return null;
  const evidence = {
    source: "engine" as const,
    evidenceId: commandId,
    detail: `Native compaction lifecycle is ${marker.marker.status}.`,
  };
  return {
    status:
      marker.marker.status === "success"
        ? "completed"
        : marker.marker.status === "noop"
          ? "skipped"
          : marker.marker.status === "cancelled"
            ? "cancelled"
            : "failed",
    evidence,
    ...(marker.marker.status === "failed" || marker.marker.status === "cancelled"
      ? { reason: `Native compaction ${marker.marker.status}.` }
      : {}),
  };
}

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
  readonly userInputs: Map<
    string,
    {
      readonly prompt: string;
      readonly inputKind: "text" | "choice" | "form";
      readonly options: readonly EngineUserInputOption[];
      readonly presentation?: EngineUserInputPresentation;
    }
  >;
  readonly toolDetails: Map<string, { name?: string; input?: unknown }>;
  turnId: string | null;
  nativeForegroundExecutionId: string | null;
  textBlockSequence: number;
  currentTextBlock: { messageId: string; blockId: string } | null;
  lastSequence: number | null;
  deliverySequence: number;
  finished: boolean;
  wake?: () => void;
  dispose(): void;
}

type ZCodeSubmissionMode = "build" | "edit" | "plan" | "yolo";

interface ZCodeSubmissionConfig {
  readonly mode?: ZCodeSubmissionMode;
  readonly planEnabled?: boolean;
  readonly modelSelection?: ModelSelection;
}

const ZCODE_SUBMISSION_MODES = new Set<ZCodeSubmissionMode>(["build", "edit", "plan", "yolo"]);

function parseZCodeSubmissionConfig(
  value: EngineJsonObject | undefined,
): { config: ZCodeSubmissionConfig } | { error: string } {
  if (value === undefined) return { config: {} };
  const unsupportedKey = Object.keys(value).find(
    (key) => !["mode", "planEnabled", "modelSelection"].includes(key),
  );
  if (unsupportedKey)
    return { error: `ZCode submission config field is unsupported: ${unsupportedKey}.` };

  const mode = value.mode;
  if (
    mode !== undefined &&
    (typeof mode !== "string" || !ZCODE_SUBMISSION_MODES.has(mode as ZCodeSubmissionMode))
  )
    return { error: "ZCode submission mode is unsupported." };
  const planEnabled = value.planEnabled;
  if (planEnabled !== undefined && typeof planEnabled !== "boolean")
    return { error: "ZCode plan setting must be a boolean." };
  let modelSelection: ModelSelection | undefined;
  if (value.modelSelection !== undefined) {
    const parsed = modelSelectionSchema.safeParse(value.modelSelection);
    if (!parsed.success) return { error: "ZCode model selection is invalid." };
    modelSelection = parsed.data;
  }
  return {
    config: {
      ...(mode ? { mode: mode as ZCodeSubmissionMode } : {}),
      ...(planEnabled !== undefined ? { planEnabled } : {}),
      ...(modelSelection ? { modelSelection } : {}),
    },
  };
}

const ENGINE_ID = "zcode";
const SOURCE_VERSION = "zcode-cli/0.16.9@872ad960de7ec172591f7e1952f7849229f94521";
const ADAPTER_VERSION = "m1.2";
const CLIENT_ID = "anyagent-m1-host";
const WORKFLOW_TOOL_NAMES = new Set(["CreateWorkflow", "AmendWorkflow"]);

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
  operation:
    | "session.create"
    | "session.fork"
    | "session.compact"
    | "execution.run"
    | "execution.revise"
    | "approval.respond"
    | "execution.interrupt",
  message: string,
  kind:
    | "unsupported"
    | "temporarily-unavailable"
    | "execution-failed"
    | "result-unknown"
    | "protocol-error",
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

function approvalPresentation(raw: unknown): EngineApprovalPresentation | undefined {
  const request = payloadRecord(raw);
  const toolCallId = text(request.toolCallId);
  const riskLevel = text(request.riskLevel);
  const presentation: EngineApprovalPresentation = {
    ...(toolCallId ? { toolCallId } : {}),
    ...(request.input === undefined ? {} : { input: request.input as EngineJsonValue }),
    ...(riskLevel === "low" ||
    riskLevel === "medium" ||
    riskLevel === "high" ||
    riskLevel === "critical"
      ? { riskLevel }
      : {}),
    ...(request.origin === undefined ? {} : { origin: request.origin as EngineJsonValue }),
  };
  return Object.keys(presentation).length > 0 ? presentation : undefined;
}

function approvalOptionPresentation(raw: unknown): EngineApprovalOptionPresentation | undefined {
  const option = payloadRecord(raw);
  const kind = text(option.kind);
  const response = option.response;
  if (!kind || !response || typeof response !== "object" || Array.isArray(response))
    return undefined;
  const description = text(option.description);
  return {
    kind,
    ...(description ? { description } : {}),
    response: response as EngineJsonValue,
  };
}

function approvalOptions(raw: unknown, toolName?: string): EngineApprovalOption[] {
  const options = Array.isArray(raw)
    ? raw.flatMap((entry): EngineApprovalOption[] => {
        const option = payloadRecord(entry);
        const id = text(option.optionId);
        if (!id) return [];
        const kind = text(option.kind)?.toLowerCase() ?? "";
        const presentation = approvalOptionPresentation(entry);
        return [
          {
            id,
            label: text(option.name) ?? id,
            decision: kind.includes("deny")
              ? "reject"
              : kind.includes("allow")
                ? "approve"
                : "other",
            ...(id === WORKFLOW_REFINE_PERMISSION_OPTION_ID &&
            WORKFLOW_TOOL_NAMES.has(toolName ?? "")
              ? { requiresFeedback: true }
              : {}),
            ...(presentation ? { presentation } : {}),
          },
        ];
      })
    : [];
  if (!WORKFLOW_TOOL_NAMES.has(toolName ?? "")) return options;
  if (options.some((option) => option.id === WORKFLOW_REFINE_PERMISSION_OPTION_ID)) return options;
  return [
    ...options,
    {
      id: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
      label: "Refine",
      decision: "reject",
      requiresFeedback: true,
      presentation: {
        kind: "custom",
        response: { decision: "deny", reason: "Denied" },
      },
    },
  ];
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
  readConfigurationVersion?: () => Promise<string>;
  validateModelSelection?: (
    selection: ModelSelection,
  ) => Promise<string | undefined> | string | undefined;
}): EngineAdapter & {
  dispose(): void;
  readAssistantFeedback(
    session: string,
    messageIds: readonly string[],
  ): Promise<
    | { state: "current"; values: Record<string, "like" | "dislike" | null> }
    | { state: "unknown"; reason: string }
  >;
} {
  const workspace = {
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
  };
  const sessions = new Set<string>();
  // A native Session stays within its first explicitly selected provider.
  // There is no trustworthy way to recover this pin if the Adapter is recreated.
  const providerIdBySession = new Map<string, string>();
  const runs = new Map<string, PendingRun>();
  const compactOperations = new Map<string, (reason: string) => void>();
  // ponytail: retain per-run listeners for late evidence until Host disposal; use one
  // per-session fanout if long-lived, high-volume Sessions make listener count material.
  const allRuns = new Set<PendingRun>();
  const sessionSequence = new Map<string, number>();
  let availability: "unknown" | "available" | "temporarily-unavailable" | "authorization-required" =
    "unknown";
  let availabilityReason = "运行条件尚未探测";
  let configurationVersion: string | null = null;
  let nativeWorkspaceId = options.workspaceIdentity ?? options.workspacePath;
  let capabilityProbeRevision = 0;

  class AssistantRowReadError extends Error {
    constructor(
      message: string,
      readonly status: "unsupported" | "temporarily-unavailable",
    ) {
      super(message);
    }
  }

  async function readAssistantRows(session: string, messageIds: ReadonlySet<string>) {
    let beforeRowId: number | undefined;
    let baseRevision: number | undefined;
    let baseLogEpoch: string | undefined;
    const matches = new Map<string, { rowId: number; feedback: "like" | "dislike" | null }>();
    while (true) {
      const page = await options.agent.conversationRowsRangeV4({
        ...workspace,
        sessionId: session,
        ...(beforeRowId === undefined ? {} : { beforeRowId }),
        limit: 200,
      });
      if (baseRevision === undefined) {
        baseRevision = page.atRevision;
        baseLogEpoch = page.atLogEpoch;
      } else if (baseRevision !== page.atRevision || baseLogEpoch !== page.atLogEpoch) {
        throw new AssistantRowReadError(
          "The native conversation changed while reading assistant feedback.",
          "temporarily-unavailable",
        );
      }
      for (const row of page.rows) {
        if (row.kind !== "assistantText" || !row.entityId || !messageIds.has(row.entityId))
          continue;
        if (matches.has(row.entityId))
          throw new AssistantRowReadError(
            "The native assistant message has no unique text row.",
            "unsupported",
          );
        if (!Number.isSafeInteger(row.rowId))
          throw new AssistantRowReadError(
            "The native assistant row identity is invalid.",
            "temporarily-unavailable",
          );
        matches.set(row.entityId, { rowId: row.rowId, feedback: row.feedback ?? null });
      }
      if (!page.hasMore || page.rows.length === 0) break;
      const nextBeforeRowId = page.rows[0]?.rowId;
      if (
        typeof nextBeforeRowId !== "number" ||
        !Number.isSafeInteger(nextBeforeRowId) ||
        (beforeRowId !== undefined && nextBeforeRowId >= beforeRowId)
      )
        throw new AssistantRowReadError(
          "The native conversation row cursor did not advance.",
          "temporarily-unavailable",
        );
      beforeRowId = nextBeforeRowId;
    }
    return { matches, baseRevision, baseLogEpoch };
  }

  function capabilities(): EngineCapabilitySnapshot {
    const status = (support: "supported" | "unsupported" | "unknown", reason?: string) => ({
      support,
      availability: support === "supported" ? availability : ("unknown" as const),
      ...(reason ? { reason } : availabilityReason ? { reason: availabilityReason } : {}),
    });
    const items: Record<EngineCapability, ReturnType<typeof status>> = {
      "session.create": status("supported"),
      "session.fork": status("supported"),
      "session.compact": status("supported"),
      "session.close": status(
        "unsupported",
        "当前固定版本的 closeSession 语义不能证明原生状态已关闭",
      ),
      "execution.run": status("supported"),
      "execution.revise": status("supported"),
      "execution.interrupt": status("supported"),
      "execution.reconcile": status("unknown", "尚未验证断线后命令与执行对账"),
      "events.stream": status("supported"),
      "events.tool": status("supported"),
      "events.file": status("unknown", "公开文件差异需结合 v4 行查询，当前未完成映射"),
      "approval.respond": status("supported"),
      "user-input.respond": status("supported"),
      "assistant.feedback": status("supported"),
    };
    return {
      engineId: ENGINE_ID,
      engineVersion: SOURCE_VERSION,
      adapterVersion: ADAPTER_VERSION,
      configurationVersion,
      environment: options.workspaceIdentity ?? `local:${options.workspacePath}`,
      capabilities: items,
    };
  }

  async function refreshCapabilities(): Promise<EngineCapabilitySnapshot> {
    const revision = ++capabilityProbeRevision;
    try {
      const result = await options.agent.initialize(workspace);
      const nextConfigurationVersion = (await options.readConfigurationVersion?.()) ?? null;
      if (revision !== capabilityProbeRevision) return capabilities();
      configurationVersion = nextConfigurationVersion;
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
      if (revision !== capabilityProbeRevision) return capabilities();
      configurationVersion = null;
      availability = "temporarily-unavailable";
      availabilityReason = error instanceof Error ? error.message : String(error);
    }
    return capabilities();
  }

  async function resolveRevisionTarget(
    session: EngineSessionRef,
    sourceExecutionId: EngineExecutionRef,
    kind: "edit" | "retry",
  ): Promise<{
    target: { rowId: number; entityId: string };
    baseRevision: number;
    baseLogEpoch: string;
  }> {
    let beforeRowId: number | undefined;
    let baseRevision: number | undefined;
    let baseLogEpoch: string | undefined;
    const sourceTurnIds: string[] = [];
    const candidates: Array<{ turnId: string; rowId: number; entityId: string }> = [];
    try {
      while (true) {
        const page = await options.agent.conversationRowsRangeV4({
          ...workspace,
          sessionId: session,
          ...(beforeRowId === undefined ? {} : { beforeRowId }),
          limit: 200,
        });
        if (baseRevision === undefined) {
          baseRevision = page.atRevision;
          baseLogEpoch = page.atLogEpoch;
        } else if (baseRevision !== page.atRevision || baseLogEpoch !== page.atLogEpoch) {
          throw operationError(
            "execution.revise",
            "The native conversation changed during revision target lookup.",
            "temporarily-unavailable",
            "none",
          );
        }
        for (const row of page.rows) {
          if (row.kind === "turnHeader" && row.sourceCommandId === sourceExecutionId)
            sourceTurnIds.push(row.turnId);
          if (
            row.entityId &&
            ((kind === "edit" && row.kind === "userInput" && row.actions?.canEdit) ||
              (kind === "retry" && row.kind === "assistantText" && row.actions?.canRetry))
          )
            candidates.push({ turnId: row.turnId, rowId: row.rowId, entityId: row.entityId });
        }
        if (!page.hasMore) break;
        const nextBeforeRowId = page.rows[0]?.rowId;
        if (
          nextBeforeRowId === undefined ||
          !Number.isSafeInteger(nextBeforeRowId) ||
          (beforeRowId !== undefined && nextBeforeRowId >= beforeRowId)
        )
          throw operationError(
            "execution.revise",
            "The native conversation row cursor did not advance.",
            "temporarily-unavailable",
            "none",
          );
        beforeRowId = nextBeforeRowId;
      }
    } catch (error) {
      if (error instanceof EngineContractError) throw error;
      throw operationError(
        "execution.revise",
        error instanceof Error ? error.message : String(error),
        "temporarily-unavailable",
        "none",
      );
    }
    const targets =
      sourceTurnIds.length === 1 ? candidates.filter((row) => row.turnId === sourceTurnIds[0]) : [];
    if (targets.length !== 1 || baseRevision === undefined || !baseLogEpoch)
      throw operationError(
        "execution.revise",
        "No unique native revision target exists for this Execution.",
        "unsupported",
        "none",
      );
    return {
      target: { rowId: targets[0]!.rowId, entityId: targets[0]!.entityId },
      baseRevision,
      baseLogEpoch,
    };
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
    for (const markUnknown of compactOperations.values())
      markUnknown("ZCode Runtime disconnected before compaction terminal evidence.");
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
      // Without a native turn ID, a late request from the previous turn is
      // indistinguishable from one for the current run. Never make it actionable.
      if (!request.turnId) return;
      if (request.turnId && !run.turnId) {
        run.pendingTurnControls.push(incoming);
        return;
      }
      if (request.turnId !== run.turnId) return;
      if (run.approvals.has(request.requestId)) return;
      const allowed = approvalOptions(request.options, request.toolName);
      const presentation = approvalPresentation(request);
      run.approvals.set(request.requestId, allowed);
      publish(run, {
        type: "approval.requested",
        approvalId: request.requestId as EngineApprovalRef,
        operation: request.toolName,
        scope: request.reason,
        options: allowed,
        ...(presentation ? { presentation } : {}),
        expiresAt: null,
      });
      return;
    }
    if (incoming.type === "userInput.response") {
      if (!run.userInputs.has(incoming.requestId)) return;
      publish(run, {
        type: "user-input.response",
        requestId: incoming.requestId as EngineUserInputRef,
        status: incoming.response.action === "accept" ? "forwarded" : "rejected",
        response: incoming.response as EngineJsonObject,
      });
      return;
    }
    if (incoming.type === "userInput.request") {
      if (incoming.request.sessionId !== run.session) return;
      if (!incoming.request.turnId) return;
      if (incoming.request.turnId && !run.turnId) {
        run.pendingTurnControls.push(incoming);
        return;
      }
      if (incoming.request.turnId !== run.turnId) return;
      const questions = incoming.request.questions ?? [];
      const singleQuestion = questions.length === 1 ? questions[0] : undefined;
      const inputKind =
        questions.length === 0
          ? "text"
          : singleQuestion && !singleQuestion.multiSelect
            ? "choice"
            : "form";
      const prompt = singleQuestion?.question ?? incoming.request.prompt ?? "用户输入";
      const inputOptions = singleQuestion
        ? singleQuestion.options.map((option) => ({ id: option.value, label: option.label }))
        : [];
      const presentation =
        questions.length > 0
          ? {
              questions: questions.map((question) => ({
                question: question.question,
                header: question.header,
                options: question.options.map((option) => ({
                  value: option.value,
                  label: option.label,
                  ...(option.description ? { description: option.description } : {}),
                })),
                ...(question.multiSelect === undefined
                  ? {}
                  : { multiSelect: question.multiSelect }),
              })),
            }
          : undefined;
      const userInputPresentation =
        presentation && incoming.request.origin !== undefined
          ? { ...presentation, origin: incoming.request.origin as EngineJsonValue }
          : presentation;
      run.userInputs.set(incoming.request.requestId, {
        prompt,
        inputKind,
        options: inputOptions,
        ...(userInputPresentation ? { presentation: userInputPresentation } : {}),
      });
      publish(run, {
        type: "user-input.requested",
        requestId: incoming.request.requestId as EngineUserInputRef,
        prompt,
        inputKind,
        ...(inputOptions.length ? { options: inputOptions } : {}),
        ...(userInputPresentation ? { presentation: userInputPresentation } : {}),
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
      case "model.streaming": {
        const messageId = text(data.assistantMessageId);
        if (data.kind === "tool_call") {
          const toolCallId = text(data.toolCallId);
          if (toolCallId) {
            const previous = run.toolDetails.get(toolCallId);
            run.toolDetails.set(toolCallId, {
              name: text(data.toolName) ?? previous?.name,
              input: data.input ?? previous?.input,
            });
          }
        } else if (data.kind === "text_start") {
          if (run.seen.has(event.eventId)) break;
          run.seen.add(event.eventId);
          run.currentTextBlock = messageId
            ? { messageId, blockId: `zcode-text-${++run.textBlockSequence}` }
            : null;
        } else if (data.kind === "text_end") {
          if (run.seen.has(event.eventId)) break;
          run.seen.add(event.eventId);
          if (run.currentTextBlock?.messageId === messageId) run.currentTextBlock = null;
        } else if (data.kind === "text_delta" && typeof data.delta === "string")
          publish(
            run,
            {
              type: "message.delta",
              text: data.delta,
              ...(messageId ? { messageId } : {}),
              ...(text(data.partId)
                ? { blockId: text(data.partId) }
                : run.currentTextBlock?.messageId === messageId && run.currentTextBlock
                  ? { blockId: run.currentTextBlock.blockId }
                  : {}),
            },
            event,
          );
        break;
      }
      case "part.delta":
        if (data.field === "text" && typeof data.delta === "string")
          publish(
            run,
            {
              type: "message.delta",
              text: data.delta,
              ...(text(data.messageId) ? { messageId: text(data.messageId) } : {}),
              ...(text(data.partId) ? { blockId: text(data.partId) } : {}),
            },
            event,
          );
        break;
      case "tool.updated": {
        const toolCallId = text(data.toolCallId);
        if (!toolCallId) break;
        if (data.kind === "scheduled") {
          const previous = run.toolDetails.get(toolCallId);
          run.toolDetails.set(toolCallId, {
            name: text(data.toolName) ?? previous?.name,
            ...(data.input === undefined && previous?.input === undefined
              ? {}
              : { input: data.input ?? previous?.input }),
          });
          break;
        }
        const details = run.toolDetails.get(toolCallId);
        const name = text(data.toolName) ?? details?.name;
        if (data.kind === "started")
          publish(
            run,
            {
              type: "tool.started",
              toolCallId,
              name: name ?? "tool",
              ...(details?.input === undefined ? {} : { input: details.input }),
            },
            event,
          );
        if (data.kind === "result")
          publish(
            run,
            {
              type: "tool.completed",
              toolCallId,
              ...(name ? { name } : {}),
              ...(details?.input === undefined ? {} : { input: details.input }),
              result: data.result,
              sideEffects: "possible",
            },
            event,
          );
        if (data.kind === "error")
          publish(
            run,
            {
              type: "tool.failed",
              toolCallId,
              ...(name ? { name } : {}),
              ...(details?.input === undefined ? {} : { input: details.input }),
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
        const allowed = approvalOptions(data.options, toolName);
        const presentation = approvalPresentation(data);
        run.approvals.set(requestId, allowed);
        publish(
          run,
          {
            type: "approval.requested",
            approvalId: requestId as EngineApprovalRef,
            operation: toolName,
            scope: text(data.reason),
            options: allowed,
            ...(presentation ? { presentation } : {}),
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
      for (const markUnknown of compactOperations.values())
        markUnknown("ZCode Adapter disposed before compaction terminal evidence.");
      compactOperations.clear();
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
    async forkSession({
      session,
      sourceExecutionId,
      commandId,
      beforeDispatch,
    }): Promise<EngineSessionRef> {
      if (!sessions.has(session))
        throw operationError(
          "session.fork",
          "The source native Session is not attached.",
          "unsupported",
          "none",
        );
      if (!sourceExecutionId || !commandId)
        throw operationError(
          "session.fork",
          "Fork source or command identity is missing.",
          "protocol-error",
          "none",
        );

      let beforeRowId: number | undefined;
      let baseRevision: number | undefined;
      let baseLogEpoch: string | undefined;
      const sourceHeaders: Array<{ turnId: string; state: string }> = [];
      const candidates: Array<{ turnId: string; rowId: number; entityId: string }> = [];
      try {
        while (true) {
          const page = await options.agent.conversationRowsRangeV4({
            ...workspace,
            sessionId: session,
            ...(beforeRowId === undefined ? {} : { beforeRowId }),
            limit: 200,
          });
          if (baseRevision === undefined) {
            baseRevision = page.atRevision;
            baseLogEpoch = page.atLogEpoch;
          } else if (baseRevision !== page.atRevision || baseLogEpoch !== page.atLogEpoch) {
            throw operationError(
              "session.fork",
              "The native conversation changed during fork target lookup.",
              "temporarily-unavailable",
              "none",
            );
          }
          for (const row of page.rows) {
            if (row.kind === "turnHeader" && row.sourceCommandId === sourceExecutionId)
              sourceHeaders.push({ turnId: row.turnId, state: row.state });
            if (row.kind === "assistantText" && row.actions?.canFork && row.entityId)
              candidates.push({ turnId: row.turnId, rowId: row.rowId, entityId: row.entityId });
          }
          if (!page.hasMore) break;
          const nextBeforeRowId = page.rows[0]?.rowId;
          if (
            nextBeforeRowId === undefined ||
            !Number.isSafeInteger(nextBeforeRowId) ||
            (beforeRowId !== undefined && nextBeforeRowId >= beforeRowId)
          )
            throw operationError(
              "session.fork",
              "The native conversation row cursor did not advance.",
              "temporarily-unavailable",
              "none",
            );
          beforeRowId = nextBeforeRowId;
        }
      } catch (error) {
        if (error instanceof EngineContractError) throw error;
        throw operationError(
          "session.fork",
          error instanceof Error ? error.message : String(error),
          "temporarily-unavailable",
          "none",
        );
      }
      const sourceHeader = sourceHeaders.length === 1 ? sourceHeaders[0] : undefined;
      const targets = sourceHeader
        ? candidates.filter((row) => row.turnId === sourceHeader.turnId)
        : [];
      if (
        !sourceHeader ||
        sourceHeader.state !== "completedSuccess" ||
        targets.length !== 1 ||
        !Number.isSafeInteger(targets[0]?.rowId) ||
        baseRevision === undefined ||
        !baseLogEpoch
      )
        throw operationError(
          "session.fork",
          "No unique stable native assistant fork target exists for this Execution.",
          "unsupported",
          "none",
        );

      const envelope = {
        ...command("forkAssistant", session, {
          target: { rowId: targets[0]!.rowId, entityId: targets[0]!.entityId },
        }),
        commandId,
        baseRevision,
        baseLogEpoch,
      };
      beforeDispatch?.();
      let ack;
      try {
        ack = await options.agent.sendConversationCommandV4({ ...workspace, envelope });
      } catch {
        // The native child may have committed before the transport reply was lost.
      }
      if (
        !ack ||
        ((ack.status === "accepted" || ack.status === "duplicate" || ack.status === "failed") &&
          ack.result?.type !== "forkAssistant")
      ) {
        try {
          const query = await options.agent.queryConversationCommandsV4?.({
            ...workspace,
            commands: [{ sessionId: session, commandId }],
          });
          const result = query?.results.find(
            (item) => item.key.sessionId === session && item.key.commandId === commandId,
          )?.result;
          if (result && result !== "unknown") ack = result;
        } catch {
          // Keep the product child unknown; never create another native child on a new ID.
        }
      }
      if (
        (ack?.status === "accepted" || ack?.status === "duplicate") &&
        ack.result?.type === "forkAssistant"
      ) {
        const child = ack.result.sessionId as EngineSessionRef;
        if (!child || child === session)
          throw operationError(
            "session.fork",
            "The native child Session identity is invalid.",
            "result-unknown",
          );
        sessions.add(child);
        const providerId = providerIdBySession.get(session);
        if (providerId) providerIdBySession.set(child, providerId);
        return child;
      }
      if (ack?.status === "rejected" || ack?.status === "stale")
        throw operationError(
          "session.fork",
          ack.reasonCode ?? ack.message ?? ack.status,
          "execution-failed",
          "none",
        );
      throw operationError(
        "session.fork",
        ack?.reasonCode ?? ack?.message ?? "Native fork result is unknown.",
        "result-unknown",
      );
    },
    async run({
      session,
      input,
      commandId,
      submissionConfig,
      attachments,
      revision,
      beforeDispatch,
    }): Promise<EngineRun> {
      const operation = revision ? "execution.revise" : "execution.run";
      if (!sessions.has(session))
        throw operationError(operation, "未知或已失效的 ZCode Session", "protocol-error", "none");
      const parsedConfig = parseZCodeSubmissionConfig(submissionConfig);
      if ("error" in parsedConfig)
        throw operationError(operation, parsedConfig.error, "protocol-error", "none");
      const { mode, planEnabled, modelSelection } = parsedConfig.config;
      if (!modelSelection)
        throw operationError(
          operation,
          "Harness Session 必须明确选择模型，才能固定并验证 Provider。",
          "unsupported",
          "none",
        );
      const pinnedProviderId = providerIdBySession.get(session);
      if (pinnedProviderId && modelSelection.providerId !== pinnedProviderId)
        throw operationError(
          operation,
          `Harness Session 已固定 Provider ${pinnedProviderId}；跨 Provider 切换不受支持。`,
          "unsupported",
          "none",
        );
      if (!options.validateModelSelection)
        throw operationError(
          operation,
          "当前 Host 无法验证所选模型配置",
          "temporarily-unavailable",
          "none",
        );
      let validationError: string | undefined;
      try {
        validationError = await options.validateModelSelection(modelSelection);
      } catch (error) {
        throw operationError(
          operation,
          error instanceof Error ? error.message : String(error),
          "temporarily-unavailable",
          "none",
        );
      }
      if (validationError)
        throw operationError(operation, validationError, "execution-failed", "none");
      if (runs.has(session) || compactOperations.has(session))
        throw operationError(
          operation,
          "Session has an active operation; queued promotion is not integrated.",
          "temporarily-unavailable",
          "none",
        );
      const nativeRevisionTarget = revision
        ? await resolveRevisionTarget(session, revision.sourceExecutionId, revision.kind)
        : null;
      if (runs.has(session) || compactOperations.has(session))
        throw operationError(
          operation,
          "Session became busy before native dispatch; queued promotion is not integrated.",
          "temporarily-unavailable",
          "none",
        );
      const envelope =
        revision && nativeRevisionTarget
          ? {
              ...command(revision.kind === "edit" ? "editUserQuery" : "retryTurn", session, {
                target: nativeRevisionTarget.target,
                ...(revision.kind === "edit" ? { newText: input, workspaceMode: "preserve" } : {}),
              }),
              commandId: revision.commandId,
              baseRevision: nativeRevisionTarget.baseRevision,
              baseLogEpoch: nativeRevisionTarget.baseLogEpoch,
            }
          : {
              ...command("sendText", session, {
                text: input,
                requestedDelivery: "startNow",
                ...(mode ? { mode } : {}),
                ...(planEnabled !== undefined ? { planEnabled } : {}),
                ...(modelSelection ? { modelSelection } : {}),
                ...(attachments?.length
                  ? {
                      attachments: attachments.map((attachment) => ({
                        ref: attachment.locator,
                        fileName: attachment.fileName,
                        mime: attachment.mimeType,
                        bytes: attachment.sizeBytes,
                      })),
                    }
                  : {}),
              }),
              ...(commandId ? { commandId } : {}),
            };
      beforeDispatch?.();
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
        userInputs: new Map(),
        toolDetails: new Map(),
        turnId: null,
        nativeForegroundExecutionId: null,
        textBlockSequence: 0,
        currentTextBlock: null,
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
      const providerWasPinned = pinnedProviderId !== undefined;
      disposable = options.agent.onDynamicSessionEvent({
        ...workspace,
        sessionId: session,
        deliveryKind: "desktop-continuous",
        ...(run.lastSequence !== null ? { afterSeq: run.lastSequence } : {}),
      })((event) => receive(run, event));
      if (!providerWasPinned) providerIdBySession.set(session, modelSelection.providerId);
      let ack;
      try {
        ack = await options.agent.sendConversationCommandV4({ ...workspace, envelope });
      } catch (error) {
        if (!revision) {
          runs.delete(session);
          run.dispose();
          allRuns.delete(run);
          throw operationError(
            operation,
            error instanceof Error ? error.message : String(error),
            "result-unknown",
          );
        }
      }
      if (revision && (!ack || ack.status === "failed")) {
        try {
          const query = await options.agent.queryConversationCommandsV4?.({
            ...workspace,
            commands: [{ sessionId: session, commandId: revision.commandId }],
          });
          const recovered = query?.results.find(
            (item) => item.key.sessionId === session && item.key.commandId === revision.commandId,
          )?.result;
          if (recovered && recovered !== "unknown") ack = recovered;
        } catch {
          // Preserve the unknown product Input and never resubmit with a new command ID.
        }
      }
      if (run.finished) {
        run.dispose();
        throw operationError(operation, "ZCode Runtime 在输入回执到达前断开", "result-unknown");
      }
      if (
        !ack ||
        (ack.status !== "accepted" && !(revision && ack.status === "duplicate")) ||
        (!revision &&
          (ack.result?.type !== "inputAccepted" || ack.result.delivery !== "startNow")) ||
        (revision?.kind === "edit" &&
          (ack.result?.type !== "editUserQuery" || ack.result.disposition !== "rewind"))
      ) {
        if (ack?.status === "rejected" && !providerWasPinned) providerIdBySession.delete(session);
        runs.delete(session);
        run.dispose();
        allRuns.delete(run);
        throw operationError(
          operation,
          ack?.reasonCode ??
            ack?.message ??
            `ZCode 输入未确认立即执行: ${ack?.status ?? "unknown"}`,
          !ack ||
            (ack.status === "accepted" && ack.result?.type !== "editUserQuery") ||
            ack.status === "failed"
            ? "result-unknown"
            : "execution-failed",
          ack?.status === "rejected" || ack?.status === "stale" ? "none" : "possible",
        );
      }
      run.inputId =
        !revision && ack.result?.type === "inputAccepted" ? ack.result.inputId : envelope.commandId;
      run.acknowledged = true;
      for (const event of run.pendingEvents.splice(0)) receive(run, event);
      run.queue.unshift({
        type: "input.accepted",
        evidence: {
          source: "engine",
          evidenceId: ack.commandId,
          detail: revision ? `v4 ${revision.kind} command ACK` : "v4 command ACK: startNow",
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
    async compactSession({
      session,
      commandId,
      beforeDispatch,
      onAccepted,
    }): Promise<EngineCompactReceipt> {
      if (!sessions.has(session))
        throw operationError(
          "session.compact",
          "未知或已失效的 ZCode Session",
          "protocol-error",
          "none",
        );
      if (runs.has(session) || compactOperations.has(session))
        throw operationError(
          "session.compact",
          "Cannot compact a busy Session; queued promotion is not integrated.",
          "temporarily-unavailable",
          "none",
        );

      let resolveResult!: (receipt: EngineCompactReceipt) => void;
      const result = new Promise<EngineCompactReceipt>((resolve) => {
        resolveResult = resolve;
      });
      let settled = false;
      let acknowledged = false;
      let terminal: EngineCompactReceipt | null = null;
      let disposable: { dispose(): void } | undefined;
      let observation = Promise.resolve();
      const cleanup = () => {
        disposable?.dispose();
        disposable = undefined;
        if (compactOperations.get(session) === markUnknown) compactOperations.delete(session);
      };
      const finish = (receipt: EngineCompactReceipt) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveResult(receipt);
      };
      const abandon = () => {
        if (settled) return;
        settled = true;
        cleanup();
      };
      const markUnknown = (reason: string) =>
        finish({
          status: "unknown",
          reason,
          evidence: {
            source: "adapter",
            evidenceId: `${commandId}:unknown`,
            detail: reason,
          },
        });
      const accept = (evidence: NonNullable<EngineCompactReceipt["evidence"]>) => {
        if (!acknowledged) {
          acknowledged = true;
          onAccepted?.(evidence);
        }
        if (terminal) finish(terminal);
      };
      const observe = () => {
        observation = observation.then(async () => {
          if (settled) return;
          try {
            const page = await options.agent.conversationRowsRangeV4({
              ...workspace,
              sessionId: session,
              limit: 200,
            });
            const found = compactTerminalFromRows(page.rows, commandId);
            if (!found) return;
            if (found.status === "unknown") finish(found);
            else {
              terminal = found;
              accept(found.evidence!);
            }
          } catch {
            // A later session event retries the read; disconnect resolves the operation as unknown.
          }
        });
        return observation;
      };
      compactOperations.set(session, markUnknown);
      disposable = options.agent.onDynamicSessionEvent({
        ...workspace,
        sessionId: session,
        deliveryKind: "desktop-continuous",
        ...(sessionSequence.has(session) ? { afterSeq: sessionSequence.get(session) } : {}),
      })(() => void observe());

      let nativeState;
      try {
        nativeState = await options.agent.readSession({ ...workspace, sessionId: session });
      } catch (error) {
        abandon();
        throw operationError(
          "session.compact",
          error instanceof Error ? error.message : String(error),
          "temporarily-unavailable",
          "none",
        );
      }
      if (
        nativeState.runtime.activeTurnId ||
        nativeState.runtime.pendingRequestIds.length > 0 ||
        (nativeState.session.status !== "idle" && nativeState.session.status !== "completed")
      ) {
        abandon();
        throw operationError(
          "session.compact",
          "Native Session is busy or held; queued promotion is not integrated.",
          "temporarily-unavailable",
          "none",
        );
      }
      await observe();
      if (settled) return result;
      try {
        const dispatchState = await options.agent.readSession({
          ...workspace,
          sessionId: session,
        });
        if (
          dispatchState.runtime.activeTurnId ||
          dispatchState.runtime.pendingRequestIds.length > 0 ||
          (dispatchState.session.status !== "idle" && dispatchState.session.status !== "completed")
        )
          throw operationError(
            "session.compact",
            "Session became busy before native dispatch; queued promotion is not integrated.",
            "temporarily-unavailable",
            "none",
          );
        if (runs.has(session))
          throw operationError(
            "session.compact",
            "Session became busy before native dispatch; queued promotion is not integrated.",
            "temporarily-unavailable",
            "none",
          );
        beforeDispatch?.();
      } catch (error) {
        abandon();
        throw error;
      }

      const envelope = { ...command("compact", session, {}), commandId };
      const sent = options.agent.sendConversationCommandV4({ ...workspace, envelope }).then(
        (ack) => ({ kind: "ack" as const, ack }),
        () => ({ kind: "error" as const }),
      );
      const first = await Promise.race([
        sent,
        result.then((receipt) => ({ kind: "terminal" as const, receipt })),
      ]);
      if (first.kind === "terminal") return first.receipt;

      let ack = first.kind === "ack" ? first.ack : undefined;
      if ((!ack || ack.status === "failed") && options.agent.queryConversationCommandsV4) {
        try {
          const query = await options.agent.queryConversationCommandsV4({
            ...workspace,
            commands: [{ sessionId: session, commandId }],
          });
          const recovered = query.results.find(
            (item) => item.key.sessionId === session && item.key.commandId === commandId,
          )?.result;
          if (recovered && recovered !== "unknown") ack = recovered;
        } catch {
          // A lost ACK is never retried; lifecycle evidence may still resolve it.
        }
      }
      if (settled) return result;
      if (ack && ack.commandId !== commandId) {
        await observe();
        if (!settled) markUnknown("Native compact ACK returned a different command ID.");
        return result;
      }
      if (ack?.status === "accepted" || ack?.status === "duplicate") {
        accept({
          source: "engine",
          evidenceId: commandId,
          detail: `v4 compact ${ack.status} ACK`,
        });
        await observe();
        return result;
      }
      if (ack && ["rejected", "stale", "noop"].includes(ack.status)) {
        await observe();
        if (!settled)
          finish({
            status: "failed",
            evidence: {
              source: "engine",
              evidenceId: commandId,
              detail: `v4 compact ${ack.status} ACK`,
            },
            reason: ack.reasonCode ?? ack.message ?? `Native compact command was ${ack.status}.`,
          });
        return result;
      }
      await observe();
      if (!settled) markUnknown("Native compact ACK is unknown; command will not be resent.");
      return result;
    },
    async replyToApproval({
      session,
      approvalId,
      optionId,
      feedback,
    }): Promise<EngineApprovalReceipt> {
      const run = runs.get(session);
      const optionsForRequest = run?.approvals.get(approvalId);
      const selectedOption = optionsForRequest?.find((option) => option.id === optionId);
      if (!selectedOption) return { status: "unsupported" };
      if (selectedOption.requiresFeedback) {
        if (!feedback?.trim() || feedback.length > MAX_PERMISSION_FEEDBACK_CHARS)
          return { status: "unsupported" };
      } else if (feedback !== undefined) {
        return { status: "unsupported" };
      }
      const envelope = command("resolveInteraction", session, {
        interactionId: approvalId,
        answer: { optionId, ...(feedback === undefined ? {} : { freeText: feedback }) },
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
      const request = runs.get(session)?.userInputs.get(requestId);
      if (!request) return { status: "unsupported" };
      let answer: {
        freeText?: string;
        action?: "accept" | "decline" | "cancel";
        content?: Record<string, unknown>;
      };
      if (request.inputKind === "choice") {
        if (
          typeof response !== "string" ||
          !request.options.some((option) => option.id === response)
        ) {
          return { status: "unsupported" };
        }
        answer = {
          action: "accept",
          content: { answers: { [request.prompt]: response } },
        };
      } else if (request.inputKind === "text" && typeof response === "string") {
        answer = { freeText: response };
      } else if (request.inputKind === "form" && request.presentation?.questions.length) {
        if (typeof response !== "object" || response === null || Array.isArray(response))
          return { status: "unsupported" };
        const record = response as Record<string, unknown>;
        const action = text(record.action);
        if (action !== "accept" && action !== "decline" && action !== "cancel")
          return { status: "unsupported" };
        if (Object.keys(record).some((key) => key !== "action" && key !== "content"))
          return { status: "unsupported" };
        const content = record.content;
        if (
          content !== undefined &&
          (action !== "accept" ||
            typeof content !== "object" ||
            content === null ||
            Array.isArray(content))
        )
          return { status: "unsupported" };
        answer = {
          action,
          ...(content === undefined ? {} : { content: content as Record<string, unknown> }),
        };
      } else {
        return { status: "unsupported" };
      }
      const envelope = command("resolveInteraction", session, {
        interactionId: requestId,
        answer,
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
    async setAssistantFeedback({
      session,
      executionId,
      messageId,
      feedback,
      beforeDispatch,
    }): Promise<EngineAssistantFeedbackReceipt> {
      if (!sessions.has(session))
        return {
          status: "unknown",
          reason: "The native Session is not attached in this Adapter process.",
        };
      if (!messageId || messageId.trim() !== messageId)
        return { status: "unsupported", reason: "The assistant message identity is invalid." };

      let baseRevision: number | undefined;
      let baseLogEpoch: string | undefined;
      let target:
        | { readonly rowId: number; readonly feedback: "like" | "dislike" | null }
        | undefined;
      try {
        const rows = await readAssistantRows(session, new Set([messageId]));
        baseRevision = rows.baseRevision;
        baseLogEpoch = rows.baseLogEpoch;
        target = rows.matches.get(messageId);
      } catch (error) {
        return {
          status: error instanceof AssistantRowReadError ? error.status : "temporarily-unavailable",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (!target || baseRevision === undefined || !baseLogEpoch)
        return {
          status: "unsupported",
          reason: "No native assistant text row exists for this Execution message.",
        };
      if (target.feedback === feedback) return { status: "unchanged" };

      // Row pagination is asynchronous; recheck product eligibility immediately before send.
      beforeDispatch?.();

      const envelope = {
        ...command("setAssistantFeedback", session, {
          target: { rowId: target.rowId, entityId: messageId },
          feedback,
        }),
        baseRevision,
        baseLogEpoch,
      };
      try {
        const ack = await options.agent.sendConversationCommandV4({ ...workspace, envelope });
        if (ack.status === "accepted")
          return {
            status: "updated",
            evidence: {
              source: "engine",
              evidenceId: ack.commandId,
              detail: `Native feedback applied to Execution ${executionId}.`,
            },
          };
        if (
          ack.status === "stale" ||
          ack.reasonCode === "proto.staleRevision" ||
          ack.reasonCode === "proto.staleLogEpoch"
        )
          return {
            status: "temporarily-unavailable",
            reason: ack.message ?? "The native conversation changed before feedback was applied.",
          };
        if (ack.status === "rejected")
          return {
            status: "unsupported",
            reason:
              ack.reasonCode ?? ack.message ?? "The native feedback target is no longer valid.",
          };
        return {
          status: "unknown",
          reason: ack.reasonCode ?? ack.message ?? `Native feedback result is ${ack.status}.`,
        };
      } catch (error) {
        return {
          status: "unknown",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async readAssistantFeedback(session, messageIds) {
      if (!sessions.has(session))
        return {
          state: "unknown",
          reason: "The native Session is not attached in this Adapter process.",
        };
      if (messageIds.length === 0) return { state: "current", values: {} };
      try {
        const { matches } = await readAssistantRows(session, new Set(messageIds));
        return {
          state: "current",
          values: Object.fromEntries([...matches].map(([id, row]) => [id, row.feedback])),
        };
      } catch (error) {
        return {
          state: "unknown",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async closeSession(): Promise<EngineCommandReceipt> {
      return { status: "unsupported", reason: "未核实固定版本的原生关闭语义" };
    },
  };
}
