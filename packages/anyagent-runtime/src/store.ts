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

export interface StoredHostAuthorization {
  readonly id: string;
  readonly environmentId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly revokeReason: string | null;
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
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_input_idempotency_key
        ON runtime_records(task_id, native_key)
        WHERE kind = 'input' AND native_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_authorizations (
        id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        revoke_reason TEXT
      );
    `);
  }

  backfillHostAuthorizationsOnce(): void {
    const migrationKey = "host_authorization_backfill_v1";
    if (this.getMeta(migrationKey) === "complete") return;
    this.transaction(() => {
      if (this.getMeta(migrationKey) === "complete") return;
      const rows = this.#db
        .prepare(
          "SELECT id, data FROM runtime_records WHERE kind = 'task' ORDER BY created_at, rowid",
        )
        .all() as { id: string; data: string }[];
      for (const row of rows) {
        const task = JSON.parse(row.data) as {
          authorization?: {
            id?: unknown;
            environmentId?: unknown;
            scopes?: unknown;
            expiresAt?: unknown;
            issuer?: unknown;
          };
        };
        const grant = task.authorization;
        if (
          !grant ||
          typeof grant.id !== "string" ||
          typeof grant.environmentId !== "string" ||
          !Array.isArray(grant.scopes) ||
          !grant.scopes.every((scope) => typeof scope === "string") ||
          (grant.expiresAt !== null && typeof grant.expiresAt !== "number") ||
          grant.issuer !== "host"
        )
          throw new Error(`Cannot backfill Host authorization from legacy Task ${row.id}.`);
        this.registerHostAuthorization({
          id: grant.id,
          environmentId: grant.environmentId,
          scopes: grant.scopes,
          expiresAt: grant.expiresAt,
        });
      }
      this.setMeta(migrationKey, "complete");
    });
  }

  registerHostAuthorization(
    grant: Pick<StoredHostAuthorization, "id" | "environmentId" | "scopes" | "expiresAt">,
  ): StoredHostAuthorization {
    const scopes = [...grant.scopes].sort();
    this.#db
      .prepare(`
        INSERT INTO runtime_authorizations(id, environment_id, scopes, expires_at, revoked_at, revoke_reason)
        VALUES (?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(id) DO NOTHING
      `)
      .run(grant.id, grant.environmentId, JSON.stringify(scopes), grant.expiresAt);
    const current = this.getHostAuthorization(grant.id);
    if (
      !current ||
      current.environmentId !== grant.environmentId ||
      current.expiresAt !== grant.expiresAt ||
      JSON.stringify([...current.scopes].sort()) !== JSON.stringify(scopes)
    )
      throw new Error(`Host authorization ${grant.id} conflicts with its persistent authority.`);
    return current;
  }

  getHostAuthorization(id: string): StoredHostAuthorization | null {
    const row = this.#db.prepare("SELECT * FROM runtime_authorizations WHERE id = ?").get(id) as
      | RawHostAuthorization
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      environmentId: row.environment_id,
      scopes: JSON.parse(row.scopes) as string[],
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      revokeReason: row.revoke_reason,
    };
  }

  hasTaskAuthorization(id: string): boolean {
    const rows = this.#db.prepare("SELECT data FROM runtime_records WHERE kind = 'task'").all() as {
      data: string;
    }[];
    return rows.some((row) => {
      const task = JSON.parse(row.data) as {
        authorization?: { id?: unknown };
      };
      return task.authorization?.id === id;
    });
  }

  revokeHostAuthorization(
    id: string,
    revokedAt: number,
    reason: string,
  ): StoredHostAuthorization | null {
    this.#db
      .prepare(`
        UPDATE runtime_authorizations
        SET revoked_at = ?, revoke_reason = ?
        WHERE id = ? AND revoked_at IS NULL
      `)
      .run(revokedAt, reason, id);
    return this.getHostAuthorization(id);
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

interface RawHostAuthorization {
  id: string;
  environment_id: string;
  scopes: string;
  expires_at: number | null;
  revoked_at: number | null;
  revoke_reason: string | null;
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
