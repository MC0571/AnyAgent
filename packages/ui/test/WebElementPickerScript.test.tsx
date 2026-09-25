import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { buildWebElementPickerScript } from "../src/lib/webElementPickerScript.js";

test("web element picker accepts a direct click without a prior mousemove", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="marker">PR25_WEB_ELEMENT_MARKER_925</button></body></html>',
    { url: "http://127.0.0.1:43127/fixture", pretendToBeVisual: true, runScripts: "outside-only" },
  );
  try {
    // tsx wraps named closures in __name when `toString()` serializes the script.
    dom.window.eval("window.__name = (value) => value");
    const result = dom.window.eval(buildWebElementPickerScript()) as Promise<{
      status: string;
      element?: { tagName: string; text?: string; pageUrl: string };
    }>;
    const button = dom.window.document.getElementById("marker");
    assert.ok(button);
    button.click();
    const selected = await result;
    assert.equal(selected.status, "selected");
    assert.equal(selected.element?.tagName, "button");
    assert.equal(selected.element?.text, "PR25_WEB_ELEMENT_MARKER_925");
    assert.equal(selected.element?.pageUrl, "http://127.0.0.1:43127/fixture");
  } finally {
    dom.window.close();
  }
});

test("web element picker cancels when a click has no element target", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://127.0.0.1:43127/fixture",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  try {
    dom.window.eval("window.__name = (value) => value");
    const result = dom.window.eval(buildWebElementPickerScript()) as Promise<{ status: string }>;
    dom.window.document.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert.equal((await result).status, "cancelled");
  } finally {
    dom.window.close();
  }
});

test("web element picker preserves body selection", async () => {
  const dom = new JSDOM("<!doctype html><html><body>Whole page context</body></html>", {
    url: "http://127.0.0.1:43127/fixture",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  try {
    dom.window.eval("window.__name = (value) => value");
    const result = dom.window.eval(buildWebElementPickerScript()) as Promise<{
      status: string;
      element?: { tagName: string; text?: string };
    }>;
    dom.window.document.body.click();
    const selected = await result;
    assert.equal(selected.status, "selected");
    assert.equal(selected.element?.tagName, "body");
    assert.equal(selected.element?.text, "Whole page context");
  } finally {
    dom.window.close();
  }
});
