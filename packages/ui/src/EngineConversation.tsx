/* oxlint-disable eslint(max-lines) -- 单个 Task 的刷新、资格投影、身份校验与正式消息界面共享同一选中状态。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BrainIcon } from "lucide-react";
import type { IAnyAgentService, TaskSkillReference } from "@zcode/services";
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
  capabilityBlockReason,
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
export interface EngineTaskComposerDraft {
  readonly text: string;
  readonly config?: { readonly mode?: string; readonly modelSelection?: ModelSelection };
  readonly editorStateJson?: string;
  readonly recoveryParts?: readonly {
    readonly version: number;
    readonly text: string;
  }[];
  readonly recoveryVersion: number;
}
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
const nativePromptBuiltinSlashCommands = new Set(["init"]);
const rendererMappedSlashCommands = new Set([
  "compact",
  "effort",
  "help",
  "locale",
  "mode",
  "model",
  "new",
  "plan",
  "skill",
  "variant",
]);
const unsupportedNativeSlashReasons = {
  login: {
    en: "M0 login starts a shared account and credential flow; the Task Composer has no Host-mediated account action.",
    zh: "M0 登录会启动共享账号与凭据流程；当前 Task Composer 没有经 Host 授权的账号操作。",
  },
  logout: {
    en: "M0 logout removes credentials shared across sessions; the Task Composer has no Host-mediated account action.",
    zh: "M0 退出登录会删除多个 Session 共用的凭据；当前 Task Composer 没有经 Host 授权的账号操作。",
  },
  expert: {
    en: "M0 manages durable Expert workflow runs; M1 exposes ordinary Task executions but no Task-scoped Expert workflow API.",
    zh: "M0 管理持久化 Expert 工作流；M1 目前只提供 Task 执行操作，没有 Task 级 Expert 工作流 API。",
  },
  dwf: {
    en: "M0 operates on the CLI dynamic-workflow run registry; M1 has no matching Task-scoped Host operation.",
    zh: "M0 操作 CLI 动态工作流运行记录；M1 没有对应的 Task 级 Host 操作。",
  },
  fork: {
    en: "M0 forks from a workspace checkpoint, while M1 forks from a selected product Execution; the source semantics do not match.",
    zh: "M0 从工作区检查点分叉，M1 从指定产品 Execution 分叉；两者的来源语义不一致。",
  },
  mcp: {
    en: "M0 manages CLI MCP server connections; M1 has no Task-scoped Host route for this CLI configuration.",
    zh: "M0 管理 CLI 的 MCP 服务连接；M1 没有对应的 Task 级 Host 路径来操作这份 CLI 配置。",
  },
  plugins: {
    en: "M0 changes CLI plugin configuration for future CLI sessions; that is not the product Plugin manager or a Task Host action.",
    zh: "M0 修改后续 CLI Session 使用的插件配置；这不等同于产品插件管理器，也没有对应的 Task Host 操作。",
  },
  resume: {
    en: "An M0 CLI Session id cannot safely identify and authorize a product Task, Participant, and Session.",
    zh: "M0 CLI Session ID 不能安全地映射并授权到产品 Task、Participant 和 Session。",
  },
  rewind: {
    en: "M0 restores workspace checkpoints; M1 only offers file rewind qualified to a specific product Execution.",
    zh: "M0 恢复工作区检查点；M1 只支持绑定到指定产品 Execution 的文件撤销。",
  },
  goal: {
    en: "M0 stores Session goal state and can trigger goal continuation; M1 has no matching Task-scoped Host/Runtime operation.",
    zh: "M0 保存 Session 目标并可触发目标续跑；M1 没有对应的 Task 级 Host/Runtime 操作。",
  },
} as const;

function parseLeadingSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  const rawName = match?.[1];
  if (!rawName) return null;
  const normalizedName = normalizeSlashCommandValue(rawName).toLowerCase();
  return {
    name: zcodeBuiltinSlashCommandByName.get(normalizedName) ?? normalizedName,
    args: match?.[2]?.trim() ?? "",
  };
}

function nativeBuiltinForSlashCommand(name: string): string | null {
  return zcodeBuiltinSlashCommandByName.get(name) ?? null;
}

function parseManualSkillArgs(args: string): { skillName: string; task: string } | null {
  const trimmed = args.trim();
  if (!trimmed) return null;
  const firstWhitespace = trimmed.search(/\s/u);
  if (firstWhitespace === -1) return { skillName: trimmed, task: "" };
  return {
    skillName: trimmed.slice(0, firstWhitespace),
    task: trimmed.slice(firstWhitespace + 1).trim(),
  };
}

/** Keep the fixed v0.16.9 CLI `/skill` rewrite before submitting through Host/Runtime. */
function buildManualSkillPrompt(skillName: string, task: string): string {
  const trimmedTask = task.trim();
  const taskBlock = trimmedTask
    ? `User request:\n${trimmedTask}`
    : "No additional user request was provided. Load the skill and respond according to its instructions.";
  return [
    `Use the skill named \`${skillName}\` for this turn.`,
    `First call the \`Skill\` tool with name \`${skillName}\` before doing the task.`,
    "After the skill content is loaded, follow its instructions and continue.",
    "",
    taskBlock,
  ].join("\n");
}

function formatSessionSkillCatalog(skills: readonly TaskSkillReference[]): string {
  if (skills.length === 0) return "No skills found.";
  const lines = [`Available skills (${skills.length})`];
  for (const skill of skills) {
    lines.push(`- ${skill.name} (${skill.scope}${skill.pluginName ? `/${skill.pluginName}` : ""})`);
    lines.push(`  ${skill.description}`);
  }
  lines.push("", "Use /skill <name> [task] to load one.");
  return lines.join("\n");
}

function excludedNativeSlashCommandNames(commands: readonly ZCodeSlashCommand[]): string[] {
  return commands
    .map((command) => normalizeSlashCommandValue(command.name).toLowerCase())
    .filter(
      (name) =>
        !nativePromptBuiltinSlashCommands.has(name) && !rendererMappedSlashCommands.has(name),
    );
}

