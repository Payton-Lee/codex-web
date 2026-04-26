import type {
  AccountSummary,
  AppServerCatalog,
  ApprovalRequest,
  ApprovalResolution,
  DiffPreview,
  SessionSummary,
  LoadedThreadsSummary,
  McpComposerSuggestions,
  SkillSuggestion,
  SettingsSummary,
  SnapshotPayload,
  ThreadDetail,
  ThreadHistoryPage,
  ThreadSummary,
  WorkspaceFileSuggestion,
  WorkspaceState
} from "./shared";

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json"
    },
    ...init
  });
  if (!response.ok) {
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      throw new Error(parsed.error || raw || `HTTP ${response.status}`);
    } catch {
      throw new Error(raw || `HTTP ${response.status}`);
    }
  }
  return (await response.json()) as T;
}

export const api = {
  bootstrap: () => request<SnapshotPayload>("/api/bootstrap"),
  account: () => request<AccountSummary>("/api/account"),
  session: (sessionId: string) => request<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`),
  resolveSession: (workspacePath: string, threadId?: string | null) =>
    request<SessionSummary>("/api/sessions/resolve", {
      method: "POST",
      body: JSON.stringify({
        workspacePath,
        ...(threadId ? { threadId } : {})
      })
    }),
  login: () =>
    request<{
      authUrl?: string | null;
      loginId?: string | null;
      browserOpen?: { ok: boolean; message: string } | null;
      raw?: unknown;
    }>("/api/account/login", { method: "POST" }),
  cancelLogin: (loginId: string) =>
    request<{ ok?: boolean } | Record<string, never>>("/api/account/login/cancel", {
      method: "POST",
      body: JSON.stringify({ loginId })
    }),
  logout: () => request<AccountSummary>("/api/account/logout", { method: "POST" }),
  workspaces: () => request<WorkspaceState>("/api/workspaces"),
  pickWorkspace: () =>
    request<{
      canceled: boolean;
      path?: string;
      workspace: WorkspaceState;
    }>("/api/workspaces/pick", {
      method: "POST"
    }),
  addWorkspace: (path: string) =>
    request<WorkspaceState>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ path })
    }),
  selectWorkspace: (path: string) =>
    request<WorkspaceState>("/api/workspaces/select", {
      method: "POST",
      body: JSON.stringify({ path })
    }),
  threads: () => request<ThreadSummary[]>("/api/threads"),
  loadedThreads: () => request<LoadedThreadsSummary>("/api/threads/loaded"),
  createThread: () => request<ThreadSummary>("/api/threads", { method: "POST" }),
  archiveThread: (threadId: string) =>
    request<{ ok: boolean }>(`/api/threads/${threadId}/archive`, {
      method: "POST"
    }),
  unarchiveThread: (threadId: string) =>
    request<ThreadSummary>(`/api/threads/${threadId}/unarchive`, {
      method: "POST"
    }),
  renameThread: (threadId: string, name: string | null) =>
    request<{ ok: boolean; threadId: string; name: string | null }>(`/api/threads/${threadId}/name`, {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  compactThread: (threadId: string) =>
    request<{ ok: boolean }>(`/api/threads/${threadId}/compact`, {
      method: "POST"
    }),
  rollbackThread: (threadId: string, turnCount = 1) =>
    request<ThreadDetail>(`/api/threads/${threadId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ turnCount })
    }),
  runThreadShellCommand: (threadId: string, command: string, cwd?: string | null) =>
    request<unknown>(`/api/threads/${threadId}/shell-command`, {
      method: "POST",
      body: JSON.stringify({
        command,
        ...(cwd ? { cwd } : {})
      })
    }),
  threadDetail: (threadId: string) =>
    request<ThreadDetail>(`/api/threads/${threadId}`, {
      cache: "no-store"
    }),
  threadHistory: (threadId: string, options?: { beforeTurnId?: string | null; limit?: number }) => {
    const params = new URLSearchParams();
    if (options?.beforeTurnId) {
      params.set("beforeTurnId", options.beforeTurnId);
    }
    if (typeof options?.limit === "number") {
      params.set("limit", String(options.limit));
    }
    const query = params.toString();
    return request<ThreadHistoryPage>(
      `/api/threads/${threadId}/history${query ? `?${query}` : ""}`,
      {
        cache: "no-store"
      }
    );
  },
  searchComposerFiles: (query: string) =>
    request<WorkspaceFileSuggestion[]>(`/api/composer/files?query=${encodeURIComponent(query)}`),
  searchComposerSkills: (query: string) =>
    request<SkillSuggestion[]>(`/api/composer/skills?query=${encodeURIComponent(query)}`),
  searchComposerMcp: (query: string) =>
    request<McpComposerSuggestions>(`/api/composer/mcp?query=${encodeURIComponent(query)}`),
  appServerCatalog: () => request<AppServerCatalog>("/api/app-server/catalog"),
  appServerApps: () => request<unknown>("/api/app-server/apps"),
  readPlugin: (marketplacePath: string, pluginName: string) =>
    request<unknown>("/api/app-server/plugin/read", {
      method: "POST",
      body: JSON.stringify({ marketplacePath, pluginName })
    }),
  reloadMcpConfig: () =>
    request<unknown>("/api/app-server/mcp/reload", {
      method: "POST"
    }),
  execCommand: (command: string, cwd?: string | null) =>
    request<unknown>("/api/commands/exec", {
      method: "POST",
      body: JSON.stringify({
        command,
        ...(cwd ? { cwd } : {})
      })
    }),
  execCommandInteractive: (payload: {
    command: string[];
    cwd?: string | null;
    processId: string;
    tty?: boolean;
    size?: { cols: number; rows: number };
    env?: Record<string, string>;
    disableTimeout?: boolean;
  }) =>
    request<unknown>("/api/commands/exec", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  execCommandWrite: (processId: string, input: string) =>
    request<unknown>(`/api/commands/exec/${encodeURIComponent(processId)}/write`, {
      method: "POST",
      body: JSON.stringify({ input })
    }),
  execCommandResize: (processId: string, cols: number, rows: number) =>
    request<unknown>(`/api/commands/exec/${encodeURIComponent(processId)}/resize`, {
      method: "POST",
      body: JSON.stringify({ size: { cols, rows } })
    }),
  execCommandTerminate: (processId: string) =>
    request<unknown>(`/api/commands/exec/${encodeURIComponent(processId)}/terminate`, {
      method: "POST"
    }),
  fsReadFile: (path: string) =>
    request<unknown>("/api/fs/read-file", {
      method: "POST",
      body: JSON.stringify({ path })
    }),
  fsWriteFile: (path: string, dataBase64: string) =>
    request<unknown>("/api/fs/write-file", {
      method: "POST",
      body: JSON.stringify({ path, dataBase64 })
    }),
  fsCreateDirectory: (path: string, recursive = true) =>
    request<unknown>("/api/fs/create-directory", {
      method: "POST",
      body: JSON.stringify({ path, recursive })
    }),
  fsReadDirectory: (path: string) =>
    request<unknown>("/api/fs/read-directory", {
      method: "POST",
      body: JSON.stringify({ path })
    }),
  fsMetadata: (path: string) =>
    request<unknown>("/api/fs/metadata", {
      method: "POST",
      body: JSON.stringify({ path })
    }),
  fsRemove: (path: string, recursive = false, force = false) =>
    request<unknown>("/api/fs/remove", {
      method: "POST",
      body: JSON.stringify({ path, recursive, force })
    }),
  fsCopy: (source: string, destination: string, recursive = false) =>
    request<unknown>("/api/fs/copy", {
      method: "POST",
      body: JSON.stringify({ source, destination, recursive })
    }),
  fsWatch: (path: string, watchId: string) =>
    request<unknown>("/api/fs/watch", {
      method: "POST",
      body: JSON.stringify({ path, watchId })
    }),
  fsUnwatch: (watchId: string) =>
    request<unknown>("/api/fs/unwatch", {
      method: "POST",
      body: JSON.stringify({ watchId })
    }),
  sendPrompt: (threadId: string, prompt: string) =>
    request<{ turnId: string }>(`/api/threads/${threadId}/turns`, {
      method: "POST",
      body: JSON.stringify({ prompt })
    }),
  interruptTurn: (threadId: string, turnId: string) =>
    request<{ ok: boolean }>(`/api/threads/${threadId}/interrupt`, {
      method: "POST",
      body: JSON.stringify({ turnId })
    }),
  approvals: () => request<ApprovalRequest[]>("/api/approvals"),
  resolveApproval: (approvalId: string, resolution: ApprovalResolution) =>
    request<{ ok: boolean }>(`/api/approvals/${approvalId}/decision`, {
      method: "POST",
      body: JSON.stringify(resolution)
    }),
  settings: () => request<SettingsSummary>("/api/settings"),
  diff: (threadId: string, turnId: string) =>
    request<{ diff: string; previews: DiffPreview[] }>(`/api/threads/${threadId}/diffs/${turnId}`)
};
