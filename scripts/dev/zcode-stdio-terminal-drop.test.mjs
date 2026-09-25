import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const proxyPath = new URL("./zcode-stdio-tap.mjs", import.meta.url);
const workspaceKey = "isolated-workspace-key";
const sessionId = "native-session-for-test";
const commandId = "product-command-for-test";

function terminalEvent({ session = sessionId, command = commandId, type = "turn.completed" } = {}) {
  return {
    method: "session/event",
    params: {
      sessionId: session,
      type,
      payload: {
        inputId: command,
        response: "SENSITIVE_TERMINAL_RESULT_TEST_ONLY",
      },
    },
  };
}

async function createFixture(t, envOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "anyagent-stdio-terminal-drop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, ".zcode", "v2", "dev");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const failpointPath = join(configDir, "zcode-stdio-terminal-drop.json");
  const markerPath = join(root, "native-side-effect-marker");
  const config = {
    schemaVersion: 1,
    enabled: true,
    workspaceKey,
    sessionId,
    commandId,
  };
  await writeFile(failpointPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const cliScript = join(root, "fake-cli.mjs");
  const beforeTerminal = [
    {
      method: "session/event",
      params: { sessionId, type: "turn.completed", payload: { inputId: "other-command" } },
    },
    {
      method: "session/event",
      params: {
        sessionId: "other-session",
        type: "turn.completed",
        payload: { inputId: commandId },
      },
    },
    {
      method: "session/event",
      params: { sessionId, type: "turn.started", payload: { inputId: commandId } },
    },
  ];
  const scriptBody = [
    'import { appendFileSync } from "node:fs";',
    'if (process.env.TEST_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => appendFileSync(process.env.TEST_SIDE_EFFECT_MARKER, "sigterm-ignored" + String.fromCharCode(10)));',
    'appendFileSync(process.env.TEST_SIDE_EFFECT_MARKER, "effect" + String.fromCharCode(10));',
    `process.stdout.write(${JSON.stringify(beforeTerminal.map((event) => JSON.stringify(event) + "\n").join(""))});`,
    `process.stdout.write(${JSON.stringify(JSON.stringify(terminalEvent()) + "\n")});`,
    'if (process.env.TEST_STAY_OPEN === "1") setInterval(() => {}, 1000);',
  ].join("\n");
  await writeFile(cliScript, scriptBody);

  return {
    root,
    failpointPath,
    markerPath,
    cliScript,
    env: {
      ...process.env,
      ANYAGENT_M0: "1",
      ZCODE_RUNTIME_ENV: "development",
      ZCODE_DATA_BASE_DIR: root,
      TEST_SIDE_EFFECT_MARKER: markerPath,
      TEST_STAY_OPEN: "1",
      TEST_IGNORE_SIGTERM: "0",
      ...envOverrides,
    },
  };
}

async function runProxy(
  fixture,
  { proxyWorkspaceKey = workspaceKey, timeoutMs = 5_000, stayOpen = true } = {},
) {
  const child = spawn(
    process.execPath,
    [
      proxyPath.pathname,
      "--workspace-key",
      proxyWorkspaceKey,
      "--terminal-drop-failpoint",
      "--",
      process.execPath,
      fixture.cliScript,
    ],
    {
      env: { ...fixture.env, TEST_STAY_OPEN: stayOpen ? "1" : "0" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [code, signal] = await once(child, "close");
    return { code, signal, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

test("stdio failpoint drops only the exact terminal frame, closes its CLI and consumes once", async (t) => {
  const fixture = await createFixture(t);
  fixture.env.ZCODE_STDIO_TAP_LOG_DIR = join(fixture.root, "explicit-tap-log-dir");
  const result = await runProxy(fixture);

  assert.equal(result.signal, null);
  assert.notEqual(result.code, null);
  assert.equal(result.stderr.includes("SENSITIVE_TERMINAL_RESULT_TEST_ONLY"), false);
  assert.equal(result.stdout.includes("SENSITIVE_TERMINAL_RESULT_TEST_ONLY"), false);
  assert.equal(result.stdout.includes('"inputId":"other-command"'), true, JSON.stringify(result));
  assert.equal(result.stdout.includes('"sessionId":"other-session"'), true);
  assert.equal(result.stdout.includes('"type":"turn.started"'), true);

  assert.equal((await readFile(fixture.markerPath, "utf8")).trim(), "effect");
  const consumed = JSON.parse(await readFile(fixture.failpointPath, "utf8"));
  assert.equal(consumed.enabled, false);
  assert.equal(consumed.workspaceKey, workspaceKey);
  assert.equal(consumed.sessionId, sessionId);
  assert.equal(consumed.commandId, commandId);
  assert.equal(consumed.consumedEventType, "turn.completed");
  assert.equal(typeof consumed.consumedAt, "string");

  await assert.rejects(access(join(fixture.root, ".zcode", "v2", "dev", "stdio-traffic")));
  await assert.rejects(access(fixture.env.ZCODE_STDIO_TAP_LOG_DIR));
  fixture.env.ZCODE_STDIO_TAP_LOG_DIR = "";
  const second = await runProxy(fixture, { stayOpen: false });
  assert.equal(second.stdout.includes("SENSITIVE_TERMINAL_RESULT_TEST_ONLY"), true);
  assert.equal((await readFile(fixture.markerPath, "utf8")).trim().split("\n").length, 2);
});

test("stdio failpoint stays inert for other workspaces and production runtime", async (t) => {
  const workspaceFixture = await createFixture(t);
  const wrongWorkspace = await runProxy(workspaceFixture, {
    proxyWorkspaceKey: "another-isolated-workspace",
    stayOpen: false,
  });
  assert.equal(
    wrongWorkspace.stdout.includes("SENSITIVE_TERMINAL_RESULT_TEST_ONLY"),
    true,
    JSON.stringify(wrongWorkspace),
  );
  assert.equal(JSON.parse(await readFile(workspaceFixture.failpointPath, "utf8")).enabled, true);

  const productionFixture = await createFixture(t, { ZCODE_RUNTIME_ENV: "production" });
  const production = await runProxy(productionFixture, { stayOpen: false });
  assert.equal(production.stdout.includes("SENSITIVE_TERMINAL_RESULT_TEST_ONLY"), true);
  assert.equal(JSON.parse(await readFile(productionFixture.failpointPath, "utf8")).enabled, true);
});

test("stdio failpoint force-closes only its owned CLI if SIGTERM is ignored", async (t) => {
  const fixture = await createFixture(t, { TEST_IGNORE_SIGTERM: "1" });
  const result = await runProxy(fixture, { timeoutMs: 3_000 });

  assert.equal(result.signal, null, JSON.stringify(result));
  assert.notEqual(result.code, null);
  assert.equal(result.stdout.includes("SENSITIVE_TERMINAL_RESULT_TEST_ONLY"), false);
  assert.deepEqual((await readFile(fixture.markerPath, "utf8")).trim().split("\n"), [
    "effect",
    "sigterm-ignored",
  ]);
  const consumed = JSON.parse(await readFile(fixture.failpointPath, "utf8"));
  assert.equal(consumed.enabled, false);
  assert.equal(consumed.commandId, commandId);
});

test("proxy re-reads the isolated config after startup and drops only the exact updated inputId", async (t) => {
  const fixture = await createFixture(t);
  const placeholder = "pending-input-id-placeholder";
  await writeFile(
    fixture.failpointPath,
    `${JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      workspaceKey,
      sessionId,
      commandId: placeholder,
    })}\n`,
    { mode: 0o600 },
  );

  const interactiveCli = join(fixture.root, "interactive-cli.mjs");
  const scriptBody = [
    'import { appendFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    "const input = createInterface({ input: process.stdin });",
    'process.stderr.write("TEST_CLI_READY\\n");',
    'input.on("line", (line) => {',
    "  const request = JSON.parse(line);",
    '  if (request.method !== "v4/command" || request.params?.type !== "sendText") return;',
    "  if (request.params.sessionId !== process.env.TEST_SESSION_ID) return;",
    '  appendFileSync(process.env.TEST_SIDE_EFFECT_MARKER, "effect\\n");',
    '  for (const id of ["another-input", request.params.commandId]) {',
    '    const event = { method: "session/event", params: { sessionId: request.params.sessionId, type: "turn.completed", payload: { inputId: id, response: "SENSITIVE_TERMINAL_RESULT_TEST_ONLY" } } };',
    '    process.stdout.write(JSON.stringify(event) + "\\n");',
    "  }",
    "});",
  ].join("\n");
  await writeFile(interactiveCli, scriptBody);

  const proxy = spawn(
    process.execPath,
    [
      proxyPath.pathname,
      "--workspace-key",
      workspaceKey,
      "--terminal-drop-failpoint",
      "--",
      process.execPath,
      interactiveCli,
    ],
    { env: { ...fixture.env, TEST_SESSION_ID: sessionId }, stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => proxy.kill("SIGKILL"));
  let stdout = "";
  let stderr = "";
  proxy.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  let announceReady;
  const ready = new Promise((resolve) => (announceReady = resolve));
  proxy.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    if (stderr.includes("TEST_CLI_READY")) announceReady();
  });
  await Promise.race([
    ready,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("fake CLI did not start")), 5_000);
      timer.unref();
    }),
  ]);

  const expectedInputId = "persisted-product-input-7";
  const updatedConfig = {
    schemaVersion: 1,
    enabled: true,
    workspaceKey,
    sessionId,
    commandId: expectedInputId,
  };
  const temporaryPath = fixture.failpointPath + ".test.tmp";
  await writeFile(temporaryPath, `${JSON.stringify(updatedConfig, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, fixture.failpointPath);

  proxy.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "v4/command",
      params: {
        type: "sendText",
        sessionId,
        commandId: expectedInputId,
        payload: { text: "do the isolated operation" },
      },
    })}\n`,
  );
  const [code, signal] = await once(proxy, "close");

  assert.equal(signal, null);
  assert.notEqual(code, null);
  assert.equal(stdout.includes('"inputId":"another-input"'), true, stdout);
  assert.equal(stdout.includes(`"inputId":"${expectedInputId}"`), false, stdout);
  assert.equal((await readFile(fixture.markerPath, "utf8")).trim(), "effect");
  const consumed = JSON.parse(await readFile(fixture.failpointPath, "utf8"));
  assert.equal(consumed.enabled, false);
  assert.equal(consumed.commandId, expectedInputId);
  assert.equal(consumed.consumedEventType, "turn.completed");
  assert.equal(JSON.stringify(consumed).includes("SENSITIVE_TERMINAL_RESULT_TEST_ONLY"), false);
  await assert.rejects(access(join(fixture.root, ".zcode", "v2", "dev", "stdio-traffic")));
});
