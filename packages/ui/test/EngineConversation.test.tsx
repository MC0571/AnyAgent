import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { buildManualSkillPrompt as buildM0ManualSkillPrompt } from "../../../apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts";

const taskId = "task-engine-ui";
const participantId = "participant-engine-ui";
const sessionId = "product-session-engine-ui";
const engineId = "fake-engine";
const available = { support: "supported", availability: "available" } as const;
const capabilities = {
  "session.create": available,
  "session.resume": available,
  "session.close": available,
  "execution.run": available,
  "execution.interrupt": available,
  "execution.reconcile": available,
  "events.stream": available,
  "events.tool": available,
  "events.file": available,
  "approval.respond": available,
  "user-input.respond": available,
  "assistant.feedback": available,
};
const currentEngine = {
  engineId,
  adapterVersion: "fake-adapter-1",
  engineVersion: "Fake Engine 1",
  configurationVersion: "cfg-1",
  environment: "workspace",
  capabilities,
  state: "current",
  observedAt: 1_000,
  source: "active-probe",
} as const;
const task = {
  id: taskId,
  authorizationId: "authorization-engine-ui",
  status: "active",
  createdAt: 900,
  updatedAt: 1_000,
  closedAt: null,
  closeReason: null,
  engine: {
    engineId,
    adapterVersion: "fake-adapter-1",
    engineVersion: "Fake Engine 1",
    configurationVersion: "cfg-1",
    environment: "workspace",
    capabilities,
  },
  currentEngine,
  environment: { id: "env-engine-ui", kind: "workspace", workDirectory: "/tmp/anyagent-ui" },
  credentialSource: { kind: "none" },
  participant: { id: participantId, status: "active", createdAt: 900 },
  session: {
    id: sessionId,
    status: "active",
    createdAt: 900,
    updatedAt: 1_000,
    environmentId: "env-engine-ui",
  },
};

