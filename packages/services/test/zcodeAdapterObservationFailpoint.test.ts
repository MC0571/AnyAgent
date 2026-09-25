import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setDataBaseDir } from "../src/paths.js";
import {
  consumeZCodeAdapterObservationFailpoint,
  getZCodeAdapterObservationFailpointPath,
} from "../src/anyagent/zcodeAdapterObservationFailpoint.js";

test("Adapter observation failpoint requires an exact isolated development identity and consumes once", async (t) => {
  const dataBaseDir = await mkdtemp(join(tmpdir(), "anyagent-zcode-observation-failpoint-"));
  const previousEnvironment = {
    ANYAGENT_M0: process.env.ANYAGENT_M0,
    ZCODE_RUNTIME_ENV: process.env.ZCODE_RUNTIME_ENV,
    ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR,
  };
  t.after(async () => {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setDataBaseDir(null);
    await rm(dataBaseDir, { recursive: true, force: true });
  });

  process.env.ANYAGENT_M0 = "1";
  process.env.ZCODE_RUNTIME_ENV = "development";
  process.env.ZCODE_DATA_BASE_DIR = dataBaseDir;
  setDataBaseDir(dataBaseDir);
  const failpointPath = getZCodeAdapterObservationFailpointPath();
  assert.ok(failpointPath);
  await mkdir(dirname(failpointPath), { recursive: true });
  const arm = async () =>
    writeFile(
      failpointPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enabled: true,
          workspaceKey: "/tmp/workspace",
          sessionId: "native-session",
          inputId: "native-input",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  await arm();

  const expected = {
    workspaceKey: "/tmp/workspace",
    sessionId: "native-session",
    inputId: "native-input",
  };
  assert.equal(
    consumeZCodeAdapterObservationFailpoint({ ...expected, workspaceKey: "/tmp/other" }),
    false,
  );
  assert.equal(
    consumeZCodeAdapterObservationFailpoint({ ...expected, sessionId: "other-session" }),
    false,
  );
  assert.equal(
    consumeZCodeAdapterObservationFailpoint({ ...expected, inputId: "other-input" }),
    false,
  );
  assert.equal(JSON.parse(await readFile(failpointPath, "utf8")).enabled, true);

  assert.equal(consumeZCodeAdapterObservationFailpoint(expected), true);
  assert.equal(consumeZCodeAdapterObservationFailpoint(expected), false);
  const consumed = JSON.parse(await readFile(failpointPath, "utf8"));
  assert.equal(consumed.enabled, false);
  assert.equal(typeof consumed.consumedAt, "string");

  await arm();
  process.env.ZCODE_RUNTIME_ENV = "production";
  assert.equal(consumeZCodeAdapterObservationFailpoint(expected), false);
  assert.equal(JSON.parse(await readFile(failpointPath, "utf8")).enabled, true);
});
