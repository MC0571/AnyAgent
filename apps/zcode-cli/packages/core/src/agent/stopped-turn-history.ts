import {
  createRuntimeToolResultEntry,
  type MessageHistory,
  type RuntimeMessageEntry,
} from "./message-history.js";

// A stopped prompt remains readable in the native transcript, but its unfinished
// instruction must not be offered to the model again when the next Input starts.
export const STOPPED_TURN_PROVIDER_TEXT =
  "[The previous user request was stopped. Its unfinished instructions are withdrawn.]";

export const STOPPED_TURN_PROVIDER_DISPOSITION = "withdrawn_after_stop";
export const INTERRUPTED_TOOL_RESULT = "[Tool execution was interrupted before resume]";

export function withdrawStoppedTurnFromLiveHistory(
  history: MessageHistory,
  startIndex: number,
): void {
  const entries = history.toRuntimeEntries();
  if (startIndex < 0 || startIndex >= entries.length) return;
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