function formatEngineSlashHelp(
  args: string,
  commands: readonly ZCodeSlashCommand[],
  locale: string,
): string {
  const requestedName = normalizeSlashCommandValue(args.trim()).toLowerCase();
  if (requestedName) {
    const entry = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find(
      (candidate) => candidate.name === requestedName || candidate.aliases?.includes(requestedName),
    );
    if (entry) {
      const isMapped =
        rendererMappedSlashCommands.has(entry.name) ||
        nativePromptBuiltinSlashCommands.has(entry.name);
      return [
        `${entry.usage} — ${entry.summary}`,
        ...entry.details,
        ...(entry.name === "compact" ? ["M1 Engine 通过 Host 支持可选 instructions。"] : []),
        ...(entry.name === "locale"
          ? ["M1 通过产品全局 UI 语言偏好支持 auto、en-US 和 zh-CN。"]
          : []),
        ...(!isMapped
          ? [
              unsupportedNativeSlashReasons[
                entry.name as keyof typeof unsupportedNativeSlashReasons
              ]?.[locale === "zh-CN" ? "zh" : "en"] ??
                "此原生命令当前没有对应的 Task 级 Host 操作。",
            ]
          : []),
      ].join("\n");
    }
    const custom = commands.find(
      (command) => normalizeSlashCommandValue(command.name).toLowerCase() === requestedName,
    );
    if (custom) {
      return [
        custom.inputHint?.trim() || `/${custom.name}`,
        custom.description,
        "M1 Engine 对话暂不执行 ZCode CLI 自定义命令；输入会保留。",
      ].join("\n");
    }
    return `未找到固定 ZCode v0.16.9 命令 /${requestedName}。输入已保留。`;
  }

  const supportedNames = new Set([
    ...rendererMappedSlashCommands,
    ...nativePromptBuiltinSlashCommands,
  ]);
  const unsupportedBuiltins = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.filter(
    (entry) => !supportedNames.has(entry.name),
  ).map((entry) => `/${entry.name}`);
  const customNames = commands
    .filter((command) => command.source === "custom")
    .map((command) => `/${normalizeSlashCommandValue(command.name)}`);
  const supportedCommands = [...supportedNames].map((name) => `/${name}`);
  return [
    `M1 Engine 对话支持：${supportedCommands.join("、")}。`,
    `固定 CLI 命令暂不支持：${unsupportedBuiltins.join("、")}。`,
    ...(customNames.length > 0
      ? [`ZCode CLI 自定义命令暂不支持：${customNames.join("、")}。`]
      : []),
    "输入 /help <命令> 查看说明。",
  ].join("\n");
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
  composerDraft,
  onRecoveredDraftChange,
  onRecoveredConfigChange,
  draftStorageIssue,
  onRecoveredSubmitPrepare,
  onComposerDraftSubmitted,
  onRecoveredSubmitUncertain,
  onResolveRecoveredReview,
  onQueueEditPrepare,
  onQueueDraftRecovered,
  onQueueRecoveryReconcile,
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
  composerDraft?: EngineTaskComposerDraft;
  onRecoveredDraftChange?: (
    taskId: string,
    text: string,
    editorStateJson?: string,
  ) => string | void;
  onRecoveredConfigChange?: (
    taskId: string,
    config: NonNullable<EngineTaskComposerDraft["config"]>,
  ) => void;
  draftStorageIssue?: "storage-failed" | "review-required";
  onRecoveredSubmitPrepare?: (
    taskId: string,
    submittedText: string,
    submissionConfig?: NonNullable<EngineTaskComposerDraft["config"]>,
    hasCancelledQueueInput?: boolean,
  ) => boolean;
  onComposerDraftSubmitted?: (taskId: string, submittedText: string) => boolean;
  onRecoveredSubmitUncertain?: (taskId: string) => void;
  onResolveRecoveredReview?: (taskId: string, action: "restore" | "discard") => boolean;
  onQueueEditPrepare?: (
    taskId: string,
    inputId: string,
    recovered: Pick<EngineTaskComposerDraft, "text" | "config">,
  ) => boolean;
  onQueueDraftRecovered?: (taskId: string, inputId: string) => boolean;
  onQueueRecoveryReconcile?: (
    taskId: string,
    inputs: readonly { readonly id: string; readonly status: string }[],
  ) => void;
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
  const [pendingEditQueueItemId, setPendingEditQueueItemId] = useState<string | null>(null);
  const [restoreErrors, setRestoreErrors] = useState<Record<string, string>>({});
  const [reconcileErrors, setReconcileErrors] = useState<Record<string, string>>({});
  const lifecycleActionsRef = useRef(new Set<string>());
  const setNotice = (notice: Notice | null) => {
    if (notice) toast(notice.message, { variant: notice.kind === "error" ? "warning" : "info" });
  };
  const [attachmentsByTask, setAttachmentsByTask] = useState<
    Record<string, EngineComposerAttachment[]>
  >({});
  const [configByTask, setConfigByTask] = useState<
    Record<string, { mode?: string; modelSelection?: ModelSelection }>
  >({});
  const [modePickerOpen, setModePickerOpen] = useState(false);
  const [thoughtPickerOpen, setThoughtPickerOpen] = useState(false);
  const [modelPickerRequestKey, setModelPickerRequestKey] = useState(0);
  const [revision, setRevision] = useState(0);
  const requestVersionRef = useRef(0);
  const changeVersionRef = useRef(0);
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const appliedQueueRecoveryVersion = useRef(0);
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
  const selectedTaskIdRef = useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;
  const { intl, locale, localePreference, setLocalePreference } = useZCodeIntl();
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
  }, [feedbackReadKey, revision, service, visibleTask?.id, visibleTask?.session.status]);
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
  const queuePaused = visibleTask?.session.queuePaused === true;
  queuedInputs.sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
  useEffect(() => {
    if (visibleTask && visibleHistory)
      onQueueRecoveryReconcile?.(visibleTask.id, visibleHistory.inputs);
  }, [onQueueRecoveryReconcile, visibleHistory, visibleTask?.id]);
  useEffect(() => {
    if (
      !visibleTask ||
      !composerDraft ||
      composerDraft.recoveryVersion <= appliedQueueRecoveryVersion.current
    )
      return;
    const editor = inputApiRef.current;
    if (!editor) return;
    const pendingText = composerDraft.recoveryParts
      ?.filter((part) => part.version > appliedQueueRecoveryVersion.current)
      .map((part) => part.text)
      .join("\n\n");
    appliedQueueRecoveryVersion.current = composerDraft.recoveryVersion;
    if (editor.getText().trim() && pendingText) {
      editor.appendText(`\n\n${pendingText}`);
    } else if (composerDraft.editorStateJson) {
      try {
        editor.setEditorStateJson(composerDraft.editorStateJson);
      } catch {
        editor.setText(composerDraft.text);
      }
    } else if (editor.getText() !== composerDraft.text) {
      editor.setText(composerDraft.text);
    }
    if (composerDraft.config)
      setConfigByTask((current) => ({
        ...current,
        [visibleTask.id]: composerDraft.config!,
      }));
    editor.focus();
  }, [composerDraft?.recoveryVersion, visibleTask?.id]);
  useEffect(() => {
    if (!visibleTask) return;
    const config = configByTask[visibleTask.id];
    if (config) onRecoveredConfigChange?.(visibleTask.id, config);
  }, [configByTask, onRecoveredConfigChange, visibleTask?.id]);
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
  const unknownExecutions =
    visibleHistory?.executions.filter((execution) => execution.status === "unknown") ?? [];
  const hasPendingRound = activeRound || unknownRound || queuedInputs.length > 0;
  const shouldQueue = activeRound || queuedInputs.length > 0;
  const hasUnresolvedMaintenance =
    visibleHistory?.compactOperations?.some((operation) =>
      ["requested", "accepted", "unknown"].includes(operation.status),
    ) === true ||
    visibleHistory?.fileRewindOperations?.some((operation) =>
      ["requested", "unknown"].includes(operation.status),
    ) === true;
  const sessionRestoreBlockedReason = unknownRound
    ? unknownExecutions.length > 0
      ? "请先对账结果未知的原执行；对账不会重发原输入。"
      : "原生输入结果未知，尚无可对账的执行；请先核实原生状态。"
    : activeRound || (queuedInputs.length > 0 && !queuePaused)
      ? "Session 仍有未完成的输入或执行，完成对账后才能恢复继续。"
      : hasUnresolvedMaintenance
        ? "Session 仍有未决的压缩或文件撤销操作，核实后才能恢复。"
        : null;
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
  const activeNativeSessionId = visibleTask?.session.status === "active" ? nativeSessionId : null;
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
  const mappedSlashCommands = useMemo<AppSlashCommand[]>(() => {
    if (!isZCodeHarness) return [];
    const openModePicker = () => {
      if (runBlockedReason || busyAction) {
        setNotice({ kind: "info", message: runBlockedReason ?? "当前暂不可操作。" });
        return;
      }
      setModePickerOpen(true);
    };
    const openModelPicker = () => {
      if (runBlockedReason || busyAction) {
        setNotice({ kind: "info", message: runBlockedReason ?? "当前暂不可操作。" });
        return;
      }
      if (!modelView) {
        setNotice({ kind: "info", message: "当前模型目录尚未就绪。" });
        return;
      }
      setModelPickerRequestKey((current) => current + 1);
    };
    const openThoughtPicker = () => {
      if (runBlockedReason || busyAction) {
        setNotice({ kind: "info", message: runBlockedReason ?? "当前暂不可操作。" });
        return;
      }
      if (!thoughtOption) {
        setNotice({ kind: "info", message: "当前模型没有可用的推理档位。" });
        return;
      }
      setThoughtPickerOpen(true);
    };
    const uiCommands: AppSlashCommand[] = [
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
        },
      },
      {
        value: "mode",
        description: "查看或切换权限模式",
        keywords: [
          "mode",
          "权限",
          "模式",
          ...engineModeUnavailableOptions.map((item) => item.value),
        ],
        run: openModePicker,
      },
      {
        value: "model",
        description: "查看或切换当前 Provider 的模型",
        keywords: ["model", "模型", "provider"],
        run: openModelPicker,
      },
      {
        value: "new",
        description:
          locale === "zh-CN"
            ? "在当前工作区开始新对话"
            : "Start a new conversation in this workspace",
        keywords: ["new", "clear", "新对话", "清空"],
        run: () => inputApiRef.current?.setText("/new "),
      },
      {
        value: "locale",
        description: locale === "zh-CN" ? "查看或切换界面语言" : "Show or switch the UI locale",
        keywords: ["locale", "language", "语言"],
        run: () => inputApiRef.current?.setText("/locale "),
      },
      {
        value: "effort",
        description: "查看或切换当前模型的推理档位",
        keywords: ["effort", "推理", "档位"],
        run: openThoughtPicker,
      },
      {
        value: "variant",
        description: "查看或切换当前模型的推理档位",
        keywords: ["variant", "effort", "推理", "档位"],
        run: openThoughtPicker,
      },
      {
        value: "help",
        description: "查看当前 Harness 命令帮助",
        keywords: ["help", "帮助", "命令"],
        run: () =>
          toast(formatEngineSlashHelp("", nativeSlashCommands, locale), { variant: "info" }),
      },
    ];
    return uiCommands;
  }, [
    busyAction,
    isZCodeHarness,
    locale,
    modelView,
    nativeSlashCommands,
    runBlockedReason,
    thoughtOption,
    visibleTask,
  ]);
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

  const restoreUnknownSession = (): void => {
    const target = visibleTask;
    if (
      !target ||
      target.session.status !== "unknown" ||
      target.status !== "active" ||
      !target.session.nativeSessionId ||
      sessionRestoreBlockedReason ||
      busyAction
    )
      return;
    const actionKey = `restore:${target.id}`;
    if (lifecycleActionsRef.current.has(actionKey)) return;
    lifecycleActionsRef.current.add(actionKey);
    setRestoreErrors((current) => {
      const next = { ...current };
      delete next[target.id];
      return next;
    });
    setBusyAction(actionKey);
    setNotice(null);
    const requestVersion = requestVersionRef.current;
    void (async () => {
      try {
        const identity = {
          taskId: target.id,
          participantId: target.participant.id,
          sessionId: target.session.id,
          authorizationId: target.authorizationId,
        };
        const restored = await service.restoreTaskSession(identity);
        if (
          restored.id !== target.id ||
          restored.status !== "active" ||
          restored.participant.id !== target.participant.id ||
          restored.session.id !== target.session.id ||
          restored.session.nativeSessionId !== target.session.nativeSessionId
        )
          throw new Error("Host 恢复结果的 Task、Participant 或 Session 身份不匹配。");
        const [freshTask, freshHistory] = await Promise.all([
          service.getTask(target.id),
          service.getHistory(target.id),
        ]);
        if (
          !freshTask ||
          !freshHistory ||
          freshHistory.taskId !== target.id ||
          freshTask.id !== target.id ||
          freshTask.participant.id !== target.participant.id ||
          freshTask.session.id !== target.session.id ||
          freshTask.session.nativeSessionId !== target.session.nativeSessionId
        )
          throw new Error("恢复后读取的 Task、Participant、Session 或历史身份不匹配。");
        if (requestVersion === requestVersionRef.current && selectedTaskId === target.id) {
          setTask(freshTask);
          setHistory(freshHistory);
        }
      } catch (error) {
        const message = errorText(error);
        setRestoreErrors((current) => ({ ...current, [target.id]: message }));
        setNotice({ kind: "error", message });
      } finally {
        lifecycleActionsRef.current.delete(actionKey);
        setBusyAction(null);
      }
    })();
  };

  const reconcileUnknownExecution = (executionId: string): void => {
    const target = visibleTask;
    const execution = visibleHistory?.executions.find((item) => item.id === executionId);
    if (
      !target ||
      !execution ||
      execution.status !== "unknown" ||
      execution.taskId !== target.id ||
      execution.participantId !== target.participant.id ||
      execution.sessionId !== target.session.id ||
      busyAction
    )
      return;
    const actionKey = `reconcile:${executionId}`;
    if (lifecycleActionsRef.current.has(actionKey)) return;
    lifecycleActionsRef.current.add(actionKey);
    setReconcileErrors((current) => {
      const next = { ...current };
      delete next[executionId];
      return next;
    });
    setBusyAction(actionKey);
    setNotice(null);
    const requestVersion = requestVersionRef.current;
    void (async () => {
      try {
        const identity = {
          taskId: target.id,
          participantId: target.participant.id,
          sessionId: target.session.id,
          authorizationId: target.authorizationId,
        };
        const result = await service.reconcileExecution({ ...identity, executionId });
        if (
          result.id !== executionId ||
          result.taskId !== target.id ||
          result.participantId !== target.participant.id ||
          result.sessionId !== target.session.id
        )
          throw new Error("Host 对账结果的 Execution 归属不匹配。");
        const [freshTask, freshHistory] = await Promise.all([
          service.getTask(target.id),
          service.getHistory(target.id),
        ]);
        if (
          !freshTask ||
          !freshHistory ||
          freshHistory.taskId !== target.id ||
          freshTask.id !== target.id ||
          freshTask.participant.id !== target.participant.id ||
          freshTask.session.id !== target.session.id
        )
          throw new Error("对账后读取的 Task、Participant、Session 或历史身份不匹配。");
        if (requestVersion === requestVersionRef.current && selectedTaskId === target.id) {
          setTask(freshTask);
          setHistory(freshHistory);
        }
      } catch (error) {
        const message = errorText(error);
        setReconcileErrors((current) => ({ ...current, [executionId]: message }));
        setNotice({ kind: "error", message });
      } finally {
        lifecycleActionsRef.current.delete(actionKey);
        setBusyAction(null);
      }
    })();
  };

  const importSharedContext = async (request: {
    shareCode: string;
    clientRequestId: string;
  }): Promise<boolean> => {
    const target = visibleTask;
    if (
      !target ||
      target.engine.engineId !== "zcode" ||
      target.id !== selectedTaskIdRef.current ||
      busyAction
    )
      return false;
    const workspacePath = target.environment.workDirectory;
    if (!workspacePath) {
      setNotice({ kind: "error", message: "共享上下文导入需要当前 Task 的本地工作区。" });
      return false;
    }

    const importedTaskRef: {
      current: Awaited<ReturnType<IAnyAgentService["importSharedContext"]>> | null;
    } = { current: null };
    const accepted = await runAction(
      "import-shared-context",
      async () => {
        const imported = await service.importSharedContext({
          ...request,
          workspacePath,
          locale,
        });
        if (
          imported.id === target.id ||
          imported.status !== "active" ||
          imported.engine.engineId !== "zcode" ||
          imported.environment.id !== target.environment.id ||
          imported.environment.workDirectory !== workspacePath ||
          imported.participant.id === target.participant.id ||
          imported.participant.status !== "active" ||
          imported.session.id === target.session.id ||
          imported.session.nativeSessionId === target.session.nativeSessionId ||
          imported.session.status !== "active" ||
          !imported.session.nativeSessionId ||
          !imported.sharedContext?.contextId.trim() ||
          !imported.sharedContext.title.trim() ||
          !imported.sharedContext.shareUrl.trim()
        )
          throw new Error("Host 返回的共享上下文 Task 身份或来源校验不完整。");
        importedTaskRef.current = imported;
        return imported;
      },
      () => "共享上下文已导入。",
    );
    const importedTask = importedTaskRef.current;
    if (!accepted || !importedTask) return false;
    if (selectedTaskIdRef.current === target.id) onSelectTask(importedTask.id);
    return true;
  };

  const submitInput = (text: string): boolean => {
    const cleanText = text.trim();
    if (!visibleTask || !cleanText) return false;
    const selectedAttachments = attachmentsByTask[visibleTask.id] ?? [];
    const selectedWebContexts = [...webElementContexts];
    const slashCommand = parseLeadingSlashCommand(cleanText);
    let submittedText = cleanText;
    let submission = zcodeSubmission;
    let submitActionId = "input";
    let submitPreflight: (() => Promise<void>) | null = null;
    let submitSuccessMessage: (() => string | null) | null = null;

    if (isZCodeHarness && slashCommand) {
      if (slashCommand.name === "compact") {
        if (selectedAttachments.length > 0 || selectedWebContexts.length > 0) {
          setNotice({
            kind: "info",
            message: "/compact 不接受附件或网页上下文；输入已保留。",
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
              ...(slashCommand.args ? { instructions: slashCommand.args } : {}),
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
      } else if (slashCommand.name === "new") {
        if (slashCommand.args) {
          setNotice({ kind: "info", message: "/new 不接受参数；输入已保留。" });
          return false;
        }
        if (selectedAttachments.length > 0 || selectedWebContexts.length > 0) {
          setNotice({ kind: "info", message: "/new 不接受附件或网页上下文；输入已保留。" });
          return false;
        }
        const createEngine = engines?.find(
          (engine) => engine.engineId === visibleTask.engine.engineId,
        );
        const createBlockedReason =
          refreshFailed || engines === null
            ? "暂时无法确认新对话是否可创建，请刷新状态。"
            : !createEngine || createEngine.state !== "current"
              ? "暂时无法确认新对话是否可创建，请刷新状态。"
              : capabilityBlockReason(createEngine.capabilities["session.create"]);
        if (createBlockedReason || busyAction) {
          setNotice({
            kind: "info",
            message: createBlockedReason ?? "当前操作尚未完成。",
          });
          return false;
        }
        const workspacePath = visibleTask.environment.workDirectory;
        if (!workspacePath) {
          setNotice({ kind: "info", message: "/new 需要已确认的本地工作区；输入已保留。" });
          return false;
        }
        void runAction(
          "new",
          async () => {
            const created = await service.createTask({
              engineId: visibleTask.engine.engineId,
              workspacePath,
            });
            if (
              created.id === visibleTask.id ||
              created.engine.engineId !== visibleTask.engine.engineId ||
              created.environment.id !== visibleTask.environment.id ||
              created.participant.id === visibleTask.participant.id ||
              created.participant.status !== "active" ||
              created.session.status !== "active" ||
              created.session.id === visibleTask.session.id ||
              created.session.nativeSessionId === visibleTask.session.nativeSessionId
            )
              throw new Error("Host 新建对话结果的 Task、Participant 或 Session 身份不匹配。");
            const editor = inputApiRef.current;
            if (editor) editor.clear();
            onSelectTask(created.id);
            return created;
          },
          () => null,
        );
        return false;
      } else if (slashCommand.name === "plan") {
        if (selectedAttachments.length > 0 || selectedWebContexts.length > 0) {
          setNotice({
            kind: "info",
            message:
              locale === "zh-CN"
                ? "/plan 目前只接受纯文本；请先移除附件或上下文，输入已保留。"
                : "/plan currently accepts text only. Remove attachments or context; your draft is preserved.",
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
      } else if (slashCommand.name === "help") {
        toast(formatEngineSlashHelp(slashCommand.args, nativeSlashCommands, locale), {
          variant: "info",
        });
        return true;
      } else if (slashCommand.name === "locale") {
        const requestedLocale = slashCommand.args.trim();
        if (!requestedLocale || requestedLocale === "status" || requestedLocale === "list") {
          const preference = localePreference === "system" ? "auto" : localePreference;
          setNotice({
            kind: "info",
            message:
              locale === "zh-CN"
                ? `当前界面语言：${locale}（偏好：${preference}）。可选：auto、en-US、zh-CN。`
                : `Current UI locale: ${locale} (preference: ${preference}). Available: auto, en-US, zh-CN.`,
          });
          return true;
        }
        const preference =
          requestedLocale === "auto"
            ? "system"
            : requestedLocale === "en-US" || requestedLocale === "zh-CN"
              ? requestedLocale
              : null;
        if (!preference) {
          setNotice({
            kind: "info",
            message:
              locale === "zh-CN"
                ? `不支持界面语言 ${requestedLocale}；可选：auto、en-US、zh-CN。输入已保留。`
                : `Unsupported UI locale ${requestedLocale}; choose auto, en-US, or zh-CN. Your draft is preserved.`,
          });
          return false;
        }
        setLocalePreference(preference);
        const messageLocale = preference === "system" ? locale : preference;
        setNotice({
          kind: "info",
          message:
            messageLocale === "zh-CN"
              ? `界面语言偏好已切换为 ${requestedLocale}。`
              : `UI locale preference switched to ${requestedLocale}.`,
        });
        return true;
      } else if (slashCommand.name === "model") {
        if (runBlockedReason || busyAction) {
          setNotice({ kind: "info", message: runBlockedReason ?? "当前暂不可操作。" });
          return false;
        }
        const requestedModel = slashCommand.args.trim();
        if (!requestedModel || requestedModel.toLowerCase() === "list") {
          if (!modelView) {
            setNotice({ kind: "info", message: "当前模型目录尚未就绪；输入已保留。" });
            return false;
          }
          setModelPickerRequestKey((current) => current + 1);
          return true;
        }
        const providerSeparator = requestedModel.indexOf("/");
        if (providerSeparator <= 0 || providerSeparator === requestedModel.length - 1) {
          setNotice({
            kind: "info",
            message: "/model 需要 provider/model；输入已保留。",
          });
          return false;
        }
        const providerId = requestedModel.slice(0, providerSeparator);
        const modelId = requestedModel.slice(providerSeparator + 1);
        const sessionHasProviderConstraint =
          visibleHistory?.inputs.length !== 0 || !!visibleTask.forkedFrom;
        if (
          !modelView ||
          (sessionHasProviderConstraint && !sessionProviderId) ||
          (sessionProviderId !== null && providerId !== sessionProviderId)
        ) {
          setNotice({
            kind: "info",
            message:
              "当前 Session 只允许选择同一 Provider 的模型；跨 Provider 切换请新建对话。输入已保留。",
          });
          return false;
        }
        const selection = completeNewModelSelection(modelView, { providerId, modelId });
        if (!selection) {
          setNotice({
            kind: "info",
            message: `模型 ${requestedModel} 不在当前 Provider 配置中；输入已保留。`,
          });
          return false;
        }
        setConfigByTask((current) => ({
          ...current,
          [visibleTask.id]: { ...current[visibleTask.id], modelSelection: selection },
        }));
        return true;
      } else if (slashCommand.name === "effort" || slashCommand.name === "variant") {
        if (runBlockedReason || busyAction) {
          setNotice({ kind: "info", message: runBlockedReason ?? "当前暂不可操作。" });
          return false;
        }
        if (!thoughtOption || !selectedModel) {
          setNotice({ kind: "info", message: "当前模型没有可用的推理档位；输入已保留。" });
          return false;
        }
        const requestedEffort = slashCommand.args.trim();
        if (!requestedEffort || requestedEffort.toLowerCase() === "list") {
          setThoughtPickerOpen(true);
          return true;
        }
        const effort = thoughtOption.options?.find(
          (option) => option.value.toLowerCase() === requestedEffort.toLowerCase(),
        );
        if (!effort) {
          setNotice({
            kind: "info",
            message: `当前模型不支持推理档位 ${requestedEffort}；输入已保留。`,
          });
          return false;
        }
        setConfigByTask((current) => ({
          ...current,
          [visibleTask.id]: {
            ...current[visibleTask.id],
            modelSelection: {
              providerId: selectedModel.providerId,
              modelId: selectedModel.modelId,
              options: { reasoningLevel: effort.value },
            },
          },
        }));
        return true;
      } else if (slashCommand.name === "mode") {
        const requestedMode = engineModeUnavailableOptions.find(
          (option) => option.value.toLowerCase() === slashCommand.args.toLowerCase(),
        );
        if (selectedAttachments.length > 0 || selectedWebContexts.length > 0) {
          setNotice({
            kind: "info",
            message:
              locale === "zh-CN"
                ? "/mode 是本地配置操作；请先移除附件或上下文，输入已保留。"
                : "/mode is a local setting. Remove attachments or context; your draft is preserved.",
          });
          return false;
        }
        if (runBlockedReason || busyAction) return false;
        if (!slashCommand.args || slashCommand.args.toLowerCase() === "list") {
          setModePickerOpen(true);
          return true;
        }
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
      } else if (slashCommand.name === "skill") {
        const target = visibleTask;
        if (target.session.status !== "active" || target.status !== "active") {
          setNotice({
            kind: "info",
            message: "/skill 需要当前 Task 有可用的 Session；输入已保留。",
          });
          return false;
        }
        if (busyAction || submitPendingRef.current) {
          setNotice({ kind: "info", message: "当前操作尚未完成；输入已保留。" });
          return false;
        }
        const editor = inputApiRef.current;
        const readSessionCatalog = async () => {
          if (selectedTaskIdRef.current !== target.id)
            throw new Error("Skill 请求的 Task 或原生 Session 已变化；输入已保留。");
          const catalog = await service.getTaskSkillReferenceCatalog({
            taskId: target.id,
            participantId: target.participant.id,
            sessionId: target.session.id,
            authorizationId: target.authorizationId,
          });
          if (selectedTaskIdRef.current !== target.id)
            throw new Error("Skill 请求的 Task 已切换；输入已保留。");
          return catalog;
        };

        if (!slashCommand.args) {
          void runAction(
            "skill-list",
            async () => formatSessionSkillCatalog((await readSessionCatalog()).skills),
            (result) => result,
          ).then((accepted) => {
            if (
              accepted &&
              selectedTaskIdRef.current === target.id &&
              inputApiRef.current === editor &&
              editor?.getText().trim() === cleanText
            )
              editor?.clear();
          });
          return false;
        }

        if (selectedAttachments.length > 0 || selectedWebContexts.length > 0) {
          setNotice({
            kind: "info",
            message: "/skill 当前只接受文本任务；请先移除附件或网页上下文，输入已保留。",
          });
          return false;
        }
        if (runBlockedReason || submitBlockedReason || !submission) {
          setNotice({
            kind: "info",
            message:
              runBlockedReason ??
              submitBlockedReason ??
              "请先选择当前可用的模型与推理档位；输入已保留。",
          });
          return false;
        }
        const parsedSkill = parseManualSkillArgs(slashCommand.args);
        if (!parsedSkill) {
          setNotice({ kind: "info", message: "用法：/skill <名称> [任务]；输入已保留。" });
          return false;
        }
        submittedText = buildManualSkillPrompt(parsedSkill.skillName, parsedSkill.task);
        submitActionId = "skill";
        submitPreflight = async () => {
          const catalog = await readSessionCatalog();
          if (!catalog.skills.some((skill) => skill.name === parsedSkill.skillName))
            throw new Error(
              `Skill “${parsedSkill.skillName}” is not available in this Session's Skill catalog.`,
            );
          if (selectedTaskIdRef.current !== target.id)
            throw new Error("Skill 请求的 Task 已切换；输入已保留。");
        };
        submitSuccessMessage = () =>
          shouldQueue ? "Skill 请求已加入输入队列。" : "Skill 请求已提交。";
      } else if (!nativePromptBuiltinSlashCommands.has(slashCommand.name)) {
        const nativeBuiltin = nativeBuiltinForSlashCommand(slashCommand.name);
        const catalogCommand = nativeSlashCommands.find(
          (command) => normalizeSlashCommandValue(command.name).toLowerCase() === slashCommand.name,
        );
        const unsupportedReason = nativeBuiltin
          ? unsupportedNativeSlashReasons[
              slashCommand.name as keyof typeof unsupportedNativeSlashReasons
            ]?.[locale === "zh-CN" ? "zh" : "en"]
          : null;
        const message = nativeBuiltin
          ? locale === "zh-CN"
            ? `/${slashCommand.name} 暂不映射：${unsupportedReason ?? "当前 M1 Engine 对话没有对应的 Task 级 Host 操作。"} 输入已保留。`
            : `/${slashCommand.name} is not mapped: ${unsupportedReason ?? "M1 Engine conversations have no matching Task-scoped Host action."} Your draft is preserved.`
          : catalogCommand?.source === "custom"
            ? locale === "zh-CN"
              ? `/${slashCommand.name} 是 ZCode CLI 自定义命令；当前 M1 Engine 对话不执行此类命令，输入已保留。`
              : `/${slashCommand.name} is a ZCode CLI custom command; M1 Engine conversations do not run these commands. Your draft is preserved.`
            : catalogCommand
              ? locale === "zh-CN"
                ? `/${slashCommand.name} 不在固定 ZCode v0.16.9 支持范围内；输入已保留。`
                : `/${slashCommand.name} is outside the fixed ZCode v0.16.9 support set. Your draft is preserved.`
              : locale === "zh-CN"
                ? `未知斜杠命令 /${slashCommand.name}；输入已保留。`
                : `Unknown slash command /${slashCommand.name}. Your draft is preserved.`;
        setNotice({ kind: "info", message });
        return false;
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
    if (
      onRecoveredSubmitPrepare &&
      !onRecoveredSubmitPrepare(
        visibleTask.id,
        cleanText,
        submission
          ? { mode: submission.mode, modelSelection: submission.modelSelection }
          : undefined,
        visibleHistory?.inputs.some((input) => input.status === "cancelled") ?? false,
      )
    ) {
      setNotice({
        kind: "error",
        message: "恢复草稿未能安全保存或提交状态待核对；输入仍在，请勿重复发送。",
      });
      return false;
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
      submitActionId,
      async () => {
        if (submitPreflight) await submitPreflight();
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
      () => submitSuccessMessage?.() ?? null,
    )
      .then((accepted) => {
        if (!accepted) {
          onRecoveredSubmitUncertain?.(visibleTask.id);
          return;
        }
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
        const draftCleared = onComposerDraftSubmitted?.(visibleTask.id, cleanText);
        if (draftCleared === false)
          setNotice({
            kind: "error",
            message: "输入已被接受，但本地旧草稿清理失败。请核对历史，勿直接重新发送。",
          });
        if (inputApiRef.current === editor && editor?.getText().trim() === cleanText)
          editor?.clear();
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

  const editQueuedInput = async (inputId: string) => {
    if (!visibleTask || busyAction || pendingEditQueueItemId) return;
    if (draftStorageIssue === "review-required") {
      setNotice({ kind: "info", message: "请先核对上一份撤回草稿的提交结果，再编辑队列项。" });
      return;
    }
    const input = queuedInputs.find((entry) => entry.id === inputId);
    if (!input) return;
    if (input.attachments?.length) {
      setNotice({
        kind: "error",
        message: "该队列项含附件，当前无法安全恢复到草稿；原队列项已保留。",
      });
      return;
    }
    const sourceTask = visibleTask;
    const editor = inputApiRef.current;
    if (!editor || editor.getText().trim()) {
      setNotice({ kind: "info", message: "请先清空当前草稿，再撤回队列项编辑。" });
      return;
    }
    const parsedModel = modelSelectionSchema.safeParse(input.submissionConfig?.modelSelection);
    const config = input.submissionConfig
      ? {
          ...(typeof input.submissionConfig.mode === "string"
            ? { mode: input.submissionConfig.mode }
            : {}),
          ...(parsedModel.success ? { modelSelection: parsedModel.data } : {}),
        }
      : undefined;
    if (
      onQueueEditPrepare &&
      !onQueueEditPrepare(sourceTask.id, inputId, {
        text: input.text,
        ...(config ? { config } : {}),
      })
    ) {
      setNotice({ kind: "error", message: "草稿保存失败，队列项已保留；请检查本地存储后重试。" });
      return;
    }
    setPendingEditQueueItemId(inputId);
    try {
      const accepted = await runAction(
        `queue-edit:${inputId}`,
        () =>
          service.cancelQueuedInput({
            taskId: sourceTask.id,
            participantId: sourceTask.participant.id,
            sessionId: sourceTask.session.id,
            authorizationId: sourceTask.authorizationId,
            inputId,
          }),
        () => null,
      );
      if (!accepted) return;
      if (onQueueDraftRecovered) {
        if (!onQueueDraftRecovered(sourceTask.id, inputId))
          setNotice({ kind: "info", message: "队列项已撤回，草稿恢复待对账；请重新进入此 Task。" });
      } else if (selectedTaskIdRef.current === sourceTask.id && inputApiRef.current === editor) {
        editor.setText([editor.getText(), input.text].filter(Boolean).join("\n\n"));
        editor.focus();
      }
      if (input.submissionConfig && !onQueueDraftRecovered) {
        setConfigByTask((current) => ({
          ...current,
          [sourceTask.id]: config ?? {},
        }));
      }
    } finally {
      setPendingEditQueueItemId(null);
    }
  };

  const moveQueuedInput = (inputId: string, beforeInputId: string | null) => {
    if (!visibleTask || busyAction || pendingEditQueueItemId) return;
    void runAction(
      `queue-move:${inputId}`,
      () =>
        service.moveQueuedInput({
          taskId: visibleTask.id,
          participantId: visibleTask.participant.id,
          sessionId: visibleTask.session.id,
          authorizationId: visibleTask.authorizationId,
          inputId,
          beforeInputId,
        }),
      () => null,
    );
  };

  const sendQueuedInputNow = (inputId: string) => {
    if (!visibleTask || busyAction || pendingEditQueueItemId) return;
    void runAction(
      `queue-send-now:${inputId}`,
      () =>
        service.sendQueuedInputNow({
          taskId: visibleTask.id,
          participantId: visibleTask.participant.id,
          sessionId: visibleTask.session.id,
          authorizationId: visibleTask.authorizationId,
          inputId,
        }),
      ({ stopRequest, priorityRestored }) =>
        priorityRestored
          ? "中断请求未送达，队列顺序已恢复。"
          : stopRequest?.status === "confirmed"
            ? "原生停止已确认；队首仍需在派发前重新核验资格。"
            : stopRequest?.status === "unknown"
              ? "中断结果未知；请对账原执行，队列不会盲目重发。"
              : stopRequest?.deliveryStatus === "unknown"
                ? "中断请求是否送达尚未确认；队列会等待原执行的真实终态。"
                : stopRequest && stopRequest.status !== "requested"
                  ? "中断未获确认；队列优先级已更新，但不会仅凭请求回执派发。"
                  : stopRequest
                    ? "中断请求已提交；等待原生停止证据后处理队首。"
                    : "已请求队首派发；仍需等待原生接纳与执行结果。",
    );
  };

  const resumeQueuedInputs = async () => {
    if (!visibleTask || busyAction || !queuePaused) return;
    await runAction(
      `queue-resume:${visibleTask.session.id}`,
      () =>
        service.resumeQueuedInputs({
          taskId: visibleTask.id,
          participantId: visibleTask.participant.id,
          sessionId: visibleTask.session.id,
          authorizationId: visibleTask.authorizationId,
        }),
      () => "队列恢复请求已受理；每项派发前仍会重新核验资格。",
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

  const retryExecution = (executionId: string) => {
    if (!visibleTask || revisionBlockedReason || busyAction) return;
    void runAction(
      `retry:${executionId}`,
      () =>
        service.reviseTurn({
          taskId: visibleTask.id,
          participantId: visibleTask.participant.id,
          sessionId: visibleTask.session.id,
          authorizationId: visibleTask.authorizationId,
          sourceExecutionId: executionId,
          kind: "retry",
        }),
      () => null,
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
              onRetryExecution={retryExecution}
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
            {visibleTask.session.status === "unknown" ? (
              <section
                className="mb-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm"
                data-testid="engine-session-recovery"
                role="status"
                aria-live="polite"
              >
                <p className="font-medium">
                  原生 Session 状态未知，历史仍可查看；不会自动恢复或重发输入。
                </p>
                {visibleTask.status !== "active" ? (
                  <p className="mt-1 text-xs text-foreground-subtle">
                    此 Task 已结束，不能恢复后继续。
                  </p>
                ) : !visibleTask.session.nativeSessionId ? (
                  <p className="mt-1 text-xs text-foreground-subtle">
                    历史中没有已验证的原生 Session 身份，无法恢复此会话。
                  </p>
                ) : sessionRestoreBlockedReason ? (
                  <p className="mt-1 text-xs text-foreground-subtle">
                    {sessionRestoreBlockedReason}
                  </p>
                ) : (
                  <button
                    className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface disabled:opacity-60"
                    data-testid="restore-engine-session"
                    type="button"
                    disabled={busyAction !== null}
                    onClick={restoreUnknownSession}
                  >
                    {busyAction === `restore:${visibleTask.id}` ? "正在恢复…" : "恢复原会话"}
                  </button>
                )}
                {restoreErrors[visibleTask.id] ? (
                  <p className="mt-2 text-xs text-warning" data-testid="restore-session-error">
                    恢复失败：{restoreErrors[visibleTask.id]}
                  </p>
                ) : null}
              </section>
            ) : null}
            {unknownExecutions.map((execution) => (
              <section
                className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm"
                data-testid={`unknown-execution-${execution.id}`}
                key={execution.id}
                role="status"
                aria-live="polite"
              >
                <div className="min-w-0">
                  <p className="font-medium">执行结果未知；对账只查询原生状态，不会重发输入。</p>
                  {execution.reconciliationReason || execution.reconciliationEvidence?.detail ? (
                    <p className="mt-1 break-words text-xs text-foreground-subtle">
                      {execution.reconciliationReason ?? execution.reconciliationEvidence?.detail}
                    </p>
                  ) : null}
                  {reconcileErrors[execution.id] ? (
                    <p
                      className="mt-1 break-words text-xs text-warning"
                      data-testid={`reconcile-execution-error-${execution.id}`}
                    >
                      对账失败：{reconcileErrors[execution.id]}
                    </p>
                  ) : null}
                </div>
                <button
                  className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface disabled:opacity-60"
                  data-testid={`reconcile-execution-${execution.id}`}
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => reconcileUnknownExecution(execution.id)}
                >
                  {busyAction === `reconcile:${execution.id}` ? "正在对账…" : "对账原执行"}
                </button>
              </section>
            ))}
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
              {draftStorageIssue ? (
                <div
                  role="alert"
                  data-testid="engine-queue-draft-storage-warning"
                  className="mb-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning"
                >
                  <p>
                    {draftStorageIssue === "review-required"
                      ? "队列撤回草稿的提交或清理结果待核对。请先检查此 Task 历史；旧草稿不会自动重发。"
                      : "队列撤回草稿未能写入本地存储。关闭 App 前请保留输入；发送已暂停。"}
                  </p>
                  {draftStorageIssue === "review-required" ? (
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        className="rounded border border-current px-2 py-1"
                        data-testid="engine-queue-draft-review-restore"
                        onClick={() => onResolveRecoveredReview?.(visibleTask.id, "restore")}
                      >
                        核对后恢复
                      </button>
                      <button
                        type="button"
                        className="rounded border border-current px-2 py-1"
                        data-testid="engine-queue-draft-review-discard"
                        onClick={() => onResolveRecoveredReview?.(visibleTask.id, "discard")}
                      >
                        清除旧稿
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <ConversationQueuePanel
                queue={{
                  items: queuedInputs.map((input) => ({
                    queueItemId: input.id,
                    kind: "sendText",
                    text: input.text,
                    dispatch: { state: "queued" },
                  })),
                  autoDrain: !queuePaused,
                  ...(queuePaused ? { pauseReason: "manual" as const } : {}),
                }}
                onDeleteItem={cancelQueuedInput}
                onEditItem={editQueuedInput}
                pendingEditQueueItemId={pendingEditQueueItemId}
                onMoveItem={runBlockedReason ? undefined : moveQueuedInput}
                onSendNow={queuePaused ? undefined : sendQueuedInputNow}
                onResume={queuePaused && !runBlockedReason ? resumeQueuedInputs : undefined}
              />
              <div className="chat-composer-input-surface w-full">
                <ChatPromptEditor
                  key={visibleTask.id}
                  className="p-0"
                  workspacePath={composerWorkspacePath}
                  taskId={activeNativeSessionId}
                  taskSkillCatalogRequest={
                    isZCodeHarness
                      ? {
                          taskId: visibleTask.id,
                          participantId: visibleTask.participant.id,
                          sessionId: visibleTask.session.id,
                          authorizationId: visibleTask.authorizationId,
                        }
                      : undefined
                  }
                  promptHistory={promptHistory}
                  inputApiRef={inputApiRef}
                  onChange={(value) => {
                    if (!onRecoveredDraftChange) return;
                    let editorStateJson: string | undefined;
                    try {
                      const editorState = inputApiRef.current?.getEditorState();
                      editorStateJson = editorState
                        ? JSON.stringify(editorState.toJSON())
                        : undefined;
                    } catch {
                      // Plain text remains recoverable when the editor state cannot be serialized.
                    }
                    const restoreText = onRecoveredDraftChange(
                      visibleTask.id,
                      value,
                      editorStateJson,
                    );
                    if (restoreText && !value.trim())
                      queueMicrotask(() => {
                        if (!inputApiRef.current?.getText().trim())
                          inputApiRef.current?.setText(restoreText);
                      });
                  }}
                  onImportSharedContext={isZCodeHarness ? importSharedContext : undefined}
                  attachmentAction={platform.canSelectFilePath ? attachmentAction : undefined}
                  showMentionButton={isZCodeHarness}
                  fileReferencesOnly={isZCodeHarness}
                  actionMenuDisabled={shouldQueue || !!runBlockedReason || busyAction !== null}
                  actionMenuDisabledReason={
                    runBlockedReason ??
                    (busyAction !== null
                      ? "操作正在处理中。"
                      : shouldQueue
                        ? "附件不能排队；请等待当前轮次完成后发送。"
                        : intl.formatMessage({
                            id: platform.canSelectFilePath
                              ? "engine.composer.textOnly"
                              : "engine.composer.attachmentLocalPathRequired",
                          }))
                  }
                  leadingActions={
                    <ConfigSelect
                      option={modeOption}
                      provider={ZCODE_AGENT_PROVIDER}
                      open={modePickerOpen}
                      onOpenChange={setModePickerOpen}
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
                        openRequestKey={modelPickerRequestKey}
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
                        open={thoughtPickerOpen}
                        onOpenChange={setThoughtPickerOpen}
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
                    latestExecution.status !== "unknown" &&
                    !isTerminal(latestExecution.status) &&
                    !stopBlockedReason &&
                    !pendingStop &&
                    busyAction === null
                      ? () => requestStop(latestExecution.id)
                      : undefined
                  }
                  showSlashButton={false}
                  excludedSlashCommandNames={excludedSlashCommandNames}
                  appSlashCommands={mappedSlashCommands}
                  enableMentionPanel={
                    visibleTask.session.status === "active" && nativeSessionId !== null
                  }
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
