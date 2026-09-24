/* oxlint-disable eslint(max-lines) -- 单个 Task 的刷新、资格投影、身份校验与正式消息界面共享同一选中状态。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BrainIcon } from "lucide-react";
import type { IAnyAgentService } from "@zcode/services";
import type {
  EngineCapability,
  EngineFileRewindPreview,
  EngineUserInputAnswer,
} from "@anyagent/engine-contract";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import {
  EngineCapabilityList,
  canActOnTask,
  jsonLabel,
  shortId,
  timeLabel,
} from "@/EngineUiParts.js";
import type { EngineHistory, EngineTask } from "@/EngineUiParts.js";
import {
  EngineConversationTimeline,
  type EngineLocalAttachment,
} from "@/EngineConversationTimeline.js";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import {
  projectEngineConversation,
  type EngineConversationProjection,
} from "@/engineConversationProjection.js";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { ConfigSelect } from "@/chat-input-toolbar/display.js";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import {
  buildRegistryModelSelectGroups,
  buildZCodeHarnessModelGroup,
  decodeHarnessZCodeModelValue,
  encodeHarnessZCodeModelValue,
} from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { completeNewModelSelection } from "@zcode/provider";
import {
  BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES,
  getZCodeAgentModeSelectOptions,
  modelSelectionSchema,
  ZCODE_AGENT_PROVIDER,
  type ModelSelection,
  type ZCodeSlashCommand,
  type ZCodeConfigOption,
} from "@zcode/shared";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { useSlashCommands } from "@/hooks/useSlashCommands.js";
import { normalizeSlashCommandValue, type AppSlashCommand } from "@/slashCommandHelpers.js";
import { resolveDraftModelThoughtOption } from "@/v4/composer/draftWorkspaceDefaults.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getConversationContentWidthClassName } from "@/v4/conversationLayout.js";
import { basenameFromPath, inferAttachmentMimeType } from "@/lib/chatAttachmentMetadata.js";
import { appendPromptHistoryEntry } from "@/lib/promptHistory.js";
import {
  persistPromptHistoryEntries,
  readPromptHistoryEntries,
} from "@/lib/promptHistoryStorage.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { ConversationFindMatchState } from "@/v4/legacyChatViewTypes.js";
import { useWebElementContexts } from "@/v4/composer/useWebElementContexts.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import {
  buildPromptWithWebElementContexts,
  parsePromptWebElementContexts,
} from "@/lib/webElementContext.js";

type Notice = { kind: "error" | "info"; message: string };
type InheritedSource = {
  sourceTaskId: string;
  projection: EngineConversationProjection | null;
  submissionConfig?: NonNullable<EngineHistory["inputs"][number]["submissionConfig"]>;
};
type EngineComposerAttachment = EngineLocalAttachment;
const contentWidthClassName = getConversationContentWidthClassName({
  centeredEmptyLayout: false,
  statusPanelLayout: "none",
});
const engineModeUnavailableOptions = getZCodeAgentModeSelectOptions();
const zcodeBuiltinSlashCommandByName = new Map(
  BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.flatMap((entry) =>
    [entry.name, ...(entry.aliases ?? [])].map((name) => [name.toLowerCase(), entry.name] as const),
  ),
);
const nativePromptBuiltinSlashCommands = new Set(["init", "skill"]);
const rendererMappedSlashCommands = new Set(["compact", "mode", "plan"]);

function parseLeadingSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  const rawName = match?.[1];
  if (!rawName) return null;
  return {
    name: normalizeSlashCommandValue(rawName).toLowerCase(),
    args: match?.[2]?.trim() ?? "",
  };
}

function nativeBuiltinForSlashCommand(
  name: string,
  commands: readonly ZCodeSlashCommand[],
): string | null {
  const knownBuiltin = zcodeBuiltinSlashCommandByName.get(name);
  if (knownBuiltin) return knownBuiltin;
  const catalogCommand = commands.find(
    (command) => normalizeSlashCommandValue(command.name).toLowerCase() === name,
  );
  return catalogCommand && catalogCommand.source !== "custom" ? name : null;
}

function excludedNativeSlashCommandNames(commands: readonly ZCodeSlashCommand[]): string[] {
  return commands
    .map((command) => normalizeSlashCommandValue(command.name).toLowerCase())
    .filter((name) => {
      if (nativePromptBuiltinSlashCommands.has(name) || rendererMappedSlashCommands.has(name))
        return false;
      return nativeBuiltinForSlashCommand(name, commands) !== null;
    });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminal(status: string) {
  return status === "completed" || status === "failed" || status === "stopped";
}

async function loadInheritedSources(
  service: IAnyAgentService,
  child: EngineTask,
): Promise<InheritedSource[]> {
  const sources: InheritedSource[] = [];
  const visited = new Set([child.id]);
  let current: EngineTask = child;
  while (current.forkedFrom) {
    const { taskId, inputId, executionId } = current.forkedFrom;
    if (visited.has(taskId)) {
      sources.push({ sourceTaskId: taskId, projection: null });
      break;
    }
    visited.add(taskId);
    const [sourceTask, sourceHistory] = await Promise.all([
      service.getTask(taskId),
      service.getHistory(taskId),
    ]);
    if (!sourceTask || !sourceHistory || sourceHistory.taskId !== taskId) {
      sources.push({ sourceTaskId: taskId, projection: null });
      break;
    }
    const full = projectEngineConversation(sourceTask, sourceHistory);
    const turnIndex = full.turns.findIndex((turn) => turn.input.id === inputId);
    const turn = full.turns[turnIndex];
    const executionIndex =
      turn?.executions.findIndex((entry) => entry.execution.id === executionId) ?? -1;
    if (!turn || executionIndex < 0) {
      sources.push({ sourceTaskId: taskId, projection: null });
      break;
    }
    sources.push({
      sourceTaskId: taskId,
      ...(turn.input.submissionConfig ? { submissionConfig: turn.input.submissionConfig } : {}),
      projection: {
        turns: [
          ...full.turns.slice(0, turnIndex),
          { ...turn, executions: turn.executions.slice(0, executionIndex + 1) },
        ],
        unassociatedExecutions: [],
        unassociatedEvents: [],
        unassociatedApprovals: [],
        unassociatedUserInputs: [],
      },
    });
    current = sourceTask;
  }
  return sources.reverse();
}

function currentTaskBlock(
  task: EngineTask,
  capability: EngineCapability,
  refreshedEngines: Awaited<ReturnType<IAnyAgentService["listEngines"]>> | null,
  refreshFailed: boolean,
): string | null {
  if (refreshFailed || refreshedEngines === null)
    return "暂时无法确认此对话是否可继续，请刷新状态。";
  const current = refreshedEngines.find(
    (engine) => engine.engineId === task.currentEngine.engineId,
  );
  if (!current || current.state !== "current") return "暂时无法确认此对话是否可继续，请刷新状态。";
  return canActOnTask({ ...task, currentEngine: current }, capability);
}

export function EngineConversation({
  service,
  selectedTaskId,
  onSelectTask,
  onTitleChange,
  onOpenCodeViewer,
  onOpenFileLink,
  refreshVersion = 0,
  inspectorOpen = false,
  onInspectorOpenChange = () => {},
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
}: {
  service: IAnyAgentService;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onTitleChange?: (taskId: string, title: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  refreshVersion?: number;
  inspectorOpen?: boolean;
  onInspectorOpenChange?: (open: boolean) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
}) {
  const [task, setTask] = useState<EngineTask | null>(null);
  const [history, setHistory] = useState<EngineHistory | null>(null);
  const [feedbackSnapshot, setFeedbackSnapshot] = useState<{
    taskId: string;
    read: Awaited<ReturnType<IAnyAgentService["getAssistantFeedback"]>>;
  } | null>(null);
  const [inheritedSources, setInheritedSources] = useState<{
    childTaskId: string;
    sources: InheritedSource[];
  } | null>(null);
  const [engines, setEngines] = useState<Awaited<
    ReturnType<IAnyAgentService["listEngines"]>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const setNotice = (notice: Notice | null) => {
    if (notice) toast(notice.message, { variant: notice.kind === "error" ? "warning" : "info" });
  };
  const [attachmentsByTask, setAttachmentsByTask] = useState<
    Record<string, EngineComposerAttachment[]>
  >({});
  const [configByTask, setConfigByTask] = useState<
    Record<string, { mode?: string; modelSelection?: ModelSelection }>
  >({});
  const [revision, setRevision] = useState(0);
  const requestVersionRef = useRef(0);
  const changeVersionRef = useRef(0);
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const queuedSubmissionRef = useRef<{
    taskId: string;
    authorizationId: string;
    text: string;
    config: string;
    key: string;
  } | null>(null);
  const submitPendingRef = useRef(false);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const followConversationTailRef = useRef(true);
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const unavailableControlValue = intl.formatMessage({
    id: "engine.composer.unavailableValue",
  });
  const engineModeUnavailableOption: ZCodeConfigOption = {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: unavailableControlValue,
    options: engineModeUnavailableOptions,
  };
  const engineThoughtUnavailableOption: ZCodeConfigOption = {
    id: "thought_level",
    name: "Thought Level",
    category: "thought_level",
    type: "select",
    currentValue: "engine-unavailable",
    options: [{ value: "engine-unavailable", name: unavailableControlValue }],
  };
  const { modelSelectionService } = useServices();
  const modelSelectionRead = useModelSelectionServiceView(modelSelectionService);

  const refresh = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    const startedChangeVersion = changeVersionRef.current;
    setLoading(true);
    setRefreshFailed(false);
    setEngines(null);
    try {
      const nextTasks = await service.listTasks();
      const targetTaskId = selectedTaskId ?? nextTasks[0]?.id ?? null;
      if (!targetTaskId) {
        const nextEngines = await service.listEngines();
        if (requestVersion !== requestVersionRef.current) return;
        setEngines(nextEngines);
        if (changeVersionRef.current === startedChangeVersion) {
          setTask(null);
          setHistory(null);
          setFeedbackSnapshot(null);
          setInheritedSources(null);
        }
        return;
      }
      if (selectedTaskId === null) onSelectTask(targetTaskId);
      const [nextTask, nextHistory] = await Promise.all([
        service.getTask(targetTaskId),
        service.getHistory(targetTaskId),
      ]);
      if (requestVersion !== requestVersionRef.current) return;
      if (changeVersionRef.current === startedChangeVersion) {
        setTask(nextTask);
        setHistory(nextHistory);
      }
      if (nextTask) {
        try {
          const sources = await loadInheritedSources(service, nextTask);
          if (requestVersion === requestVersionRef.current) {
            setInheritedSources({ childTaskId: nextTask.id, sources });
          }
        } catch {
          if (requestVersion === requestVersionRef.current) {
            setInheritedSources({
              childTaskId: nextTask.id,
              sources: nextTask.forkedFrom
                ? [{ sourceTaskId: nextTask.forkedFrom.taskId, projection: null }]
                : [],
            });
          }
        }
      }
      // Historical conversation remains readable even if this workspace no longer exists.
      const nextEngines = await service.listEngines(
        nextTask?.environment.workDirectory
          ? { workspacePath: nextTask.environment.workDirectory }
          : undefined,
      );
      if (requestVersion !== requestVersionRef.current) return;
      setEngines(nextEngines);
      if (changeVersionRef.current === startedChangeVersion) {
        const refreshedTask = await service.getTask(targetTaskId);
        if (
          requestVersion === requestVersionRef.current &&
          changeVersionRef.current === startedChangeVersion
        ) {
          setTask(refreshedTask);
        }
      }
    } catch {
      if (requestVersion === requestVersionRef.current) {
        setEngines(null);
        setRefreshFailed(true);
        setNotice({ kind: "error", message: "刷新失败，请稍后重试。" });
      }
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }, [onSelectTask, selectedTaskId, service]);

  useEffect(() => {
    void refresh();
    return () => {
      requestVersionRef.current += 1;
    };
  }, [refresh, refreshVersion, revision]);

  useEffect(() => {
    const subscription = service.onDidChange((change) => {
      if (change.taskId !== selectedTaskId) return;
      changeVersionRef.current += 1;
      if (change.task) setTask(change.task);
      if (change.history) setHistory(change.history);
    });
    return () => subscription.dispose();
  }, [selectedTaskId, service]);

  useEffect(() => {
    if (selectedTaskId && task?.id !== selectedTaskId) {
      setTask(null);
      setHistory(null);
      setFeedbackSnapshot(null);
      setInheritedSources(null);
    }
  }, [selectedTaskId, task?.id]);

  const projection = useMemo(
    () => (task && task.id === selectedTaskId ? projectEngineConversation(task, history) : null),
    [task, history, selectedTaskId],
  );
  useLayoutEffect(() => {
    const element = conversationScrollRef.current;
    if (element && followConversationTailRef.current) {
      element.scrollTop = element.scrollHeight - element.clientHeight;
    }
  }, [projection]);
  const visibleTask = task?.id === selectedTaskId ? task : null;
  const visibleHistory = visibleTask ? history : null;
  const {
    contexts: webElementContexts,
    removeContext: removeWebElementContext,
    clearContexts: clearWebElementContexts,
  } = useWebElementContexts({
    workspacePath: visibleTask?.environment.workDirectory ?? "",
    listenAddToChatEvents:
      visibleTask?.engine.engineId === "zcode" && !!visibleTask.environment.workDirectory,
    scopeId: visibleTask?.id,
  });
  const visibleFeedback =
    visibleTask?.engine.engineId === "zcode" && feedbackSnapshot?.taskId === visibleTask.id
      ? feedbackSnapshot.read
      : null;
  const feedbackReadKey = visibleHistory
    ? [
        ...visibleHistory.executions
          .filter((execution) => isTerminal(execution.status))
          .map((execution) => execution.id),
        ...new Set(
          visibleHistory.events
            .filter(
              (event) =>
                event.type === "message.delta" &&
                visibleHistory.executions.some(
                  (execution) => execution.id === event.executionId && isTerminal(execution.status),
                ),
            )
            .map((event) => String(event.payload.messageId ?? "")),
        ),
      ].join("|")
    : "";
  useEffect(() => {
    if (!visibleTask || visibleTask.engine.engineId !== "zcode" || !visibleHistory) return;
    let cancelled = false;
    void service.getAssistantFeedback(visibleTask.id).then(
      (read) => {
        if (!cancelled) setFeedbackSnapshot({ taskId: visibleTask.id, read });
      },
      (error: unknown) => {
        if (!cancelled)
          setFeedbackSnapshot({
            taskId: visibleTask.id,
            read: { state: "unknown", reason: errorText(error) },
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [feedbackReadKey, revision, service, visibleTask?.id]);
  const visibleTitle = visibleTask
    ? parsePromptWebElementContexts(visibleHistory?.inputs[0]?.text ?? "", {
        workspacePath: visibleTask.environment.workDirectory ?? "",
      })
        .visibleContent.trim()
        .replace(/\s+/g, " ")
        .slice(0, 80) || `Task ${shortId(visibleTask.id)}`
    : "任务";
  useEffect(() => {
    if (visibleTask) onTitleChange?.(visibleTask.id, visibleTitle);
  }, [onTitleChange, visibleTask?.id, visibleTitle]);
  const queuedInputs = visibleHistory?.inputs.filter((input) => input.status === "queued") ?? [];
  const activeRound =
    visibleHistory?.inputs.some((input) =>
      ["received", "native-accepted", "started"].includes(input.status),
    ) ||
    visibleHistory?.executions.some((execution) =>
      ["accepted", "started"].includes(execution.status),
    );
  const unknownRound =
    visibleHistory?.inputs.some((input) => input.status === "unknown") ||
    visibleHistory?.executions.some((execution) => execution.status === "unknown");
  const hasPendingRound = activeRound || unknownRound || queuedInputs.length > 0;
  const shouldQueue = activeRound || queuedInputs.length > 0;
  const currentAttachments = visibleTask ? (attachmentsByTask[visibleTask.id] ?? []) : [];
  const runBlockedReason = visibleTask
    ? unknownRound
      ? "当前轮次的原生结果未知，无法安全发送或排队。"
      : currentTaskBlock(visibleTask, "execution.run", engines, refreshFailed)
    : "请选择或创建一个 Engine Task。";
  const submitBlockedReason =
    runBlockedReason ??
    (visibleTask?.forkedFrom &&
    visibleHistory?.inputs.length === 0 &&
    (inheritedSources?.childTaskId !== visibleTask.id ||
      !modelSelectionSchema.safeParse(
        inheritedSources.sources.at(-1)?.submissionConfig?.modelSelection,
      ).success)
      ? "无法核实分叉 Session 继承的模型配置。"
      : null) ??
    (shouldQueue && (currentAttachments.length > 0 || webElementContexts.length > 0)
      ? "当前轮次未结束，上下文不能安全排队；请等待后发送。"
      : null);
  const approvalBlockedReason = visibleTask
    ? currentTaskBlock(visibleTask, "approval.respond", engines, refreshFailed)
    : "当前 Task 不可用。";
  const userInputBlockedReason = visibleTask
    ? currentTaskBlock(visibleTask, "user-input.respond", engines, refreshFailed)
    : "当前 Task 不可用。";
  const stopBlockedReason = visibleTask
    ? currentTaskBlock(visibleTask, "execution.interrupt", engines, refreshFailed)
    : "当前 Task 不可用。";
  const forkBlockedReason = visibleTask
    ? currentTaskBlock(visibleTask, "session.fork", engines, refreshFailed)
    : "当前 Task 不可用。";
  const revisionBlockedReason = visibleTask
    ? hasPendingRound
      ? "当前轮次尚未结束，暂不能编辑历史输入。"
      : currentTaskBlock(visibleTask, "execution.revise", engines, refreshFailed)
    : "当前 Task 不可用。";
  const fileRewindBlockedReason = visibleTask
    ? hasPendingRound
      ? "当前轮次尚未结束，暂不能撤销历史文件变化。"
      : currentTaskBlock(visibleTask, "workspace.file-rewind", engines, refreshFailed)
    : "当前 Task 不可用。";
  const assistantFeedbackBlockedReason = visibleTask
    ? (currentTaskBlock(visibleTask, "assistant.feedback", engines, refreshFailed) ??
      (visibleTask.engine.engineId === "zcode" && visibleFeedback?.state !== "current"
        ? visibleFeedback?.state === "unknown"
          ? visibleFeedback.reason
          : "原生反馈状态尚未读取。"
        : null))
    : "当前 Task 不可用。";
  const currentEngine = visibleTask
    ? (engines?.find((engine) => engine.engineId === visibleTask.currentEngine.engineId) ?? null)
    : null;
  const isZCodeHarness = visibleTask?.engine.engineId === "zcode";
  const composerWorkspacePath = isZCodeHarness
    ? (visibleTask?.environment.workDirectory ?? "")
    : "";
  const promptHistoryWorkspacePath = visibleTask?.environment.workDirectory ?? "";
  const [promptHistory, setPromptHistory] = useState<readonly string[]>(() =>
    readPromptHistoryEntries(promptHistoryWorkspacePath),
  );
  const promptHistoryWorkspacePathRef = useRef(promptHistoryWorkspacePath);
  promptHistoryWorkspacePathRef.current = promptHistoryWorkspacePath;
  useEffect(() => {
    setPromptHistory(readPromptHistoryEntries(promptHistoryWorkspacePath));
  }, [promptHistoryWorkspacePath]);
  const nativeSessionId = isZCodeHarness ? (visibleTask?.session.nativeSessionId ?? null) : null;
  const nativeSlashCommands = useSlashCommands(composerWorkspacePath);
  const excludedSlashCommandNames = useMemo(
    () =>
      isZCodeHarness
        ? excludedNativeSlashCommandNames(nativeSlashCommands)
        : nativeSlashCommands.map((command) =>
            normalizeSlashCommandValue(command.name).toLowerCase(),
          ),
    [isZCodeHarness, nativeSlashCommands],
  );
  const modelView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const savedConfig = visibleHistory?.inputs.findLast(
    (input) =>
      input.status !== "rejected" && input.status !== "cancelled" && input.submissionConfig,
  )?.submissionConfig;
  const inheritedConfig =
    visibleTask?.forkedFrom && inheritedSources?.childTaskId === visibleTask.id
      ? inheritedSources.sources.at(-1)?.submissionConfig
      : undefined;
  const savedMode = typeof savedConfig?.mode === "string" ? savedConfig.mode : undefined;
  const inheritedMode =
    typeof inheritedConfig?.mode === "string" ? inheritedConfig.mode : undefined;
  const savedModelResult = modelSelectionSchema.safeParse(savedConfig?.modelSelection);
  const inheritedModelResult = modelSelectionSchema.safeParse(inheritedConfig?.modelSelection);
  const initialModelResult = modelSelectionSchema.safeParse(
    visibleHistory?.inputs.find(
      (input) => input.status !== "rejected" && input.submissionConfig?.modelSelection,
    )?.submissionConfig?.modelSelection,
  );
  const sessionProviderId = initialModelResult.success
    ? initialModelResult.data.providerId
    : inheritedModelResult.success
      ? inheritedModelResult.data.providerId
      : null;
  const activeConfig = visibleTask ? configByTask[visibleTask.id] : undefined;
  const selectedMode =
    activeConfig?.mode ??
    (savedConfig?.planEnabled === true || inheritedConfig?.planEnabled === true
      ? "plan"
      : (savedMode ?? inheritedMode ?? "build"));
  const selectedModel =
    activeConfig?.modelSelection ??
    (savedModelResult.success ? savedModelResult.data : null) ??
    (inheritedModelResult.success ? inheritedModelResult.data : null) ??
    (visibleHistory?.inputs.length === 0 && !visibleTask?.forkedFrom
      ? modelView?.preferredSelection
      : null) ??
    null;
  const zcodeSubmission =
    isZCodeHarness && modelView
      ? createComposerSubmissionConfig(
          {
            mode: selectedMode,
            planEnabled: selectedMode === "plan",
            modelSelection: selectedModel ?? undefined,
          },
          modelView,
        )
      : null;
  const planSlashCommands = useMemo<AppSlashCommand[]>(
    () =>
      isZCodeHarness
        ? [
            {
              value: "plan",
              description: locale === "zh-CN" ? "切换到计划模式" : "Switch to plan mode",
              keywords: ["plan", "计划", "计划模式"],
              run: () => {
                if (!visibleTask) return;
                if (runBlockedReason || busyAction) {
                  setNotice({ kind: "info", message: runBlockedReason ?? "当前暂不可操作。" });
                  return;
                }
                setConfigByTask((current) => ({
                  ...current,
                  [visibleTask.id]: { ...current[visibleTask.id], mode: "plan" },
                }));
                setNotice(null);
              },
            },
          ]
        : [],
    [busyAction, isZCodeHarness, locale, runBlockedReason, visibleTask],
  );
  const modeOption: ZCodeConfigOption = isZCodeHarness
    ? { ...engineModeUnavailableOption, currentValue: selectedMode }
    : engineModeUnavailableOption;
  const thoughtOption =
    isZCodeHarness && selectedModel
      ? resolveDraftModelThoughtOption(selectedModel.providerId, selectedModel.modelId, modelView)
      : null;
  const currentThoughtOption = thoughtOption
    ? { ...thoughtOption, currentValue: selectedModel?.options?.reasoningLevel ?? "" }
    : engineThoughtUnavailableOption;
  const modelGroups = useMemo<ModelSelectGroup[]>(() => {
    const harnessGroup: ModelSelectGroup = {
      key: "harness",
      label: "Harness",
      directItems: true,
      items: (engines ?? []).map((engine) => ({
        key: `harness:${engine.engineId}`,
        value: `harness:${engine.engineId}`,
        name: engine.engineId,
      })),
    };
    const providerGroups =
      modelSelectionRead.state.status === "ready"
        ? buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelSelectionRead.state.view)
        : [];
    const zcodeGroup =
      modelSelectionRead.state.status === "ready"
        ? buildZCodeHarnessModelGroup(modelSelectionRead.state.view)
        : null;
    return [harnessGroup, ...(zcodeGroup ? [zcodeGroup] : []), ...providerGroups];
  }, [engines, modelSelectionRead.state]);
  const latestExecution = visibleHistory?.executions.at(-1);
  const pendingStop = latestExecution
    ? visibleHistory?.stopRequests.find(
        (stop) =>
          stop.executionId === latestExecution.id &&
          (stop.status === "requested" || stop.status === "unknown"),
      )
    : undefined;

  const runAction = async <T,>(
    id: string,
    action: () => Promise<T>,
    summarize: (result: T) => string | null,
  ): Promise<boolean> => {
    setBusyAction(id);
    setNotice(null);
    try {
      const result = await action();
      const message = summarize(result);
      if (message) setNotice({ kind: "info", message });
      setRevision((version) => version + 1);
      return true;
    } catch (error) {
      setNotice({ kind: "error", message: errorText(error) });
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const submitInput = (text: string): boolean => {
    const cleanText = text.trim();
    if (!visibleTask || !cleanText) return false;
    const selectedAttachments = attachmentsByTask[visibleTask.id] ?? [];
    const selectedWebContexts = [...webElementContexts];
    const slashCommand = parseLeadingSlashCommand(cleanText);
    let submittedText = cleanText;
    let submission = zcodeSubmission;

    if (isZCodeHarness && slashCommand) {
      if (slashCommand.name === "compact") {
        if (slashCommand.args || selectedAttachments.length > 0) {
          setNotice({
            kind: "info",
            message: "/compact 是独立维护操作，不接受正文或附件；输入已保留。",
          });
          return false;
        }
        const compactBlockedReason = currentTaskBlock(
          visibleTask,
          "session.compact",
          engines,
          refreshFailed,
        );
        if (compactBlockedReason || hasPendingRound || busyAction) {
          setNotice({
            kind: "info",
            message:
              compactBlockedReason ??
              (hasPendingRound
                ? "当前 Session 尚有未完成的输入或队列，暂不能压缩。"
                : "当前操作尚未完成。"),
          });
          return false;
        }
        const editor = inputApiRef.current;
        void runAction(
          "compact",
          async () => {
            const operation = await service.compactSession({
              taskId: visibleTask.id,
              participantId: visibleTask.participant.id,
              sessionId: visibleTask.session.id,
              authorizationId: visibleTask.authorizationId,
            });
            if (operation.status === "failed" || operation.status === "cancelled")
              throw new Error(
                operation.reason ??
                  `上下文压缩${operation.status === "failed" ? "失败" : "已取消"}。`,
              );
            return operation;
          },
          (operation) =>
            operation.status === "completed"
              ? "上下文压缩已完成。"
              : operation.status === "skipped"
                ? "原生 Session 跳过了本次压缩。"
                : operation.status === "unknown"
                  ? "上下文压缩结果未知；不会自动重试。"
                  : "上下文压缩请求已记录，仍需等待原生结果。",
        ).then((accepted) => {
          if (accepted && inputApiRef.current === editor) editor?.clear();
        });
        return false;
      } else if (slashCommand.name === "plan") {
        if (selectedAttachments.length > 0) {
          setNotice({
            kind: "info",
            message: intl.formatMessage({ id: "chat.plan.attachmentsBlocked" }),
          });
          return false;
        }
        if (runBlockedReason || busyAction) return false;
        if (!slashCommand.args) {
          setConfigByTask((current) => ({
            ...current,
            [visibleTask.id]: { ...current[visibleTask.id], mode: "plan" },
          }));
          setNotice(null);
          // Empty /plan is a local mode shortcut. Returning true lets Lexical consume the command.
          return true;
        }
        submission = createComposerSubmissionConfig(
          {
            mode: "plan",
            planEnabled: true,
            modelSelection: selectedModel ?? undefined,
          },
          modelView,
        );
        if (!submission) {
          setNotice({
            kind: "info",
            message:
              locale === "zh-CN"
                ? "/plan 暂无可用模型配置；输入已保留。"
                : "/plan has no usable model configuration. Your draft is preserved.",
          });
          return false;
        }
        setConfigByTask((current) => ({
          ...current,
          [visibleTask.id]: { ...current[visibleTask.id], mode: "plan" },
        }));
        submittedText = slashCommand.args;
      } else if (slashCommand.name === "mode") {
        const requestedMode = engineModeUnavailableOptions.find(
          (option) => option.value.toLowerCase() === slashCommand.args.toLowerCase(),
        );
        if (selectedAttachments.length > 0) {
          setNotice({
            kind: "info",
            message:
              locale === "zh-CN"
                ? "/mode 是本地配置操作；请先移除附件，输入已保留。"
                : "/mode is a local setting. Remove attachments first; your draft is preserved.",
          });
          return false;
        }
        if (runBlockedReason || busyAction) return false;
        if (!requestedMode) {
          setNotice({
            kind: "info",
            message:
              locale === "zh-CN"
                ? "/mode 只接受当前可用的权限模式；输入已保留。"
                : "/mode only accepts an available permission mode. Your draft is preserved.",
          });
          return false;
        }
        setConfigByTask((current) => ({
          ...current,
          [visibleTask.id]: {
            ...current[visibleTask.id],
            mode: requestedMode.value,
          },
        }));
        setNotice(null);
        return true;
      } else {
        const nativeBuiltin = nativeBuiltinForSlashCommand(slashCommand.name, nativeSlashCommands);
        if (nativeBuiltin && !nativePromptBuiltinSlashCommands.has(nativeBuiltin)) {
          setNotice({
            kind: "info",
            message:
              locale === "zh-CN"
                ? `/${slashCommand.name} 是 ZCode 原生命令；当前 Harness 没有对应操作，输入已保留。`
                : `/${slashCommand.name} is a native ZCode command with no matching Harness operation. Your draft is preserved.`,
          });
          return false;
        }
      }
    }

    if (
      submitBlockedReason ||
      busyAction ||
      submitPendingRef.current ||
      (isZCodeHarness && !submission)
    )
      return false;
    if (selectedWebContexts.length > 0) {
      submittedText = buildPromptWithWebElementContexts(submittedText, selectedWebContexts);
    }
    const delivery = shouldQueue ? "queue" : "startNow";
    const configKey = JSON.stringify(submission ?? null);
    const queueKey = shouldQueue
      ? queuedSubmissionRef.current?.taskId === visibleTask.id &&
        queuedSubmissionRef.current.authorizationId === visibleTask.authorizationId &&
        queuedSubmissionRef.current.text === submittedText &&
        queuedSubmissionRef.current.config === configKey
        ? queuedSubmissionRef.current.key
        : globalThis.crypto.randomUUID()
      : null;
    if (queueKey)
      queuedSubmissionRef.current = {
        taskId: visibleTask.id,
        authorizationId: visibleTask.authorizationId,
        text: submittedText,
        config: configKey,
        key: queueKey,
      };
    const editor = inputApiRef.current;
    submitPendingRef.current = true;
    void runAction(
      "input",
      async () => {
        const attachments = await Promise.all(
          selectedAttachments.map((attachment) =>
            service.stageAttachment({
              taskId: visibleTask.id,
              participantId: visibleTask.participant.id,
              sessionId: visibleTask.session.id,
              authorizationId: visibleTask.authorizationId,
              ...attachment,
            }),
          ),
        );
        return service.submitInput({
          taskId: visibleTask.id,
          participantId: visibleTask.participant.id,
          sessionId: visibleTask.session.id,
          authorizationId: visibleTask.authorizationId,
          text: submittedText,
          delivery,
          ...(queueKey ? { idempotencyKey: queueKey } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(isZCodeHarness && submission
            ? {
                submissionConfig: {
                  mode: submission.mode,
                  planEnabled: submission.planEnabled,
                  modelSelection: {
                    providerId: submission.modelSelection.providerId,
                    modelId: submission.modelSelection.modelId,
                    ...(submission.modelSelection.options?.reasoningLevel
                      ? {
                          options: {
                            reasoningLevel: submission.modelSelection.options.reasoningLevel,
                          },
                        }
                      : {}),
                  },
                },
              }
            : {}),
        });
      },
      () => null,
    )
      .then((accepted) => {
        if (!accepted) return;
        if (queuedSubmissionRef.current?.key === queueKey) queuedSubmissionRef.current = null;
        try {
          const nextHistory = appendPromptHistoryEntry(
            readPromptHistoryEntries(promptHistoryWorkspacePath),
            cleanText,
          );
          persistPromptHistoryEntries(promptHistoryWorkspacePath, nextHistory);
          if (promptHistoryWorkspacePathRef.current === promptHistoryWorkspacePath)
            setPromptHistory(nextHistory);
        } catch {
          // History is optional; an unavailable browser store must not undo an accepted input.
        }
        if (inputApiRef.current === editor) editor?.clear();
        if (selectedAttachments.length > 0) {
          setAttachmentsByTask((current) => ({
            ...current,
            [visibleTask.id]: (current[visibleTask.id] ?? []).filter(
              (attachment) => !selectedAttachments.includes(attachment),
            ),
          }));
        }
        for (const context of selectedWebContexts) removeWebElementContext(context.id);
      })
      .finally(() => {
        submitPendingRef.current = false;
      });
    // Lexical keeps the draft until the Host accepts it; the button path uses the same rule.
    return false;
  };

  const replyApproval = (approvalId: string, optionId: string, feedback?: string) => {
    const approval = visibleHistory?.approvals.find((item) => item.id === approvalId);
    if (!visibleTask || !approval || approvalBlockedReason || busyAction) return;
    void runAction(
      `approval:${approval.id}`,
      () =>
        service.replyToApproval({
          taskId: visibleTask.id,
          participantId: approval.participantId,
          sessionId: approval.sessionId,
          authorizationId: visibleTask.authorizationId,
          approvalId: approval.id,
          optionId,
          ...(feedback === undefined ? {} : { feedback }),
        }),
      () => null,
    );
  };

  const replyUserInput = (requestId: string, response: EngineUserInputAnswer) => {
    const request = visibleHistory?.userInputs.find((item) => item.id === requestId);
    if (!visibleTask || !request || userInputBlockedReason || busyAction) return;
    void runAction(
      `user-input:${request.id}`,
      () =>
        service.replyToUserInput({
          taskId: visibleTask.id,
          participantId: request.participantId,
          sessionId: request.sessionId,
          authorizationId: visibleTask.authorizationId,
          requestId: request.id,
          response,
        }),
      () => null,
    );
  };

  const fileActionTarget = useMemo(
    () =>
      visibleTask
        ? {
            taskId: visibleTask.id,
            participantId: visibleTask.participant.id,
            sessionId: visibleTask.session.id,
            authorizationId: visibleTask.authorizationId,
          }
        : null,
    [
      visibleTask?.id,
      visibleTask?.participant.id,
      visibleTask?.session.id,
      visibleTask?.authorizationId,
    ],
  );
  const loadFileChanges = useCallback(
    (executionId: string) =>
      fileActionTarget
        ? service.getExecutionFileChanges({ ...fileActionTarget, executionId })
        : Promise.resolve(null),
    [fileActionTarget, service],
  );
  const previewFileRewind = useCallback(
    (executionId: string) => {
      if (!fileActionTarget) throw new Error("当前 Task 不可用。");
      return service.previewFileRewind({ ...fileActionTarget, executionId });
    },
    [fileActionTarget, service],
  );
  const applyFileRewind = useCallback(
    async (executionId: string, expectedPreview: EngineFileRewindPreview) => {
      if (!fileActionTarget) throw new Error("当前 Task 不可用。");
      setBusyAction(`file-rewind:${executionId}`);
      try {
        const result = await service.applyFileRewind({
          ...fileActionTarget,
          executionId,
          expectedPreview,
        });
        setRevision((value) => value + 1);
        if (result.status !== "applied")
          setNotice({
            kind: "error",
            message: result.reason ?? `文件撤销结果：${result.status}`,
          });
        return result;
      } finally {
        setBusyAction(null);
      }
    },
    [fileActionTarget, service],
  );

  const updateAssistantFeedback = (
    executionId: string,
    messageId: string,
    feedback: "like" | "dislike" | null,
  ): Promise<boolean> => {
    if (!visibleTask || assistantFeedbackBlockedReason || busyAction) return Promise.resolve(false);
    return runAction(
      `feedback:${executionId}:${messageId}`,
      async () => {
        const receipt = await service.setAssistantFeedback({
          taskId: visibleTask.id,
          participantId: visibleTask.participant.id,
          sessionId: visibleTask.session.id,
          authorizationId: visibleTask.authorizationId,
          executionId,
          messageId,
          feedback,
        });
        if (receipt.status !== "updated" && receipt.status !== "unchanged") {
          throw new Error(receipt.reason ?? `无法保存消息反馈：${receipt.status}`);
        }
        return receipt;
      },
      (receipt) => (receipt.status === "updated" ? "消息反馈已保存。" : null),
    );
  };

  const requestStop = (executionId: string) => {
    if (!visibleTask || stopBlockedReason || busyAction || pendingStop) return;
    void runAction(
      `stop:${executionId}`,
      () =>
        service.requestStop({
          taskId: visibleTask.id,
          participantId: visibleTask.participant.id,
          sessionId: visibleTask.session.id,
          authorizationId: visibleTask.authorizationId,
          executionId,
        }),
      () => "中断请求已提交，仍需等待实际停止证据。",
    );
  };

  const cancelQueuedInput = (inputId: string) => {
    if (!visibleTask || busyAction) return;
    void runAction(
      `queue:${inputId}`,
      () =>
        service.cancelQueuedInput({
          taskId: visibleTask.id,
          participantId: visibleTask.participant.id,
          sessionId: visibleTask.session.id,
          authorizationId: visibleTask.authorizationId,
          inputId,
        }),
      () => null,
    );
  };

  const forkExecution = (executionId: string) => {
    if (!visibleTask || forkBlockedReason || busyAction) return;
    void runAction(
      `fork:${executionId}`,
      () =>
        service.forkTask({
          taskId: visibleTask.id,
          participantId: visibleTask.participant.id,
          sessionId: visibleTask.session.id,
          authorizationId: visibleTask.authorizationId,
          executionId,
        }),
      (child) => {
        onSelectTask(child.id);
        return null;
      },
    );
  };

  const editExecution = async (
    executionId: string,
    text: string,
    retainedAttachmentIds: readonly string[],
    addedAttachments: readonly EngineLocalAttachment[],
  ): Promise<boolean> => {
    if (!visibleTask || revisionBlockedReason || busyAction || !text.trim()) return false;
    return runAction(
      `edit:${executionId}`,
      async () => {
        const attachments = await Promise.all(
          addedAttachments.map((attachment) =>
            service.stageAttachment({
              taskId: visibleTask.id,
              participantId: visibleTask.participant.id,
              sessionId: visibleTask.session.id,
              authorizationId: visibleTask.authorizationId,
              ...attachment,
            }),
          ),
        );
        return service.reviseTurn({
          taskId: visibleTask.id,
          participantId: visibleTask.participant.id,
          sessionId: visibleTask.session.id,
          authorizationId: visibleTask.authorizationId,
          sourceExecutionId: executionId,
          kind: "edit",
          text,
          retainedAttachmentIds,
          ...(attachments.length ? { attachments } : {}),
        });
      },
      () => null,
    );
  };

  const chooseLocalAttachments = useCallback(async (): Promise<EngineLocalAttachment[]> => {
    try {
      const selectedPaths = platform.selectFiles
        ? await platform.selectFiles()
        : await platform.selectFile().then((path) => (path ? [path] : []));
      const attachments = selectedPaths
        .filter((path) => path.trim().length > 0)
        .map((localPath) => {
          const fileName = basenameFromPath(localPath);
          return {
            localPath,
            fileName,
            mimeType: inferAttachmentMimeType(fileName),
            // The Host stats and validates the selected path while staging it.
            sizeBytes: 0,
          };
        });
      return attachments;
    } catch (error) {
      setNotice({ kind: "error", message: errorText(error) });
      return [];
    }
  }, [platform]);
  const openAttachmentPicker = useCallback(async () => {
    if (!visibleTask) return;
    const attachments = await chooseLocalAttachments();
    if (attachments.length === 0) return;
    setAttachmentsByTask((current) => ({
      ...current,
      [visibleTask.id]: [...(current[visibleTask.id] ?? []), ...attachments],
    }));
  }, [chooseLocalAttachments, visibleTask]);
  const attachmentAction = useMemo(
    () => ({
      label: intl.formatMessage({ id: "chat.composer.attachment" }),
      onSelect: () => void openAttachmentPicker(),
      testId: "engine-composer-attachment-action",
      menuItemTestId: "engine-composer-attachment-menu-item",
    }),
    [intl, openAttachmentPicker],
  );
  const removeAttachment = (index: number) => {
    if (!visibleTask) return;
    setAttachmentsByTask((current) => ({
      ...current,
      [visibleTask.id]: (current[visibleTask.id] ?? []).filter(
        (_, itemIndex) => itemIndex !== index,
      ),
    }));
  };

  return (
    <div
      className="@container/conversation flex h-full min-h-0 w-full flex-col bg-background text-foreground"
      data-testid="engine-conversation"
    >
      <div
        ref={conversationScrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4"
        data-testid="engine-conversation-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          followConversationTailRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        <div className={`mx-auto ${contentWidthClassName}`}>
          {visibleTask && projection ? (
            <EngineConversationTimeline
              projection={projection}
              inheritedSources={
                inheritedSources?.childTaskId === visibleTask.id
                  ? inheritedSources.sources
                  : visibleTask.forkedFrom
                    ? [{ sourceTaskId: visibleTask.forkedFrom.taskId, projection: null }]
                    : []
              }
              workspacePath={visibleTask.environment.workDirectory ?? ""}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              historyLoading={loading && !visibleHistory}
              approvalBlockedReason={approvalBlockedReason}
              userInputBlockedReason={userInputBlockedReason}
              busyAction={busyAction}
              onReplyApproval={replyApproval}
              onReplyUserInput={replyUserInput}
              assistantFeedbackBlockedReason={assistantFeedbackBlockedReason}
              assistantFeedback={
                visibleFeedback?.state === "current" ? visibleFeedback.values : undefined
              }
              onAssistantFeedback={updateAssistantFeedback}
              forkBlockedReason={forkBlockedReason}
              onForkExecution={forkExecution}
              revisionBlockedReason={revisionBlockedReason}
              onEditExecution={editExecution}
              fileRewindBlockedReason={fileRewindBlockedReason}
              onLoadFileChanges={isZCodeHarness ? loadFileChanges : undefined}
              onPreviewFileRewind={isZCodeHarness ? previewFileRewind : undefined}
              onApplyFileRewind={isZCodeHarness ? applyFileRewind : undefined}
              onPickEditAttachments={chooseLocalAttachments}
              conversationFindQuery={conversationFindQuery}
              conversationFindActiveIndex={conversationFindActiveIndex}
              conversationFindNavigationRequestId={conversationFindNavigationRequestId}
              onConversationFindMatchStateChange={onConversationFindMatchStateChange}
            />
          ) : (
            <div className="mx-auto grid h-full max-w-2xl place-items-center px-5 text-center">
              <div>
                <h2 className="font-semibold">{loading ? "正在读取对话…" : "开始新对话"}</h2>
                <p className="mt-2 text-sm text-foreground-subtle">
                  从左侧选择已有对话，或在下方发送消息。
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      {visibleTask ? (
        <Dialog open={inspectorOpen} onOpenChange={onInspectorOpenChange}>
          <DialogContent
            className="max-h-[85vh] max-w-4xl overflow-y-auto text-xs"
            data-testid="engine-diagnostic-inspector"
            aria-describedby={undefined}
          >
            <DialogHeader>
              <DialogTitle>Engine 诊断信息</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-3 md:grid-cols-2">
              <section>
                <h2 className="mb-2 font-semibold">历史创建快照</h2>
                <dl className="space-y-1 break-all">
                  <div>
                    <dt className="inline text-foreground-subtle">Task：</dt>
                    <dd className="inline">{visibleTask.id}</dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-subtle">Participant：</dt>
                    <dd className="inline">{visibleTask.participant.id}</dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-subtle">产品 Session：</dt>
                    <dd className="inline">{visibleTask.session.id}</dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-subtle">Engine Snapshot：</dt>
                    <dd className="inline">
                      {visibleTask.engine.engineId} · Adapter {visibleTask.engine.adapterVersion}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-subtle">配置版本：</dt>
                    <dd className="inline">{visibleTask.engine.configurationVersion ?? "未知"}</dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-subtle">环境快照：</dt>
                    <dd className="inline">{visibleTask.engine.environment ?? "未知"}</dd>
                  </div>
                  {visibleTask.closeReason ? (
                    <div>
                      <dt className="inline text-foreground-subtle">结束原因：</dt>
                      <dd className="inline">{visibleTask.closeReason}</dd>
                    </div>
                  ) : null}
                </dl>
              </section>
              <section>
                <h2 className="mb-2 font-semibold">当前 Engine 状态</h2>
                {currentEngine ? (
                  <EngineCapabilityList engine={currentEngine} compact />
                ) : (
                  <p>未知；刷新失败或 Engine 不在当前 Host。</p>
                )}
                <div className="mt-2 break-all text-foreground-subtle">
                  {currentEngine?.state === "current"
                    ? `观测来源：${currentEngine.source} · ${timeLabel(currentEngine.observedAt)}`
                    : "当前能力未知"}
                </div>
              </section>
            </div>
            <section className="border-t border-border pt-3">
              <h2 className="mb-2 font-semibold">
                原始 Engine 事件（只读） · {visibleHistory?.events.length ?? 0}
              </h2>
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {[...(visibleHistory?.events ?? [])]
                  .sort((a, b) => a.observedAt - b.observedAt)
                  .map((event) => (
                    <details key={event.id} className="rounded-md border border-border p-2">
                      <summary className="cursor-pointer">
                        {event.type} · {timeLabel(event.observedAt)} · Task {shortId(event.taskId)}{" "}
                        · Execution {event.executionId ? shortId(event.executionId) : "未知"}
                      </summary>
                      <pre className="mt-2 overflow-auto whitespace-pre-wrap">
                        {jsonLabel(event.payload)}
                      </pre>
                    </details>
                  ))}
              </div>
            </section>
          </DialogContent>
        </Dialog>
      ) : null}
      {visibleTask ? (
        <div className="shrink-0 px-4 pb-4">
          <div className={`mx-auto ${contentWidthClassName}`}>
            {submitBlockedReason ? (
              <p className="mb-2 text-xs text-warning">{submitBlockedReason}</p>
            ) : null}
            {isZCodeHarness && !runBlockedReason && !zcodeSubmission ? (
              <p className="mb-2 text-xs text-warning">请选择当前可用的模型与推理档位。</p>
            ) : null}
            {pendingStop ||
            (latestExecution && !isTerminal(latestExecution.status) && stopBlockedReason) ? (
              <p className="mb-2 text-xs text-warning">
                {pendingStop?.status === "unknown"
                  ? "中断结果未知"
                  : pendingStop
                    ? "等待停止确认"
                    : stopBlockedReason}
              </p>
            ) : null}
            <div className="chat-composer-region z-20 w-full shrink-0 @container/composer">
              <ConversationQueuePanel
                queue={{
                  items: queuedInputs.map((input) => ({
                    queueItemId: input.id,
                    kind: "sendText",
                    text: input.text,
                    dispatch: { state: "queued" },
                  })),
                  autoDrain: true,
                }}
                onDeleteItem={cancelQueuedInput}
              />
              <div className="chat-composer-input-surface w-full">
                <ChatPromptEditor
                  key={visibleTask.id}
                  className="p-0"
                  workspacePath={composerWorkspacePath}
                  taskId={nativeSessionId}
                  promptHistory={promptHistory}
                  inputApiRef={inputApiRef}
                  attachmentAction={attachmentAction}
                  actionMenuDisabled={!platform.canSelectFilePath || shouldQueue}
                  actionMenuDisabledReason={
                    shouldQueue
                      ? "附件不能排队；请等待当前轮次完成后发送。"
                      : intl.formatMessage({
                          id: platform.canSelectFilePath
                            ? "engine.composer.textOnly"
                            : "engine.composer.attachmentLocalPathRequired",
                        })
                  }
                  leadingActions={
                    <ConfigSelect
                      option={modeOption}
                      provider={ZCODE_AGENT_PROVIDER}
                      onValueChange={(mode) => {
                        if (!visibleTask || !isZCodeHarness) return;
                        if (!engineModeUnavailableOptions.some((option) => option.value === mode))
                          return;
                        setConfigByTask((current) => ({
                          ...current,
                          [visibleTask.id]: { ...current[visibleTask.id], mode },
                        }));
                      }}
                      disabled={
                        !isZCodeHarness ||
                        busyAction !== null ||
                        !!currentTaskBlock(visibleTask, "execution.run", engines, refreshFailed)
                      }
                      tooltipTitle={
                        isZCodeHarness
                          ? selectedMode
                          : intl.formatMessage({ id: "engine.composer.modeUnavailable" })
                      }
                      triggerVariant="ghost"
                      triggerSize="default"
                      triggerClassName="size-7 gap-1 rounded-lg p-0 text-ui-base @xl/composer:w-auto @xl/composer:px-2"
                      labelVisibilityClassName="hidden @xl/composer:inline-flex"
                      restoreFocusSelector={null}
                    />
                  }
                  trailingActions={
                    <>
                      <ModelConfigSelect
                        modelGroups={modelGroups}
                        normalizedValue={
                          isZCodeHarness && selectedModel
                            ? encodeHarnessZCodeModelValue(
                                encodeCustomModelValue(
                                  selectedModel.providerId,
                                  selectedModel.modelId,
                                ),
                              )
                            : `harness:${visibleTask.engine.engineId}`
                        }
                        triggerLabel={
                          isZCodeHarness && selectedModel
                            ? `Harness · zcode · ${selectedModel.modelId}`
                            : `Harness · ${visibleTask.engine.engineId}`
                        }
                        triggerLabelPrefix="Harness · "
                        triggerLabelValue={
                          isZCodeHarness && selectedModel
                            ? selectedModel.modelId
                            : visibleTask.engine.engineId
                        }
                        triggerLabelPrefixClassName="composer-provider-prefix hidden @2xl/composer:inline group-data-[composer-provider-compact=true]/toolbar:hidden"
                        showManageModelsAction={false}
                        lockReasonMessage="当前 Session 不支持切换 Harness 或 Provider。请新建对话后选择。"
                        isItemLocked={(candidate) => {
                          const encoded = decodeHarnessZCodeModelValue(candidate);
                          const decoded = encoded === null ? null : decodeCustomModelValue(encoded);
                          return (
                            !isZCodeHarness ||
                            !modelView ||
                            !decoded ||
                            ((visibleHistory?.inputs.length !== 0 || !!visibleTask.forkedFrom) &&
                              !sessionProviderId) ||
                            (sessionProviderId !== null &&
                              decoded.providerId !== sessionProviderId) ||
                            !!currentTaskBlock(visibleTask, "execution.run", engines, refreshFailed)
                          );
                        }}
                        onValueChange={(value) => {
                          const encodedModel = decodeHarnessZCodeModelValue(value);
                          const decoded =
                            encodedModel === null ? null : decodeCustomModelValue(encodedModel);
                          if (
                            !visibleTask ||
                            !isZCodeHarness ||
                            !modelView ||
                            !decoded?.modelName ||
                            ((visibleHistory?.inputs.length !== 0 || !!visibleTask.forkedFrom) &&
                              !sessionProviderId) ||
                            (sessionProviderId !== null && decoded.providerId !== sessionProviderId)
                          )
                            return;
                          const selected = completeNewModelSelection(modelView, {
                            providerId: decoded.providerId,
                            modelId: decoded.modelName,
                          });
                          if (!selected) return;
                          setConfigByTask((current) => ({
                            ...current,
                            [visibleTask.id]: {
                              ...current[visibleTask.id],
                              modelSelection: selected,
                            },
                          }));
                        }}
                        disabled={busyAction !== null}
                        tooltipTitle={`Harness · ${visibleTask.engine.engineId}`}
                        labelVisibilityClassName="hidden @sm/composer:inline-flex"
                        indicatorClassName="hidden @sm/composer:block group-data-[composer-model-icon=true]/toolbar:hidden"
                        triggerLabelClassName="hidden min-w-0 text-left @sm/composer:block group-data-[composer-model-icon=true]/toolbar:hidden [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate"
                        triggerClassName="composer-model-trigger max-w-[var(--composer-model-max-width,16rem)] group-data-[composer-model-icon=true]/toolbar:size-7 group-data-[composer-model-icon=true]/toolbar:p-0 group-data-[composer-model-icon=true]/toolbar:gap-0 group-data-[composer-model-icon=true]/toolbar:justify-center @max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:gap-0 @max-sm/composer:p-0"
                        triggerIconClassName="inline-flex @sm/composer:hidden group-data-[composer-model-icon=true]/toolbar:inline-flex"
                        focusSelectorOnClose='[data-testid="engine-composer-input"]'
                      />
                      <ConfigSelect
                        option={currentThoughtOption}
                        onValueChange={(reasoningLevel) => {
                          if (!visibleTask || !isZCodeHarness || !selectedModel || !thoughtOption)
                            return;
                          if (
                            !thoughtOption.options?.some(
                              (option) => option.value === reasoningLevel,
                            )
                          )
                            return;
                          setConfigByTask((current) => ({
                            ...current,
                            [visibleTask.id]: {
                              ...current[visibleTask.id],
                              modelSelection: {
                                providerId: selectedModel.providerId,
                                modelId: selectedModel.modelId,
                                options: { reasoningLevel },
                              },
                            },
                          }));
                        }}
                        disabled={
                          !isZCodeHarness ||
                          !thoughtOption ||
                          busyAction !== null ||
                          !!currentTaskBlock(visibleTask, "execution.run", engines, refreshFailed)
                        }
                        tooltipTitle={
                          isZCodeHarness
                            ? thoughtOption
                              ? (selectedModel?.options?.reasoningLevel ?? "请选择推理档位")
                              : "当前模型不支持推理档位。"
                            : intl.formatMessage({ id: "engine.composer.thoughtUnavailable" })
                        }
                        triggerVariant="ghost"
                        triggerSize="default"
                        leadingIcon={BrainIcon}
                        triggerClassName="gap-1 rounded-lg px-1.5 py-1.5 text-ui-base"
                        labelVisibilityClassName="hidden @xl/composer:inline-flex"
                        restoreFocusSelector={null}
                      />
                    </>
                  }
                  placeholder={intl.formatMessage({ id: "chat.placeholder.followUpAsk" })}
                  disabled={!!runBlockedReason || busyAction !== null}
                  disabledReason={runBlockedReason ?? undefined}
                  submitting={busyAction === "input"}
                  submitDisabled={
                    !!submitBlockedReason ||
                    busyAction !== null ||
                    (isZCodeHarness && !zcodeSubmission)
                  }
                  submitLabel={shouldQueue ? "加入队列" : "发送"}
                  topContent={
                    currentAttachments.length > 0 || webElementContexts.length > 0 ? (
                      <>
                        <WebElementContextAttachmentChip
                          contexts={webElementContexts}
                          onRemove={removeWebElementContext}
                          onRemoveAll={clearWebElementContexts}
                        />
                        {currentAttachments.length > 0 ? (
                          <Attachments
                            variant="inline"
                            className="flex max-w-full flex-wrap gap-2"
                            data-testid="engine-composer-attachments"
                          >
                            {currentAttachments.map((attachment, index) => (
                              <Attachment
                                key={`${attachment.localPath}:${index}`}
                                variant="inline"
                                data={{
                                  id: `${attachment.localPath}:${index}`,
                                  type: "file",
                                  filename: attachment.fileName,
                                  mediaType: attachment.mimeType,
                                  url: "",
                                }}
                                onRemove={() => removeAttachment(index)}
                                data-testid={`engine-composer-attachment-${index}`}
                              >
                                <AttachmentPreview />
                                <AttachmentInfo className="max-w-48 text-ui-base text-foreground" />
                                <AttachmentRemove
                                  alwaysVisible
                                  label={intl.formatMessage({ id: "chat.attachments.remove" })}
                                />
                              </Attachment>
                            ))}
                          </Attachments>
                        ) : null}
                      </>
                    ) : null
                  }
                  allowSubmitWhenEmpty={false}
                  cancelLabel="请求中断"
                  onCancel={
                    latestExecution &&
                    !isTerminal(latestExecution.status) &&
                    !stopBlockedReason &&
                    !pendingStop &&
                    busyAction === null
                      ? () => requestStop(latestExecution.id)
                      : undefined
                  }
                  showSlashButton={false}
                  excludedSlashCommandNames={excludedSlashCommandNames}
                  appSlashCommands={planSlashCommands}
                  enableMentionPanel={nativeSessionId !== null}
                  inputTestId="engine-composer-input"
                  submitTestId="engine-composer-submit"
                  onSubmit={submitInput}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
