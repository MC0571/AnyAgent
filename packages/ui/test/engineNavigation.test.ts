import assert from "node:assert/strict";
import test from "node:test";
import {
  createTaskNavigationHistory,
  goBack,
  goForward,
  pushEngineNavEntry,
  pushNavEntry,
} from "../src/lib/taskNavigationHistory.js";

test("Engine page shares workspace task navigation history", () => {
  const task = pushNavEntry(createTaskNavigationHistory(), "/project", "task-1");
  const engine = pushEngineNavEntry(task, "/project");
  assert.equal(engine.entries[engine.cursor]?.kind, "engine");
  assert.strictEqual(pushEngineNavEntry(engine, "/project"), engine);

  const previous = goBack(engine);
  assert.equal(previous?.entry.kind, "task");
  assert.equal(previous?.entry.kind === "task" && previous.entry.taskId, "task-1");
  const next = previous && goForward(previous.history);
  assert.equal(next?.entry.kind, "engine");

  const remote = pushEngineNavEntry(engine, "/project", "remote-1");
  assert.equal(remote.entries.length, 3);
  assert.equal(remote.entries[remote.cursor]?.workspaceIdentity, "remote-1");
});
