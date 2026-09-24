import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeEngine, type FakeEngineStep } from "../../anyagent-engine/src/index.js";
import { createTaskRuntime } from "../../anyagent-runtime/src/index.js";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const environment = { id: "fake-ui-test", kind: "workspace" as const, workDirectory: "/tmp" };

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
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof win.matchMedia;
  win.HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof win.HTMLCanvasElement.prototype.getContext;
  for (const [key, value] of Object.entries({
    window: win,
    document: win.document,
    navigator: win.navigator,
    customElements: win.customElements,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    SVGElement: win.SVGElement,
    CSSStyleSheet: win.CSSStyleSheet,
    MutationObserver: win.MutationObserver,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  return dom;
}

async function waitFor(check: () => void) {
  let error: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      check();
      return;
    } catch (caught) {
      error = caught;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw error;
}

async function mount(script: readonly FakeEngineStep[]) {
  const dom = installDom();
  const directory = mkdtempSync(join(tmpdir(), "anyagent-ui-runtime-"));
  let clock = 10;
  const fake = new FakeEngine({ environment: environment.id, now: () => clock, script });
  const runtime = createTaskRuntime({
    databasePath: join(directory, "runtime.sqlite"),
    engines: new Map([["fake", fake]]),
    now: () => clock,
  });
  const task = await runtime.createTask({
    engineId: "fake",
    environment,
    authorization: {
      id: "ui-authorization",
      environmentId: environment.id,
      issuer: "host",
      expiresAt: null,
      scopes: [
        "session.create",
        "execution.run",
        "approval.respond",
        "execution.interrupt",
        "task.close",
      ],
    },
  });
  const service = {
    onDidChange: (listener: Parameters<typeof runtime.subscribe>[0]) => ({
      dispose: runtime.subscribe(listener),
    }),
    listEngines: () => runtime.refreshEngines(),
    listTasks: async () => runtime.listTasks(),
    getTask: async (id: string) => runtime.getTask(id),
    getHistory: async (id: string) => runtime.getHistory(id),
    submitInput: async (input: Parameters<typeof runtime.submitInput>[0]) => {
      await runtime.submitInput(input);
    },
    replyToApproval: async (input: Parameters<typeof runtime.replyToApproval>[0]) => {
      await runtime.replyToApproval(input);
    },
    replyToUserInput: async (input: Parameters<typeof runtime.replyToUserInput>[0]) => {
      await runtime.replyToUserInput(input);
    },
    requestStop: async (input: Parameters<typeof runtime.requestStop>[0]) => {
      await runtime.requestStop(input);
    },
  };
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let refreshVersion = 0;
  const app = (version = refreshVersion) =>
    createElement(
      TooltipProvider,
      null,
      createElement(
        ServiceProvider,
        {
          services: {
            settingService: { get: async () => ({}) },
            subagentsService: {
              list: async () => ({
                agents: [],
                userAgents: [],
                pluginAgents: [],
                capability: { userScopeAvailable: false },
              }),
            },
          } as never,
        },
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
                selectedTaskId: task.id,
                onSelectTask: () => {},
                refreshVersion: version,
              }),
            ),
          ),
        ),
      ),
    );
  await act(async () => root.render(app()));
  await waitFor(() =>
    assert.equal(
      container
        .querySelector('[data-testid="engine-composer-input"]')
        ?.getAttribute("data-e2e-lexical-bridge"),
      "ready",
    ),
  );
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    assert.ok(found, `missing button: ${label}`);
    return found;
  };
  return {
    container,
    fake,
    runtime,
    task,
    button,
    async refresh() {
      await act(async () => root.render(app(++refreshVersion)));
    },
    setClock(value: number) {
      clock = value;
    },
    async send(text: string) {
      const input = container.querySelector(
        '[data-testid="engine-composer-input"]',
      ) as HTMLElement & {
        __zcodeLexicalInputE2E: { setText(value: string): void };
      };
      await act(async () => input.__zcodeLexicalInputE2E.setText(text));
      await act(async () =>
        (
          container.querySelector('[data-testid="engine-composer-submit"]') as HTMLButtonElement
        ).click(),
      );
      await waitFor(() => assert.equal(runtime.getHistory(task.id)?.inputs.length, 1));
    },
    async advance(count: number) {
      for (let i = 0; i < count; i++) {
        await act(async () => {
          assert.equal(fake.advance("fake-execution-1" as never), true);
        });
      }
      await waitFor(() => assert.ok((runtime.getHistory(task.id)?.events.length ?? 0) >= count));
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
      runtime.close();
      dom.window.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("mounted conversation forwards a real FakeEngine rejection decision and keeps the execution active", async () => {
  const ui = await mount([
    { type: "input.accepted" },
    { type: "execution.started" },
    {
      type: "approval.requested",
      operation: "write file",
      options: [
        { id: "allow", label: "允许", decision: "approve" },
        { id: "deny", label: "拒绝", decision: "reject" },
      ],
    },
  ]);
  try {
    await ui.send("write a file");
    await ui.advance(3);
    await waitFor(() =>
      assert.ok(ui.container.textContent?.includes("审批 · write file · 等待答复")),
    );
    await act(async () => ui.button("拒绝").click());
    await waitFor(() =>
      assert.equal(ui.runtime.getHistory(ui.task.id)?.approvals[0]?.status, "forwarded"),
    );
    assert.equal(ui.runtime.getHistory(ui.task.id)?.approvals[0]?.repliedOptionId, "deny");
    assert.ok(
      ui.runtime
        .getHistory(ui.task.id)
        ?.events.some(
          (event) => event.type === "approval.response" && event.payload.decision === "reject",
        ),
    );
    assert.equal(ui.runtime.getHistory(ui.task.id)?.executions[0]?.status, "started");
    assert.match(ui.container.textContent ?? "", /审批 · write file · 已转交 Engine/);
  } finally {
    await ui.close();
  }
});

test("mounted conversation shows approval expiry without forwarding an answer", async () => {
  const ui = await mount([
    { type: "input.accepted" },
    { type: "execution.started" },
    {
      type: "approval.requested",
      operation: "expired write",
      expiresAt: 20,
      options: [{ id: "allow", label: "允许", decision: "approve" }],
    },
  ]);
  try {
    await ui.send("write later");
    await ui.advance(3);
    ui.setClock(20);
    await act(async () => ui.button("允许").click());
    await waitFor(() =>
      assert.equal(ui.runtime.getHistory(ui.task.id)?.approvals[0]?.status, "expired"),
    );
    assert.equal(ui.runtime.getHistory(ui.task.id)?.approvals[0]?.repliedOptionId, null);
    assert.equal(ui.runtime.getHistory(ui.task.id)?.executions[0]?.status, "started");
    assert.match(ui.container.textContent ?? "", /审批 · expired write · 已过期/);
  } finally {
    await ui.close();
  }
});

test("mounted conversation distinguishes interrupt request, confirmation, and disconnect unknown", async () => {
  const ui = await mount([{ type: "input.accepted" }, { type: "execution.started" }]);
  try {
    await ui.send("long work");
    await ui.advance(2);
    await waitFor(() => assert.equal((ui.button("请求中断") as HTMLButtonElement).disabled, false));
    await act(async () => ui.button("请求中断").click());
    await waitFor(() =>
      assert.equal(ui.runtime.getHistory(ui.task.id)?.stopRequests[0]?.status, "requested"),
    );
    assert.equal(ui.runtime.getHistory(ui.task.id)?.executions[0]?.status, "started");
    assert.match(ui.container.textContent ?? "", /等待停止确认/);
    await act(async () => assert.equal(ui.fake.confirmStopped("fake-execution-1" as never), true));
    await waitFor(() =>
      assert.equal(ui.runtime.getHistory(ui.task.id)?.executions[0]?.status, "stopped"),
    );
    assert.equal(ui.runtime.getHistory(ui.task.id)?.stopRequests[0]?.status, "confirmed");
    assert.equal(
      [...ui.container.querySelectorAll("button")].some(
        (button) => button.textContent === "请求中断",
      ),
      false,
    );
    await assert.rejects(
      () =>
        ui.runtime.requestStop({
          taskId: ui.task.id,
          participantId: ui.task.participant.id,
          sessionId: ui.task.session.id,
          authorizationId: ui.task.authorizationId,
          executionId: ui.runtime.getHistory(ui.task.id)!.executions[0]!.id,
        }),
      /already stopped/,
    );
  } finally {
    await ui.close();
  }

  const disconnected = await mount([{ type: "input.accepted" }, { type: "execution.started" }]);
  try {
    await disconnected.send("network work");
    await disconnected.advance(2);
    await act(async () => disconnected.fake.disconnect("fake-execution-1" as never));
    await waitFor(() =>
      assert.equal(
        disconnected.runtime.getHistory(disconnected.task.id)?.executions[0]?.status,
        "unknown",
      ),
    );
    assert.match(disconnected.container.textContent ?? "", /结果未知/);
    assert.equal(
      disconnected.runtime.getHistory(disconnected.task.id)?.executions[0]?.status,
      "unknown",
    );
  } finally {
    await disconnected.close();
  }
});

test("mounted conversation blocks changed capabilities and recovers after refresh", async () => {
  const ui = await mount([{ type: "input.accepted" }, { type: "execution.started" }]);
  try {
    const refresh = async () => {
      await ui.refresh();
    };
    for (const [status, message] of [
      [{ support: "supported", availability: "temporarily-unavailable" }, "此能力暂不可用"],
      [{ support: "supported", availability: "authorization-required" }, "当前授权不足"],
      [{ support: "unknown", availability: "unknown" }, "Engine 支持情况未知"],
      [{ support: "unsupported", availability: "unknown" }, "Engine 不支持此操作"],
    ] as const) {
      ui.fake.setCapability("execution.run", status);
      await refresh();
      await waitFor(() =>
        assert.equal(
          ui.runtime.getTask(ui.task.id)?.currentEngine.capabilities["execution.run"].support,
          status.support,
        ),
      );
      await waitFor(() => assert.match(ui.container.textContent ?? "", new RegExp(message)));
      assert.equal(
        (ui.container.querySelector('[data-testid="engine-composer-submit"]') as HTMLButtonElement)
          .disabled,
        true,
      );
    }
    assert.equal(
      ui.runtime.getTask(ui.task.id)?.engine.capabilities["execution.run"].availability,
      "available",
    );
    ui.fake.setCapability("execution.run", { support: "supported", availability: "available" });
    await refresh();
    await waitFor(() =>
      assert.equal(
        (ui.container.querySelector('[data-testid="engine-composer-submit"]') as HTMLButtonElement)
          .disabled,
        false,
      ),
    );
  } finally {
    await ui.close();
  }
});

test("mounted conversation refuses new business after Task reaches a terminal state", async () => {
  const ui = await mount([]);
  try {
    await act(async () => {
      ui.runtime.closeTask({
        taskId: ui.task.id,
        participantId: ui.task.participant.id,
        sessionId: ui.task.session.id,
        authorizationId: ui.task.authorizationId,
        outcome: "completed",
      });
    });
    await waitFor(() =>
      assert.equal(
        (ui.container.querySelector('[data-testid="engine-composer-submit"]') as HTMLButtonElement)
          .disabled,
        true,
      ),
    );
    assert.match(ui.container.textContent ?? "", /不接收新的业务请求/);
    await assert.rejects(
      () =>
        ui.runtime.submitInput({
          taskId: ui.task.id,
          participantId: ui.task.participant.id,
          sessionId: ui.task.session.id,
          authorizationId: ui.task.authorizationId,
          text: "late business",
        }),
      /is completed/,
    );
    assert.equal(ui.runtime.getHistory(ui.task.id)?.inputs.length, 0);
  } finally {
    await ui.close();
  }
});
