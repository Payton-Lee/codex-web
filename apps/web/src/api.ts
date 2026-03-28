import type {
  AccountSummary,
  ApprovalRequest,
  ApprovalResolution,
  DiffPreview,
  LoadedThreadsSummary,
  SettingsSummary,
  SnapshotPayload,
  ThreadDetail,
  ThreadSummary,
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
  login: () => request<{ authUrl?: string; loginId?: string }>("/api/account/login", { method: "POST" }),
  logout: () => request<AccountSummary>("/api/account/logout", { method: "POST" }),
  workspaces: () => request<WorkspaceState>("/api/workspaces"),
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
  threadDetail: (threadId: string) => request<ThreadDetail>(`/api/threads/${threadId}`),
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
