import type {
  EngineApproval,
  EngineEvent,
  EngineExecution,
  EngineHistory,
  EngineInput,
  EngineTask,
  EngineUserInput,
} from "@/EngineUiParts.js";

export type EngineDeltaBlock = {
  key: string;
  text: string;
  messageId: string | null;
  blockId: string | null;
  identityKnown: boolean;
  streamId: string;
  source: string;
};

export type EngineExecutionItem =
  | { kind: "delta"; block: EngineDeltaBlock }
  | { kind: "tool"; toolCallId: string };

export type EngineExecutionTurn = {
  execution: EngineExecution;
  events: readonly EngineEvent[];
  deltas: readonly EngineDeltaBlock[];
  items: readonly EngineExecutionItem[];
  approvals: readonly EngineApproval[];
  userInputs: readonly EngineUserInput[];
};

export type EngineInputTurn = {
  input: EngineInput;
  events: readonly EngineEvent[];
  executions: readonly EngineExecutionTurn[];
};

export type EngineConversationProjection = {
  turns: readonly EngineInputTurn[];
  unassociatedExecutions: readonly EngineExecution[];
  unassociatedEvents: readonly EngineEvent[];
  unassociatedApprovals: readonly EngineApproval[];
  unassociatedUserInputs: readonly EngineUserInput[];
};

function belongsToTask(
  item: { taskId: string; participantId?: string; sessionId?: string },
  task: EngineTask,
): boolean {
  return (
    item.taskId === task.id &&
    (item.participantId === undefined || item.participantId === task.participant.id) &&
    (item.sessionId === undefined || item.sessionId === task.session.id)
  );
}

function stringField(event: EngineEvent, field: string): string | null {
  const value = event.payload[field];
  return typeof value === "string" ? value : null;
}

