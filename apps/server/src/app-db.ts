type SqliteDatabase = {
  pragma(source: string): unknown;
  exec(source: string): unknown;
};

const APP_DB_SCHEMA_VERSION = "2";

export function ensureAppDatabaseSchema(db: SqliteDatabase): void {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_entries (
      path TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL,
      plan_type TEXT,
      requires_openai_auth INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_selections (
      selection_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      selected_path TEXT NOT NULL,
      picker_label TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_state (
      state_id INTEGER PRIMARY KEY CHECK (state_id = 1),
      current_workspace_id TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (current_workspace_id) REFERENCES workspaces(workspace_id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      name TEXT,
      source TEXT,
      status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      thread_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE SET NULL,
      UNIQUE (account_id, workspace_id, thread_id)
    );

    CREATE TABLE IF NOT EXISTS session_query_state (
      session_id TEXT PRIMARY KEY,
      query_key TEXT NOT NULL DEFAULT 'sid',
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_display_name
      ON workspaces(display_name);

    CREATE INDEX IF NOT EXISTS idx_workspace_selections_workspace
      ON workspace_selections(workspace_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_threads_workspace_updated
      ON threads(workspace_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_sessions_account_last_opened
      ON sessions(account_id, last_opened_at DESC);

    CREATE INDEX IF NOT EXISTS idx_sessions_workspace_last_opened
      ON sessions(workspace_id, last_opened_at DESC);

    CREATE INDEX IF NOT EXISTS idx_sessions_thread
      ON sessions(thread_id);
  `);

  db.exec(`
    INSERT INTO schema_meta(key, value, updated_at)
    VALUES('app_db_schema_version', '${APP_DB_SCHEMA_VERSION}', unixepoch() * 1000)
    ON CONFLICT(key) DO UPDATE
      SET value = excluded.value,
          updated_at = excluded.updated_at;
  `);
}
