import { forwardRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

type TaskListRowShellProps = Omit<HTMLAttributes<HTMLLIElement>, "children" | "onClick"> & {
  taskId: string;
  isActive: boolean;
  onActivate: () => void;
  leading?: ReactNode;
  leadingClassName?: string;
  dataTaskItemKey?: string;
  children: ReactNode;
};

export const TaskListRowShell = forwardRef<HTMLLIElement, TaskListRowShellProps>(
  function TaskListRowShell(
    {
      taskId,
      isActive,
      onActivate,
      leading,
      leadingClassName,
      dataTaskItemKey,
      className,
      children,
      ...itemProps
    },
    ref,
  ) {
    const handleKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
      itemProps.onKeyDown?.(event);
      if (event.defaultPrevented || event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate();
      }
    };

    return (
      <li
        ref={ref}
        {...itemProps}
        data-task-item-key={dataTaskItemKey ?? taskId}
        onClick={onActivate}
        onKeyDown={handleKeyDown}
        tabIndex={itemProps.tabIndex ?? 0}
        className={cn(
          "group/task-item flex cursor-pointer gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow]",
          isActive ? "bg-selected" : "hover:bg-surface-hover",
          className,
        )}
      >
        <div
          className={cn(
            "relative flex size-4 shrink-0 items-center justify-center",
            leadingClassName,
          )}
        >
          {leading}
        </div>
        {children}
      </li>
    );
  },
);
