/* eslint-disable max-lines -- M1 Workbench keeps its event projection and controls in one view. */
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { IAnyAgentService } from "@zcode/services";
import { SettingsBreadcrumbReporter } from "./settings/SettingsHeaderBreadcrumb.js";
import { runtimeErrorNotice, type WorkbenchNotice } from "./AnyAgentEngineWorkbenchErrors.js";
import { AnyAgentEngineWorkbenchInspector } from "./AnyAgentEngineWorkbenchInspector.js";
import { AnyAgentEngineWorkbenchNavigation } from "./AnyAgentEngineWorkbenchNavigation.js";
import {
  canActOnTask,
  capabilityBlockReason,
  sessionStatusLabel,
  shortId,
  taskStatusLabel,
  timeLabel,
  WorkbenchHistory,
} from "./AnyAgentEngineWorkbenchParts.js";
import type {
  WorkbenchApproval,
  WorkbenchContext,
  WorkbenchEngine,
  WorkbenchHistory as WorkbenchHistoryData,
  WorkbenchTask,
  WorkbenchUserInput,
} from "./AnyAgentEngineWorkbenchParts.js";

export type AnyAgentEngineWorkbenchProps = {
  service: IAnyAgentService;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
};

type Notice = WorkbenchNotice;

type EngineWorkbenchTask = WorkbenchTask;
type EngineProjection = WorkbenchEngine;
type EngineWorkbenchCreateContext = WorkbenchContext;
type TaskHistory = WorkbenchHistoryData;
type RuntimeApproval = WorkbenchApproval;
type RuntimeUserInput = WorkbenchUserInput;

