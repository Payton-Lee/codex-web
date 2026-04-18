import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { AccountSummary, SessionSummary, ThreadSummary } from "../../../packages/shared/src/index.js";
import { ensureAppDatabaseSchema } from "./app-db.js";

const APP_UUID_NAMESPACE = "a67a2671-6f78-4f2d-9447-1d030f62f33f";

type SqliteDatabase = {
  prepare(source: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
};

type SessionRow = {
  session_id: string;
  account_id: string;
  account_email: string;
  workspace_id: string;
  workspace_path: string;
  workspace_display_name: string;
  thread_id: string | null;
  created_at: number;
  updated_at: number;
  last_opened_at: number;
  archived: number;
  query_key: string | null;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizePathValue(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function displayNameFromPath(workspacePath: string): string {
  return path.basename(workspacePath) || workspacePath;
}

function uuidToBytes(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, ""), "hex");
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join("-");
}

function stableUuid(name: string): string {
  const hash = createHash("sha1").update(uuidToBytes(APP_UUID_NAMESPACE)).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return bytesToUuid(hash.subarray(0, 16));
}

function mapSessionRow(row: SessionRow | undefined): SessionSummary | null {
  if (!row) {
    return null;
  }
  return {
    sessionId: row.session_id,
    queryKey: row.query_key ?? "sid",
    accountId: row.account_id,
    accountEmail: row.account_email,
    workspaceId: row.workspace_id,
    workspacePath: row.workspace_path,
    workspaceDisplayName: row.workspace_display_name,
    threadId: row.thread_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    archived: Boolean(row.archived)
  };
}

export class SessionStore {
  private readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    ensureAppDatabaseSchema(this.db as never);
  }

  close(): void {
    this.db.close();
  }

  upsertAccount(account: AccountSummary): string | null {
    if (!account.loggedIn || !account.email) {
      return null;
    }
    const email = normalizeEmail(account.email);
    const accountId = stableUuid(`account:${email}`);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO accounts(
          account_id, email, mode, plan_type, requires_openai_auth, created_at, updated_at, last_seen_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          email = excluded.email,
          mode = excluded.mode,
          plan_type = excluded.plan_type,
          requires_openai_auth = excluded.requires_openai_auth,
          updated_at = excluded.updated_at,
          last_seen_at = excluded.last_seen_at`
      )
      .run(
        accountId,
        email,
        account.mode,
        account.planType ?? null,
        account.requiresOpenaiAuth ? 1 : 0,
        now,
        now,
        now
      );
    return accountId;
  }

  upsertWorkspace(workspacePath: string): string {
    const canonicalPath = path.resolve(workspacePath);
    const workspaceId = stableUuid(`workspace:${normalizePathValue(workspacePath)}`);
    const displayName = displayNameFromPath(canonicalPath);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspaces(workspace_id, canonical_path, display_name, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           canonical_path = excluded.canonical_path,
           display_name = excluded.display_name,
           updated_at = excluded.updated_at`
      )
      .run(workspaceId, canonicalPath, displayName, now, now);
    return workspaceId;
  }

  recordWorkspaceSelection(workspacePath: string, sourceType: string, pickerLabel?: string | null): string {
    const workspaceId = this.upsertWorkspace(workspacePath);
    const selectionId = stableUuid(
      `workspace-selection:${workspaceId}:${sourceType}:${pickerLabel ?? ""}:${Date.now()}`
    );
    this.db
      .prepare(
        `INSERT INTO workspace_selections(
          selection_id, workspace_id, source_type, selected_path, picker_label, created_at
        ) VALUES(?, ?, ?, ?, ?, ?)`
      )
      .run(selectionId, workspaceId, sourceType, path.resolve(workspacePath), pickerLabel ?? null, Date.now());
    return workspaceId;
  }

  upsertThread(thread: ThreadSummary): void {
    const workspaceId = this.upsertWorkspace(thread.cwd);
    this.db
      .prepare(
        `INSERT INTO threads(
          thread_id, workspace_id, cwd, name, source, status, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          cwd = excluded.cwd,
          name = excluded.name,
          source = excluded.source,
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at`
      )
      .run(
        thread.id,
        workspaceId,
        path.resolve(thread.cwd),
        thread.name ?? null,
        thread.source,
        thread.status,
        thread.createdAt,
        thread.updatedAt
      );
  }

  syncThreads(threads: ThreadSummary[]): void {
    const tx = this.db.transaction((rows: ThreadSummary[]) => {
      for (const row of rows) {
        this.upsertThread(row);
      }
    });
    tx(threads);
  }

  resolveSession(params: {
    account: AccountSummary;
    workspacePath: string;
    threadId?: string | null;
    threadSummary?: ThreadSummary | null;
  }): SessionSummary | null {
    const accountId = this.upsertAccount(params.account);
    if (!accountId) {
      return null;
    }
    const workspaceId = this.upsertWorkspace(params.workspacePath);
    if (params.threadSummary) {
      this.upsertThread(params.threadSummary);
    }
    const threadId = params.threadSummary?.id ?? params.threadId ?? null;
    const sessionId = stableUuid(`session:${accountId}:${workspaceId}:${threadId ?? ""}`);
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO sessions(
          session_id, account_id, workspace_id, thread_id, created_at, updated_at, last_opened_at, archived
        ) VALUES(?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(session_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          updated_at = excluded.updated_at,
          last_opened_at = excluded.last_opened_at,
          archived = 0`
      )
      .run(sessionId, accountId, workspaceId, threadId, now, now, now);

    this.db
      .prepare(
        `INSERT INTO session_query_state(session_id, query_key, updated_at)
         VALUES(?, 'sid', ?)
         ON CONFLICT(session_id) DO UPDATE SET
           query_key = excluded.query_key,
           updated_at = excluded.updated_at`
      )
      .run(sessionId, now);

    return this.getSession(sessionId);
  }

  getSession(sessionId: string): SessionSummary | null {
    return mapSessionRow(
      this.db
        .prepare(
          `SELECT
             s.session_id,
             s.account_id,
             a.email AS account_email,
             s.workspace_id,
             w.canonical_path AS workspace_path,
             w.display_name AS workspace_display_name,
             s.thread_id,
             s.created_at,
             s.updated_at,
             s.last_opened_at,
             s.archived,
             sqs.query_key
           FROM sessions s
           INNER JOIN accounts a ON a.account_id = s.account_id
           INNER JOIN workspaces w ON w.workspace_id = s.workspace_id
           LEFT JOIN session_query_state sqs ON sqs.session_id = s.session_id
           WHERE s.session_id = ?`
        )
        .get(sessionId) as SessionRow | undefined
    );
  }
}
