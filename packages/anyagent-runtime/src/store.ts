import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Desktop tsup rewrites static node:sqlite imports to the nonexistent bare "sqlite" package.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

export interface StoredRecord<T = unknown> {
  readonly kind: string;
  readonly id: string;
  readonly taskId: string;
  readonly sessionId: string | null;
  readonly inputId: string | null;
  readonly executionId: string | null;
  readonly nativeKey: string | null;
  readonly status: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly data: T;
}

export class RuntimeStore {
  readonly #db: DatabaseSyncType;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runtime_records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        session_id TEXT,
        input_id TEXT,
        execution_id TEXT,
        native_key TEXT,
        status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE INDEX IF NOT EXISTS runtime_records_task_kind ON runtime_records(task_id, kind, created_at, id);
      CREATE INDEX IF NOT EXISTS runtime_records_session_kind ON runtime_records(session_id, kind, created_at, id);
      CREATE INDEX IF NOT EXISTS runtime_records_native_key ON runtime_records(session_id, kind, native_key);
      CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  get<T = unknown>(kind: string, id: string): StoredRecord<T> | null {
    const row = this.#db
      .prepare("SELECT * FROM runtime_records WHERE kind = ? AND id = ?")
      .get(kind, id);
    return row ? decode<T>(row) : null;
  }

  list<T = unknown>(kind: string, taskId?: string): StoredRecord<T>[] {
    const rows =
      taskId === undefined
        ? this.#db
            .prepare("SELECT * FROM runtime_records WHERE kind = ? ORDER BY created_at, rowid")
            .all(kind)
        : this.#db
            .prepare(
              "SELECT * FROM runtime_records WHERE kind = ? AND task_id = ? ORDER BY created_at, rowid",
            )
            .all(kind, taskId);
    return rows.map((row) => decode<T>(row));
  }

  listInSession<T = unknown>(kind: string, sessionId: string): StoredRecord<T>[] {
    return this.#db
      .prepare(
        "SELECT * FROM runtime_records WHERE kind = ? AND session_id = ? ORDER BY created_at, rowid",
      )
      .all(kind, sessionId)
      .map((row) => decode<T>(row));
  }

  findByNativeKey<T = unknown>(
    kind: string,
    sessionId: string,
    nativeKey: string,
  ): StoredRecord<T> | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM runtime_records WHERE kind = ? AND session_id = ? AND native_key = ? ORDER BY created_at, id LIMIT 1",
      )
      .get(kind, sessionId, nativeKey);
    return row ? decode<T>(row) : null;
  }

  findBySequence<T = unknown>(
    sessionId: string,
    streamId: string,
    source: string,
    sequence: number,
  ): StoredRecord<T> | null {
    const rows = this.listInSession<T>("event", sessionId);
    return (
      rows.find((row) => {
        const data = row.data as Record<string, unknown>;
        return (
          data.streamId === streamId && data.source === source && data.sourceSequence === sequence
        );
      }) ?? null
    );
  }

  insert(record: StoredRecord): void {
    this.#db
      .prepare(`
      INSERT INTO runtime_records(kind, id, task_id, session_id, input_id, execution_id, native_key, status, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        record.kind,
        record.id,
        record.taskId,
        record.sessionId,
        record.inputId,
        record.executionId,
        record.nativeKey,
        record.status,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record.data),
      );
  }

  update(record: StoredRecord): void {
    const result = this.#db
      .prepare(`
      UPDATE runtime_records
      SET task_id = ?, session_id = ?, input_id = ?, execution_id = ?, native_key = ?, status = ?, updated_at = ?, data = ?
      WHERE kind = ? AND id = ?
    `)
      .run(
        record.taskId,
        record.sessionId,
        record.inputId,
        record.executionId,
        record.nativeKey,
        record.status,
        record.updatedAt,
        JSON.stringify(record.data),
        record.kind,
        record.id,
      );
    if (Number(result.changes) !== 1)
      throw new Error(`Cannot update missing ${record.kind} ${record.id}.`);
  }

  transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM runtime_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO runtime_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRecord {
  kind: string;
  id: string;
  task_id: string;
  session_id: string | null;
  input_id: string | null;
  execution_id: string | null;
  native_key: string | null;
  status: string | null;
  created_at: number;
  updated_at: number;
  data: string;
}

function decode<T>(value: unknown): StoredRecord<T> {
  const row = value as RawRecord;
  return {
    kind: row.kind,
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    inputId: row.input_id,
    executionId: row.execution_id,
    nativeKey: row.native_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    data: JSON.parse(row.data) as T,
  };
}
