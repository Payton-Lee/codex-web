import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  FileChangeEntry,
  ThreadDetail,
  ThreadHistoryPage,
  ThreadSummary,
  TurnSummary
} from "../../../packages/shared/src/index.js";
import { ensureAppDatabaseSchema } from "./app-db.js";

const ROLLOUT_PARSER_VERSION = "1";

type SqliteDatabase = {
  prepare(source: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
};

type SourceThreadRecord = {
  thread_id: string;
  state_db_path: string;
  rollout_path: string | null;
  cwd: string;
  title: string | null;
  source: string | null;
  model_provider: string | null;
  cli_version: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  archived: number;
  first_user_message: string | null;
  memory_mode: string | null;
};

type StateThreadRow = {
  id: string;
  rollout_path: string | null;
  cwd: string | null;
  title: string | null;
  source: string | null;
  model_provider: string | null;
  cli_version: string | null;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  archived: number | null;
  first_user_message: string | null;
  memory_mode: string | null;
};

type IngestRow = {
  thread_id: string;
  rollout_path: string | null;
  rollout_size_bytes: number | null;
  rollout_mtime_ms: number | null;
  parser_version: string;
  status: string;
};

type CachedTurnRow = {
  turn_id: string;
  ordinal: number;
  status: string;
  error_text: string | null;
};

type CachedItemRow = {
  item_id: string;
  turn_id: string;
  ordinal_in_turn: number;
  item_type: string;
  phase: string | null;
  status: string | null;
  text_value: string | null;
  aggregated_output: string | null;
  command_text: string | null;
  cwd: string | null;
  tool_name: string | null;
  server_name: string | null;
  raw_payload_json: string | null;
};

type CachedChangeRow = {
  item_id: string;
  ordinal: number;
  path: string;
  change_kind: string;
  move_path: string | null;
  diff_text: string | null;
};

type ParsedTurn = {
  turnId: string;
  ordinal: number;
  status: string;
  errorText: string | null;
  cwd: string | null;
  model: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  durationMs: number | null;
  contextJson: string | null;
};

type ParsedItem = {
  itemId: string;
  threadId: string;
  turnId: string;
  ordinalInTurn: number;
  itemType: string;
  role: string | null;
  phase: string | null;
  status: string | null;
  textValue: string | null;
  aggregatedOutput: string | null;
  commandText: string | null;
  cwd: string | null;
  toolName: string | null;
  serverName: string | null;
  callId: string | null;
  exitCode: number | null;
  createdAtMs: number | null;
  rawPayloadJson: string | null;
};

type ParsedItemChange = {
  changeId: string;
  itemId: string;
  ordinal: number;
  path: string;
  changeKind: string;
  movePath: string | null;
  diffText: string | null;
};

type ParsedThread = {
  turns: ParsedTurn[];
  items: ParsedItem[];
  changes: ParsedItemChange[];
  ingestStatus: string;
  ingestError: string | null;
};

type MutableTurn = ParsedTurn & {
  nextItemOrdinal: number;
};

type PendingCall = {
  turnId: string | null;
  name: string;
  argumentsText: string | null;
  createdAtMs: number | null;
};

function normalizeCodexPath(candidate: string | null | undefined): string | null {
  if (!candidate || typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  const withoutWin32Namespace =
    process.platform === "win32" && trimmed.startsWith("\\\\?\\") ? trimmed.slice(4) : trimmed;
  try {
    return path.resolve(withoutWin32Namespace);
  } catch {
    return withoutWin32Namespace;
  }
}

function toMillis(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toOptionalMillis(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeJsonStringify(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractTextFromMessageContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const candidate = entry as { text?: unknown };
      return typeof candidate.text === "string" ? candidate.text : "";
    })
    .join("")
    .trim();
}

function extractTextFromContentItems(contentItems: unknown): string {
  if (!Array.isArray(contentItems)) {
    return "";
  }
  return contentItems
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const candidate = entry as { text?: unknown };
      return typeof candidate.text === "string" ? candidate.text : "";
    })
    .join("\n")
    .trim();
}

