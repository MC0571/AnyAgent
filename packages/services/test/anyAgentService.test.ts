import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAnyAgentService } from "../src/anyagent/createAnyAgentService.js";
import { setDataBaseDir } from "../src/paths.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";

async function waitForCompleted(
  service: ReturnType<typeof createAnyAgentService>["service"],
  taskId: string,
  count: number,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const history = await service.getHistory(taskId);
    if (
      history?.executions.length === count &&
      history.executions.every((run) => run.status === "completed")
    )
      return history;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const history = await service.getHistory(taskId);
  assert.fail(
    `Fake Engine did not complete through the Host service: ${JSON.stringify({
      inputs: history?.inputs.map((item) => item.status),
      executions: history?.executions.map((item) => item.status),
      issues: history?.integrityIssues.map((item) => item.type),
    })}`,
  );
}

test("one Host service drives Fake multiround and reports ZCode unavailability without fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyagent-host-"));
  setDataBaseDir(directory);
  const host = createAnyAgentService({} as IZCodeAgentService);
  let changes = 0;
  const subscription = host.service.onDidChange(() => changes++);
  try {
    const engines = await host.service.listEngines();
    assert.equal(
      engines.find((item) => item.engineId === "fake")?.capabilities["execution.run"].availability,
      "available",
    );
    assert.equal(
      engines.find((item) => item.engineId === "zcode")?.capabilities["execution.run"].availability,
      "temporarily-unavailable",
    );
    await assert.rejects(host.service.createTask({ engineId: "zcode" }));

    const task = await host.service.createTask({ engineId: "fake" });
    assert.equal(task.environment.workDirectory, join(directory, ".zcode", "workspace", "default"));
    assert.equal(task.credentialSource.kind, "none");
    const input = {
      taskId: task.id,
      participantId: task.participant.id,
      sessionId: task.session.id,
      authorizationId: task.authorizationId,
    };
    await host.service.submitInput({ ...input, text: "first" });
    await waitForCompleted(host.service, task.id, 1);
    await host.service.submitInput({ ...input, text: "second" });
    const history = await waitForCompleted(host.service, task.id, 2);
    assert.deepEqual(
      history.inputs.map((item) => item.sessionId),
      [task.session.id, task.session.id],
    );
    assert.ok(changes > 0);

    const other = await host.service.createTask({ engineId: "fake" });
    assert.notEqual(other.participant.id, task.participant.id);
    assert.notEqual(other.session.id, task.session.id);
    await assert.rejects(
      host.service.submitInput({ ...input, taskId: other.id, text: "wrong session" }),
    );
  } finally {
    subscription.dispose();
    host.close();
    setDataBaseDir(null);
    await rm(directory, { recursive: true, force: true });
  }
});
