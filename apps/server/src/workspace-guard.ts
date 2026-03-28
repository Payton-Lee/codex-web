import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

type WorkspaceMetaKey = "current_workspace";
type SqliteDatabase = {
  pragma(source: string): unknown;
  exec(source: string): unknown;
  prepare(source: string): {
    all(): unknown[];
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
};

export class WorkspaceGuard {
  private currentWorkspace: string | null;
  private readonly workspaceEntries = new Set<string>();
  private readonly db: SqliteDatabase;

  constructor(
    private readonly allowedWorkspaces: string[],
    defaultWorkspace: string | null,
    dbPath: string
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_entries (
        path TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    for (const workspace of allowedWorkspaces) {
      this.workspaceEntries.add(path.resolve(workspace));
    }

    this.loadPersistedEntries();

    const persistedCurrent = this.getMeta("current_workspace");
    if (persistedCurrent) {
      try {
        this.currentWorkspace = this.ensureAllowed(persistedCurrent);
        this.workspaceEntries.add(this.currentWorkspace);
      } catch {
        this.currentWorkspace = defaultWorkspace ? path.resolve(defaultWorkspace) : null;
      }
    } else {
      this.currentWorkspace = defaultWorkspace ? path.resolve(defaultWorkspace) : null;
    }

    if (this.currentWorkspace) {
      this.workspaceEntries.add(this.currentWorkspace);
      this.persistWorkspace(this.currentWorkspace);
      this.setMeta("current_workspace", this.currentWorkspace);
    }
  }

  list() {
    return {
      current: this.currentWorkspace,
      allowed: Array.from(this.workspaceEntries)
        .sort((a, b) => a.localeCompare(b))
        .map((entry) => ({ path: entry, allowed: true }))
    };
  }

  getCurrentWorkspace(): string | null {
    return this.currentWorkspace;
  }

  ensureAllowed(workspacePath: string): string {
    const normalized = path.resolve(workspacePath);
    const matched = this.allowedWorkspaces.some((allowed) => {
      const normalizedAllowed = path.resolve(allowed);
      return normalized === normalizedAllowed || normalized.startsWith(`${normalizedAllowed}${path.sep}`);
    });
    if (!matched) {
      throw new Error(`工作目录不在白名单中: ${normalized}`);
    }
    return normalized;
  }

  setCurrentWorkspace(workspacePath: string): string {
    const normalized = this.ensureAllowed(workspacePath);
    this.workspaceEntries.add(normalized);
    this.currentWorkspace = normalized;
    this.persistWorkspace(normalized);
    this.setMeta("current_workspace", normalized);
    return normalized;
  }

  addWorkspace(workspacePath: string): string {
    const normalized = this.ensureAllowed(workspacePath);
    this.workspaceEntries.add(normalized);
    this.persistWorkspace(normalized);
    if (!this.currentWorkspace) {
      this.currentWorkspace = normalized;
      this.setMeta("current_workspace", normalized);
    }
    return normalized;
  }

  private loadPersistedEntries(): void {
    const rows = this.db.prepare("SELECT path FROM workspace_entries ORDER BY created_at ASC").all() as Array<{
      path: string;
    }>;

    for (const row of rows) {
      try {
        this.workspaceEntries.add(this.ensureAllowed(row.path));
      } catch {
        this.db.prepare("DELETE FROM workspace_entries WHERE path = ?").run(row.path);
      }
    }
  }

  private persistWorkspace(workspacePath: string): void {
    this.db
      .prepare(
        "INSERT INTO workspace_entries(path, created_at) VALUES(?, ?) ON CONFLICT(path) DO NOTHING"
      )
      .run(workspacePath, Date.now());
  }

  private getMeta(key: WorkspaceMetaKey): string | null {
    const row = this.db
      .prepare("SELECT value FROM workspace_meta WHERE key = ?")
      .get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: WorkspaceMetaKey, value: string): void {
    this.db
      .prepare(
        "INSERT INTO workspace_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value);
  }
}
