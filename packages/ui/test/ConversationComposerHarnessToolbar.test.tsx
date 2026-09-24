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

test("ConversationComposer keeps the Harness toolbar stable from selection through first send", async () => {
  const dom = installDom();
  const sent: Array<{ text: string; attachments?: unknown }> = [];
  const [
    { ConversationComposer },
    { ServiceProvider },
    { PlatformProvider },
    { ZCodeIntlProvider },
    { TabStoreProvider },
    { StoreProvider },
    { CodingPlanUpgradeDialogProvider },
    { TooltipProvider },
  ] = await Promise.all([
    import("../src/v4/ConversationComposer.js"),
    import("../src/hooks/useServices.js"),
    import("../src/hooks/usePlatform.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/store/TabStoreProvider.js"),
    import("../src/store/StoreProvider.js"),
    import("../src/settings/CodingPlanUpgradeDialogProvider.js"),
    import("../src/components/ui/tooltip.js"),
  ]);

  const services = {
    settingService: { get: async () => ({}) },
    clientConfigService: { getSnapshot: async () => ({ pluginStoreOrder: null }) },
    pluginManagementService: {
      getPluginReferenceCatalog: async () => ({ entries: [], authority: "workspace" }),
    },
    fileService: { searchWorkspaceFiles: async () => [] },
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
    selectFiles: async () => ["/tmp/selected.md"],
    onSettingsChanged: () => () => {},
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalCreateObjectURL = URL.createObjectURL;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => "blob:composer-harness-test",
  });
  const composerProps = {
    snapshot: null,
    draftMode: true,
    composerDraft: { text: "first harness draft", updatedAt: 1 },
    updateComposerContent: () => {},
    replaceComposerDraft: () => {},
    workspacePath: "/tmp/anyagent-composer-test",
    harnesses: [{ engineId: "fake-engine", label: "Fake Engine", selectable: true }],
    attachmentPut: async () => ({}) as never,
    onSendText: async (text: string, options?: { attachments?: unknown }) => {
      sent.push({ text, attachments: options?.attachments });
      return "sent" as const;
    },
    onStop: () => {},
    onSelectModel: () => {},
    onSelectThought: () => {},
    onSwitchMode: () => {},
  };
  function Fixture() {
    const [selectedHarnessId, setSelectedHarnessId] = useState<string | null>(null);
    return createElement(ConversationComposer, {
      ...composerProps,
      autoFocusEnabled: false,
      selectedHarnessId,
      onSelectHarness: setSelectedHarnessId,
    } as never);
  }

  const renderApp = () =>
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
              StoreProvider,
              {
                broadcastService: {
                  send: () => {},
                  onMessage: () => ({ dispose: () => {} }),
                } as never,
              },
              createElement(
                TabStoreProvider,
                null,
                createElement(CodingPlanUpgradeDialogProvider, null, createElement(Fixture)),
              ),
            ),
          ),
        ),
      ),
    );

  try {
    await act(async () => root.render(renderApp()));
    const picker = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-select-trigger"]',
    );
    assert.ok(picker, "the existing model selector should be present before Harness selection");
    const addContext = () =>
      container.querySelector<HTMLButtonElement>(
        '[data-composer-leading-content] button[data-testid="chat-attachment-button"]',
      );
    assert.ok(addContext(), "Provider draft keeps the native + control");
    assert.equal(addContext()?.disabled, false, "Provider draft + remains enabled");
    assert.equal(
      container.querySelector('[data-testid="chat-thought-level-select-trigger"]'),
      null,
    );
    const sendButton = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="v4-composer-send"]');
    await waitFor(() => assert.equal(sendButton()?.disabled, false), "draft text did not hydrate");

    await act(async () => {
      picker.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      picker.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, button: 0 }));
      picker.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await waitFor(() => {
      assert.ok(
        [
          ...document.body.querySelectorAll<HTMLElement>(
            '[data-testid^="chat-model-select-item-"]',
          ),
        ].some((item) => item.textContent?.includes("Fake Engine")),
      );
    }, "Harness option did not open in the existing model selector");
    const harnessItem = [
      ...document.body.querySelectorAll<HTMLElement>('[data-testid^="chat-model-select-item-"]'),
    ].find((item) => item.textContent?.includes("Fake Engine"));
    assert.ok(harnessItem);
    await act(async () => {
      harnessItem.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    const mode = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="chat-mode-select-trigger"]');
    const thought = () =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-thought-level-select-trigger"]',
      );
    await waitFor(() => {
      assert.ok(mode(), "Harness selection should retain the native mode selector");
      assert.ok(thought(), "Harness selection should retain the native reasoning selector");
    }, "disabled Harness configuration controls did not render");
    assert.equal(mode()?.disabled, true);
    assert.match(mode()?.getAttribute("aria-label") ?? "", /尚未映射权限\/执行模式设置/);
    assert.match(mode()?.textContent ?? "", /接入未映射/);
    assert.equal(thought()?.disabled, true);
    assert.match(thought()?.getAttribute("aria-label") ?? "", /尚未映射推理档位设置/);
    assert.match(thought()?.textContent ?? "", /接入未映射/);
    assert.equal(addContext()?.disabled, false, "Harness + remains available for local files");
    await act(async () => {
      addContext()!.click();
    });
    assert.equal(addContext()?.getAttribute("aria-haspopup"), "dialog");
    assert.equal(addContext()?.getAttribute("aria-expanded"), "true");
    const attachmentAction = () =>
      document.body.querySelector<HTMLElement>('[data-testid="chat-attachment-menu-item"]');
    await waitFor(() => assert.ok(attachmentAction()), "Harness + menu omitted local attachment");
    const attachmentOption = attachmentAction()?.closest<HTMLButtonElement>('[role="option"]');
    assert.ok(attachmentOption, "local attachment should use the native suggestion row");
    await act(async () => {
      attachmentOption.dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });
    await waitFor(
      () => assert.ok(container.querySelector("[data-composer-attachment-remove]")),
      "selected local attachment was not rendered in the formal composer",
    );
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(fileInput);
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new dom.window.File(["pasted image"], "pasted.png", { type: "image/png" })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await waitFor(
      () =>
        assert.ok(
          container.textContent?.includes("必须是可由 Host 核验的本地文件"),
          "Harness must reject a file without a Host local path",
        ),
      "pathless browser attachment was not rejected",
    );

    const input = container.querySelector<HTMLElement>('[data-testid="v4-composer-input"]') as
      | (HTMLElement & { __zcodeLexicalInputE2E?: { setText: (value: string) => void } })
      | null;
    assert.ok(input?.__zcodeLexicalInputE2E, "the real Lexical composer should be mounted");
    await waitFor(() => {
      assert.equal(sendButton()?.disabled, false);
    }, "first Harness draft should be sendable");
    await act(async () => {
      sendButton()!.click();
    });
    await waitFor(() => assert.equal(sent.length, 1), "draft with attachment was not sent");
    assert.deepEqual(sent[0], {
      text: "first harness draft",
      attachments: [
        {
          ref: "/tmp/selected.md",
          fileName: "selected.md",
          mime: "text/markdown",
          bytes: 0,
        },
      ],
    });
    assert.equal(mode()?.disabled, true, "mode control remains unavailable after first send");
    assert.equal(
      thought()?.disabled,
      true,
      "reasoning control remains unavailable after first send",
    );
    assert.equal(addContext()?.disabled, false, "+ remains available after first send");
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    });
    dom.window.close();
  }
});

