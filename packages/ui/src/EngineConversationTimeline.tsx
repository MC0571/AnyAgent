/* oxlint-disable eslint(max-lines) -- 输入轮次、Execution 与对应交互必须沿同一消息序列呈现。 */
import { useMemo, useRef, useState } from "react";
import {
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  type ZCodeElicitationRequest,
  type ZCodeInteractionRequestOrigin,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
} from "@zcode/shared";
import type {
  EngineFileChanges,
  EngineFileRewindPreview,
  EngineJsonObject,
  EngineUserInputAnswer,
} from "@anyagent/engine-contract";
import type { EngineApproval, EngineInput, EngineUserInput } from "@/EngineUiParts.js";
import { jsonLabel, timeLabel } from "@/EngineUiParts.js";
import type {
  EngineDeltaBlock,
  EngineConversationProjection,
  EngineExecutionTurn,
} from "@/engineConversationProjection.js";
import {
  Message,
  MessageContent,
  MessageResponse,
  type MessageFileLinkTarget,
} from "@/components/ai-elements/message.js";
import {
  ConversationAssistantTextActions,
  ConversationUserInputActions,
} from "@/v4/ConversationRowView.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { parsePromptWebElementContexts } from "@/lib/webElementContext.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ElicitationDialog } from "@/ElicitationDialog.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { isPlainRecord } from "@/ToolCallBlocks/fileSummaryTypes.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments.js";
import type { AssistantTextRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import { EngineExecutionFileSummary } from "@/EngineExecutionFileSummary.js";
import { useConversationTimelineFind } from "@/v4/useConversationTimelineFind.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type { ConversationFindMatchState } from "@/v4/legacyChatViewTypes.js";

function isInProgress(status: string) {
  return status === "accepted" || status === "started";
}

function assistantAnswerTimestamp(turn: EngineExecutionTurn): number | undefined {
  if (turn.execution.terminalAt !== null) return turn.execution.terminalAt;
  return turn.events.reduce<number | undefined>(
    (latest, event) =>
      event.type === "message.delta" && (latest === undefined || event.observedAt > latest)
        ? event.observedAt
        : latest,
    undefined,
  );
}

function sameAnswerBlock(turn: EngineExecutionTurn): boolean {
  const [first, ...rest] = turn.deltas;
  return (
    !!first &&
    (rest.length === 0 ||
      (first.identityKnown &&
        rest.every(
          (block) =>
            block.identityKnown &&
            block.messageId === first.messageId &&
            block.blockId === first.blockId &&
            block.streamId === first.streamId &&
            block.source === first.source,
        )))
  );
}

function finalDuplicatesDeltas(turn: EngineExecutionTurn): boolean {
  const result = turn.execution.result;
  if (result === null || !turn.deltas.length) return false;
  if (turn.deltas.some((block) => block.text === result)) return true;
  const [first, ...rest] = turn.deltas;
  return (
    !!first?.identityKnown &&
    rest.every(
      (block) =>
        block.identityKnown &&
        block.messageId === first.messageId &&
        block.streamId === first.streamId &&
        block.source === first.source,
    ) &&
    turn.deltas.map((block) => block.text).join("") === result
  );
}

function finalExtendsDeltas(turn: EngineExecutionTurn): boolean {
  const result = turn.execution.result;
  if (result === null || !sameAnswerBlock(turn)) return false;
  const streamed = turn.deltas.map((block) => block.text).join("");
  return streamed.length > 0 && result.length > streamed.length && result.startsWith(streamed);
}

type EngineFindProjection = {
  renderUnits: ConversationTurnRenderUnit[];
  rowIdByInputId: Map<string, number>;
  rowIdByAnswerKey: Map<string, number>;
};

type EngineVisibleAssistantAnswer = {
  parts: Array<{ key: string; text: string }>;
  finalExtendsPartialStream: boolean;
  finalReplacesPartialStream: boolean;
  finalAlreadyShown: boolean;
};

function textRevision(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return `${text.length}:${hash >>> 0}`;
}

function visibleAssistantAnswer(turn: EngineExecutionTurn): EngineVisibleAssistantAnswer {
  const { execution, deltas, items } = turn;
  const finalExtendsPartialStream = !isInProgress(execution.status) && finalExtendsDeltas(turn);
  const firstDeltaIndex = items.findIndex((item) => item.kind === "delta");
  const lastDeltaIndex = items.findLastIndex((item) => item.kind === "delta");
  const hasInterleavedContent = items
    .slice(firstDeltaIndex + 1, lastDeltaIndex)
    .some((item) => item.kind !== "delta");
  const finalReplacesPartialStream = finalExtendsPartialStream && !hasInterleavedContent;
  const finalAlreadyShown = finalExtendsPartialStream || finalDuplicatesDeltas(turn);
  const finalSuffix =
    finalExtendsPartialStream && hasInterleavedContent
      ? execution.result?.slice(deltas.map((block) => block.text).join("").length)
      : "";
  const firstDelta = deltas[0];
  const parts: Array<{ key: string; text: string }> = [];

  for (const item of items) {
    if (item.kind !== "delta") continue;
    if (finalReplacesPartialStream && item.block !== firstDelta) continue;
    parts.push({
      key: item.block.key,
      text: finalReplacesPartialStream
        ? (execution.result ?? item.block.text)
        : item.block.text + (item.block === deltas.at(-1) ? finalSuffix : ""),
    });
  }
  if (execution.result && !finalAlreadyShown) {
    parts.push({ key: `engine-result:${execution.id}`, text: execution.result });
  }
  return {
    parts,
    finalExtendsPartialStream,
    finalReplacesPartialStream,
    finalAlreadyShown,
  };
}

function buildEngineFindProjection(projection: EngineConversationProjection): EngineFindProjection {
  let nextRowId = 1;
  const rowIdByInputId = new Map<string, number>();
  const rowIdByAnswerKey = new Map<string, number>();
  const renderUnits = projection.turns.map((turn) => {
    const userRowId = nextRowId++;
    rowIdByInputId.set(turn.input.id, userRowId);
    const userRow = {
      kind: "userInput",
      rowId: userRowId,
      turnId: turn.input.id,
      text: turn.input.text,
    } as unknown as UserInputRow;
    const assistantTextRows: AssistantTextRow[] = [];
    let isRunning = false;
    const contentRevisionParts = [`input:${textRevision(turn.input.text)}`];

    for (const executionTurn of turn.executions) {
      const answer = visibleAssistantAnswer(executionTurn);
      isRunning ||= isInProgress(executionTurn.execution.status);
      contentRevisionParts.push(
        [
          executionTurn.execution.id,
          executionTurn.execution.status,
          executionTurn.execution.terminalAt ?? "open",
          textRevision(executionTurn.execution.result ?? ""),
          executionTurn.events.length,
          executionTurn.events.at(-1)?.id ?? "no-event",
          answer.parts.map((part) => `${part.key}:${textRevision(part.text)}`).join(","),
        ].join(":"),
      );
      for (const part of answer.parts) {
        const rowId = nextRowId++;
        rowIdByAnswerKey.set(part.key, rowId);
        assistantTextRows.push({
          kind: "assistantText",
          rowId,
          turnId: turn.input.id,
          text: part.text,
          state: isInProgress(executionTurn.execution.status) ? "streaming" : "complete",
        } as unknown as AssistantTextRow);
      }
    }

    // The native find cache treats a stable unit key as immutable text. Engine can attach a late
    // event or result to a completed input, so include its projected row and event revision.
    return {
      key: `${turn.input.id}:${contentRevisionParts.join("|")}`,
      turnId: turn.input.id,
      visibleUserInputs: [userRow],
      assistantTextRows,
      isRunning,
    } as ConversationTurnRenderUnit;
  });
  return { renderUnits, rowIdByInputId, rowIdByAnswerKey };
}

function EngineConversationFindController({
  rootRef,
  findProjection,
  conversationFindQuery,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  onConversationFindMatchStateChange,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
  findProjection: EngineFindProjection;
  conversationFindQuery: string;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
}) {
  const mountedRowsKey = findProjection.renderUnits
    .map((unit) => `${unit.key}:${unit.isRunning ? "running" : "stable"}`)
    .join("|");
  useConversationTimelineFind({
    rootRef,
    renderUnits: findProjection.renderUnits,
    rows: [],
    mountedRowsKey,
    canLoadOlder: false,
    loadingOlder: false,
    conversationFindQuery,
    conversationFindActiveIndex,
    conversationFindNavigationRequestId,
    onConversationFindMatchStateChange,
    scrollToUnit: () => {},
  });
  return null;
}

type EngineToolEventData = {
  id: string;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  sideEffects?: unknown;
};

function toolEvents(turn: EngineExecutionTurn): EngineToolEventData[] {
  const byId = new Map<string, EngineToolEventData>();
  for (const event of turn.events) {
    if (event.duplicateOf) continue;
    if (
      event.type !== "tool.started" &&
      event.type !== "tool.completed" &&
      event.type !== "tool.failed"
    )
      continue;
    const callId = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : null;
    const name = typeof event.payload.name === "string" ? event.payload.name : "未知工具";
    if (!callId) continue;
    const item = byId.get(callId) ?? { id: callId, name, status: "pending" };
    if (name !== "未知工具") item.name = name;
    if (event.payload.input !== undefined) item.input = event.payload.input;
    if (event.type === "tool.started") {
      item.status = "in_progress";
    } else if (event.type === "tool.completed") {
      item.output = event.payload.result;
      item.sideEffects = event.payload.sideEffects;
      item.status = "completed";
    } else {
      const failure = event.payload.failure;
      item.error =
        failure &&
        typeof failure === "object" &&
        "message" in failure &&
        typeof failure.message === "string"
          ? failure.message
          : jsonLabel(failure);
      item.status = "failed";
    }
    byId.set(callId, item);
  }
  return [...byId.values()];
}

function EngineToolEvent({
  item,
  workspacePath,
  onOpenCodeViewer,
  onOpenFileLink,
}: {
  item: ReturnType<typeof toolEvents>[number];
  workspacePath: string;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
}) {
  const toolCallNode: TaskChatToolCallTreeNode = {
    toolCall: {
      toolId: item.id,
      toolName: item.name,
      kind: item.name,
      input: item.input,
      status: item.status,
      ...(item.output === undefined ? {} : { output: item.output }),
      ...(item.error === undefined ? {} : { error: item.error }),
      ...(item.sideEffects === undefined ? {} : { raw: { sideEffects: item.sideEffects } }),
    },
    childToolCalls: [],
  };
  return (
    <ToolCallBlock
      toolCallNode={toolCallNode}
      workspacePath={workspacePath}
      onOpenCodeViewer={onOpenCodeViewer}
      onOpenFileLink={onOpenFileLink}
    />
  );
}

function InlineApproval({
  approval,
  disabledReason,
  busyAction,
  onReply,
}: {
  approval: EngineApproval;
  disabledReason: string | null;
  busyAction: string | null;
  onReply: (approvalId: string, optionId: string, feedback?: string) => void;
}) {
  return (
    <Message from="assistant" data-testid={`engine-approval-${approval.id}`}>
      <MessageContent className="w-full max-w-2xl rounded-lg border border-warning/30 bg-warning/5 p-3">
        <p className="text-sm font-medium">需要批准 · {approval.operation}</p>
        {approval.scope ? (
          <p className="mt-1 text-xs text-foreground-subtle">范围：{approval.scope}</p>
        ) : null}
        {approval.expiresAt !== null ? (
          <p className="mt-1 text-xs text-foreground-subtle">
            到期：{timeLabel(approval.expiresAt)}
          </p>
        ) : null}
        {approval.options.length === 0 ? (
          <p className="mt-2 text-xs text-warning">暂时无法答复此请求。</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {approval.options.map((option) => {
              const requiresFreeText = option.id === WORKFLOW_REFINE_PERMISSION_OPTION_ID;
              return (
                <Button
                  key={option.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    !!disabledReason ||
                    busyAction !== null ||
                    requiresFreeText ||
                    option.requiresFeedback === true
                  }
                  title={
                    disabledReason ??
                    (requiresFreeText || option.requiresFeedback
                      ? "此选项需要填写反馈文本；当前请求没有可用的原生反馈输入。"
                      : undefined)
                  }
                  onClick={() => {
                    if (!requiresFreeText && !option.requiresFeedback)
                      onReply(approval.id, option.id);
                  }}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
        )}
        {disabledReason ? <p className="mt-2 text-xs text-warning">{disabledReason}</p> : null}
        {approval.options.some(
          (option) => option.id === WORKFLOW_REFINE_PERMISSION_OPTION_ID || option.requiresFeedback,
        ) ? (
          <p className="mt-2 text-xs text-warning">
            工作流修改反馈需要通过原生审批对话框填写后提交。
          </p>
        ) : null}
      </MessageContent>
    </Message>
  );
}

function permissionOrigin(value: unknown): ZCodeInteractionRequestOrigin | undefined {
  if (
    !isPlainRecord(value) ||
    value.kind !== "subagent" ||
    typeof value.agentId !== "string" ||
    typeof value.agentType !== "string" ||
    typeof value.childSessionId !== "string" ||
    typeof value.parentSessionId !== "string"
  )
    return undefined;
  return value as unknown as ZCodeInteractionRequestOrigin;
}

function nativePermissionRequest(approval: EngineApproval): ZCodePermissionRequest | null {
  const presentation = approval.presentation;
  if (!presentation?.toolCallId || approval.options.length === 0) return null;

  const options: ZCodePermissionOption[] = [];
  for (const option of approval.options) {
    const native = option.presentation;
    if (
      !native?.kind ||
      !native.response ||
      !isPlainRecord(native.response) ||
      (native.response.decision !== "allow" && native.response.decision !== "deny")
    )
      return null;
    options.push({
      optionId: option.id,
      kind: native.kind,
      name: option.label,
      ...(native.description ? { description: native.description } : {}),
      response: native.response as ZCodePermissionOption["response"],
    });
  }

  const origin = permissionOrigin(presentation.origin);
  const raw = {
    toolCallId: presentation.toolCallId,
    toolName: approval.operation,
    ...(approval.scope === null ? {} : { reason: approval.scope }),
    ...(presentation.riskLevel ? { riskLevel: presentation.riskLevel } : {}),
    ...(presentation.input === undefined ? {} : { input: presentation.input }),
  };
  return {
    type: "permission_request",
    taskId: approval.taskId as ZCodePermissionRequest["taskId"],
    traceId: approval.executionId as ZCodePermissionRequest["traceId"],
    requestId: approval.id,
    description: approval.scope ?? approval.operation,
    kind: approval.operation,
    title: approval.operation,
    options,
    ...(approval.options.some((option) => option.requiresFeedback) ? { freeText: true } : {}),
    ...(origin ? { origin } : {}),
    raw,
  };
}

function nativeElicitationRequest(request: EngineUserInput): ZCodeElicitationRequest | null {
  const source = request.presentation;
  if (!source?.questions.length) return null;
  const questions = source.questions.map((question) => ({
    question: question.question,
    header: question.header,
    options: question.options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
  }));
  const first = questions[0];
  if (!first) return null;
  const origin = permissionOrigin(source.origin);
  return {
    type: "elicitation_request",
    taskId: request.taskId,
    traceId: request.executionId as ZCodeElicitationRequest["traceId"],
    requestId: request.id,
    message: first.question,
    header: first.header,
    options: first.options,
    questions,
    ...(origin ? { origin } : {}),
  };
}

function ApprovalEntry({
  approval,
  executionTerminal = false,
  workspacePath,
  disabledReason,
  busyAction,
  onReply,
}: {
  approval: EngineApproval;
  executionTerminal?: boolean;
  workspacePath: string;
  disabledReason: string | null;
  busyAction: string | null;
  onReply: (approvalId: string, optionId: string, feedback?: string) => void;
}) {
  if (executionTerminal && approval.status === "pending")
    return (
      <p className="ml-4 text-xs text-foreground-subtle">执行已结束，此授权请求不可再答复。</p>
    );
  if (approval.status !== "pending") {
    if (approval.status === "expired" || approval.status === "unknown")
      return (
        <p className="ml-4 text-xs text-foreground-subtle">
          {approval.status === "expired" ? "授权请求已过期。" : "授权结果暂时无法确认。"}
        </p>
      );
    return null;
  }
  const request = nativePermissionRequest(approval);
  if (request) {
    return (
      <Message from="assistant" data-testid={`engine-approval-${approval.id}`}>
        <PermissionDialog
          key={approval.id}
          request={request}
          workspacePath={workspacePath}
          responding={busyAction !== null || disabledReason !== null}
          onRespond={(requestId, option, feedback) => {
            if (requestId === approval.id) onReply(approval.id, option.optionId, feedback);
          }}
        />
      </Message>
    );
  }
  return (
    <InlineApproval
      approval={approval}
      disabledReason={disabledReason}
      busyAction={busyAction}
      onReply={onReply}
    />
  );
}

function InlineUserInput({
  request,
  executionTerminal = false,
  disabledReason,
  busyAction,
  onReply,
}: {
  request: EngineUserInput;
  executionTerminal?: boolean;
  disabledReason: string | null;
  busyAction: string | null;
  onReply: (requestId: string, response: EngineUserInputAnswer) => void;
}) {
  if (executionTerminal && request.status === "pending")
    return <p className="ml-4 text-xs text-foreground-subtle">执行已结束，此提问不可再答复。</p>;
  if (request.status !== "pending") {
    if (request.status === "expired" || request.status === "unknown")
      return (
        <p className="ml-4 text-xs text-foreground-subtle">
          {request.status === "expired" ? "提问已过期。" : "答复结果暂时无法确认。"}
        </p>
      );
    return null;
  }
  const elicitation = nativeElicitationRequest(request);
  if (elicitation && !disabledReason && busyAction === null) {
    return (
      <Message from="assistant" data-testid={`engine-user-input-${request.id}`}>
        <ElicitationDialog
          request={elicitation}
          onRespond={(requestId, action, content) => {
            if (requestId !== request.id) return;
            onReply(request.id, {
              action,
              ...(content === undefined ? {} : { content: content as EngineJsonObject }),
            });
          }}
        />
      </Message>
    );
  }
  return (
    <Message from="assistant" data-testid={`engine-user-input-${request.id}`}>
      <MessageContent className="w-full max-w-2xl rounded-lg border border-input-border bg-card p-3">
        <p className="text-xs text-foreground-subtle">需要你的回答</p>
        <p className="mt-1 whitespace-pre-wrap text-sm">{request.prompt}</p>
        {request.expiresAt !== null ? (
          <p className="mt-1 text-xs text-foreground-subtle">
            到期：{timeLabel(request.expiresAt)}
          </p>
        ) : null}
        {request.inputKind === "choice" && request.options.length === 0 ? (
          <p className="mt-2 text-xs text-warning">暂时无法答复此请求。</p>
        ) : request.inputKind === "choice" ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {request.options.map((option) => (
              <Button
                key={option.id}
                type="button"
                variant="outline"
                size="sm"
                disabled={!!disabledReason || busyAction !== null}
                title={disabledReason ?? undefined}
                onClick={() => onReply(request.id, option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : request.inputKind === "text" ? (
          <UserInputReply
            requestId={request.id}
            disabled={!!disabledReason || busyAction !== null}
            onReply={onReply}
          />
        ) : (
          <p className="mt-2 text-xs text-warning">暂时无法答复此请求。</p>
        )}
        {disabledReason ? <p className="mt-2 text-xs text-warning">{disabledReason}</p> : null}
      </MessageContent>
    </Message>
  );
}

function UserInputReply({
  requestId,
  disabled,
  onReply,
}: {
  requestId: string;
  disabled: boolean;
  onReply: (requestId: string, response: EngineUserInputAnswer) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="mt-3 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const response = value.trim();
        if (response) onReply(requestId, response);
      }}
    >
      <Textarea
        aria-label="用户输入答复"
        disabled={disabled}
        className="resize-y"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" size="sm" disabled={disabled || !value.trim()} className="self-start">
        提交答复
      </Button>
    </form>
  );
}

export type EngineLocalAttachment = {
  localPath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

function EngineUserInputMessage({
  input,
  findRowId,
  workspacePath,
  superseded,
  editable,
  busyAction,
  onEdit,
  onPickEditAttachments,
}: {
  input: EngineInput;
  findRowId?: number;
  workspacePath: string;
  superseded: boolean;
  editable: boolean;
  busyAction: string | null;
  onEdit?: (
    text: string,
    retainedAttachmentIds: readonly string[],
    addedAttachments: readonly EngineLocalAttachment[],
  ) => Promise<boolean>;
  onPickEditAttachments?: () => Promise<EngineLocalAttachment[]>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(input.text);
  const [retainedAttachmentIds, setRetainedAttachmentIds] = useState<readonly string[]>(
    input.attachments?.map((attachment) => attachment.id) ?? [],
  );
  const [addedAttachments, setAddedAttachments] = useState<readonly EngineLocalAttachment[]>([]);
  const { intl } = useZCodeIntl();
  const visibleInput = parsePromptWebElementContexts(input.text, { workspacePath });
  const retainedAttachments =
    input.attachments?.filter((attachment) => retainedAttachmentIds.includes(attachment.id)) ?? [];
  const attachmentList = (removable: boolean) =>
    (removable ? retainedAttachments : (input.attachments ?? [])).length ? (
      <Attachments variant="inline" className="flex max-w-full flex-wrap gap-2">
        {(removable ? retainedAttachments : (input.attachments ?? [])).map((attachment) => (
          <Attachment
            key={attachment.id}
            variant="inline"
            data={{
              id: attachment.id,
              type: "file",
              filename: attachment.fileName,
              mediaType: attachment.mimeType,
              url: "",
            }}
            {...(removable
              ? {
                  onRemove: () =>
                    setRetainedAttachmentIds((current) =>
                      current.filter((id) => id !== attachment.id),
                    ),
                }
              : {})}
            data-testid={`engine-edit-attachment-${attachment.id}`}
          >
            <AttachmentPreview />
            <AttachmentInfo className="max-w-48 text-ui-base text-foreground" />
            {removable ? (
              <AttachmentRemove
                alwaysVisible
                label={intl.formatMessage({ id: "chat.attachments.remove" })}
              />
            ) : null}
          </Attachment>
        ))}
      </Attachments>
    ) : null;
  const addedAttachmentList = addedAttachments.length ? (
    <Attachments variant="inline" className="flex max-w-full flex-wrap gap-2">
      {addedAttachments.map((attachment, index) => (
        <Attachment
          key={`${attachment.localPath}:${index}`}
          variant="inline"
          data={{
            id: `${attachment.localPath}:${index}`,
            type: "file",
            filename: attachment.fileName,
            mediaType: attachment.mimeType,
            url: "",
          }}
          onRemove={() =>
            setAddedAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))
          }
          data-testid={`engine-edit-added-attachment-${index}`}
        >
          <AttachmentPreview />
          <AttachmentInfo className="max-w-48 text-ui-base text-foreground" />
          <AttachmentRemove
            alwaysVisible
            label={intl.formatMessage({ id: "chat.attachments.remove" })}
          />
        </Attachment>
      ))}
    </Attachments>
  ) : null;
  return (
    <Message from="user" data-testid={`engine-input-${input.id}`} data-row-id={findRowId}>
      <div className="group/user-row flex flex-col items-end">
        {editing && onEdit ? (
          <ChatPromptEditor
            workspacePath={workspacePath}
            taskId={null}
            enableMentionPanel={false}
            initialValue={input.text}
            topContent={
              retainedAttachments.length || addedAttachments.length ? (
                <>
                  {attachmentList(true)}
                  {addedAttachmentList}
                </>
              ) : null
            }
            attachmentAction={
              onPickEditAttachments
                ? {
                    label: intl.formatMessage({ id: "chat.composer.attachment" }),
                    onSelect: () =>
                      void onPickEditAttachments().then((picked) =>
                        setAddedAttachments((current) => [...current, ...picked]),
                      ),
                    testId: `engine-edit-attachment-action-${input.id}`,
                    menuItemTestId: `engine-edit-attachment-menu-item-${input.id}`,
                  }
                : undefined
            }
            submitting={busyAction !== null}
            submitDisabled={
              !draft.trim() ||
              busyAction !== null ||
              retainedAttachments.length + addedAttachments.length > 8
            }
            submitLabel={intl.formatMessage({ id: "chat.send" })}
            cancelLabel={intl.formatMessage({ id: "common.cancel" })}
            inputTestId={`engine-edit-input-${input.id}`}
            submitTestId={`engine-edit-submit-${input.id}`}
            cancelTestId={`engine-edit-cancel-${input.id}`}
            className="w-full max-w-xl"
            shellClassName="min-h-32"
            onChange={setDraft}
            onSubmit={(text) => {
              void onEdit(text, retainedAttachmentIds, addedAttachments).then((accepted) => {
                if (accepted) setEditing(false);
              });
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <div
              data-v4-user-input-bubble="true"
              className="flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl"
            >
              <ConversationUserInputContent text={visibleInput.visibleContent} />
              <WebElementContextAttachmentChip contexts={visibleInput.webElementContexts} />
              {attachmentList(false)}
            </div>
            <ConversationUserInputActions
              text={visibleInput.visibleContent}
              editActionTestId={`engine-edit-${input.id}`}
              onEdit={
                editable && onEdit
                  ? () => {
                      setDraft(input.text);
                      setRetainedAttachmentIds(
                        input.attachments?.map((attachment) => attachment.id) ?? [],
                      );
                      setAddedAttachments([]);
                      setEditing(true);
                    }
                  : undefined
              }
            />
          </>
        )}
        {input.revisionOf ? (
          <span className="mt-1 text-xs text-foreground-subtle">
            {input.status === "unknown"
              ? "修订请求结果未知"
              : input.status === "rejected"
                ? "修订请求已拒绝"
                : input.revisionOf.kind === "edit"
                  ? "编辑后的输入"
                  : "重试的输入"}
          </span>
        ) : superseded ? (
          <span className="mt-1 text-xs text-foreground-subtle">此前版本 · 已由后续轮次修订</span>
        ) : null}
        {input.status === "rejected" || input.status === "failed" || input.status === "unknown" ? (
          <div className="mt-1 text-[11px] text-foreground-subtle">
            {input.status === "unknown"
              ? "发送状态暂时无法确认。"
              : input.status === "rejected"
                ? "消息未被接收。"
                : "消息发送失败。"}
          </div>
        ) : null}
      </div>
    </Message>
  );
}

function isSupersededInput(projection: EngineConversationProjection, inputId: string): boolean {
  return projection.turns.some(
    (later) =>
      later.input.revisionOf?.inputId === inputId &&
      ["native-accepted", "started", "completed", "failed", "stopped"].includes(later.input.status),
  );
}

function EngineTurnFrame({
  inputId,
  superseded,
  children,
}: {
  inputId: string;
  superseded: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3" data-testid={`engine-turn-${inputId}`}>
      {superseded ? (
        <details
          className="rounded-lg border border-border bg-surface/30 p-3 text-foreground-subtle"
          data-testid={`engine-superseded-turn-${inputId}`}
        >
          <summary className="cursor-pointer text-sm">此前版本 · 已由后续轮次修订</summary>
          <div className="mt-3 space-y-3">{children}</div>
        </details>
      ) : (
        children
      )}
    </section>
  );
}

export function EngineConversationTimeline({
  projection,
  inheritedSources = [],
  readOnlySource = false,
  workspacePath,
  onOpenCodeViewer,
  onOpenFileLink,
  historyLoading,
  approvalBlockedReason,
  userInputBlockedReason,
  busyAction,
  onReplyApproval,
  onReplyUserInput,
  assistantFeedbackBlockedReason = null,
  assistantFeedback,
  onAssistantFeedback,
  forkBlockedReason = null,
  onForkExecution,
  revisionBlockedReason = null,
  onEditExecution,
  onRetryExecution,
  fileRewindBlockedReason,
  onLoadFileChanges,
  onPreviewFileRewind,
  onApplyFileRewind,
  onPickEditAttachments,
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
}: {
  projection: EngineConversationProjection;
  inheritedSources?: readonly {
    sourceTaskId: string;
    projection: EngineConversationProjection | null;
  }[];
  readOnlySource?: boolean;
  workspacePath: string;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  historyLoading: boolean;
  approvalBlockedReason: string | null;
  userInputBlockedReason: string | null;
  busyAction: string | null;
  onReplyApproval: (approvalId: string, optionId: string, feedback?: string) => void;
  onReplyUserInput: (requestId: string, response: EngineUserInputAnswer) => void;
  assistantFeedbackBlockedReason?: string | null;
  assistantFeedback?: Readonly<Record<string, "like" | "dislike" | null>>;
  onAssistantFeedback?: (
    executionId: string,
    messageId: string,
    feedback: "like" | "dislike" | null,
  ) => Promise<boolean>;
  forkBlockedReason?: string | null;
  onForkExecution?: (executionId: string) => void;
  revisionBlockedReason?: string | null;
  onEditExecution?: (
    executionId: string,
    text: string,
    retainedAttachmentIds: readonly string[],
    addedAttachments: readonly EngineLocalAttachment[],
  ) => Promise<boolean>;
  onRetryExecution?: (executionId: string) => void;
  fileRewindBlockedReason?: string | null;
  onLoadFileChanges?: (executionId: string) => Promise<EngineFileChanges | null>;
  onPreviewFileRewind?: (executionId: string) => Promise<EngineFileRewindPreview>;
  onApplyFileRewind?: (
    executionId: string,
    preview: EngineFileRewindPreview,
  ) => Promise<{ status: "requested" | "applied" | "rejected" | "unknown"; reason: string | null }>;
  onPickEditAttachments?: () => Promise<EngineLocalAttachment[]>;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const findProjection = useMemo(() => buildEngineFindProjection(projection), [projection]);
  // Native v4 only marks the latest real user query editable. An older completed
  // Execution must not gain an edit action just because a newer turn has no Execution.
  const latestEditableExecutionId = [...(projection.turns.at(-1)?.executions ?? [])]
    .reverse()
    .find((turn) => turn.execution.status === "completed")?.execution.id;
  const latestRetryableTurn = projection.turns.at(-1)?.executions.at(-1);
  const latestRetryableExecutionId =
    latestRetryableTurn &&
    ["completed", "failed"].includes(latestRetryableTurn.execution.status) &&
    toolEvents(latestRetryableTurn).length === 0
      ? latestRetryableTurn.execution.id
      : undefined;
  if (historyLoading) {
    return <p className="py-4 text-sm text-foreground-subtle">正在读取对话…</p>;
  }
  if (
    !projection.turns.length &&
    !projection.unassociatedExecutions.length &&
    !projection.unassociatedApprovals.length &&
    !projection.unassociatedUserInputs.length &&
    !inheritedSources.length
  ) {
    return (
      <div
        ref={rootRef}
        className="mx-auto w-full py-4"
        data-testid={readOnlySource ? "engine-inherited-timeline" : "engine-conversation-timeline"}
      >
        {!readOnlySource ? (
          <AssistantCodeCommentFeatureProvider enabled={false}>
            <EngineConversationFindController
              rootRef={rootRef}
              findProjection={findProjection}
              conversationFindQuery={conversationFindQuery}
              conversationFindActiveIndex={conversationFindActiveIndex}
              conversationFindNavigationRequestId={conversationFindNavigationRequestId}
              onConversationFindMatchStateChange={onConversationFindMatchStateChange}
            />
          </AssistantCodeCommentFeatureProvider>
        ) : null}
        <p className="text-sm text-foreground-subtle">开始对话吧。</p>
      </div>
    );
  }
  return (
    <div
      ref={rootRef}
      className="mx-auto flex w-full flex-col gap-5 py-4"
      data-testid={readOnlySource ? "engine-inherited-timeline" : "engine-conversation-timeline"}
    >
      {!readOnlySource ? (
        <AssistantCodeCommentFeatureProvider enabled={false}>
          <EngineConversationFindController
            rootRef={rootRef}
            findProjection={findProjection}
            conversationFindQuery={conversationFindQuery}
            conversationFindActiveIndex={conversationFindActiveIndex}
            conversationFindNavigationRequestId={conversationFindNavigationRequestId}
            onConversationFindMatchStateChange={onConversationFindMatchStateChange}
          />
        </AssistantCodeCommentFeatureProvider>
      ) : null}
      {inheritedSources.map((source) => (
        <div
          key={source.sourceTaskId}
          data-testid={`engine-inherited-source-${source.sourceTaskId}`}
        >
          <p className="mb-3 text-xs text-foreground-subtle">来自原对话 · 只读</p>
          {source.projection ? (
            <EngineConversationTimeline
              projection={source.projection}
              readOnlySource
              workspacePath={workspacePath}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              historyLoading={false}
              approvalBlockedReason="继承来源只读。"
              userInputBlockedReason="继承来源只读。"
              busyAction={busyAction}
              onReplyApproval={onReplyApproval}
              onReplyUserInput={onReplyUserInput}
              forkBlockedReason="继承来源只读。"
            />
          ) : (
            <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
              继承来源历史无法核实；此处不展示未经确认的对话内容。
            </p>
          )}
        </div>
      ))}
      {projection.turns.map((turn) => (
        <EngineTurnFrame
          key={turn.input.id}
          inputId={turn.input.id}
          superseded={isSupersededInput(projection, turn.input.id)}
        >
          <EngineUserInputMessage
            input={turn.input}
            findRowId={
              !readOnlySource ? findProjection.rowIdByInputId.get(turn.input.id) : undefined
            }
            workspacePath={workspacePath}
            superseded={isSupersededInput(projection, turn.input.id)}
            editable={
              !readOnlySource &&
              !revisionBlockedReason &&
              turn.executions.some((entry) => entry.execution.id === latestEditableExecutionId)
            }
            busyAction={busyAction}
            onPickEditAttachments={!readOnlySource ? onPickEditAttachments : undefined}
            onEdit={
              onEditExecution && latestEditableExecutionId
                ? (text, retainedAttachmentIds, addedAttachments) =>
                    onEditExecution(
                      latestEditableExecutionId,
                      text,
                      retainedAttachmentIds,
                      addedAttachments,
                    )
                : undefined
            }
          />
          {turn.executions.map((executionTurn) => {
            const execution = executionTurn.execution;
            const deltas = executionTurn.deltas;
            const streaming = isInProgress(execution.status);
            const terminal = ["completed", "failed", "stopped"].includes(execution.status);
            const answerDisplay = visibleAssistantAnswer(executionTurn);
            const { finalReplacesPartialStream, finalAlreadyShown } = answerDisplay;
            const toolParts = new Map(toolEvents(executionTurn).map((item) => [item.id, item]));
            const approvalById = new Map(executionTurn.approvals.map((item) => [item.id, item]));
            const userInputById = new Map(executionTurn.userInputs.map((item) => [item.id, item]));
            const placedApprovalIds = new Set(
              executionTurn.items
                .filter((item) => item.kind === "approval")
                .map((item) => item.approvalId),
            );
            const placedUserInputIds = new Set(
              executionTurn.items
                .filter((item) => item.kind === "user-input")
                .map((item) => item.requestId),
            );
            const hasAssistantAnswer = deltas.length > 0 || execution.result !== null;
            const latestDeltaKey = deltas.at(-1)?.key;
            const completionTime = execution.terminalAt;
            const durationMs =
              execution.startedAt !== null && completionTime !== null
                ? completionTime - execution.startedAt
                : undefined;
            const duration =
              durationMs !== undefined && durationMs >= 0
                ? formatConversationWorkDuration(durationMs, intl, locale)
                : null;
            const workStatusLabel =
              execution.status === "stopped"
                ? intl.formatMessage({ id: "chat.history.stopped" })
                : duration && (execution.status === "completed" || execution.status === "failed")
                  ? intl.formatMessage({ id: "chat.history.workedFor" }, { duration })
                  : null;
            const feedbackUnavailableReason = intl.formatMessage({
              id: "engine.message.feedbackUnsupported",
            });
            const feedbackActionForBlock = (block: EngineDeltaBlock | undefined) => {
              if (
                readOnlySource ||
                assistantFeedbackBlockedReason ||
                busyAction ||
                !onAssistantFeedback ||
                !block?.messageId ||
                (assistantFeedback !== undefined &&
                  !Object.hasOwn(assistantFeedback, block.messageId)) ||
                block.source !== "engine" ||
                !["completed", "failed", "stopped"].includes(execution.status)
              ) {
                return undefined;
              }
              return (feedback: "like" | "dislike" | null) =>
                onAssistantFeedback(execution.id, block.messageId!, feedback);
            };
            const feedbackDisabledReason = readOnlySource
              ? "继承来源只读。"
              : (assistantFeedbackBlockedReason ?? feedbackUnavailableReason);
            const forkUnavailableReason = intl.formatMessage({
              id: "engine.message.forkUnsupported",
            });
            return (
              <div
                key={execution.id}
                className="space-y-3"
                data-testid={`engine-execution-${execution.id}`}
              >
                {workStatusLabel ? (
                  <div
                    className="flex w-full border-b border-[var(--color-border)]/50 pb-2"
                    data-testid={`engine-work-status-${execution.id}`}
                  >
                    <span className="text-ui-base text-foreground-subtle">{workStatusLabel}</span>
                  </div>
                ) : null}
                {executionTurn.items.map((item) => {
                  if (item.kind === "delta") {
                    const answerPart = answerDisplay.parts.find(
                      (part) => part.key === item.block.key,
                    );
                    if (!answerPart) return null;
                    const firstDelta = item.block === deltas[0];
                    const text = answerPart.text;
                    const showsFinalAnswer =
                      !streaming &&
                      hasAssistantAnswer &&
                      (finalReplacesPartialStream
                        ? firstDelta
                        : finalAlreadyShown || !execution.result
                          ? item.block.key === latestDeltaKey
                          : false);
                    return (
                      <Message
                        key={item.block.key}
                        from="assistant"
                        className="group/assistant-row"
                        data-row-id={
                          !readOnlySource
                            ? findProjection.rowIdByAnswerKey.get(item.block.key)
                            : undefined
                        }
                        data-testid={
                          finalReplacesPartialStream
                            ? `engine-final-${execution.id}`
                            : `engine-answer-${execution.id}`
                        }
                      >
                        <MessageContent>
                          <MessageResponse
                            streaming={streaming}
                            workspacePath={workspacePath}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                          >
                            {text}
                          </MessageResponse>
                        </MessageContent>
                        {showsFinalAnswer ? (
                          <ConversationAssistantTextActions
                            text={execution.result ?? text}
                            createdAt={assistantAnswerTimestamp(executionTurn)}
                            entityId={item.block.messageId ?? undefined}
                            feedback={
                              item.block.messageId
                                ? assistantFeedback?.[item.block.messageId]
                                : undefined
                            }
                            onFeedbackAction={feedbackActionForBlock(item.block)}
                            unsupportedFeedbackReason={feedbackDisabledReason}
                            unsupportedForkReason={
                              readOnlySource
                                ? "继承来源只读。"
                                : (forkBlockedReason ?? forkUnavailableReason)
                            }
                            onForkAction={
                              !readOnlySource &&
                              !forkBlockedReason &&
                              execution.status === "completed" &&
                              onForkExecution
                                ? () => onForkExecution(execution.id)
                                : undefined
                            }
                            forkActionId={execution.id}
                            onRetryAction={
                              !readOnlySource &&
                              !revisionBlockedReason &&
                              !busyAction &&
                              execution.reconciledAt === undefined &&
                              execution.id === latestRetryableExecutionId &&
                              onRetryExecution
                                ? () => onRetryExecution(execution.id)
                                : undefined
                            }
                            retryActionId={execution.id}
                            className="mt-1 opacity-0 transition-opacity group-hover/assistant-row:opacity-100 focus-within:opacity-100"
                          />
                        ) : null}
                      </Message>
                    );
                  }
                  if (item.kind === "tool") {
                    const tool = toolParts.get(item.toolCallId);
                    return tool ? (
                      <EngineToolEvent
                        key={`tool:${item.toolCallId}`}
                        item={tool}
                        workspacePath={workspacePath}
                        onOpenCodeViewer={onOpenCodeViewer}
                        onOpenFileLink={onOpenFileLink}
                      />
                    ) : null;
                  }
                  if (item.kind === "approval") {
                    const approval = approvalById.get(item.approvalId);
                    return approval ? (
                      <ApprovalEntry
                        key={approval.id}
                        approval={approval}
                        executionTerminal={terminal}
                        workspacePath={workspacePath}
                        disabledReason={readOnlySource ? "继承来源只读。" : approvalBlockedReason}
                        busyAction={busyAction}
                        onReply={onReplyApproval}
                      />
                    ) : null;
                  }
                  if (item.kind === "user-input") {
                    const request = userInputById.get(item.requestId);
                    return request ? (
                      <InlineUserInput
                        key={request.id}
                        request={request}
                        executionTerminal={terminal}
                        disabledReason={readOnlySource ? "继承来源只读。" : userInputBlockedReason}
                        busyAction={busyAction}
                        onReply={onReplyUserInput}
                      />
                    ) : null;
                  }
                })}
                {execution.result && !finalAlreadyShown ? (
                  <Message
                    from="assistant"
                    className="group/assistant-row"
                    data-testid={`engine-final-${execution.id}`}
                    data-row-id={
                      !readOnlySource
                        ? findProjection.rowIdByAnswerKey.get(`engine-result:${execution.id}`)
                        : undefined
                    }
                  >
                    <MessageContent>
                      {deltas.length ? (
                        <p className="mb-1 text-xs text-foreground-subtle">
                          最终结果与流式内容不同
                        </p>
                      ) : null}
                      <MessageResponse
                        workspacePath={workspacePath}
                        onOpenCodeViewer={onOpenCodeViewer}
                        onOpenFileLink={onOpenFileLink}
                      >
                        {execution.result}
                      </MessageResponse>
                    </MessageContent>
                    {!streaming && hasAssistantAnswer ? (
                      <ConversationAssistantTextActions
                        text={execution.result}
                        createdAt={assistantAnswerTimestamp(executionTurn)}
                        entityId={executionTurn.deltas.at(-1)?.messageId ?? undefined}
                        feedback={
                          executionTurn.deltas.at(-1)?.messageId
                            ? assistantFeedback?.[executionTurn.deltas.at(-1)!.messageId!]
                            : undefined
                        }
                        onFeedbackAction={feedbackActionForBlock(executionTurn.deltas.at(-1))}
                        unsupportedFeedbackReason={feedbackDisabledReason}
                        unsupportedForkReason={
                          readOnlySource
                            ? "继承来源只读。"
                            : (forkBlockedReason ?? forkUnavailableReason)
                        }
                        onForkAction={
                          !readOnlySource &&
                          !forkBlockedReason &&
                          execution.status === "completed" &&
                          onForkExecution
                            ? () => onForkExecution(execution.id)
                            : undefined
                        }
                        forkActionId={execution.id}
                        onRetryAction={
                          !readOnlySource &&
                          !revisionBlockedReason &&
                          !busyAction &&
                          execution.reconciledAt === undefined &&
                          execution.id === latestRetryableExecutionId &&
                          onRetryExecution
                            ? () => onRetryExecution(execution.id)
                            : undefined
                        }
                        retryActionId={execution.id}
                        className="mt-1 opacity-0 transition-opacity group-hover/assistant-row:opacity-100 focus-within:opacity-100"
                      />
                    ) : null}
                  </Message>
                ) : null}
                {!readOnlySource &&
                ["completed", "failed", "stopped"].includes(execution.status) &&
                onLoadFileChanges &&
                onPreviewFileRewind &&
                onApplyFileRewind ? (
                  <EngineExecutionFileSummary
                    executionId={execution.id}
                    workspacePath={workspacePath}
                    onOpenCodeViewer={onOpenCodeViewer}
                    blockedReason={fileRewindBlockedReason}
                    loadChanges={onLoadFileChanges}
                    previewRewind={onPreviewFileRewind}
                    applyRewind={onApplyFileRewind}
                  />
                ) : null}
                {!deltas.length && !execution.result && !toolParts.size && streaming ? (
                  <p className="ml-4 text-xs text-foreground-subtle">正在处理…</p>
                ) : null}
                {!deltas.length &&
                !execution.result &&
                !toolParts.size &&
                execution.status === "completed" ? (
                  <p className="ml-4 text-xs text-foreground-subtle">
                    {execution.reconciliationReason
                      ? "原生终态已对账；回答正文未恢复。"
                      : "本轮没有回答正文。"}
                  </p>
                ) : null}
                {!deltas.length &&
                !execution.result &&
                !toolParts.size &&
                execution.status === "stopped" ? (
                  <p className="ml-4 text-xs text-foreground-subtle">已确认停止；没有回答正文。</p>
                ) : null}
                {!deltas.length &&
                !execution.result &&
                !toolParts.size &&
                execution.status === "failed" &&
                !execution.error ? (
                  <p className="ml-4 text-xs text-destructive">执行失败；没有回答正文。</p>
                ) : null}
                {execution.status === "failed" && execution.error ? (
                  <p className="ml-4 text-sm text-destructive">处理失败，请刷新状态后重试。</p>
                ) : null}
                {executionTurn.approvals
                  .filter((approval) => !placedApprovalIds.has(approval.id))
                  .map((approval) => (
                    <ApprovalEntry
                      key={approval.id}
                      approval={approval}
                      executionTerminal={terminal}
                      workspacePath={workspacePath}
                      disabledReason={readOnlySource ? "继承来源只读。" : approvalBlockedReason}
                      busyAction={busyAction}
                      onReply={onReplyApproval}
                    />
                  ))}
                {executionTurn.userInputs
                  .filter((request) => !placedUserInputIds.has(request.id))
                  .map((request) => (
                    <InlineUserInput
                      key={request.id}
                      request={request}
                      executionTerminal={terminal}
                      disabledReason={readOnlySource ? "继承来源只读。" : userInputBlockedReason}
                      busyAction={busyAction}
                      onReply={onReplyUserInput}
                    />
                  ))}
                {!deltas.length && execution.result === null && execution.status === "unknown" ? (
                  <p className="ml-4 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
                    回复状态暂时无法确认。
                  </p>
                ) : null}
              </div>
            );
          })}
          {turn.events
            .filter((event) => event.type === "connection.disconnected")
            .map((event) => (
              <p key={event.id} className="ml-4 text-xs text-foreground-subtle">
                连接已中断，回复状态暂时无法确认。
              </p>
            ))}
          {!turn.executions.length ? (
            <p className="ml-4 rounded-md border border-dashed border-input-border p-2 text-xs text-foreground-subtle">
              {turn.input.status === "rejected"
                ? "消息未被接收。"
                : turn.input.status === "unknown"
                  ? "发送状态暂时无法确认。"
                  : turn.input.status === "queued"
                    ? "已加入队列。"
                    : "正在等待回复…"}
            </p>
          ) : null}
        </EngineTurnFrame>
      ))}
      {projection.unassociatedExecutions.map((execution) => (
        <p
          key={execution.id}
          className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning"
        >
          部分回复暂时无法显示。
        </p>
      ))}
      {projection.unassociatedApprovals.map((approval) => (
        <div key={approval.id}>
          <ApprovalEntry
            approval={approval}
            workspacePath={workspacePath}
            disabledReason={readOnlySource ? "继承来源只读。" : approvalBlockedReason}
            busyAction={busyAction}
            onReply={onReplyApproval}
          />
        </div>
      ))}
      {projection.unassociatedUserInputs.map((request) => (
        <div key={request.id}>
          <InlineUserInput
            request={request}
            disabledReason={readOnlySource ? "继承来源只读。" : userInputBlockedReason}
            busyAction={busyAction}
            onReply={onReplyUserInput}
          />
        </div>
      ))}
    </div>
  );
}
