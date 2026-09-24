import { useCallback, useEffect, useState } from "react";
import type { EngineFileChanges, EngineFileRewindPreview } from "@anyagent/engine-contract";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { ConversationFileSummaryPanel } from "./v4/ConversationFileSummaryPanel.js";

export function EngineExecutionFileSummary({
  executionId,
  workspacePath,
  onOpenCodeViewer,
  blockedReason,
  loadChanges,
  previewRewind,
  applyRewind,
}: {
  executionId: string;
  workspacePath: string;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  blockedReason?: string | null;
  loadChanges: (executionId: string) => Promise<EngineFileChanges | null>;
  previewRewind: (executionId: string) => Promise<EngineFileRewindPreview>;
  applyRewind: (
    executionId: string,
    preview: EngineFileRewindPreview,
  ) => Promise<{ status: "requested" | "applied" | "rejected" | "unknown"; reason: string | null }>;
}) {
  const [changes, setChanges] = useState<EngineFileChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    void loadChanges(executionId).then(
      (result) => {
        if (current) {
          setChanges(result);
          setError(null);
        }
      },
      (cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [executionId, loadChanges, revision]);

  const fetchFileChanges = useCallback(async () => {
    const current = await loadChanges(executionId);
    if (!current) throw new Error("当前文件变化不可读取。");
    return current;
  }, [executionId, loadChanges]);

  if (!changes)
    return error ? (
      <p className="text-xs text-foreground-subtle">文件变化状态未知：{error}</p>
    ) : null;

  return (
    <ConversationFileSummaryPanel
      header={{
        rowId: 0,
        entityId: `engine-file:${executionId}`,
        turnId: `engine-file:${executionId}`,
        state: "completedSuccess",
        fileChanges: changes,
        ...(changes.canRewind && !blockedReason
          ? { actions: { canRewindFiles: true as const } }
          : {}),
      }}
      context={{
        workspacePath,
        onOpenCodeViewer,
        fetchFileChanges,
        previewFileRewind: () => previewRewind(executionId),
        applyFileRewind: async (_target, preview) => {
          const result = await applyRewind(executionId, preview);
          setRevision((value) => value + 1);
          return {
            status: result.status === "applied" ? "accepted" : "failed",
            ...(result.reason ? { message: result.reason } : {}),
          };
        },
      }}
    />
  );
}
