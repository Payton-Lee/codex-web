type SqliteDatabase = {
  pragma(source: string): unknown;
  exec(source: string): unknown;
};

const APP_DB_SCHEMA_VERSION = "3";

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

    CREATE TABLE IF NOT EXISTS codex_source_threads (
      thread_id TEXT PRIMARY KEY,
      state_db_path TEXT NOT NULL,
      rollout_path TEXT,
      cwd TEXT NOT NULL,
      title TEXT,
      source TEXT,
      model_provider TEXT,
      cli_version TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      first_user_message TEXT,
      memory_mode TEXT,
      synced_at_ms INTEGER NOT NULL,
      raw_summary_json TEXT
    );

    CREATE TABLE IF NOT EXISTS codex_thread_ingest (
      thread_id TEXT PRIMARY KEY,
      rollout_path TEXT,
      rollout_size_bytes INTEGER,
      rollout_mtime_ms INTEGER,
      parser_version TEXT NOT NULL,
      status TEXT NOT NULL,
      last_error TEXT,
      last_ingested_at_ms INTEGER NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES codex_source_threads(thread_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS codex_thread_turns (
      turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_text TEXT,
      cwd TEXT,
      model TEXT,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      duration_ms INTEGER,
      context_json TEXT,
      FOREIGN KEY (thread_id) REFERENCES codex_source_threads(thread_id) ON DELETE CASCADE,
      UNIQUE (thread_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS codex_thread_items (
      item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      ordinal_in_turn INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      role TEXT,
      phase TEXT,
      status TEXT,
      text_value TEXT,
      aggregated_output TEXT,
      command_text TEXT,
      cwd TEXT,
      tool_name TEXT,
      server_name TEXT,
      call_id TEXT,
      exit_code INTEGER,
      created_at_ms INTEGER,
      raw_payload_json TEXT,
      FOREIGN KEY (thread_id) REFERENCES codex_source_threads(thread_id) ON DELETE CASCADE,
      FOREIGN KEY (turn_id) REFERENCES codex_thread_turns(turn_id) ON DELETE CASCADE,
      UNIQUE (thread_id, turn_id, ordinal_in_turn)
    );

    CREATE TABLE IF NOT EXISTS codex_thread_item_changes (
      change_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      path TEXT NOT NULL,
      change_kind TEXT NOT NULL,
      move_path TEXT,
      diff_text TEXT,
      FOREIGN KEY (item_id) REFERENCES codex_thread_items(item_id) ON DELETE CASCADE,
      UNIQUE (item_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_codex_source_threads_updated
      ON codex_source_threads(updated_at_ms DESC);

    CREATE INDEX IF NOT EXISTS idx_codex_source_threads_archived_updated
      ON codex_source_threads(archived, updated_at_ms DESC);

    CREATE INDEX IF NOT EXISTS idx_codex_thread_turns_thread_ordinal
      ON codex_thread_turns(thread_id, ordinal);

    CREATE INDEX IF NOT EXISTS idx_codex_thread_items_thread_turn_ordinal
      ON codex_thread_items(thread_id, turn_id, ordinal_in_turn);

    CREATE INDEX IF NOT EXISTS idx_codex_thread_items_call_id
      ON codex_thread_items(call_id);

    CREATE INDEX IF NOT EXISTS idx_codex_thread_item_changes_item_ordinal
      ON codex_thread_item_changes(item_id, ordinal);
  `);

  db.exec(`
    INSERT INTO schema_meta(key, value, updated_at)
    VALUES('app_db_schema_version', '${APP_DB_SCHEMA_VERSION}', unixepoch() * 1000)
    ON CONFLICT(key) DO UPDATE
      SET value = excluded.value,
          updated_at = excluded.updated_at;
  `);
}
