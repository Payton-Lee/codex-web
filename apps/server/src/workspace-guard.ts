import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { ensureAppDatabaseSchema } from "./app-db.js";

type SqliteDatabase = {
  pragma(source: string): unknown;
  exec(source: string): unknown;
  prepare(source: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
};

type WorkspaceRow = {
  workspace_id: string;
  canonical_path: string;
  display_name: string;
  created_at: number;
  updated_at: number;
};

const APP_UUID_NAMESPACE = "a67a2671-6f78-4f2d-9447-1d030f62f33f";

function normalizeAllowedPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

function displayNameFromPath(workspacePath: string): string {
  return path.basename(workspacePath) || workspacePath;
}

export class WorkspaceGuard {
  private currentWorkspace: string | null = null;
  private readonly db: SqliteDatabase;

  constructor(
    private readonly allowedWorkspaces: string[],
    defaultWorkspace: string | null,
    dbPath: string
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    ensureAppDatabaseSchema(this.db);

    this.migrateLegacyWorkspaceState();

    const persistedCurrent = this.readCurrentWorkspaceFromState();
    if (persistedCurrent) {
      try {
        this.currentWorkspace = this.ensureAllowed(persistedCurrent);
      } catch {
        this.currentWorkspace = defaultWorkspace ? this.ensureAllowed(defaultWorkspace) : null;
      }
    } else {
      this.currentWorkspace = defaultWorkspace ? this.ensureAllowed(defaultWorkspace) : null;
    }

    if (this.currentWorkspace) {
      this.upsertWorkspace(this.currentWorkspace, "default");
      this.setCurrentWorkspaceId(this.workspaceIdForPath(this.currentWorkspace));
    }
  }

  list() {
    const allowedEntries = (this.db.prepare(
      "SELECT workspace_id, canonical_path, display_name, created_at, updated_at FROM workspaces ORDER BY updated_at DESC, created_at DESC"
    ).all() as WorkspaceRow[])
      .filter((row) => {
        try {
          this.ensureAllowed(row.canonical_path);
          return true;
        } catch {
          return false;
        }
      })
      .map((row) => ({ path: row.canonical_path, allowed: true }));

    return {
      current: this.currentWorkspace,
      allowed: allowedEntries
    };
  }

  getCurrentWorkspace(): string | null {
    return this.currentWorkspace;
  }

  ensureAllowed(workspacePath: string): string {
    const normalized = path.resolve(workspacePath);
    const matched = this.isWithinConfiguredRoots(normalized) || this.isRegisteredWorkspace(normalized);
    if (!matched) {
      throw new Error(`工作目录不在白名单中: ${normalized}`);
    }
    return normalized;
  }

  setCurrentWorkspace(workspacePath: string, sourceType = "manual_select"): string {
    const normalized =
      sourceType === "folder_picker"
        ? this.ensureDirectoryWorkspace(workspacePath)
        : this.ensureAllowed(workspacePath);
    const workspaceId = this.upsertWorkspace(normalized, sourceType);
    this.currentWorkspace = normalized;
    this.setCurrentWorkspaceId(workspaceId);
    return normalized;
  }

  addWorkspace(workspacePath: string, sourceType = "manual_input"): string {
    const normalized =
      sourceType === "folder_picker"
        ? this.ensureDirectoryWorkspace(workspacePath)
        : this.ensureAllowed(workspacePath);
    const workspaceId = this.upsertWorkspace(normalized, sourceType);
    if (!this.currentWorkspace) {
      this.currentWorkspace = normalized;
      this.setCurrentWorkspaceId(workspaceId);
    }
    return normalized;
  }

  private workspaceIdForPath(workspacePath: string): string {
    return stableUuid(`workspace:${normalizeAllowedPath(workspacePath)}`);
  }

  private isWithinConfiguredRoots(workspacePath: string): boolean {
    return this.allowedWorkspaces.some((allowed) => {
      const normalizedAllowed = path.resolve(allowed);
      return workspacePath === normalizedAllowed || workspacePath.startsWith(`${normalizedAllowed}${path.sep}`);
    });
  }

  private isRegisteredWorkspace(workspacePath: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS matched FROM workspaces WHERE canonical_path = ? LIMIT 1")
      .get(workspacePath) as { matched?: number } | undefined;
    return Boolean(row?.matched);
  }

  private ensureDirectoryWorkspace(workspacePath: string): string {
    const normalized = path.resolve(workspacePath);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(normalized);
    } catch {
      throw new Error(`工作目录不存在: ${normalized}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`选择的路径不是文件夹: ${normalized}`);
    }
    return normalized;
  }

  private upsertWorkspace(workspacePath: string, sourceType: string): string {
    const canonicalPath = path.resolve(workspacePath);
    const workspaceId = this.workspaceIdForPath(canonicalPath);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspaces(workspace_id, canonical_path, display_name, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET
             canonical_path = excluded.canonical_path,
             display_name = excluded.display_name,
             updated_at = excluded.updated_at`
        )
        .run(workspaceId, canonicalPath, displayNameFromPath(canonicalPath), now, now);

      this.db
        .prepare(
          `INSERT INTO workspace_selections(
             selection_id, workspace_id, source_type, selected_path, picker_label, created_at
           ) VALUES(?, ?, ?, ?, ?, ?)`
        )
        .run(
          stableUuid(`workspace-selection:${workspaceId}:${sourceType}:${now}`),
          workspaceId,
          sourceType,
          canonicalPath,
          null,
          now
        );
    });
    tx();
    return workspaceId;
  }

  private setCurrentWorkspaceId(workspaceId: string): void {
    this.db
      .prepare(
        `INSERT INTO workspace_state(state_id, current_workspace_id, updated_at)
         VALUES(1, ?, ?)
         ON CONFLICT(state_id) DO UPDATE SET
           current_workspace_id = excluded.current_workspace_id,
           updated_at = excluded.updated_at`
      )
      .run(workspaceId, Date.now());
  }

  private readCurrentWorkspaceFromState(): string | null {
    const row = this.db
      .prepare(
        `SELECT w.canonical_path
         FROM workspace_state ws
         LEFT JOIN workspaces w ON w.workspace_id = ws.current_workspace_id
         WHERE ws.state_id = 1`
      )
      .get() as { canonical_path?: string | null } | undefined;
    return row?.canonical_path ?? null;
  }

  private migrateLegacyWorkspaceState(): void {
    const existingCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM workspaces")
      .get() as { count: number };
    const stateRow = this.db
      .prepare("SELECT current_workspace_id FROM workspace_state WHERE state_id = 1")
      .get() as { current_workspace_id?: string | null } | undefined;

    if (existingCount.count > 0 && stateRow?.current_workspace_id) {
      return;
    }

    const legacyEntries = this.db.prepare(
      "SELECT path, created_at FROM workspace_entries ORDER BY created_at ASC"
    ).all() as Array<{ path: string; created_at: number }>;
    const legacyCurrent = this.db
      .prepare("SELECT value FROM workspace_meta WHERE key = 'current_workspace'")
      .get() as { value?: string | null } | undefined;

    const tx = this.db.transaction(() => {
      for (const entry of legacyEntries) {
        try {
          const normalized = this.ensureAllowed(entry.path);
          const workspaceId = this.workspaceIdForPath(normalized);
          this.db
            .prepare(
              `INSERT INTO workspaces(workspace_id, canonical_path, display_name, created_at, updated_at)
               VALUES(?, ?, ?, ?, ?)
               ON CONFLICT(workspace_id) DO UPDATE SET
                 canonical_path = excluded.canonical_path,
                 display_name = excluded.display_name,
                 updated_at = MAX(workspaces.updated_at, excluded.updated_at)`
            )
            .run(
              workspaceId,
              normalized,
              displayNameFromPath(normalized),
              entry.created_at,
              entry.created_at
            );
          this.db
            .prepare(
              `INSERT OR IGNORE INTO workspace_selections(
                 selection_id, workspace_id, source_type, selected_path, picker_label, created_at
               ) VALUES(?, ?, 'legacy_migration', ?, ?, ?)`
            )
            .run(
              stableUuid(`workspace-selection:${workspaceId}:legacy:${entry.created_at}`),
              workspaceId,
              normalized,
              "legacy workspace_entries",
              entry.created_at
            );
        } catch {
          continue;
        }
      }

      const currentPath = legacyCurrent?.value ? String(legacyCurrent.value) : null;
      if (currentPath) {
        try {
          const normalized = this.ensureAllowed(currentPath);
          const workspaceId = this.workspaceIdForPath(normalized);
          this.db
            .prepare(
              `INSERT INTO workspaces(workspace_id, canonical_path, display_name, created_at, updated_at)
               VALUES(?, ?, ?, ?, ?)
               ON CONFLICT(workspace_id) DO UPDATE SET
                 canonical_path = excluded.canonical_path,
                 display_name = excluded.display_name,
                 updated_at = excluded.updated_at`
            )
            .run(workspaceId, normalized, displayNameFromPath(normalized), Date.now(), Date.now());
          this.db
            .prepare(
              `INSERT INTO workspace_state(state_id, current_workspace_id, updated_at)
               VALUES(1, ?, ?)
               ON CONFLICT(state_id) DO UPDATE SET
                 current_workspace_id = excluded.current_workspace_id,
                 updated_at = excluded.updated_at`
            )
            .run(workspaceId, Date.now());
        } catch {
          return;
        }
      }
    });

    tx();
  }
}
