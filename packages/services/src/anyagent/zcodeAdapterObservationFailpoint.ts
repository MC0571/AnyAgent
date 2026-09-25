import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAppConfigDir } from "#src/paths.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

const FAILPOINT_FILE = "zcode-adapter-observation-drop.json";

interface ZCodeAdapterObservationFailpoint {
  readonly schemaVersion: 1;
  readonly enabled: true;
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly inputId: string;
}

function failpointIsAllowed(): boolean {
  return (
    isEffectiveDevelopmentNodeEnv() &&
    process.env.ANYAGENT_M0 === "1" &&
    Boolean(process.env.ZCODE_DATA_BASE_DIR?.trim())
  );
}

export function getZCodeAdapterObservationFailpointPath(): string | null {
  if (!process.env.ZCODE_DATA_BASE_DIR?.trim()) return null;
  return join(getAppConfigDir(), "dev", FAILPOINT_FILE);
}

function readFailpoint(path: string): ZCodeAdapterObservationFailpoint | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const state = parsed as Record<string, unknown>;
    const nonEmptyString = (value: unknown): value is string =>
      typeof value === "string" && value.trim().length > 0;
    if (
      state.schemaVersion !== 1 ||
      state.enabled !== true ||
      !nonEmptyString(state.workspaceKey) ||
      !nonEmptyString(state.sessionId) ||
      !nonEmptyString(state.inputId) ||
      state.consumedAt !== undefined
    )
      return null;
    return {
      schemaVersion: 1,
      enabled: true,
      workspaceKey: state.workspaceKey,
      sessionId: state.sessionId,
      inputId: state.inputId,
    };
  } catch {
    return null;
  }
}

/**
 * Consume a single Adapter event-observation loss for one isolated development Input.
 * This only changes this Adapter run's event subscription; it never touches the CLI transport.
 */
export function consumeZCodeAdapterObservationFailpoint(expected: {
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly inputId: string;
}): boolean {
  if (!failpointIsAllowed()) return false;
  const path = getZCodeAdapterObservationFailpointPath();
  if (!path) return false;
  const failpoint = readFailpoint(path);
  if (
    !failpoint ||
    failpoint.workspaceKey !== expected.workspaceKey ||
    failpoint.sessionId !== expected.sessionId ||
    failpoint.inputId !== expected.inputId
  )
    return false;

  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        {
          ...failpoint,
          enabled: false,
          consumedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
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