function emptyHistory(forTaskId = taskId) {
  return {
    taskId: forTaskId,
    inputs: [] as Array<Record<string, unknown>>,
    executions: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    approvals: [] as Array<Record<string, unknown>>,
    userInputs: [] as Array<Record<string, unknown>>,
    stopRequests: [] as Array<Record<string, unknown>>,
    integrityIssues: [],
  };
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  win.matchMedia = ((media: string) => ({
    media,
    matches: false,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof win.matchMedia;
  win.HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof win.HTMLCanvasElement.prototype.getContext;
  win.Range.prototype.getBoundingClientRect = () => new win.DOMRect();
  win.HTMLElement.prototype.scrollIntoView = () => {};
  const legacyInputTarget = win.HTMLElement.prototype as HTMLElement & {
    attachEvent: (eventName: string, listener: EventListener) => void;
    detachEvent: (eventName: string, listener: EventListener) => void;
  };
  legacyInputTarget.attachEvent = function (eventName, listener) {
    this.addEventListener(eventName.replace(/^on/u, ""), listener);
  };
  legacyInputTarget.detachEvent = function (eventName, listener) {
    this.removeEventListener(eventName.replace(/^on/u, ""), listener);
  };
  Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.getAttribute("role") === "listbox" ? 224 : 0;
    },
  });
  win.Element.prototype.hasPointerCapture = () => false;
  win.Element.prototype.setPointerCapture = () => {};
  win.Element.prototype.releasePointerCapture = () => {};
  for (const [key, value] of Object.entries({
    window: win,
    document: win.document,
    navigator: win.navigator,
    customElements: win.customElements,
    Image: win.Image,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    Text: win.Text,
    Element: win.Element,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    FocusEvent: win.FocusEvent,
    Node: win.Node,
    DocumentFragment: win.DocumentFragment,
    NodeFilter: win.NodeFilter,
    SVGElement: win.SVGElement,
    CSSStyleSheet: win.CSSStyleSheet,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
    MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  return dom;
}

async function waitFor(assertion: () => void, message: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(message, { cause: lastError });
}

test("EngineConversation sends through the product composer and renders ordered streamed turns", async () => {
  const dom = installDom();
  const copiedCode: string[] = [];
  const openedFileLinks: string[] = [];
  const engineProbePaths: Array<string | undefined> = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => copiedCode.push(text) },
  });
  const [
    { EngineConversation },
    { useEngineComposerDrafts },
    { ServiceProvider },
    { PlatformProvider },
    { ZCodeIntlProvider },
    { TabStoreProvider },
    { TooltipProvider },
  ] = await Promise.all([
    import("../src/EngineConversation.js"),
    import("../src/app-shell/useEngineComposerDrafts.js"),
    import("../src/hooks/useServices.js"),
    import("../src/hooks/usePlatform.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/store/TabStoreProvider.js"),
    import("../src/components/ui/tooltip.js"),
  ]);

  const taskBId = "task-engine-b";
  let engineProjection: any = currentEngine;
  let activeTask: any = task;
  let activeTaskB: any = {
    ...task,
    id: taskBId,
    authorizationId: "authorization-engine-b",
    participant: { ...task.participant, id: "participant-engine-b" },
    session: { ...task.session, id: "product-session-engine-b" },
  };
  let history = emptyHistory();
  let historyB = emptyHistory(taskBId);
  let unavailableWorkspacePath: string | null = null;
  let nextRound = 0;
  let deliverySequence = 0;
  const changes = new Set<(change: { taskId: string; task: any; history: any }) => void>();
  const submissions: Array<{
    text: string;
    inputId: string;
    executionId: string;
    attachments?: Array<Record<string, unknown>>;
  }> = [];
  const queuedRequests: Array<{ text: string; delivery: string; idempotencyKey: string }> = [];
  const stagedAttachmentRequests: Array<Record<string, unknown>> = [];
  const selectedLocalPaths = ["/tmp/anyagent-ui/src/two.ts"];
  const replies: Array<{ approvalId: string; optionId: string }> = [];
  const feedbackRequests: Array<Record<string, unknown>> = [];
  const stopRequests: Array<{ taskId: string; executionId: string }> = [];
  const queueResumeRequests: string[] = [];
  let queueCancelGate: Promise<void> | null = null;
  let failNextSubmit = false;
  let clock = 1_000;
  const taskRecord = (id: string) => {
    const current = id === taskBId ? activeTaskB : activeTask;
    return { ...current, currentEngine: engineProjection };
  };
  const emit = (changedTaskId = taskId, changedHistory = history) => {
    for (const listener of changes) {
      listener({ taskId: changedTaskId, task: taskRecord(changedTaskId), history: changedHistory });
    }
  };
  const service = {
    onDidChange(listener: (change: { taskId: string; task: any; history: any }) => void) {
      changes.add(listener);
      return { dispose: () => changes.delete(listener) };
    },
    listEngines: async (workspace?: { workspacePath?: string }) => {
      engineProbePaths.push(workspace?.workspacePath);
      if (workspace?.workspacePath === unavailableWorkspacePath)
        throw new Error("Project directory unavailable");
      return [engineProjection];
    },
    listTasks: async () => [taskRecord(taskId), taskRecord(taskBId)],
    getTask: async (id: string) => taskRecord(id),
    getHistory: async (id: string) => (id === taskBId ? historyB : history),
    stageAttachment: async (input: Record<string, unknown>) => {
      stagedAttachmentRequests.push(input);
      return {
        id: `runtime-attachment-${stagedAttachmentRequests.length}`,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: 12,
      };
    },
    submitInput: async ({
      taskId: submittedTaskId,
      text,
      attachments,
      delivery,
      idempotencyKey,
    }: {
      taskId: string;
      text: string;
      attachments?: Array<Record<string, unknown>>;
      delivery?: string;
      idempotencyKey?: string;
    }) => {
      if (failNextSubmit) {
        failNextSubmit = false;
        throw new Error("Fake host rejected this input");
      }
      if (submittedTaskId !== taskId) throw new Error(`Unexpected task ${submittedTaskId}`);
      if (delivery === "queue") {
        assert.ok(idempotencyKey, "a queued request needs a stable retry identity");
        queuedRequests.push({ text, delivery, idempotencyKey });
        history = {
          ...history,
          inputs: [
            ...history.inputs,
            {
              id: "input-queued-test",
              taskId,
              participantId,
              sessionId,
              text,
              status: "queued",
              receivedAt: 1_001,
              acceptedAt: null,
              startedAt: null,
              terminalAt: null,
              error: null,
            },
          ],
        };
        emit();
        return;
      }
      nextRound += 1;
      const round = nextRound;
      const inputId = round === 1 ? "input-z-first" : "input-a-second";
      const executionId = round === 1 ? "execution-z-first" : "execution-a-second";
      history = {
        ...history,
        inputs: [
          ...history.inputs,
          {
            id: inputId,
            taskId,
            participantId,
            sessionId,
            text,
            status: "started",
            receivedAt: 1_000,
            acceptedAt: 1_000,
            startedAt: 1_000,
            terminalAt: null,
            error: null,
          },
        ],
        executions: [
          ...history.executions,
          {
            id: executionId,
            taskId,
            participantId,
            sessionId,
            inputId,
            status: "started",
            acceptedAt: 1_000,
            startedAt: 1_000,
            terminalAt: null,
            result: null,
            error: null,
          },
        ],
      };
      emit();
      submissions.push({ text, inputId, executionId, ...(attachments ? { attachments } : {}) });
    },
    cancelQueuedInput: async ({ inputId }: { inputId: string }) => {
      if (queueCancelGate) await queueCancelGate;
      history = {
        ...history,
        inputs: history.inputs.map((input) =>
          input.id === inputId ? { ...input, status: "cancelled", terminalAt: 1_002 } : input,
        ),
      };
      emit();
    },
    moveQueuedInput: async () => {},
    resumeQueuedInputs: async ({ taskId: resumedTaskId }: { taskId: string }) => {
      queueResumeRequests.push(resumedTaskId);
      activeTask = { ...activeTask, session: { ...activeTask.session, queuePaused: false } };
      emit();
    },
    sendQueuedInputNow: async () => ({
      priorityRestored: false,
      stopRequest: {
        status: "requested",
        deliveryStatus: "delivered",
        stopEvidence: null,
      },
    }),
    replyToApproval: async ({ approvalId, optionId }: { approvalId: string; optionId: string }) => {
      replies.push({ approvalId, optionId });
      history = {
        ...history,
        approvals: history.approvals.map((approval) =>
          approval.id === approvalId
            ? { ...approval, status: "rejected", repliedOptionId: optionId }
            : approval,
        ),
      };
      emit();
    },
    replyToUserInput: async () => {},
    setAssistantFeedback: async (input: Record<string, unknown>) => {
      feedbackRequests.push(input);
      return { status: "updated" };
    },
    requestStop: async ({
      taskId: requestedTaskId,
      executionId,
    }: {
      taskId: string;
      executionId: string;
    }) => {
      stopRequests.push({ taskId: requestedTaskId, executionId });
      clock += 1;
      history = {
        ...history,
        stopRequests: [
          ...history.stopRequests,
          {
            id: "stop-request-frozen",
            taskId,
            participantId,
            sessionId,
            executionId,
            requestedAt: clock,
            status: "requested",
            reason: null,
          },
        ],
      };
      emit();
    },
  };
  const services = {
    settingService: { get: async () => ({}) },
    clientConfigService: { getSnapshot: async () => ({ pluginStoreOrder: null }) },
    subagentsService: {
      list: async () => ({
        agents: [],
        userAgents: [],
        pluginAgents: [],
        capability: { userScopeAvailable: false },
      }),
    },
  };
  const platform = {
    canSelectFilePath: true,
    selectFiles: async () => selectedLocalPaths,
    onSettingsChanged: () => () => {},
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let reportedTitle = "";
  let refreshVersion = 0;
  let inspectorOpen = false;
  const appFor = (selectedTaskId: string, version = refreshVersion) =>
    createElement(
      TooltipProvider,
      null,
      createElement(
        ServiceProvider,
        { services: services as never },
        createElement(
          PlatformProvider,
          { platform: platform as never },
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(
              TabStoreProvider,
              null,
              createElement(EngineConversation, {
                service: service as never,
                selectedTaskId,
                onSelectTask: () => {},
                onTitleChange: (_taskId: string, title: string) => {
                  reportedTitle = title;
                },
                onOpenFileLink: (target: { path: string; workspacePath?: string }) => {
                  openedFileLinks.push(`${target.workspacePath}:${target.path}`);
                },
                refreshVersion: version,
                inspectorOpen,
                onInspectorOpenChange: (open: boolean) => {
                  inspectorOpen = open;
                },
              }),
            ),
          ),
        ),
      ),
    );

  try {
    await act(async () => {
      root.render(appFor(taskId));
    });
    await waitFor(() => {
      const input = document.querySelector<HTMLElement>('[data-testid="engine-composer-input"]');
      assert.equal(input?.getAttribute("data-e2e-lexical-bridge"), "ready");
      assert.equal(
        (input as HTMLElement & { __zcodeLexicalInputE2E?: unknown }).__zcodeLexicalInputE2E !==
          undefined,
        true,
      );
      assert.equal(
        (
          document.querySelector(
            '[data-testid="engine-composer-submit"]',
          ) as HTMLButtonElement | null
        )?.disabled,
        false,
      );
    }, "product composer did not become ready");
    const composer = container.querySelector(".chat-composer-region");
    const modelTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-select-trigger"]',
    );
    const permissionModeTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-mode-select-trigger"]',
    );
    const thoughtLevelTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-thought-level-select-trigger"]',
    );
    const addContextTrigger = container
      .querySelector<SVGElement>("[data-composer-leading-content] svg.lucide-plus")
      ?.closest("button") as HTMLButtonElement | null;
    const composerSubmit = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]');
    assert.ok(composer?.querySelector(".chat-composer-input-surface"));
    assert.ok(modelTrigger?.closest("[data-composer-trailing-actions]"));
    assert.equal(modelTrigger.getAttribute("data-model-current-value"), `harness:${engineId}`);
    assert.ok(permissionModeTrigger, "the native permission mode control remains visible");
    assert.equal(permissionModeTrigger.disabled, true);
    assert.match(
      permissionModeTrigger.getAttribute("aria-label") ?? "",
      /AnyAgent 当前 Harness 接入尚未映射权限\/执行模式设置/,
    );
    assert.match(permissionModeTrigger.textContent ?? "", /接入未映射/);
    assert.ok(thoughtLevelTrigger, "the native thought level control remains visible");
    assert.equal(thoughtLevelTrigger.disabled, true);
    assert.match(
      thoughtLevelTrigger.getAttribute("aria-label") ?? "",
      /AnyAgent 当前 Harness 接入尚未映射推理档位设置/,
    );
    assert.match(thoughtLevelTrigger.textContent ?? "", /接入未映射/);
    assert.ok(addContextTrigger, "the native + action remains visible");
    assert.equal(addContextTrigger.disabled, false);
    assert.ok(engineProbePaths.includes("/tmp/anyagent-ui"));
    const conversationScroll = container.querySelector<HTMLElement>(
      '[data-testid="engine-conversation-scroll"]',
    );
    assert.ok(conversationScroll);
    Object.defineProperties(conversationScroll, {
      scrollHeight: { configurable: true, get: () => 600 },
      clientHeight: { configurable: true, get: () => 100 },
    });

    const send = async (text: string) => {
      const input = document.querySelector<HTMLElement>(
        '[data-testid="engine-composer-input"]',
      ) as HTMLElement & {
        __zcodeLexicalInputE2E: { setText: (value: string) => void };
      };
      await act(async () => {
        input.__zcodeLexicalInputE2E.setText(text);
      });
      await act(async () => {
        (
          document.querySelector('[data-testid="engine-composer-submit"]') as HTMLButtonElement
        ).click();
      });
      await waitFor(
        () => assert.equal(submissions.length, nextRound),
        `composer did not submit round ${nextRound}`,
      );
    };
    const sendDelta = async (round: number, text: string, withNativeIdentity: boolean) => {
      const submission = submissions[round - 1]!;
      deliverySequence += 1;
      const payload: Record<string, unknown> = { text };
      if (withNativeIdentity) {
        payload.messageId = `native-message-${round}`;
        payload.blockId = "text-block";
      }
      const eventId = `event-${round}-${deliverySequence}`;
      const event = {
        id: eventId,
        taskId,
        participantId,
        sessionId,
        inputId: submission.inputId,
        executionId: submission.executionId,
        nativeEventId: `native-${round}-${deliverySequence}`,
        streamId: `stream-${round}`,
        sourceSequence: deliverySequence,
        deliverySequence,
        observedAt: 1_000 + deliverySequence,
        source: "engine",
        type: "message.delta",
        payload,
        duplicateOf: null,
      };
      await act(async () => {
        history = {
          ...history,
          events: [
            ...history.events,
            event,
            ...(round === 1 && deliverySequence === 1
              ? [
                  {
                    ...event,
                    id: `${eventId}-redelivery`,
                    nativeEventId: `${event.nativeEventId}-redelivery`,
                    deliverySequence: deliverySequence + 10_000,
                    duplicateOf: eventId,
                  },
                ]
              : []),
          ],
        };
        emit();
      });
    };
    const finish = async (round: number, result: string) => {
      const submission = submissions[round - 1]!;
      await act(async () => {
        history = {
          ...history,
          inputs: history.inputs.map((input) =>
            input.id === submission.inputId
              ? { ...input, status: "completed", terminalAt: 1_010 }
              : input,
          ),
          executions: history.executions.map((execution) =>
            execution.id === submission.executionId
              ? { ...execution, status: "completed", terminalAt: 1_010, result }
              : execution,
          ),
        };
        emit();
      });
    };

    const firstStream = "First **answer** and code:\n\n```ts\nconst round = 1;\n```";
    const firstAnswer = `${firstStream}\n\nFinal line. [README.md](README.md)`;
    await act(async () => addContextTrigger.click());
    assert.equal(addContextTrigger.getAttribute("aria-expanded"), "true");
    await waitFor(
      () =>
        assert.ok(
          document.querySelector('[data-testid="engine-composer-attachment-menu-item"]'),
          "the native + menu should expose the attachment action",
        ),
      "attachment action did not appear in the native composer menu",
    );
    const attachmentMenuItem = document.querySelector<HTMLElement>(
      '[data-testid="engine-composer-attachment-menu-item"]',
    );
    assert.ok(attachmentMenuItem);
    const attachmentOption = attachmentMenuItem.closest<HTMLElement>('[role="option"]');
    assert.ok(attachmentOption);
    await act(async () => {
      attachmentOption.dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });
    await waitFor(
      () => assert.ok(container.querySelector('[data-testid="engine-composer-attachment-0"]')),
      "the selected local file should appear as a removable native attachment chip",
    );
    const firstInput = container.querySelector<HTMLElement>(
      '[data-testid="engine-composer-input"]',
    ) as HTMLElement & {
      __zcodeLexicalInputE2E: {
        setTextWithPluginMentions: (value: string) => void;
      };
    };
    const structuredMentionPrompt = "first request [@Review Plugin](plugin://openai.review@1.0.0)";
    await act(async () =>
      firstInput.__zcodeLexicalInputE2E.setTextWithPluginMentions(structuredMentionPrompt),
    );
    failNextSubmit = true;
    await act(async () => composerSubmit()?.click());
    await waitFor(
      () => assert.ok(document.body.textContent?.includes("Fake host rejected this input")),
      "failed submission should report the Host rejection",
    );
    assert.ok(
      container.querySelector('[data-testid="engine-composer-attachment-0"]'),
      "a rejected submission should preserve the selected attachment",
    );
    assert.equal(submissions.length, 0);
    assert.equal(
      dom.window.localStorage.getItem("zcode-chat-prompt-history:/tmp/anyagent-ui"),
      null,
      "a rejected input must not enter native prompt history",
    );
    await act(async () => composerSubmit()?.click());
    await waitFor(() => assert.equal(submissions.length, 1), "attachment retry was not submitted");
    assert.deepEqual(stagedAttachmentRequests, [
      {
        taskId,
        participantId,
        sessionId,
        authorizationId: "authorization-engine-ui",
        localPath: "/tmp/anyagent-ui/src/two.ts",
        fileName: "two.ts",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
      },
      {
        taskId,
        participantId,
        sessionId,
        authorizationId: "authorization-engine-ui",
        localPath: "/tmp/anyagent-ui/src/two.ts",
        fileName: "two.ts",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
      },
    ]);
    assert.deepEqual(submissions[0]?.attachments, [
      {
        id: "runtime-attachment-2",
        fileName: "two.ts",
        mimeType: "application/octet-stream",
        sizeBytes: 12,
      },
    ]);
    assert.equal(
      submissions[0]?.text,
      structuredMentionPrompt,
      "structured @ Plugin mention markdown should survive submit alongside staged attachments",
    );
    await waitFor(
      () =>
        assert.equal(container.querySelector('[data-testid="engine-composer-attachments"]'), null),
      "accepted submission should clear the attachment chip",
    );
    const conversationTimeline = container.querySelector(
      '[data-testid="engine-conversation-timeline"]',
    );
    assert.ok(conversationTimeline);
    assert.doesNotMatch(conversationTimeline.textContent ?? "", /Execution execution-/);
    assert.doesNotMatch(conversationTimeline.textContent ?? "", /当前轮次尚未结束/);
    assert.equal(
      container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')
        ?.disabled,
      false,
      "the same native composer should accept a queued next turn while Execution is active",
    );
    assert.equal(composerSubmit()?.getAttribute("aria-label"), "加入队列");
    const queueDraft = document.querySelector<HTMLElement>(
      '[data-testid="engine-composer-input"]',
    ) as HTMLElement & {
      __zcodeLexicalInputE2E: { setText: (value: string) => void; getText: () => string };
    };
    await act(async () => queueDraft.__zcodeLexicalInputE2E.setText("Queued while running"));
    await act(async () => composerSubmit()?.click());
    await waitFor(
      () => assert.equal(queuedRequests.length, 1),
      "busy send should be admitted as a queued product Input",
    );
    assert.equal(queuedRequests[0]?.text, "Queued while running");
    await waitFor(
      () =>
        assert.match(
          container.querySelector('[data-testid="v4-queue"]')?.textContent ?? "",
          /Queued while running/,
        ),
      "queued Input should use the native queue panel",
    );
    assert.equal(
      container.querySelector('[data-testid="engine-input-input-queued-test"]'),
      null,
      "a queued Input has not reached the Engine and is not a conversation message",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="v4-queue-item-edit-input-queued-test"]')
        ?.click(),
    );
    await waitFor(() => assert.equal(container.querySelector('[data-testid="v4-queue"]'), null));
    assert.equal(queueDraft.__zcodeLexicalInputE2E.getText(), "Queued while running");
    await act(async () => composerSubmit()?.click());
    await waitFor(() => assert.equal(queuedRequests.length, 2));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="v4-queue-item-send-now-input-queued-test"]',
        )
        ?.click(),
    );
    assert.equal(
      container.querySelector('[data-testid="engine-input-input-queued-test"]'),
      null,
      "send-now request alone must not create a dispatched conversation message",
    );
    history = {
      ...history,
      inputs: history.inputs.map((input) =>
        input.id === "input-queued-test" && input.status === "queued"
          ? {
              ...input,
              attachments: [
                { id: "old-attachment", fileName: "old.txt", mimeType: "text/plain", sizeBytes: 4 },
              ],
            }
          : input,
      ),
    };
    await act(async () => emit());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="v4-queue-item-edit-input-queued-test"]')
        ?.click(),
    );
    assert.match(
      container.querySelector('[data-testid="v4-queue"]')?.textContent ?? "",
      /Queued while running/,
    );
    const beforeQueuePause = history;
    history = {
      ...history,
      inputs: history.inputs.map((input) =>
        input.status === "started" ? { ...input, status: "completed" } : input,
      ),
      executions: history.executions.map((execution) =>
        execution.status === "started" ? { ...execution, status: "completed" } : execution,
      ),
    };
    activeTask = { ...activeTask, session: { ...activeTask.session, queuePaused: true } };
    await act(async () => emit());
    assert.equal(
      container.querySelector('[data-testid="v4-queue"]')?.getAttribute("data-queue-auto-drain"),
      "false",
    );
    assert.ok(container.querySelector('[data-testid="v4-queue-paused-banner"]'));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="v4-queue-resume"]')?.click(),
    );
    await waitFor(() => assert.deepEqual(queueResumeRequests, [taskId]));
    await waitFor(() =>
      assert.equal(
        container.querySelector('[data-testid="v4-queue"]')?.getAttribute("data-queue-auto-drain"),
        "true",
      ),
    );
    history = beforeQueuePause;
    await act(async () => emit());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="v4-queue-item-delete-input-queued-test"]')
        ?.click(),
    );
    await waitFor(
      () => assert.equal(container.querySelector('[data-testid="v4-queue"]'), null),
      "cancelled queue item should leave the native queue panel",
    );
    assert.equal(
      container.querySelector('[data-testid="engine-input-input-queued-test"]'),
      null,
      "cancelled pre-dispatch Input should not become a user message",
    );
    assert.equal(container.querySelector(".chat-composer-region"), composer);
    assert.equal(
      container.querySelector('[data-testid="chat-model-select-trigger"]'),
      modelTrigger,
      "sending should keep the native composer and model selector mounted",
    );
    assert.equal(
      container.querySelector('[data-testid="chat-mode-select-trigger"]'),
      permissionModeTrigger,
      "sending should keep the disabled native permission mode control mounted",
    );
    assert.equal(
      container.querySelector('[data-testid="chat-thought-level-select-trigger"]'),
      thoughtLevelTrigger,
      "sending should keep the disabled native thought level control mounted",
    );
    assert.equal(
      container
        .querySelector<SVGElement>("[data-composer-leading-content] svg.lucide-plus")
        ?.closest("button")?.disabled,
      true,
      "the native + action should be disabled while the Host is handling the submission",
    );
    permissionModeTrigger.click();
    thoughtLevelTrigger.click();
    assert.equal(permissionModeTrigger.disabled, true);
    assert.equal(thoughtLevelTrigger.disabled, true);
    assert.equal(
      container
        .querySelector<SVGElement>("[data-composer-leading-content] svg.lucide-plus")
        ?.closest("button")?.disabled,
      true,
    );
    await waitFor(
      () => assert.equal(reportedTitle, structuredMentionPrompt),
      "native header title did not follow the first input",
    );
    await sendDelta(1, "First **answer** and code:\n\n```ts\n", true);
    assert.equal(conversationScroll.scrollTop, 500, "streaming should follow the visible tail");
    assert.match(
      container.querySelector('[data-testid="engine-answer-execution-z-first"]')?.textContent ?? "",
      /First answer and code/,
      "delta should be readable while the execution is still running",
    );
    await act(async () => {
      conversationScroll.scrollTop = 100;
      conversationScroll.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    await sendDelta(1, "const round = 1;\n```", true);
    assert.equal(
      conversationScroll.scrollTop,
      100,
      "reading older turns should keep scroll position",
    );
    const first = submissions[0]!;
    await act(async () => {
      history = {
        ...history,
        approvals: [
          {
            id: "approval-reject-first",
            taskId,
            participantId,
            sessionId,
            executionId: first.executionId,
            operation: "run command",
            scope: "workspace",
            options: [{ id: "reject", label: "拒绝", decision: "reject" }],
            expiresAt: 5_000,
            status: "pending",
            repliedOptionId: null,
          },
        ],
      };
      emit();
    });
    const reject = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "拒绝",
    );
    assert.ok(reject, "approval should appear inside the execution conversation");
    await act(async () => reject!.click());
    await waitFor(
      () =>
        assert.deepEqual(replies, [{ approvalId: "approval-reject-first", optionId: "reject" }]),
      "approval reply was not sent",
    );
    await act(async () => {
      conversationScroll.scrollTop = 470;
      conversationScroll.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    await finish(1, firstAnswer);
    assert.equal(conversationScroll.scrollTop, 500, "returning near the tail resumes following");
    const likeButton = container.querySelector<HTMLButtonElement>('button[aria-label="赞"]');
    assert.ok(likeButton, "native assistant message actions should expose Runtime-backed Like");
    await act(async () => likeButton.click());
    await waitFor(
      () =>
        assert.deepEqual(feedbackRequests, [
          {
            taskId,
            participantId,
            sessionId,
            authorizationId: "authorization-engine-ui",
            executionId: "execution-z-first",
            messageId: "native-message-1",
            feedback: "like",
          },
        ]),
      "Like did not retain the originating Task, Session, Execution and native message identity",
    );
    await waitFor(
      () =>
        assert.equal(
          container.querySelector('button[aria-label="已赞"]')?.getAttribute("aria-pressed"),
          "true",
        ),
      "successful native Like should keep the message action selected",
    );
    const fileLink = container.querySelector<HTMLButtonElement>(
      'button[title="/tmp/anyagent-ui/README.md"]',
    );
    assert.ok(fileLink, "Engine Markdown should reuse the native file link component");
    await act(async () => fileLink.click());
    assert.deepEqual(openedFileLinks, ["/tmp/anyagent-ui:/tmp/anyagent-ui/README.md"]);
    assert.equal(
      container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')
        ?.disabled,
      false,
      "the same Task may continue once the previous turn has ended",
    );
    await act(async () => {
      history = {
        ...history,
        events: [
          ...history.events,
          {
            id: "tool-event-start",
            taskId,
            participantId,
            sessionId,
            inputId: first.inputId,
            executionId: first.executionId,
            nativeEventId: "native-tool-start",
            streamId: "tool-stream",
            sourceSequence: 100,
            deliverySequence: 100,
            observedAt: 1_100,
            source: "adapter",
            type: "tool.started",
            payload: {
              toolCallId: "tool-native-row",
              name: "read_file",
              input: { path: "README.md" },
            },
            duplicateOf: null,
          },
          {
            id: "tool-event-complete",
            taskId,
            participantId,
            sessionId,
            inputId: first.inputId,
            executionId: first.executionId,
            nativeEventId: "native-tool-complete",
            streamId: "tool-stream",
            sourceSequence: 101,
            deliverySequence: 101,
            observedAt: 1_101,
            source: "adapter",
            type: "tool.completed",
            payload: { toolCallId: "tool-native-row", name: "read_file", result: "ok" },
            duplicateOf: null,
          },
        ],
      };
      emit();
    });
    assert.ok(
      container.querySelector('[data-testid="chat-tool-call-block-tool-native-row"]'),
      "Engine tool events should use the original ZCode ToolCallBlock",
    );
    await waitFor(
      () =>
        assert.equal(
          (
            document.querySelector('[data-testid="engine-composer-input"]') as HTMLElement & {
              __zcodeLexicalInputE2E: { getText: () => string };
            }
          ).__zcodeLexicalInputE2E.getText(),
          "",
        ),
      "successful button submission should clear the product composer",
    );
    assert.deepEqual(
      JSON.parse(
        dom.window.localStorage.getItem("zcode-chat-prompt-history:/tmp/anyagent-ui") ?? "[]",
      ),
      [structuredMentionPrompt, "Queued while running"],
      "accepted direct and queued inputs should reuse the existing workspace prompt history",
    );
    const historyInput = document.querySelector('[data-testid="engine-composer-input"]') as
      | (HTMLElement & {
          __zcodeLexicalInputE2E: { getText: () => string; setText: (text: string) => void };
        })
      | null;
    assert.ok(historyInput);
    await act(async () => {
      historyInput.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    });
    assert.equal(historyInput.__zcodeLexicalInputE2E.getText(), "Queued while running");
    await act(async () => {
      historyInput.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    });
    assert.equal(historyInput.__zcodeLexicalInputE2E.getText(), structuredMentionPrompt);
    await act(async () => historyInput.__zcodeLexicalInputE2E.setText(""));

    const secondAnswer = "Second round fragment one · fragment two";
    await send("second request");
    await sendDelta(2, "Second round fragment one · ", false);
    await sendDelta(2, "fragment two", false);
    await finish(2, secondAnswer);

    const turns = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid^="engine-turn-"]'),
    );
    assert.deepEqual(
      turns.map((turn) => turn.getAttribute("data-testid")),
      ["engine-turn-input-z-first", "engine-turn-input-a-second"],
      "same-millisecond turns must retain the service's stable insertion order even when IDs sort oppositely",
    );
    assert.match(turns[0]!.textContent ?? "", /first request[\s\S]*First answer and code/);
    assert.doesNotMatch(
      container.querySelector('[data-testid="engine-input-input-z-first"]')?.textContent ?? "",
      /输入 · 已完成/,
      "completed input should use the native user bubble without extra status chrome",
    );
    assert.equal(
      (turns[0]!.textContent?.match(/First answer and code/g) ?? []).length,
      1,
      "a duplicate delta delivery must not duplicate answer text",
    );
    assert.match(
      turns[1]!.textContent ?? "",
      /second request[\s\S]*Second round fragment one[\s\S]*fragment two/,
    );
    assert.equal(
      container.querySelector('[data-testid="engine-answer-execution-z-first"]'),
      null,
      "a longer final answer must replace its streamed prefix",
    );
    assert.match(
      container.querySelector('[data-testid="engine-final-execution-z-first"]')?.textContent ?? "",
      /Final line/,
    );
    const codeBlock = container.querySelector<HTMLElement>(
      '[data-testid="engine-final-execution-z-first"] [data-language="ts"]',
    );
    assert.ok(codeBlock, "existing Markdown rendering should produce a TypeScript code block");
    const copyCodeButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="engine-final-execution-z-first"] button',
      ),
    ).find((button) => button.getAttribute("aria-label") === "复制代码");
    assert.ok(copyCodeButton, "existing code-block actions should be rendered");
    await act(async () => copyCodeButton.click());
    await waitFor(
      () => assert.ok(copiedCode.includes("const round = 1;")),
      "the rendered Markdown code block should preserve its source text",
    );
    assert.equal(
      container.querySelectorAll('[data-testid="engine-answer-execution-a-second"]').length,
      2,
      "fragments without native message identity must remain separate readable blocks",
    );
    assert.deepEqual(
      submissions.map(({ text }) => text),
      [structuredMentionPrompt, "second request"],
      "the real ChatPromptEditor must submit the user's current composer text",
    );

    assert.equal(
      document.body.querySelector('[data-testid="engine-diagnostic-inspector"]'),
      null,
      "diagnostics must not occupy the conversation by default",
    );
    inspectorOpen = true;
    await act(async () => root.render(appFor(taskId)));
    const diagnostic = document.body.querySelector<HTMLElement>(
      '[data-testid="engine-diagnostic-inspector"]',
    );
    assert.ok(diagnostic);
    const historicalSnapshot = structuredClone(activeTask.engine);
    assert.match(diagnostic.textContent ?? "", /配置版本：cfg-1/);
    inspectorOpen = false;
    await act(async () => root.render(appFor(taskId)));
    const checkCapability = async (
      capability: { support: string; availability: string; reason?: string },
      state: "current" | "unknown",
      disabled: boolean,
      reason: string,
    ) => {
      clock += 1;
      engineProjection = {
        ...engineProjection,
        state,
        source: state === "current" ? "active-probe" : "unknown",
        observedAt: state === "current" ? clock : null,
        capabilities: { ...engineProjection.capabilities, "execution.run": capability },
      };
      activeTask = { ...activeTask, currentEngine: engineProjection };
      activeTaskB = { ...activeTaskB, currentEngine: engineProjection };
      await act(async () => root.render(appFor(taskId, ++refreshVersion)));
      await waitFor(() => {
        assert.equal(composerSubmit()?.disabled, disabled);
        if (reason) assert.ok(container.textContent?.includes(reason));
      }, `current capability should render ${reason}`);
      assert.deepEqual(
        activeTask.engine,
        historicalSnapshot,
        "current capability refresh must not rewrite the historical task snapshot",
      );
    };
    await checkCapability(
      { support: "supported", availability: "temporarily-unavailable" },
      "current",
      true,
      "此操作暂时不可用",
    );
    await checkCapability(
      { support: "supported", availability: "authorization-required" },
      "current",
      true,
      "需要授权后才能继续",
    );
    await checkCapability(
      { support: "unknown", availability: "unknown" },
      "current",
      true,
      "暂时无法确认此操作是否可用",
    );
    await checkCapability(
      { support: "unsupported", availability: "unknown" },
      "current",
      true,
      "此操作当前不可用",
    );
    await checkCapability(available, "unknown", true, "暂时无法确认此对话是否可继续");
    await checkCapability(available, "current", false, "");

    const composerInput = () =>
      container.querySelector<HTMLElement>(
        '[data-testid="engine-composer-input"]',
      ) as HTMLElement & {
        __zcodeLexicalInputE2E: { setText: (value: string) => void; getText: () => string };
      };
    failNextSubmit = true;
    await act(async () => composerInput().__zcodeLexicalInputE2E.setText("keep this draft"));
    await act(async () => composerSubmit()?.click());
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(composerInput().__zcodeLexicalInputE2E.getText(), "keep this draft");

    const frozenInputId = "input-frozen-running";
    const frozenExecutionId = "execution-frozen-running";
    await act(async () => {
      activeTask = { ...activeTask, status: "frozen" };
      history = {
        ...history,
        inputs: [
          ...history.inputs,
          {
            id: frozenInputId,
            taskId,
            participantId,
            sessionId,
            text: "inspect running execution",
            status: "started",
            receivedAt: 2_000,
            acceptedAt: 2_000,
            startedAt: 2_000,
            terminalAt: null,
            error: null,
          },
        ],
        executions: [
          ...history.executions,
          {
            id: frozenExecutionId,
            taskId,
            participantId,
            sessionId,
            inputId: frozenInputId,
            status: "started",
            acceptedAt: 2_000,
            startedAt: 2_000,
            terminalAt: null,
            result: null,
            error: null,
          },
        ],
      };
      emit();
    });
    await waitFor(() => {
      const stopButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.includes("请求中断"),
      );
      assert.ok(stopButton && !stopButton.disabled);
      assert.equal(composerSubmit()?.disabled, true, "frozen Task should reject new input");
    }, "frozen Task should allow requesting an interrupt for its running Execution");
    const interruptButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("请求中断"));
    assert.ok(interruptButton);
    await act(async () => interruptButton.click());
    await waitFor(
      () => assert.deepEqual(stopRequests, [{ taskId, executionId: frozenExecutionId }]),
      "interrupt request should be sent for the selected running Execution",
    );
    await waitFor(
      () => assert.match(container.textContent ?? "", /等待停止确认/),
      "requested interruption should remain distinct from confirmed stopping",
    );
    assert.equal(history.executions.at(-1)?.status, "started");
    await act(async () => {
      clock += 1;
      deliverySequence += 1;
      history = {
        ...history,
        inputs: history.inputs.map((input) =>
          input.id === frozenInputId ? { ...input, status: "stopped", terminalAt: clock } : input,
        ),
        executions: history.executions.map((execution) =>
          execution.id === frozenExecutionId
            ? { ...execution, status: "stopped", terminalAt: clock }
            : execution,
        ),
        events: [
          ...history.events,
          {
            id: "native-confirmed-stop",
            taskId,
            participantId,
            sessionId,
            inputId: frozenInputId,
            executionId: frozenExecutionId,
            nativeEventId: "native-confirmed-stop",
            streamId: "stream-stop",
            sourceSequence: deliverySequence,
            deliverySequence,
            observedAt: clock,
            source: "engine",
            type: "execution.stopped",
            payload: { evidence: { kind: "fake-test" } },
            duplicateOf: null,
          },
        ],
        stopRequests: history.stopRequests.map((stop) => ({ ...stop, status: "confirmed" })),
      };
      emit();
    });
    await waitFor(
      () => assert.match(container.textContent ?? "", /已确认停止/),
      "confirmed stop evidence should update the execution state",
    );
    assert.equal(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("等待停止确认"),
      ),
      false,
    );

    activeTaskB = {
      ...activeTaskB,
      environment: {
        ...activeTaskB.environment,
        id: "env-engine-b",
        workDirectory: "/tmp/missing-project",
      },
      session: { ...activeTaskB.session, environmentId: "env-engine-b" },
    };
    historyB = {
      ...historyB,
      inputs: [
        {
          id: "input-project-history",
          taskId: taskBId,
          participantId: activeTaskB.participant.id,
          sessionId: activeTaskB.session.id,
          text: "Recovered prompt after project removal",
          status: "completed",
          receivedAt: 2_100,
          acceptedAt: 2_100,
          startedAt: 2_100,
          terminalAt: 2_110,
          error: null,
        },
      ],
    };
    unavailableWorkspacePath = "/tmp/missing-project";
    inspectorOpen = true;
    await act(async () => root.render(appFor(taskBId)));
    await waitFor(
      () =>
        assert.match(
          document.body.querySelector('[data-testid="engine-diagnostic-inspector"]')?.textContent ??
            "",
          /task-engine-b/,
        ),
      "selecting Task B should load its own conversation",
    );
    assert.match(container.textContent ?? "", /Recovered prompt after project removal/);
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(composerSubmit()?.disabled, true);
    await act(async () => {
      clock += 1;
      deliverySequence += 1;
      history = {
        ...history,
        events: [
          ...history.events,
          {
            id: "late-event-from-task-a",
            taskId,
            participantId,
            sessionId,
            inputId: frozenInputId,
            executionId: frozenExecutionId,
            nativeEventId: "late-event-from-task-a",
            streamId: "stream-late-a",
            sourceSequence: deliverySequence,
            deliverySequence,
            observedAt: clock,
            source: "engine",
            type: "message.delta",
            payload: { text: "Late event from Task A" },
            duplicateOf: null,
          },
        ],
      };
      emit(taskId, history);
    });
    assert.match(
      document.body.querySelector('[data-testid="engine-diagnostic-inspector"]')?.textContent ?? "",
      /task-engine-b/,
    );
    assert.doesNotMatch(container.textContent ?? "", /Late event from Task A/);
    assert.doesNotMatch(container.textContent ?? "", /inspect running execution/);

    // The shell owner stays mounted when a keyed Task or main page changes while
    // cancellation is pending. The ACK must restore the draft to its source Task.
    let queueControls: ReturnType<typeof useEngineComposerDrafts> | null = null;
    function QueueEditWorkspace({
      selectedTaskId,
      page,
    }: {
      selectedTaskId: string;
      page: "engine" | "automations";
    }) {
      const drafts = useEngineComposerDrafts("/tmp/anyagent-ui", undefined, selectedTaskId);
      queueControls = drafts;
      return page === "engine"
        ? createElement(EngineConversation, {
            key: selectedTaskId,
            service: service as never,
            selectedTaskId,
            onSelectTask: () => {},
            composerDraft: drafts.drafts[selectedTaskId],
            onRecoveredDraftChange: drafts.onRecoveredDraftChange,
            onRecoveredConfigChange: drafts.onRecoveredConfigChange,
            onComposerDraftSubmitted: drafts.onSubmitted,
            onQueueEditPrepare: drafts.onQueueEditPrepare,
            onQueueDraftRecovered: drafts.onQueueRecovered,
            onQueueRecoveryReconcile: drafts.onQueueRecoveryReconcile,
          })
        : createElement("div", { "data-testid": "automation-page" });
    }
    const queueAppFor = (selectedTaskId: string, page: "engine" | "automations" = "engine") =>
      createElement(
        TooltipProvider,
        null,
        createElement(
          ServiceProvider,
          { services: services as never },
          createElement(
            PlatformProvider,
            { platform: platform as never },
            createElement(
              ZCodeIntlProvider,
              { initialLocale: "zh-CN" },
              createElement(
                TabStoreProvider,
                null,
                createElement(QueueEditWorkspace, { selectedTaskId, page }),
              ),
            ),
          ),
        ),
      );
    engineProjection = currentEngine;
    activeTask = { ...task, currentEngine };
    unavailableWorkspacePath = null;
    history = {
      ...emptyHistory(),
      inputs: [
        {
          id: "input-queued-late",
          taskId,
          participantId,
          sessionId,
          text: "Recovered after navigation",
          status: "queued",
          receivedAt: 3_000,
          acceptedAt: null,
          startedAt: null,
          terminalAt: null,
          error: null,
        },
      ],
    };
    await act(async () => root.render(queueAppFor(taskId)));
    await waitFor(() =>
      assert.ok(container.querySelector('[data-testid="v4-queue-item-edit-input-queued-late"]')),
    );
    let releaseQueueCancel!: () => void;
    queueCancelGate = new Promise<void>((resolve) => {
      releaseQueueCancel = resolve;
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="v4-queue-item-edit-input-queued-late"]')
        ?.click(),
    );
    assert.equal(history.inputs[0]?.status, "queued", "Host cancellation is still pending");
    await act(async () => root.render(queueAppFor(taskBId)));
    await act(async () => root.render(queueAppFor(taskBId, "automations")));
    assert.ok(container.querySelector('[data-testid="automation-page"]'));
    await act(async () => releaseQueueCancel());
    await waitFor(() => assert.equal(history.inputs[0]?.status, "cancelled"));
    await act(async () => root.render(queueAppFor(taskId)));
    await waitFor(() => {
      const editor = container.querySelector<HTMLElement>(
        '[data-testid="engine-composer-input"]',
      ) as HTMLElement & { __zcodeLexicalInputE2E?: { getText: () => string } };
      assert.equal(editor?.__zcodeLexicalInputE2E?.getText(), "Recovered after navigation");
    });
    queueCancelGate = null;

    const { readV4ComposerDraft } = await import("../src/v4/composer/composerDraftStore.js");
    assert.equal(
      readV4ComposerDraft("/tmp/anyagent-ui", undefined, `anyagent-queue-edit:${taskId}`)?.text,
      "Recovered after navigation",
    );
    assert.equal(
      queueControls!.onQueueEditPrepare(taskBId, "queued-before-restart", {
        text: "Only after cancellation",
        config: { mode: "plan" },
      }),
      true,
    );
    historyB = {
      ...emptyHistory(taskBId),
      inputs: [
        {
          id: "queued-before-restart",
          taskId: taskBId,
          participantId: activeTaskB.participant.id,
          sessionId: activeTaskB.session.id,
          text: "Only after cancellation",
          status: "queued",
          receivedAt: 4_000,
        },
      ],
    };
    // Unmount the owner as an App restart would, leaving only the existing V4 draft store.
    await act(async () => root.render(appFor(taskBId)));
    queueControls = null;
    await act(async () => root.render(queueAppFor(taskBId)));
    await waitFor(() =>
      assert.equal(
        container
          .querySelector<HTMLElement>('[data-testid="engine-composer-input"]')
          ?.__zcodeLexicalInputE2E?.getText(),
        "",
      ),
    );
    historyB = {
      ...historyB,
      inputs: historyB.inputs.map((input) =>
        input.id === "queued-before-restart" ? { ...input, status: "cancelled" } : input,
      ),
    };
    await act(async () => emit(taskBId, historyB));
    await waitFor(() =>
      assert.equal(
        container
          .querySelector<HTMLElement>('[data-testid="engine-composer-input"]')
          ?.__zcodeLexicalInputE2E?.getText(),
        "Only after cancellation",
      ),
    );
    assert.equal(
      readV4ComposerDraft("/tmp/anyagent-ui", undefined, `anyagent-queue-edit:${taskBId}`)
        ?.queueEditOriginalMode,
      "plan",
    );
    const recoveredB = container.querySelector<HTMLElement>(
      '[data-testid="engine-composer-input"]',
    ) as HTMLElement & { __zcodeLexicalInputE2E: { setText: (value: string) => void } };
    await act(async () => recoveredB.__zcodeLexicalInputE2E.setText(""));
    await waitFor(() =>
      assert.equal(
        readV4ComposerDraft("/tmp/anyagent-ui", undefined, `anyagent-queue-edit:${taskBId}`),
        null,
      ),
    );
    await act(async () => recoveredB.__zcodeLexicalInputE2E.setText("ordinary draft"));
    assert.equal(
      readV4ComposerDraft("/tmp/anyagent-ui", undefined, `anyagent-queue-edit:${taskBId}`),
      null,
      "ordinary Composer text must not become a queue recovery draft",
    );
    await act(async () => recoveredB.__zcodeLexicalInputE2E.setText(""));
    historyB = {
      ...historyB,
      inputs: [
        ...historyB.inputs,
        {
          id: "queue-storage-failure",
          taskId: taskBId,
          participantId: activeTaskB.participant.id,
          sessionId: activeTaskB.session.id,
          text: "Do not cancel without a saved copy",
          status: "queued",
          receivedAt: 4_001,
        },
      ],
    };
    await act(async () => emit(taskBId, historyB));
    const storage = dom.window.localStorage;
    const storagePrototype = Object.getPrototypeOf(storage);
    const originalSetItem = Object.getOwnPropertyDescriptor(storagePrototype, "setItem")!;
    Object.defineProperty(storagePrototype, "setItem", {
      configurable: true,
      value: () => {
        throw new Error("storage unavailable");
      },
    });
    try {
      assert.equal(
        queueControls!.onQueueEditPrepare(taskBId, "storage-probe", { text: "probe" }),
        false,
      );
      const failedEditButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="v4-queue-item-edit-queue-storage-failure"]',
      );
      assert.ok(failedEditButton);
      assert.equal(failedEditButton.disabled, false);
      await act(async () => failedEditButton.click());
      assert.equal(historyB.inputs.at(-1)?.status, "queued");
      await waitFor(() =>
        assert.match(document.body.textContent ?? "", /草稿保存失败，队列项已保留/),
      );
    } finally {
      Object.defineProperty(storagePrototype, "setItem", originalSetItem);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.close();
  }
});

