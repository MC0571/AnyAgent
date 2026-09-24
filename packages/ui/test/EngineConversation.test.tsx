import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const taskId = "task-engine-ui";
const participantId = "participant-engine-ui";
const sessionId = "product-session-engine-ui";
const engineId = "fake-engine";
const available = { support: "supported", availability: "available" } as const;
const capabilities = {
  "session.create": available,
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
  const stagedAttachmentRequests: Array<Record<string, unknown>> = [];
  const selectedLocalPaths = ["/tmp/anyagent-ui/src/two.ts"];
  const replies: Array<{ approvalId: string; optionId: string }> = [];
  const feedbackRequests: Array<Record<string, unknown>> = [];
  const stopRequests: Array<{ taskId: string; executionId: string }> = [];
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
    }: {
      taskId: string;
      text: string;
      attachments?: Array<Record<string, unknown>>;
    }) => {
      if (failNextSubmit) {
        failNextSubmit = false;
        throw new Error("Fake host rejected this input");
      }
      if (submittedTaskId !== taskId) throw new Error(`Unexpected task ${submittedTaskId}`);
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
      () => assert.ok(container.textContent?.includes("Fake host rejected this input")),
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
      true,
      "another turn must wait while the current Execution is active",
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
      [structuredMentionPrompt],
      "an accepted Engine input should use the existing workspace prompt history",
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
      "此能力暂不可用",
    );
    await checkCapability(
      { support: "supported", availability: "authorization-required" },
      "current",
      true,
      "当前授权不足",
    );
    await checkCapability(
      { support: "unknown", availability: "unknown" },
      "current",
      true,
      "Engine 支持情况未知",
    );
    await checkCapability(
      { support: "unsupported", availability: "unknown" },
      "current",
      true,
      "Engine 不支持此操作",
    );
    await checkCapability(available, "unknown", true, "Engine 当前状态未知");
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
    await waitFor(
      () =>
        assert.match(
          container.querySelector('[role="alert"]')?.textContent ?? "",
          /Fake host rejected/,
        ),
      "failed submission should show the Host error",
    );
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
    assert.match(
      container.querySelector('[role="alert"]')?.textContent ?? "",
      /Project directory unavailable/,
    );
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
  } finally {
    await act(async () => root.unmount());
    container.remove();
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
    approvals: [approval("approval-one"), { ...approval("approval-two"), options: [] }],
    userInputs: [request("request-one"), { ...request("request-two"), options: [] }],
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
    for (const id of ["approval-one", "approval-two", "request-one", "request-two"]) {
      const control = execution.querySelector<HTMLElement>(
        `[data-testid="engine-${id.startsWith("approval") ? "approval" : "user-input"}-${id}"]`,
      );
      assert.ok(control, `${id} must remain visible`);
      assert.ok(second.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING);
    }
    assert.match(execution.textContent ?? "", /内部顺序未知/);
    for (const id of ["approval-two", "request-two"]) {
      assert.match(
        execution.querySelector(
          `[data-testid="engine-${id.startsWith("approval") ? "approval" : "user-input"}-${id}"]`,
        )?.textContent ?? "",
        /未提供可答复选项/,
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
  const zcodeEngine = { ...currentEngine, engineId: "zcode" };
  const zcodeTask = {
    ...task,
    engine: { ...task.engine, engineId: "zcode" },
    currentEngine: zcodeEngine,
    session: { ...task.session, nativeSessionId: "native-zcode-session-ui" },
  };
  const workspacePath = "/tmp/anyagent-ui";
  const zcodeSlashCommands = [
    { name: "compact", description: "Compact", source: "builtin" as const },
    { name: "goal", description: "Goal", source: "builtin" as const },
    { name: "help", description: "Help", source: "builtin" as const },
    { name: "mode", description: "Mode", source: "builtin" as const },
    { name: "init", description: "Initialize", source: "builtin" as const },
    { name: "skill", description: "Use a skill", source: "builtin" as const },
    { name: "custom-note", description: "Custom prompt", source: "custom" as const },
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
      providerId: "opencode-go",
      modelId: "go-alpha",
      options: { reasoningLevel: "high" },
    },
  };
  const submissions: Array<Record<string, unknown>> = [];
  const skillCatalogLookups: Array<Record<string, unknown>> = [];
  const history = emptyHistory();
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
    listTasks: async () => [zcodeTask],
    getTask: async () => zcodeTask,
    getHistory: async () => history,
    listEngines: async () => [zcodeEngine],
    onDidChange: () => ({ dispose: () => {} }),
    submitInput: async (input: Record<string, unknown>) => {
      submissions.push(input);
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
      getSkillReferenceCatalog: async (params: Record<string, unknown>) => {
        skillCatalogLookups.push(params);
        return { skills: [], authority: "session" };
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
  try {
    await act(async () =>
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(
            ServiceProvider,
            { services: services as never },
            createElement(
              PlatformProvider,
              { platform: { onSettingsChanged: () => () => {} } as never },
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
        ),
      ),
    );
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
    await act(async () => input.__zcodeLexicalInputE2E!.setText("Use the selected model"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')!.click(),
    );
    await waitFor(() => assert.equal(submissions.length, 1), "the chosen model was not submitted");
    const submissionConfig = submissions[0]?.submissionConfig as Record<string, unknown>;
    assert.deepEqual(submissionConfig.modelSelection, {
      providerId: "opencode-go",
      modelId: "go-beta",
      options: { reasoningLevel: "low" },
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
    assert.equal(
      container.querySelector('[data-option-id="slash:compact"]'),
      null,
      "the native-only compact command must not be advertised as a Harness action",
    );
    await act(async () => input.__zcodeLexicalInputE2E!.setText("/compact instructions"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="engine-composer-submit"]')!.click(),
    );
    assert.equal(submissions.length, 1, "unmapped /compact must not become submitInput text");
    assert.equal(input.__zcodeLexicalInputE2E!.getText(), "/compact instructions");
    assert.match(
      container.querySelector('[role="status"]')?.textContent ?? "",
      /独立的上下文维护操作.*没有对应操作.*输入已保留/,
    );

    await act(async () => input.__zcodeLexicalInputE2E!.setText("/skill"));
    await waitFor(
      () => assert.ok(container.querySelector('[data-option-id="slash:skill"]')),
      "safe native Skill prompt command should remain available",
    );
    await waitFor(
      () =>
        assert.ok(
          skillCatalogLookups.some((lookup) => lookup.sessionId === "native-zcode-session-ui"),
        ),
      "native Skill catalog did not receive the verified native Session ID",
    );

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
    await waitFor(() => assert.equal(submissions.length, 2), "/plan task was not submitted");
    assert.equal(submissions[1]?.text, "explain the change");
    assert.equal(
      (submissions[1]?.submissionConfig as Record<string, unknown>)?.planEnabled,
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
      () => assert.equal(submissions.length, 3),
      "structured mention prompt was not sent",
    );
    assert.equal(
      submissions[2]?.text,
      structuredMentionPrompt,
      "structured @ Plugin mention markdown should survive Harness submission",
    );
    await act(async () => {
      input.blur();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    zcodeSessionStore.setSlashCommands(workspacePath, originalSlashCommands);
    dom.window.close();
  }
});
