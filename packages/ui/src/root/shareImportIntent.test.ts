import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveShareImportRoute } from "./shareImportIntent.js";

test("shared-context deep links use the Engine Task route only when the entry flag is enabled", () => {
  assert.equal(resolveShareImportRoute(false, true), "native-session");
  assert.equal(resolveShareImportRoute(true, true), "engine-task");
  assert.equal(resolveShareImportRoute(true, false), "unavailable");
});