test("Engine timeline reuses native find navigation and updates matches as Harness text streams", async () => {
  const dom = installDom();
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    value(this: HTMLElement, eventName: string, listener: EventListener) {
      this.addEventListener(eventName.replace(/^on/u, ""), listener);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    value(this: HTMLElement, eventName: string, listener: EventListener) {
      this.removeEventListener(eventName.replace(/^on/u, ""), listener);
    },
  });
  const registry = new Map<string, unknown>();
  class TestHighlight {
    priority = 0;
    readonly ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }
  const css = {
    highlights: {
      set: (name: string, value: unknown) => registry.set(name, value),
      delete: (name: string) => registry.delete(name),
    },
  };
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(dom.window, "CSS", { configurable: true, value: css });
  Object.defineProperty(dom.window, "Highlight", { configurable: true, value: TestHighlight });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: css,
  });

  const [
    { EngineConversationTimeline },
    { projectEngineConversation },
    { TaskFindDialog },
    { createTaskFindNavigationState, changeTaskFindSelection, navigateTaskFindSelection },
    { ZCodeIntlProvider },
    { TooltipProvider },
  ] = await Promise.all([
    import("../src/EngineConversationTimeline.js"),
    import("../src/engineConversationProjection.js"),
    import("../src/quickpick/TaskFindDialog.js"),
    import("../src/quickpick/taskFindNavigationState.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/components/ui/tooltip.js"),
  ]);
  const taskBId = "task-engine-find-b";
  const taskB = {
    ...task,
    id: taskBId,
    participant: { ...task.participant, id: "participant-engine-find-b" },
    session: { ...task.session, id: "session-engine-find-b" },
  };
  const historyA = {
    ...emptyHistory(),
    inputs: [
      {
        id: "input-find-a",
        taskId,
        participantId,
        sessionId,
        text: "needle in prompt",
        status: "completed",
        receivedAt: 1_000,
        acceptedAt: 1_000,
        startedAt: 1_000,
        terminalAt: 1_010,
        error: null,
      },
      {
        id: "input-live-a",
        taskId,
        participantId,
        sessionId,
        text: "waiting for streamed content",
        status: "started",
        receivedAt: 2_000,
        acceptedAt: 2_000,
        startedAt: 2_000,
        terminalAt: null,
        error: null,
      },
    ],
    executions: [
      {
        id: "execution-find-a",
        taskId,
        participantId,
        sessionId,
        inputId: "input-find-a",
        status: "completed",
        acceptedAt: 1_000,
        startedAt: 1_000,
        terminalAt: 1_010,
        result: "needle in answer",
        error: null,
      },
      {
        id: "execution-live-a",
        taskId,
        participantId,
        sessionId,
        inputId: "input-live-a",
        status: "started",
        acceptedAt: 2_000,
        startedAt: 2_000,
        terminalAt: null,
        result: null,
        error: null,
      },
    ],
  };
  const historyB = {
    ...emptyHistory(taskBId),
    inputs: [
      {
        id: "input-find-b",
        taskId: taskBId,
        participantId: taskB.participant.id,
        sessionId: taskB.session.id,
        text: "Task B prompt",
        status: "completed",
        receivedAt: 1_000,
        acceptedAt: 1_000,
        startedAt: 1_000,
        terminalAt: 1_010,
        error: null,
      },
    ],
  };

  function FindTestHarness() {
    const [selectedTaskId, setSelectedTaskId] = useState(taskId);
    const [findOpen, setFindOpen] = useState(false);
    const [findState, setFindState] = useState(createTaskFindNavigationState);
    const [matchCount, setMatchCount] = useState(0);
    const [timelineRevision, setTimelineRevision] = useState(0);
    const selectedTask = selectedTaskId === taskId ? task : taskB;
    const selectedHistory = selectedTaskId === taskId ? historyA : historyB;
    const projection = useMemo(
      () => projectEngineConversation(selectedTask as never, selectedHistory as never),
      [selectedTaskId, timelineRevision],
    );
    const onFindChange = useCallback((query: string, activeIndex: number) => {
      setFindState((state) => changeTaskFindSelection(state, query, activeIndex));
    }, []);
    const onFindNavigate = useCallback((query: string, activeIndex: number) => {
      setFindState((state) => navigateTaskFindSelection(state, query, activeIndex));
    }, []);
    const onMatchStateChange = useCallback(
      (state: { matchCount: number; activeIndex?: number }) => {
        setMatchCount(state.matchCount);
        if (state.activeIndex !== undefined) {
          setFindState((current) =>
            changeTaskFindSelection(current, current.query, state.activeIndex ?? -1),
          );
        }
      },
      [],
    );
    const onFileChangeFindChange = useCallback(() => {}, []);
    const streamLiveText = useCallback(() => {
      historyA.events.push({
        id: "event-live-a",
        taskId,
        participantId,
        sessionId,
        inputId: "input-live-a",
        executionId: "execution-live-a",
        nativeEventId: "native-event-live-a",
        streamId: "stream-live-a",
        sourceSequence: 1,
        deliverySequence: 1,
        observedAt: 2_010,
        source: "engine",
        type: "message.delta",
        payload: { text: "liveword arrived" },
        duplicateOf: null,
      });
      setTimelineRevision((revision) => revision + 1);
    }, []);
    const reviseCompletedAnswer = useCallback(() => {
      historyA.executions[0]!.result = "needle on answer";
      setTimelineRevision((revision) => revision + 1);
    }, []);

    return createElement(
      "div",
      null,
      createElement(
        "button",
        { type: "button", "data-testid": "open-find", onClick: () => setFindOpen(true) },
        "Find",
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": "select-task-b",
          onClick: () => setSelectedTaskId(taskBId),
        },
        "Task B",
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": "select-task-a",
          onClick: () => setSelectedTaskId(taskId),
        },
        "Task A",
      ),
      createElement(
        "button",
        { type: "button", "data-testid": "stream-live-text", onClick: streamLiveText },
        "Stream text",
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": "revise-completed-answer",
          onClick: reviseCompletedAnswer,
        },
        "Revise completed answer",
      ),
      createElement(TaskFindDialog, {
        key: `task-find:${selectedTaskId}`,
        open: findOpen,
        focusRequestId: 1,
        placement: "chat",
        showFileChangesScope: false,
        conversationMatchCount: matchCount,
        conversationMatchIndex: findState.activeIndex,
        fileChangeMatchCount: 0,
        fileChangeMatchIndex: -1,
        onOpenChange: setFindOpen,
        onConversationFindChange: onFindChange,
        onConversationFindNavigate: onFindNavigate,
        onFileChangeFindChange,
        onFileChangeFindNavigate: onFileChangeFindChange,
        onOpenFileChanges: () => {},
      }),
      createElement(EngineConversationTimeline, {
        key: `engine-timeline:${selectedTaskId}`,
        projection: projection as never,
        workspacePath: "/tmp/anyagent-ui",
        historyLoading: false,
        approvalBlockedReason: null,
        userInputBlockedReason: null,
        busyAction: null,
        onReplyApproval: () => {},
        onReplyUserInput: () => {},
        conversationFindQuery: findState.query,
        conversationFindActiveIndex: findState.activeIndex,
        conversationFindNavigationRequestId: findState.navigationRequestId,
        onConversationFindMatchStateChange: onMatchStateChange,
      }),
    );
  }

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const activeRanges = () =>
    (registry.get("zcode-v4-conversation-find-active") as TestHighlight | undefined)?.ranges ?? [];
  const setQuery = async (value: string) => {
    const input = container.querySelector<HTMLInputElement>('[role="dialog"] input');
    assert.ok(input, "the native find input should be mounted");
    await act(async () => {
      input.focus();
      const valueSetter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, value);
      const propertyChange = new dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };

  try {
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(TooltipProvider, null, createElement(FindTestHarness)),
        ),
      );
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="open-find"]')?.click(),
    );
    await waitFor(
      () => assert.ok(container.querySelector('[role="dialog"] input')),
      "the shared native find dialog should open for Engine conversations",
    );
    assert.equal(
      container.querySelector('button[aria-label="搜索文件变更"]'),
      null,
      "Engine find must not expose M0 file change search from the prior workspace task",
    );
    await setQuery("needle");
    await waitFor(
      () => assert.equal(container.querySelector(".tabular-nums")?.textContent, "1/2"),
      "native find should count the prompt and answer matches",
    );
    await waitFor(
      () => assert.equal(activeRanges()[0]?.toString(), "needle"),
      "the active conversation match should use native CSS text highlighting",
    );
    assert.equal(
      activeRanges()[0]
        ?.commonAncestorContainer.parentElement?.closest("[data-testid]")
        ?.getAttribute("data-testid"),
      "engine-input-input-find-a",
    );

    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="下一个结果"]')?.click(),
    );
    await waitFor(
      () =>
        assert.equal(
          activeRanges()[0]
            ?.commonAncestorContainer.parentElement?.closest("[data-testid]")
            ?.getAttribute("data-testid"),
          "engine-final-execution-find-a",
        ),
      "next should highlight the assistant answer match",
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="上一个结果"]')?.click(),
    );
    await waitFor(
      () =>
        assert.equal(
          activeRanges()[0]
            ?.commonAncestorContainer.parentElement?.closest("[data-testid]")
            ?.getAttribute("data-testid"),
          "engine-input-input-find-a",
        ),
      "previous should return to the prompt match",
    );

    await setQuery("in answer");
    await waitFor(
      () => assert.equal(container.querySelector(".tabular-nums")?.textContent, "1/1"),
      "a completed Engine answer should be searchable",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="revise-completed-answer"]')
        ?.click(),
    );
    await waitFor(
      () => assert.equal(container.querySelector(".tabular-nums")?.textContent, "0/0"),
      "a same-length late answer revision should invalidate the completed unit search cache",
    );

    await setQuery("liveword");
    await waitFor(
      () => assert.equal(container.querySelector(".tabular-nums")?.textContent, "0/0"),
      "a query without a match should report zero results",
    );
    await waitFor(
      () => assert.equal(activeRanges().length, 0),
      "the old active highlight should clear when the query has no matches",
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="stream-live-text"]')?.click(),
    );
    await waitFor(
      () => assert.equal(container.querySelector(".tabular-nums")?.textContent, "1/1"),
      "a matching Harness delta should update the open find count",
    );
    await waitFor(
      () => assert.equal(activeRanges()[0]?.toString(), "liveword"),
      "a newly streamed matching word should receive the active highlight",
    );

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="select-task-b"]')?.click(),
    );
    await waitFor(() => {
      assert.equal(container.querySelector<HTMLInputElement>('[role="dialog"] input')?.value, "");
      assert.equal(container.querySelector(".tabular-nums")?.textContent, "0/0");
    }, "Task B should not inherit Task A's open search query");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="select-task-a"]')?.click(),
    );
    await waitFor(() => {
      assert.equal(container.querySelector<HTMLInputElement>('[role="dialog"] input')?.value, "");
      assert.equal(container.querySelector(".tabular-nums")?.textContent, "0/0");
    }, "returning to Task A should keep the cleared search state");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')?.click(),
    );
    await waitFor(
      () => assert.equal(container.querySelector('[role="dialog"]'), null),
      "closing native find should restore the conversation view",
    );
    assert.equal(activeRanges().length, 0);

    await act(async () =>
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(
            TooltipProvider,
            null,
            createElement(TaskFindDialog, {
              open: true,
              focusRequestId: 2,
              conversationMatchCount: 0,
              conversationMatchIndex: -1,
              fileChangeMatchCount: 0,
              fileChangeMatchIndex: -1,
              onOpenChange: () => {},
              onConversationFindChange: () => {},
              onConversationFindNavigate: () => {},
              onFileChangeFindChange: () => {},
              onFileChangeFindNavigate: () => {},
              onOpenFileChanges: () => {},
            }),
          ),
        ),
      ),
    );
    await waitFor(
      () =>
        assert.ok(
          document.body.querySelector('button[aria-label="搜索文件变更"]'),
          "M0 should keep its existing file change search scope by default",
        ),
      "the new Engine-only prop should preserve M0 find behavior",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss);
    else Reflect.deleteProperty(globalThis, "CSS");
    dom.window.close();
  }
});

