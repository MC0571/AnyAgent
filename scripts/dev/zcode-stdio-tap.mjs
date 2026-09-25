#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import {
  consumeTerminalDropFailpoint,
  getTerminalDropFailpointPath,
  isIsolatedDevelopmentFailpointAllowed,
  matchesTerminalFrame,
  readTerminalDropFailpoint,
} from "./zcode-stdio-terminal-drop-failpoint.mjs";

const TERMINAL_DROP_CHILD_FORCE_MS = 500;

function printUsageAndExit() {
  process.stderr.write(
    [
      "Usage: zcode-stdio-tap.mjs --workspace-key <key> [--log-dir <dir>] [--terminal-drop-failpoint] -- <command> [...args]",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex < 0) {
    printUsageAndExit();
  }

  const options = argv.slice(0, separatorIndex);
  const commandAndArgs = argv.slice(separatorIndex + 1);
  if (commandAndArgs.length === 0) {
    printUsageAndExit();
  }

  let workspaceKey = "";
  let logDir = process.env.ZCODE_STDIO_TAP_LOG_DIR?.trim() || "";
  let terminalDropFailpoint = false;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--workspace-key") {
      workspaceKey = options[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (option === "--log-dir") {
      logDir = options[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (option === "--terminal-drop-failpoint") {
      terminalDropFailpoint = true;
      continue;
    }
    printUsageAndExit();
  }

  if (!workspaceKey.trim()) {
    printUsageAndExit();
  }

  return {
    command: commandAndArgs[0],
    args: commandAndArgs.slice(1),
    logDir: terminalDropFailpoint
      ? null
      : logDir || join(homedir(), ".zcode", "v2", "dev", "stdio-traffic"),
    terminalDropFailpoint,
    workspaceKey,
  };
}

function workspaceHash(workspaceKey) {
  return createHash("sha256").update(workspaceKey).digest("hex").slice(0, 12);
}

function tryParseJsonLine(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { message: null, parseError: null };
  }

  try {
    return { message: JSON.parse(trimmed), parseError: null };
  } catch (error) {
    return {
      message: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractProtocolMeta(message) {
  if (!message || typeof message !== "object") {
    return {};
  }

  const params = "params" in message && typeof message.params === "object" ? message.params : null;
  const payload =
    params && "payload" in params && typeof params.payload === "object" ? params.payload : null;

  return {
    id: "id" in message ? message.id : undefined,
    method: "method" in message ? message.method : undefined,
    sessionId:
      params && "sessionId" in params
        ? params.sessionId
        : payload && "sessionId" in payload
          ? payload.sessionId
          : undefined,
    inputId:
      params && "inputId" in params
        ? params.inputId
        : payload && "inputId" in payload
          ? payload.inputId
          : undefined,
  };
}

function createRecorder({ childPid, stream, workspaceKey }) {
  return function recordLine(direction, raw, bytes) {
    const parsed =
      direction === "agent-stderr" ? { message: null, parseError: null } : tryParseJsonLine(raw);
    const meta = extractProtocolMeta(parsed.message);
    const record = {
      ts: new Date().toISOString(),
      workspaceKey,
      proxyPid: process.pid,
      pid: childPid,
      direction,
      bytes,
      raw,
      message: parsed.message,
      parseError: parsed.parseError,
      ...meta,
    };
    stream.write(`${JSON.stringify(record)}\n`);
  };
}

function createLineTap(direction, recordLine) {
  const decoder = new StringDecoder("utf8");
  let pending = "";

  return {
    push(chunk) {
      pending += decoder.write(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        recordLine(
          direction,
          line.endsWith("\r") ? line.slice(0, -1) : line,
          Buffer.byteLength(line),
        );
      }
    },
    flush() {
      const tail = `${pending}${decoder.end()}`;
      pending = "";
      if (tail.length > 0) {
        recordLine(
          direction,
          tail.endsWith("\r") ? tail.slice(0, -1) : tail,
          Buffer.byteLength(tail),
        );
      }
    },
  };
}

function createStdoutForwarder({ recordLine, terminalDrop }) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let dropped = false;

  const forwardLine = (line, hasNewline) => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    const match = matchesTerminalFrame(normalized, terminalDrop);
    if (
      match &&
      consumeTerminalDropFailpoint(
        terminalDrop.path,
        {
          schemaVersion: 1,
          enabled: true,
          workspaceKey: terminalDrop.workspaceKey,
          sessionId: terminalDrop.sessionId,
          commandId: match.commandId,
        },
        match.eventType,
      )
    ) {
      dropped = true;
      return true;
    }
    process.stdout.write(line + (hasNewline ? "\n" : ""));
    recordLine("agent-to-app", normalized, Buffer.byteLength(normalized));
    return false;
  };

  return {
    push(chunk) {
      if (dropped) {
        return true;
      }
      pending += decoder.write(chunk);
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        if (forwardLine(line, true)) {
          // The Host receives the disconnect immediately after this exact terminal frame.
          pending = "";
          return true;
        }
        newlineIndex = pending.indexOf("\n");
      }
      return false;
    },
    flush() {
      if (dropped) {
        return;
      }
      const tail = pending + decoder.end();
      pending = "";
      if (tail.length > 0) {
        forwardLine(tail, false);
      }
    },
  };
}

const config = parseArgs(process.argv.slice(2));
const failpointPath = getTerminalDropFailpointPath();
const terminalDrop =
  config.terminalDropFailpoint && isIsolatedDevelopmentFailpointAllowed()
    ? {
        config: readTerminalDropFailpoint(failpointPath, config.workspaceKey),
        path: failpointPath,
      }
    : null;
const activeTerminalDrop = terminalDrop?.config
  ? {
      path: terminalDrop.path,
      workspaceKey: terminalDrop.config.workspaceKey,
      sessionId: terminalDrop.config.sessionId,
    }
  : null;
const dir = config.logDir ? join(config.logDir, workspaceHash(config.workspaceKey)) : null;
if (dir) {
  mkdirSync(dir, { recursive: true });
}

const child = spawn(config.command, config.args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const logFilePath = dir
  ? join(
      dir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-proxy-${process.pid}-agent-${child.pid ?? "unknown"}.ndjson`,
    )
  : null;
if (dir && logFilePath) {
  writeFileSync(join(dir, "latest.txt"), `${logFilePath}\n`);
}

const stream = logFilePath ? createWriteStream(logFilePath, { flags: "a" }) : null;
const recordLine = stream
  ? createRecorder({
      childPid: child.pid ?? null,
      stream,
      workspaceKey: config.workspaceKey,
    })
  : () => {};

const stdinTap = createLineTap("app-to-agent", recordLine);
const stdoutTap = createLineTap("agent-to-app", recordLine);
const stderrTap = createLineTap("agent-stderr", recordLine);
const stdoutForwarder = createStdoutForwarder({
  recordLine,
  terminalDrop: activeTerminalDrop,
});
let terminalDropForceTimer;

child.on("error", (error) => {
  recordLine(
    "agent-stderr",
    `[tap] spawn failed: ${error.message}`,
    Buffer.byteLength(error.message),
  );
  process.stderr.write(`[zcode-stdio-tap] spawn failed: ${error.message}\n`);
});

child.stdout.on("data", (chunk) => {
  if (!activeTerminalDrop) {
    process.stdout.write(chunk);
    stdoutTap.push(chunk);
    return;
  }
  if (!stdoutForwarder.push(chunk)) {
    return;
  }
  process.stdin.pause();
  // The terminal frame is persisted by the CLI before it reaches this boundary.
  // Closing the owned CLI gives the Host a real transport close for reconciliation.
  terminalDropForceTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, TERMINAL_DROP_CHILD_FORCE_MS);
  terminalDropForceTimer.unref();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  stderrTap.push(chunk);
});

process.stdin.on("data", (chunk) => {
  stdinTap.push(chunk);
  if (!child.stdin.write(chunk)) {
    process.stdin.pause();
  }
});

child.stdin.on("drain", () => {
  process.stdin.resume();
});

process.stdin.on("end", () => {
  stdinTap.flush();
  child.stdin.end();
});

function forwardSignal(signal) {
  if (!child.killed) {
    child.kill(signal);
  }
}

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("close", (code, signal) => {
  if (terminalDropForceTimer) clearTimeout(terminalDropForceTimer);
  stdinTap.flush();
  if (activeTerminalDrop) stdoutForwarder.flush();
  else stdoutTap.flush();
  stderrTap.flush();
  const exitCode = code ?? (signal ? 1 : 0);
  if (stream) {
    stream.end(() => process.exit(exitCode));
  } else {
    process.exit(exitCode);
  }
});
