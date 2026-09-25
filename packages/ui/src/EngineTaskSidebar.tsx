import { useCallback, useEffect, useRef, useState } from "react";
import { Ellipsis } from "lucide-react";
import type { IAnyAgentService } from "@zcode/services";
import { TaskListRowShell } from "@/TaskListRowShell.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import {
  EngineTaskMenuItems,
  engineTaskSidebarMetadata,
  engineTaskTitle,
  isEngineTaskArchived,
  isEngineTaskPinned,
  taskSidebarIdentity,
  useEngineTaskRename,
} from "@/EngineTaskSidebarMenu.js";
export {
  engineTaskSidebarMetadata,
  engineTaskTitle,
  isEngineTaskArchived,
  isEngineTaskPinned,
} from "@/EngineTaskSidebarMenu.js";
import {
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_ROW_LINE_CLASS,
} from "@/workspace-grouped-tasks/types.js";

export type EngineTask = NonNullable<Awaited<ReturnType<IAnyAgentService["getTask"]>>>;
type EngineHistory = Awaited<ReturnType<IAnyAgentService["getHistory"]>>;

function titleFromHistory(history: EngineHistory): string | null {
  const first = history?.inputs.reduce<(typeof history.inputs)[number] | null>(
    (earliest, input) => (!earliest || input.receivedAt < earliest.receivedAt ? input : earliest),
    null,
  );
  const text = first?.text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** Engine 查询只提供侧栏展示数据，不把产品 Task 转成 ZCode 私有任务类型。 */
export function useEngineTaskSidebarData({
  service,
  onRefresh,
  onNativeSessionIdsChange,
}: {
  service: IAnyAgentService | null;
  onRefresh?: () => void;
  onNativeSessionIdsChange?: (ids: ReadonlySet<string>) => void;
}) {
  const [tasks, setTasks] = useState<readonly EngineTask[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [runningByTask, setRunningByTask] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const changeVersionRef = useRef(0);
  const titleVersionRef = useRef(new Map<string, number>());

  useEffect(() => {
    onNativeSessionIdsChange?.(
      new Set(
        tasks.flatMap((task) =>
          task.engine.engineId === "zcode" && task.session.nativeSessionId
            ? [task.session.nativeSessionId]
            : [],
        ),
      ),
    );
  }, [onNativeSessionIdsChange, tasks]);

  const refresh = useCallback(async () => {
    if (!service) {
      setTasks([]);
      setTitles({});
      setRunningByTask({});
      setError(null);
      return;
    }
    const requestId = ++requestIdRef.current;
    const changeVersion = changeVersionRef.current;
    try {
      const nextTasks = await service.listTasks();
      if (requestId !== requestIdRef.current) return;
      setTasks((current) => {
        if (changeVersionRef.current === changeVersion) return nextTasks;
        const merged = new Map(nextTasks.map((task) => [task.id, task]));
        current.forEach((task) => merged.set(task.id, task));
        return [...merged.values()];
      });
      for (const task of nextTasks) {
        const titleVersion = titleVersionRef.current.get(task.id) ?? 0;
        void service
          .getHistory(task.id)
          .then((history) => {
            if (
              requestId !== requestIdRef.current ||
              titleVersion !== (titleVersionRef.current.get(task.id) ?? 0)
            )
              return;
            const title = titleFromHistory(history);
            if (title) setTitles((current) => ({ ...current, [task.id]: title }));
            setRunningByTask((current) => ({
              ...current,
              [task.id]:
                history?.executions?.some(
                  (execution) => execution.status === "accepted" || execution.status === "started",
                ) ?? false,
            }));
          })
          .catch(() => {});
      }
      setError(null);
      onRefresh?.();
    } catch (cause) {
      if (requestId === requestIdRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, [onRefresh, service]);

  useEffect(() => {
    void refresh();
    if (!service) return;
    const subscription = service.onDidChange((change) => {
      changeVersionRef.current += 1;
      titleVersionRef.current.set(
        change.taskId,
        (titleVersionRef.current.get(change.taskId) ?? 0) + 1,
      );
      const title = titleFromHistory(change.history);
      setTitles((current) => {
        const next = { ...current };
        if (title && change.task) next[change.taskId] = title;
        else if (!change.task) delete next[change.taskId];
        return next;
      });
      setTasks((current) => {
        const next = current.filter((task) => task.id !== change.taskId);
        return change.task ? [change.task, ...next] : next;
      });
      setRunningByTask((current) => {
        const next = { ...current };
        if (change.task) {
          next[change.taskId] =
            change.history?.executions?.some(
              (execution) => execution.status === "accepted" || execution.status === "started",
            ) ?? false;
        } else delete next[change.taskId];
        return next;
      });
    });
    return () => {
      requestIdRef.current += 1;
      subscription.dispose();
    };
  }, [refresh, service]);

  return { tasks, titles, runningByTask, error };
}

export function EngineTaskRow({
  task,
  title,
  active,
  service = null,
  onSelectTask,
  onOpenContextMenu,
  variant = "default",
}: {
  task: EngineTask;
  title: string;
  active: boolean;
  service?: IAnyAgentService | null;
  onSelectTask: (taskId: string) => void;
  onOpenContextMenu?: (taskId: string) => void;
  variant?: "default" | "grouped";
}) {
  const { intl } = useZCodeIntl();
  const rename = useEngineTaskRename(task, title, service);
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "common.more" })}
          data-testid={`engine-task-options-${task.id}`}
          className="size-5 shrink-0 text-foreground-subtle hover:text-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          <Ellipsis className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-52"
        align="end"
        onClick={(event) => event.stopPropagation()}
      >
        <EngineTaskMenuItems
          Item={DropdownMenuItem}
          task={task}
          service={service}
          onRename={rename.start}
          intl={intl}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const handleSelectTask = () => {
    onSelectTask(task.id);
    const expectedUnreadAt = engineTaskSidebarMetadata(task).unreadAt;
    if (!service || expectedUnreadAt === null) return;
    void service
      .setTaskUnread({
        ...taskSidebarIdentity(task),
        unread: false,
        expectedUnreadAt,
      })
      .catch(() => toast(intl.formatMessage({ id: "taskList.markAsUnreadFailed" })));
  };
  if (variant === "grouped") {
    return (
      <div className="rounded-lg border border-transparent py-px">
        <div
          role="button"
          tabIndex={0}
          data-task-item-key={task.id}
          aria-current={active ? "page" : undefined}
          className={cn(
            "group/task-row cursor-pointer",
            TASK_GROUP_ROW_CLASS,
            active ? "bg-selected" : "hover:bg-surface-hover",
          )}
          onClick={handleSelectTask}
          onContextMenu={() => onOpenContextMenu?.(task.id)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleSelectTask();
            }
          }}
        >
          <span className={TASK_GROUP_ROW_LINE_CLASS}>
            <TaskTitleOverflowText as="span" className="text-foreground" title={title}>
              {title}
            </TaskTitleOverflowText>
            <span className="ml-auto shrink-0 text-ui-sm text-foreground-subtle">
              {formatTaskRelativeTime(task.updatedAt, intl)}
            </span>
            {menu}
          </span>
        </div>
        {rename.dialog}
      </div>
    );
  }
  return (
    <>
      <TaskListRowShell
        taskId={task.id}
        isActive={active}
        onActivate={handleSelectTask}
        onContextMenu={() => onOpenContextMenu?.(task.id)}
        aria-current={active ? "page" : undefined}
        className="items-center"
        leading={
          engineTaskSidebarMetadata(task).unreadAt !== null ? (
            <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
          ) : task.status === "failed" || task.status === "abandoned" ? (
            <span aria-hidden="true" className="size-1.5 rounded-full bg-destructive" />
          ) : task.status === "active" ? (
            <span aria-hidden="true" className="size-1.5 rounded-full bg-border" />
          ) : null
        }
      >
        <span className="flex min-w-0 flex-1 items-center justify-between gap-2 text-ui-base">
          <span className="truncate text-foreground">{title}</span>
          <span className="shrink-0 text-foreground-subtle">
            {formatTaskRelativeTime(task.updatedAt, intl)}
          </span>
        </span>
        {menu}
      </TaskListRowShell>
      {rename.dialog}
    </>
  );
}

export function EngineGroupedTaskRow({
  task,
  title,
  active,
  service,
  onSelectTask,
}: {
  task: EngineTask;
  title: string;
  active: boolean;
  service?: IAnyAgentService | null;
  onSelectTask: (taskId: string) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <EngineTaskRow
            task={task}
            title={title}
            active={active}
            service={service}
            onSelectTask={onSelectTask}
            variant="grouped"
          />
        </div>
      </ContextMenuTrigger>
      <EngineTaskContextMenuContent task={task} title={title} service={service} />
    </ContextMenu>
  );
}

export function EngineTaskContextMenuContent({
  task,
  title,
  service = null,
}: {
  task: EngineTask;
  title?: string;
  service?: IAnyAgentService | null;
}) {
  const { intl } = useZCodeIntl();
  const rename = useEngineTaskRename(task, title ?? engineTaskTitle(task), service);
  return (
    <>
      <ContextMenuContent className="w-52">
        <EngineTaskMenuItems
          Item={ContextMenuItem}
          task={task}
          service={service}
          onRename={rename.start}
          intl={intl}
        />
      </ContextMenuContent>
      {rename.dialog}
    </>
  );
}
