import type { EngineTaskComposerDraft } from "@/EngineConversation.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  readV4ComposerDraftResult,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";

export const queueEditDraftScopeForTask = (taskId: string) => `anyagent-queue-edit:${taskId}`;

export function prepareQueueEditDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskScopeId: string,
  scopeId: string,
  recovered: Pick<EngineTaskComposerDraft, "text" | "config" | "attachmentTickets">,
): "storage-failed" | "review-required" | null {
  const current = readV4ComposerDraftResult(workspacePath, workspaceIdentity, taskScopeId);
  if (!current.ok) return "storage-failed";
  if (current.draft?.queueEditRequiresReview) return "review-required";
  const mode = submissionModeSchema.safeParse(recovered.config?.mode);
  return persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, {
    text: recovered.text,
    ...(mode.success ? { mode: mode.data, queueEditOriginalMode: mode.data } : {}),
    ...(recovered.config?.modelSelection
      ? { modelSelection: recovered.config.modelSelection }
      : {}),
    ...(recovered.attachmentTickets?.length
      ? { queueEditAttachmentTickets: [...recovered.attachmentTickets] }
      : {}),
  })
    ? null
    : "storage-failed";
}

export function recoverPreparedQueueEditDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string,
  inputId: string,
) {
  const taskScope = queueEditDraftScopeForTask(taskId);
  const preparedScope = `${taskScope}:${inputId}`;
  const prepared = readV4ComposerDraft(workspacePath, workspaceIdentity, preparedScope);
  if (!prepared) return null;
  const previousResult = readV4ComposerDraftResult(workspacePath, workspaceIdentity, taskScope);
  if (!previousResult.ok || previousResult.draft?.queueEditRequiresReview) return null;
  const previous = previousResult.draft;
  if (previous?.queueEditRecoveredInputIds?.includes(inputId)) {
    clearV4ComposerDraft(workspacePath, workspaceIdentity, preparedScope);
    return { alreadyRecovered: true as const };
  }
  const text = [previous?.text, prepared.text].filter(Boolean).join("\n\n");
  const attachmentTickets = [
    ...(previous?.queueEditAttachmentTickets ?? []),
    ...(prepared.queueEditAttachmentTickets ?? []),
  ];
  const config = {
    mode: prepared.queueEditOriginalMode ?? previous?.queueEditOriginalMode ?? previous?.mode,
    modelSelection: prepared.modelSelection ?? previous?.modelSelection,
  };
  const mode = submissionModeSchema.safeParse(config.mode);
  if (
    !persistV4ComposerDraft(workspacePath, workspaceIdentity, taskScope, {
      text,
      ...(mode.success ? { mode: mode.data, queueEditOriginalMode: mode.data } : {}),
      ...(config.modelSelection ? { modelSelection: config.modelSelection } : {}),
      ...(attachmentTickets.length ? { queueEditAttachmentTickets: attachmentTickets } : {}),
      queueEditRecoveredInputIds: [...(previous?.queueEditRecoveredInputIds ?? []), inputId],
    })
  )
    return null;
  clearV4ComposerDraft(workspacePath, workspaceIdentity, preparedScope);
  return {
    alreadyRecovered: false as const,
    text,
    preparedText: prepared.text,
    config,
    attachmentTickets,
  };
}

export function updateRecoveredQueueAttachmentTickets(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string,
  previous: V4ComposerDraft | null,
  tickets: NonNullable<EngineTaskComposerDraft["attachmentTickets"]>,
): "ignored" | "updated" | "cleared" | "review-required" | "storage-failed" {
  if (!previous?.queueEditRecoveredInputIds?.length) return "ignored";
  if (previous.queueEditRequiresReview) return "review-required";
  const taskScope = queueEditDraftScopeForTask(taskId);
  if (!tickets.length && !previous.text.trim()) {
    if (
      previous.queueEditRecoveredInputIds.some((inputId) =>
        readV4ComposerDraft(workspacePath, workspaceIdentity, `${taskScope}:${inputId}`),
      )
    )
      return "review-required";
    return clearV4ComposerDraft(workspacePath, workspaceIdentity, taskScope)
      ? "cleared"
      : "storage-failed";
  }
  const { updatedAt: _updatedAt, ...draft } = previous;
  return persistV4ComposerDraft(workspacePath, workspaceIdentity, taskScope, {
    ...draft,
    queueEditAttachmentTickets: [...tickets],
  })
    ? "updated"
    : "storage-failed";
}