function extractReasoningText(payload: Record<string, unknown>): string {
  const summary = Array.isArray(payload.summary)
    ? payload.summary
        .map((entry) => {
          if (typeof entry === "string") {
            return entry;
          }
          if (!entry || typeof entry !== "object") {
            return "";
          }
          const candidate = entry as { text?: unknown; summary?: unknown };
          if (typeof candidate.text === "string") {
            return candidate.text;
          }
          return typeof candidate.summary === "string" ? candidate.summary : "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
  if (summary.trim()) {
    return summary.trim();
  }

  const content = payload.content;
  if (Array.isArray(content)) {
    const text = extractTextFromMessageContent(content);
    if (text) {
      return text;
    }
  }
  return "";
}

function shouldIgnoreUserMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed.startsWith("<environment_context>") || trimmed.startsWith("<app-context>");
}

function normalizeChangeKind(change: Record<string, unknown>): { kind: string; movePath: string | null } {
  const type = typeof change.type === "string" ? change.type : "unknown";
  const movePath = typeof change.move_path === "string" && change.move_path.trim() ? change.move_path : null;
  return {
    kind: type,
    movePath
  };
}

function mapChangeRows(rows: CachedChangeRow[]): FileChangeEntry[] {
  return rows.map((row) => ({
    path: row.path,
    kind: row.move_path ? `${row.change_kind} -> ${row.move_path}` : row.change_kind,
    diff: row.diff_text ?? ""
  }));
}

function joinCommand(parts: unknown): string | null {
  if (Array.isArray(parts)) {
    return parts.map((part) => String(part)).join(" ").trim() || null;
  }
  if (typeof parts === "string") {
    return parts.trim() || null;
  }
  return null;
}

function parseShellCommandFromArguments(argumentsText: string | null | undefined): string | null {
  if (!argumentsText) {
    return null;
  }
  try {
    const parsed = JSON.parse(argumentsText) as { command?: unknown };
    if (typeof parsed.command === "string") {
      return parsed.command.trim() || null;
    }
    if (Array.isArray(parsed.command)) {
      return parsed.command.map((entry) => String(entry)).join(" ").trim() || null;
    }
    return argumentsText;
  } catch {
    return argumentsText;
  }
}

function threadPreview(record: SourceThreadRecord): string {
  const firstLine = record.title?.trim() || record.first_user_message?.trim() || "";
  if (firstLine) {
    return firstLine;
  }
  return record.thread_id;
}

function toThreadSummary(record: SourceThreadRecord, status: ThreadSummary["status"]): ThreadSummary {
  return {
    id: record.thread_id,
    name: record.title,
    preview: threadPreview(record),
    cwd: normalizeCodexPath(record.cwd) ?? record.cwd,
    createdAt: record.created_at_ms,
    updatedAt: record.updated_at_ms,
    modelProvider: record.model_provider ?? "unknown",
    cliVersion: record.cli_version ?? "unknown",
    source: record.source ?? "unknown",
    status
  };
}

export class CodexThreadStore {
  private readonly db: SqliteDatabase;
  private readonly codexHomeDir: string;

  constructor(appDbPath: string, codexHomeDir: string) {
    this.codexHomeDir = codexHomeDir;
    fs.mkdirSync(path.dirname(appDbPath), { recursive: true });
    this.db = new Database(appDbPath);
    ensureAppDatabaseSchema(this.db as never);
  }

  close(): void {
    this.db.close();
  }

  listThreads(turnStatuses: ReadonlyMap<string, ThreadSummary["status"]>, limit = 200): ThreadSummary[] {
    const sourceThreads = this.syncThreadIndex(limit);
    return sourceThreads.map((record) =>
      toThreadSummary(record, turnStatuses.get(record.thread_id) ?? "idle")
    );
  }

  readThreadDetail(
    threadId: string,
    fallbackStatus: ThreadSummary["status"] = "idle"
  ): ThreadDetail | null {
    const source = this.getOrSyncSourceThread(threadId);
    if (!source) {
      return null;
    }

    this.ensureThreadIngested(source);

    const turns = this.db
      .prepare(
        `SELECT turn_id, ordinal, status, error_text
         FROM codex_thread_turns
         WHERE thread_id = ?
         ORDER BY ordinal ASC`
      )
      .all(threadId) as CachedTurnRow[];
    const items = this.db
      .prepare(
        `SELECT i.item_id, i.turn_id, i.ordinal_in_turn, i.item_type, i.phase, i.status, i.text_value, i.aggregated_output,
                i.command_text, i.cwd, i.tool_name, i.server_name, i.raw_payload_json, t.ordinal AS turn_ordinal
         FROM codex_thread_items i
         INNER JOIN codex_thread_turns t ON t.turn_id = i.turn_id
         WHERE i.thread_id = ?
         ORDER BY t.ordinal ASC, i.ordinal_in_turn ASC`
      )
      .all(threadId) as Array<CachedItemRow & { turn_ordinal: number }>;
    const changes = this.db
      .prepare(
        `SELECT item_id, ordinal, path, change_kind, move_path, diff_text
         FROM codex_thread_item_changes
         WHERE item_id IN (
           SELECT item_id FROM codex_thread_items WHERE thread_id = ?
         )
         ORDER BY item_id ASC, ordinal ASC`
      )
      .all(threadId) as CachedChangeRow[];

    const changeMap = new Map<string, FileChangeEntry[]>();
    for (const [itemId, groupedRows] of groupBy(changes, (row) => row.item_id).entries()) {
      changeMap.set(itemId, mapChangeRows(groupedRows));
    }

    const itemsByTurn = new Map<string, TurnSummary["items"]>();
    for (const row of items) {
      const turnItems = itemsByTurn.get(row.turn_id) ?? [];
      const rawPayload = safeJsonParse(row.raw_payload_json) as Record<string, unknown> | null;
      turnItems.push({
        id: row.item_id,
        type: row.item_type,
        text: row.text_value ?? undefined,
        command: row.command_text ?? undefined,
        cwd: row.cwd ?? undefined,
        aggregatedOutput: row.aggregated_output,
        status: row.status ?? undefined,
        changes: changeMap.get(row.item_id) ?? [],
        tool: row.tool_name ?? undefined,
        server: row.server_name ?? undefined,
        result: rawPayload?.output ?? rawPayload?.content_items ?? undefined,
        error: rawPayload?.error ?? undefined
      } as TurnSummary["items"][number]);
      itemsByTurn.set(row.turn_id, turnItems);
    }

    return {
      ...toThreadSummary(source, fallbackStatus),
      turns: turns.map((turn) => ({
        id: turn.turn_id,
        status: turn.status,
        error: turn.error_text,
        items: itemsByTurn.get(turn.turn_id) ?? []
      }))
    };
  }

  readThreadHistoryPage(
    threadId: string,
    options?: {
      beforeTurnId?: string | null;
      limit?: number;
    }
  ): ThreadHistoryPage | null {
    const source = this.getOrSyncSourceThread(threadId);
    if (!source) {
      return null;
    }

    this.ensureThreadIngested(source);

    const allTurns = this.db
      .prepare(
        `SELECT turn_id, ordinal, status, error_text
         FROM codex_thread_turns
         WHERE thread_id = ?
         ORDER BY ordinal DESC`
      )
      .all(threadId) as CachedTurnRow[];
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
    const beforeTurnId = options?.beforeTurnId?.trim() || null;
    const startIndex = beforeTurnId
      ? Math.max(
          allTurns.findIndex((turn) => turn.turn_id === beforeTurnId) + 1,
          0
        )
      : 0;
    const pageTurns = allTurns.slice(startIndex, startIndex + limit);
    const nextBeforeTurnId = allTurns[startIndex + limit]?.turn_id ?? null;
    if (pageTurns.length === 0) {
      return {
        threadId,
        turns: [],
        hasMore: false,
        nextBeforeTurnId: null
      };
    }

    const turnIdSet = new Set(pageTurns.map((turn) => turn.turn_id));
    const items = this.db
      .prepare(
        `SELECT i.item_id, i.turn_id, i.ordinal_in_turn, i.item_type, i.phase, i.status, i.text_value, i.aggregated_output,
                i.command_text, i.cwd, i.tool_name, i.server_name, i.raw_payload_json, t.ordinal AS turn_ordinal
         FROM codex_thread_items i
         INNER JOIN codex_thread_turns t ON t.turn_id = i.turn_id
         WHERE i.thread_id = ?
         ORDER BY t.ordinal DESC, i.ordinal_in_turn ASC`
      )
      .all(threadId) as Array<CachedItemRow & { turn_ordinal: number }>;
    const filteredItems = items.filter((row) => turnIdSet.has(row.turn_id));
    const itemIds = filteredItems.map((row) => row.item_id);
    const changes = itemIds.length
      ? (this.db
          .prepare(
            `SELECT item_id, ordinal, path, change_kind, move_path, diff_text
             FROM codex_thread_item_changes
             WHERE item_id IN (${itemIds.map(() => "?").join(",")})
             ORDER BY item_id ASC, ordinal ASC`
          )
          .all(...itemIds) as CachedChangeRow[])
      : [];

    const changeMap = new Map<string, FileChangeEntry[]>();
    for (const [itemId, groupedRows] of groupBy(changes, (row) => row.item_id).entries()) {
      changeMap.set(itemId, mapChangeRows(groupedRows));
    }

    const itemsByTurn = new Map<string, TurnSummary["items"]>();
    for (const row of filteredItems) {
      const turnItems = itemsByTurn.get(row.turn_id) ?? [];
      const rawPayload = safeJsonParse(row.raw_payload_json) as Record<string, unknown> | null;
      turnItems.push({
        id: row.item_id,
        type: row.item_type,
        text: row.text_value ?? undefined,
        command: row.command_text ?? undefined,
        cwd: row.cwd ?? undefined,
        aggregatedOutput: row.aggregated_output,
        status: row.status ?? undefined,
        changes: changeMap.get(row.item_id) ?? [],
        tool: row.tool_name ?? undefined,
        server: row.server_name ?? undefined,
        result: rawPayload?.output ?? rawPayload?.content_items ?? undefined,
        error: rawPayload?.error ?? undefined
      });
      itemsByTurn.set(row.turn_id, turnItems);
    }

    return {
      threadId,
      turns: pageTurns.map((turn) => ({
        id: turn.turn_id,
        status: turn.status,
        error: turn.error_text,
        items: itemsByTurn.get(turn.turn_id) ?? []
      })),
      hasMore: startIndex + limit < allTurns.length,
      nextBeforeTurnId
    };
  }

  private syncThreadIndex(limit: number): SourceThreadRecord[] {
    const stateDbPath = this.findLatestStateDbPath();
    if (!stateDbPath) {
      return this.readCachedSourceThreads(limit);
    }

    const stateDb = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = stateDb
        .prepare(
          `SELECT id, rollout_path, cwd, title, source, model_provider, cli_version,
                  created_at_ms, updated_at_ms, archived, first_user_message, memory_mode
           FROM threads
           WHERE archived = 0
           ORDER BY updated_at_ms DESC
           LIMIT ?`
        )
        .all(limit) as StateThreadRow[];
      const now = Date.now();
      const tx = this.db.transaction((records: StateThreadRow[]) => {
        const upsert = this.db.prepare(
          `INSERT INTO codex_source_threads(
             thread_id, state_db_path, rollout_path, cwd, title, source, model_provider, cli_version,
             created_at_ms, updated_at_ms, archived, first_user_message, memory_mode, synced_at_ms, raw_summary_json
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             state_db_path = excluded.state_db_path,
             rollout_path = excluded.rollout_path,
             cwd = excluded.cwd,
             title = excluded.title,
             source = excluded.source,
             model_provider = excluded.model_provider,
             cli_version = excluded.cli_version,
             created_at_ms = excluded.created_at_ms,
             updated_at_ms = excluded.updated_at_ms,
             archived = excluded.archived,
             first_user_message = excluded.first_user_message,
             memory_mode = excluded.memory_mode,
             synced_at_ms = excluded.synced_at_ms,
             raw_summary_json = excluded.raw_summary_json`
        );

        for (const row of records) {
          upsert.run(
            row.id,
            stateDbPath,
            row.rollout_path ?? null,
            normalizeCodexPath(row.cwd) ?? "",
            row.title ?? null,
            row.source ?? null,
            row.model_provider ?? null,
            row.cli_version ?? null,
            toMillis(row.created_at_ms),
            toMillis(row.updated_at_ms),
            row.archived ? 1 : 0,
            row.first_user_message ?? null,
            row.memory_mode ?? null,
            now,
            safeJsonStringify(row)
          );
        }
      });
      tx(rows);
    } finally {
      stateDb.close();
    }

    return this.readCachedSourceThreads(limit);
  }

  private getOrSyncSourceThread(threadId: string): SourceThreadRecord | null {
    const cached = this.readCachedSourceThread(threadId);
    const stateDbPath = this.findLatestStateDbPath();
    if (!stateDbPath) {
      return cached;
    }

    const stateDb = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    try {
      const row = stateDb
        .prepare(
          `SELECT id, rollout_path, cwd, title, source, model_provider, cli_version,
                  created_at_ms, updated_at_ms, archived, first_user_message, memory_mode
           FROM threads
           WHERE id = ?`
        )
        .get(threadId) as StateThreadRow | undefined;
      if (!row) {
        return cached;
      }
      this.db
        .prepare(
          `INSERT INTO codex_source_threads(
             thread_id, state_db_path, rollout_path, cwd, title, source, model_provider, cli_version,
             created_at_ms, updated_at_ms, archived, first_user_message, memory_mode, synced_at_ms, raw_summary_json
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             state_db_path = excluded.state_db_path,
             rollout_path = excluded.rollout_path,
             cwd = excluded.cwd,
             title = excluded.title,
             source = excluded.source,
             model_provider = excluded.model_provider,
             cli_version = excluded.cli_version,
             created_at_ms = excluded.created_at_ms,
             updated_at_ms = excluded.updated_at_ms,
             archived = excluded.archived,
             first_user_message = excluded.first_user_message,
             memory_mode = excluded.memory_mode,
             synced_at_ms = excluded.synced_at_ms,
             raw_summary_json = excluded.raw_summary_json`
        )
        .run(
          row.id,
          stateDbPath,
          row.rollout_path ?? null,
          normalizeCodexPath(row.cwd) ?? "",
          row.title ?? null,
          row.source ?? null,
          row.model_provider ?? null,
          row.cli_version ?? null,
          toMillis(row.created_at_ms),
          toMillis(row.updated_at_ms),
          row.archived ? 1 : 0,
          row.first_user_message ?? null,
          row.memory_mode ?? null,
          Date.now(),
          safeJsonStringify(row)
        );
    } finally {
      stateDb.close();
    }

    return this.readCachedSourceThread(threadId);
  }

  private ensureThreadIngested(source: SourceThreadRecord): void {
    const rolloutPath = source.rollout_path;
    if (!rolloutPath || !fs.existsSync(rolloutPath)) {
      this.persistParsedThread(source.thread_id, rolloutPath, {
        turns: [],
        items: [],
        changes: [],
        ingestStatus: rolloutPath ? "missing_rollout" : "missing_rollout_path",
        ingestError: rolloutPath ? `rollout missing: ${rolloutPath}` : "thread has no rollout path"
      });
      return;
    }

    const stats = fs.statSync(rolloutPath);
    const currentSize = stats.size;
    const currentMtime = stats.mtimeMs;
    const ingest = this.db
      .prepare(
        `SELECT thread_id, rollout_path, rollout_size_bytes, rollout_mtime_ms, parser_version, status
         FROM codex_thread_ingest
         WHERE thread_id = ?`
      )
      .get(source.thread_id) as IngestRow | undefined;

    const isFresh =
      ingest &&
      ingest.rollout_path === rolloutPath &&
      ingest.rollout_size_bytes === currentSize &&
      ingest.rollout_mtime_ms === currentMtime &&
      ingest.parser_version === ROLLOUT_PARSER_VERSION &&
      ingest.status === "ready";
    if (isFresh) {
      return;
    }

    const parsed = this.parseRolloutFile(source.thread_id, rolloutPath);
    this.persistParsedThread(source.thread_id, rolloutPath, parsed, {
      sizeBytes: currentSize,
      mtimeMs: currentMtime
    });
  }

  private parseRolloutFile(threadId: string, rolloutPath: string): ParsedThread {
    const content = fs.readFileSync(rolloutPath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    const turns = new Map<string, MutableTurn>();
    const turnOrder: string[] = [];
    const items: ParsedItem[] = [];
    const changes: ParsedItemChange[] = [];
    const pendingCalls = new Map<string, PendingCall>();
    const emittedCallIds = new Set<string>();
    let currentTurnId: string | null = null;
    let latestTurnId: string | null = null;
    let latestActiveTurnId: string | null = null;

    const ensureTurn = (turnId: string, seed?: Partial<MutableTurn>): MutableTurn => {
      const existing = turns.get(turnId);
      if (existing) {
        if (seed) {
          if (seed.cwd != null) existing.cwd = seed.cwd;
          if (seed.model != null) existing.model = seed.model;
          if (seed.startedAtMs != null) existing.startedAtMs = seed.startedAtMs;
          if (seed.completedAtMs != null) existing.completedAtMs = seed.completedAtMs;
          if (seed.durationMs != null) existing.durationMs = seed.durationMs;
          if (seed.contextJson != null) existing.contextJson = seed.contextJson;
          if (seed.errorText != null) existing.errorText = seed.errorText;
          if (seed.status != null) existing.status = seed.status;
        }
        return existing;
      }
      const created: MutableTurn = {
        turnId,
        ordinal: turnOrder.length + 1,
        status: seed?.status ?? "inProgress",
        errorText: seed?.errorText ?? null,
        cwd: seed?.cwd ?? null,
        model: seed?.model ?? null,
        startedAtMs: seed?.startedAtMs ?? null,
        completedAtMs: seed?.completedAtMs ?? null,
        durationMs: seed?.durationMs ?? null,
        contextJson: seed?.contextJson ?? null,
        nextItemOrdinal: 1
      };
      turns.set(turnId, created);
      turnOrder.push(turnId);
      return created;
    };

    const resolveTurnId = (candidate?: unknown): string | null => {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
      return latestActiveTurnId ?? currentTurnId ?? latestTurnId;
    };

    const addItem = (turnId: string, item: Omit<ParsedItem, "itemId" | "threadId" | "turnId" | "ordinalInTurn">) => {
      const turn = ensureTurn(turnId);
      const itemId = `${turnId}:item:${turn.nextItemOrdinal}`;
      items.push({
        itemId,
        threadId,
        turnId,
        ordinalInTurn: turn.nextItemOrdinal,
        ...item
      });
      turn.nextItemOrdinal += 1;
      return itemId;
    };

    const addPatchChanges = (itemId: string, payloadChanges: unknown) => {
      if (!payloadChanges || typeof payloadChanges !== "object") {
        return;
      }
      let ordinal = 1;
      for (const [filePath, changeValue] of Object.entries(payloadChanges as Record<string, unknown>)) {
        if (!changeValue || typeof changeValue !== "object") {
          continue;
        }
        const change = changeValue as Record<string, unknown>;
        const normalized = normalizeChangeKind(change);
        changes.push({
          changeId: `${itemId}:change:${ordinal}`,
          itemId,
          ordinal,
          path: normalizeCodexPath(filePath) ?? filePath,
          changeKind: normalized.kind,
          movePath: normalized.movePath,
          diffText: typeof change.unified_diff === "string" ? change.unified_diff : null
        });
        ordinal += 1;
      }
    };

    try {
      for (const line of lines) {
        const parsedLine = JSON.parse(line) as { timestamp?: string; type?: string; payload?: Record<string, unknown> };
        const payload = parsedLine.payload ?? {};
        const timestampMs = parseTimestamp(parsedLine.timestamp);

        if (parsedLine.type === "turn_context") {
          const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
          if (!turnId) {
            continue;
          }
          currentTurnId = turnId;
          latestTurnId = turnId;
          latestActiveTurnId = turnId;
          ensureTurn(turnId, {
            cwd: normalizeCodexPath(typeof payload.cwd === "string" ? payload.cwd : null),
            model: typeof payload.model === "string" ? payload.model : null,
            contextJson: safeJsonStringify(payload)
          });
          continue;
        }

        if (parsedLine.type === "event_msg") {
          const eventType = typeof payload.type === "string" ? payload.type : "";
          switch (eventType) {
            case "task_started": {
              const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
              if (!turnId) {
                break;
              }
              currentTurnId = turnId;
              latestTurnId = turnId;
              latestActiveTurnId = turnId;
              ensureTurn(turnId, {
                status: "inProgress",
                startedAtMs: toOptionalMillis(payload.started_at) != null ? toMillis(payload.started_at) * 1000 : timestampMs
              });
              break;
            }
            case "task_complete": {
              const turnId = resolveTurnId(payload.turn_id);
              if (!turnId) {
                break;
              }
              const turn = ensureTurn(turnId);
              if (turn.status !== "failed" && turn.status !== "interrupted") {
                turn.status = "completed";
              }
              turn.completedAtMs =
                toOptionalMillis(payload.completed_at) != null ? toMillis(payload.completed_at) * 1000 : timestampMs;
              turn.durationMs = toOptionalMillis(payload.duration_ms);
              latestTurnId = turnId;
              latestActiveTurnId = null;
              if (currentTurnId === turnId) {
                currentTurnId = null;
              }
              break;
            }
            case "turn_aborted": {
              const turnId = resolveTurnId(payload.turn_id);
              if (!turnId) {
                break;
              }
              const turn = ensureTurn(turnId);
              turn.status = "interrupted";
              turn.errorText = typeof payload.reason === "string" ? payload.reason : turn.errorText;
              turn.completedAtMs =
                toOptionalMillis(payload.completed_at) != null ? toMillis(payload.completed_at) * 1000 : timestampMs;
              turn.durationMs = toOptionalMillis(payload.duration_ms);
              latestTurnId = turnId;
              latestActiveTurnId = null;
              if (currentTurnId === turnId) {
                currentTurnId = null;
              }
              break;
            }
            case "error": {
              const turnId = resolveTurnId(payload.turn_id);
              if (!turnId) {
                break;
              }
              const turn = ensureTurn(turnId);
              turn.status = "failed";
              turn.errorText = typeof payload.message === "string" ? payload.message : "Unknown error";
              break;
            }
            case "exec_command_end": {
              const turnId = resolveTurnId(payload.turn_id);
              if (!turnId) {
                break;
              }
              const callId = typeof payload.call_id === "string" ? payload.call_id : null;
              if (callId) {
                emittedCallIds.add(callId);
              }
              addItem(turnId, {
                itemType: "commandExecution",
                role: null,
                phase: null,
                status: typeof payload.status === "string" ? payload.status : null,
                textValue: null,
                aggregatedOutput:
                  typeof payload.aggregated_output === "string"
                    ? payload.aggregated_output
                    : [
                        typeof payload.stdout === "string" ? payload.stdout : "",
                        typeof payload.stderr === "string" ? payload.stderr : ""
                      ]
                        .filter(Boolean)
                        .join("\n")
                        .trim() || null,
                commandText: joinCommand(payload.command),
                cwd: normalizeCodexPath(typeof payload.cwd === "string" ? payload.cwd : null),
                toolName: "shell_command",
                serverName: null,
                callId,
                exitCode: typeof payload.exit_code === "number" ? payload.exit_code : null,
                createdAtMs: timestampMs,
                rawPayloadJson: safeJsonStringify(payload)
              });
              break;
            }
            case "patch_apply_end": {
              const turnId = resolveTurnId(payload.turn_id);
              if (!turnId) {
                break;
              }
              const callId = typeof payload.call_id === "string" ? payload.call_id : null;
              if (callId) {
                emittedCallIds.add(callId);
              }
              const itemId = addItem(turnId, {
                itemType: "fileChange",
                role: null,
                phase: null,
                status: payload.success === true ? "completed" : "failed",
                textValue: null,
                aggregatedOutput:
                  [
                    typeof payload.stdout === "string" ? payload.stdout : "",
                    typeof payload.stderr === "string" ? payload.stderr : ""
                  ]
                    .filter(Boolean)
                    .join("\n")
                    .trim() || null,
                commandText: "apply_patch",
                cwd: null,
                toolName: "apply_patch",
                serverName: null,
                callId,
                exitCode: null,
                createdAtMs: timestampMs,
                rawPayloadJson: safeJsonStringify(payload)
              });
              addPatchChanges(itemId, payload.changes);
              break;
            }
            case "dynamic_tool_call_response": {
              const turnId = resolveTurnId(payload.turn_id);
              if (!turnId) {
                break;
              }
              const callId = typeof payload.call_id === "string" ? payload.call_id : null;
              if (callId) {
                emittedCallIds.add(callId);
              }
              addItem(turnId, {
                itemType: "commandExecution",
                role: null,
                phase: null,
                status: payload.success === true ? "completed" : "failed",
                textValue: null,
                aggregatedOutput:
                  extractTextFromContentItems(payload.content_items) ||
                  (typeof payload.error === "string" ? payload.error : null),
                commandText: typeof payload.tool === "string" ? payload.tool : null,
                cwd: null,
                toolName: typeof payload.tool === "string" ? payload.tool : null,
                serverName: null,
                callId,
                exitCode: null,
                createdAtMs: timestampMs,
                rawPayloadJson: safeJsonStringify(payload)
              });
              break;
            }
            default:
              break;
          }
          continue;
        }

        if (parsedLine.type !== "response_item") {
          continue;
        }

        const itemType = typeof payload.type === "string" ? payload.type : "";
        switch (itemType) {
          case "message": {
            const role = typeof payload.role === "string" ? payload.role : "";
            const text = extractTextFromMessageContent(payload.content);
            const turnId = resolveTurnId();
            if (!turnId) {
              break;
            }
            if (role === "developer") {
              break;
            }
            if (role === "user") {
              if (shouldIgnoreUserMessage(text)) {
                break;
              }
              addItem(turnId, {
                itemType: "userMessage",
                role,
                phase: null,
                status: null,
                textValue: text || null,
                aggregatedOutput: null,
                commandText: null,
                cwd: null,
                toolName: null,
                serverName: null,
                callId: null,
                exitCode: null,
                createdAtMs: timestampMs,
                rawPayloadJson: safeJsonStringify(payload)
              });
              break;
            }
            if (role === "assistant") {
              addItem(turnId, {
                itemType: "agentMessage",
                role,
                phase: typeof payload.phase === "string" ? payload.phase : null,
                status: null,
                textValue: text || null,
                aggregatedOutput: null,
                commandText: null,
                cwd: null,
                toolName: null,
                serverName: null,
                callId: null,
                exitCode: null,
                createdAtMs: timestampMs,
                rawPayloadJson: safeJsonStringify(payload)
              });
            }
            break;
          }
          case "reasoning": {
            const text = extractReasoningText(payload);
            const turnId = resolveTurnId();
            if (!turnId || !text) {
              break;
            }
            addItem(turnId, {
              itemType: "reasoning",
              role: null,
              phase: null,
              status: null,
              textValue: text,
              aggregatedOutput: null,
              commandText: null,
              cwd: null,
              toolName: null,
              serverName: null,
              callId: null,
              exitCode: null,
              createdAtMs: timestampMs,
              rawPayloadJson: safeJsonStringify(payload)
            });
            break;
          }
          case "function_call": {
            const callId = typeof payload.call_id === "string" ? payload.call_id : null;
            if (!callId) {
              break;
            }
            pendingCalls.set(callId, {
              turnId: resolveTurnId(),
              name: typeof payload.name === "string" ? payload.name : "unknown",
              argumentsText: typeof payload.arguments === "string" ? payload.arguments : null,
              createdAtMs: timestampMs
            });
            break;
          }
          case "function_call_output": {
            const callId = typeof payload.call_id === "string" ? payload.call_id : null;
            if (!callId || emittedCallIds.has(callId)) {
              break;
            }
            const pending = pendingCalls.get(callId);
            const turnId = pending?.turnId ?? resolveTurnId();
            if (!turnId) {
              break;
            }
            const toolName = pending?.name ?? "function_call";
            addItem(turnId, {
              itemType: toolName === "apply_patch" ? "fileChange" : "commandExecution",
              role: null,
              phase: null,
              status: "completed",
              textValue: null,
              aggregatedOutput: typeof payload.output === "string" ? payload.output : safeJsonStringify(payload.output),
              commandText:
                toolName === "shell_command"
                  ? parseShellCommandFromArguments(pending?.argumentsText)
                  : toolName,
              cwd: null,
              toolName,
              serverName: null,
              callId,
              exitCode: null,
              createdAtMs: timestampMs ?? pending?.createdAtMs ?? null,
              rawPayloadJson: safeJsonStringify(payload)
            });
            emittedCallIds.add(callId);
            break;
          }
          default:
            break;
        }
      }
    } catch (error) {
      return {
        turns: [],
        items: [],
        changes: [],
        ingestStatus: "parse_failed",
        ingestError: error instanceof Error ? error.message : String(error)
      };
    }

    const normalizedTurns = turnOrder.map((turnId) => {
      const turn = turns.get(turnId)!;
      if (turn.status === "inProgress" && turn.completedAtMs != null) {
        turn.status = "completed";
      }
      return {
        turnId: turn.turnId,
        ordinal: turn.ordinal,
        status: turn.status,
        errorText: turn.errorText,
        cwd: turn.cwd,
        model: turn.model,
        startedAtMs: turn.startedAtMs,
        completedAtMs: turn.completedAtMs,
        durationMs: turn.durationMs,
        contextJson: turn.contextJson
      } satisfies ParsedTurn;
    });

    return {
      turns: normalizedTurns,
      items,
      changes,
      ingestStatus: "ready",
      ingestError: null
    };
  }

  private persistParsedThread(
    threadId: string,
    rolloutPath: string | null,
    parsed: ParsedThread,
    stats?: { sizeBytes: number; mtimeMs: number }
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM codex_thread_items WHERE thread_id = ?").run(threadId);
      this.db.prepare("DELETE FROM codex_thread_turns WHERE thread_id = ?").run(threadId);

      const insertTurn = this.db.prepare(
        `INSERT INTO codex_thread_turns(
           turn_id, thread_id, ordinal, status, error_text, cwd, model,
           started_at_ms, completed_at_ms, duration_ms, context_json
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const turn of parsed.turns) {
        insertTurn.run(
          turn.turnId,
          threadId,
          turn.ordinal,
          turn.status,
          turn.errorText,
          turn.cwd,
          turn.model,
          turn.startedAtMs,
          turn.completedAtMs,
          turn.durationMs,
          turn.contextJson
        );
      }

      const insertItem = this.db.prepare(
        `INSERT INTO codex_thread_items(
           item_id, thread_id, turn_id, ordinal_in_turn, item_type, role, phase, status,
           text_value, aggregated_output, command_text, cwd, tool_name, server_name,
           call_id, exit_code, created_at_ms, raw_payload_json
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of parsed.items) {
        insertItem.run(
          item.itemId,
          threadId,
          item.turnId,
          item.ordinalInTurn,
          item.itemType,
          item.role,
          item.phase,
          item.status,
          item.textValue,
          item.aggregatedOutput,
          item.commandText,
          item.cwd,
          item.toolName,
          item.serverName,
          item.callId,
          item.exitCode,
          item.createdAtMs,
          item.rawPayloadJson
        );
      }

      const insertChange = this.db.prepare(
        `INSERT INTO codex_thread_item_changes(
           change_id, item_id, ordinal, path, change_kind, move_path, diff_text
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`
      );
      for (const change of parsed.changes) {
        insertChange.run(
          change.changeId,
          change.itemId,
          change.ordinal,
          change.path,
          change.changeKind,
          change.movePath,
          change.diffText
        );
      }

      this.db
        .prepare(
          `INSERT INTO codex_thread_ingest(
             thread_id, rollout_path, rollout_size_bytes, rollout_mtime_ms, parser_version,
             status, last_error, last_ingested_at_ms
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             rollout_path = excluded.rollout_path,
             rollout_size_bytes = excluded.rollout_size_bytes,
             rollout_mtime_ms = excluded.rollout_mtime_ms,
             parser_version = excluded.parser_version,
             status = excluded.status,
             last_error = excluded.last_error,
             last_ingested_at_ms = excluded.last_ingested_at_ms`
        )
        .run(
          threadId,
          rolloutPath,
          stats?.sizeBytes ?? null,
          stats?.mtimeMs ?? null,
          ROLLOUT_PARSER_VERSION,
          parsed.ingestStatus,
          parsed.ingestError,
          Date.now()
        );
    });
    tx();
  }

  private readCachedSourceThreads(limit: number): SourceThreadRecord[] {
    return this.db
      .prepare(
        `SELECT thread_id, state_db_path, rollout_path, cwd, title, source, model_provider, cli_version,
                created_at_ms, updated_at_ms, archived, first_user_message, memory_mode
         FROM codex_source_threads
         WHERE archived = 0
         ORDER BY updated_at_ms DESC
         LIMIT ?`
      )
      .all(limit) as SourceThreadRecord[];
  }

  private readCachedSourceThread(threadId: string): SourceThreadRecord | null {
    return (
      (this.db
        .prepare(
          `SELECT thread_id, state_db_path, rollout_path, cwd, title, source, model_provider, cli_version,
                  created_at_ms, updated_at_ms, archived, first_user_message, memory_mode
           FROM codex_source_threads
           WHERE thread_id = ?`
        )
        .get(threadId) as SourceThreadRecord | undefined) ?? null
    );
  }

  private findLatestStateDbPath(): string | null {
    if (!fs.existsSync(this.codexHomeDir)) {
      return null;
    }
    const entries = fs
      .readdirSync(this.codexHomeDir)
      .filter((name) => /^state_\d+\.sqlite$/i.test(name))
      .map((name) => {
        const fullPath = path.join(this.codexHomeDir, name);
        const match = name.match(/^state_(\d+)\.sqlite$/i);
        return {
          fullPath,
          generation: match ? Number(match[1]) : 0,
          mtimeMs: fs.statSync(fullPath).mtimeMs
        };
      })
      .sort((a, b) => b.generation - a.generation || b.mtimeMs - a.mtimeMs);
    return entries[0]?.fullPath ?? null;
  }
}

function groupBy<T>(rows: T[], getKey: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = getKey(row);
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }
  return grouped;
}
