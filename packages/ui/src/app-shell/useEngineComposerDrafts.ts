import { useCallback, useEffect, useRef, useState } from "react";

import type { EngineTaskComposerDraft } from "@/EngineConversation.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraftResult,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import {
  clearRecoveredQueueDraftText,
  finalizeSubmittedQueueDraft,
  markQueueDraftForSubmission,
  persistRecoveredQueueDraftText,
  persistRecoveredQueueDraftConfig,
  prepareQueueEditDraft,
  recoverPreparedQueueEditDraft,
  reconcilePreparedQueueEdits,
  restoreReviewedQueueDraft,
  updateRecoveredQueueAttachmentTickets,
  updateQueueDraftIssue,
  type QueueEditInputState,
} from "@/app-shell/engineQueueDraftStorage.js";

const scopeForTask = (taskId: string) => `anyagent-queue-edit:${taskId}`;
const scopeForPreparedInput = (taskId: string, inputId: string) =>
  `${scopeForTask(taskId)}:${inputId}`;

export type EngineQueueDraftIssue = "storage-failed" | "review-required";
type QueueRecoveryDraft = Pick<EngineTaskComposerDraft, "text" | "config" | "attachmentTickets">;

export function useEngineComposerDrafts(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  selectedTaskId: string | null,
) {
  const [drafts, setDrafts] = useState<Record<string, EngineTaskComposerDraft>>({});
  const [issues, setIssues] = useState<Record<string, EngineQueueDraftIssue>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const issuesRef = useRef(issues);
  issuesRef.current = issues;
  const setIssue = useCallback((taskId: string, issue: EngineQueueDraftIssue | null) => {
    setIssues((current) => updateQueueDraftIssue(current, taskId, issue));
  }, []);
  const readResult = useCallback(
    (taskId: string) =>
      readV4ComposerDraftResult(workspacePath, workspaceIdentity, scopeForTask(taskId)),
    [workspacePath, workspaceIdentity],
  );
  const persist = useCallback(
    (taskId: string, draft: Omit<V4ComposerDraft, "updatedAt">) =>
      persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeForTask(taskId), draft),
    [workspacePath, workspaceIdentity],
  );
  useEffect(() => {
    if (!selectedTaskId) return;
    const result = readResult(selectedTaskId);
    if (!result.ok) return;
    const stored = result.draft;
    if (!stored) return;
    if (stored.queueEditRequiresReview) {
      setIssue(selectedTaskId, "review-required");
      return;
    }
    if (!stored.text && !stored.queueEditAttachmentTickets?.length) return;
    setDrafts((current) => {
      if (current[selectedTaskId]) return current;
      return {
        ...current,
        [selectedTaskId]: {
          text: stored.text,
          editorStateJson: stored.editorStateJson,
          config: {
            mode: stored.queueEditOriginalMode ?? stored.mode,
            modelSelection: stored.modelSelection,
          },
          attachmentTickets: stored.queueEditAttachmentTickets,
          recoveryVersion: 1,
        },
      };
    });
  }, [readResult, selectedTaskId, setIssue]);
  const onQueueEditPrepare = useCallback(
    (taskId: string, inputId: string, recovered: QueueRecoveryDraft) => {
      const issue = prepareQueueEditDraft(
        workspacePath,
        workspaceIdentity,
        scopeForTask(taskId),
        scopeForPreparedInput(taskId, inputId),
        recovered,
      );
      if (issue) setIssue(taskId, issue);
      return !issue;
    },
    [setIssue, workspaceIdentity, workspacePath],
  );
  const onQueueRecovered = useCallback(
    (taskId: string, inputId: string) => {
      const recovered = recoverPreparedQueueEditDraft(
        workspacePath,
        workspaceIdentity,
        taskId,
        inputId,
      );
      if (!recovered) return false;
      if (recovered.alreadyRecovered) return true;
      setDrafts((current) => ({
        ...current,
        [taskId]: {
          text: recovered.text,
          config: recovered.config,
          attachmentTickets: recovered.attachmentTickets,
          recoveryVersion: (current[taskId]?.recoveryVersion ?? 0) + 1,
          recoveryParts: [
            ...(current[taskId]?.recoveryParts ?? []),
            { version: (current[taskId]?.recoveryVersion ?? 0) + 1, text: recovered.preparedText },
          ],
        },
      }));
      setIssue(taskId, null);
      return true;
    },
    [setIssue, workspaceIdentity, workspacePath],
  );
  const onQueueRecoveryReconcile = useCallback(
    (taskId: string, inputs: readonly QueueEditInputState[]) =>
      reconcilePreparedQueueEdits(workspacePath, workspaceIdentity, taskId, inputs, (inputId) =>
        onQueueRecovered(taskId, inputId),
      ),
    [onQueueRecovered, workspaceIdentity, workspacePath],
  );
  const onRecoveredDraftChange = useCallback(
    (taskId: string, text: string, editorStateJson?: string) => {
      const result = readResult(taskId);
      if (!result.ok) {
        if (!draftsRef.current[taskId]?.text) return;
        setIssue(taskId, "storage-failed");
        if (!text.trim()) return draftsRef.current[taskId]?.text;
        setDrafts((current) => {
          const draft = current[taskId];
          return draft ? { ...current, [taskId]: { ...draft, text, editorStateJson } } : current;
        });
        return;
      }
      const previous = result.draft;
      if (!previous || (!previous.text && !previous.queueEditAttachmentTickets?.length)) return;
      if (previous.queueEditRequiresReview) return;
      if (!text.trim()) {
        if (previous.queueEditAttachmentTickets?.length) {
          const { updatedAt: _updatedAt, editorStateJson: _editorStateJson, ...draft } = previous;
          const written = persist(taskId, { ...draft, text: "" });
          setIssue(taskId, written ? null : "storage-failed");
          if (written)
            setDrafts((current) => {
              const draft = current[taskId];
              return draft ? { ...current, [taskId]: { ...draft, text: "" } } : current;
            });
          return;
        }
        const { cleared, marked } = clearRecoveredQueueDraftText(
          workspacePath,
          workspaceIdentity,
          taskId,
          previous,
        );
        setIssue(taskId, cleared ? null : marked ? "review-required" : "storage-failed");
        if (!cleared && !marked) return previous.text;
        setDrafts((current) => {
          if (!current[taskId]) return current;
          if (!cleared)
            return { ...current, [taskId]: { ...current[taskId], text: "", recoveryVersion: 0 } };
          const next = { ...current };
          delete next[taskId];
          return next;
        });
        return;
      }
      const written = persistRecoveredQueueDraftText(
        workspacePath,
        workspaceIdentity,
        taskId,
        previous,
        text,
        editorStateJson,
      );
      setIssue(taskId, written ? null : "storage-failed");
      setDrafts((current) => {
        const draft = current[taskId];
        return draft ? { ...current, [taskId]: { ...draft, text, editorStateJson } } : current;
      });
    },
    [persist, readResult, setIssue, workspaceIdentity, workspacePath],
  );
  const onRecoveredConfigChange = useCallback(
    (taskId: string, config: NonNullable<EngineTaskComposerDraft["config"]>) => {
      const result = readResult(taskId);
      if (!result.ok) {
        if (!draftsRef.current[taskId]?.text) return;
        setIssue(taskId, "storage-failed");
        setDrafts((current) => {
          const draft = current[taskId];
          return draft ? { ...current, [taskId]: { ...draft, config } } : current;
        });
        return;
      }
      const previous = result.draft;
      if (!previous || (!previous.text && !previous.queueEditAttachmentTickets?.length)) return;
      if (previous.queueEditRequiresReview) return;
      const written = persistRecoveredQueueDraftConfig(
        workspacePath,
        workspaceIdentity,
        taskId,
        previous,
        config,
      );
      if (!written) setIssue(taskId, "storage-failed");
      setDrafts((current) => {
        const draft = current[taskId];
        return draft ? { ...current, [taskId]: { ...draft, config } } : current;
      });
    },
    [readResult, setIssue, workspaceIdentity, workspacePath],
  );
  const onRecoveredAttachmentTicketsChange = useCallback(
    (taskId: string, tickets: NonNullable<EngineTaskComposerDraft["attachmentTickets"]>) => {
      const result = readResult(taskId);
      if (!result.ok) {
        setIssue(taskId, "storage-failed");
        return false;
      }
      const status = updateRecoveredQueueAttachmentTickets(
        workspacePath,
        workspaceIdentity,
        taskId,
        result.draft,
        tickets,
      );
      if (status === "storage-failed" || status === "review-required") {
        setIssue(taskId, status);
        return false;
      }
      if (status === "updated")
        setDrafts((current) => {
          const value = current[taskId];
          return value
            ? { ...current, [taskId]: { ...value, attachmentTickets: [...tickets] } }
            : current;
        });
      if (status === "cleared")
        setDrafts((current) => {
          if (!current[taskId]) return current;
          const next = { ...current };
          delete next[taskId];
          return next;
        });
      setIssue(taskId, null);
      return true;
    },
    [readResult, setIssue, workspaceIdentity, workspacePath],
  );
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
    [persist, readResult, setIssue],
  );
  const onSubmitted = useCallback(
    (taskId: string, submittedText: string) => {
      const result = readResult(taskId);
      if (!result.ok) {
        if (!draftsRef.current[taskId]?.text && !issuesRef.current[taskId]) return true;
        setIssue(taskId, "review-required");
        return false;
      }
      const previous = result.draft;
      if (!previous?.text) return true;
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
      return outcome.cleared;
    },
    [readResult, setIssue, workspaceIdentity, workspacePath],
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
    [readResult, setIssue],
  );
  const onResolveReview = useCallback(
    (taskId: string, action: "restore" | "discard") => {
      const result = readResult(taskId);
      if (!result.ok) {
        setIssue(taskId, "storage-failed");
        return false;
      }
      const previous = result.draft;
      if (!previous?.queueEditRequiresReview) return false;
      const changed =
        action === "discard"
          ? clearV4ComposerDraft(workspacePath, workspaceIdentity, scopeForTask(taskId))
          : persist(taskId, restoreReviewedQueueDraft(previous));
      if (!changed) {
        setIssue(taskId, "review-required");
        return false;
      }
      setIssue(taskId, null);
      setDrafts((current) => {
        if (action === "discard") {
          const next = { ...current };
          delete next[taskId];
          return next;
        }
        return {
          ...current,
          [taskId]: {
            text: previous.text,
            editorStateJson: previous.editorStateJson,
            config: {
              mode: previous.queueEditOriginalMode ?? previous.mode,
              modelSelection: previous.modelSelection,
            },
            attachmentTickets: previous.queueEditAttachmentTickets,
            recoveryVersion: (current[taskId]?.recoveryVersion ?? 0) + 1,
          },
        };
      });
      return true;
    },
    [persist, readResult, setIssue, workspaceIdentity, workspacePath],
  );
  return {
    drafts,
    issues,
    onQueueEditPrepare,
    onQueueRecovered,
    onQueueRecoveryReconcile,
    onRecoveredDraftChange,
    onRecoveredConfigChange,
    onRecoveredAttachmentTicketsChange,
    onSubmitPrepare,
    onSubmitted,
    onSubmitUncertain,
    onResolveReview,
  };
}
