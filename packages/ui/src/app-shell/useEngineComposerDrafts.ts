import { useCallback, useEffect, useState } from "react";

import type { EngineTaskComposerDraft } from "@/EngineConversation.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";

const scopeForTask = (taskId: string) => `anyagent-queue-edit:${taskId}`;
const scopeForPreparedInput = (taskId: string, inputId: string) =>
  `anyagent-queue-edit:${taskId}:${inputId}`;

/** Only a cancelled queue item is owned here; ordinary Composer drafts stay in their editor. */
export function useEngineComposerDrafts(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  selectedTaskId: string | null,
) {
  const [drafts, setDrafts] = useState<Record<string, EngineTaskComposerDraft>>({});
  const read = useCallback(
    (taskId: string) => readV4ComposerDraft(workspacePath, workspaceIdentity, scopeForTask(taskId)),
    [workspacePath, workspaceIdentity],
  );
  const persist = useCallback(
    (taskId: string, draft: Omit<V4ComposerDraft, "updatedAt">) =>
      persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeForTask(taskId), draft),
    [workspacePath, workspaceIdentity],
  );
  useEffect(() => {
    if (!selectedTaskId) return;
    const stored = read(selectedTaskId);
    if (!stored?.text) return;
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
  }, [read, selectedTaskId]);
  const onQueueEditPrepare = useCallback(
    (
      taskId: string,
      inputId: string,
      recovered: Pick<EngineTaskComposerDraft, "text" | "config">,
    ) => {
      const mode = submissionModeSchema.safeParse(recovered.config?.mode);
      return persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        scopeForPreparedInput(taskId, inputId),
        {
          text: recovered.text,
          ...(mode.success ? { mode: mode.data } : {}),
          ...(mode.success ? { queueEditOriginalMode: mode.data } : {}),
          ...(recovered.config?.modelSelection
            ? { modelSelection: recovered.config.modelSelection }
            : {}),
        },
      );
    },
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
      const previous = read(taskId);
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
      return true;
    },
    [persist, read, workspaceIdentity, workspacePath],
  );
  const onQueueRecoveryReconcile = useCallback(
    (
      taskId: string,
      inputs: readonly {
        readonly id: string;
        readonly status: string;
        readonly receivedAt?: number | null;
        readonly queuePosition?: number | null;
      }[],
    ) => {
      for (const input of [...inputs].sort(
        (left, right) =>
          (left.queuePosition ?? left.receivedAt ?? 0) -
            (right.queuePosition ?? right.receivedAt ?? 0) || left.id.localeCompare(right.id),
      )) {
        const prepared = readV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          scopeForPreparedInput(taskId, input.id),
        );
        if (!prepared) continue;
        if (input.status === "cancelled") onQueueRecovered(taskId, input.id);
        else if (["completed", "rejected", "stopped", "failed"].includes(input.status))
          clearV4ComposerDraft(
            workspacePath,
            workspaceIdentity,
            scopeForPreparedInput(taskId, input.id),
          );
      }
    },
    [onQueueRecovered, workspaceIdentity, workspacePath],
  );
  const onRecoveredDraftChange = useCallback(
    (taskId: string, text: string, editorStateJson?: string) => {
      const previous = read(taskId);
      if (!previous?.text) return;
      if (!text.trim()) {
        const unclearedIds = previous.queueEditRecoveredInputIds?.filter((inputId) =>
          readV4ComposerDraft(
            workspacePath,
            workspaceIdentity,
            scopeForPreparedInput(taskId, inputId),
          ),
        );
        if (unclearedIds?.length)
          persist(taskId, { text: "", queueEditRecoveredInputIds: unclearedIds });
        else clearV4ComposerDraft(workspacePath, workspaceIdentity, scopeForTask(taskId));
        setDrafts((current) => {
          if (!current[taskId]) return current;
          const next = { ...current };
          delete next[taskId];
          return next;
        });
        return;
      }
      persist(taskId, {
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
      setDrafts((current) => {
        const draft = current[taskId];
        return draft ? { ...current, [taskId]: { ...draft, text, editorStateJson } } : current;
      });
    },
    [persist, read, workspaceIdentity, workspacePath],
  );
  const onRecoveredConfigChange = useCallback(
    (taskId: string, config: NonNullable<EngineTaskComposerDraft["config"]>) => {
      const previous = read(taskId);
      if (!previous?.text) return;
      const mode = submissionModeSchema.safeParse(config.mode);
      persist(taskId, {
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
      setDrafts((current) => {
        const draft = current[taskId];
        return draft ? { ...current, [taskId]: { ...draft, config } } : current;
      });
    },
    [persist, read],
  );
  const onSubmitted = useCallback(
    (taskId: string, submittedText: string) => {
      const previous = read(taskId);
      if (!previous || previous.text.trim() !== submittedText) return;
      const unclearedIds = previous.queueEditRecoveredInputIds?.filter((inputId) =>
        readV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          scopeForPreparedInput(taskId, inputId),
        ),
      );
      if (unclearedIds?.length)
        persist(taskId, { text: "", queueEditRecoveredInputIds: unclearedIds });
      else clearV4ComposerDraft(workspacePath, workspaceIdentity, scopeForTask(taskId));
      setDrafts((current) => {
        if (!current[taskId]) return current;
        const next = { ...current };
        delete next[taskId];
        return next;
      });
    },
    [persist, read, workspaceIdentity, workspacePath],
  );
  return {
    drafts,
    onQueueEditPrepare,
    onQueueRecovered,
    onQueueRecoveryReconcile,
    onRecoveredDraftChange,
    onRecoveredConfigChange,
    onSubmitted,
  };
}
