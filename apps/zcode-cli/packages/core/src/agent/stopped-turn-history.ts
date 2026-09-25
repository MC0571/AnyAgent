import {
  createRuntimeToolResultEntry,
  type MessageHistory,
  type RuntimeMessageEntry,
} from "./message-history.js";
import { SESSION_ENTRY_NATIVE_TURN_TERMINAL } from "@zcode/contracts";
import type { MessageId, SessionId, SessionStorePort } from "@zcode/contracts";
import { parseRewindCommand } from "../runtime/helpers/commands.js";

// A stopped prompt remains readable in the native transcript, but its unfinished
// instruction must not be offered to the model again when the next Input starts.
export const STOPPED_TURN_PROVIDER_TEXT =
  "[The previous user request was stopped. Its unfinished instructions are withdrawn.]";

export const STOPPED_TURN_PROVIDER_DISPOSITION = "withdrawn_after_stop";
export const INTERRUPTED_TOOL_RESULT = "[Tool execution was interrupted before resume]";
export const NATIVE_TURN_STARTED_ENTRY = "runtime/native_turn_started";

export function tagPreRecordedTurnInput(
  history: MessageHistory,
  nativeMessageId: string,
  turnId: string,
): void {
  const entries = history.toRuntimeEntries();
  const matches = entries.flatMap((entry, index) =>
    entry.kind !== "attachment" &&
    entry.message.role === "user" &&
    entry.metadata?.nativeMessageId === nativeMessageId
      ? [index]
      : [],
  );
  if (matches.length !== 1) throw new Error("Pre-recorded native Input is absent or ambiguous");
  const index = matches[0]!;
  const entry = entries[index]!;
  if (entry.kind === "attachment") throw new Error("Pre-recorded native Input is not a message");
  entries[index] = {
    ...entry,
    metadata: { ...(entry.metadata ?? { source: "legacy_synthetic" }), turnId },
  };
  history.replaceMessages(entries);
}

