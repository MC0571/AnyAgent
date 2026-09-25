import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraftResult,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { queueEditDraftScopeForTask } from "@/app-shell/engineQueueDraftStorage.js";

const scopeForTask = (taskId: string) => `anyagent-task-composer:${taskId}`;
type TaskComposerDraft = Pick<V4ComposerDraft, "text" | "editorStateJson">;

function isDraftIncludedInSubmission(draftText: string, submittedText: string) {
  const draft = draftText.trim();
  const submitted = submittedText.trim();
  return draft === submitted || submitted.startsWith(`${draft}\n\n`);
}

export function useEngineTaskComposerDrafts(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  selectedTaskId: string | null,
) {
  const [drafts, setDrafts] = useState<Record<string, TaskComposerDraft | null>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const read = useCallback(
    (taskId: string) =>
      readV4ComposerDraftResult(workspacePath, workspaceIdentity, scopeForTask(taskId)),
    [workspacePath, workspaceIdentity],
  );
  const readQueueDraft = useCallback(
    (taskId: string) =>
      readV4ComposerDraftResult(
        workspacePath,
        workspaceIdentity,
        queueEditDraftScopeForTask(taskId),
      ),
    [workspacePath, workspaceIdentity],
  );
  const persist = useCallback(
    (taskId: string, draft: Omit<V4ComposerDraft, "updatedAt">) =>
      persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeForTask(taskId), draft),
    [workspacePath, workspaceIdentity],
  );

  useEffect(() => {
    if (!selectedTaskId) return;
    const result = read(selectedTaskId);
    if (!result.ok) return;
    const stored = result.draft;
    if (!stored?.text.trim()) {
      setDrafts((current) => {
        if (Object.hasOwn(current, selectedTaskId) && current[selectedTaskId] === null)
          return current;
        return { ...current, [selectedTaskId]: null };
      });
      return;
    }
    setDrafts((current) => ({
      ...current,
      [selectedTaskId]: {
        text: stored.text,
        ...(stored.editorStateJson ? { editorStateJson: stored.editorStateJson } : {}),
      },
    }));
  }, [read, selectedTaskId]);

  const onDraftChange = useCallback(
    (taskId: string, text: string, editorStateJson?: string) => {
      const queueDraftResult = readQueueDraft(taskId);
      if (!queueDraftResult.ok) return;
      const queueDraft = queueDraftResult.draft;
      if (
        queueDraft &&
        (queueDraft.text.trim() ||
          queueDraft.queueEditRequiresReview ||
          queueDraft.queueEditRecoveredInputIds?.length ||
          queueDraft.queueEditAttachmentTickets?.length)
      )
        return;
      const result = read(taskId);
      if (!result.ok) return;
      const previous = result.draft;
      const { updatedAt: _updatedAt, ...previousDraft } = previous ?? {
        text: "",
        updatedAt: 0,
      };
      if (
        !persist(taskId, {
          ...previousDraft,
          text: text.trim() ? text : "",
          editorStateJson: text.trim() ? editorStateJson : undefined,
          mention: undefined,
        })
      )
        return;

      setDrafts((current) => {
        if (!text.trim()) {
          if (Object.hasOwn(current, taskId) && current[taskId] === null) return current;
          return { ...current, [taskId]: null };
        }
        const next = { text, ...(editorStateJson ? { editorStateJson } : {}) };
        const existing = current[taskId];
        if (existing?.text === next.text && existing.editorStateJson === next.editorStateJson)
          return current;
        return { ...current, [taskId]: next };
      });
    },
    [persist, read, readQueueDraft],
  );

  const onSubmitted = useCallback(
    (taskId: string, submittedText: string) => {
      const result = read(taskId);
      if (!result.ok) {
        const current = draftsRef.current[taskId];
        return !current || !isDraftIncludedInSubmission(current.text, submittedText);
      }
      const stored = result.draft;
      if (stored?.text && isDraftIncludedInSubmission(stored.text, submittedText)) {
        if (!clearV4ComposerDraft(workspacePath, workspaceIdentity, scopeForTask(taskId)))
          return false;
        setDrafts((drafts) => {
          const current = drafts[taskId];
          if (!current || !isDraftIncludedInSubmission(current.text, submittedText)) return drafts;
          return { ...drafts, [taskId]: null };
        });
      } else {
        const current = draftsRef.current[taskId];
        if (current && isDraftIncludedInSubmission(current.text, submittedText))
          setDrafts((drafts) => {
            const draft = drafts[taskId];
            if (!draft || !isDraftIncludedInSubmission(draft.text, submittedText)) return drafts;
            return { ...drafts, [taskId]: null };
          });
      }
      return true;
    },
    [read, workspaceIdentity, workspacePath],
  );

  return { drafts, onDraftChange, onSubmitted };
}