export function AnyAgentEngineWorkbench({
  service,
  selectedTaskId,
  onSelectTask,
}: AnyAgentEngineWorkbenchProps) {
  const [revision, setRevision] = useState(0);
  const changeVersion = useRef(0);
  const taskListVersion = useRef(0);
  const [selectedEngineId, setSelectedEngineId] = useState("");
  const [draft, setDraft] = useState("");
  const [userInputDrafts, setUserInputDrafts] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [createTaskContext, setCreateTaskContext] = useState<EngineWorkbenchCreateContext | null>(
    null,
  );
  const [engines, setEngines] = useState<readonly EngineProjection[]>([]);
  const [tasks, setTasks] = useState<readonly EngineWorkbenchTask[]>([]);
  const [task, setTask] = useState<EngineWorkbenchTask | null>(null);
  const [history, setHistory] = useState<TaskHistory | null>(null);

  useEffect(() => {
    const subscription = service.onDidChange((change) => {
      taskListVersion.current += 1;
      if (change.taskId === selectedTaskId || (!selectedTaskId && change.task))
        changeVersion.current += 1;
      if (change.task) {
        setTasks((current) => {
          const index = current.findIndex((item) => item.id === change.taskId);
          if (index < 0) return [change.task!, ...current];
          return current.map((item, position) => (position === index ? change.task! : item));
        });
      }
      if (!selectedTaskId && change.task) onSelectTask(change.taskId);
      if (change.taskId !== selectedTaskId) return;
      setTask(change.task);
      setHistory(change.history);
    });
    return () => subscription.dispose();
  }, [service, selectedTaskId, onSelectTask]);

  useEffect(() => {
    let isCurrent = true;
    const startedAtVersion = changeVersion.current;
    const listStartedAtVersion = taskListVersion.current;
    const refresh = async () => {
      setIsLoading(true);
      try {
        const [context, nextEngines, nextTasks] = await Promise.all([
          service.getCreateTaskContext(),
          service.listEngines(),
          service.listTasks(),
        ]);
        if (!isCurrent) return;
        setCreateTaskContext(context);
        setEngines(nextEngines);
        setTasks((current) => {
          if (taskListVersion.current === listStartedAtVersion) return nextTasks;
          const merged = new Map(nextTasks.map((item) => [item.id, item]));
          for (const item of current) merged.set(item.id, item);
          return [...merged.values()];
        });
        const selected =
          nextTasks.find((item) => item.id === selectedTaskId) ?? nextTasks[0] ?? null;
        if (!selected) {
          if (changeVersion.current === startedAtVersion) {
            setTask(null);
            setHistory(null);
          }
          return;
        }
        if (!selectedTaskId && changeVersion.current === startedAtVersion)
          onSelectTask(selected.id);
        const [freshTask, freshHistory] = await Promise.all([
          service.getTask(selected.id),
          service.getHistory(selected.id),
        ]);
        if (!isCurrent || changeVersion.current !== startedAtVersion) return;
        setTask(freshTask ?? selected);
        setHistory(freshHistory);
      } catch (error) {
        if (isCurrent) setNotice(runtimeErrorNotice(error));
      } finally {
        if (isCurrent) setIsLoading(false);
      }
    };
    void refresh();
    return () => {
      isCurrent = false;
    };
  }, [service, selectedTaskId, onSelectTask, revision]);

  const effectiveEngineId = engines.some((engine) => engine.engineId === selectedEngineId)
    ? selectedEngineId
    : (engines[0]?.engineId ?? "");
  const selectedEngine = engines.find((engine) => engine.engineId === effectiveEngineId);
  const createCapability = selectedEngine?.capabilities["session.create"];
  const createBlock = !createTaskContext
    ? "Host 尚未提供创建 Task 所需的工作环境。"
    : capabilityBlockReason(createCapability);

  const runAction = async <T,>(
    actionId: string,
    action: () => T | Promise<T>,
    summarize: (result: T) => string,
  ) => {
    setBusyAction(actionId);
    setNotice(null);
    try {
      const result = await action();
      setNotice({ kind: "info", message: summarize(result) });
    } catch (error) {
      setNotice(runtimeErrorNotice(error));
    } finally {
      setBusyAction(null);
      setRevision((value) => value + 1);
    }
  };

  const handleCreateTask = () => {
    if (!createTaskContext || !effectiveEngineId || createBlock) return;
    void runAction(
      "create-task",
      () => service.createTask({ engineId: effectiveEngineId }),
      (created) => {
        onSelectTask(created.id);
        setDraft("");
        return `Task ${shortId(created.id)} 已创建；Session 状态：${sessionStatusLabel(created.session.status)}。`;
      },
    );
  };

  const submitDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!task || !text || busyAction || canActOnTask(task, "execution.run")) return;
    void runAction(
      "submit-input",
      () =>
        service.submitInput({
          taskId: task.id,
          participantId: task.participant.id,
          sessionId: task.session.id,
          authorizationId: task.authorizationId,
          text,
        }),
      () => {
        setDraft("");
        return "输入请求已提交；等待 Runtime 事件确认接纳和执行状态。";
      },
    );
  };

  const replyApproval = (approval: RuntimeApproval, optionId: string) => {
    if (!task || !history || busyAction || canActOnTask(task, "approval.respond")) return;
    void runAction(
      `approval:${approval.id}`,
      () =>
        service.replyToApproval({
          taskId: task.id,
          participantId: approval.participantId,
          sessionId: approval.sessionId,
          authorizationId: task.authorizationId,
          approvalId: approval.id,
          optionId,
        }),
      () => "审批答复已提交；等待 Engine 确认处理。",
    );
  };

  const replyUserInput = (request: RuntimeUserInput, response: unknown) => {
    if (!task || !history || busyAction || canActOnTask(task, "user-input.respond")) return;
    void runAction(
      `user-input:${request.id}`,
      () =>
        service.replyToUserInput({
          taskId: task.id,
          participantId: request.participantId,
          sessionId: request.sessionId,
          authorizationId: task.authorizationId,
          requestId: request.id,
          response,
        }),
      () => "用户输入答复已提交；等待 Engine 确认处理。",
    );
  };

  const requestStop = (executionId: string) => {
    if (!task || busyAction || canActOnTask(task, "execution.interrupt")) return;
    void runAction(
      `stop:${executionId}`,
      () =>
        service.requestStop({
          taskId: task.id,
          participantId: task.participant.id,
          sessionId: task.session.id,
          authorizationId: task.authorizationId,
          executionId,
        }),
      () => "中断请求已提交；执行尚未确认停止。",
    );
  };

  const submitBlock = task ? canActOnTask(task, "execution.run") : null;
  const approvalBlock = task ? canActOnTask(task, "approval.respond") : null;
  const userInputBlock = task ? canActOnTask(task, "user-input.respond") : null;
  const stopBlock = task ? canActOnTask(task, "execution.interrupt") : null;
  const latestExecution = history?.executions[history.executions.length - 1];
  const unresolvedStopRequest = latestExecution
    ? history?.stopRequests.find(
        (request) =>
          request.executionId === latestExecution.id &&
          (request.status === "requested" || request.status === "unknown"),
      )
    : undefined;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <SettingsBreadcrumbReporter
        items={[{ label: task ? `Task ${shortId(task.id)}` : "Tasks" }]}
      />
      <div className="flex shrink-0 items-center justify-end border-b border-border bg-card px-5 py-2">
        <div className="max-w-full text-right text-xs text-foreground-subtle">
          <div>
            {createTaskContext?.environment.label ??
              createTaskContext?.environment.id ??
              "未提供工作环境"}
          </div>
          <div className="truncate">
            {createTaskContext?.environment.workDirectory ?? "工作目录未知"}
            {createTaskContext?.credentialSource
              ? ` · 凭据来源：${createTaskContext.credentialSource.label ?? createTaskContext.credentialSource.kind}`
              : " · 凭据来源未知"}
          </div>
        </div>
      </div>

      {notice ? (
        <div
          role="status"
          className={`mx-4 mt-3 rounded-md border px-3 py-2 text-sm ${
            notice.kind === "error"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : notice.kind === "warning"
                ? "border-warning/30 bg-warning/10 text-warning"
                : "border-border bg-surface text-foreground"
          }`}
        >
          {notice.message}
          <button
            className="float-right ml-3 font-medium"
            onClick={() => setNotice(null)}
            aria-label="关闭提示"
          >
            关闭
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <AnyAgentEngineWorkbenchNavigation
          engines={engines}
          tasks={tasks}
          selectedEngineId={effectiveEngineId}
          selectedTaskId={task?.id ?? selectedTaskId}
          createBlock={createBlock}
          busyAction={busyAction}
          onSelectEngine={setSelectedEngineId}
          onSelectTask={(taskId) => {
            onSelectTask(taskId);
            setNotice(null);
          }}
          onCreateTask={handleCreateTask}
        />

        <section className="flex min-w-0 flex-1 flex-col">
          {task ? (
            <>
              <div className="shrink-0 border-b border-border bg-card px-5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">Task {shortId(task.id)}</h2>
                      <span className="rounded-full border border-input-border px-2 py-0.5 text-xs">
                        {taskStatusLabel(task.status)}
                      </span>
                      <span className="text-xs text-foreground-subtle">
                        创建于 {timeLabel(task.createdAt)}
                      </span>
                    </div>
                    {task.status === "frozen" || task.status !== "active" ? (
                      <p className="mt-1 text-sm text-foreground-subtle">
                        {task.status === "frozen" ? "冻结说明：" : "终态说明："}
                        {task.closeReason ?? "未提供原因。"}
                        {task.closedAt ? ` · ${timeLabel(task.closedAt)}` : ""}
                      </p>
                    ) : null}
                  </div>
                  {latestExecution &&
                  latestExecution.status !== "completed" &&
                  latestExecution.status !== "failed" &&
                  latestExecution.status !== "stopped" ? (
                    <button
                      className="rounded-md border border-warning/50 px-3 py-1.5 text-sm font-medium text-warning disabled:opacity-45"
                      disabled={!!stopBlock || !!unresolvedStopRequest || busyAction !== null}
                      title={
                        stopBlock ??
                        unresolvedStopRequest?.reason ??
                        (unresolvedStopRequest
                          ? "等待执行停止证据，不重复提交中断请求。"
                          : undefined)
                      }
                      onClick={() => requestStop(latestExecution.id)}
                    >
                      {busyAction === `stop:${latestExecution.id}`
                        ? "正在请求中断…"
                        : unresolvedStopRequest?.status === "unknown"
                          ? "中断结果未知"
                          : unresolvedStopRequest
                            ? "等待停止确认"
                            : "请求中断"}
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_19rem]">
                <div className="min-h-0 overflow-y-auto px-5 py-4">
                  <h3 className="mb-3 text-sm font-semibold">历史与公开事件</h3>
                  <WorkbenchHistory history={history} isLoading={isLoading} />
                </div>
                <AnyAgentEngineWorkbenchInspector
                  task={task}
                  history={history}
                  approvalBlock={approvalBlock}
                  userInputBlock={userInputBlock}
                  busyAction={busyAction}
                  userInputDrafts={userInputDrafts}
                  onUserInputDraftChange={(requestId, value) =>
                    setUserInputDrafts((drafts) => ({ ...drafts, [requestId]: value }))
                  }
                  onReplyApproval={replyApproval}
                  onReplyUserInput={replyUserInput}
                />
              </div>

              <form
                onSubmit={submitDraft}
                className="shrink-0 border-t border-border bg-card px-5 py-3"
              >
                <div className="flex items-end gap-2">
                  <textarea
                    aria-label="向当前 Task 输入"
                    className="min-h-12 min-w-0 flex-1 resize-y rounded-md border border-input-border px-3 py-2 text-sm disabled:bg-surface-hover"
                    placeholder="继续当前 Task 的多轮工作…"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    disabled={!!submitBlock || busyAction !== null}
                  />
                  <button
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
                    disabled={!draft.trim() || !!submitBlock || busyAction !== null}
                    title={submitBlock ?? undefined}
                  >
                    {busyAction === "submit-input" ? "发送中…" : "发送"}
                  </button>
                </div>
                {submitBlock ? (
                  <p className="mt-2 text-xs text-warning">{submitBlock}</p>
                ) : (
                  <p className="mt-2 text-xs text-foreground-subtle">
                    每次输入都会由 Runtime 重新校验 Task、参与者、Session、授权和环境；新独立 Task
                    使用新参与者与 Session。
                  </p>
                )}
              </form>
            </>
          ) : (
            <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
              <div>
                <h2 className="font-semibold">选择或创建一个 Task</h2>
                <p className="mt-2 max-w-md text-sm text-foreground-subtle">
                  Workbench 通过注入的产品 Runtime
                  展示归属、事件与交互记录。尚无历史时不会推断或补造执行状态。
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
