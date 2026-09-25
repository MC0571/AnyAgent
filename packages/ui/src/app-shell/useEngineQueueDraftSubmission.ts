import { useCallback, type Dispatch, type SetStateAction } from "react";

import type { EngineTaskComposerDraft } from "@/EngineConversation.js";
import {
  finalizeSubmittedQueueDraft,
  markQueueDraftForSubmission,
} from "@/app-shell/engineQueueDraftStorage.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

export type EngineQueueDraftIssue = "storage-failed" | "review-required";

type DraftMap = Record<string, EngineTaskComposerDraft>;
type IssueMap = Record<string, EngineQueueDraftIssue>;
type IssueSetter = (taskId: string, issue: EngineQueueDraftIssue | null) => void;
type DraftReader = (
  taskId: string,
) =>
  | { readonly ok: true; readonly draft: V4ComposerDraft | null }
  | { readonly ok: false; readonly draft: null };
type DraftPersister = (taskId: string, draft: Omit<V4ComposerDraft, "updatedAt">) => boolean;
type TaskDraftSubmitter = (taskId: string, text: string) => boolean;

export function useEngineQueueDraftSubmission({
  workspacePath,
  workspaceIdentity,
  readResult,
  persist,
  draftsRef,
  issuesRef,
  setDrafts,
  setIssue,
  onTaskDraftSubmitted,
}: {
  workspacePath: string;
  workspaceIdentity: string | undefined;
  readResult: DraftReader;
  persist: DraftPersister;
  draftsRef: { current: DraftMap };
  issuesRef: { current: IssueMap };
  setDrafts: Dispatch<SetStateAction<DraftMap>>;
  setIssue: IssueSetter;
  onTaskDraftSubmitted: TaskDraftSubmitter;
}) {
  const onSubmitPrepare = useCallback(
    (
      taskId: string,
      text: string,
      submissionConfig?: NonNullable<EngineTaskComposerDraft["config"]>,
      hasCancelledQueueInput = false,
    ) => {
      const result = readResult(taskId);
      if (!result.ok) {
        if (
          draftsRef.current[taskId]?.text ||
          issuesRef.current[taskId] ||
          hasCancelledQueueInput
        ) {
          setIssue(taskId, "storage-failed");
          return false;
        }
        return true;
      }
      const previous = result.draft;
      if (previous?.queueEditRequiresReview) {
        setIssue(taskId, "review-required");
        return false;
      }
      if (!previous || (!previous.text && !previous.queueEditAttachmentTickets?.length)) {
        if (draftsRef.current[taskId]?.text) {
          setIssue(taskId, "storage-failed");
          return false;
        }
        setIssue(taskId, null);
        return true;
      }
      const written = persist(
        taskId,
        markQueueDraftForSubmission(previous, text, submissionConfig),
      );
      setIssue(taskId, written ? null : "storage-failed");
      return written;
    },
    [draftsRef, issuesRef, persist, readResult, setIssue],
  );

  const onSubmitted = useCallback(
    (taskId: string, submittedText: string) => {
      const result = readResult(taskId);
      if (!result.ok) {
        if (!draftsRef.current[taskId]?.text && !issuesRef.current[taskId])
          return onTaskDraftSubmitted(taskId, submittedText);
        setIssue(taskId, "review-required");
        return false;
      }
      const previous = result.draft;
      if (!previous?.text) return onTaskDraftSubmitted(taskId, submittedText);
      const outcome = finalizeSubmittedQueueDraft(
        workspacePath,
        workspaceIdentity,
        taskId,
        previous,
        submittedText,
      );
      setIssue(taskId, outcome.reviewRequired ? "review-required" : null);
      if (!outcome.textMatched) return false;
      setDrafts((current) => {
        const draft = current[taskId];
        // Keep recoveryVersion monotonic; the mounted Composer already applied it.
        return draft
          ? {
              ...current,
              [taskId]: { ...draft, text: "", attachmentTickets: [], recoveryParts: [] },
            }
          : current;
      });
      return outcome.cleared && onTaskDraftSubmitted(taskId, submittedText);
    },
    [
      draftsRef,
      issuesRef,
      onTaskDraftSubmitted,
      readResult,
      setDrafts,
      setIssue,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const onSubmitUncertain = useCallback(
    (taskId: string) => {
      const result = readResult(taskId);
      if (
        (!result.ok && (draftsRef.current[taskId]?.text || issuesRef.current[taskId])) ||
        result.draft?.queueEditRequiresReview
      )
        setIssue(taskId, "review-required");
    },
    [draftsRef, issuesRef, readResult, setIssue],
  );

  return { onSubmitPrepare, onSubmitted, onSubmitUncertain };
}
