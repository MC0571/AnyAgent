import type { EngineEvidence } from "./types.js";

/** File facts belong to the Engine's native workspace; these product-facing shapes carry no native row IDs. */
export interface EngineFileChanges {
  readonly canRewind: boolean;
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
  readonly state?: "active" | "reverted";
  readonly items: {
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
    readonly writeCount: number;
    readonly toolNames: string[];
    readonly patches: {
      readonly oldStart: number;
      readonly oldLines: number;
      readonly newStart: number;
      readonly newLines: number;
      readonly lines: string[];
    }[];
  }[];
}

export interface EngineFileRewindPreview {
  readonly canApply: boolean;
  readonly safeFiles: {
    readonly action: "restore" | "delete";
    readonly operationCount: number;
    readonly path: string;
    readonly toolNames: string[];
  }[];
  readonly unsafeFiles: {
    readonly currentHash?: string;
    readonly expectedHash?: string;
    readonly message?: string;
    readonly operationCount: number;
    readonly path: string;
    readonly reason:
      | "checkpoint_missing"
      | "checkpoint_unreadable"
      | "external_modified"
      | "file_read_failed"
      | "unsupported_checkpoint";
    readonly toolNames: string[];
  }[];
  readonly ignoredFiles: {
    readonly operationCount: number;
    readonly path: string;
    readonly reason: "bash_ignored";
    readonly toolNames: string[];
  }[];
}

export interface EngineFileRewindReceipt {
  readonly status: "applied" | "rejected" | "unknown";
  readonly evidence?: EngineEvidence;
  readonly reason?: string;
}
