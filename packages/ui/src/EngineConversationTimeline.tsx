/* oxlint-disable eslint(max-lines) -- 输入轮次、Execution 与对应交互必须沿同一消息序列呈现。 */
import { useState } from "react";
import {
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  type ZCodeElicitationRequest,
  type ZCodeInteractionRequestOrigin,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
} from "@zcode/shared";
import type { EngineJsonObject, EngineUserInputAnswer } from "@anyagent/engine-contract";
import type { EngineApproval, EngineInput, EngineUserInput } from "@/EngineUiParts.js";
import { jsonLabel, recordStatusLabel, shortId, timeLabel } from "@/EngineUiParts.js";
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
  const pending = approval.status === "pending";
  return (
    <Message from="assistant" data-testid={`engine-approval-${approval.id}`}>
      <MessageContent className="w-full max-w-2xl rounded-lg border border-warning/30 bg-warning/5 p-3">
        <p className="text-sm font-medium">
          审批 · {approval.operation} · {recordStatusLabel(approval.status)}
        </p>
        {approval.scope ? (
          <p className="mt-1 text-xs text-foreground-subtle">范围：{approval.scope}</p>
        ) : null}
        {approval.expiresAt !== null ? (
          <p className="mt-1 text-xs text-foreground-subtle">
            到期：{timeLabel(approval.expiresAt)}
          </p>
        ) : null}
        {pending && approval.options.length === 0 ? (
          <p className="mt-2 text-xs text-warning">
            当前 Engine 未提供可答复选项，暂不能从此处作答。
          </p>
        ) : pending ? (
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
        ) : approval.repliedOptionId ? (
          <p className="mt-2 text-xs text-foreground-subtle">
            答复选项：{approval.repliedOptionId}
          </p>
        ) : null}
        {disabledReason && pending ? (
          <p className="mt-2 text-xs text-warning">{disabledReason}</p>
        ) : null}
        {pending &&
        approval.options.some(
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
  workspacePath,
  disabledReason,
  busyAction,
  onReply,
}: {
  approval: EngineApproval;
  workspacePath: string;
  disabledReason: string | null;
  busyAction: string | null;
  onReply: (approvalId: string, optionId: string, feedback?: string) => void;
}) {
  const request = approval.status === "pending" ? nativePermissionRequest(approval) : null;
  if (request && !disabledReason) {
    return (
      <Message from="assistant" data-testid={`engine-approval-${approval.id}`}>
        <PermissionDialog
          key={approval.id}
          request={request}
          workspacePath={workspacePath}
          responding={busyAction !== null}
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
  disabledReason,
  busyAction,
  onReply,
}: {
  request: EngineUserInput;
  disabledReason: string | null;
  busyAction: string | null;
  onReply: (requestId: string, response: EngineUserInputAnswer) => void;
}) {
  const elicitation = nativeElicitationRequest(request);
  if (elicitation && request.status === "pending" && !disabledReason && busyAction === null) {
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
        <p className="text-xs text-foreground-subtle">
          需要你的输入 · {request.inputKind} · {recordStatusLabel(request.status)}
        </p>
        <p className="mt-1 whitespace-pre-wrap text-sm">{request.prompt}</p>
        {request.expiresAt !== null ? (
          <p className="mt-1 text-xs text-foreground-subtle">
            到期：{timeLabel(request.expiresAt)}
          </p>
        ) : null}
        {request.status === "pending" ? (
          request.inputKind === "choice" && request.options.length === 0 ? (
            <p className="mt-2 text-xs text-warning">
              当前 Engine 未提供可答复选项，暂不能从此处作答。
            </p>
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
            <p className="mt-2 text-xs text-warning">
              当前 Engine 未提供可验证的表单结构，暂不能从此处作答。
            </p>
          )
        ) : request.response != null ? (
          <pre className="mt-2 overflow-auto rounded bg-surface p-2 text-xs">
            {jsonLabel(request.response)}
          </pre>
        ) : null}
        {disabledReason && request.status === "pending" ? (
          <p className="mt-2 text-xs text-warning">{disabledReason}</p>
        ) : null}
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

function EngineUserInputMessage({
  input,
  workspacePath,
  superseded,
  editable,
  busyAction,
  onEdit,
}: {
  input: EngineInput;
  workspacePath: string;
  superseded: boolean;
  editable: boolean;
  busyAction: string | null;
  onEdit?: (text: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(input.text);
  const { intl } = useZCodeIntl();
  return (
    <Message from="user" data-testid={`engine-input-${input.id}`}>
      <div className="group/user-row flex flex-col items-end">
        {editing && onEdit ? (
          <ChatPromptEditor
            workspacePath={workspacePath}
            taskId={null}
            enableMentionPanel={false}
            initialValue={input.text}
            submitting={busyAction !== null}
            submitDisabled={!draft.trim() || busyAction !== null}
            submitLabel={intl.formatMessage({ id: "chat.send" })}
            cancelLabel={intl.formatMessage({ id: "common.cancel" })}
            inputTestId={`engine-edit-input-${input.id}`}
            submitTestId={`engine-edit-submit-${input.id}`}
            cancelTestId={`engine-edit-cancel-${input.id}`}
            className="w-full max-w-xl"
            shellClassName="min-h-32"
            onChange={setDraft}
            onSubmit={(text) => {
              void onEdit(text).then((accepted) => {
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
              <ConversationUserInputContent text={input.text} />
            </div>
            <ConversationUserInputActions
              text={input.text}
              editActionTestId={`engine-edit-${input.id}`}
              onEdit={
                editable && onEdit
                  ? () => {
                      setDraft(input.text);
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
            输入 · {recordStatusLabel(input.status)} · {timeLabel(input.receivedAt)}
          </div>
        ) : null}
        {input.error ? <p className="mt-2 text-sm text-destructive">{input.error}</p> : null}
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
  onAssistantFeedback,
  forkBlockedReason = null,
  onForkExecution,
  revisionBlockedReason = null,
  onEditExecution,
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
  onAssistantFeedback?: (
    executionId: string,
    messageId: string,
    feedback: "like" | "dislike" | null,
  ) => Promise<boolean>;
  forkBlockedReason?: string | null;
  onForkExecution?: (executionId: string) => void;
  revisionBlockedReason?: string | null;
  onEditExecution?: (executionId: string, text: string) => Promise<boolean>;
}) {
  const { intl, locale } = useZCodeIntl();
  // Native v4 only marks the latest real user query editable. An older completed
  // Execution must not gain an edit action just because a newer turn has no Execution.
  const latestEditableExecutionId = [...(projection.turns.at(-1)?.executions ?? [])]
    .reverse()
    .find((turn) => turn.execution.status === "completed")?.execution.id;
  if (historyLoading) {
    return <p className="py-4 text-sm text-foreground-subtle">正在读取对话…</p>;
  }
  if (
    !projection.turns.length &&
    !projection.unassociatedExecutions.length &&
    !projection.unassociatedEvents.length &&
    !projection.unassociatedApprovals.length &&
    !projection.unassociatedUserInputs.length &&
    !inheritedSources.length
  ) {
    return (
      <p className="py-4 text-sm text-foreground-subtle">
        此 Task 尚无输入。可以继续在下方开始一轮对话。
      </p>
    );
  }
  return (
    <div
      className="mx-auto flex w-full max-w-4xl flex-col gap-5 py-4"
      data-testid={readOnlySource ? "engine-inherited-timeline" : "engine-conversation-timeline"}
    >
      {inheritedSources.map((source) => (
        <div
          key={source.sourceTaskId}
          data-testid={`engine-inherited-source-${source.sourceTaskId}`}
        >
          <p className="mb-3 text-xs text-foreground-subtle">
            继承自 Task {shortId(source.sourceTaskId)} · 只读
          </p>
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
            workspacePath={workspacePath}
            superseded={isSupersededInput(projection, turn.input.id)}
            editable={
              !readOnlySource &&
              !revisionBlockedReason &&
              turn.executions.some((entry) => entry.execution.id === latestEditableExecutionId)
            }
            busyAction={busyAction}
            onEdit={
              onEditExecution && latestEditableExecutionId
                ? (text) => onEditExecution(latestEditableExecutionId, text)
                : undefined
            }
          />
          {turn.executions.map((executionTurn) => {
            const execution = executionTurn.execution;
            const deltas = executionTurn.deltas;
            const streaming = isInProgress(execution.status);
            const finalExtendsPartialStream = !streaming && finalExtendsDeltas(executionTurn);
            const firstDeltaIndex = executionTurn.items.findIndex((item) => item.kind === "delta");
            const lastDeltaIndex = executionTurn.items.findLastIndex(
              (item) => item.kind === "delta",
            );
            const hasInterleavedContent = executionTurn.items
              .slice(firstDeltaIndex + 1, lastDeltaIndex)
              .some((item) => item.kind !== "delta");
            const finalReplacesPartialStream = finalExtendsPartialStream && !hasInterleavedContent;
            const finalAlreadyShown =
              finalExtendsPartialStream || finalDuplicatesDeltas(executionTurn);
            const finalSuffix =
              finalExtendsPartialStream && hasInterleavedContent
                ? execution.result?.slice(deltas.map((block) => block.text).join("").length)
                : "";
            const toolParts = new Map(toolEvents(executionTurn).map((item) => [item.id, item]));
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
                    const firstDelta = item.block === deltas[0];
                    if (finalReplacesPartialStream && !firstDelta) return null;
                    const text = finalReplacesPartialStream
                      ? (execution.result ?? item.block.text)
                      : item.block.text + (item.block === deltas.at(-1) ? finalSuffix : "");
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
                })}
                {execution.result && !finalAlreadyShown ? (
                  <Message
                    from="assistant"
                    className="group/assistant-row"
                    data-testid={`engine-final-${execution.id}`}
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
                        className="mt-1 opacity-0 transition-opacity group-hover/assistant-row:opacity-100 focus-within:opacity-100"
                      />
                    ) : null}
                  </Message>
                ) : null}
                {!deltas.length && !execution.result && !toolParts.size && streaming ? (
                  <p className="ml-4 text-xs text-foreground-subtle">正在处理…</p>
                ) : null}
                {!deltas.length &&
                !execution.result &&
                !toolParts.size &&
                execution.status === "completed" ? (
                  <p className="ml-4 text-xs text-foreground-subtle">本轮没有回答正文。</p>
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
                {execution.error ? (
                  <p className="ml-4 text-sm text-destructive">{execution.error}</p>
                ) : null}
                {executionTurn.approvals.length || executionTurn.userInputs.length ? (
                  <p className="ml-4 text-xs text-foreground-subtle">
                    审批与用户输入属于此 Execution；原生请求身份未公开，内部顺序未知。
                  </p>
                ) : null}
                {executionTurn.approvals.map((approval) => (
                  <ApprovalEntry
                    key={approval.id}
                    approval={approval}
                    workspacePath={workspacePath}
                    disabledReason={readOnlySource ? "继承来源只读。" : approvalBlockedReason}
                    busyAction={busyAction}
                    onReply={onReplyApproval}
                  />
                ))}
                {executionTurn.userInputs.map((request) => (
                  <InlineUserInput
                    key={request.id}
                    request={request}
                    disabledReason={readOnlySource ? "继承来源只读。" : userInputBlockedReason}
                    busyAction={busyAction}
                    onReply={onReplyUserInput}
                  />
                ))}
                {!deltas.length && execution.result === null && execution.status === "unknown" ? (
                  <p className="ml-4 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
                    Engine 执行结果未知；当前没有可确认的回答正文。
                  </p>
                ) : null}
              </div>
            );
          })}
          {turn.events.map((event) => (
            <p key={event.id} className="ml-4 text-xs text-foreground-subtle">
              {event.type === "connection.disconnected" ? "连接断开" : event.type} ·{" "}
              {timeLabel(event.observedAt)}
            </p>
          ))}
          {!turn.executions.length ? (
            <p className="ml-4 rounded-md border border-dashed border-input-border p-2 text-xs text-foreground-subtle">
              {turn.input.status === "rejected"
                ? "此输入已被拒绝，未创建 Execution。"
                : turn.input.status === "unknown"
                  ? "输入接纳状态未知，尚未找到关联 Execution。"
                  : `输入状态：${recordStatusLabel(turn.input.status)}；等待关联 Execution。`}
            </p>
          ) : null}
        </EngineTurnFrame>
      ))}
      {projection.unassociatedExecutions.map((execution) => (
        <p
          key={execution.id}
          className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning"
        >
          Execution {shortId(execution.id)} 未能关联到本 Task 的输入；其内容未并入对话。
        </p>
      ))}
      {projection.unassociatedApprovals.map((approval) => (
        <div key={approval.id} className="space-y-2">
          <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
            审批 {shortId(approval.id)} 没有可靠的 Execution 关联，单独显示以保留答复入口。
          </p>
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
        <div key={request.id} className="space-y-2">
          <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
            用户输入请求 {shortId(request.id)} 没有可靠的 Execution 关联，单独显示以保留答复入口。
          </p>
          <InlineUserInput
            request={request}
            disabledReason={readOnlySource ? "继承来源只读。" : userInputBlockedReason}
            busyAction={busyAction}
            onReply={onReplyUserInput}
          />
        </div>
      ))}
      {projection.unassociatedEvents.length ? (
        <p className="rounded-md border border-warning/30 bg-warning/5 p-2 text-xs text-warning">
          有 {projection.unassociatedEvents.length}{" "}
          条事件无法可靠关联到此对话。原始内容仅在下方诊断信息中查看。
        </p>
      ) : null}
    </div>
  );
}
