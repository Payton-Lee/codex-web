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
  threadDetail: (threadId: string) => request<ThreadDetail>(`/api/threads/${threadId}`),
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
  fsReadFile: (path: string) =>
    request<unknown>("/api/fs/read-file", {
      method: "POST",
      body: JSON.stringify({ path })
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
