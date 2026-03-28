import { create } from "zustand";
import type {
  ApprovalDecision,
  ApprovalRequest,
  FrontendEvent,
  SettingsSummary,
  SnapshotPayload,
  ThreadDetail,
  ThreadSummary
} from "./shared";
import { api } from "./api";
import { isThreadInWorkspace } from "./lib/workspace";

type DeltaMap = Record<string, { stream: string; text: string; threadId: string; turnId: string }>;
type PendingPrompt = { threadId: string; prompt: string } | null;

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

interface AppState {
  loading: boolean;
  bootstrapped: boolean;
  error: string | null;
  snapshot: SnapshotPayload | null;
  approvalHistory: ApprovalRequest[];
  selectedThreadId: string | null;
  threadDetail: ThreadDetail | null;
  liveDeltas: DeltaMap;
  activeTurnId: string | null;
  pendingPrompt: PendingPrompt;
  setError(error: string | null): void;
  bootstrap(): Promise<void>;
  refreshThreads(): Promise<void>;
  refreshLoadedThreads(): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  createThread(): Promise<void>;
  sendPrompt(prompt: string): Promise<void>;
  interruptTurn(): Promise<void>;
  addWorkspace(path: string): Promise<void>;
  selectWorkspace(path: string): Promise<void>;
  login(): Promise<void>;
  logout(): Promise<void>;
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

export const useAppStore = create<AppState>((set, get) => ({
  loading: false,
  bootstrapped: false,
  error: null,
  snapshot: null,
  approvalHistory: [],
  selectedThreadId: null,
  threadDetail: null,
  liveDeltas: {},
  activeTurnId: null,
  pendingPrompt: null,
  setError: (error) => set({ error }),
  bootstrap: async () => {
    set({ loading: true, error: null });
    try {
      const snapshot = await api.bootstrap();
      const preferredThread = snapshot.workspace.current
        ? latestThreadForWorkspace(snapshot.threads, snapshot.workspace.current) ?? snapshot.threads[0] ?? null
        : snapshot.threads[0] ?? null;
      set({
        loading: false,
        bootstrapped: true,
        snapshot,
        approvalHistory: [],
        selectedThreadId: preferredThread?.id ?? null
      });
      if (preferredThread?.id) {
        await get().selectThread(preferredThread.id);
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
  selectThread: async (threadId) => {
    set({ selectedThreadId: threadId, error: null });
    try {
      const detail = await api.threadDetail(threadId);
      set((state) => ({
        selectedThreadId: threadId,
        threadDetail: detail,
        activeTurnId:
          detail.turns.find((turn) => turn.status === "inProgress")?.id ??
          detail.turns.at(-1)?.id ??
          null,
        pendingPrompt:
          state.pendingPrompt && state.pendingPrompt.threadId === threadId && detailContainsPrompt(detail, state.pendingPrompt.prompt)
            ? null
            : state.pendingPrompt
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const summary = get().snapshot?.threads.find((entry) => entry.id === threadId) ?? null;
      if (message.includes("is not materialized yet") && summary) {
        set((state) => ({
          threadDetail: emptyDetailFromSummary(summary),
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
    const threadId = get().selectedThreadId;
    if (!threadId) {
      await get().createThread();
    }
    const currentThreadId = get().selectedThreadId;
    if (!currentThreadId) {
      throw new Error("无法创建线程");
    }
    set({ error: null, pendingPrompt: { threadId: currentThreadId, prompt: trimmedPrompt } });
    try {
      const result = await api.sendPrompt(currentThreadId, trimmedPrompt);
      set({ activeTurnId: result.turnId });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("thread not found")) {
        set({ pendingPrompt: null, error: message });
        throw error;
      }

      await get().createThread();
      const fallbackThreadId = get().selectedThreadId;
      if (!fallbackThreadId) {
        set({ pendingPrompt: null, error: message });
        throw error;
      }

      set({ pendingPrompt: { threadId: fallbackThreadId, prompt: trimmedPrompt } });
      try {
        const retry = await api.sendPrompt(fallbackThreadId, trimmedPrompt);
        set({ activeTurnId: retry.turnId, error: null });
      } catch (retryError) {
        set({
          pendingPrompt: null,
          error: retryError instanceof Error ? retryError.message : String(retryError)
        });
        throw retryError;
      }
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
      threadDetail: null,
      activeTurnId: null,
      liveDeltas: {}
    });
  },
  login: async () => {
    await api.login();
  },
  logout: async () => {
    const account = await api.logout();
    set((state) =>
      state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              account
            }
          }
        : state
    );
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
              }
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
            stream: event.payload.stream,
            text: `${state.liveDeltas[event.payload.itemId]?.text ?? ""}${event.payload.delta}`,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId
          }
        }
      }));
      return;
    }

    if (event.type === "turn.started") {
      void get().refreshLoadedThreads();
      set({ activeTurnId: event.payload.turnId });
      if (event.payload.threadId === get().selectedThreadId) {
        void get().selectThread(event.payload.threadId);
      }
      return;
    }

    if (event.type === "item.started" || event.type === "item.completed") {
      if (event.payload.threadId === get().selectedThreadId) {
        set((state) => ({
          pendingPrompt:
            state.pendingPrompt?.threadId === event.payload.threadId ? null : state.pendingPrompt
        }));
        void get().selectThread(event.payload.threadId);
      } else {
        void get().refreshThreads();
      }
      return;
    }

    if (event.type === "diff.updated") {
      if (event.payload.threadId === get().selectedThreadId) {
        void get().selectThread(event.payload.threadId);
      }
      return;
    }

    if (event.type === "turn.completed") {
      if (event.payload.threadId === get().selectedThreadId) {
        void get().selectThread(event.payload.threadId);
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
