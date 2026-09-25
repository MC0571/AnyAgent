import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { IAnyAgentService } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import type { EngineTask } from "@/EngineTaskSidebar.js";

const DEFAULT_SIDEBAR_METADATA = {
  title: null,
  pinned: false,
  pinOrder: null,
  archivedAt: null,
  unreadAt: null,
} as const;

export function engineTaskSidebarMetadata(task: EngineTask) {
  return task.sidebarMetadata ?? DEFAULT_SIDEBAR_METADATA;
}

export function isEngineTaskArchived(task: EngineTask): boolean {
  return engineTaskSidebarMetadata(task).archivedAt !== null;
}

export function isEngineTaskPinned(task: EngineTask): boolean {
  return engineTaskSidebarMetadata(task).pinned;
}

export function engineTaskTitle(task: EngineTask, historyTitle?: string): string {
  return engineTaskSidebarMetadata(task).title?.trim() || historyTitle || "";
}

export function taskSidebarIdentity(task: EngineTask) {
  return {
    taskId: task.id,
    participantId: task.participant.id,
    sessionId: task.session.id,
  };
}

export function EngineTaskMenuItems({
  Item,
  task,
  service,
  onRename,
  intl,
}: {
  Item: ComponentType<{
    children: ReactNode;
    disabled?: boolean;
    title?: string;
    onSelect?: () => void;
  }>;
  task: EngineTask;
  service: IAnyAgentService | null;
  onRename: () => void;
  intl: { formatMessage: (message: { id: string }) => string };
}) {
  const disabled = !service;
  const metadata = engineTaskSidebarMetadata(task);
  const run = (action: () => Promise<unknown>, messageId: string) => {
    void action().catch(() => toast(intl.formatMessage({ id: messageId })));
  };
  return (
    <>
      <Item
        disabled={disabled}
        onSelect={() => {
          if (!service) return;
          run(
            () =>
              service.setTaskPinned({
                ...taskSidebarIdentity(task),
                pinned: !metadata.pinned,
              }),
            "taskList.pinFailed",
          );
        }}
      >
        {intl.formatMessage({ id: metadata.pinned ? "taskList.unpin" : "taskList.pin" })}
      </Item>
      <Item disabled={disabled} onSelect={onRename}>
        {intl.formatMessage({ id: "taskList.rename" })}
      </Item>
      <Item
        disabled={disabled}
        onSelect={() => {
          if (!service) return;
          run(
            () =>
              service.setTaskArchived({
                ...taskSidebarIdentity(task),
                archived: metadata.archivedAt === null,
              }),
            "taskList.archiveFailed",
          );
        }}
      >
        {intl.formatMessage({
          id: metadata.archivedAt === null ? "taskList.archive" : "taskList.unarchive",
        })}
      </Item>
      <Item
        disabled={disabled}
        onSelect={() => {
          if (!service) return;
          run(
            () => service.setTaskUnread({ ...taskSidebarIdentity(task), unread: true }),
            "taskList.markAsUnreadFailed",
          );
        }}
      >
        {intl.formatMessage({ id: "taskList.markAsUnread" })}
      </Item>
      <Item
        onSelect={() => {
          void navigator.clipboard
            .writeText(task.id)
            .catch(() => toast(intl.formatMessage({ id: "taskList.copyTaskIdFailed" })));
        }}
      >
        {intl.formatMessage({ id: "taskList.copyTaskId" })}
      </Item>
    </>
  );
}

export function useEngineTaskRename(
  task: EngineTask,
  fallbackTitle: string,
  service: IAnyAgentService | null,
) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const start = useCallback(() => {
    setDraft(engineTaskSidebarMetadata(task).title ?? fallbackTitle);
    setOpen(true);
  }, [fallbackTitle, task]);
  const cancel = useCallback(() => setOpen(false), []);
  const confirm = useCallback(() => {
    const title = draft.trim();
    if (!service || !title) {
      if (!title) toast(intl.formatMessage({ id: "taskList.renameFailed" }));
      return;
    }
    void service
      .renameTask({ ...taskSidebarIdentity(task), title })
      .then(() => setOpen(false))
      .catch(() => toast(intl.formatMessage({ id: "taskList.renameFailed" })));
  }, [draft, intl, service, task]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  return {
    start,
    dialog: (
      <TaskRenameDialog
        open={open}
        value={draft}
        inputRef={inputRef}
        intl={intl}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setOpen(false);
        }}
        onChange={setDraft}
        onCancel={cancel}
        onConfirm={confirm}
      />
    ),
  };
}
