import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

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
  for (const [key, value] of Object.entries({
    window: win,
    document: win.document,
    navigator: win.navigator,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    PointerEvent: win.PointerEvent,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    SVGElement: win.SVGElement,
    MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
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

test("the native composer model menu selects Harness and keeps Provider selection distinct", async () => {
  const dom = installDom();
  const [{ ModelConfigSelect }, { ZCodeIntlProvider }, modelGroups, customModel] =
    await Promise.all([
      import("../src/ModelConfigSelect.js"),
      import("../src/i18n/IntlProvider.js"),
      import("../src/lib/modelSelectionGroups.js"),
      import("../src/lib/zcodeCustomModelValue.js"),
    ]);
  const providerValue = customModel.encodeCustomModelValue("provider-id", "provider-model");
  const harnesses = [
    { engineId: "local:cli", label: "Local CLI", selectable: true },
    { engineId: "remote:cli", label: "Unavailable CLI", selectable: false, reason: "未授权" },
  ] as const;
  const groups = [
    ...modelGroups.buildHarnessModelSelectGroups(harnesses),
    {
      key: "registry-provider:provider-id",
      label: "Example Provider",
      directItems: true,
      items: [{ key: "provider-model", value: providerValue, name: "provider-model" }],
    },
  ];
  const selected: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  function Picker({
    sessionId,
    openRequestKey,
  }: {
    sessionId: string | null;
    openRequestKey: number;
  }) {
    const dispatch = (value: string) =>
      modelGroups.dispatchComposerModelSelectValue({
        value,
        harnesses,
        sessionId,
        onSelectHarness: (engineId) => selected.push(`harness:${engineId ?? "none"}`),
        onSelectProvider: (provider) => selected.push(`provider:${provider}`),
      });
    return createElement(ModelConfigSelect, {
      modelGroups: [...groups],
      normalizedValue: "",
      triggerLabel: "Choose a model",
      showManageModelsAction: false,
      lockReasonMessage: "This option cannot be changed in the current session.",
      isItemLocked: (value: string) => {
        if (!modelGroups.isHarnessModelSelectValue(value)) return false;
        const engineId = modelGroups.decodeHarnessModelSelectValue(value);
        return (
          sessionId !== null || !harnesses.find((item) => item.engineId === engineId)?.selectable
        );
      },
      onValueChange: dispatch,
      openRequestKey,
      disabled: false,
    });
  }

  try {
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(Picker, { sessionId: null, openRequestKey: 0 }),
        ),
      );
    });
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(Picker, { sessionId: null, openRequestKey: 1 }),
        ),
      );
    });

    assert.ok(document.body.textContent?.includes("Harness"));
    assert.ok(document.body.textContent?.includes("Local CLI"));
    assert.ok(document.body.textContent?.includes("Example Provider"));
    const selectableHarness = [
      ...document.body.querySelectorAll<HTMLElement>('[data-testid^="chat-model-select-item-"]'),
    ].find((item) => item.textContent?.includes("Local CLI"));
    assert.ok(selectableHarness, "selectable Harness should be present in the menu");
    await act(async () => {
      selectableHarness.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(selected, ["harness:local:cli"]);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(Picker, { sessionId: null, openRequestKey: 2 }),
        ),
      );
    });
    const unavailableHarness = document.body.querySelector<HTMLElement>(
      '[data-model-option-locked="true"]',
    );
    assert.ok(unavailableHarness, "unavailable Harness should use the native locked menu row");
    assert.ok(unavailableHarness.textContent?.includes("未授权"));
    await act(async () => unavailableHarness.click());
    assert.deepEqual(selected, ["harness:local:cli"]);

    const providerItem = [
      ...document.body.querySelectorAll<HTMLElement>('[data-testid^="chat-model-select-item-"]'),
    ].find((item) => item.textContent?.includes("provider-model"));
    assert.ok(providerItem, "Provider model should remain selectable");
    await act(async () => providerItem.click());
    assert.deepEqual(selected, ["harness:local:cli", "harness:none", `provider:${providerValue}`]);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(Picker, { sessionId: "native-session", openRequestKey: 3 }),
        ),
      );
    });
    const sessionLockedHarness = document.body.querySelector<HTMLElement>(
      '[data-model-option-locked="true"]',
    );
    assert.ok(sessionLockedHarness, "Harness options should be locked for native Sessions");
    assert.ok(sessionLockedHarness.textContent?.includes("Local CLI"));
    assert.equal(
      sessionLockedHarness.getAttribute("aria-description"),
      "This option cannot be changed in the current session.",
    );
    assert.equal(
      sessionLockedHarness.getAttribute("title"),
      "This option cannot be changed in the current session.",
    );
    await act(async () => {
      sessionLockedHarness.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
      document.querySelector("#zcode-toast-host")?.textContent ?? "",
      /This option cannot be changed in the current session/u,
    );
    await act(async () => {
      sessionLockedHarness.focus();
      sessionLockedHarness.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.deepEqual(selected, ["harness:local:cli", "harness:none", `provider:${providerValue}`]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("Harness grouping keeps the native draft picker usable without Provider state", async () => {
  const dom = installDom();
  const [{ ModelConfigSelect }, { ZCodeIntlProvider }, modelGroups] = await Promise.all([
    import("../src/ModelConfigSelect.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/lib/modelSelectionGroups.js"),
  ]);
  const harnesses = [{ engineId: "fake-engine", label: "Fake Engine", selectable: true }];
  const groups = modelGroups.buildHarnessModelSelectGroups(harnesses);
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
          createElement(ModelConfigSelect, {
            modelGroups: groups,
            normalizedValue: "",
            triggerLabel: "Choose a model",
            showManageModelsAction: false,
            lockReasonMessage: "Unavailable",
            isItemLocked: () => false,
            onValueChange: (value: string) => selected.push(value),
            openRequestKey: 0,
            disabled: false,
          }),
        ),
      );
    });
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ModelConfigSelect, {
            modelGroups: groups,
            normalizedValue: "",
            triggerLabel: "Choose a model",
            showManageModelsAction: false,
            lockReasonMessage: "Unavailable",
            isItemLocked: () => false,
            onValueChange: (value: string) => selected.push(value),
            openRequestKey: 1,
            disabled: false,
          }),
        ),
      );
    });
    const engineItem = [
      ...document.body.querySelectorAll<HTMLElement>('[data-testid^="chat-model-select-item-"]'),
    ].find((item) => item.textContent?.includes("Fake Engine"));
    assert.ok(engineItem, "Harness-only selector should expose its choice without Provider groups");
    await act(async () => {
      engineItem.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(selected, [modelGroups.encodeHarnessModelSelectValue("fake-engine")]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
