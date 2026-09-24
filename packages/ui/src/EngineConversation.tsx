/* oxlint-disable eslint(max-lines) -- 单个 Task 的刷新、资格投影、身份校验与正式消息界面共享同一选中状态。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { IAnyAgentService } from "@zcode/services";
import type { EngineCapability } from "@anyagent/engine-contract";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import {
  EngineCapabilityList,
  canActOnTask,
  jsonLabel,
  shortId,
  taskStatusLabel,
  timeLabel,
} from "@/EngineUiParts.js";
import type { EngineHistory, EngineTask } from "@/EngineUiParts.js";
import { EngineConversationTimeline } from "@/EngineConversationTimeline.js";
import { projectEngineConversation } from "@/engineConversationProjection.js";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { useServices } from "@/hooks/useServices.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getConversationContentWidthClassName } from "@/v4/conversationLayout.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";

type Notice = { kind: "error" | "info"; message: string };
const contentWidthClassName = getConversationContentWidthClassName({
  centeredEmptyLayout: false,
  statusPanelLayout: "none",
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminal(status: string) {
  return status === "completed" || status === "failed" || status === "stopped";
}

function currentTaskBlock(
  task: EngineTask,
  capability: EngineCapability,
  refreshedEngines: Awaited<ReturnType<IAnyAgentService["listEngines"]>> | null,
  refreshFailed: boolean,
): string | null {
  if (refreshFailed || refreshedEngines === null) return "Engine 当前状态未知，请刷新后重试。";
  const current = refreshedEngines.find(
    (engine) => engine.engineId === task.currentEngine.engineId,
  );
  if (!current || current.state !== "current") return "Engine 当前状态未知，请刷新后重试。";
  if (capability !== "execution.interrupt" && task.status !== "active")
    return `Task 当前状态为“${taskStatusLabel(task.status)}”，不接收新的业务请求。`;
  if (capability !== "execution.interrupt" && task.session.status !== "active") {
    return `产品 Session 当前状态为“${task.session.status}”，暂不可操作。`;
  }
  if (
    task.engine.adapterVersion !== current.adapterVersion ||
    task.engine.configurationVersion !== current.configurationVersion ||
    task.engine.environment !== current.environment
  ) {
    return "当前 Engine 配置、适配器或环境与 Task 创建时快照不兼容；请重新创建 Task 并重新授权。";
  }
  return canActOnTask({ ...task, currentEngine: current }, capability);
}

export function EngineConversation({
  service,
  selectedTaskId,
  onSelectTask,
  onTitleChange,
  onOpenCodeViewer,
  onOpenFileLink,
  refreshVersion = 0,
  inspectorOpen = false,
  onInspectorOpenChange = () => {},
}: {
  service: IAnyAgentService;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onTitleChange?: (taskId: string, title: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  refreshVersion?: number;
  inspectorOpen?: boolean;
  onInspectorOpenChange?: (open: boolean) => void;
}) {
  const [task, setTask] = useState<EngineTask | null>(null);
  const [history, setHistory] = useState<EngineHistory | null>(null);
  const [engines, setEngines] = useState<Awaited<
    ReturnType<IAnyAgentService["listEngines"]>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [revision, setRevision] = useState(0);
  const requestVersionRef = useRef(0);
  const changeVersionRef = useRef(0);
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const followConversationTailRef = useRef(true);
  const { intl } = useZCodeIntl();
  const { modelSelectionService } = useServices();
  const modelSelectionRead = useModelSelectionServiceView(modelSelectionService);

  const refresh = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    const startedChangeVersion = changeVersionRef.current;
    setLoading(true);
    setRefreshFailed(false);
    setEngines(null);
    try {
      const nextTasks = await service.listTasks();
      const targetTaskId = selectedTaskId ?? nextTasks[0]?.id ?? null;
      if (!targetTaskId) {
        const nextEngines = await service.listEngines();
        if (requestVersion !== requestVersionRef.current) return;
        setEngines(nextEngines);
        if (changeVersionRef.current === startedChangeVersion) {
          setTask(null);
          setHistory(null);
        }
        return;
      }
      if (selectedTaskId === null) onSelectTask(targetTaskId);
      const [nextTask, nextHistory] = await Promise.all([
        service.getTask(targetTaskId),
        service.getHistory(targetTaskId),
      ]);
      if (requestVersion !== requestVersionRef.current) return;
      if (changeVersionRef.current === startedChangeVersion) {
        setTask(nextTask);
        setHistory(nextHistory);
      }
      // Historical conversation remains readable even if this workspace no longer exists.
      const nextEngines = await service.listEngines(
        nextTask?.environment.workDirectory
          ? { workspacePath: nextTask.environment.workDirectory }
          : undefined,
      );
      if (requestVersion !== requestVersionRef.current) return;
      setEngines(nextEngines);
      if (changeVersionRef.current === startedChangeVersion) {
        const refreshedTask = await service.getTask(targetTaskId);
        if (
          requestVersion === requestVersionRef.current &&
          changeVersionRef.current === startedChangeVersion
        ) {
          setTask(refreshedTask);
        }
      }
    } catch (error) {
      if (requestVersion === requestVersionRef.current) {
        setEngines(null);
        setRefreshFailed(true);
        setNotice({ kind: "error", message: `刷新 Engine 状态失败：${errorText(error)}` });
      }
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }, [onSelectTask, selectedTaskId, service]);

  useEffect(() => {
    void refresh();
    return () => {
      requestVersionRef.current += 1;
    };
  }, [refresh, refreshVersion, revision]);

  useEffect(() => {
    const subscription = service.onDidChange((change) => {
      if (change.taskId !== selectedTaskId) return;
      changeVersionRef.current += 1;
      if (change.task) setTask(change.task);
      if (change.history) setHistory(change.history);
    });
    return () => subscription.dispose();
  }, [selectedTaskId, service]);

  useEffect(() => {
    if (selectedTaskId && task?.id !== selectedTaskId) {
      setTask(null);
      setHistory(null);
    }
  }, [selectedTaskId, task?.id]);

  const projection = useMemo(
    () => (task && task.id === selectedTaskId ? projectEngineConversation(task, history) : null),
    [task, history, selectedTaskId],
  );
  useLayoutEffect(() => {
    const element = conversationScrollRef.current;
    if (element && followConversationTailRef.current) {
      element.scrollTop = element.scrollHeight - element.clientHeight;
    }
  }, [projection]);
  const visibleTask = task?.id === selectedTaskId ? task : null;
  const visibleHistory = visibleTask ? history : null;
  const visibleTitle = visibleTask
    ? visibleHistory?.inputs[0]?.text.trim().replace(/\s+/g, " ").slice(0, 80) ||
      `Task ${shortId(visibleTask.id)}`
    : "任务";
  useEffect(() => {
    if (visibleTask) onTitleChange?.(visibleTask.id, visibleTitle);
  }, [onTitleChange, visibleTask?.id, visibleTitle]);
  const hasPendingRound =
    visibleHistory?.inputs.some((input) =>
      ["received", "native-accepted", "started", "unknown"].includes(input.status),
    ) ||
    visibleHistory?.executions.some((execution) =>
      ["accepted", "started", "unknown"].includes(execution.status),
    );
  const runBlockedReason = visibleTask
    ? hasPendingRound
      ? "当前轮次尚未结束，暂不能发送下一轮输入。"
      : currentTaskBlock(visibleTask, "execution.run", engines, refreshFailed)
    : "请选择或创建一个 Engine Task。";
  const approvalBlockedReason = visibleTask
    ? currentTaskBlock(visibleTask, "approval.respond", engines, refreshFailed)
    : "当前 Task 不可用。";
  const userInputBlockedReason = visibleTask
    ? currentTaskBlock(visibleTask, "user-input.respond", engines, refreshFailed)
    : "当前 Task 不可用。";
  const stopBlockedReason = visibleTask
    ? currentTaskBlock(visibleTask, "execution.interrupt", engines, refreshFailed)
    : "当前 Task 不可用。";
  const currentEngine = visibleTask
    ? (engines?.find((engine) => engine.engineId === visibleTask.currentEngine.engineId) ?? null)
    : null;
  const modelGroups = useMemo<ModelSelectGroup[]>(() => {
    const harnessGroup: ModelSelectGroup = {
      key: "harness",
      label: "Harness",
      directItems: true,
      items: (engines ?? []).map((engine) => ({
        key: `harness:${engine.engineId}`,
        value: `harness:${engine.engineId}`,
        name: engine.engineId,
      })),
    };
    const providerGroups =
      modelSelectionRead.state.status === "ready"
        ? buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelSelectionRead.state.view)
        : [];
    return [harnessGroup, ...providerGroups];
  }, [engines, modelSelectionRead.state]);
  const latestExecution = visibleHistory?.executions.at(-1);
  const pendingStop = latestExecution
    ? visibleHistory?.stopRequests.find(
        (stop) =>
          stop.executionId === latestExecution.id &&
          (stop.status === "requested" || stop.status === "unknown"),
      )
    : undefined;

  const runAction = async <T,>(
    id: string,
    action: () => Promise<T>,
    summarize: (result: T) => string | null,
  ): Promise<boolean> => {
    setBusyAction(id);
    setNotice(null);
    try {
      const result = await action();
      const message = summarize(result);
      if (message) setNotice({ kind: "info", message });
      setRevision((version) => version + 1);
      return true;
    } catch (error) {
      setNotice({ kind: "error", message: errorText(error) });
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const submitInput = (text: string): boolean => {
    const cleanText = text.trim();
    if (!visibleTask || !cleanText || runBlockedReason || busyAction) return false;
    const editor = inputApiRef.current;
    void runAction(
      "input",
      () =>
        service.submitInput({
          taskId: visibleTask.id,
          participantId: visibleTask.participant.id,
          sessionId: visibleTask.session.id,
          authorizationId: visibleTask.authorizationId,
          text: cleanText,
        }),
      () => null,
    ).then((accepted) => {
      if (accepted && inputApiRef.current === editor) editor?.clear();
    });
    // Lexical keeps the draft until the Host accepts it; the button path uses the same rule.
    return false;
  };

  const replyApproval = (approvalId: string, optionId: string) => {
    const approval = visibleHistory?.approvals.find((item) => item.id === approvalId);
    if (!visibleTask || !approval || approvalBlockedReason || busyAction) return;
    void runAction(
      `approval:${approval.id}`,
      () =>
        service.replyToApproval({
          taskId: visibleTask.id,
          participantId: approval.participantId,
          sessionId: approval.sessionId,
          authorizationId: visibleTask.authorizationId,
          approvalId: approval.id,
          optionId,
        }),
      () => "审批答复已提交，等待 Engine 确认处理。",
    );
  };

  const replyUserInput = (requestId: string, response: unknown) => {
    const request = visibleHistory?.userInputs.find((item) => item.id === requestId);
    if (!visibleTask || !request || userInputBlockedReason || busyAction) return;
    void runAction(
      `user-input:${request.id}`,
      () =>
        service.replyToUserInput({
          taskId: visibleTask.id,
          participantId: request.participantId,
          sessionId: request.sessionId,
          authorizationId: visibleTask.authorizationId,
          requestId: request.id,
          response,
        }),
      () => "用户输入答复已提交，等待 Engine 确认处理。",
    );
  };

  const requestStop = (executionId: string) => {
    if (!visibleTask || stopBlockedReason || busyAction || pendingStop) return;
    void runAction(
      `stop:${executionId}`,
      () =>
        service.requestStop({
          taskId: visibleTask.id,
          participantId: visibleTask.participant.id,
          sessionId: visibleTask.session.id,
          authorizationId: visibleTask.authorizationId,
          executionId,
        }),
      () => "中断请求已提交，仍需等待实际停止证据。",
    );
  };

  return (
    <div
      className="@container/conversation flex h-full min-h-0 w-full flex-col bg-background text-foreground"
      data-testid="engine-conversation"
    >
      {notice ? (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={`mx-4 mt-3 rounded-md border px-3 py-2 text-sm ${notice.kind === "error" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-surface text-foreground"}`}
        >
          {notice.message}
          <button
            type="button"
            className="float-right ml-3 font-medium"
            aria-label="关闭提示"
            onClick={() => setNotice(null)}
          >
            关闭
          </button>
        </div>
      ) : null}
      <div
        ref={conversationScrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4"
        data-testid="engine-conversation-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          followConversationTailRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        <div className={`mx-auto ${contentWidthClassName}`}>
          {visibleTask?.closeReason ? (
            <p className="pt-3 text-xs text-foreground-subtle">{visibleTask.closeReason}</p>
          ) : null}
          {visibleTask && projection ? (
            <EngineConversationTimeline
              projection={projection}
              workspacePath={visibleTask.environment.workDirectory ?? ""}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              historyLoading={loading && !visibleHistory}
              approvalBlockedReason={approvalBlockedReason}
              userInputBlockedReason={userInputBlockedReason}
              busyAction={busyAction}
              onReplyApproval={replyApproval}
              onReplyUserInput={replyUserInput}
            />
          ) : (
            <div className="mx-auto grid h-full max-w-2xl place-items-center px-5 text-center">
              <div>
                <h2 className="font-semibold">
                  {loading ? "正在读取 Engine 任务…" : "选择或创建 Engine Task"}
                </h2>
                <p className="mt-2 text-sm text-foreground-subtle">
                  在左侧任务列表选择已有 Task，或创建一个使用独立参与者与产品 Session 的新 Task。
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      {visibleTask ? (
        <Dialog open={inspectorOpen} onOpenChange={onInspectorOpenChange}>
          <DialogContent
            className="max-h-[85vh] max-w-4xl overflow-y-auto text-xs"
            data-testid="engine-diagnostic-inspector"
            aria-describedby={undefined}
          >
            <DialogHeader>
              <DialogTitle>Engine 诊断信息</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-3 md:grid-cols-2">
              <section>
                <h2 className="mb-2 font-semibold">历史创建快照</h2>
                <dl className="space-y-1 break-all">
                  <div>
                    <dt className="inline text-foreground-subtle">Task：</dt>
                    <dd className="inline">{visibleTask.id}</dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-subtle">Participant：</dt>
                    <dd className="inline">{visibleTask.participant.id}</dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-subtle">产品 Session：</dt>
                    <dd className="inline">{visibleTask.session.id}</dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-subtle">Engine Snapshot：</dt>
                    <dd className="inline">
                      {visibleTask.engine.engineId} · Adapter {visibleTask.engine.adapterVersion}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-subtle">配置版本：</dt>
                    <dd className="inline">{visibleTask.engine.configurationVersion ?? "未知"}</dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-subtle">环境快照：</dt>
                    <dd className="inline">{visibleTask.engine.environment ?? "未知"}</dd>
                  </div>
                </dl>
              </section>
              <section>
                <h2 className="mb-2 font-semibold">当前 Engine 状态</h2>
                {currentEngine ? (
                  <EngineCapabilityList engine={currentEngine} compact />
                ) : (
                  <p>未知；刷新失败或 Engine 不在当前 Host。</p>
                )}
                <div className="mt-2 break-all text-foreground-subtle">
                  {currentEngine?.state === "current"
                    ? `观测来源：${currentEngine.source} · ${timeLabel(currentEngine.observedAt)}`
                    : "当前能力未知"}
                </div>
              </section>
            </div>
            <section className="border-t border-border pt-3">
              <h2 className="mb-2 font-semibold">
                原始 Engine 事件（只读） · {visibleHistory?.events.length ?? 0}
              </h2>
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {[...(visibleHistory?.events ?? [])]
                  .sort((a, b) => a.observedAt - b.observedAt)
                  .map((event) => (
                    <details key={event.id} className="rounded-md border border-border p-2">
                      <summary className="cursor-pointer">
                        {event.type} · {timeLabel(event.observedAt)} · Task {shortId(event.taskId)}{" "}
                        · Execution {event.executionId ? shortId(event.executionId) : "未知"}
                      </summary>
                      <pre className="mt-2 overflow-auto whitespace-pre-wrap">
                        {jsonLabel(event.payload)}
                      </pre>
                    </details>
                  ))}
              </div>
            </section>
          </DialogContent>
        </Dialog>
      ) : null}
      {visibleTask ? (
        <div className="shrink-0 px-4 pb-4">
          <div className={`mx-auto ${contentWidthClassName}`}>
            {runBlockedReason ? (
              <p className="mb-2 text-xs text-warning">{runBlockedReason}</p>
            ) : null}
            {pendingStop ||
            (latestExecution && !isTerminal(latestExecution.status) && stopBlockedReason) ? (
              <p className="mb-2 text-xs text-warning">
                {pendingStop?.status === "unknown"
                  ? "中断结果未知"
                  : pendingStop
                    ? "等待停止确认"
                    : stopBlockedReason}
              </p>
            ) : null}
            <div className="chat-composer-region z-20 w-full shrink-0 @container/composer">
              <div className="chat-composer-input-surface w-full">
                <ChatPromptEditor
                  key={visibleTask.id}
                  className="p-0"
                  workspacePath={visibleTask.environment.workDirectory ?? ""}
                  taskId={null}
                  inputApiRef={inputApiRef}
                  trailingActions={
                    <ModelConfigSelect
                      modelGroups={modelGroups}
                      normalizedValue={`harness:${visibleTask.engine.engineId}`}
                      triggerLabel={`Harness · ${visibleTask.engine.engineId}`}
                      triggerLabelPrefix="Harness · "
                      triggerLabelValue={visibleTask.engine.engineId}
                      triggerLabelPrefixClassName="composer-provider-prefix hidden @2xl/composer:inline group-data-[composer-provider-compact=true]/toolbar:hidden"
                      showManageModelsAction={false}
                      lockReasonMessage="当前 Session 不支持切换 Harness 或 Provider。请新建对话后选择。"
                      isItemLocked={() => true}
                      onValueChange={() => {}}
                      disabled={busyAction !== null}
                      tooltipTitle={`Harness · ${visibleTask.engine.engineId}`}
                      labelVisibilityClassName="hidden @sm/composer:inline-flex"
                      indicatorClassName="hidden @sm/composer:block group-data-[composer-model-icon=true]/toolbar:hidden"
                      triggerLabelClassName="hidden min-w-0 text-left @sm/composer:block group-data-[composer-model-icon=true]/toolbar:hidden [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate"
                      triggerClassName="composer-model-trigger max-w-[var(--composer-model-max-width,16rem)] group-data-[composer-model-icon=true]/toolbar:size-7 group-data-[composer-model-icon=true]/toolbar:p-0 group-data-[composer-model-icon=true]/toolbar:gap-0 group-data-[composer-model-icon=true]/toolbar:justify-center @max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:gap-0 @max-sm/composer:p-0"
                      triggerIconClassName="inline-flex @sm/composer:hidden group-data-[composer-model-icon=true]/toolbar:inline-flex"
                      focusSelectorOnClose='[data-testid="engine-composer-input"]'
                    />
                  }
                  placeholder={intl.formatMessage({ id: "chat.placeholder.followUpAsk" })}
                  disabled={!!runBlockedReason || busyAction !== null}
                  disabledReason={runBlockedReason ?? undefined}
                  submitting={busyAction === "input"}
                  submitDisabled={!!runBlockedReason || busyAction !== null}
                  submitLabel="发送"
                  cancelLabel="请求中断"
                  onCancel={
                    latestExecution &&
                    !isTerminal(latestExecution.status) &&
                    !stopBlockedReason &&
                    !pendingStop &&
                    busyAction === null
                      ? () => requestStop(latestExecution.id)
                      : undefined
                  }
                  showMentionButton={false}
                  showSlashButton={false}
                  enableMentionPanel={false}
                  inputTestId="engine-composer-input"
                  submitTestId="engine-composer-submit"
                  onSubmit={submitInput}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
