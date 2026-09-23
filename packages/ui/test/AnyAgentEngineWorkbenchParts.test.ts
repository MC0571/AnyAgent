import assert from "node:assert/strict";
import { test } from "node:test";
import { canActOnTask, type WorkbenchTask } from "../src/AnyAgentEngineWorkbenchParts.js";

test("Workbench keeps stop control available for frozen or terminal Tasks", () => {
  for (const status of ["frozen", "abandoned"] as const) {
    const task = {
      status,
      session: { status: "unknown" },
      engine: {
        capabilities: {
          "execution.interrupt": { support: "supported", availability: "available" },
        },
      },
    } as WorkbenchTask;
    assert.equal(canActOnTask(task, "execution.interrupt"), null);
    assert.match(canActOnTask(task, "execution.run") ?? "", /不接收新的业务请求/);
  }
});
