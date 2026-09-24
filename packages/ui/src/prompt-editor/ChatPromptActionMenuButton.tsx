import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { PlusIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";

interface ChatPromptActionMenuButtonProps extends Omit<
  ComponentPropsWithoutRef<"button">,
  "children"
> {
  actionMenuTitle: string;
  disabledReason?: string;
  testId?: string;
}

export const ChatPromptActionMenuButton = forwardRef<
  HTMLButtonElement,
  ChatPromptActionMenuButtonProps
>(function ChatPromptActionMenuButton(
  { actionMenuTitle, disabledReason, testId, className, onMouseDown, ...buttonProps },
  ref,
) {
  return (
    <Button
      {...buttonProps}
      ref={ref}
      type="button"
      variant="ghost"
      size="icon-md"
      className={cn("gap-1 rounded-lg text-ui-base", className)}
      onMouseDown={(event) => {
        onMouseDown?.(event);
        event.preventDefault();
      }}
      aria-label={actionMenuTitle}
      data-testid={testId}
      title={disabledReason}
    >
      <PlusIcon className="size-4" />
      <span className="sr-only">{actionMenuTitle}</span>
    </Button>
  );
});

/** Native-looking disabled + trigger without mounting its catalog hooks. */
export function ChatPromptActionMenuDisabledTrigger({
  actionMenuTitle,
  disabledReason,
  testId,
}: ChatPromptActionMenuButtonProps) {
  return (
    <ControlHintTooltip title={disabledReason ?? actionMenuTitle}>
      <ChatPromptActionMenuButton
        actionMenuTitle={actionMenuTitle}
        disabled
        disabledReason={disabledReason}
        testId={testId}
      />
    </ControlHintTooltip>
  );
}
