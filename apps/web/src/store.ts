import { create } from "zustand";
import type {
  ApprovalDecision,
  ApprovalRequest,
  FrontendEvent,
  SessionSummary,
  SettingsSummary,
  SnapshotPayload,
  ThreadDetail,
  ThreadItem,
  ThreadSummary
} from "./shared";
import { api } from "./api";
import { isThreadInWorkspace } from "./lib/workspace";

type LiveItemState = {
  stream: string;
  text: string;
  threadId: string;
  turnId: string;
  item: ThreadItem;
};
type DeltaMap = Record<string, LiveItemState>;
type PendingPrompt = { threadId: string; prompt: string } | null;
const SESSION_QUERY_KEY = "sid";

function readSessionIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get(SESSION_QUERY_KEY)?.trim();
  return sessionId || null;
}

function writeSessionIdToUrl(sessionId: string | null): void {
  const url = new URL(window.location.href);
  if (sessionId) {
    url.searchParams.set(SESSION_QUERY_KEY, sessionId);
  } else {
    url.searchParams.delete(SESSION_QUERY_KEY);
  }
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(null, "", nextUrl);
}

function itemTextContent(item: ThreadDetail["turns"][number]["items"][number]): string {
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text;
  }
  const content = Array.isArray(item.content) ? (item.content as unknown as Array<Record<string, unknown>>) : null;
  if (!content) {
    return "";
  }
  return content
    .map((entry) =>
      typeof entry.text === "string" ? entry.text : ""
    )
    .join("")
    .trim();
}

function detailContainsPrompt(detail: ThreadDetail, prompt: string): boolean {
  return detail.turns.some((turn) =>
    turn.items.some((item) => item.type === "userMessage" && itemTextContent(item) === prompt.trim())
  );
}

function normalizeLoginErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("LOGIN_SERVER_PORT_BLOCKED") || raw.includes("localhost:1455")) {
    return "当前 Windows 阻止了 localhost:1455，Codex 无法启动 ChatGPT 登录回调服务。请尽量不要退出现有登录态，或者改用 API key 登录。";
  }
  if (raw.includes("failed to start login server") && (raw.includes("10013") || raw.includes("访问权限不允许"))) {
    return "当前 Windows 阻止了 localhost:1455，Codex 无法启动 ChatGPT 登录回调服务。请尽量不要退出现有登录态，或者改用 API key 登录。";
  }
  return raw;
}

interface AppState {
  loading: boolean;
  bootstrapped: boolean;
  error: string | null;
  snapshot: SnapshotPayload | null;
  loginPending: boolean;
  loginAuthUrl: string | null;
  loginId: string | null;
  loginMessage: string | null;
  appServerAppsRaw: string | null;
  pluginReadRaw: string | null;
  mcpReloadRaw: string | null;
  commandExecRaw: string | null;
  fsDebugRaw: string | null;
  approvalHistory: ApprovalRequest[];
  activeSessionId: string | null;
  selectedThreadId: string | null;
  threadDetail: ThreadDetail | null;
  threadDetailRefreshing: boolean;
  liveDeltas: DeltaMap;
  activeTurnId: string | null;
  pendingPrompt: PendingPrompt;
  setError(error: string | null): void;
  bootstrap(): Promise<void>;
  refreshThreads(): Promise<void>;
  refreshLoadedThreads(): Promise<void>;
  refreshAppServerCatalog(): Promise<void>;
  refreshAppServerApps(): Promise<void>;
  readPluginDetail(marketplacePath: string, pluginName: string): Promise<void>;
  reloadMcpConfig(): Promise<void>;
  execCommandDebug(command: string, cwd?: string | null): Promise<void>;
  readFsFileDebug(path: string): Promise<void>;
  readFsDirectoryDebug(path: string): Promise<void>;
  readFsMetadataDebug(path: string): Promise<void>;
  refreshCurrentThreadDetail(threadId: string): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  createThread(): Promise<void>;
  sendPrompt(prompt: string): Promise<void>;
  interruptTurn(): Promise<void>;
  pickWorkspace(): Promise<void>;
  addWorkspace(path: string): Promise<void>;
  selectWorkspace(path: string): Promise<void>;
  login(): Promise<void>;
  cancelLogin(): Promise<void>;
  logout(): Promise<void>;
  renameThread(threadId: string, name: string | null): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  compactThread(threadId: string): Promise<void>;
  rollbackThread(threadId: string, turnCount?: number): Promise<void>;
  runThreadShellCommand(threadId: string, command: string, cwd?: string | null): Promise<void>;
  resolveApproval(
    approvalId: string,
    payload: { decision: ApprovalDecision; answers?: Record<string, string> }
  ): Promise<void>;
  handleEvent(event: FrontendEvent): void;
}

