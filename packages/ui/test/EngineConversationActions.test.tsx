import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { buildPromptWithWebElementContexts } from "../src/lib/webElementContext.js";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  dom.window.matchMedia = (() => ({
    matches: false,
    media: "",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof dom.window.matchMedia;
  dom.window.HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    customElements: dom.window.customElements,
    matchMedia: dom.window.matchMedia.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    DocumentFragment: dom.window.DocumentFragment,
    NodeFilter: dom.window.NodeFilter,
    Text: dom.window.Text,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    FocusEvent: dom.window.FocusEvent,
    SVGElement: dom.window.SVGElement,
    DOMRect: dom.window.DOMRect,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.getAttribute("role") === "listbox" ? 224 : 0;
    },
  });
  dom.window.Element.prototype.hasPointerCapture = () => false;
  dom.window.Element.prototype.setPointerCapture = () => {};
  dom.window.Element.prototype.releasePointerCapture = () => {};
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  return dom;
}

async function waitForElement(selector: string): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) return element;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${selector}`);
}

test("send-now queue history follows native dispatch order in the mounted conversation", async () => {
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
  const task = {
    id: "queue-task",
    participant: { id: "queue-participant" },
    session: { id: "queue-session" },
  };
  const input = (id: string, text: string, receivedAt: number, startedAt: number) => ({
    id,
    taskId: task.id,
    participantId: task.participant.id,
    sessionId: task.session.id,
    text,
    status: "completed",
    receivedAt,
    acceptedAt: startedAt,
    startedAt,
    terminalAt: startedAt + 1,
    error: null,
  });
  const inputs = [
    input("source", "source", 100, 110),
    input("queued-a", "queued A", 120, 300),
    input("queued-b", "queued B sent now", 130, 200),
  ];
  const history = {
    taskId: task.id,
    inputs,
    executions: inputs.map((item) => ({
      id: `execution-${item.id}`,
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      inputId: item.id,
      status: "completed",
      acceptedAt: item.acceptedAt,
      startedAt: item.startedAt,
      terminalAt: item.terminalAt,
      result: `${item.text} answer`,
      error: null,
    })),
    events: [],
    approvals: [],
    userInputs: [],
    stopRequests: [],
    compactOperations: [],
    integrityIssues: [],
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
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
    const orderedInputs = [
      ...container.querySelectorAll<HTMLElement>("[data-testid^='engine-input-']"),
    ].map((element) => element.getAttribute("data-testid"));
    assert.deepEqual(orderedInputs, [
      "engine-input-source",
      "engine-input-queued-b",
      "engine-input-queued-a",
    ]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.close();
  }
});

test("Engine completed answers reuse native bubble and message actions", async () => {
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
  const taskId = "task-actions";
  const participantId = "participant-actions";
  const sessionId = "session-actions";
  const now = Date.now();
  const inputs = [1, 2].map((index) => ({
    id: `input-${index}`,
    taskId,
    participantId,
    sessionId,
    text: `question ${index}`,
    status: "started",
    receivedAt: now - 4_000,
    acceptedAt: now - 3_500,
    startedAt: now - 3_000,
    terminalAt: now,
    error: null,
  }));
  const executions = [1, 2].map((index) => ({
    id: `execution-${index}`,
    taskId,
    participantId,
    sessionId,
    inputId: `input-${index}`,
    status: "completed",
    acceptedAt: now - 3_500,
    startedAt: now - 3_000,
    terminalAt: now,
    result: `answer ${index}`,
    error: null,
  }));
  const history = {
    taskId,
    inputs,
    executions,
    events: [],
    approvals: [],
    userInputs: [],
    stopRequests: [],
    integrityIssues: [],
  };
  const task = {
    id: taskId,
    participant: { id: participantId },
    session: { id: sessionId },
  };
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => copied.push(value) },
  });

  try {
    await act(async () => {
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

    const userMessage = container.querySelector<HTMLElement>(
      '[data-testid="engine-input-input-2"]',
    );
    const userBubble = userMessage?.querySelector<HTMLElement>("[data-v4-user-input-bubble]");
    assert.ok(userBubble);
    assert.match(userMessage?.firstElementChild?.className ?? "", /items-end/u);
    assert.match(userBubble.className, /rounded-tr-xs/u);
    assert.match(userBubble.className, /@min-\[624px\]\/conversation:max-w-xl/u);
    assert.equal(userBubble.textContent, "question 2");

    for (const index of [1, 2]) {
      const answer = container.querySelector<HTMLElement>(
        `[data-testid="engine-final-execution-${index}"]`,
      );
      assert.ok(answer, `completed answer ${index} is rendered`);
      assert.equal(answer.querySelectorAll('button[aria-label="复制"]').length, 1);
      const execution = container.querySelector<HTMLElement>(
        `[data-testid="engine-execution-execution-${index}"]`,
      );
      assert.ok(execution);
      assert.ok(answer.querySelector('[aria-label="复制"]'));
      const like = answer.querySelector<HTMLButtonElement>('[aria-label="赞"]');
      const dislike = answer.querySelector<HTMLButtonElement>('[aria-label="踩"]');
      const fork = answer.querySelector<HTMLButtonElement>('[aria-label="分叉"]');
      assert.equal(like?.getAttribute("aria-disabled"), "true");
      assert.equal(dislike?.getAttribute("aria-disabled"), "true");
      assert.equal(fork?.getAttribute("aria-disabled"), "true");
      assert.match(like?.title ?? "", /暂不支持保存消息反馈/u);
      assert.match(fork?.title ?? "", /暂不支持从此消息分叉/u);
      const timestamp = answer.querySelector<HTMLElement>("span.select-none");
      assert.ok(timestamp?.textContent, "the native action row displays the answer time");
      assert.match(execution.textContent ?? "", /已工作 3 秒/u);
      assert.match(answer.textContent ?? "", /answer/u);
      await act(async () => {
        like?.click();
        dislike?.click();
        fork?.click();
      });
      assert.equal(like?.getAttribute("aria-disabled"), "true");
      assert.equal(dislike?.getAttribute("aria-disabled"), "true");
      assert.equal(fork?.getAttribute("aria-disabled"), "true");
    }

    const copy = container.querySelector<HTMLButtonElement>(
      '[data-testid="engine-final-execution-2"] button[aria-label="复制"]',
    );
    assert.ok(copy);
    await act(async () => {
      copy.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(copied, ["answer 2"]);

    history.inputs[1]!.text = buildPromptWithWebElementContexts("question 2", [
      {
        id: "web-context-2",
        workspacePath: "/tmp/anyagent-ui",
        pageUrl: "https://example.test/review",
        pageTitle: "Review page",
        tagName: "BUTTON",
        accessibleName: "Approve",
        capturedAt: now,
      },
    ]);
    await act(async () => {
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
    const contextBubble = container.querySelector<HTMLElement>(
      '[data-testid="engine-input-input-2"] [data-v4-user-input-bubble]',
    );
    assert.ok(contextBubble);
    assert.match(contextBubble.textContent ?? "", /question 2/u);
    assert.match(contextBubble.textContent ?? "", /1 个网页元素/u);
    assert.doesNotMatch(contextBubble.textContent ?? "", /# Web page elements:/u);

    // A later product input without an Execution must not make an older user
    // query look editable; native v4 decides editability on the latest query.
    history.inputs.push({
      ...inputs[1]!,
      id: "input-3",
      text: "unaccepted latest question",
      status: "rejected",
      receivedAt: now + 1_000,
    });
    await act(async () => {
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
              onEditExecution: async () => true,
            }),
          ),
        ),
      );
    });
    assert.equal(container.querySelector('[data-testid="engine-edit-input-2"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.close();
  }
});

test("fork action uses the completed product Execution and inherited source stays read-only", async () => {
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
  const now = Date.now();
  const source = {
    id: "source-task",
    participant: { id: "source-participant" },
    session: { id: "source-session" },
  };
  const sourceHistory = {
    taskId: source.id,
    inputs: [
      {
        id: "source-input",
        taskId: source.id,
        participantId: source.participant.id,
        sessionId: source.session.id,
        text: "original question",
        status: "completed",
        receivedAt: now - 3_000,
        acceptedAt: now - 2_900,
        startedAt: now - 2_800,
        terminalAt: now - 1_000,
        error: null,
      },
    ],
    executions: [
      {
        id: "source-execution",
        taskId: source.id,
        participantId: source.participant.id,
        sessionId: source.session.id,
        inputId: "source-input",
        status: "completed",
        acceptedAt: now - 2_900,
        startedAt: now - 2_800,
        terminalAt: now - 1_000,
        result: "original answer",
        error: null,
      },
    ],
    events: [],
    approvals: [],
    userInputs: [],
    stopRequests: [],
    integrityIssues: [],
  };
  const child = {
    id: "child-task",
    participant: { id: "child-participant" },
    session: { id: "child-session" },
  };
  const childHistory = {
    ...sourceHistory,
    taskId: child.id,
    inputs: [
      {
        ...sourceHistory.inputs[0]!,
        id: "child-input",
        taskId: child.id,
        participantId: child.participant.id,
        sessionId: child.session.id,
        text: "new branch question",
      },
    ],
    executions: [
      {
        ...sourceHistory.executions[0]!,
        id: "child-execution",
        taskId: child.id,
        participantId: child.participant.id,
        sessionId: child.session.id,
        inputId: "child-input",
        result: "new branch answer",
      },
    ],
  };
  const called: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(
            TooltipProvider,
            null,
            createElement(EngineConversationTimeline, {
              projection: projectEngineConversation(child as never, childHistory as never),
              inheritedSources: [
                {
                  sourceTaskId: source.id,
                  projection: projectEngineConversation(source as never, sourceHistory as never),
                },
              ],
              workspacePath: "/tmp/anyagent-ui",
              historyLoading: false,
              approvalBlockedReason: null,
              userInputBlockedReason: null,
              busyAction: null,
              onReplyApproval: () => {},
              onReplyUserInput: () => {},
              onForkExecution: (executionId: string) => called.push(executionId),
            }),
          ),
        ),
      );
    });
    assert.match(
      container.textContent ?? "",
      /original question[\s\S]*original answer[\s\S]*new branch question[\s\S]*new branch answer/u,
    );
    const sourceAnswer = container.querySelector<HTMLElement>(
      '[data-testid="engine-inherited-source-source-task"] [data-testid="engine-final-source-execution"]',
    );
    assert.ok(sourceAnswer);
    assert.equal(
      sourceAnswer.querySelector('[aria-label="分叉"]')?.getAttribute("aria-disabled"),
      "true",
    );
    const childFork = container.querySelector<HTMLButtonElement>(
      '[data-testid="engine-final-child-execution"] [aria-label="分叉"]',
    );
    assert.ok(childFork);
    await act(async () => childFork.click());
    assert.deepEqual(called, ["child-execution"]);
    assert.equal(
      container.querySelectorAll('[data-testid="engine-execution-source-execution"]').length,
      1,
      "inherited Execution must stay a single read-only source row",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.close();
  }
});

test("product conversation forks into a fresh Task and displays only its verified source prefix", async () => {
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
  const available = { support: "supported", availability: "available" };
  const capabilities = {
    "session.fork": available,
    "execution.run": available,
    "execution.revise": available,
  };
  const engine = {
    engineId: "fake-engine",
    adapterVersion: "fake-adapter-1",
    engineVersion: "Fake Engine 1",
    configurationVersion: "cfg-1",
    environment: "workspace",
    capabilities,
    state: "current",
    observedAt: 1_000,
    source: "active-probe",
  };
  const sourceTask = {
    id: "source-task",
    authorizationId: "source-authorization",
    status: "active",
    createdAt: 900,
    updatedAt: 1_000,
    closedAt: null,
    closeReason: null,
    currentAuthorization: { status: "current", reason: null, observedAt: 1_000 },
    engine,
    currentEngine: engine,
    environment: { id: "env", kind: "workspace", workDirectory: "/tmp/anyagent-ui" },
    credentialSource: { kind: "none" },
    participant: { id: "source-participant", status: "active", createdAt: 900 },
    session: {
      id: "source-session",
      status: "active",
      createdAt: 900,
      updatedAt: 1_000,
      environmentId: "env",
    },
  };
  const childTask = {
    ...sourceTask,
    id: "child-task",
    authorizationId: "child-authorization",
    participant: { ...sourceTask.participant, id: "child-participant" },
    session: { ...sourceTask.session, id: "child-session" },
    forkedFrom: {
      taskId: sourceTask.id,
      inputId: "source-input-1",
      executionId: "source-execution-1",
    },
  };
  const sourceHistory = {
    taskId: sourceTask.id,
    inputs: [1, 2].map((index) => ({
      id: `source-input-${index}`,
      taskId: sourceTask.id,
      participantId: sourceTask.participant.id,
      sessionId: sourceTask.session.id,
      text: `question ${index}`,
      ...(index === 2
        ? {
            attachments: [
              {
                id: "source-attachment",
                fileName: "notes.md",
                mimeType: "text/markdown",
                sizeBytes: 12,
              },
            ],
          }
        : {}),
      status: "completed",
      receivedAt: index * 1_000,
      acceptedAt: index * 1_000 + 1,
      startedAt: index * 1_000 + 2,
      terminalAt: index * 1_000 + 100,
      error: null,
    })),
    executions: [1, 2].map((index) => ({
      id: `source-execution-${index}`,
      taskId: sourceTask.id,
      participantId: sourceTask.participant.id,
      sessionId: sourceTask.session.id,
      inputId: `source-input-${index}`,
      status: "completed",
      acceptedAt: index * 1_000 + 1,
      startedAt: index * 1_000 + 2,
      terminalAt: index * 1_000 + 100,
      result: `answer ${index}`,
      error: null,
    })),
    events: [],
    approvals: [],
    userInputs: [],
    stopRequests: [],
    compactOperations: [],
    integrityIssues: [],
  };
  const childHistory = { ...sourceHistory, taskId: childTask.id, inputs: [], executions: [] };
  const forkRequests: Record<string, unknown>[] = [];
  const revisionRequests: Record<string, unknown>[] = [];
  const stageRequests: Record<string, unknown>[] = [];
  let childCreated = false;
  let sourceAvailable = true;
  let refreshVersion = 0;
  const service = {
    listTasks: async () => (childCreated ? [sourceTask, childTask] : [sourceTask]),
    getTask: async (id: string) =>
      id === sourceTask.id ? sourceTask : id === childTask.id && childCreated ? childTask : null,
    getHistory: async (id: string) => {
      if (id === sourceTask.id && sourceAvailable) {
        return {
          ...sourceHistory,
          inputs: [...sourceHistory.inputs],
          executions: [...sourceHistory.executions],
        };
      }
      return id === childTask.id && childCreated ? childHistory : null;
    },
    listEngines: async () => [engine],
    onDidChange: () => ({ dispose: () => {} }),
    stageAttachment: async (request: Record<string, unknown>) => {
      stageRequests.push(request);
      return { id: "new-attachment", fileName: "new.txt", mimeType: "text/plain", sizeBytes: 7 };
    },
    forkTask: async (request: Record<string, unknown>) => {
      forkRequests.push(request);
      childCreated = true;
      return childTask;
    },
    reviseTurn: async (request: Record<string, unknown>) => {
      revisionRequests.push(request);
      sourceHistory.inputs.push({
        ...sourceHistory.inputs[1]!,
        id: "revised-input",
        text: String(request.text),
        receivedAt: 3_000,
        revisionOf: {
          kind: "edit",
          inputId: "source-input-2",
          executionId: "source-execution-2",
        },
      } as never);
      sourceHistory.executions.push({
        ...sourceHistory.executions[1]!,
        id: "revised-execution",
        inputId: "revised-input",
        acceptedAt: 3_001,
        result: "revised answer",
        revisionOf: {
          kind: "edit",
          inputId: "source-input-2",
          executionId: "source-execution-2",
        },
      } as never);
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let selected = sourceTask.id;
  const render = async () => {
    await act(async () => {
      root.render(
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
                  onSettingsChanged: () => () => {},
                  selectFiles: async () => ["/tmp/new.txt"],
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
                    selectedTaskId: selected,
                    refreshVersion,
                    onSelectTask: (id: string | null) => {
                      if (id) selected = id;
                    },
                  }),
                ),
              ),
            ),
          ),
        ),
      );
    });
  };
  try {
    await render();
    const edit = container.querySelector<HTMLButtonElement>(
      '[data-testid="engine-edit-source-input-2"]',
    );
    assert.ok(edit, "latest completed user input should reuse the native edit action");
    await act(async () => edit.click());
    const editInput = container.querySelector<HTMLElement>(
      '[data-testid="engine-edit-input-source-input-2"]',
    ) as HTMLElement & { __zcodeLexicalInputE2E?: { setText: (text: string) => void } };
    assert.ok(editInput?.__zcodeLexicalInputE2E);
    const editAttachment = container.querySelector<HTMLElement>(
      '[data-testid="engine-edit-attachment-source-attachment"]',
    );
    assert.match(editAttachment?.textContent ?? "", /notes\.md/u);
    await act(async () => editAttachment?.querySelector<HTMLButtonElement>("button")?.click());
    assert.equal(
      container.querySelector('[data-testid="engine-edit-attachment-source-attachment"]'),
      null,
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="engine-edit-attachment-action-source-input-2"]',
        )
        ?.click(),
    );
    const editAttachmentMenuItem = await waitForElement(
      '[data-testid="engine-edit-attachment-menu-item-source-input-2"]',
    );
    const editAttachmentOption = editAttachmentMenuItem.closest<HTMLElement>('[role="option"]');
    assert.ok(editAttachmentOption);
    await act(async () =>
      editAttachmentOption.dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
      ),
    );
    assert.match(
      container.querySelector('[data-testid="engine-edit-added-attachment-0"]')?.textContent ?? "",
      /new\.txt/u,
    );
    await act(async () => editInput.__zcodeLexicalInputE2E!.setText("revised second question"));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="engine-edit-submit-source-input-2"]')
        ?.click();
    });
    assert.deepEqual(revisionRequests, [
      {
        taskId: sourceTask.id,
        participantId: sourceTask.participant.id,
        sessionId: sourceTask.session.id,
        authorizationId: sourceTask.authorizationId,
        sourceExecutionId: "source-execution-2",
        kind: "edit",
        text: "revised second question",
        retainedAttachmentIds: [],
        attachments: [
          { id: "new-attachment", fileName: "new.txt", mimeType: "text/plain", sizeBytes: 7 },
        ],
      },
    ]);
    assert.equal(stageRequests[0]?.localPath, "/tmp/new.txt");
    assert.equal(sourceHistory.inputs.length, 3);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const superseded = container.querySelector<HTMLDetailsElement>(
      '[data-testid="engine-superseded-turn-source-input-2"]',
    );
    assert.ok(superseded, "the superseded answer must be a distinct collapsed branch");
    assert.equal(superseded.open, false);
    assert.match(superseded.querySelector("summary")?.textContent ?? "", /此前版本/u);
    assert.match(
      container.querySelector('[data-testid="engine-turn-revised-input"]')?.textContent ?? "",
      /revised second question[\s\S]*revised answer/u,
    );
    const fork = container.querySelector<HTMLButtonElement>(
      '[data-testid="engine-final-source-execution-1"] [aria-label="分叉"]',
    );
    assert.ok(fork, "completed source answer should expose the native fork action");
    await act(async () => fork.click());
    assert.deepEqual(forkRequests, [
      {
        taskId: sourceTask.id,
        participantId: sourceTask.participant.id,
        sessionId: sourceTask.session.id,
        authorizationId: sourceTask.authorizationId,
        executionId: "source-execution-1",
      },
    ]);
    assert.equal(selected, childTask.id);
    await render();
    assert.ok(container.querySelector('[data-testid="engine-inherited-source-source-task"]'));
    assert.match(container.textContent ?? "", /question 1[\s\S]*answer 1/u);
    assert.doesNotMatch(container.textContent ?? "", /question 2|answer 2/u);
    assert.equal(
      container
        .querySelector('[data-testid="engine-input-source-input-1"]')
        ?.closest('[data-testid="engine-inherited-source-source-task"]')
        ?.getAttribute("data-testid"),
      "engine-inherited-source-source-task",
    );
    assert.equal(container.querySelector('[data-testid="engine-input-child-input"]'), null);
    assert.ok(container.querySelector('[data-testid="engine-composer-input"]'));
    sourceAvailable = false;
    refreshVersion += 1;
    await render();
    assert.match(container.textContent ?? "", /继承来源历史无法核实/u);
    assert.doesNotMatch(container.textContent ?? "", /original answer|answer 1/u);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.close();
  }
});
