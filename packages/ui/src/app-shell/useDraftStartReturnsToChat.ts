import { useEffect, useRef } from "react";

/** Root-level New Task actions start the M0 draft; if M1 is visible, show that draft's Composer. */
export function useDraftStartReturnsToChat({
  workspaceKey,
  draftFocusVersion,
  isEngineView,
  onReturnToChat,
}: {
  workspaceKey: string;
  draftFocusVersion: number;
  isEngineView: boolean;
  onReturnToChat: () => void;
}) {
  const lastHandledDraftNavigationRef = useRef({ workspaceKey, draftFocusVersion });

  useEffect(() => {
    const previous = lastHandledDraftNavigationRef.current;
    if (previous.workspaceKey !== workspaceKey) {
      lastHandledDraftNavigationRef.current = { workspaceKey, draftFocusVersion };
      return;
    }
    if (previous.draftFocusVersion === draftFocusVersion) return;

    lastHandledDraftNavigationRef.current = { workspaceKey, draftFocusVersion };
    if (draftFocusVersion > 0 && isEngineView) onReturnToChat();
  }, [draftFocusVersion, isEngineView, onReturnToChat, workspaceKey]);
}