export async function assertNoUnresolvedAnyAgentInputs(
  sessionStore: SessionStorePort,
  sessionId: SessionId,
): Promise<void> {
  if (!sessionStore.listSessionInputs) return; // Legacy sessions have no durable V4 input ledger.
  const promoted = await sessionStore.listSessionInputs({
    sessionID: sessionId,
    status: "promoted",
  });
  const sourceCommandIds = promoted.flatMap((input) => {
    if (input.kind !== "sendText" && input.kind !== "sendGoalCommand") return [];
    const intent = input.payload.intent;
    if (!intent || typeof intent !== "object" || Array.isArray(intent)) return [];
    const fields = intent as Record<string, unknown>;
    return fields.clientId === "anyagent-m1-host" && typeof fields.sourceCommandId === "string"
      ? [fields.sourceCommandId]
      : [];
  });
  if (sourceCommandIds.length === 0) return;
  if (!sessionStore.sessionEntries) {
    throw new Error("Native terminal provenance is unavailable; Session resume is blocked");
  }
  const terminalEntries = await sessionStore.sessionEntries({
    sessionID: sessionId,
    type: SESSION_ENTRY_NATIVE_TURN_TERMINAL,
  });
  const terminalFacts = terminalEntries.flatMap((entry) => {
    const data = entry.data;
    return data && typeof data === "object" && !Array.isArray(data)
      ? [data as Record<string, unknown>]
      : [];
  });
  const terminals = new Map(
    terminalFacts.flatMap((fields) =>
      typeof fields.inputId === "string" ? [[fields.inputId, fields] as const] : [],
    ),
  );
  if (sourceCommandIds.some((commandId) => !terminals.has(commandId))) {
    throw new Error("Native Input result is unresolved; reconcile it before resuming this Session");
  }
  const startedEntries = await sessionStore.sessionEntries({
    sessionID: sessionId,
    type: NATIVE_TURN_STARTED_ENTRY,
  });
  const terminalTurnIds = new Set(
    terminalFacts.flatMap((terminal) =>
      typeof terminal.turnId === "string" ? [terminal.turnId] : [],
    ),
  );
  if (
    startedEntries.some((entry) => {
      const data = entry.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return true;
      const turnId = (data as Record<string, unknown>).turnId;
      return typeof turnId !== "string" || !terminalTurnIds.has(turnId);
    })
  ) {
    throw new Error("Native turn result is unresolved; reconcile it before resume");
  }
  const cancelledTurnIds = terminalFacts.flatMap((terminal) =>
    terminal.resultType === "cancelled" && typeof terminal.turnId === "string"
      ? [terminal.turnId]
      : [],
  );
  if (cancelledTurnIds.length === 0) return;
  const controlCancelledTurnIds = new Set(
    terminalFacts.flatMap((terminal) => {
      if (
        terminal.resultType !== "cancelled" ||
        typeof terminal.turnId !== "string" ||
        typeof terminal.inputId !== "string"
      ) {
        return [];
      }
      const controlInput = promoted.find((input) => {
        const intent = input.payload.intent;
        return (
          intent &&
          typeof intent === "object" &&
          !Array.isArray(intent) &&
          (intent as Record<string, unknown>).sourceCommandId === terminal.inputId
        );
      });
      const text = controlInput?.payload.text ?? "";
      return controlInput?.kind === "compact" || parseRewindCommand(text) !== null
        ? [terminal.turnId]
        : [];
    }),
  );
  const messages = await sessionStore.messages({ sessionID: sessionId });
  const startedMessageIds = new Map(
    startedEntries.flatMap((entry) => {
      const data = entry.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return [];
      const fields = data as Record<string, unknown>;
      return typeof fields.turnId === "string" && typeof fields.messageId === "string"
        ? [[fields.turnId, fields.messageId] as const]
        : [];
    }),
  );
  const withdrawnTurnIds = new Set(
    messages.flatMap((message) =>
      message.info.role === "user" &&
      message.info.metadata?.providerHistoryDisposition === STOPPED_TURN_PROVIDER_DISPOSITION
        ? [String(message.info.metadata.providerWithdrawalTurnId ?? message.info.anchor?.turnId)]
        : [],
    ),
  );
  if (
    cancelledTurnIds.some((turnId) => {
      if (withdrawnTurnIds.has(turnId)) return false;
      const startedMessageId = startedMessageIds.get(turnId);
      if (!startedMessageId) {
        // Old regular turns and background notices may lack a start fact and
        // have provider input anchored to an earlier turn. Only a matched
        // compact/rewind command proves this cancelled terminal is control-only.
        return !controlCancelledTurnIds.has(turnId);
      }
      // A Stop before prompt hooks/attachment resolution can emit a cancelled
      // terminal without ever adding or persisting a provider-visible Input.
      if (
        startedMessageId &&
        !messages.some(
          (message) =>
            String(message.info.id) === startedMessageId ||
            String(message.info.anchor?.turnId) === turnId,
        )
      ) {
        return false;
      }
      return true;
    })
  ) {
    throw new Error("Stopped native Input lacks provider withdrawal; reconcile it before resume");
  }
  if (
    messages.some(
      (message) =>
        message.info.role === "assistant" &&
        cancelledTurnIds.includes(String(message.info.anchor?.turnId)) &&
        message.parts.some(
          (part) =>
            part.type === "tool" &&
            (part.state.status === "pending" || part.state.status === "running"),
        ),
    )
  ) {
    throw new Error("Stopped native tool outcome is unknown; reconcile it before resume");
  }
}

