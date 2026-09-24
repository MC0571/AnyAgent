import type { Event } from "@zcode/rpc";
import type { Locale } from "@zcode/shared";
import type {
  ReplyToApproval,
  ReplyToUserInput,
  RequestStop,
  ReviseTurn,
  RuntimeChange,
  RuntimeCredentialSource,
  RuntimeCurrentEngineProjection,
  RuntimeCompactOperation,
  RuntimeEnvironment,
  RuntimeTask,
  ForkTaskInput,
  RuntimeAttachmentReference,
  RuntimeAssistantFeedbackResult,
  RuntimeExecutionFileChanges,
  RuntimeFileRewindPreview,
  RuntimeFileRewindOperation,
  ExecutionFileTarget,
  ApplyFileRewind,
  CompactSession,
  SetAssistantFeedback,
  StageRuntimeAttachmentInput,
  SubmitInput,
  TaskHistory,
  TaskLifecycleRequest,
  ReconcileExecution,
  RuntimeExecution,
} from "@anyagent/runtime/types";
import { createServiceDescriptor } from "../descriptors.js";

/** Renderer-facing product surface. Native engine handles and grants stay in the Host. */
export interface IAnyAgentService {
  readonly onDidChange: Event<RuntimeChange>;
  getCreateTaskContext(workspace?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<{
    environment: RuntimeEnvironment;
    credentialSource: RuntimeCredentialSource;
  }>;
  listEngines(workspace?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<readonly RuntimeCurrentEngineProjection[]>;
  listTasks(): Promise<readonly RuntimeTask[]>;
  getTask(taskId: string): Promise<RuntimeTask | null>;
  getHistory(taskId: string): Promise<TaskHistory | null>;
  getTaskSkillReferenceCatalog(
    input: TaskSkillReferenceCatalogRequest,
  ): Promise<TaskSkillReferenceCatalog>;
  restoreTaskSession(input: TaskLifecycleRequest): Promise<RuntimeTask>;
  reconcileExecution(input: ReconcileExecution): Promise<RuntimeExecution>;
  /** Read-only feedback projection from the native Session, not a second product authority. */
  getAssistantFeedback(
    taskId: string,
  ): Promise<
    | { state: "current"; values: Record<string, "like" | "dislike" | null> }
    | { state: "unknown"; reason: string }
  >;
  createTask(input: {
    engineId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<RuntimeTask>;
  /** Host imports and verifies a native shared-context Session before product ownership is created. */
  importSharedContext(input: {
    shareCode: string;
    clientRequestId: string;
    workspacePath?: string;
    locale?: Locale;
  }): Promise<RuntimeTask>;
  forkTask(input: Omit<ForkTaskInput, "authorization">): Promise<RuntimeTask>;
  stageAttachment(input: StageRuntimeAttachmentInput): Promise<RuntimeAttachmentReference>;
  submitInput(input: SubmitInput): Promise<void>;
  cancelQueuedInput(input: {
    readonly taskId: string;
    readonly participantId: string;
    readonly sessionId: string;
    readonly authorizationId: string;
    readonly inputId: string;
  }): Promise<void>;
  reviseTurn(input: ReviseTurn): Promise<void>;
  setAssistantFeedback(input: SetAssistantFeedback): Promise<RuntimeAssistantFeedbackResult>;
  getExecutionFileChanges(input: ExecutionFileTarget): Promise<RuntimeExecutionFileChanges | null>;
  previewFileRewind(input: ExecutionFileTarget): Promise<RuntimeFileRewindPreview>;
  applyFileRewind(input: ApplyFileRewind): Promise<RuntimeFileRewindOperation>;
  compactSession(input: CompactSession): Promise<RuntimeCompactOperation>;
  replyToApproval(input: ReplyToApproval): Promise<void>;
  replyToUserInput(input: ReplyToUserInput): Promise<void>;
  requestStop(input: RequestStop): Promise<void>;
}

export interface TaskSkillReferenceCatalog {
  readonly skills: readonly TaskSkillReference[];
}

export type TaskSkillReferenceCatalogRequest = Pick<
  TaskLifecycleRequest,
  "taskId" | "participantId" | "sessionId" | "authorizationId"
>;

export interface TaskSkillReference {
  readonly name: string;
  readonly description: string;
  readonly scope: "workspace" | "user" | "plugin";
  readonly pluginName?: string;
}

export const IAnyAgentService = createServiceDescriptor<IAnyAgentService>("anyagent-runtime");
