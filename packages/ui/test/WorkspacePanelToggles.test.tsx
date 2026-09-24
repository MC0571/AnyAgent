import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  win.matchMedia = (() => ({
    media: "",
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
    customElements: win.customElements,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    Element: win.Element,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
    FocusEvent: win.FocusEvent,
    Node: win.Node,
    NodeFilter: win.NodeFilter,
    SVGElement: win.SVGElement,
    CSSStyleSheet: win.CSSStyleSheet,
    HTMLCanvasElement: win.HTMLCanvasElement,
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
  win.HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof win.HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  return dom;
}

test("workspace shell panel buttons reflect open state after user clicks", async () => {
  const dom = installDom();
  const [
    { DesktopTopOverlay },
    { WorkspaceSidePaneToggleButton },
    { WorkspaceTerminalToggleButton },
    { ZCodeIntlProvider },
    { ServiceProvider },
    { PlatformProvider },
    { TooltipProvider },
  ] = await Promise.all([
    import("../src/DesktopTopOverlay.js"),
    import("../src/WorkspaceSidePaneToggleButton.js"),
    import("../src/WorkspaceTerminalToggleButton.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/hooks/useServices.js"),
    import("../src/hooks/usePlatform.js"),
    import("../src/components/ui/tooltip.js"),
  ]);

  function PanelsHarness() {
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [sidePaneOpen, setSidePaneOpen] = useState(false);
    const [terminalOpen, setTerminalOpen] = useState(false);
    return createElement(
      "div",
      null,
      createElement(DesktopTopOverlay, {
        isMacDesktop: true,
        isSidebarVisible: sidebarOpen,
        updateReadyVersion: null,
        updateState: null,
        toggleSidebarShortcutLabel: "⌘B",
        newTaskShortcutLabel: "⌘N",
        goBackShortcutLabel: "⌘[",
        goForwardShortcutLabel: "⌘]",
        canTaskNavBack: false,
        canTaskNavForward: false,
        canGoBack: false,
        canGoForward: false,
        appLogoUrl: "",
        platform: {},
        onToggleSidebar: () => setSidebarOpen((open) => !open),
        onCreateTask: () => {},
        onGoBack: () => {},
        onGoForward: () => {},
      }),
      createElement(WorkspaceSidePaneToggleButton, {
        isSidePaneOpen: sidePaneOpen,
        onToggleSidePane: () => setSidePaneOpen((open) => !open),
      }),
      createElement(WorkspaceTerminalToggleButton, {
        isTerminalOpen: terminalOpen,
        onToggleTerminal: () => setTerminalOpen((open) => !open),
      }),
    );
  }

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
            ServiceProvider,
            { services: {} },
            createElement(
              PlatformProvider,
              { platform: {} },
              createElement(TooltipProvider, null, createElement(PanelsHarness)),
            ),
          ),
        ),
      );
    });
    const sidebarToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="切换侧边栏"]',
    );
    assert.ok(sidebarToggle);
    await act(async () => {
      sidebarToggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.match(
      sidebarToggle.querySelector("svg")?.getAttribute("class") ?? "",
      /panel-left-close/,
    );

    const sidePaneToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="side-pane-toggle"]',
    );
    assert.ok(sidePaneToggle);
    await act(async () => {
      sidePaneToggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(sidePaneToggle.getAttribute("aria-label"), "收起侧边面板");

    const terminalToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="terminal-toggle"]',
    );
    assert.ok(terminalToggle);
    await act(async () => {
      terminalToggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.match(terminalToggle.className, /!bg-selected/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.close();
  }
});