test("mounted Engine timeline keeps delta, tool, delta order without guessing identical requests", async () => {
  const dom = installDom();
  const [
    { EngineConversationTimeline },
    { projectEngineConversation },
    { ZCodeIntlProvider },
    { TooltipProvider },
  ] = await Promise.all([
    import("../src/EngineConversationTimeline.js"),
    import("../src/engineConversationProjection.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/components/ui/tooltip.js"),
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const inputId = "input-ordered";
  const executionId = "execution-ordered";
  const event = (id: string, type: string, payload: Record<string, unknown>, order: number) => ({
    id,
    taskId,
    participantId,
    sessionId,
    inputId,
    executionId,
    nativeEventId: id,
    streamId: "ordered-stream",
    sourceSequence: order,
    deliverySequence: order,
    observedAt: 1_000 + order,
    source: "engine",
    type,
    payload,
    duplicateOf: null,
  });
  const firstDelta = event(
    "delta-before-tool",
    "message.delta",
    { text: "before ", messageId: "native-message", blockId: "block-a" },
    1,
  );
  const laterEvents = [
    event(
      "tool-start",
      "tool.started",
      { toolCallId: "tool-ordered", name: "read_file", input: { path: "README.md" } },
      2,
    ),
    event("tool-end", "tool.completed", { toolCallId: "tool-ordered", result: "ok" }, 3),
    event(
      "approval-request-1",
      "approval.requested",
      { operation: "same operation", scope: "workspace" },
      4,
    ),
    event(
      "approval-request-2",
      "approval.requested",
      { operation: "same operation", scope: "workspace" },
      5,
    ),
    event(
      "user-input-request-1",
      "user-input.requested",
      { prompt: "same prompt", inputKind: "choice" },
      6,
    ),
    event(
      "user-input-request-2",
      "user-input.requested",
      { prompt: "same prompt", inputKind: "choice" },
      7,
    ),
    event(
      "read-failed-without-start",
      "tool.failed",
      {
        toolCallId: "tool-failed",
        name: "Read",
        input: { filePath: "README.md" },
        failure: { kind: "execution-failed", message: "File does not exist" },
      },
      8,
    ),
    event(
      "delta-after-tool",
      "message.delta",
      { text: "after", messageId: "native-message", blockId: "block-b" },
      9,
    ),
  ];
  const approval = (id: string) => ({
    id,
    taskId,
    participantId,
    sessionId,
    executionId,
    operation: "same operation",
    scope: "workspace",
    options: [{ id: "reject", label: "拒绝", decision: "reject" }],
    expiresAt: null,
    status: "pending",
    repliedOptionId: null,
  });
  const request = (id: string) => ({
    id,
    taskId,
    participantId,
    sessionId,
    executionId,
    prompt: "same prompt",
    inputKind: "choice",
    options: [{ id: "no", label: "否" }],
    expiresAt: null,
    status: "pending",
    response: null,
  });
  const history = {
    ...emptyHistory(),
    inputs: [
      {
        id: inputId,
        taskId,
        participantId,
        sessionId,
        text: "inspect order",
        status: "started",
        receivedAt: 1_000,
        acceptedAt: 1_000,
        startedAt: 1_000,
        terminalAt: null,
        error: null,
      },
    ],
    executions: [
      {
        id: executionId,
        taskId,
        participantId,
        sessionId,
        inputId,
        status: "started",
        acceptedAt: 1_000,
        startedAt: 1_000,
        terminalAt: null,
        result: null,
        error: null,
      },
    ],
    events: [firstDelta],
    approvals: [
      { ...approval("approval-one"), requestEventId: "approval-request-1" },
      { ...approval("approval-two"), options: [] },
    ],
    userInputs: [
      { ...request("request-one"), requestEventId: "user-input-request-1" },
      { ...request("request-two"), options: [] },
    ],
  };
  const render = async () =>
    act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(
            TooltipProvider,
            null,
            createElement(EngineConversationTimeline, {
              projection: projectEngineConversation(task as never, history as never),
              workspacePath: "/tmp/anyagent-ui",
              historyLoading: false,
              approvalBlockedReason: null,
              userInputBlockedReason: null,
              busyAction: null,
              onReplyApproval: () => {},
              onReplyUserInput: () => {},
            }),
          ),
        ),
      );
    });
  try {
    await render();
    assert.match(
      container.querySelector('[data-testid="engine-answer-execution-ordered"]')?.textContent ?? "",
      /before/,
    );
    history.events.push(...laterEvents);
    await render();
    const execution = container.querySelector<HTMLElement>(
      `[data-testid="engine-execution-${executionId}"]`,
    );
    assert.ok(execution);
    const first = execution.querySelectorAll<HTMLElement>(
      `[data-testid="engine-answer-${executionId}"]`,
    )[0];
    const second = execution.querySelectorAll<HTMLElement>(
      `[data-testid="engine-answer-${executionId}"]`,
    )[1];
    const tool = execution.querySelector<HTMLElement>(
      '[data-testid="chat-tool-call-block-tool-ordered"]',
    );
    assert.ok(first && tool && second);
    const failedTool = execution.querySelector<HTMLElement>(
      '[data-testid="chat-tool-call-block-tool-failed"]',
    );
    assert.ok(failedTool, "a native failure before start still renders a tool card");
    assert.match(failedTool.textContent ?? "", /README\.md/);
    assert.match(failedTool.textContent ?? "", /执行失败/);
    assert.doesNotMatch(failedTool.textContent ?? "", /未知工具/);
    assert.ok(first.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(tool.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.match(second.textContent ?? "", /after/);
    const orderedApproval = execution.querySelector<HTMLElement>(
      '[data-testid="engine-approval-approval-one"]',
    );
    const orderedUserInput = execution.querySelector<HTMLElement>(
      '[data-testid="engine-user-input-request-one"]',
    );
    assert.ok(orderedApproval && orderedUserInput);
    assert.ok(tool.compareDocumentPosition(orderedApproval) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(
      orderedApproval.compareDocumentPosition(orderedUserInput) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    assert.ok(orderedUserInput.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    for (const id of ["approval-one", "approval-two", "request-one", "request-two"]) {
      const control = execution.querySelector<HTMLElement>(
        `[data-testid="engine-${id.startsWith("approval") ? "approval" : "user-input"}-${id}"]`,
      );
      assert.ok(control, `${id} must remain visible`);
      if (id.endsWith("two"))
        assert.ok(second.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING);
    }
    assert.doesNotMatch(execution.textContent ?? "", /内部顺序未知/);
    for (const id of ["approval-two", "request-two"]) {
      assert.match(
        execution.querySelector(
          `[data-testid="engine-${id.startsWith("approval") ? "approval" : "user-input"}-${id}"]`,
        )?.textContent ?? "",
        /暂时无法答复此请求/,
      );
    }
    history.executions[0] = {
      ...history.executions[0]!,
      status: "completed",
      result: "before after",
      terminalAt: 1_020,
    };
    await render();
    assert.equal(execution.querySelector(`[data-testid="engine-final-${executionId}"]`), null);
    assert.equal(
      execution.querySelectorAll(`[data-testid="engine-answer-${executionId}"]`).length,
      2,
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.close();
  }
});

test("an active ZCode Harness task switches models within its Session and submits the chosen model", async () => {
  const dom = installDom();
  const [
    { EngineConversation },
    { ServiceProvider },
    { PlatformProvider },
    { ZCodeIntlProvider },
    { TabStoreProvider },
    { TooltipProvider },
    { useZCodeSessionStore },
  ] = await Promise.all([
    import("../src/EngineConversation.js"),
    import("../src/hooks/useServices.js"),
    import("../src/hooks/usePlatform.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/store/TabStoreProvider.js"),
    import("../src/components/ui/tooltip.js"),
    import("../src/store/zcodeSessionStore.js"),
  ]);
  const zcodeEngine = {
    ...currentEngine,
    engineId: "zcode",
    capabilities: {
      ...capabilities,
      "session.compact": available,
      "session.fork": available,
      "execution.revise": available,
    },
  };
  const zcodeTask = {
    ...task,
    engine: { ...task.engine, engineId: "zcode" },
    currentEngine: zcodeEngine,
    session: { ...task.session, nativeSessionId: "native-zcode-session-ui" },
  };
  const zcodeTaskB = {
    ...zcodeTask,
    id: "task-zcode-feedback-b",
    participant: { ...zcodeTask.participant, id: "participant-zcode-feedback-b" },
    session: { ...zcodeTask.session, id: "session-zcode-feedback-b", nativeSessionId: "native-b" },
  };
  const forkTask = {
    ...zcodeTask,
    id: "task-zcode-fork-model",
    participant: { ...zcodeTask.participant, id: "participant-zcode-fork-model" },
    session: {
      ...zcodeTask.session,
      id: "session-zcode-fork-model",
      nativeSessionId: "native-fork",
    },
    forkedFrom: {
      taskId,
      inputId: "input-initial",
      executionId: "execution-native-feedback",
    },
  };
  const newTask = {
    ...zcodeTask,
    id: "task-zcode-new-from-slash",
    participant: { ...zcodeTask.participant, id: "participant-zcode-new-from-slash" },
    session: {
      ...zcodeTask.session,
      id: "session-zcode-new-from-slash",
      nativeSessionId: "native-zcode-new-from-slash",
    },
  };
  const importedContextTask = {
    ...zcodeTask,
    id: "task-zcode-shared-context-import",
    authorizationId: "authorization-zcode-shared-context-import",
    participant: { ...zcodeTask.participant, id: "participant-zcode-shared-context-import" },
    session: {
      ...zcodeTask.session,
      id: "session-zcode-shared-context-import",
      nativeSessionId: "native-zcode-shared-context-import",
    },
    sharedContext: {
      contextId: "shared-context-ui-import",
      title: "Imported shared context",
      shareUrl: "https://zcode.z.ai/cn/share/share_123",
    },
  };
  const workspacePath = "/tmp/anyagent-ui";
  const zcodeSlashCommands = [
    { name: "compact", description: "Compact", source: "builtin" as const },
    { name: "goal", description: "Goal", source: "builtin" as const },
    { name: "init", description: "Initialize", source: "builtin" as const },
    { name: "skill", description: "Use a skill", source: "builtin" as const },
    { name: "custom-note", description: "Custom prompt", source: "custom" as const },
    { name: "future-native", description: "Future native command", source: "builtin" as const },
  ];
  const zcodeSessionStore = useZCodeSessionStore.getState();
  const originalSlashCommands = zcodeSessionStore.getWorkspaceState(workspacePath).slashCommands;
  zcodeSessionStore.setSlashCommands(workspacePath, zcodeSlashCommands);
  const modelView = {
    revision: 1,
    providers: [
      {
        providerId: "opencode-go",
        providerName: "OpenCode Go",
        config: { api: { type: "openai" }, visibility: "visible" },
        models: [
          {
            modelId: "go-alpha",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
          },
          {
            modelId: "go-beta",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
          },
        ],
      },
      {
        providerId: "other-provider",
        providerName: "Other Provider",
        config: { api: { type: "openai" }, visibility: "visible" },
        models: [
          {
            modelId: "other-model",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
          },
        ],
      },
    ],
    preferredSelection: {
      providerId: "other-provider",
      modelId: "other-model",
      options: { reasoningLevel: "high" },
    },
  };
  const submissions: Array<Record<string, unknown>> = [];
  const compactRequests: Array<Record<string, unknown>> = [];
  const createTaskRequests: Array<Record<string, unknown>> = [];
  const sharedContextImportRequests: Array<Record<string, unknown>> = [];
  const selectedTaskIds: string[] = [];
  let createTaskError: Error | null = null;
  const skillCatalogLookups: Array<Record<string, unknown>> = [];
  const nativeSkillCatalogLookups: Array<Record<string, unknown>> = [];
  let delayNextSkillCatalogRead = false;
  let releaseSkillCatalogRead: (() => void) | null = null;
  const feedbackRequests: Array<Record<string, unknown>> = [];
  const workspaceFileSearches: Array<Record<string, unknown>> = [];
  const forkRequests: Array<Record<string, unknown>> = [];
  const revisionRequests: Array<Record<string, unknown>> = [];
  let nativeFeedback: "like" | "dislike" | null = null;
  const changes = new Set<(change: Record<string, unknown>) => void>();
  let history = emptyHistory();
  const historyB = emptyHistory(zcodeTaskB.id);
  const forkHistory = emptyHistory(forkTask.id);
  history.inputs.push({
    id: "input-initial",
    taskId,
    participantId,
    sessionId,
    text: "earlier turn",
    submissionConfig: {
      mode: "build",
      planEnabled: false,
      modelSelection: {
        providerId: "opencode-go",
        modelId: "go-alpha",
        options: { reasoningLevel: "high" },
      },
    },
    status: "completed",
    receivedAt: 900,
    acceptedAt: 901,
    startedAt: 902,
    terminalAt: 950,
    error: null,
  });
  const service = {
    listTasks: async () => [zcodeTask, zcodeTaskB, forkTask, newTask],
    getTask: async (id: string) =>
      id === newTask.id
        ? newTask
        : id === forkTask.id
          ? forkTask
          : id === zcodeTaskB.id
            ? zcodeTaskB
            : zcodeTask,
    getHistory: async (id: string) =>
      id === newTask.id
        ? emptyHistory(newTask.id)
        : id === forkTask.id
          ? forkHistory
          : id === zcodeTaskB.id
            ? historyB
            : history,
    getExecutionFileChanges: async () => null,
    getAssistantFeedback: async (id: string) => ({
      state: "current",
      values: id === zcodeTaskB.id ? {} : { "native-feedback-message": nativeFeedback },
    }),
    listEngines: async () => [zcodeEngine],
    onDidChange: (listener: (change: Record<string, unknown>) => void) => {
      changes.add(listener);
      return { dispose: () => changes.delete(listener) };
    },
    submitInput: async (input: Record<string, unknown>) => {
      submissions.push(input);
    },
    compactSession: async (input: Record<string, unknown>) => {
      compactRequests.push(input);
      return { status: "completed", reason: null };
    },
    createTask: async (input: Record<string, unknown>) => {
      createTaskRequests.push(input);
      if (createTaskError) throw createTaskError;
      return newTask;
    },
    importSharedContext: async (input: Record<string, unknown>) => {
      sharedContextImportRequests.push(input);
      return importedContextTask;
    },
    getTaskSkillReferenceCatalog: async (input: Record<string, unknown>) => {
      skillCatalogLookups.push(input);
      if (delayNextSkillCatalogRead) {
        delayNextSkillCatalogRead = false;
        await new Promise<void>((resolve) => {
          releaseSkillCatalogRead = resolve;
        });
      }
      return {
        skills: [
          {
            name: "review",
            description: "Review code changes",
            scope: "workspace" as const,
          },
        ],
      };
    },
    setAssistantFeedback: async (input: Record<string, unknown>) => {
      feedbackRequests.push(input);
      nativeFeedback = input.feedback as "like" | "dislike" | null;
      return { status: "updated" };
    },
    forkTask: async (input: Record<string, unknown>) => {
      forkRequests.push(input);
      return forkTask;
    },
    reviseTurn: async (input: Record<string, unknown>) => {
      revisionRequests.push(input);
    },
  };
  const services = {
    anyAgentService: service,
    clientConfigService: { getSnapshot: async () => ({ pluginStoreOrder: null }) },
    fileService: {
      searchWorkspaceFiles: async (params: Record<string, unknown>) => {
        workspaceFileSearches.push(params);
        return [
          {
            name: "notes.md",
            path: `${workspacePath}/notes.md`,
            relativePath: "notes.md",
            type: "file" as const,
          },
        ];
      },
    },
    subagentsService: {
      list: async () => ({
        agents: [],
        userAgents: [],
        pluginAgents: [],
        capability: { userScopeAvailable: false },
      }),
    },
    zcodeAgentService: {
      getSkillReferenceCatalog: async (params: Record<string, unknown>) => {
        nativeSkillCatalogLookups.push(params);
        return {
          skills: [
            {
              id: "skill-review",
              name: "review",
              description: "Review code changes",
              path: `${workspacePath}/.agents/skills/review/SKILL.md`,
              scope: "workspace",
              enabled: true,
            },
          ],
          authority: "session",
        };
      },
      onAgentRuntimeRestarted: () => ({ dispose: () => {} }),
    },
    modelSelectionService: {
      getView: async () => modelView,
      onDidChange: () => ({ dispose: () => {} }),
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const appFor = (selectedTaskId: string) =>
    createElement(
      TooltipProvider,
      null,
      createElement(
        ServiceProvider,
        { services: services as never },
        createElement(
          PlatformProvider,
          {
            platform: {
              canSelectFilePath: false,
              onSettingsChanged: () => () => {},
            } as never,
          },
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(
              TabStoreProvider,
              null,
              createElement(EngineConversation, {
                service: service as never,
                selectedTaskId,
                onSelectTask: (id) => {
                  if (id) selectedTaskIds.push(id);
                },
              }),
            ),
          ),
        ),
      ),
    );
  try {
    await act(async () => root.render(appFor(taskId)));
    const modelTrigger = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="chat-model-select-trigger"]');
    await waitFor(() => {
      assert.match(modelTrigger()?.textContent ?? "", /go-alpha/);
      assert.equal(
        container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')
          ?.disabled,
        false,
      );
    }, "ZCode Harness model did not become ready");
    const addContextTrigger = container
      .querySelector<SVGElement>("[data-composer-leading-content] svg.lucide-plus")
      ?.closest<HTMLButtonElement>("button");
    assert.ok(addContextTrigger, "the M1 ZCode composer should expose its context menu");
    assert.equal(addContextTrigger.disabled, false);
    await act(async () => addContextTrigger.click());
    const workspaceFileOption = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) =>
        option.textContent?.includes("notes.md"),
      );
    await waitFor(
      () => assert.ok(workspaceFileOption(), "the + menu should expose Host-searched files"),
      "workspace file reference did not appear in the native composer menu",
    );
    assert.equal(
      document.querySelector('[data-testid="prompt-suggestion-section-plugins"]'),
      null,
      "the M1 file-reference menu should not expose unsupported Plugin context routes",
    );
    assert.ok(workspaceFileSearches.length > 0);
    assert.equal(workspaceFileSearches[0]?.rootPath, workspacePath);
    const workspaceFileInput = container.querySelector<HTMLElement>(
      '[data-testid="engine-composer-input"]',
    ) as HTMLElement & {
      __zcodeLexicalInputE2E: { getText: () => string; setText: (text: string) => void };
    };
    await act(async () => {
      workspaceFileOption()?.dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });
    await waitFor(
      () =>
        assert.equal(
          workspaceFileInput.__zcodeLexicalInputE2E.getText(),
          "[notes.md](./notes.md) ",
        ),
      "selecting a workspace result should insert the canonical file reference into the product composer",
    );
    await act(async () => workspaceFileInput.__zcodeLexicalInputE2E.setText(""));
    await act(async () => {
      const trigger = modelTrigger()!;
      trigger.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, button: 0 }));
      trigger.click();
    });
    await waitFor(
      () =>
        assert.ok(document.body.querySelector('[data-model-provider-key="harness-zcode-models"]')),
      "Harness model group did not open",
    );
    const harnessModels = document.body.querySelector<HTMLElement>(
      '[data-model-provider-key="harness-zcode-models"]',
    );
    assert.ok(harnessModels, "native picker should group models under ZCode Harness");
    await act(async () => harnessModels.click());
    const other = [
      ...document.body.querySelectorAll<HTMLElement>('[data-testid^="chat-model-select-item-"]'),
    ].find((item) => item.textContent?.includes("other-model"));
    assert.equal(
      other?.getAttribute("data-model-option-locked"),
      "true",
      "an active Session must reject cross-Provider model changes",
    );
    const beta = [
      ...document.body.querySelectorAll<HTMLElement>('[data-testid^="chat-model-select-item-"]'),
    ].find(
      (item) =>
        item.textContent?.includes("go-beta") &&
        item.getAttribute("data-model-option-locked") !== "true",
    );
    assert.ok(beta, "same-Harness model must be selectable in the native model picker");
    await act(async () => beta.click());
    await waitFor(
      () => assert.match(modelTrigger()?.textContent ?? "", /go-beta/),
      "model did not change",
    );
    const chooseConfig = async (triggerTestId: string, itemTestId: string) => {
      const trigger = container.querySelector<HTMLButtonElement>(
        `[data-testid="${triggerTestId}"]`,
      );
      assert.ok(trigger && !trigger.disabled);
      await act(async () => trigger.click());
      await waitFor(
        () => assert.ok(document.body.querySelector(`[data-testid="${itemTestId}"]`)),
        `${itemTestId} did not open`,
      );
      await act(async () =>
        document.body.querySelector<HTMLElement>(`[data-testid="${itemTestId}"]`)!.click(),
      );
    };
    await chooseConfig("chat-mode-select-trigger", "chat-mode-select-item-edit");
    await chooseConfig("chat-thought-level-select-trigger", "chat-thought-level-select-item-low");
    const input = container.querySelector<HTMLElement>('[data-testid="engine-composer-input"]') as
      | (HTMLElement & {
          __zcodeLexicalInputE2E?: {
            setText: (value: string) => void;
            setTextWithPluginMentions: (value: string) => void;
            getText: () => string;
          };
        })
      | null;
    assert.ok(input?.__zcodeLexicalInputE2E);

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/model"));
    await waitFor(
      () => assert.ok(container.querySelector('[data-option-id="app-slash:model"]')),
      "the Harness model shortcut should be available when the Desktop CLI catalog omits TUI-only /model",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-option-id="app-slash:model"]')!
        .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 })),
    );
    await waitFor(
      () =>
        assert.ok(document.body.querySelector('[data-model-provider-key="harness-zcode-models"]')),
      "/model should open the existing model picker",
    );
    await act(async () =>
      document.body
        .querySelector<HTMLElement>('[data-model-provider-key="harness-zcode-models"]')!
        .click(),
    );
    await waitFor(
      () =>
        assert.ok(
          [
            ...document.body.querySelectorAll<HTMLElement>(
              "[data-testid^='chat-model-select-item-']",
            ),
          ].some((item) => item.textContent?.includes("go-alpha")),
        ),
      "/model picker should list models for the current ZCode Harness",
    );
    await waitFor(
      () => assert.equal(input.__zcodeLexicalInputE2E!.getText(), ""),
      "selecting /model should consume the local command without submitting input",
    );
    assert.equal(submissions.length, 0);
    await act(async () => modelTrigger()!.click());

    const submitCurrentDraft = async () =>
      act(async () =>
        container
          .querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')!
          .click(),
      );
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/model opencode-go/go-alpha"));
    await submitCurrentDraft();
    await waitFor(
      () => assert.match(modelTrigger()?.textContent ?? "", /go-alpha/),
      "/model provider/model should use the existing same-Provider model selection",
    );
    assert.equal(submissions.length, 0, "model selection must not create an Input");
    await act(async () =>
      input.__zcodeLexicalInputE2E!.setText("/model other-provider/other-model"),
    );
    await submitCurrentDraft();
    assert.equal(
      input.__zcodeLexicalInputE2E!.getText(),
      "/model other-provider/other-model",
      "cross-Provider model selection must be rejected with the draft preserved",
    );
    assert.equal(submissions.length, 0);
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/model opencode-go/go-beta"));
    await submitCurrentDraft();
    await waitFor(
      () => assert.match(modelTrigger()?.textContent ?? "", /go-beta/),
      "same-Provider /model selection did not restore the selected model",
    );

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/effort"));
    await waitFor(
      () => assert.ok(container.querySelector('[data-option-id="app-slash:effort"]')),
      "the Harness reasoning shortcut should be available when absent from the Desktop CLI catalog",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-option-id="app-slash:effort"]')!
        .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 })),
    );
    await waitFor(
      () =>
        assert.ok(
          document.body.querySelector('[data-testid="chat-thought-level-select-item-low"]'),
        ),
      "/effort should open the existing reasoning picker",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-thought-level-select-trigger"]')!
        .click(),
    );
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/effort high"));
    await submitCurrentDraft();
    await waitFor(
      () =>
        assert.match(
          container.querySelector('[data-testid="chat-thought-level-select-trigger"]')
            ?.textContent ?? "",
          /high/i,
        ),
      "/effort high should update the same model selection used by the composer",
    );
    assert.equal(submissions.length, 0, "reasoning selection must not create an Input");

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/mode"));
    await waitFor(
      () => assert.ok(container.querySelector('[data-option-id="app-slash:mode"]')),
      "the Harness mode shortcut should be available when absent from the Desktop CLI catalog",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-option-id="app-slash:mode"]')!
        .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 })),
    );
    await waitFor(
      () => assert.ok(document.body.querySelector('[data-testid="chat-mode-select-item-edit"]')),
      "/mode should open the existing permission mode picker",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-mode-select-trigger"]')!
        .click(),
    );
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/mode build"));
    await submitCurrentDraft();
    await waitFor(
      () =>
        assert.equal(
          container
            .querySelector('[data-testid="chat-mode-select-trigger"]')
            ?.getAttribute("aria-label"),
          "build",
        ),
      "/mode build should update the current product submission configuration",
    );
    await chooseConfig("chat-mode-select-trigger", "chat-mode-select-item-edit");

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/help model"));
    await submitCurrentDraft();
    await waitFor(
      () => assert.ok(document.body.textContent?.includes("/model [list|provider/model]")),
      "/help model should show local CLI help without submitting to the model",
    );
    assert.equal(submissions.length, 0);
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/help skill"));
    await submitCurrentDraft();
    await waitFor(
      () => assert.ok(document.body.textContent?.includes("/skill [<skill-name> [task]]")),
      "/help skill should show the fixed CLI command usage now mapped through Host",
    );
    assert.equal(submissions.length, 0);
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/help compact"));
    await submitCurrentDraft();
    await waitFor(
      () =>
        assert.ok(
          document.body.textContent?.includes("M1 Engine 通过 Host 支持可选 instructions。"),
        ),
      "/help compact should describe the Host instructions field accurately",
    );
    assert.equal(submissions.length, 0);
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/help locale"));
    await submitCurrentDraft();
    await waitFor(
      () =>
        assert.ok(
          document.body.textContent?.includes(
            "M1 通过产品全局 UI 语言偏好支持 auto、en-US 和 zh-CN。",
          ),
        ),
      "/help locale should describe the existing product preference route",
    );
    assert.equal(submissions.length, 0);
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/help"));
    await submitCurrentDraft();
    await waitFor(
      () =>
        assert.ok(
          document.body.textContent?.includes(
            "固定 CLI 命令暂不支持：/login、/logout、/expert、/dwf、/fork、/mcp、/plugins、/resume、/rewind、/goal",
          ),
        ),
      "/help should distinguish the fixed M0 catalog from M1-supported commands",
    );

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/goal status"));
    await submitCurrentDraft();
    assert.equal(submissions.length, 0, "unmapped native /goal must not become an ordinary prompt");
    assert.equal(input.__zcodeLexicalInputE2E!.getText(), "/goal status");
    await waitFor(
      () =>
        assert.ok(
          document.body.textContent?.includes(
            "M0 保存 Session 目标并可触发目标续跑；M1 没有对应的 Task 级 Host/Runtime 操作。",
          ),
        ),
      "a fixed but unmapped M0 command should explain the missing Task-scoped operation",
    );

    const unsupportedNativeCommands = [
      ["/login setup", "M0 登录会启动共享账号与凭据流程"],
      ["/logout", "M0 退出登录会删除多个 Session 共用的凭据"],
      ["/expert status", "M0 管理持久化 Expert 工作流"],
      ["/dwf list", "M0 操作 CLI 动态工作流运行记录"],
      ["/fork latest", "M0 从工作区检查点分叉，M1 从指定产品 Execution 分叉"],
      ["/mcp status", "M0 管理 CLI 的 MCP 服务连接"],
      ["/plugin list", "M0 修改后续 CLI Session 使用的插件配置"],
      ["/continue", "M0 CLI Session ID 不能安全地映射并授权"],
      ["/rewind latest", "M0 恢复工作区检查点；M1 只支持绑定到指定产品 Execution"],
      ["/target pause", "M0 保存 Session 目标并可触发目标续跑"],
    ] as const;
    for (const [command, reason] of unsupportedNativeCommands) {
      await act(async () => input.__zcodeLexicalInputE2E!.setText(command));
      await submitCurrentDraft();
      assert.equal(submissions.length, 0, `${command} must not become an ordinary Input`);
      assert.equal(input.__zcodeLexicalInputE2E!.getText(), command);
      await waitFor(
        () => assert.ok(document.body.textContent?.includes(reason)),
        `${command} should preserve its draft and explain the semantic/ownership boundary`,
      );
    }

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/custom-note take notes"));
    await submitCurrentDraft();
    assert.equal(submissions.length, 0, "a CLI custom command must not be sent as ordinary input");
    assert.equal(input.__zcodeLexicalInputE2E!.getText(), "/custom-note take notes");
    await waitFor(
      () => assert.ok(document.body.textContent?.includes("不执行此类命令，输入已保留")),
      "a custom CLI command should explain that M1 does not execute it",
    );

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/future-native arg"));
    await submitCurrentDraft();
    assert.equal(submissions.length, 0, "a dynamic future command must not be dispatched");
    assert.equal(input.__zcodeLexicalInputE2E!.getText(), "/future-native arg");
    await waitFor(
      () => assert.ok(document.body.textContent?.includes("不在固定 ZCode v0.16.9 支持范围内")),
      "a command added outside the fixed M0 catalog should remain unsupported",
    );

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/not-in-catalog arg"));
    await submitCurrentDraft();
    assert.equal(submissions.length, 0, "an unknown slash command must not become a prompt");
    assert.equal(input.__zcodeLexicalInputE2E!.getText(), "/not-in-catalog arg");
    await waitFor(
      () => assert.ok(document.body.textContent?.includes("未知斜杠命令 /not-in-catalog")),
      "an unknown slash command should be reported and preserved",
    );

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/new"));
    await waitFor(
      () => assert.ok(container.querySelector('[data-option-id="app-slash:new"]')),
      "the product /new command should be available when the M1 protocol catalog omits it",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-option-id="app-slash:new"]')!
        .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 })),
    );
    await waitFor(
      () => assert.match(input.__zcodeLexicalInputE2E!.getText(), /\/new/),
      "selecting /new should fill the composer before creating a Task",
    );
    await submitCurrentDraft();
    await waitFor(() => {
      assert.equal(createTaskRequests.length, 1);
      assert.equal(selectedTaskIds.length, 1);
    }, "/new should create and select a fresh Host Task");
    assert.deepEqual(createTaskRequests[0], { engineId: "zcode", workspacePath });
    assert.equal(selectedTaskIds[0], newTask.id);
    assert.equal(input.__zcodeLexicalInputE2E!.getText(), "");

    createTaskError = new Error("Host rejected new Task");
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/new"));
    await submitCurrentDraft();
    await waitFor(() => assert.equal(createTaskRequests.length, 2));
    assert.equal(selectedTaskIds.length, 1, "a failed /new must not change selection");
    assert.equal(input.__zcodeLexicalInputE2E!.getText(), "/new", "a failed /new keeps its draft");
    createTaskError = null;

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/clear"));
    await submitCurrentDraft();
    await waitFor(() => assert.equal(createTaskRequests.length, 3));
    assert.equal(selectedTaskIds[1], newTask.id, "/clear should retain /new alias behavior");

    await act(async () => input.__zcodeLexicalInputE2E!.setText("Use the selected model"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')!.click(),
    );
    await waitFor(() => assert.equal(submissions.length, 1), "the chosen model was not submitted");
    const submissionConfig = submissions[0]?.submissionConfig as Record<string, unknown>;
    assert.deepEqual(submissionConfig.modelSelection, {
      providerId: "opencode-go",
      modelId: "go-beta",
      options: { reasoningLevel: "high" },
    });
    assert.equal(submissions[0]?.sessionId, sessionId);
    assert.equal(submissionConfig.mode, "edit");
    await waitFor(
      () => assert.equal(input.__zcodeLexicalInputE2E!.getText(), ""),
      "accepted input did not clear",
    );

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/compact"));
    await waitFor(
      () => assert.ok(container.querySelector('[data-testid="prompt-suggestion-panel"]')),
      "native slash suggestions did not open",
    );
    assert.ok(
      container.querySelector('[data-option-id="slash:compact"]'),
      "the native compact command should remain in the shared slash suggestions",
    );
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/compact instructions"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')!.click(),
    );
    assert.equal(submissions.length, 1, "/compact must not become submitInput text");
    await waitFor(() => assert.equal(compactRequests.length, 1));
    assert.deepEqual(compactRequests[0], {
      taskId,
      participantId,
      sessionId,
      authorizationId: "authorization-engine-ui",
      instructions: "instructions",
    });
    await waitFor(() => assert.equal(input.__zcodeLexicalInputE2E!.getText(), ""));
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/compact"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')!.click(),
    );
    await waitFor(
      () => assert.equal(compactRequests.length, 2),
      "compact must use the separate maintenance API",
    );
    assert.deepEqual(compactRequests[1], {
      taskId,
      participantId,
      sessionId,
      authorizationId: "authorization-engine-ui",
    });
    assert.equal(submissions.length, 1, "maintenance must not create a user Input");
    await waitFor(
      () => assert.equal(input.__zcodeLexicalInputE2E!.getText(), ""),
      "completed maintenance should clear the slash draft",
    );
    assert.equal(container.querySelector('[role="status"]'), null);

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/ski"));
    await waitFor(
      () => assert.ok(container.querySelector('[data-option-id="slash:skill"]')),
      "fixed M1 protocol slash catalog should expose /skill in the composer picker",
    );
    await waitFor(
      () => assert.ok(skillCatalogLookups.length > 0),
      "M1 Skill suggestions should read through the current Task's Host catalog",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-option-id="slash:skill"]')!
        .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 })),
    );
    await waitFor(
      () => assert.match(input.__zcodeLexicalInputE2E!.getText(), /^\/skill\s/u),
      "selecting the /skill picker item should fill the executable M0 command",
    );
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/skill"));
    const catalogReadsBeforeCommand = skillCatalogLookups.length;
    await submitCurrentDraft();
    await waitFor(
      () => assert.equal(skillCatalogLookups.length, catalogReadsBeforeCommand + 1),
      "Host Skill catalog service did not receive the current Task identity",
    );
    assert.deepEqual(skillCatalogLookups.at(-1), {
      taskId,
      participantId,
      sessionId,
      authorizationId: "authorization-engine-ui",
    });
    assert.equal(nativeSkillCatalogLookups.length, 0, "Renderer must not read the native catalog");
    await waitFor(() => {
      assert.equal(input.__zcodeLexicalInputE2E!.getText(), "");
      assert.ok(document.body.textContent?.includes("Available skills (1)"));
    }, "no-argument /skill should list the Session catalog and clear only after success");
    assert.equal(
      submissions.length,
      1,
      "no-argument M0 /skill lists skills without creating a product Input",
    );

    const skillTask = "inspect changes";
    delayNextSkillCatalogRead = true;
    await act(async () => input.__zcodeLexicalInputE2E!.setText(`/skill review ${skillTask}`));
    await submitCurrentDraft();
    await waitFor(
      () => assert.equal(typeof releaseSkillCatalogRead, "function"),
      "named /skill should wait for the current Session catalog before submitInput",
    );
    await act(async () => input.__zcodeLexicalInputE2E!.setText("keep this newer draft"));
    releaseSkillCatalogRead?.();
    releaseSkillCatalogRead = null;
    await waitFor(
      () => assert.equal(submissions.length, 2),
      "named /skill should submit its expanded prompt through Host/Runtime",
    );
    assert.equal(
      submissions[1]?.text,
      buildM0ManualSkillPrompt("review", skillTask),
      "named /skill must preserve fixed M0 prompt expansion before native session_input",
    );
    assert.equal(submissions[1]?.taskId, taskId);
    assert.equal(submissions[1]?.participantId, participantId);
    assert.equal(submissions[1]?.sessionId, sessionId);
    assert.equal(submissions[1]?.authorizationId, "authorization-engine-ui");
    assert.equal(
      input.__zcodeLexicalInputE2E!.getText(),
      "keep this newer draft",
      "successful async Skill preflight must not erase text entered while it was waiting",
    );

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/skill not-installed task"));
    await submitCurrentDraft();
    await waitFor(
      () => assert.ok(document.body.textContent?.includes("not-installed")),
      "a Skill absent from this Session catalog should report the miss",
    );
    assert.equal(submissions.length, 2, "an unknown Skill must not be dispatched as an Input");
    assert.equal(input.__zcodeLexicalInputE2E!.getText(), "/skill not-installed task");

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/review"));
    await waitFor(
      () => assert.ok(container.querySelector('[data-option-id="task-skill:review"]')),
      "Host Task Skill suggestions should route through the executable /skill command",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-option-id="task-skill:review"]')!
        .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 })),
    );
    assert.equal(
      input.__zcodeLexicalInputE2E!.getText().trimEnd(),
      "/skill review",
      "selecting an M1 Task Skill must serialize to the Host-gated /skill path",
    );
    const catalogReadsBeforeSuggestionSubmit = skillCatalogLookups.length;
    await submitCurrentDraft();
    await waitFor(
      () => assert.equal(submissions.length, 3),
      "selected Task Skill should submit its expanded M0 skill prompt through Host/Runtime",
    );
    assert.equal(skillCatalogLookups.length, catalogReadsBeforeSuggestionSubmit + 1);
    assert.equal(submissions[2]?.text, buildM0ManualSkillPrompt("review", ""));
    assert.equal(submissions[2]?.taskId, taskId);
    assert.equal(submissions[2]?.participantId, participantId);
    assert.equal(submissions[2]?.sessionId, sessionId);
    assert.equal(submissions[2]?.authorizationId, "authorization-engine-ui");
    assert.equal(
      nativeSkillCatalogLookups.length,
      0,
      "M1 suggestions must not read native catalog",
    );

    await act(async () => input.__zcodeLexicalInputE2E!.setText("$rev"));
    const taskSkillMentionId = `skill:task-skill:${taskId}:review`;
    await waitFor(
      () => assert.ok(container.querySelector(`[data-option-id="${taskSkillMentionId}"]`)),
      "M1 Skill mentions should use the Host Task catalog",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(`[data-option-id="${taskSkillMentionId}"]`)!
        .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 })),
    );
    assert.equal(
      input.__zcodeLexicalInputE2E!.getText().trimEnd(),
      "/skill review",
      "M1 Skill mention should serialize to the Host-gated /skill command instead of an empty path",
    );
    const catalogReadsBeforeMentionSubmit = skillCatalogLookups.length;
    await submitCurrentDraft();
    await waitFor(
      () => assert.equal(submissions.length, 4),
      "selected Skill mention should be expanded through the Task's /skill preflight",
    );
    assert.equal(skillCatalogLookups.length, catalogReadsBeforeMentionSubmit + 1);
    assert.equal(submissions[3]?.text, buildM0ManualSkillPrompt("review", ""));
    assert.equal(nativeSkillCatalogLookups.length, 0, "M1 mention must not read native catalog");

    const submissionsBeforeShareImport = submissions.length;
    const selectionsBeforeShareImport = selectedTaskIds.length;
    const currentAddContextTrigger = () =>
      container
        .querySelector<SVGElement>("[data-composer-leading-content] svg.lucide-plus")
        ?.closest<HTMLButtonElement>("button");
    await waitFor(
      () => assert.equal(currentAddContextTrigger()?.disabled, false),
      "the add menu should be re-enabled after the Skill catalog lookup completes",
    );
    await act(async () => currentAddContextTrigger()?.click());
    await waitFor(
      () =>
        assert.ok(document.querySelector('[data-testid="conversation-share-import-menu-item"]')),
      "the M1 composer add menu should expose shared-context import",
    );
    await act(async () =>
      document
        .querySelector<HTMLElement>('[data-testid="conversation-share-import-menu-item"]')
        ?.closest<HTMLButtonElement>('button[role="option"]')
        ?.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 })),
    );
    await waitFor(
      () => assert.ok(document.querySelector('[data-testid="conversation-share-import-dialog"]')),
      "selecting shared-context import should open its dialog",
    );
    const shareInput = document.querySelector<HTMLInputElement>(
      '[data-testid="conversation-share-import-input"]',
    );
    assert.ok(shareInput);
    await act(async () => {
      shareInput.focus();
      const valueSetter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(shareInput, "https://zcode.z.ai/cn/share/share_123");
      const propertyChange = new dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      shareInput.dispatchEvent(propertyChange);
      shareInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      shareInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="conversation-share-import-submit"]')
        ?.click(),
    );
    await waitFor(
      () => assert.equal(sharedContextImportRequests.length, 1),
      "share code import did not reach the Host service",
    );
    assert.equal(sharedContextImportRequests[0]?.shareCode, "share_123");
    assert.equal(sharedContextImportRequests[0]?.workspacePath, workspacePath);
    assert.equal(sharedContextImportRequests[0]?.locale, "zh-CN");
    assert.match(
      String(sharedContextImportRequests[0]?.clientRequestId),
      /^share-import-request-/u,
    );
    await waitFor(
      () => assert.equal(selectedTaskIds.length, selectionsBeforeShareImport + 1),
      "a successful import should select its new Task while the source Task remains selected",
    );
    assert.equal(selectedTaskIds.at(-1), importedContextTask.id);
    assert.equal(
      submissions.length,
      submissionsBeforeShareImport,
      "shared-context import must use Host import and must not create a model Input",
    );
    assert.equal(document.querySelector('[data-testid="conversation-share-import-dialog"]'), null);

    const submissionsBeforePlan = submissions.length;
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/plan"));
    await waitFor(
      () => assert.ok(container.querySelector('[data-option-id="app-slash:plan"]')),
      "the product-routed /plan shortcut should be available in the native composer",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-option-id="app-slash:plan"]')!
        .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 })),
    );
    await waitFor(
      () => assert.ok(input.__zcodeLexicalInputE2E!.getText() === ""),
      "selecting /plan should consume only the local mode shortcut",
    );
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/plan explain the change"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')!.click(),
    );
    await waitFor(
      () => assert.equal(submissions.length, submissionsBeforePlan + 1),
      "/plan task was not submitted",
    );
    assert.equal(submissions[submissionsBeforePlan]?.text, "explain the change");
    assert.equal(
      (submissions[submissionsBeforePlan]?.submissionConfig as Record<string, unknown>)
        ?.planEnabled,
      true,
      "/plan task should route through the product submission config in plan mode",
    );

    const structuredMentionPrompt =
      "Inspect [@Review Plugin](plugin://openai.review@1.0.0) before proposing changes";
    await act(async () =>
      input.__zcodeLexicalInputE2E!.setTextWithPluginMentions(structuredMentionPrompt),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')!.click(),
    );
    await waitFor(
      () => assert.equal(submissions.length, submissionsBeforePlan + 2),
      "structured mention prompt was not sent",
    );
    assert.equal(
      submissions[submissionsBeforePlan + 1]?.text,
      structuredMentionPrompt,
      "structured @ Plugin mention markdown should survive Harness submission",
    );
    history.executions.push({
      id: "execution-native-feedback",
      taskId,
      participantId,
      sessionId,
      inputId: "input-initial",
      status: "completed",
      acceptedAt: 910,
      startedAt: 911,
      terminalAt: 950,
      result: "Native feedback answer",
      error: null,
    });
    history.events.push({
      id: "event-native-feedback",
      taskId,
      participantId,
      sessionId,
      inputId: "input-initial",
      executionId: "execution-native-feedback",
      nativeEventId: "native-feedback-event",
      streamId: "stream-native-feedback",
      sourceSequence: 1,
      deliverySequence: 1,
      observedAt: 930,
      source: "engine",
      type: "message.delta",
      payload: {
        text: "Native feedback answer",
        messageId: "native-feedback-message",
        blockId: "native-feedback-block",
      },
      duplicateOf: null,
    });
    history = { ...history };
    await act(async () => {
      for (const listener of changes) listener({ taskId, task: zcodeTask, history });
    });
    await waitFor(
      () =>
        assert.equal(
          container.querySelector<HTMLButtonElement>('button[aria-label="赞"]')?.disabled,
          false,
        ),
      "a terminal native message should enable feedback without leaving the Task",
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="赞"]')!.click(),
    );
    await waitFor(() => assert.equal(nativeFeedback, "like"));
    await act(async () => root.render(appFor(zcodeTaskB.id)));
    await waitFor(
      () =>
        assert.equal(container.querySelector('[data-testid="engine-input-input-initial"]'), null),
      "Task B must not show Task A's native message",
    );
    await act(async () => root.render(appFor(taskId)));
    await waitFor(
      () =>
        assert.equal(
          container.querySelector('button[aria-label="已赞"]')?.getAttribute("aria-pressed"),
          "true",
        ),
      "A→B→A must restore the native feedback state",
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="已赞"]')!.click(),
    );
    await waitFor(() => assert.equal(nativeFeedback, null));
    assert.deepEqual(
      feedbackRequests.map((entry) => entry.feedback),
      ["like", null],
    );
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="v4-retry-execution-native-feedback"]',
    );
    assert.ok(retry && !retry.disabled, "latest native answer should expose the retry action");
    await act(async () => retry.click());
    await waitFor(() => assert.equal(revisionRequests.length, 1));
    assert.deepEqual(revisionRequests[0], {
      taskId,
      participantId,
      sessionId,
      authorizationId: "authorization-engine-ui",
      sourceExecutionId: "execution-native-feedback",
      kind: "retry",
    });
    const fork = container.querySelector<HTMLButtonElement>('button[aria-label="分叉"]');
    assert.ok(fork && !fork.disabled);
    await act(async () => fork.click());
    await waitFor(() => assert.equal(forkRequests.length, 1));
    await act(async () => root.render(appFor(forkTask.id)));
    await waitFor(
      () => assert.match(modelTrigger()?.textContent ?? "", /go-alpha/),
      "forked Session should inherit the source model instead of the current Provider default",
    );
    const forkInput = container.querySelector<HTMLElement>(
      '[data-testid="engine-composer-input"]',
    ) as (HTMLElement & { __zcodeLexicalInputE2E?: { setText: (value: string) => void } }) | null;
    assert.ok(forkInput?.__zcodeLexicalInputE2E);
    await act(async () => forkInput.__zcodeLexicalInputE2E!.setText("Continue the fork"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')!.click(),
    );
    await waitFor(() => assert.equal(submissions.length, submissionsBeforePlan + 3));
    assert.deepEqual(
      (submissions[submissionsBeforePlan + 2]?.submissionConfig as Record<string, unknown>)
        ?.modelSelection,
      {
        providerId: "opencode-go",
        modelId: "go-alpha",
        options: { reasoningLevel: "high" },
      },
    );
    assert.equal(submissions[submissionsBeforePlan + 2]?.taskId, forkTask.id);
    const webContext = {
      workspacePath,
      pageUrl: "https://example.test/review",
      pageTitle: "Review page",
      tagName: "BUTTON",
      accessibleName: "Approve",
      capturedAt: 1_790_260_000_000,
    };
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("zcode:web-element-context-add-to-chat", { detail: webContext }),
      );
    });
    await waitFor(
      () => assert.match(container.textContent ?? "", /网页元素|web page element/i),
      "M1 composer did not accept the browser context",
    );
    await act(async () => forkInput.__zcodeLexicalInputE2E!.setText("Review this element"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')!.click(),
    );
    await waitFor(() => assert.equal(submissions.length, submissionsBeforePlan + 4));
    assert.match(String(submissions[submissionsBeforePlan + 3]?.text), /Review this element/);
    assert.match(
      String(submissions[submissionsBeforePlan + 3]?.text),
      /https:\/\/example\.test\/review/,
    );
    assert.match(String(submissions[submissionsBeforePlan + 3]?.text), /Approve/);
    await waitFor(
      () => assert.doesNotMatch(container.textContent ?? "", /网页元素|web page element/i),
      "accepted browser context should clear from the composer",
    );
    await act(async () => forkInput.__zcodeLexicalInputE2E!.setText("Send only once"));
    await act(async () => {
      const send = container.querySelector<HTMLButtonElement>(
        '[data-testid="engine-composer-submit"]',
      );
      assert.ok(send);
      send.click();
      send.click();
    });
    await waitFor(() => assert.equal(submissions.length, submissionsBeforePlan + 5));
    assert.equal(submissions[submissionsBeforePlan + 4]?.text, "Send only once");
    await act(async () => forkInput.__zcodeLexicalInputE2E!.setText("/init keep workspace notes"));
    await submitCurrentDraft();
    await waitFor(() => assert.equal(submissions.length, submissionsBeforePlan + 6));
    assert.equal(
      submissions[submissionsBeforePlan + 5]?.text,
      "/init keep workspace notes",
      "/init should submit through the product Runtime input path",
    );
    assert.equal(submissions[submissionsBeforePlan + 5]?.taskId, forkTask.id);
    const submissionsBeforeLocale = submissions.length;
    await act(async () => forkInput.__zcodeLexicalInputE2E!.setText("/loc"));
    await waitFor(
      () => assert.ok(container.querySelector('[data-option-id="app-slash:locale"]')),
      "the mapped M0 /locale command should be discoverable in the M1 Composer picker",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-option-id="app-slash:locale"]')!
        .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 })),
    );
    await waitFor(
      () => assert.equal(forkInput.__zcodeLexicalInputE2E!.getText(), "/locale "),
      "selecting /locale should preserve the M0 command form for entering a preference",
    );
    assert.equal(submissions.length, submissionsBeforeLocale);
    await act(async () => forkInput.__zcodeLexicalInputE2E!.setText("/locale"));
    await submitCurrentDraft();
    await waitFor(
      () => assert.ok(document.body.textContent?.includes("当前界面语言：zh-CN（偏好：zh-CN）")),
      "/locale should report the product's current UI preference",
    );
    await act(async () => forkInput.__zcodeLexicalInputE2E!.setText("/locale en-US"));
    await submitCurrentDraft();
    await waitFor(
      () => assert.equal(dom.window.localStorage.getItem("zcode-locale-preference"), "en-US"),
      "/locale en-US should update the product's persisted locale preference",
    );
    await act(async () => forkInput.__zcodeLexicalInputE2E!.setText("/locale fr-FR"));
    await submitCurrentDraft();
    assert.equal(forkInput.__zcodeLexicalInputE2E!.getText(), "/locale fr-FR");
    await waitFor(
      () => assert.ok(document.body.textContent?.includes("Unsupported UI locale fr-FR")),
      "an unsupported locale should preserve its draft and explain the accepted values",
    );
    await act(async () => forkInput.__zcodeLexicalInputE2E!.setText("/language auto"));
    await submitCurrentDraft();
    await waitFor(
      () => assert.equal(dom.window.localStorage.getItem("zcode-locale-preference"), "system"),
      "/language auto should persist the product system locale preference",
    );
    await act(async () => forkInput.__zcodeLexicalInputE2E!.setText("/locale zh-CN"));
    await submitCurrentDraft();
    await waitFor(
      () => assert.equal(dom.window.localStorage.getItem("zcode-locale-preference"), "zh-CN"),
      "the UI locale should restore to its original test language",
    );
    assert.equal(
      submissions.length,
      submissionsBeforeLocale,
      "locale must not create a Task Input",
    );
    await act(async () => {
      forkInput.blur();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    zcodeSessionStore.setSlashCommands(workspacePath, originalSlashCommands);
    dom.window.close();
  }
});

