import type { EngineEvidence } from "./types.js";

/** Verified native state for a persisted Execution, queried without resending its Input. */
export type EngineExecutionReconciliation =
  | { readonly status: "running"; readonly evidence: EngineEvidence }
  | {
      readonly status: "completed";
      readonly result: string | null;
      readonly evidence: EngineEvidence;
    }
  | { readonly status: "failed"; readonly error: string; readonly evidence: EngineEvidence }
  | { readonly status: "stopped"; readonly evidence: EngineEvidence }
  | {
      readonly status: "unknown";
      readonly reason: string;
      readonly evidence?: EngineEvidence;
    };
