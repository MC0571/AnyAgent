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
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  return dom;
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
  ];
  const engineService = {
    listTasks: async () => engineTasks,
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
    assert.equal(dropdown.querySelectorAll("[data-disabled]").length, 4);
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
  ];
  const engineService = {
    listTasks: async () => engineTasks,
    getHistory: async (id: string) => ({
      inputs: [{ text: id, receivedAt: 1 }],
      executions: [],
    }),
    onDidChange: () => ({ dispose() {} }),
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
    await act(async () => rows[1]?.click());
    assert.deepEqual(engineSelected, ["engine-middle"]);
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
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