test("Engine file rewind uses the native summary and preview dialog through mounted controls", async () => {
  const dom = installDom();
  const [{ EngineExecutionFileSummary }, { ZCodeIntlProvider }, { TooltipProvider }] =
    await Promise.all([
      import("../src/EngineExecutionFileSummary.js"),
      import("../src/i18n/IntlProvider.js"),
      import("../src/components/ui/tooltip.js"),
    ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const preview = {
    canApply: true,
    safeFiles: [
      {
        action: "delete" as const,
        operationCount: 1,
        path: "/tmp/anyagent-ui/m1-rewind.txt",
        toolNames: ["Write"],
      },
    ],
    unsafeFiles: [],
    ignoredFiles: [],
  };
  let reverted = false;
  const applied: Array<{ executionId: string; preview: typeof preview }> = [];
  const props = {
    executionId: "execution-file-rewind",
    workspacePath: "/tmp/anyagent-ui",
    loadChanges: async () => ({
      canRewind: !reverted,
      files: 1,
      additions: reverted ? 0 : 1,
      deletions: 0,
      state: reverted ? ("reverted" as const) : ("active" as const),
      items: [],
    }),
    previewRewind: async () => preview,
    applyRewind: async (executionId: string, expectedPreview: typeof preview) => {
      applied.push({ executionId, preview: expectedPreview });
      reverted = true;
      return { status: "applied" as const, reason: null };
    },
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(TooltipProvider, null, createElement(EngineExecutionFileSummary, props)),
        ),
      ),
    );
    await waitFor(
      () => assert.match(container.textContent ?? "", /1 个文件|1 file/),
      "native file summary should show the Engine execution changes",
    );
    const rewind = Array.from(container.querySelectorAll("button")).find((button) =>
      /撤销|Undo/i.test(button.textContent ?? ""),
    );
    assert.ok(rewind && !rewind.disabled);
    await act(async () => rewind.click());
    await waitFor(
      () => assert.match(document.body.textContent ?? "", /m1-rewind\.txt/),
      "native preview dialog should show the exact file",
    );
    const confirm = Array.from(document.body.querySelectorAll("button")).find((button) =>
      /撤销文件|Rewind files/i.test(button.textContent ?? ""),
    );
    assert.ok(confirm && !confirm.disabled);
    await act(async () => confirm.click());
    await waitFor(() => assert.equal(applied.length, 1), "native confirmation should apply once");
    assert.equal(applied[0]?.executionId, props.executionId);
    assert.deepEqual(applied[0]?.preview, preview);
    await waitFor(
      () => assert.match(container.textContent ?? "", /已撤销|reverted/i),
      "the summary should refresh after the native action",
    );
    assert.equal(rewind.disabled, true);
    await act(async () =>
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(
            TooltipProvider,
            null,
            createElement(EngineExecutionFileSummary, {
              ...props,
              loadChanges: async () => {
                throw new Error("native Session unavailable");
              },
            }),
          ),
        ),
      ),
    );
    await waitFor(
      () => assert.equal(container.textContent, ""),
      "a failed native lookup must not leak diagnostics into the conversation",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.close();
  }
});

