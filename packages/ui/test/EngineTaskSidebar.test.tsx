import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    FocusEvent: dom.window.FocusEvent,
    SVGElement: dom.window.SVGElement,
    DOMRect: dom.window.DOMRect,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      configurable: true,
      value(this: HTMLElement, eventName: string, listener: EventListener) {
        this.addEventListener(eventName.replace(/^on/, ""), listener);
      },
    },
    detachEvent: {
      configurable: true,
      value(this: HTMLElement, eventName: string, listener: EventListener) {
        this.removeEventListener(eventName.replace(/^on/, ""), listener);
      },
    },
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  return dom;
}

function runtimeTask(
  id: string,
  sidebarMetadata = {
    title: null as string | null,
    pinned: false,
    pinOrder: null as number | null,
    archivedAt: null as number | null,
    unreadAt: null as number | null,
  },
  createdAt = 1,
  updatedAt = createdAt,
) {
  return {
    id,
    authorizationId: "engine-grant",
    status: "completed",
    createdAt,
    updatedAt,
    closedAt: null,
    closeReason: null,
    engine: { engineId: "fake" },
    sidebarMetadata,
    participant: { id: `${id}-participant` },
    session: { id: `${id}-session`, nativeSessionId: null },
  };
}

async function openEngineTaskMenu(dom: JSDOM, taskId: string) {
  await act(async () => {
    const button = document.querySelector<HTMLElement>(
      `[data-testid='engine-task-options-${taskId}']`,
    );
    assert.ok(button);
    const event = new dom.window.MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    button.dispatchEvent(event);
  });
  const menu = document.querySelector<HTMLElement>("[data-slot='dropdown-menu-content']");
  assert.ok(menu, "Engine row opens its action menu");
  return [...menu.querySelectorAll<HTMLElement>("[data-slot='dropdown-menu-item']")];
}