function mergeThreads(existing: SnapshotPayload | null, threads: ThreadSummary[]): SnapshotPayload | null {
  if (!existing) {
    return existing;
  }
  return {
    ...existing,
    threads
  };
}

function mergeLoadedThreads(
  existing: SnapshotPayload | null,
  loadedThreads: SnapshotPayload["loadedThreads"]
): SnapshotPayload | null {
  if (!existing) {
    return existing;
  }
  return {
    ...existing,
    loadedThreads
  };
}

function latestThreadForWorkspace(threads: ThreadSummary[], workspacePath: string): ThreadSummary | null {
  return threads.find((thread) => isThreadInWorkspace(thread.cwd, workspacePath)) ?? null;
}

function emptyDetailFromSummary(thread: ThreadSummary): ThreadDetail {
  return {
    ...thread,
    turns: []
  };
}

function pruneLiveDeltasForDetail(liveDeltas: DeltaMap, detail: ThreadDetail): DeltaMap {
  const completedItemIds = new Set(
    detail.turns.flatMap((turn) => turn.items.map((item) => item.id))
  );
  if (completedItemIds.size === 0) {
    return liveDeltas;
  }
  return Object.fromEntries(
    Object.entries(liveDeltas).filter(([itemId, delta]) => delta.threadId !== detail.id || !completedItemIds.has(itemId))
  );
}

function mergeLiveItemText(item: ThreadItem, text: string): ThreadItem {
  return {
    ...item,
    text,
    aggregatedOutput:
      item.type === "commandExecution" || item.type === "fileChange"
        ? text
        : item.aggregatedOutput
  };
}

async function resolveActiveSession(
  snapshot: SnapshotPayload | null,
  threadId: string | null
): Promise<SessionSummary | null> {
  if (!snapshot?.account.loggedIn || !snapshot.account.email || !snapshot.workspace.current) {
    return null;
  }
  return api.resolveSession(snapshot.workspace.current, threadId);
}

