import type { Event } from "@zcode/rpc";
import type {
  ReplyToApproval,
  ReplyToUserInput,
  RequestStop,
  RuntimeChange,
  RuntimeCredentialSource,
  RuntimeEngineProjection,
  RuntimeEnvironment,
  RuntimeTask,
  SubmitInput,
  TaskHistory,
} from "@anyagent/runtime/types";
import { createServiceDescriptor } from "../descriptors.js";

/** Renderer-facing product surface. Native engine handles and grants stay in the Host. */
export interface IAnyAgentService {
  readonly onDidChange: Event<RuntimeChange>;
  getCreateTaskContext(): Promise<{
    environment: RuntimeEnvironment;
    credentialSource: RuntimeCredentialSource;
  }>;
  listEngines(): Promise<readonly RuntimeEngineProjection[]>;
  listTasks(): Promise<readonly RuntimeTask[]>;
  getTask(taskId: string): Promise<RuntimeTask | null>;
  getHistory(taskId: string): Promise<TaskHistory | null>;
  createTask(input: { engineId: string }): Promise<RuntimeTask>;
  submitInput(input: SubmitInput): Promise<void>;
  replyToApproval(input: ReplyToApproval): Promise<void>;
  replyToUserInput(input: ReplyToUserInput): Promise<void>;
  requestStop(input: RequestStop): Promise<void>;
}

export const IAnyAgentService = createServiceDescriptor<IAnyAgentService>("anyagent-runtime");