function projectExecutionItems(
  executionId: string,
  events: readonly EngineEvent[],
): { items: EngineExecutionItem[]; deltas: EngineDeltaBlock[] } {
  const items: EngineExecutionItem[] = [];
  const blocks: Array<{ block: EngineDeltaBlock; events: EngineEvent[]; identity: string }> = [];
  const seenEventIds = new Set<string>();
  const seenToolIds = new Set<string>();
  let previousWasDelta = false;
  for (const event of events) {
    if (event.duplicateOf || seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    if (event.type === "message.delta") {
      const text = stringField(event, "text");
      if (!text) continue;
      const messageId = stringField(event, "messageId");
      const blockId = stringField(event, "blockId");
      const identityKnown = messageId !== null && blockId !== null;
      const identity = `${executionId}:${event.streamId}:${event.source}:${messageId}:${blockId}`;
      // Keep a native block together only while its fragments are adjacent in the event stream.
      const previousBlock = previousWasDelta ? blocks.at(-1) : undefined;
      if (identityKnown && previousBlock?.identity === identity) {
        previousBlock.events.push(event);
      } else {
        const block: EngineDeltaBlock = {
          key: `${identity}:${event.id}`,
          text: "",
          messageId,
          blockId,
          identityKnown,
          streamId: event.streamId,
          source: event.source,
        };
        blocks.push({ block, events: [event], identity });
        items.push({ kind: "delta", block });
      }
      previousWasDelta = true;
      continue;
    }
    previousWasDelta = false;
    if (
      event.type === "tool.started" ||
      event.type === "tool.completed" ||
      event.type === "tool.failed"
    ) {
      const toolCallId = stringField(event, "toolCallId");
      if (toolCallId && !seenToolIds.has(toolCallId)) {
        seenToolIds.add(toolCallId);
        items.push({ kind: "tool", toolCallId });
      }
    }
  }
  for (const { block, events: blockEvents } of blocks) {
    block.text = blockEvents
      .sort(
        (a, b) =>
          (a.sourceSequence ?? a.deliverySequence) - (b.sourceSequence ?? b.deliverySequence) ||
          a.deliverySequence - b.deliverySequence,
      )
      .map((event) => stringField(event, "text") ?? "")
      .join("");
  }
  return { items, deltas: blocks.map(({ block }) => block) };
}

export function projectEngineConversation(
  task: EngineTask,
  history: EngineHistory | null,
): EngineConversationProjection {
  if (!history || history.taskId !== task.id) {
    return {
      turns: [],
      unassociatedExecutions: [],
      unassociatedEvents: [],
      unassociatedApprovals: [],
      unassociatedUserInputs: [],
    };
  }
  const inputs = history.inputs
    .filter((input) => belongsToTask(input, task))
    .sort((a, b) => a.receivedAt - b.receivedAt);
  const executions = history.executions
    .filter((execution) => belongsToTask(execution, task))
    .sort((a, b) => (a.startedAt ?? a.acceptedAt) - (b.startedAt ?? b.acceptedAt));
  const events = history.events
    .filter((event) => belongsToTask(event, task))
    .sort((a, b) => a.observedAt - b.observedAt || a.deliverySequence - b.deliverySequence);
  const inputById = new Map(inputs.map((input) => [input.id, input]));
  const executionsByInput = new Map<string, EngineExecution[]>();
  for (const execution of executions) {
    if (!inputById.has(execution.inputId)) continue;
    const list = executionsByInput.get(execution.inputId) ?? [];
    list.push(execution);
    executionsByInput.set(execution.inputId, list);
  }

  const usedExecutionIds = new Set<string>();
  const usedEventIds = new Set<string>();
  const usedApprovalIds = new Set<string>();
  const usedUserInputIds = new Set<string>();
  const turns = inputs.map((input): EngineInputTurn => {
    const inputExecutions = executionsByInput.get(input.id) ?? [];
    const inputExecutionIds = new Set(inputExecutions.map((execution) => execution.id));
    const inputEvents = events.filter((event) => {
      const matchesByInput = event.inputId === input.id;
      const matchesByExecution = Boolean(
        event.executionId && inputExecutionIds.has(event.executionId),
      );
      // Conflicting product identities are intentionally left in diagnostics.
      if (matchesByInput && event.executionId && !inputExecutionIds.has(event.executionId))
        return false;
      if (matchesByExecution && event.inputId && event.inputId !== input.id) return false;
      return (
        matchesByExecution ||
        (matchesByInput && (!event.executionId || inputExecutions.length === 1))
      );
    });
    inputEvents.forEach((event) => usedEventIds.add(event.id));
    const executionTurns = inputExecutions.map((execution): EngineExecutionTurn => {
      usedExecutionIds.add(execution.id);
      const executionEvents = inputEvents.filter(
        (event) =>
          event.executionId === execution.id ||
          (!event.executionId && inputExecutions.length === 1),
      );
      const approvals = history.approvals.filter(
        (item) => belongsToTask(item, task) && item.executionId === execution.id,
      );
      const userInputs = history.userInputs.filter(
        (item) => belongsToTask(item, task) && item.executionId === execution.id,
      );
      approvals.forEach((item) => usedApprovalIds.add(item.id));
      userInputs.forEach((item) => usedUserInputIds.add(item.id));
      const content = projectExecutionItems(execution.id, executionEvents);
      return {
        execution,
        events: executionEvents,
        deltas: content.deltas,
        items: content.items,
        approvals,
        userInputs,
      };
    });
    return {
      input,
      events: inputEvents.filter((event) => !event.executionId),
      executions: executionTurns,
    };
  });

  return {
    turns,
    unassociatedExecutions: executions.filter((execution) => !usedExecutionIds.has(execution.id)),
    unassociatedEvents: events.filter((event) => !usedEventIds.has(event.id)),
    unassociatedApprovals: history.approvals.filter(
      (item) => belongsToTask(item, task) && !usedApprovalIds.has(item.id),
    ),
    unassociatedUserInputs: history.userInputs.filter(
      (item) => belongsToTask(item, task) && !usedUserInputIds.has(item.id),
    ),
  };
}
