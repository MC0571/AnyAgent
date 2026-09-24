import type {
  CapabilityStatus,
  EngineApprovalOption,
  EngineApprovalRef,
  EngineCapability,
  EngineEvent,
  EngineExecutionRef,
  EngineFailure,
  EngineSessionRef,
  EngineUserInputOption,
  EngineUserInputRef,
} from "./types.js";

export type FakeEngineStep =
  | { readonly type: "input.accepted" }
  | { readonly type: "execution.started" }
  | {
      readonly type: "message.delta";
      readonly text: string;
      readonly messageId?: string;
      readonly blockId?: string;
    }
  | {
      readonly type: "tool.started";
      readonly name: string;
      readonly input?: unknown;
      readonly toolCallId?: string;
    }
  | {
      readonly type: "tool.completed";
      readonly result?: unknown;
      readonly sideEffects?: "none" | "possible" | "known";
      readonly toolCallId?: string;
    }
  | {
      readonly type: "tool.failed";
      readonly failure: EngineFailure;
      readonly toolCallId: string;
    }
  | {
      readonly type: "file.changed";
      readonly path: string;
      readonly operation: "created" | "modified" | "deleted";
      readonly diff?: string;
    }
  | {
      readonly type: "approval.requested";
      readonly operation: string;
      readonly scope?: string;
      readonly options?: readonly EngineApprovalOption[];
      readonly expiresAt?: number | null;
    }
  | {
      readonly type: "user-input.requested";
      readonly prompt: string;
      readonly inputKind: "text" | "choice" | "form";
      readonly options?: readonly EngineUserInputOption[];
      readonly expiresAt?: number | null;
    }
  | { readonly type: "execution.completed"; readonly result?: string }
  | { readonly type: "execution.failed"; readonly message: string };

export interface FakeEngineOptions {
  readonly autoAdvance?: boolean;
  readonly stepDelayMs?: number;
  readonly now?: () => number;
  readonly script?: readonly FakeEngineStep[];
  readonly capabilities?: Partial<Record<EngineCapability, CapabilityStatus>>;
  readonly engineId?: string;
  readonly engineVersion?: string | null;
  readonly adapterVersion?: string;
  readonly configurationVersion?: string | null;
  readonly environment?: string | null;
}

export interface PendingApproval {
  readonly options: readonly EngineApprovalOption[];
  readonly expiresAt: number | null;
  status: "pending" | "forwarded" | "expired";
}

export interface PendingUserInput {
  readonly inputKind: "text" | "choice" | "form";
  readonly options: readonly EngineUserInputOption[];
  readonly expiresAt: number | null;
  status: "pending" | "forwarded" | "expired";
}

export interface EventOverrides {
  readonly eventId?: string;
  readonly sourceSequence?: number | null;
  readonly source?: EngineEvent["source"];
}

export interface ExecutionRecord {
  readonly session: EngineSessionRef;
  readonly executionId: EngineExecutionRef;
  readonly events: AsyncEventQueue;
  readonly script: readonly FakeEngineStep[];
  readonly emitted: EngineEvent[];
  readonly approvals: Map<EngineApprovalRef, PendingApproval>;
  readonly userInputs: Map<EngineUserInputRef, PendingUserInput>;
  cursor: number;
  sourceSequence: number;
  deliverySequence: number;
  streamGeneration: number;
  streamId: string;
  idSequence: number;
  evidenceSequence: number;
  connected: boolean;
  interruptRequested: boolean;
  closed: boolean;
  terminal: boolean;
  sessionClosed: boolean;
  autoAdvanceQueued: boolean;
}

export class AsyncEventQueue implements AsyncIterable<EngineEvent>, AsyncIterator<EngineEvent> {
  readonly #items: EngineEvent[] = [];
  readonly #waiters: Array<(result: IteratorResult<EngineEvent>) => void> = [];
  #closed = false;

  [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    return this;
  }

  next(): Promise<IteratorResult<EngineEvent>> {
    const item = this.#items.shift();
    if (item) return Promise.resolve({ done: false, value: item });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  push(event: EngineEvent): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.#items.push(event);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }
}

export const CAPABILITIES: readonly EngineCapability[] = [
  "session.create",
  "session.close",
  "execution.run",
  "execution.interrupt",
  "execution.reconcile",
  "events.stream",
  "events.tool",
  "events.file",
  "approval.respond",
  "user-input.respond",
];

export function defaultScript(round: number): readonly FakeEngineStep[] {
  const opening = `Fake round ${round}: I will inspect the file. `;
  const closing = `The file has been updated (round ${round}).`;
  return [
    { type: "input.accepted" },
    { type: "execution.started" },
    { type: "message.delta", text: opening, messageId: `fake-message-${round}`, blockId: "text" },
    {
      type: "tool.started",
      toolCallId: "fake-tool-1",
      name: "read_file",
      input: { path: "README.md" },
    },
    {
      type: "file.changed",
      path: "README.md",
      operation: "modified",
      diff: "@@ -1 +1 @@\n-old\n+new",
    },
    {
      type: "tool.completed",
      toolCallId: "fake-tool-1",
      result: { path: "README.md" },
      sideEffects: "known",
    },
    { type: "message.delta", text: closing, messageId: `fake-message-${round}`, blockId: "text" },
    { type: "execution.completed", result: opening + closing },
  ];
}
