import { useCallback, useEffect, useRef, useState } from "react";

import type { EngineTaskComposerDraft } from "@/EngineConversation.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  readV4ComposerDraftResult,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  markQueueDraftForSubmission,
  prepareQueueEditDraft,
  reconcilePreparedQueueEdits,
  restoreReviewedQueueDraft,
  updateQueueDraftIssue,
  type QueueEditInputState,
} from "@/app-shell/engineQueueDraftStorage.js";

const scopeForTask = (taskId: string) => `anyagent-queue-edit:${taskId}`;
const scopeForPreparedInput = (taskId: string, inputId: string) =>
  `anyagent-queue-edit:${taskId}:${inputId}`;

export type EngineQueueDraftIssue = "storage-failed" | "review-required";

/** Only a cancelled queue item is owned here; ordinary Composer drafts stay in their editor. */
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
    if (!stored.text) return;
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
          recoveryVersion: 1,
        },
      };
    });
  }, [readResult, selectedTaskId, setIssue]);
  const onQueueEditPrepare = useCallback(
    (
      taskId: string,
      inputId: string,
      recovered: Pick<EngineTaskComposerDraft, "text" | "config">,
    ) =>
      prepareQueueEditDraft(
        workspacePath,
        workspaceIdentity,
        scopeForPreparedInput(taskId, inputId),
        recovered,
      ),
    [workspaceIdentity, workspacePath],
  );
  const onQueueRecovered = useCallback(
    (taskId: string, inputId: string) => {
      const prepared = readV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        scopeForPreparedInput(taskId, inputId),
      );
      if (!prepared) return false;
      const previousResult = readResult(taskId);
      if (!previousResult.ok) return false;
      const previous = previousResult.draft;
      if (previous?.queueEditRecoveredInputIds?.includes(inputId)) {
        clearV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          scopeForPreparedInput(taskId, inputId),
        );
        return true;
      }
      const text = [previous?.text, prepared.text].filter(Boolean).join("\n\n");
      const config = {
        mode: prepared.queueEditOriginalMode ?? previous?.queueEditOriginalMode ?? previous?.mode,
        modelSelection: prepared.modelSelection ?? previous?.modelSelection,
      };
      const mode = submissionModeSchema.safeParse(config.mode);
      const persisted = persist(taskId, {
        text,
        ...(mode.success ? { mode: mode.data, queueEditOriginalMode: mode.data } : {}),
        ...(config.modelSelection ? { modelSelection: config.modelSelection } : {}),
        queueEditRecoveredInputIds: [...(previous?.queueEditRecoveredInputIds ?? []), inputId],
      });
      if (!persisted) return false;
      clearV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        scopeForPreparedInput(taskId, inputId),
      );
      setDrafts((current) => ({
        ...current,
        [taskId]: {
          text,
          config,
          recoveryVersion: (current[taskId]?.recoveryVersion ?? 0) + 1,
          recoveryParts: [
            ...(current[taskId]?.recoveryParts ?? []),
            { version: (current[taskId]?.recoveryVersion ?? 0) + 1, text: prepared.text },
          ],
        },
      }));
      setIssue(taskId, null);
      return true;
    },
    [persist, readResult, setIssue, workspaceIdentity, workspacePath],
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
      if (!previous?.text) return;
      if (previous.queueEditRequiresReview) return;
      if (!text.trim()) {
        const unclearedIds = previous.queueEditRecoveredInputIds?.filter((inputId) =>
          readV4ComposerDraft(
            workspacePath,
            workspaceIdentity,
            scopeForPreparedInput(taskId, inputId),
          ),
        );
        const cleared = unclearedIds?.length
          ? persist(taskId, { text: "", queueEditRecoveredInputIds: unclearedIds })
          : clearV4ComposerDraft(workspacePath, workspaceIdentity, scopeForTask(taskId));
        if (!cleared) {
          // A marker is preferable to resurrecting old text after a restart.
          const marked = persist(taskId, {
            text: "",
            queueEditRequiresReview: true,
            ...(unclearedIds?.length ? { queueEditRecoveredInputIds: unclearedIds } : {}),
          });
          setIssue(taskId, marked ? "review-required" : "storage-failed");
          if (!marked) return previous.text;
        } else setIssue(taskId, null);
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
      const written = persist(taskId, {
        text,
        ...(editorStateJson ? { editorStateJson } : {}),
        ...(previous.mode ? { mode: previous.mode } : {}),
        ...(previous.queueEditOriginalMode
          ? { queueEditOriginalMode: previous.queueEditOriginalMode }
          : {}),
        ...(previous.modelSelection ? { modelSelection: previous.modelSelection } : {}),
        ...(previous.queueEditRecoveredInputIds
          ? { queueEditRecoveredInputIds: previous.queueEditRecoveredInputIds }
          : {}),
      });
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
      if (!previous?.text) return;
      if (previous.queueEditRequiresReview) return;
      const mode = submissionModeSchema.safeParse(config.mode);
      const written = persist(taskId, {
        text: previous.text,
        ...(previous.editorStateJson ? { editorStateJson: previous.editorStateJson } : {}),
        ...(mode.success ? { mode: mode.data } : previous.mode ? { mode: previous.mode } : {}),
        ...(mode.success
          ? { queueEditOriginalMode: mode.data }
          : previous.queueEditOriginalMode
            ? { queueEditOriginalMode: previous.queueEditOriginalMode }
            : {}),
        ...(config.modelSelection ? { modelSelection: config.modelSelection } : {}),
        ...(previous.queueEditRecoveredInputIds
          ? { queueEditRecoveredInputIds: previous.queueEditRecoveredInputIds }
          : {}),
      });
      if (!written) setIssue(taskId, "storage-failed");
      setDrafts((current) => {
        const draft = current[taskId];
        return draft ? { ...current, [taskId]: { ...draft, config } } : current;
      });
    },
    [persist, readResult, setIssue],
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
      if (!previous?.text) {
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
      if (previous.text.trim() !== submittedText) {
        setIssue(taskId, "review-required");
        return false;
      }
      const unclearedIds = previous.queueEditRecoveredInputIds?.filter((inputId) =>
        readV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          scopeForPreparedInput(taskId, inputId),
        ),
      );
      const cleared = unclearedIds?.length
        ? persist(taskId, {
            text: "",
            queueEditRequiresReview: true,
            queueEditRecoveredInputIds: unclearedIds,
          })
        : clearV4ComposerDraft(workspacePath, workspaceIdentity, scopeForTask(taskId));
      if (!cleared) setIssue(taskId, "review-required");
      else setIssue(taskId, unclearedIds?.length ? "review-required" : null);
      setDrafts((current) => {
        if (!current[taskId]) return current;
        return { ...current, [taskId]: { ...current[taskId], text: "", recoveryVersion: 0 } };
      });
      return cleared;
    },
    [persist, readResult, setIssue, workspaceIdentity, workspacePath],
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
    onSubmitPrepare,
    onSubmitted,
    onSubmitUncertain,
    onResolveReview,
  };
}
