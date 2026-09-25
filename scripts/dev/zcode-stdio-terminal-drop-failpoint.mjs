import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function isIsolatedDevelopmentFailpointAllowed() {
  return (
    process.env.ANYAGENT_M0 === "1" &&
    process.env.ZCODE_RUNTIME_ENV?.trim().toLowerCase() === "development" &&
    Boolean(process.env.ZCODE_DATA_BASE_DIR?.trim())
  );
}

export function getTerminalDropFailpointPath() {
  const dataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim();
  return dataBaseDir
    ? join(dataBaseDir, ".zcode", "v2", "dev", "zcode-stdio-terminal-drop.json")
    : null;
}

export function readTerminalDropFailpoint(path, workspaceKey) {
  if (!path) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.schemaVersion !== 1 ||
      parsed.enabled !== true ||
      parsed.workspaceKey !== workspaceKey ||
      typeof parsed.sessionId !== "string" ||
      !parsed.sessionId.trim() ||
      typeof parsed.commandId !== "string" ||
      !parsed.commandId.trim() ||
      parsed.consumedAt !== undefined
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      enabled: true,
      workspaceKey,
      sessionId: parsed.sessionId,
      commandId: parsed.commandId,
    };
  } catch {
    return null;
  }
}

export function consumeTerminalDropFailpoint(path, expected, eventType) {
  if (!path || !expected) {
    return false;
  }
  const current = readTerminalDropFailpoint(path, expected.workspaceKey);
  if (
    !current ||
    current.sessionId !== expected.sessionId ||
    current.commandId !== expected.commandId
  ) {
    return false;
  }

  const temporaryPath = path + "." + process.pid + ".tmp";
  try {
    writeFileSync(
      temporaryPath,
      JSON.stringify(
        {
          ...current,
          enabled: false,
          consumedAt: new Date().toISOString(),
          consumedEventType: eventType,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    renameSync(temporaryPath, path);
    return true;
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    return false;
  }
}

export function matchesTerminalFrame(line, failpoint) {
  if (!failpoint || !isIsolatedDevelopmentFailpointAllowed()) {
    return null;
  }
  try {
    const message = JSON.parse(line.trim());
    const params = message?.method === "session/event" ? message.params : null;
    const payload = params && typeof params.payload === "object" ? params.payload : null;
    if (!params || !payload) {
      return null;
    }
    // The Host can start this proxy before the UI creates the next product Input.
    // Re-read the isolated profile per terminal frame and match its exact native inputId.
    const expected = readTerminalDropFailpoint(failpoint.path, failpoint.workspaceKey);
    if (
      !expected ||
      params.sessionId !== expected.sessionId ||
      !["turn.completed", "turn.failed"].includes(params.type) ||
      payload.inputId !== expected.commandId
    ) {
      return null;
    }
    return { commandId: expected.commandId, eventType: params.type };
  } catch {
    return null;
  }
}
