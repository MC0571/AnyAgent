import type { EngineTaskComposerDraft } from "@/EngineConversation.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";

export function prepareQueueEditDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  recovered: Pick<EngineTaskComposerDraft, "text" | "config">,
) {
  const mode = submissionModeSchema.safeParse(recovered.config?.mode);
  return persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, {
    text: recovered.text,
    ...(mode.success ? { mode: mode.data, queueEditOriginalMode: mode.data } : {}),
    ...(recovered.config?.modelSelection
      ? { modelSelection: recovered.config.modelSelection }
      : {}),
  });
}

export function restoreReviewedQueueDraft(
  previous: V4ComposerDraft,
): Omit<V4ComposerDraft, "updatedAt"> {
  const {
    updatedAt: _updatedAt,
    queueEditRequiresReview: _queueEditRequiresReview,
    ...draft
  } = previous;
  return draft;
}

export function markQueueDraftForSubmission(
  previous: V4ComposerDraft,
  text: string,
  submissionConfig?: NonNullable<EngineTaskComposerDraft["config"]>,
): Omit<V4ComposerDraft, "updatedAt"> {
  const selectedMode = submissionModeSchema.safeParse(submissionConfig?.mode);
  return {
    ...restoreReviewedQueueDraft(previous),
    text,
    queueEditRequiresReview: true,
    ...(selectedMode.success
      ? { mode: selectedMode.data, queueEditOriginalMode: selectedMode.data }
      : {}),
    ...(submissionConfig?.modelSelection
      ? { modelSelection: submissionConfig.modelSelection }
      : {}),
  };
}

export interface QueueEditInputState {
  readonly id: string;
  readonly status: string;
  readonly receivedAt?: number | null;
  readonly queuePosition?: number | null;
}

export function updateQueueDraftIssue<T extends string>(
  current: Record<string, T>,
  taskId: string,
  issue: T | null,
) {
  if (current[taskId] === issue || (!issue && !current[taskId])) return current;
  const next = { ...current };
  if (issue) next[taskId] = issue;
  else delete next[taskId];
  return next;
}

export function reconcilePreparedQueueEdits(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string,
  inputs: readonly QueueEditInputState[],
  onCancelled: (inputId: string) => void,
) {
  for (const input of [...inputs].sort(
    (left, right) =>
      (left.queuePosition ?? left.receivedAt ?? 0) -
        (right.queuePosition ?? right.receivedAt ?? 0) || left.id.localeCompare(right.id),
  )) {
    const scopeId = `anyagent-queue-edit:${taskId}:${input.id}`;
    if (!readV4ComposerDraft(workspacePath, workspaceIdentity, scopeId)) continue;
    if (input.status === "cancelled") onCancelled(input.id);
    else if (["completed", "rejected", "stopped", "failed"].includes(input.status))
      clearV4ComposerDraft(workspacePath, workspaceIdentity, scopeId);
  }
}
