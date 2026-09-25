import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SharedContextImportRequest } from "../src/prompt-editor/SharedContextImportDialog.js";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  win.matchMedia = (() => ({
    matches: false,
    media: "",
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
  const legacyEventTarget = win.HTMLElement.prototype as HTMLElement & {
    attachEvent: (eventName: string, listener: EventListener) => void;
    detachEvent: (eventName: string, listener: EventListener) => void;
  };
  legacyEventTarget.attachEvent = function (eventName, listener) {
    this.addEventListener(eventName.replace(/^on/u, ""), listener);
  };
  legacyEventTarget.detachEvent = function (eventName, listener) {
    this.removeEventListener(eventName.replace(/^on/u, ""), listener);
  };
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
    Element: win.Element,
    Node: win.Node,
    DocumentFragment: win.DocumentFragment,
    NodeFilter: win.NodeFilter,
    Text: win.Text,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    FocusEvent: win.FocusEvent,
    SVGElement: win.SVGElement,
    DOMRect: win.DOMRect,
    MutationObserver: win.MutationObserver,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    getComputedStyle: win.getComputedStyle.bind(win),
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

function ShareImportHarness({
  DialogComponent,
  onImport,
}: {
  DialogComponent: typeof import("../src/prompt-editor/SharedContextImportDialog.js").SharedContextImportDialog;
  onImport: (request: SharedContextImportRequest) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(true);
  return createElement(
    "div",
    null,
    createElement("output", { "data-testid": "dialog-open" }, String(open)),
    createElement(DialogComponent, { open, onOpenChange: setOpen, onImport }),
  );
}

async function waitFor(assertion: () => void) {
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
  throw lastError;
}

async function waitForElement<T extends HTMLElement>(selector: string): Promise<T> {
  let element: T | null = null;
  await waitFor(() => {
    element = document.querySelector<T>(selector);
    assert.ok(element);
  });
  return element as T;
}

test("shared context dialog sends a parsed share URL and keeps the dialog open on failure", async () => {
  const dom = installDom();
  const [{ SharedContextImportDialog }, { ZCodeIntlProvider }] = await Promise.all([
    import("../src/prompt-editor/SharedContextImportDialog.js"),
    import("../src/i18n/IntlProvider.js"),
  ]);
  const requests: SharedContextImportRequest[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ShareImportHarness, {
          DialogComponent: SharedContextImportDialog,
          onImport: async (request) => {
            requests.push(request);
            return requests.length > 1;
          },
        }),
      ),
    );
  });

  try {
    const input = await waitForElement<HTMLInputElement>(
      '[data-testid="conversation-share-import-input"]',
    );
    await act(async () => {
      input.focus();
      const valueSetter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, "https://zcode.z.ai/cn/share/share_123");
      const propertyChange = new dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="conversation-share-import-submit"]')
        ?.click();
    });
    await waitFor(() => {
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.shareCode, "share_123");
      assert.ok(requests[0]?.clientRequestId.startsWith("share-import-request-"));
      assert.equal(container.querySelector('[data-testid="dialog-open"]')?.textContent, "true");
      assert.ok(document.querySelector('[data-testid="conversation-share-import-error"]'));
    });
    assert.equal(input.value, "https://zcode.z.ai/cn/share/share_123");

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="conversation-share-import-submit"]')
        ?.click();
    });
    await waitFor(() => {
      assert.equal(requests.length, 2);
      assert.equal(requests[1]?.clientRequestId, requests[0]?.clientRequestId);
      assert.equal(container.querySelector('[data-testid="dialog-open"]')?.textContent, "false");
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.close();
  }
});