test("a new ZCode Harness draft submits its selected model, mode, and reasoning level", async () => {
  const dom = installDom();
  const sent: Array<{ text: string; submission?: unknown }> = [];
  const [
    { ConversationComposer },
    { createComposerSubmissionConfig },
    { ServiceProvider },
    { PlatformProvider },
    { ZCodeIntlProvider },
    { TabStoreProvider },
    { StoreProvider },
    { CodingPlanUpgradeDialogProvider },
    { TooltipProvider },
  ] = await Promise.all([
    import("../src/v4/ConversationComposer.js"),
    import("../src/v4/composer/composerSubmissionConfig.js"),
    import("../src/hooks/useServices.js"),
    import("../src/hooks/usePlatform.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/store/TabStoreProvider.js"),
    import("../src/store/StoreProvider.js"),
    import("../src/settings/CodingPlanUpgradeDialogProvider.js"),
    import("../src/components/ui/tooltip.js"),
  ]);
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
    ],
    preferredSelection: {
      providerId: "opencode-go",
      modelId: "go-alpha",
      options: { reasoningLevel: "high" },
    },
  };
  const services = {
    settingService: { get: async () => ({}) },
    clientConfigService: { getSnapshot: async () => ({ pluginStoreOrder: null }) },
    pluginManagementService: {
      getPluginReferenceCatalog: async () => ({ entries: [], authority: "workspace" }),
    },
    fileService: { searchWorkspaceFiles: async () => [] },
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
  function Fixture() {
    const [selectedHarnessId, setSelectedHarnessId] = useState<string | null>(null);
    const [draftConfig, setDraftConfig] = useState({
      provider: "opencode-go",
      model: "go-alpha",
      mode: "build",
      planEnabled: false,
      modelSelection: {
        providerId: "opencode-go",
        modelId: "go-alpha",
        options: { reasoningLevel: "high" },
      },
    });
    return createElement(ConversationComposer, {
      snapshot: null,
      draftMode: true,
      composerDraft: { text: "first native draft", updatedAt: 1 },
      updateComposerContent: () => {},
      replaceComposerDraft: () => {},
      workspacePath: "/tmp/anyagent-composer-test",
      harnesses: [{ engineId: "zcode", label: "ZCode Harness", selectable: true }],
      selectedHarnessId,
      onSelectHarness: setSelectedHarnessId,
      modelSelectionView: modelView,
      modelSelectionState: { status: "ready", view: modelView },
      draftConfig,
      createSubmissionFromComposer: () => createComposerSubmissionConfig(draftConfig, modelView),
      submissionReady: true,
      attachmentPut: async () => ({}) as never,
      onSendText: async (text: string, options?: { submission?: unknown }) => {
        sent.push({ text, submission: options?.submission });
        return "sent" as const;
      },
      onStop: () => {},
      onSelectModel: (provider: string, model: string) => {
        setDraftConfig((current) => ({
          ...current,
          provider,
          model,
          modelSelection: {
            providerId: provider,
            modelId: model,
            options: { reasoningLevel: current.modelSelection.options.reasoningLevel },
          },
        }));
      },
      onSelectThought: (
        reasoningLevel: string,
        modelContext: { provider: string; model: string },
      ) => {
        setDraftConfig((current) =>
          current.provider === modelContext.provider && current.model === modelContext.model
            ? {
                ...current,
                modelSelection: {
                  ...current.modelSelection,
                  options: { reasoningLevel },
                },
              }
            : current,
        );
      },
      onSwitchMode: (mode: string) => setDraftConfig((current) => ({ ...current, mode })),
      autoFocusEnabled: false,
    } as never);
  }
  const renderApp = () =>
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
              StoreProvider,
              {
                broadcastService: {
                  send: () => {},
                  onMessage: () => ({ dispose: () => {} }),
                } as never,
              },
              createElement(
                TabStoreProvider,
                null,
                createElement(CodingPlanUpgradeDialogProvider, null, createElement(Fixture)),
              ),
            ),
          ),
        ),
      ),
    );

  try {
    await act(async () => root.render(renderApp()));
    const modelTrigger = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="chat-model-select-trigger"]');
    await waitFor(
      () => assert.match(modelTrigger()?.textContent ?? "", /go-alpha/),
      "draft model did not render",
    );
    await act(async () => {
      const trigger = modelTrigger()!;
      trigger.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, button: 0 }));
      trigger.click();
    });
    await waitFor(
      () =>
        assert.ok(document.body.querySelector('[data-model-provider-key="harness-zcode-models"]')),
      "ZCode Harness model group did not open",
    );
    await act(async () =>
      document.body
        .querySelector<HTMLElement>('[data-model-provider-key="harness-zcode-models"]')!
        .click(),
    );
    const beta = [
      ...document.body.querySelectorAll<HTMLElement>('[data-testid^="chat-model-select-item-"]'),
    ].find(
      (item) =>
        item.textContent?.includes("go-beta") &&
        item.getAttribute("data-model-option-locked") !== "true",
    );
    assert.ok(beta, "ZCode Harness should offer its alternate configured model");
    await act(async () => beta.click());
    await waitFor(
      () => assert.match(modelTrigger()?.textContent ?? "", /go-beta/),
      "model selection did not update",
    );
    await waitFor(
      () =>
        assert.equal(
          document.body.querySelector('[data-model-provider-key="harness-zcode-models"]'),
          null,
        ),
      "model menu did not close after the model was selected",
    );

    const chooseConfig = async (triggerTestId: string, itemTestId: string) => {
      const trigger = container.querySelector<HTMLButtonElement>(
        `[data-testid="${triggerTestId}"]`,
      );
      assert.ok(
        trigger && !trigger.disabled,
        `${triggerTestId} should be enabled for a ZCode Harness draft`,
      );
      await act(async () => {
        trigger.dispatchEvent(
          new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }),
        );
        trigger.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, button: 0 }));
        trigger.click();
      });
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
    const sendButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="v4-composer-send"]',
    );
    await waitFor(() => assert.equal(sendButton?.disabled, false), "draft did not become sendable");
    await act(async () => sendButton!.click());
    await waitFor(() => assert.equal(sent.length, 1), "draft was not sent");
    assert.deepEqual(sent[0], {
      text: "first native draft",
      submission: {
        mode: "edit",
        planEnabled: false,
        modelSelection: {
          providerId: "opencode-go",
          modelId: "go-beta",
          options: { reasoningLevel: "low" },
        },
      },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