export function clearRecoveredQueueDraftText(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string,
  previous: V4ComposerDraft,
): { cleared: boolean; marked: boolean } {
  const taskScope = queueEditDraftScopeForTask(taskId);
  const unclearedIds = previous.queueEditRecoveredInputIds?.filter((inputId) =>
    readV4ComposerDraft(workspacePath, workspaceIdentity, `${taskScope}:${inputId}`),
  );
  const cleared = unclearedIds?.length
    ? persistV4ComposerDraft(workspacePath, workspaceIdentity, taskScope, {
        text: "",
        queueEditRecoveredInputIds: unclearedIds,
      })
    : clearV4ComposerDraft(workspacePath, workspaceIdentity, taskScope);
  if (cleared) return { cleared: true, marked: false };
  // A marker is preferable to resurrecting old text after a restart.
  const marked = persistV4ComposerDraft(workspacePath, workspaceIdentity, taskScope, {
    text: "",
    queueEditRequiresReview: true,
    ...(unclearedIds?.length ? { queueEditRecoveredInputIds: unclearedIds } : {}),
  });
  return { cleared: false, marked };
}

export function persistRecoveredQueueDraftText(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string,
  previous: V4ComposerDraft,
  text: string,
  editorStateJson?: string,
) {
  return persistV4ComposerDraft(
    workspacePath,
    workspaceIdentity,
    queueEditDraftScopeForTask(taskId),
    {
      text,
      ...(editorStateJson ? { editorStateJson } : {}),
      ...(previous.mode ? { mode: previous.mode } : {}),
      ...(previous.queueEditOriginalMode
        ? { queueEditOriginalMode: previous.queueEditOriginalMode }
        : {}),
      ...(previous.modelSelection ? { modelSelection: previous.modelSelection } : {}),
      ...(previous.queueEditAttachmentTickets
        ? { queueEditAttachmentTickets: previous.queueEditAttachmentTickets }
        : {}),
      ...(previous.queueEditRecoveredInputIds
        ? { queueEditRecoveredInputIds: previous.queueEditRecoveredInputIds }
        : {}),
    },
  );
}

export function persistRecoveredQueueDraftConfig(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string,
  previous: V4ComposerDraft,
  config: NonNullable<EngineTaskComposerDraft["config"]>,
) {
  const mode = submissionModeSchema.safeParse(config.mode);
  return persistV4ComposerDraft(
    workspacePath,
    workspaceIdentity,
    queueEditDraftScopeForTask(taskId),
    {
      text: previous.text,
      ...(previous.editorStateJson ? { editorStateJson: previous.editorStateJson } : {}),
      ...(mode.success ? { mode: mode.data } : previous.mode ? { mode: previous.mode } : {}),
      ...(mode.success
        ? { queueEditOriginalMode: mode.data }
        : previous.queueEditOriginalMode
          ? { queueEditOriginalMode: previous.queueEditOriginalMode }
          : {}),
      ...(config.modelSelection ? { modelSelection: config.modelSelection } : {}),
      ...(previous.queueEditAttachmentTickets
        ? { queueEditAttachmentTickets: previous.queueEditAttachmentTickets }
        : {}),
      ...(previous.queueEditRecoveredInputIds
        ? { queueEditRecoveredInputIds: previous.queueEditRecoveredInputIds }
        : {}),
    },
  );
}

export function finalizeSubmittedQueueDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string,
  previous: V4ComposerDraft,
  submittedText: string,
): { textMatched: boolean; cleared: boolean; reviewRequired: boolean } {
  if (previous.text.trim() !== submittedText)
    return { textMatched: false, cleared: false, reviewRequired: true };
  const taskScope = queueEditDraftScopeForTask(taskId);
  const unclearedIds = previous.queueEditRecoveredInputIds?.filter((inputId) =>
    readV4ComposerDraft(workspacePath, workspaceIdentity, `${taskScope}:${inputId}`),
  );
  const cleared = unclearedIds?.length
    ? persistV4ComposerDraft(workspacePath, workspaceIdentity, taskScope, {
        text: "",
        queueEditRequiresReview: true,
        queueEditRecoveredInputIds: unclearedIds,
      })
    : clearV4ComposerDraft(workspacePath, workspaceIdentity, taskScope);
  return { textMatched: true, cleared, reviewRequired: !cleared || !!unclearedIds?.length };
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
    const scopeId = `${queueEditDraftScopeForTask(taskId)}:${input.id}`;
    if (!readV4ComposerDraft(workspacePath, workspaceIdentity, scopeId)) continue;
    if (input.status === "cancelled") onCancelled(input.id);
    else if (["completed", "rejected", "stopped", "failed"].includes(input.status))
      clearV4ComposerDraft(workspacePath, workspaceIdentity, scopeId);
  }
}
