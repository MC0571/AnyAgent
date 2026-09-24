import type { Event } from "@zcode/rpc";
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
  CompactSession,
  SetAssistantFeedback,
  StageRuntimeAttachmentInput,
  SubmitInput,
  TaskHistory,
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
  createTask(input: {
    engineId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<RuntimeTask>;
  forkTask(input: Omit<ForkTaskInput, "authorization">): Promise<RuntimeTask>;
  stageAttachment(input: StageRuntimeAttachmentInput): Promise<RuntimeAttachmentReference>;
  submitInput(input: SubmitInput): Promise<void>;
  reviseTurn(input: ReviseTurn): Promise<void>;
  setAssistantFeedback(input: SetAssistantFeedback): Promise<RuntimeAssistantFeedbackResult>;
  compactSession(input: CompactSession): Promise<RuntimeCompactOperation>;
  replyToApproval(input: ReplyToApproval): Promise<void>;
  replyToUserInput(input: ReplyToUserInput): Promise<void>;
  requestStop(input: RequestStop): Promise<void>;
}

export const IAnyAgentService = createServiceDescriptor<IAnyAgentService>("anyagent-runtime");