test("unknown native Session and Execution require explicit identity-bound recovery actions", async () => {
  const dom = installDom();
  const [
    { EngineConversation },
    { ServiceProvider },
    { PlatformProvider },
    { ZCodeIntlProvider },
    { TabStoreProvider },
    { TooltipProvider },
  ] = await Promise.all([
    import("../src/EngineConversation.js"),
    import("../src/hooks/useServices.js"),
    import("../src/hooks/usePlatform.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/store/TabStoreProvider.js"),
    import("../src/components/ui/tooltip.js"),
  ]);
  const zcodeEngine = { ...currentEngine, engineId: "zcode" };
  let activeTask = {
    ...task,
    authorizationId: "authorization-recovery-ui",
    engine: { ...task.engine, engineId: "zcode" },
    currentEngine: zcodeEngine,
    session: {
      ...task.session,
      status: "unknown",
      nativeSessionId: "native-session-after-restart",
    },
  };
  const sourceInput = {
    id: "input-after-disconnect",
    taskId,
    participantId,
    sessionId,
    text: "finish the original request",
    submissionConfig: {
      mode: "build",
      planEnabled: false,
      modelSelection: {
        providerId: "opencode-go",
        modelId: "go-alpha",
        options: { reasoningLevel: "low" },
      },
    },
    status: "unknown",
    receivedAt: 1_100,
    acceptedAt: 1_101,
    startedAt: 1_102,
    terminalAt: null,
    error: "connection lost",
  };
  const unknownExecution = {
    id: "execution-after-disconnect",
    taskId,
    participantId,
    sessionId,
    inputId: sourceInput.id,
    nativeExecutionId: "native-command-after-disconnect",
    status: "unknown",
    acceptedAt: 1_101,
    startedAt: 1_102,
    terminalAt: null,
    result: null,
    error: "connection lost",
    reconciliationReason: "Native command state is not yet terminal.",
  };
  let activeHistory = {
    ...emptyHistory(taskId),
    inputs: [sourceInput],
    executions: [unknownExecution],
    compactOperations: [],
    fileRewindOperations: [],
  };
  const restoreRequests: Array<Record<string, unknown>> = [];
  const reconcileRequests: Array<Record<string, unknown>> = [];
  const submittedInputs: Array<Record<string, unknown>> = [];
  const feedbackReads: string[] = [];
  const listeners = new Set<(change: Record<string, unknown>) => void>();
  let rejectRestore = true;
  let releaseRestore: (() => void) | null = null;
  let releaseReconciliation: (() => void) | null = null;
  const restoreGate = new Promise<void>((resolve) => {
    releaseRestore = resolve;
  });
  const reconciliationGate = new Promise<void>((resolve) => {
    releaseReconciliation = resolve;
  });
  const modelView = {
    revision: 1,
    providers: [
      {
        providerId: "opencode-go",
        providerName: "OpenCode Go",
        config: { api: { type: "openai" }, visibility: "visible" },
        models: [
          {
            modelId: "go-alpha",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
          },
        ],
      },
    ],
    preferredSelection: {
      providerId: "opencode-go",
      modelId: "go-alpha",
      options: { reasoningLevel: "low" },
    },
  };
  const service = {
    listTasks: async () => [activeTask],
    getTask: async (id: string) => (id === taskId ? activeTask : null),
    getHistory: async (id: string) => (id === taskId ? activeHistory : null),
    listEngines: async () => [zcodeEngine],
    getExecutionFileChanges: async () => null,
    getAssistantFeedback: async () => {
      feedbackReads.push(activeTask.session.status);
      return activeTask.session.status === "active"
        ? { state: "current", values: {} }
        : { state: "unknown", reason: "Native Session is not attached yet." };
    },
    onDidChange: (listener: (change: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    submitInput: async (input: Record<string, unknown>) => submittedInputs.push(input),
    reconcileExecution: async (request: Record<string, unknown>) => {
      reconcileRequests.push(request);
      await reconciliationGate;
      const terminalExecution = {
        ...unknownExecution,
        status: "completed",
        terminalAt: 1_200,
        result: "original execution completed",
        error: null,
      };
      activeHistory = {
        ...activeHistory,
        inputs: activeHistory.inputs.map((input) =>
          input.id === sourceInput.id
            ? { ...input, status: "completed", terminalAt: 1_200, error: null }
            : input,
        ),
        executions: [terminalExecution],
      };
      return terminalExecution;
    },
    restoreTaskSession: async (request: Record<string, unknown>) => {
      restoreRequests.push(request);
      if (restoreRequests.length === 1) await restoreGate;
      if (rejectRestore) throw new Error("授权已失效，请在 App 内重新授权后重试。");
      activeTask = {
        ...activeTask,
        session: { ...activeTask.session, status: "active" },
      };
      return activeTask;
    },
  };
  const services = {
    clientConfigService: { getSnapshot: async () => ({ pluginStoreOrder: null }) },
    fileService: { searchWorkspaceFiles: async () => [] },
    subagentsService: {
      list: async () => ({
        agents: [],
        userAgents: [],
        pluginAgents: [],
        capability: { userScopeAvailable: false },
      }),
    },
    zcodeAgentService: {
      getSkillReferenceCatalog: async () => ({ skills: [], authority: "session" }),
      onAgentRuntimeRestarted: () => ({ dispose: () => {} }),
    },
    modelSelectionService: {
      getView: async () => modelView,
      onDidChange: () => ({ dispose: () => {} }),
    },
  };
  const platform = {
    canSelectFilePath: true,
    selectFiles: async () => ["/tmp/anyagent-ui/not-used.txt"],
    onSettingsChanged: () => () => {},
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const app = createElement(
    TooltipProvider,
    null,
    createElement(
      ServiceProvider,
      { services: services as never },
      createElement(
        PlatformProvider,
        { platform: platform as never },
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(
            TabStoreProvider,
            null,
            createElement(EngineConversation, {
              service: service as never,
              selectedTaskId: taskId,
              onSelectTask: () => {},
            }),
          ),
        ),
      ),
    ),
  );
  try {
    await act(async () => root.render(app));
    await waitFor(() => {
      assert.ok(container.querySelector('[data-testid="engine-session-recovery"]'));
      assert.ok(
        container.querySelector('[data-testid="reconcile-execution-execution-after-disconnect"]'),
      );
      assert.equal(
        container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')
          ?.disabled,
        true,
      );
      assert.equal(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="engine-composer-attachment-action"]',
        )?.disabled,
        true,
      );
    }, "unknown Session should show explicit recovery controls while blocking composer actions");
    assert.equal(restoreRequests.length, 0, "history selection must not restore automatically");
    assert.equal(reconcileRequests.length, 0, "history selection must not reconcile automatically");

    const reconcileButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="reconcile-execution-execution-after-disconnect"]',
    );
    assert.ok(reconcileButton);
    await act(async () => {
      reconcileButton.click();
      reconcileButton.click();
    });
    await waitFor(
      () => assert.equal(reconcileRequests.length, 1),
      "reconcile should dispatch once",
    );
    assert.deepEqual(reconcileRequests[0], {
      taskId,
      participantId,
      sessionId,
      authorizationId: "authorization-recovery-ui",
      executionId: unknownExecution.id,
    });
    assert.equal(reconcileButton.disabled, true, "a pending reconcile cannot be dispatched twice");
    assert.equal(submittedInputs.length, 0, "reconcile must never resend the original input");
    await act(async () => {
      releaseReconciliation?.();
    });
    await waitFor(
      () => assert.ok(container.querySelector('[data-testid="restore-engine-session"]')),
      "terminal reconciliation should unblock explicit Session recovery",
    );
    assert.equal(submittedInputs.length, 0);

    const restoreButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="restore-engine-session"]',
    );
    assert.ok(restoreButton);
    await act(async () => {
      restoreButton.click();
      restoreButton.click();
    });
    await waitFor(() => assert.equal(restoreRequests.length, 1), "restore should dispatch once");
    assert.deepEqual(restoreRequests[0], {
      taskId,
      participantId,
      sessionId,
      authorizationId: "authorization-recovery-ui",
    });
    assert.equal(restoreButton.disabled, true, "a pending restore cannot be dispatched twice");
    releaseRestore?.();
    await waitFor(
      () =>
        assert.match(
          container.querySelector('[data-testid="restore-session-error"]')?.textContent ?? "",
          /授权已失效/,
        ),
      "expired authorization should stay visible and leave the Session unknown",
    );
    assert.equal(container.querySelector('[data-testid="engine-session-recovery"]') !== null, true);

    rejectRestore = false;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="restore-engine-session"]')!.click();
    });
    await waitFor(
      () =>
        assert.equal(
          container.querySelector('[data-testid="engine-session-recovery"]'),
          null,
          "the unknown-state panel should disappear after the same Session is restored",
        ),
      "successful recovery did not refresh the selected Task state",
    );
    await waitFor(
      () =>
        assert.equal(
          container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')
            ?.disabled,
          false,
        ),
      "the composer should become available only after explicit successful recovery",
    );
    await waitFor(
      () => assert.ok(feedbackReads.includes("active")),
      "native feedback should be reread after the original Session is attached",
    );
    assert.equal(restoreRequests.length, 2);
    assert.deepEqual(restoreRequests[1], restoreRequests[0]);
    assert.equal(submittedInputs.length, 0, "recovery must not replay the original input");

    activeTask = {
      ...activeTask,
      status: "completed",
      closeReason: "completed by owner",
      session: { ...activeTask.session, status: "unknown" },
    };
    await act(async () => {
      for (const listener of listeners)
        listener({ taskId, task: activeTask, history: activeHistory });
    });
    await waitFor(() => {
      assert.match(
        container.querySelector('[data-testid="engine-session-recovery"]')?.textContent ?? "",
        /此 Task 已结束，不能恢复后继续/,
      );
      assert.equal(container.querySelector('[data-testid="restore-engine-session"]'), null);
    }, "terminal Task reason should remain visible without exposing a restore action");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.close();
  }
});