export async function confirmStoppedTurnWithdrawal(input: {
  history: MessageHistory;
  sessionStore?: SessionStorePort;
  sessionId: SessionId;
  turnId: string;
  userMessageId?: MessageId;
  allowPreRecordedMessage?: boolean;
  holdQueue: () => void;
}): Promise<void> {
  try {
    withdrawStoppedTurnFromLiveHistory(input.history, input.turnId);
    if (!input.sessionStore) return;
    if (!input.userMessageId) {
      throw new Error("Stopped native turn has no durable user message to withdraw");
    }
    const [stored, messages] = await Promise.all([
      input.sessionStore.messageWithParts({
        sessionID: input.sessionId,
        messageID: input.userMessageId,
      }),
      input.sessionStore.messages({ sessionID: input.sessionId }),
    ]);
    if (
      stored?.info.role !== "user" ||
      (String(stored.info.anchor?.turnId) !== input.turnId && !input.allowPreRecordedMessage)
    ) {
      throw new Error("Stopped native user message cannot be identified");
    }
    if (
      messages.some((message) =>
        message.parts.some(
          (part) =>
            part.type === "compaction" && String(part.compactBoundary?.turnId) === input.turnId,
        ),
      )
    ) {
      throw new Error("Stopped turn may be included in an active compact summary");
    }
    if (
      messages.some(
        (message) =>
          message.info.role === "assistant" &&
          String(message.info.anchor?.turnId) === input.turnId &&
          message.parts.some(
            (part) =>
              part.type === "tool" &&
              (part.state.status === "pending" || part.state.status === "running"),
          ),
      )
    ) {
      throw new Error("Stopped native tool outcome is unknown");
    }
    await input.sessionStore.saveMessage({
      ...stored.info,
      ...(stored.info.semantics
        ? {
            semantics: { ...stored.info.semantics, providerVisibility: "hidden" },
          }
        : {}),
      metadata: {
        ...stored.info.metadata,
        providerHistoryDisposition: STOPPED_TURN_PROVIDER_DISPOSITION,
        providerWithdrawalTurnId: input.turnId,
      },
    });
  } catch (error) {
    input.holdQueue();
    throw new Error("Stopped turn provider context is unconfirmed; queue held", { cause: error });
  }
}

export function withdrawStoppedTurnFromLiveHistory(history: MessageHistory, turnId: string): void {
  const entries = history.toRuntimeEntries();
  const matches = entries.flatMap((entry, index) =>
    entry.kind !== "attachment" &&
    entry.message.role === "user" &&
    entry.metadata?.turnId === turnId
      ? [index]
      : [],
  );
  if (matches.length !== 1) {
    throw new Error("Stopped native turn is absent or ambiguous in provider history");
  }
  const startIndex = matches[0]!;
  const retained: RuntimeMessageEntry[] = entries.slice(0, startIndex);
  retained.push({
    message: { role: "user", content: STOPPED_TURN_PROVIDER_TEXT },
    metadata: { source: "legacy_synthetic" },
  });
  const pendingTools = new Map<string, string>();
  const settlePendingTools = (): void => {
    for (const [id, name] of pendingTools) {
      retained.push(createRuntimeToolResultEntry(id, name, INTERRUPTED_TOOL_RESULT, true));
    }
    pendingTools.clear();
  };
  for (let index = startIndex + 1; index < entries.length; index++) {
    const entry = entries[index]!;
    if (
      entry.kind !== "attachment" &&
      entry.message.role === "user" &&
      entry.metadata?.source === "real_user"
    ) {
      settlePendingTools();
      retained.push(...entries.slice(index));
      break;
    }
    if (entry.kind === "attachment") continue;
    if (entry.message.role === "tool") {
      retained.push(entry);
      if (entry.message.toolCallId) pendingTools.delete(entry.message.toolCallId);
    } else if (entry.message.role === "assistant" && entry.message.toolCalls?.length) {
      settlePendingTools();
      retained.push({ ...entry, message: { ...entry.message, content: "" } });
      for (const call of entry.message.toolCalls) pendingTools.set(call.id, call.name);
    }
  }
  settlePendingTools();
  history.replaceMessages(retained);
}