export const useAppStore = create<AppState>((set, get) => ({
  loading: false,
  bootstrapped: false,
  error: null,
  snapshot: null,
  loginPending: false,
  loginAuthUrl: null,
  loginId: null,
  loginMessage: null,
  appServerAppsRaw: null,
  pluginReadRaw: null,
  mcpReloadRaw: null,
  commandExecRaw: null,
  fsDebugRaw: null,
  approvalHistory: [],
  activeSessionId: null,
  selectedThreadId: null,
  threadDetail: null,
  threadDetailRefreshing: false,
  liveDeltas: {},
  activeTurnId: null,
  pendingPrompt: null,
  setError: (error) => set({ error }),
  bootstrap: async () => {
    set({ loading: true, error: null });
    try {
      let snapshot = await api.bootstrap();
      const requestedSessionId = readSessionIdFromUrl();
      let restoredSession: SessionSummary | null = null;

      if (requestedSessionId && snapshot.account.loggedIn) {
        try {
          restoredSession = await api.session(requestedSessionId);
        } catch {
          restoredSession = null;
        }
      }

      if (restoredSession && snapshot.workspace.current !== restoredSession.workspacePath) {
        const workspace = await api.selectWorkspace(restoredSession.workspacePath);
        const [threads, loadedThreads] = await Promise.all([api.threads(), api.loadedThreads()]);
        snapshot = {
          ...snapshot,
          workspace,
          threads,
          loadedThreads
        };
      }

      const restoredThread = restoredSession?.threadId
        ? snapshot.threads.find((thread) => thread.id === restoredSession?.threadId) ?? null
        : null;
      const preferredThread = restoredThread ??
        (snapshot.workspace.current
          ? latestThreadForWorkspace(snapshot.threads, snapshot.workspace.current) ?? snapshot.threads[0] ?? null
          : snapshot.threads[0] ?? null);
      set({
        loading: false,
        bootstrapped: true,
        snapshot,
        approvalHistory: [],
        activeSessionId: restoredSession?.sessionId ?? null,
        selectedThreadId: preferredThread?.id ?? null
      });
      if (restoredSession?.sessionId) {
        writeSessionIdToUrl(restoredSession.sessionId);
      }
      if (preferredThread?.id) {
        await get().selectThread(preferredThread.id);
        return;
      }
      if (!restoredSession?.sessionId) {
        const resolvedSession = await resolveActiveSession(snapshot, null);
        set({ activeSessionId: resolvedSession?.sessionId ?? null });
        writeSessionIdToUrl(resolvedSession?.sessionId ?? null);
      }
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },
  refreshThreads: async () => {
    const threads = await api.threads();
    set((state) => ({ snapshot: mergeThreads(state.snapshot, threads) }));
  },
  refreshLoadedThreads: async () => {
    const [threads, loadedThreads] = await Promise.all([api.threads(), api.loadedThreads()]);
    set((state) => ({
      snapshot: mergeLoadedThreads(mergeThreads(state.snapshot, threads), loadedThreads)
    }));
  },
  refreshAppServerCatalog: async () => {
    const catalog = await api.appServerCatalog();
    set((state) =>
      state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              appServerCatalog: catalog
            }
          }
        : state
    );
  },
  refreshCurrentThreadDetail: async (threadId) => {
    set({ threadDetailRefreshing: true, error: null });
    try {
      const detail = await api.threadDetail(threadId);
      set((state) => ({
        threadDetail: detail,
        threadDetailRefreshing: false,
        liveDeltas: pruneLiveDeltasForDetail(state.liveDeltas, detail),
        activeTurnId:
          detail.turns.find((turn) => turn.status === "inProgress")?.id ??
          detail.turns.at(-1)?.id ??
          null,
        pendingPrompt:
          state.pendingPrompt &&
          state.pendingPrompt.threadId === threadId &&
          detailContainsPrompt(detail, state.pendingPrompt.prompt)
            ? null
            : state.pendingPrompt
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const summary = get().snapshot?.threads.find((entry) => entry.id === threadId) ?? null;
      if (message.includes("is not materialized yet") && summary) {
        set((state) => ({
          threadDetail: state.threadDetail?.id === threadId ? state.threadDetail : emptyDetailFromSummary(summary),
          threadDetailRefreshing: false,
          activeTurnId: state.activeTurnId,
          pendingPrompt:
            state.pendingPrompt && state.pendingPrompt.threadId === threadId ? state.pendingPrompt : null
        }));
        return;
      }
      set({ threadDetailRefreshing: false, error: message });
      throw error;
    }
  },
  selectThread: async (threadId) => {
    set({
      selectedThreadId: threadId,
      threadDetail: null,
      threadDetailRefreshing: true,
      activeTurnId: null,
      error: null
    });
    try {
      await get().refreshCurrentThreadDetail(threadId);
      const resolvedSession = await resolveActiveSession(get().snapshot, threadId);
      set({ activeSessionId: resolvedSession?.sessionId ?? null });
      writeSessionIdToUrl(resolvedSession?.sessionId ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const summary = get().snapshot?.threads.find((entry) => entry.id === threadId) ?? null;
      if (message.includes("is not materialized yet") && summary) {
        set((state) => ({
          threadDetail: emptyDetailFromSummary(summary),
          threadDetailRefreshing: false,
          activeTurnId: null,
          pendingPrompt:
            state.pendingPrompt && state.pendingPrompt.threadId === threadId ? state.pendingPrompt : null
        }));
        return;
      }
      set({ error: message });
      throw error;
    }
  },
  createThread: async () => {
    const thread = await api.createThread();
    await get().refreshThreads();
      set({
      selectedThreadId: thread.id,
      threadDetail: emptyDetailFromSummary(thread),
      threadDetailRefreshing: false,
      activeTurnId: null,
      liveDeltas: {}
    });
    await get().selectThread(thread.id);
  },
  sendPrompt: async (prompt) => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      return;
    }
    const currentThreadId = get().selectedThreadId;
    if (!currentThreadId) {
      const message = "请先选择一个线程，再发送消息。";
      set({ error: message });
      throw new Error(message);
    }
    set({ error: null, pendingPrompt: { threadId: currentThreadId, prompt: trimmedPrompt } });
    try {
      const result = await api.sendPrompt(currentThreadId, trimmedPrompt);
      set({ activeTurnId: result.turnId });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({
        pendingPrompt: null,
        error: message.includes("thread not found") ? "当前线程已失效，请重新选择线程。" : message
      });
      throw error;
    }
  },
  interruptTurn: async () => {
    const threadId = get().selectedThreadId;
    const turnId = get().activeTurnId;
    if (!threadId || !turnId) {
      return;
    }
    await api.interruptTurn(threadId, turnId);
  },
  pickWorkspace: async () => {
    const result = await api.pickWorkspace();
    set((state) =>
      state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              workspace: result.workspace
            }
          }
        : state
    );
    if (result.canceled || !result.path) {
      return;
    }
    await get().selectWorkspace(result.path);
  },
  addWorkspace: async (path) => {
    const workspace = await api.addWorkspace(path);
    set((state) =>
      state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              workspace
            }
          }
        : state
    );
    await get().refreshLoadedThreads();
  },
  selectWorkspace: async (path) => {
    const workspace = await api.selectWorkspace(path);
    const [threads, loadedThreads] = await Promise.all([api.threads(), api.loadedThreads()]);
    const matchedThread = latestThreadForWorkspace(threads, workspace.current ?? path);
    set((state) =>
      state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              workspace,
              threads,
              loadedThreads
            },
            selectedThreadId: matchedThread?.id ?? null,
            threadDetail: matchedThread && state.threadDetail?.id === matchedThread.id ? state.threadDetail : null,
            threadDetailRefreshing: matchedThread ? state.threadDetailRefreshing : false,
            activeTurnId: matchedThread?.id ? state.activeTurnId : null,
            liveDeltas: matchedThread?.id ? state.liveDeltas : {}
          }
        : state
    );
    if (matchedThread) {
      await get().selectThread(matchedThread.id);
      return;
    }
    set({
      activeSessionId: null,
      threadDetail: null,
      threadDetailRefreshing: false,
      activeTurnId: null,
      liveDeltas: {}
    });
    const resolvedSession = await resolveActiveSession(get().snapshot, null);
    set({ activeSessionId: resolvedSession?.sessionId ?? null });
    writeSessionIdToUrl(resolvedSession?.sessionId ?? null);
  },
  login: async () => {
    set({ loginPending: true, error: null, loginMessage: null });
    try {
      const result = await api.login();
      const authUrl = result.authUrl ?? null;
      const loginId = result.loginId ?? null;
      const loginMessage = authUrl
        ? result.browserOpen?.ok
          ? "已尝试打开系统浏览器；如果没有弹出，请手动打开下面的登录链接。"
          : `未能自动打开浏览器：${result.browserOpen?.message ?? "未知错误"}。请手动打开下面的登录链接。`
        : "登录请求已发送，但后端没有返回登录链接。请查看服务日志中的 account.login.started。";
      set({
        loginPending: false,
        loginAuthUrl: authUrl,
        loginId,
        loginMessage
      });
      if (!authUrl) {
        set({
          error: "登录请求没有返回可用的 authUrl，请检查后端日志。"
        });
      }
    } catch (error) {
      const loginError = normalizeLoginErrorMessage(error);
      set({
        loginPending: false,
        loginMessage: loginError,
        error: loginError
      });
      throw error;
    }
  },
  cancelLogin: async () => {
    const loginId = get().loginId;
    if (!loginId) {
      return;
    }
    await api.cancelLogin(loginId);
    set({
      loginPending: false,
      loginAuthUrl: null,
      loginId: null,
      loginMessage: "登录已取消。"
    });
  },
  logout: async () => {
    const account = await api.logout();
    writeSessionIdToUrl(null);
    set((state) =>
      state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              account
            },
            activeSessionId: null,
            loginPending: false,
            loginAuthUrl: null,
            loginId: null,
            loginMessage: null
          }
        : state
    );
  },
  refreshAppServerApps: async () => {
    const response = await api.appServerApps();
    set({
      appServerAppsRaw: JSON.stringify(response, null, 2)
    });
  },
  readPluginDetail: async (marketplacePath, pluginName) => {
    const response = await api.readPlugin(marketplacePath, pluginName);
    set({
      pluginReadRaw: JSON.stringify(response, null, 2)
    });
  },
  reloadMcpConfig: async () => {
    const response = await api.reloadMcpConfig();
    set({
      mcpReloadRaw: JSON.stringify(response, null, 2)
    });
  },
  execCommandDebug: async (command, cwd) => {
    const response = await api.execCommand(command, cwd);
    set({
      commandExecRaw: JSON.stringify(response, null, 2)
    });
  },
  readFsFileDebug: async (path) => {
    const response = await api.fsReadFile(path);
    set({
      fsDebugRaw: JSON.stringify(response, null, 2)
    });
  },
  readFsDirectoryDebug: async (path) => {
    const response = await api.fsReadDirectory(path);
    set({
      fsDebugRaw: JSON.stringify(response, null, 2)
    });
  },
  readFsMetadataDebug: async (path) => {
    const response = await api.fsMetadata(path);
    set({
      fsDebugRaw: JSON.stringify(response, null, 2)
    });
  },
  renameThread: async (threadId, name) => {
    await api.renameThread(threadId, name);
    set((state) =>
      state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              threads: state.snapshot.threads.map((thread) =>
                thread.id === threadId ? { ...thread, name } : thread
              )
            },
            threadDetail:
              state.threadDetail?.id === threadId
                ? { ...state.threadDetail, name }
                : state.threadDetail
          }
        : state
    );
  },
  archiveThread: async (threadId) => {
    await api.archiveThread(threadId);
    set((state) => {
      if (!state.snapshot) {
        return state;
      }
      const remainingThreads = state.snapshot.threads.filter((thread) => thread.id !== threadId);
      const nextSelectedThreadId = state.selectedThreadId === threadId ? remainingThreads[0]?.id ?? null : state.selectedThreadId;
      return {
        snapshot: {
          ...state.snapshot,
          threads: remainingThreads,
          loadedThreads: {
            ...state.snapshot.loadedThreads,
            loadedThreadIds: state.snapshot.loadedThreads.loadedThreadIds.filter((id) => id !== threadId)
          }
        },
        selectedThreadId: nextSelectedThreadId,
        threadDetail: state.threadDetail?.id === threadId ? null : state.threadDetail,
        threadDetailRefreshing: state.threadDetail?.id === threadId ? false : state.threadDetailRefreshing,
        activeTurnId: state.threadDetail?.id === threadId ? null : state.activeTurnId,
        liveDeltas:
          state.threadDetail?.id === threadId
            ? {}
            : state.liveDeltas
      };
    });
    const nextSelectedThreadId = get().selectedThreadId;
    if (nextSelectedThreadId) {
      await get().selectThread(nextSelectedThreadId);
    }
  },
  compactThread: async (threadId) => {
    await api.compactThread(threadId);
  },
  rollbackThread: async (threadId, turnCount = 1) => {
    const detail = await api.rollbackThread(threadId, turnCount);
    set((state) => ({
      snapshot: state.snapshot
        ? {
            ...state.snapshot,
            threads: state.snapshot.threads.map((thread) =>
              thread.id === threadId
                ? {
                    ...thread,
                    name: detail.name,
                    preview: detail.preview,
                    status: detail.status,
                    updatedAt: detail.updatedAt
                  }
                : thread
            )
          }
        : state.snapshot,
      threadDetail: state.threadDetail?.id === threadId ? detail : state.threadDetail,
      activeTurnId:
        state.threadDetail?.id === threadId
          ? detail.turns.find((turn) => turn.status === "inProgress")?.id ??
            detail.turns.at(-1)?.id ??
            null
          : state.activeTurnId
    }));
  },
  runThreadShellCommand: async (threadId, command, cwd) => {
    await api.runThreadShellCommand(threadId, command, cwd);
  },
  resolveApproval: async (approvalId, payload) => {
    await api.resolveApproval(approvalId, payload);
  },
  handleEvent: (event) => {
    if (event.type === "snapshot") {
      set({ snapshot: event.payload, bootstrapped: true });
      return;
    }

    if (event.type === "account.updated") {
      set((state) =>
        state.snapshot
          ? {
              snapshot: {
                ...state.snapshot,
                account: event.payload
              },
              ...(event.payload.loggedIn
                ? {
                    loginPending: false,
                    loginAuthUrl: null,
                    loginId: null,
                    loginMessage: null
                  }
                : {})
            }
          : state
      );
      if (event.payload.loggedIn) {
        void resolveActiveSession(get().snapshot, get().selectedThreadId).then((resolvedSession) => {
          set({ activeSessionId: resolvedSession?.sessionId ?? null });
          writeSessionIdToUrl(resolvedSession?.sessionId ?? null);
        });
      } else {
        set({ activeSessionId: null });
        writeSessionIdToUrl(null);
      }
      return;
    }

    if (event.type === "thread.status") {
      set((state) =>
        state.snapshot
          ? {
              snapshot: {
                ...state.snapshot,
                threads: state.snapshot.threads.map((thread) =>
                  thread.id === event.payload.threadId
                    ? { ...thread, status: event.payload.status }
                    : thread
                )
              },
              threadDetail:
                state.threadDetail?.id === event.payload.threadId
                  ? { ...state.threadDetail, status: event.payload.status }
                  : state.threadDetail
            }
          : state
      );
      return;
    }

    if (event.type === "thread.archived") {
      set((state) =>
        state.snapshot
          ? {
              snapshot: {
                ...state.snapshot,
                threads: state.snapshot.threads.filter((thread) => thread.id !== event.payload.threadId),
                loadedThreads: {
                  ...state.snapshot.loadedThreads,
                  loadedThreadIds: state.snapshot.loadedThreads.loadedThreadIds.filter(
                    (id) => id !== event.payload.threadId
                  )
                }
              },
              selectedThreadId:
                state.selectedThreadId === event.payload.threadId ? null : state.selectedThreadId,
              threadDetail:
                state.threadDetail?.id === event.payload.threadId ? null : state.threadDetail,
              activeTurnId:
                state.threadDetail?.id === event.payload.threadId ? null : state.activeTurnId,
              liveDeltas:
                state.threadDetail?.id === event.payload.threadId ? {} : state.liveDeltas
            }
          : state
      );
      return;
    }

    if (event.type === "thread.unarchived") {
      void get().refreshThreads();
      return;
    }

    if (event.type === "thread.named") {
      set((state) =>
        state.snapshot
          ? {
              snapshot: {
                ...state.snapshot,
                threads: state.snapshot.threads.map((thread) =>
                  thread.id === event.payload.threadId
                    ? { ...thread, name: event.payload.name }
                    : thread
                )
              },
              threadDetail:
                state.threadDetail?.id === event.payload.threadId
                  ? { ...state.threadDetail, name: event.payload.name }
                  : state.threadDetail
            }
          : state
      );
      return;
    }

    if (event.type === "approval.created") {
      set((state) =>
        state.snapshot
          ? {
              snapshot: {
                ...state.snapshot,
                approvals: [event.payload, ...state.snapshot.approvals]
              }
            }
          : state
      );
      return;
    }

    if (event.type === "approval.resolved") {
      set((state) =>
        state.snapshot
          ? {
              approvalHistory: [event.payload, ...state.approvalHistory].slice(0, 20),
              snapshot: {
                ...state.snapshot,
                approvals: state.snapshot.approvals.filter((entry) => entry.id !== event.payload.id)
              }
            }
          : state
      );
      return;
    }

    if (event.type === "item.delta") {
      set((state) => ({
        liveDeltas: {
          ...state.liveDeltas,
          [event.payload.itemId]: {
            ...state.liveDeltas[event.payload.itemId],
            stream: event.payload.stream,
            text: `${state.liveDeltas[event.payload.itemId]?.text ?? ""}${event.payload.delta}`,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            item: mergeLiveItemText(
              state.liveDeltas[event.payload.itemId]?.item ?? {
                id: event.payload.itemId,
                type: event.payload.stream === "assistant"
                  ? "agentMessage"
                  : event.payload.stream === "reasoning"
                    ? "reasoning"
                    : event.payload.stream === "command"
                      ? "commandExecution"
                      : "fileChange"
              },
              `${state.liveDeltas[event.payload.itemId]?.text ?? ""}${event.payload.delta}`
            )
          }
        }
      }));
      return;
    }

    if (event.type === "turn.started") {
      void get().refreshLoadedThreads();
      set({ activeTurnId: event.payload.turnId });
      if (event.payload.threadId === get().selectedThreadId) {
        void get().refreshCurrentThreadDetail(event.payload.threadId);
      }
      return;
    }

    if (event.type === "item.started" || event.type === "item.completed") {
      if (event.payload.item.type !== "userMessage") {
        set((state) => ({
          liveDeltas: {
            ...state.liveDeltas,
            [event.payload.item.id]: {
              stream:
                state.liveDeltas[event.payload.item.id]?.stream ??
                (event.payload.item.type === "commandExecution"
                  ? "command"
                  : event.payload.item.type === "fileChange"
                    ? "fileChange"
                    : event.payload.item.type === "reasoning"
                      ? "reasoning"
                      : "assistant"),
              text:
                event.payload.item.text ??
                event.payload.item.aggregatedOutput ??
                state.liveDeltas[event.payload.item.id]?.text ??
                "",
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              item: event.payload.item
            }
          }
        }));
      }
      if (event.payload.threadId === get().selectedThreadId) {
        set((state) => ({
          pendingPrompt:
            state.pendingPrompt?.threadId === event.payload.threadId ? null : state.pendingPrompt
        }));
        void get().refreshCurrentThreadDetail(event.payload.threadId);
      } else {
        void get().refreshThreads();
      }
      return;
    }

    if (event.type === "diff.updated") {
      if (event.payload.threadId === get().selectedThreadId) {
        void get().refreshCurrentThreadDetail(event.payload.threadId);
      }
      return;
    }

    if (event.type === "turn.completed") {
      if (event.payload.threadId === get().selectedThreadId) {
        void get().refreshCurrentThreadDetail(event.payload.threadId);
      }
      set((state) => ({
        activeTurnId: null,
        liveDeltas: {},
        pendingPrompt:
          state.pendingPrompt?.threadId === event.payload.threadId ? null : state.pendingPrompt
      }));
      void get().refreshLoadedThreads();
      return;
    }

    if (event.type === "thread.started") {
      void get().refreshLoadedThreads();
      return;
    }

    if (event.type === "server.status") {
      set((state) =>
        state.snapshot
          ? {
              snapshot: {
                ...state.snapshot,
                settings: {
                  ...state.snapshot.settings,
                  codexArgs: state.snapshot.settings.codexArgs ?? [],
                  effectiveCodexHomeDir:
                    state.snapshot.settings.effectiveCodexHomeDir ??
                    state.snapshot.settings.codexHomeDir ??
                    "~/.codex",
                  codexConfigOverrideSources: state.snapshot.settings.codexConfigOverrideSources ?? [],
                  appServerConnected: event.payload.connected,
                  appServerStatus: event.payload.status
                } as SettingsSummary
              }
            }
          : state
      );
      return;
    }

    if (event.type === "error") {
      set({ error: event.payload.message });
    }
  }
}));

export function approvalPendingList(snapshot: SnapshotPayload | null): ApprovalRequest[] {
  return snapshot?.approvals ?? [];
}

