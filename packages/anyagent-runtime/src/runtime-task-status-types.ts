export type RuntimeTaskStatus =
  | "active"
  | "frozen"
  | "completed"
  | "failed"
  | "stopped"
  | "abandoned";

export type RuntimeSessionStatus = "creating" | "active" | "unknown" | "failed" | "closed";

export type RuntimeInputStatus =
  | "queued"
  | "received"
  | "native-accepted"
  | "started"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown"
  | "rejected"
  | "cancelled";

export type RuntimeExecutionStatus =
  | "accepted"
  | "started"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";
