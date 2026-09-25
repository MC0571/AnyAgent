import type { CapabilityStatus, EngineCapability } from "@anyagent/engine-contract";

/** Latest in-memory observation; never persisted over a Task's historical snapshot. */
export interface RuntimeCurrentEngineProjection {
  readonly engineId: string;
  readonly adapterVersion: string | null;
  readonly engineVersion: string | null;
  readonly configurationVersion: string | null;
  readonly environment: string | null;
  readonly capabilities: Readonly<Record<EngineCapability, CapabilityStatus>>;
  readonly state: "current" | "unknown";
  readonly observedAt: number | null;
  readonly source: "active-probe" | "unknown";
}

/** Current Host grant state; the saved authorization on Task stays historical. */
export interface RuntimeCurrentAuthorizationProjection {
  readonly status: "current" | "revoked" | "expired" | "missing" | "invalid";
  readonly reason: string | null;
  readonly observedAt: number | null;
}
