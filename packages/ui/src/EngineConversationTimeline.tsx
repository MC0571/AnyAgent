/* oxlint-disable eslint(max-lines) -- 输入轮次、Execution 与对应交互必须沿同一消息序列呈现。 */
import { useState } from "react";
import type { EngineApproval, EngineUserInput } from "@/EngineUiParts.js";
import { jsonLabel, recordStatusLabel, shortId, timeLabel } from "@/EngineUiParts.js";
import type {
  EngineConversationProjection,
  EngineExecutionTurn,
} from "@/engineConversationProjection.js";
import {
  Message,
  MessageContent,
  MessageResponse,
  type MessageFileLinkTarget,
} from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";

function isInProgress(status: string) {
  return status === "accepted" || status === "started";
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
  onReply: (approvalId: string, optionId: string) => void;
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
            {approval.options.map((option) => (
              <Button
                key={option.id}
                type="button"
                variant="outline"
                size="sm"
                disabled={!!disabledReason || busyAction !== null}
                title={disabledReason ?? undefined}
                onClick={() => onReply(approval.id, option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : approval.repliedOptionId ? (
          <p className="mt-2 text-xs text-foreground-subtle">
            答复选项：{approval.repliedOptionId}
          </p>
        ) : null}
        {disabledReason && pending ? (
          <p className="mt-2 text-xs text-warning">{disabledReason}</p>
        ) : null}
      </MessageContent>
    </Message>
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
  onReply: (requestId: string, response: unknown) => void;
}) {
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
  onReply: (requestId: string, response: unknown) => void;
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

export function EngineConversationTimeline({
  projection,
  workspacePath,
  onOpenCodeViewer,
  onOpenFileLink,
  historyLoading,
  approvalBlockedReason,
  userInputBlockedReason,
  busyAction,
  onReplyApproval,
  onReplyUserInput,
}: {
  projection: EngineConversationProjection;
  workspacePath: string;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  historyLoading: boolean;
  approvalBlockedReason: string | null;
  userInputBlockedReason: string | null;
  busyAction: string | null;
  onReplyApproval: (approvalId: string, optionId: string) => void;
  onReplyUserInput: (requestId: string, response: unknown) => void;
}) {
  if (historyLoading) {
    return <p className="py-4 text-sm text-foreground-subtle">正在读取对话…</p>;
  }
  if (
    !projection.turns.length &&
    !projection.unassociatedExecutions.length &&
    !projection.unassociatedEvents.length &&
    !projection.unassociatedApprovals.length &&
    !projection.unassociatedUserInputs.length
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
      data-testid="engine-conversation-timeline"
    >
      {projection.turns.map((turn) => (
        <section
          key={turn.input.id}
          className="space-y-3"
          data-testid={`engine-turn-${turn.input.id}`}
        >
          <Message from="user" data-testid={`engine-input-${turn.input.id}`}>
            <MessageContent>
              <MessageResponse
                workspacePath={workspacePath}
                onOpenCodeViewer={onOpenCodeViewer}
                onOpenFileLink={onOpenFileLink}
              >
                {turn.input.text}
              </MessageResponse>
              {turn.input.status === "rejected" ||
              turn.input.status === "failed" ||
              turn.input.status === "unknown" ? (
                <div className="mt-1 text-[11px] text-foreground-subtle">
                  输入 · {recordStatusLabel(turn.input.status)} · {timeLabel(turn.input.receivedAt)}
                </div>
              ) : null}
              {turn.input.error ? (
                <p className="mt-2 text-sm text-destructive">{turn.input.error}</p>
              ) : null}
            </MessageContent>
          </Message>
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
            return (
              <div
                key={execution.id}
                className="space-y-3"
                data-testid={`engine-execution-${execution.id}`}
              >
                {executionTurn.items.map((item) => {
                  if (item.kind === "delta") {
                    const firstDelta = item.block === deltas[0];
                    if (finalReplacesPartialStream && !firstDelta) return null;
                    const text = finalReplacesPartialStream
                      ? execution.result
                      : item.block.text + (item.block === deltas.at(-1) ? finalSuffix : "");
                    return (
                      <Message
                        key={item.block.key}
                        from="assistant"
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
                  <Message from="assistant" data-testid={`engine-final-${execution.id}`}>
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
                  <InlineApproval
                    key={approval.id}
                    approval={approval}
                    disabledReason={approvalBlockedReason}
                    busyAction={busyAction}
                    onReply={(approvalId, optionId) => onReplyApproval(approvalId, optionId)}
                  />
                ))}
                {executionTurn.userInputs.map((request) => (
                  <InlineUserInput
                    key={request.id}
                    request={request}
                    disabledReason={userInputBlockedReason}
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
        </section>
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
          <InlineApproval
            approval={approval}
            disabledReason={approvalBlockedReason}
            busyAction={busyAction}
            onReply={(approvalId, optionId) => onReplyApproval(approvalId, optionId)}
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
            disabledReason={userInputBlockedReason}
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