test("timeline interleaves native and Engine sessions in one ordered list", async () => {
  const dom = installDom();
  const [{ WorkspaceTimelineTasksSection }, { ServiceProvider }, { ZCodeIntlProvider }] =
    await Promise.all([
      import("../src/WorkspaceTimelineTasksSection.js"),
      import("../src/hooks/useServices.js"),
      import("../src/i18n/IntlProvider.js"),
    ]);
  const now = Date.now();
  const nativeTask = (id: string, updatedAt: number) => ({
    taskId: id,
    title: id,
    workspacePath: "/tmp/m1-sidebar",
    status: "completed",
    provider: "zcode",
    createdAt: updatedAt,
    updatedAt,
  });
  const nativeTasks = [
    nativeTask("native-new", now),
    nativeTask("native-duplicate", now - 20),
    nativeTask("native-old", now - 40),
  ];
  const controller = {
    onDynamicControllerFrame: () => () => ({ dispose() {} }),
    subscribeControllerV4: async () => ({ ack: { subscriptionId: "test" } }),
    unsubscribeControllerV4: async () => {},
    listTaskList: async () => ({ items: nativeTasks, total: nativeTasks.length, hasMore: false }),
  };
  const engineTasks = [
    {
      id: "engine-middle",
      status: "active",
      createdAt: now - 10,
      updatedAt: now - 10,
      engine: { engineId: "fake" },
      session: { nativeSessionId: null },
    },
    {
      id: "engine-duplicate",
      status: "active",
      createdAt: now - 20,
      updatedAt: now - 20,
      engine: { engineId: "zcode" },
      session: { nativeSessionId: "native-duplicate" },
    },
    {
      id: "engine-pinned",
      status: "completed",
      createdAt: now - 30,
      updatedAt: now - 30,
      engine: { engineId: "fake" },
      session: { nativeSessionId: null },
      sidebarMetadata: {
        title: null,
        pinned: true,
        pinOrder: 1,
        archivedAt: null,
        unreadAt: null,
      },
    },
    {
      id: "engine-archived",
      status: "completed",
      createdAt: now - 40,
      updatedAt: now - 40,
      engine: { engineId: "fake" },
      session: { nativeSessionId: null },
      sidebarMetadata: {
        title: null,
        pinned: false,
        pinOrder: null,
        archivedAt: 5,
        unreadAt: null,
      },
    },
  ];
  const engineService = {
    listTasks: async () => engineTasks,
    setTaskPinned: async () => engineTasks[0],
    renameTask: async () => engineTasks[0],
    setTaskArchived: async () => engineTasks[0],
    setTaskUnread: async () => engineTasks[0],
    getHistory: async (id: string) => ({
      inputs: [{ text: id, receivedAt: 1 }],
      executions: [],
    }),
    onDidChange: () => ({ dispose() {} }),
  };
  const nativeSelected: string[] = [];
  const engineSelected: string[] = [];
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => copied.push(value) },
  });
  let hiddenNativeIds: ReadonlySet<string> = new Set();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: { windowControllerService: controller } as never },
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(WorkspaceTimelineTasksSection, {
              workspaceTabs: [
                {
                  kind: "workspace",
                  id: "workspace-1",
                  label: "M1",
                  workspacePath: "/tmp/m1-sidebar",
                } as never,
              ],
              activeWorkspacePath: "/tmp/m1-sidebar",
              activeTaskId: null,
              taskSortBy: "updated",
              groupByDate: false,
              onSelectTask: (_workspacePath: string, id: string) => nativeSelected.push(id),
              engineService: engineService as never,
              onSelectEngineTask: (id: string) => engineSelected.push(id),
              onNativeSessionIdsChange: (ids: ReadonlySet<string>) => (hiddenNativeIds = ids),
            }),
          ),
        ),
      );
      await Promise.resolve();
    });
    const rows = [...container.querySelectorAll<HTMLLIElement>("[data-task-item-key]")];
    assert.deepEqual(
      rows.map((row) => row.dataset.taskItemKey),
      [
        "/tmp/m1-sidebar:native-new",
        "engine-middle",
        "engine-duplicate",
        "/tmp/m1-sidebar:native-old",
      ],
    );
    assert.equal(
      rows.some((row) => /engine-pinned|engine-archived/.test(row.dataset.taskItemKey ?? "")),
      false,
    );
    assert.deepEqual([...hiddenNativeIds], ["native-duplicate"]);
    await act(async () => rows[1]?.click());
    await act(async () => rows[0]?.click());
    assert.deepEqual(engineSelected, ["engine-middle"]);
    assert.deepEqual(nativeSelected, ["native-new"]);
    await act(async () => {
      rows[1]?.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    const menu = document.querySelector("[data-slot='context-menu-content']");
    assert.match(menu?.textContent ?? "", /复制 Task ID/);
    await act(async () => {
      menu?.querySelector<HTMLElement>("[data-slot='context-menu-item']:last-child")?.click();
    });
    assert.deepEqual(copied, ["engine-middle"]);
    await act(async () => {
      const button = container.querySelector<HTMLElement>(
        "[data-testid='engine-task-options-engine-duplicate']",
      );
      assert.ok(button);
      const event = new dom.window.MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      button.dispatchEvent(event);
    });
    const dropdown = document.querySelector("[data-slot='dropdown-menu-content']");
    assert.ok(dropdown, "Engine row exposes the native action menu");
    assert.equal(dropdown.querySelectorAll("[data-disabled]").length, 0);
    await act(async () => {
      dropdown.querySelector<HTMLElement>("[data-slot='dropdown-menu-item']:last-child")?.click();
    });
    assert.deepEqual(copied, ["engine-middle", "engine-duplicate"]);
    assert.deepEqual(engineSelected, ["engine-middle"], "menu actions keep the current task");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("Engine Task menu actions use the persisted product Task identity and clear only the unread version opened", async () => {
  const dom = installDom();
  const [{ EngineTaskRow }, { ZCodeIntlProvider }] = await Promise.all([
    import("../src/EngineTaskSidebar.js"),
    import("../src/i18n/IntlProvider.js"),
  ]);
  const task = runtimeTask("fake-task", {
    title: null,
    pinned: false,
    pinOrder: null,
    archivedAt: null,
    unreadAt: 41,
  });
  const requests: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const service = {
    setTaskPinned: async (input: Record<string, unknown>) => {
      requests.push({ operation: "pin", input });
      return task;
    },
    renameTask: async (input: Record<string, unknown>) => {
      requests.push({ operation: "rename", input });
      return task;
    },
    setTaskArchived: async (input: Record<string, unknown>) => {
      requests.push({ operation: "archive", input });
      return task;
    },
    setTaskUnread: async (input: Record<string, unknown>) => {
      requests.push({ operation: "unread", input });
      return task;
    },
  };
  const selected: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(EngineTaskRow, {
            task: task as never,
            title: "History title",
            active: false,
            service: service as never,
            onSelectTask: (id: string) => selected.push(id),
          }),
        ),
      );
    });

    const pinItems = await openEngineTaskMenu(dom, task.id);
    assert.equal(pinItems.length, 5);
    assert.equal(
      pinItems.slice(0, 4).filter((item) => item.hasAttribute("data-disabled")).length,
      0,
    );
    await act(async () => pinItems[0]?.click());

    const renameItems = await openEngineTaskMenu(dom, task.id);
    await act(async () => renameItems[1]?.click());
    const input = document.querySelector<HTMLInputElement>("[role='dialog'] input");
    assert.ok(input);
    assert.equal(input.value, "History title");
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, "Renamed Fake Task");
      const valueChange = new dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(valueChange, "propertyName", { value: "value" });
      input.dispatchEvent(valueChange);
    });
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")]
        .find((button) => button.textContent?.includes("确认"))
        ?.click();
    });

    const archiveItems = await openEngineTaskMenu(dom, task.id);
    await act(async () => archiveItems[2]?.click());
    const unreadItems = await openEngineTaskMenu(dom, task.id);
    await act(async () => unreadItems[3]?.click());
    await act(async () => {
      container.querySelector<HTMLElement>("[data-task-item-key='fake-task']")?.click();
    });

    assert.deepEqual(
      requests.map(({ operation }) => operation),
      ["pin", "rename", "archive", "unread", "unread"],
    );
    const identity = {
      taskId: "fake-task",
      participantId: "fake-task-participant",
      sessionId: "fake-task-session",
    };
    assert.deepEqual(requests[0]?.input, { ...identity, pinned: true });
    assert.deepEqual(requests[1]?.input, { ...identity, title: "Renamed Fake Task" });
    assert.deepEqual(requests[2]?.input, { ...identity, archived: true });
    assert.deepEqual(requests[3]?.input, { ...identity, unread: true });
    assert.deepEqual(requests[4]?.input, {
      ...identity,
      unread: false,
      expectedUnreadAt: 41,
    });
    assert.deepEqual(selected, ["fake-task"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("project TaskList renders native and Harness sessions in the same list", async () => {
  const dom = installDom();
  const [{ TaskList }, { ZCodeIntlProvider }, { TabStoreProvider }] = await Promise.all([
    import("../src/TaskList.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/store/TabStoreProvider.js"),
  ]);
  const now = Date.now();
  const selected: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const nativeTask = (id: string, updatedAt: number) => ({
    taskId: id,
    title: id,
    workspacePath: "/tmp/m1-project",
    status: "completed",
    provider: "zcode",
    createdAt: updatedAt,
    updatedAt,
  });
  try {
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(
            TabStoreProvider,
            null,
            createElement(TaskList, {
              workspacePath: "/tmp/m1-project",
              tasks: [nativeTask("native-old", now - 20), nativeTask("native-new", now)] as never,
              engineTasks: [
                {
                  id: "harness-project",
                  createdAt: now - 10,
                  updatedAt: now - 10,
                  status: "active",
                },
              ] as never,
              engineTitles: { "harness-project": "Harness project turn" },
              activeTaskId: null,
              engineSelectedTaskId: "harness-project",
              onSelectTask: (id: string) => selected.push(id),
              onSelectEngineTask: (id: string) => selected.push(id),
              onRenameTask: async () => null,
              onSetTaskPinned: async () => null,
              onArchiveTask: async () => null,
              onSetTaskUnread: async () => null,
              showCreateButton: false,
              showFooter: false,
            }),
          ),
        ),
      );
    });
    const rows = [...container.querySelectorAll<HTMLElement>("ul > [data-task-item-key]")];
    assert.deepEqual(
      rows.map((row) =>
        row.textContent?.includes("Harness project turn")
          ? "harness"
          : row.textContent?.includes("native-new")
            ? "native-new"
            : "native-old",
      ),
      ["native-old", "native-new", "harness"],
    );
    assert.equal(container.querySelectorAll("ul").length, 1);
    assert.equal(rows[2]?.getAttribute("aria-current"), "page");
    await act(async () => rows[2]?.click());
    assert.deepEqual(selected, ["harness-project"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("project TaskList sorts active Engine Tasks and keeps pinned or archived Tasks in their own views", async () => {
  const dom = installDom();
  const [{ TaskList }, { ZCodeIntlProvider }, { TabStoreProvider }] = await Promise.all([
    import("../src/TaskList.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/store/TabStoreProvider.js"),
  ]);
  const engineTasks = [
    runtimeTask(
      "engine-updated-first",
      { title: "Persisted title", pinned: false, pinOrder: null, archivedAt: null, unreadAt: null },
      10,
      30,
    ),
    runtimeTask(
      "engine-created-first",
      { title: null, pinned: false, pinOrder: null, archivedAt: null, unreadAt: null },
      20,
      20,
    ),
    runtimeTask(
      "engine-pinned",
      { title: null, pinned: true, pinOrder: 1, archivedAt: null, unreadAt: null },
      30,
      100,
    ),
    runtimeTask(
      "engine-archived",
      { title: null, pinned: false, pinOrder: null, archivedAt: 5, unreadAt: null },
      40,
      120,
    ),
  ];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (sortBy: "created" | "updated") =>
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TabStoreProvider,
        null,
        createElement(TaskList, {
          workspacePath: "/tmp/m1-sidebar",
          tasks: [],
          engineTasks: engineTasks as never,
          activeTaskId: null,
          sortBy,
          onSelectTask: () => {},
          onRenameTask: async () => null,
          onSetTaskPinned: async () => null,
          onArchiveTask: async () => null,
          onSetTaskUnread: async () => null,
          showCreateButton: false,
          showFooter: false,
        }),
      ),
    );
  const rowIds = () =>
    [...container.querySelectorAll<HTMLElement>("ul [data-task-item-key]")].map((row) =>
      row.getAttribute("data-task-item-key"),
    );
  try {
    await act(async () => root.render(render("updated")));
    assert.deepEqual(rowIds(), ["engine-updated-first", "engine-created-first"]);
    assert.match(container.textContent ?? "", /Persisted title/);
    assert.doesNotMatch(container.textContent ?? "", /engine-pinned|engine-archived/);

    await act(async () => root.render(render("created")));
    assert.deepEqual(rowIds(), ["engine-created-first", "engine-updated-first"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("pinned section renders and lets an Engine Task be unpinned when native pinned Tasks are empty", async () => {
  const dom = installDom();
  const [
    { WorkspacePinnedTasksSection },
    { ServiceProvider },
    { ZCodeIntlProvider },
    { TooltipProvider },
  ] = await Promise.all([
    import("../src/WorkspacePinnedTasksSection.js"),
    import("../src/hooks/useServices.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/components/ui/tooltip.js"),
  ]);
  const task = runtimeTask("fake-pinned", {
    title: "Pinned Fake Task",
    pinned: true,
    pinOrder: 1,
    archivedAt: null,
    unreadAt: null,
  });
  const pinChanges: Array<Record<string, unknown>> = [];
  const service = {
    setTaskPinned: async (input: Record<string, unknown>) => {
      pinChanges.push(input);
      return task;
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: { anyAgentService: service } as never },
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(
              TooltipProvider,
              null,
              createElement(WorkspacePinnedTasksSection, {
                workspaceTabs: [],
                activeWorkspacePath: "/tmp/m1-pinned",
                activeTaskId: null,
                taskSortBy: "updated",
                engineTasks: [task as never],
                engineSelectedTaskId: task.id,
                onSelectEngineTask: () => {},
                onSelectTask: () => {},
              }),
            ),
          ),
        ),
      );
      await Promise.resolve();
    });

    const row = container.querySelector<HTMLElement>("[data-task-item-key='fake-pinned']");
    assert.ok(row, "Engine pin keeps the pinned section visible without native pinned rows");
    assert.match(container.textContent ?? "", /Pinned Fake Task/);

    const menuItems = await openEngineTaskMenu(dom, task.id);
    assert.match(menuItems[0]?.textContent ?? "", /取消置顶/);
    await act(async () => {
      menuItems[0]?.click();
      await Promise.resolve();
    });
    assert.deepEqual(pinChanges, [
      {
        taskId: task.id,
        participantId: `${task.id}-participant`,
        sessionId: `${task.id}-session`,
        pinned: false,
      },
    ]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("archived view renders archived Engine Tasks and exposes the matching restore action", async () => {
  const dom = installDom();
  const [
    { WorkspaceArchivedTasksFlatSection },
    { ServiceProvider },
    { ZCodeIntlProvider },
    { TooltipProvider },
  ] = await Promise.all([
    import("../src/WorkspaceArchivedTasksFlatSection.js"),
    import("../src/hooks/useServices.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/components/ui/tooltip.js"),
  ]);
  const task = runtimeTask(
    "fake-archived",
    { title: "Archived Fake Task", pinned: false, pinOrder: null, archivedAt: 5, unreadAt: null },
    1,
    10,
  );
  const archiveChanges: Array<Record<string, unknown>> = [];
  const service = {
    setTaskArchived: async (input: Record<string, unknown>) => {
      archiveChanges.push(input);
      return task;
    },
  };
  const controller = {
    onDynamicControllerFrame: () => () => ({ dispose() {} }),
    subscribeControllerV4: async () => ({ ack: { subscriptionId: "archived-test" } }),
    unsubscribeControllerV4: async () => {},
    listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: { windowControllerService: controller, anyAgentService: service } as never },
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(
              TooltipProvider,
              null,
              createElement(WorkspaceArchivedTasksFlatSection, {
                workspaceTabs: [
                  {
                    kind: "workspace",
                    id: "workspace-1",
                    label: "M1",
                    workspacePath: "/tmp/m1-archive",
                  } as never,
                ],
                activeWorkspacePath: "/tmp/m1-archive",
                activeTaskId: null,
                engineSelectedTaskId: task.id,
                sortBy: "updated",
                onSelectTask: () => {},
                engineTasks: [task as never],
                engineTitles: {},
                onSelectEngineTask: () => {},
              }),
            ),
          ),
        ),
      );
      await Promise.resolve();
    });
    assert.ok(container.querySelector("[data-task-item-key='fake-archived']"));
    assert.match(container.textContent ?? "", /Archived Fake Task/);

    const items = await openEngineTaskMenu(dom, task.id);
    assert.match(items[2]?.textContent ?? "", /取消归档/);
    await act(async () => items[2]?.click());
    await act(async () => Promise.resolve());
    assert.deepEqual(archiveChanges, [
      {
        taskId: task.id,
        participantId: `${task.id}-participant`,
        sessionId: `${task.id}-session`,
        archived: false,
      },
    ]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("project TaskList applies created and updated sorting with running tasks first", async () => {
  const dom = installDom();
  const [{ TaskList }, { ZCodeIntlProvider }, { TabStoreProvider }, { attachTaskListRowActivity }] =
    await Promise.all([
      import("../src/TaskList.js"),
      import("../src/i18n/IntlProvider.js"),
      import("../src/store/TabStoreProvider.js"),
      import("../src/v4/taskListRowActivity.js"),
    ]);
  const nativeTask = (id: string, createdAt: number, updatedAt: number) => ({
    taskId: id,
    title: id,
    workspacePath: "/tmp/m1-project",
    status: "completed",
    provider: "zcode",
    createdAt,
    updatedAt,
  });
  const nativeTasks = [
    nativeTask("native-idle", 400, 200),
    attachTaskListRowActivity(nativeTask("native-running", 100, 900) as never, {
      phase: "running",
      lastActivityAt: 900,
      hasBackgroundWork: false,
    }),
  ];
  const engineTasks = [
    {
      id: "engine-running-completed",
      status: "completed",
      createdAt: 200,
      updatedAt: 100,
    },
    {
      id: "engine-idle-active",
      status: "active",
      createdAt: 300,
      updatedAt: 500,
    },
  ];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (sortBy: "created" | "updated") =>
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TabStoreProvider,
        null,
        createElement(TaskList, {
          workspacePath: "/tmp/m1-project",
          tasks: nativeTasks as never,
          engineTasks: engineTasks as never,
          engineRunningByTask: {
            "engine-running-completed": true,
            "engine-idle-active": false,
          },
          activeTaskId: null,
          sortBy,
          onSelectTask: () => {},
          onRenameTask: async () => null,
          onSetTaskPinned: async () => null,
          onArchiveTask: async () => null,
          onSetTaskUnread: async () => null,
          showCreateButton: false,
          showFooter: false,
        }),
      ),
    );
  const rowIds = () =>
    [...container.querySelectorAll<HTMLElement>("ul [data-task-item-key]")].map((row) =>
      row.getAttribute("data-task-item-key"),
    );
  try {
    await act(async () => root.render(render("created")));
    assert.deepEqual(rowIds(), [
      "engine-running-completed",
      "/tmp/m1-project:native-running",
      "/tmp/m1-project:native-idle",
      "engine-idle-active",
    ]);
    assert.equal(container.querySelectorAll("ul").length, 1);
    assert.equal(container.querySelector("ul")?.className, "space-y-0.5");

    await act(async () => root.render(render("updated")));
    assert.deepEqual(rowIds(), [
      "engine-running-completed",
      "/tmp/m1-project:native-running",
      "engine-idle-active",
      "/tmp/m1-project:native-idle",
    ]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("grouped view mounts Engine rows among ungrouped native rows", async () => {
  const dom = installDom();
  const [
    { WorkspaceGroupedTasksSection },
    { ServiceProvider },
    { PlatformProvider },
    { ZCodeIntlProvider },
    { TabStoreProvider },
  ] = await Promise.all([
    import("../src/WorkspaceGroupedTasksSection.js"),
    import("../src/hooks/useServices.js"),
    import("../src/hooks/usePlatform.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/store/TabStoreProvider.js"),
  ]);
  const now = Date.now();
  const nativeTask = (id: string, updatedAt: number) => ({
    taskId: id,
    title: id,
    workspacePath: "/tmp/m1-grouped",
    status: "completed",
    provider: "zcode",
    createdAt: updatedAt,
    updatedAt,
  });
  const nativeTasks = [
    nativeTask("native-new", now),
    nativeTask("native-duplicate", now - 20),
    nativeTask("native-old", now - 40),
  ];
  const controller = {
    onDynamicControllerFrame: () => () => ({ dispose() {} }),
    subscribeControllerV4: async () => ({ ack: { subscriptionId: "grouped-test" } }),
    unsubscribeControllerV4: async () => {},
    listTaskList: async () => ({ items: nativeTasks, total: nativeTasks.length, hasMore: false }),
  };
  const zcodeTaskService = {
    listGroupedTaskViewStructure: async () => ({ groups: [], members: [], topLevelOrders: [] }),
    listPinnedTaskIds: async () => [],
    listArchivedTasks: async () => [],
    listTasks: async () => nativeTasks,
    listPinnedTasks: async () => [],
    listDeletedTaskIds: async () => [],
    onDynamicWorkspaceEvent: () => () => ({ dispose() {} }),
  };
  let engineMiddle = {
    ...runtimeTask(
      "engine-middle",
      { title: null, pinned: false, pinOrder: null, archivedAt: null, unreadAt: null },
      now - 10,
      now - 10,
    ),
    status: "active",
  };
  const engineTasks = [
    engineMiddle,
    {
      id: "engine-duplicate",
      status: "active",
      createdAt: now - 20,
      updatedAt: now - 20,
      engine: { engineId: "zcode" },
      session: { nativeSessionId: "native-duplicate" },
    },
    runtimeTask(
      "grouped-pinned",
      { title: null, pinned: true, pinOrder: 1, archivedAt: null, unreadAt: null },
      now - 30,
      now - 30,
    ),
    runtimeTask(
      "grouped-archived",
      { title: null, pinned: false, pinOrder: null, archivedAt: 5, unreadAt: null },
      now - 40,
      now - 40,
    ),
  ];
  const unreadRequests: Array<Record<string, unknown>> = [];
  const buildEngineHistory = (id: string) => ({
    inputs: [{ text: id, receivedAt: 1 }],
    executions: [],
  });
  type EngineTaskChange = {
    taskId: string;
    task: typeof engineMiddle;
    history: ReturnType<typeof buildEngineHistory>;
  };
  const engineTaskListeners = new Set<(change: EngineTaskChange) => void>();
  const engineService = {
    listTasks: async () => [engineMiddle, ...engineTasks.slice(1)],
    setTaskUnread: async (input: Record<string, unknown>) => {
      unreadRequests.push(input);
      engineMiddle = {
        ...engineMiddle,
        sidebarMetadata: {
          ...engineMiddle.sidebarMetadata,
          unreadAt: input.unread === true ? 41 : null,
        },
      };
      const change = {
        taskId: engineMiddle.id,
        task: engineMiddle,
        history: buildEngineHistory(engineMiddle.id),
      };
      engineTaskListeners.forEach((listener) => listener(change));
      return engineMiddle;
    },
    getHistory: async (id: string) => buildEngineHistory(id),
    onDidChange: (listener: (change: EngineTaskChange) => void) => {
      engineTaskListeners.add(listener);
      return { dispose: () => engineTaskListeners.delete(listener) };
    },
  };
  const engineSelected: string[] = [];
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => copied.push(value) },
  });
  let hiddenNativeIds: ReadonlySet<string> = new Set();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(
          PlatformProvider,
          { platform: {} as never },
          createElement(
            ServiceProvider,
            { services: { windowControllerService: controller, zcodeTaskService } as never },
            createElement(
              ZCodeIntlProvider,
              { initialLocale: "zh-CN" },
              createElement(
                TabStoreProvider,
                null,
                createElement(WorkspaceGroupedTasksSection, {
                  workspaceTabs: [
                    {
                      kind: "workspace",
                      id: "workspace-grouped",
                      label: "M1",
                      workspacePath: "/tmp/m1-grouped",
                    } as never,
                  ],
                  activeWorkspacePath: "/tmp/m1-grouped",
                  activeTaskId: null,
                  onSelectTask: () => {},
                  onCreateTask: () => {},
                  collapsedGroupIds: new Set(),
                  onCollapsedGroupIdsChange: () => {},
                  engineService: engineService as never,
                  onSelectEngineTask: (id: string) => engineSelected.push(id),
                  onNativeSessionIdsChange: (ids: ReadonlySet<string>) => (hiddenNativeIds = ids),
                }),
              ),
            ),
          ),
        ),
      );
      await Promise.resolve();
    });
    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-grouped-task-key], [data-task-item-key]"),
    ];
    assert.equal(rows.length, 4, "Engine and native rows share the grouped top-level list");
    assert.ok(rows.every((row) => row.classList.contains("group/task-row")));
    const unreadRow = container.querySelector<HTMLElement>("[data-task-item-key='engine-middle']");
    assert.equal(unreadRow?.querySelector("[aria-hidden='true'].bg-primary"), null);
    assert.equal(container.querySelector("[data-engine-task-rows]"), null);
    assert.deepEqual([...hiddenNativeIds], ["native-duplicate"]);
    assert.deepEqual(
      rows.map(
        (row) =>
          row.getAttribute("data-task-item-key") ??
          decodeURIComponent(row.getAttribute("data-grouped-task-key") ?? "")
            .split("\0")
            .at(-1),
      ),
      ["native-new", "engine-middle", "engine-duplicate", "native-old"],
    );

    await act(async () => {
      unreadRow?.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    const menu = document.querySelector("[data-slot='context-menu-content']");
    assert.match(menu?.textContent ?? "", /复制 Task ID/);
    const markUnreadItem = [
      ...(menu?.querySelectorAll<HTMLElement>("[data-slot='context-menu-item']") ?? []),
    ].find((item) => item.textContent?.includes("标记为未读"));
    assert.ok(markUnreadItem, "grouped Engine Task exposes the mark unread action");
    await act(async () => {
      markUnreadItem.click();
      await Promise.resolve();
    });

    assert.deepEqual(unreadRequests, [
      {
        taskId: "engine-middle",
        participantId: "engine-middle-participant",
        sessionId: "engine-middle-session",
        unread: true,
      },
    ]);
    const markedUnreadRow = container.querySelector<HTMLElement>(
      "[data-task-item-key='engine-middle']",
    );
    assert.ok(markedUnreadRow?.querySelector("[aria-hidden='true'].bg-primary"));

    await act(async () => {
      markedUnreadRow?.click();
      await Promise.resolve();
    });
    assert.deepEqual(engineSelected, ["engine-middle"]);
    assert.deepEqual(unreadRequests[1], {
      taskId: "engine-middle",
      participantId: "engine-middle-participant",
      sessionId: "engine-middle-session",
      unread: false,
      expectedUnreadAt: 41,
    });
    assert.equal(
      container
        .querySelector<HTMLElement>("[data-task-item-key='engine-middle']")
        ?.querySelector("[aria-hidden='true'].bg-primary"),
      null,
    );

    const selectedRow = container.querySelector<HTMLElement>(
      "[data-task-item-key='engine-middle']",
    );
    await act(async () => {
      selectedRow?.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    const copyMenu = document.querySelector("[data-slot='context-menu-content']");
    assert.match(copyMenu?.textContent ?? "", /复制 Task ID/);
    await act(async () => {
      copyMenu?.querySelector<HTMLElement>("[data-slot='context-menu-item']:last-child")?.click();
    });
    assert.deepEqual(copied, ["engine-middle"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
