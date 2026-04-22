import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  FileCode,
  FileText,
  Files,
  Languages,
  LogOut,
  Monitor,
  Moon,
  MessageSquare,
  PanelRightOpen,
  Settings,
  Sun,
  User,
  X
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { ApprovalDrawer } from "./components/ApprovalDrawer";
import { ChatView } from "./components/ChatView";
import { DiffViewer } from "./components/DiffViewer";
import { FileEditorTab } from "./components/FileEditorTab";
import { FilesPanel } from "./components/FilesPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { ThreadSidebar } from "./components/ThreadSidebar";
import { WorkspaceSelector } from "./components/WorkspaceSelector";
import { useAppStore } from "./store";
import { cn } from "./lib/utils";
import { isThreadInWorkspace } from "./lib/workspace";
import type { SlashCommandId } from "./lib/composer";

type RightTab = "diff" | "approvals" | "settings";
type LeftTab = "threads" | "workspace" | "account" | "files" | null;
type ThemeMode = "dark" | "light";
type LanguageMode = "zh" | "en";
type SettingsSection = "overview" | "skills" | "plugins" | "models" | "modes" | "experimental";
type FileOpenMode = "preview" | "pinned";
type CenterTab =
  | { id: "chat"; type: "chat"; title: string }
  | { id: string; type: "file"; title: string; path: string; pinned: boolean };

export default function App() {
  const [rightTab, setRightTab] = useState<RightTab>("diff");
  const [leftTab, setLeftTab] = useState<LeftTab>("threads");
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [language, setLanguage] = useState<LanguageMode>("zh");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("overview");
  const [centerTabs, setCenterTabs] = useState<CenterTab[]>([{ id: "chat", type: "chat", title: "Chat" }]);
  const [activeCenterTabId, setActiveCenterTabId] = useState("chat");
  const {
    bootstrapped,
    loading,
    error,
    snapshot,
    loginPending,
    loginAuthUrl,
    loginId,
    loginMessage,
    appServerAppsRaw,
    pluginReadRaw,
    mcpReloadRaw,
    commandExecRaw,
    fsDebugRaw,
    approvalHistory,
    selectedThreadId,
    threadDetail,
    threadDetailRefreshing,
    liveDeltas,
    pendingPrompt,
    bootstrap,
    selectThread,
    createThread,
    refreshLoadedThreads,
    refreshAppServerCatalog,
    refreshAppServerApps,
    readPluginDetail,
    reloadMcpConfig,
    execCommandDebug,
    readFsFileDebug,
    readFsDirectoryDebug,
    readFsMetadataDebug,
    sendPrompt,
    interruptTurn,
    pickWorkspace,
    selectWorkspace,
    renameThread,
    archiveThread,
    compactThread,
    rollbackThread,
    runThreadShellCommand,
    resolveApproval,
    handleEvent,
    login,
    cancelLogin,
    logout
  } = useAppStore();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    document.documentElement.classList.remove("theme-dark", "theme-light");
    document.documentElement.classList.add(theme === "dark" ? "theme-dark" : "theme-light");
  }, [theme]);

  useEffect(() => {
    if (!bootstrapped) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socket.onmessage = (event) => {
        handleEvent(JSON.parse(event.data));
      };
      socket.onclose = () => {
        if (disposed) return;
        reconnectTimer = window.setTimeout(connect, 1000);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [bootstrapped, handleEvent]);

  const t = useMemo(
    () =>
      language === "zh"
        ? {
            currentWorkspace: "当前工作区",
            notSelected: "未选择",
            workspace: "工作区列表",
            threads: "线程",
            account: "账户",
            accountLogout: "退出登录",
            accountLogin: "使用 ChatGPT 登录",
            notLoggedIn: "未登录",
            accountMode: "模式",
            accountPlan: "套餐",
            accountReady: "已登录",
            tabs: {
              diff: "文件变更",
              approvals: "待审批项",
              settings: "设置"
            }
          }
        : {
            currentWorkspace: "Workspace",
            notSelected: "None",
            workspace: "Workspaces",
            threads: "Threads",
            account: "Account",
            accountLogout: "Sign Out",
            accountLogin: "Sign In with ChatGPT",
            notLoggedIn: "Signed Out",
            accountMode: "Mode",
            accountPlan: "Plan",
            accountReady: "Signed In",
            tabs: {
              diff: "Diff",
              approvals: "Approvals",
              settings: "Settings"
            }
          },
    [language]
  );

  const toggleLeftTab = (tab: LeftTab) => {
    setLeftTab((prev) => (prev === tab ? null : tab));
  };

  const loginMessageText = loginMessage ?? "";
  const showLoginHelpLink =
    Boolean(loginMessage) &&
    (loginMessageText.includes("localhost:1455") ||
      loginMessageText.includes("API key 登录") ||
      loginMessageText.includes("登录回调服务"));

  const handleSlashCommand = (command: SlashCommandId) => {
    if (command === "new") {
      void createThread();
      return;
    }
    if (command === "approvals") {
      setRightTab("approvals");
      return;
    }
    if (command === "diff") {
      setRightTab("diff");
      return;
    }
    if (command === "settings") {
      setRightTab("settings");
      setSettingsSection("overview");
      return;
    }
    if (command === "plugins") {
      setRightTab("settings");
      setSettingsSection("plugins");
      return;
    }
    if (command === "models") {
      setRightTab("settings");
      setSettingsSection("models");
      return;
    }
    if (command === "modes") {
      setRightTab("settings");
      setSettingsSection("modes");
      return;
    }
    if (command === "experimental") {
      setRightTab("settings");
      setSettingsSection("experimental");
      return;
    }
    if (command === "compact") {
      if (!selectedThreadId) {
        return;
      }
      void compactThread(selectedThreadId);
      return;
    }
    if (command === "rollback") {
      if (!selectedThreadId) {
        return;
      }
      const raw = window.prompt("Rollback how many turns?", "1");
      if (raw === null) {
        return;
      }
      const turnCount = Number(raw);
      if (!Number.isFinite(turnCount) || turnCount <= 0) {
        return;
      }
      void rollbackThread(selectedThreadId, Math.floor(turnCount));
      return;
    }
    if (command === "shell") {
      if (!selectedThreadId) {
        return;
      }
      const commandText = window.prompt("Run shell command in current thread");
      if (!commandText?.trim()) {
        return;
      }
      void runThreadShellCommand(selectedThreadId, commandText.trim(), threadDetail?.cwd ?? null);
      return;
    }
    if (command === "runtime") {
      return;
    }
  };

  if (loading && !snapshot) {
    return <div className="flex h-screen w-full items-center justify-center bg-chat-bg text-sm text-text-secondary">启动中...</div>;
  }

  if (!snapshot) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-chat-bg">
        <div className="glass-panel p-6 text-sm text-text-primary rounded-xl">
          后端未返回初始化数据。
          <div className="mt-2 text-red-500">{error}</div>
        </div>
      </div>
    );
  }

  const activeTurnId =
    threadDetail?.turns.find((turn) => turn.status === "inProgress")?.id ??
    threadDetail?.turns.at(-1)?.id ??
    null;

  const currentWorkspace = snapshot.workspace.current;
  const workspaceLabel = currentWorkspace ?? threadDetail?.cwd;
  const projectName = workspaceLabel ? workspaceLabel.split("/").pop() : t.notSelected;
  const accountName = snapshot.account.email?.split("@")[0] || "Codex User";
  const rateLimits = snapshot.account.rateLimits;
  const formatResetAt = (resetsAt?: number | null) =>
    resetsAt ? new Date(resetsAt * 1000).toLocaleString("zh-CN") : null;
  const formatRateLimitWindow = (
    window?: {
      used?: number | null;
      limit?: number | null;
      usedPercent?: number | null;
      resetsAt?: number | null;
    } | null
  ) => {
    if (!window) {
      return "-";
    }
    if (window.usedPercent != null) {
      return `${Math.max(0, 100 - window.usedPercent)}%`;
    }
    if (window.used != null && window.limit != null) {
      return `${window.used}/${window.limit}`;
    }
    const resetLabel = formatResetAt(window.resetsAt);
    return resetLabel ? `重置于 ${resetLabel}` : "-";
  };
  const workspaceThreads = currentWorkspace
    ? snapshot.threads.filter((thread) => isThreadInWorkspace(thread.cwd, currentWorkspace))
    : snapshot.threads;
  const activeCenterTab = centerTabs.find((tab) => tab.id === activeCenterTabId) ?? centerTabs[0];
  const openFileTab = (file: { path: string; name: string }, mode: FileOpenMode = "preview") => {
    const pinnedTabId = `file:${file.path}`;
    const existingPinnedTab = centerTabs.find((tab) => tab.type === "file" && tab.path === file.path && tab.pinned);
    const nextActiveTabId = existingPinnedTab?.id ?? (mode === "pinned" ? pinnedTabId : "file-preview");
    setCenterTabs((tabs) => {
      if (existingPinnedTab) {
        return tabs;
      }
      if (mode === "preview") {
        const previewTab = {
          id: "file-preview",
          type: "file" as const,
          title: file.name,
          path: file.path,
          pinned: false
        };
        return tabs.some((tab) => tab.id === "file-preview")
          ? tabs.map((tab) => (tab.id === "file-preview" ? previewTab : tab))
          : [...tabs, previewTab];
      }
      return [
        ...tabs.filter((tab) => !(tab.id === "file-preview" && tab.type === "file" && tab.path === file.path)),
        {
          id: pinnedTabId,
          type: "file",
          title: file.name,
          path: file.path,
          pinned: true
        }
      ];
    });
    setActiveCenterTabId(nextActiveTabId);
  };
  const promoteFileTab = (path: string) => {
    const pinnedTabId = `file:${path}`;
    setCenterTabs((tabs) => {
      if (tabs.some((tab) => tab.id === pinnedTabId)) {
        return tabs.filter((tab) => tab.id !== "file-preview" || tab.type !== "file" || tab.path !== path);
      }
      return tabs.map((tab) =>
        tab.id === "file-preview" && tab.type === "file" && tab.path === path
          ? {
              ...tab,
              id: pinnedTabId,
              pinned: true
            }
          : tab
      );
    });
    setActiveCenterTabId(pinnedTabId);
  };
  const closeCenterTab = (tabId: string) => {
    if (tabId === "chat") {
      return;
    }
    setCenterTabs((tabs) => {
      const nextTabs = tabs.filter((tab) => tab.id !== tabId);
      if (activeCenterTabId === tabId) {
        const closedIndex = tabs.findIndex((tab) => tab.id === tabId);
        const fallback = nextTabs[Math.max(0, closedIndex - 1)] ?? nextTabs[0];
        setActiveCenterTabId(fallback?.id ?? "chat");
      }
      return nextTabs.length > 0 ? nextTabs : [{ id: "chat", type: "chat", title: "Chat" }];
    });
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-chat-bg text-text-primary theme-transition">
      
      {/* Sidebar Area */}
      <div className="flex h-full shrink-0">
        
        {/* VS Code Vertical Icon Bar */}
        <div className="w-12 h-full bg-sidebar border-r border-border flex flex-col items-center py-4 gap-4 z-20">
          <button 
            onClick={() => toggleLeftTab("files")}
            className={cn(
              "p-2 transition-colors hover:text-text-primary",
              leftTab === "files" ? "text-accent border-l-2 border-accent" : "text-text-secondary"
            )}
            title="Files"
          >
            <Files size={24} />
          </button>
          <button 
            onClick={() => toggleLeftTab("threads")}
            className={cn(
              "p-2 transition-colors hover:text-text-primary",
              leftTab === "threads" ? "text-accent border-l-2 border-accent" : "text-text-secondary"
            )}
            title={t.threads}
          >
            <MessageSquare size={24} />
          </button>
          <button 
            onClick={() => toggleLeftTab("workspace")}
            className={cn(
              "p-2 transition-colors hover:text-text-primary",
              leftTab === "workspace" ? "text-accent border-l-2 border-accent" : "text-text-secondary"
            )}
            title={t.workspace}
          >
            <Monitor size={24} />
          </button>
          <button 
            onClick={() => toggleLeftTab("account")}
            className={cn(
              "p-2 transition-colors hover:text-text-primary",
              leftTab === "account" ? "text-accent border-l-2 border-accent" : "text-text-secondary"
            )}
            title={t.account}
          >
            <User size={24} />
          </button>
          
          <div className="mt-auto flex flex-col gap-4">
            <button 
              onClick={() => {
                setRightTab("settings");
                setSettingsSection("overview");
              }}
              className="p-2 text-text-secondary hover:text-text-primary transition-colors"
              title={t.tabs.settings}
            >
              <Settings size={24} />
            </button>
          </div>
        </div>

        {/* Collapsible Panel */}
        <AnimatePresence initial={false}>
          {leftTab && (
            <motion.div 
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 256, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              className="h-full bg-panel-bg border-r border-border flex flex-col shadow-xl overflow-hidden z-10 shrink-0"
            >
              <div className="w-64 h-full flex flex-col">
                <div className="flex-1 overflow-y-auto w-full no-scrollbar pb-6 p-4">
              
              {leftTab === "files" && (
                <FilesPanel rootPath={currentWorkspace} onOpenFile={openFileTab} />
              )}

              {leftTab === "threads" && (
                <ThreadSidebar
                  threads={workspaceThreads}
                  loadedThreadIds={snapshot.loadedThreads.loadedThreadIds}
                  loadedRefreshedAt={snapshot.loadedThreads.refreshedAt}
                  selectedThreadId={selectedThreadId}
                  onCreate={() => void createThread()}
                  onRefreshLatest={() => void refreshLoadedThreads()}
                  onSelect={(threadId) => void selectThread(threadId)}
                  onRename={(threadId) => {
                    const thread = snapshot.threads.find((entry) => entry.id === threadId);
                    const nextName = window.prompt("Rename thread", thread?.name ?? thread?.preview ?? "");
                    if (nextName === null) {
                      return;
                    }
                    void renameThread(threadId, nextName.trim() || null);
                  }}
                  onArchive={(threadId) => {
                    const confirmed = window.confirm("Archive this thread?");
                    if (!confirmed) {
                      return;
                    }
                    void archiveThread(threadId);
                  }}
                />
              )}

              {leftTab === "workspace" && (
                    <WorkspaceSelector
                      workspace={snapshot.workspace}
                      allowedRoots={snapshot.settings.allowedWorkspaces}
                      onPick={() => pickWorkspace()}
                      onSelect={(path) => selectWorkspace(path)}
                    />
              )}

              {leftTab === "account" && (
                <div className="space-y-4">
                  <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">User Profile</h3>
                  <div className="bg-white/5 rounded-lg p-4 border border-border">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center text-accent font-bold">
                        {accountName.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary truncate">{accountName}</p>
                        <p className="text-xs text-text-secondary truncate">{snapshot.account.email ?? t.notLoggedIn}</p>
                      </div>
                    </div>
                    
                    <div className="mt-4 space-y-2 text-xs text-text-secondary mb-4 pb-4 border-b border-border">
                       <div className="flex justify-between"><span>{t.accountMode}:</span> <span>{snapshot.account.mode}</span></div>
                       <div className="flex justify-between"><span>{t.accountPlan}:</span> <span>{snapshot.account.planType ?? "-"}</span></div>
                       <div className="flex justify-between"><span>主额度</span> <span>{formatRateLimitWindow(rateLimits?.primary)}</span></div>
                       <div className="flex justify-between"><span>主额度重置</span> <span>{formatResetAt(rateLimits?.primary?.resetsAt) ?? "-"}</span></div>
                       <div className="flex justify-between"><span>副额度</span> <span>{formatRateLimitWindow(rateLimits?.secondary)}</span></div>
                       <div className="flex justify-between"><span>副额度重置</span> <span>{formatResetAt(rateLimits?.secondary?.resetsAt) ?? "-"}</span></div>
                       <div className="flex justify-between"><span>Credits:</span> <span>{rateLimits?.creditsRemaining ?? "-"}</span></div>
                    </div>

                    {snapshot.account.loggedIn ? (
                      <button 
                        onClick={() => void logout()}
                        className="w-full flex items-center justify-center gap-2 py-2 text-sm text-red-400 hover:bg-red-400/10 rounded transition-colors"
                      >
                        <LogOut size={16} />
                        {t.accountLogout}
                      </button>
                    ) : (
                      <div className="space-y-3">
                        <button
                          onClick={() => void login()}
                          disabled={loginPending}
                          className="w-full flex items-center justify-center gap-2 py-2 text-sm bg-accent text-white hover:bg-accent/80 rounded transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {loginPending ? "Starting login..." : t.accountLogin}
                        </button>
                        {loginMessage && (
                          <div className="rounded border border-white/10 bg-white/5 px-3 py-2 text-xs text-text-secondary space-y-2">
                            <div>{loginMessage}</div>
                            {showLoginHelpLink && (
                              <button
                                onClick={() => window.open("/help/windows-login-10013", "_blank", "noopener,noreferrer")}
                                className="w-full rounded bg-white/5 px-3 py-2 text-left text-text-primary hover:bg-white/10"
                              >
                                查看处理说明
                              </button>
                            )}
                          </div>
                        )}
                        {loginAuthUrl && (
                          <div className="rounded border border-accent/20 bg-accent/5 p-3 text-xs text-text-secondary space-y-2">
                            <p className="text-text-primary">Login link is ready.</p>
                            <button
                              onClick={() => window.open(loginAuthUrl, "_blank", "noopener,noreferrer")}
                              className="w-full rounded bg-white/5 px-3 py-2 text-left text-text-primary hover:bg-white/10"
                            >
                              Open login link
                            </button>
                            <button
                              onClick={() => void navigator.clipboard.writeText(loginAuthUrl)}
                              className="w-full rounded bg-white/5 px-3 py-2 text-left hover:bg-white/10"
                            >
                              Copy login link
                            </button>
                            {loginId && (
                              <button
                                onClick={() => void cancelLogin()}
                                className="w-full rounded bg-red-500/10 px-3 py-2 text-left text-red-300 hover:bg-red-500/20"
                              >
                                Cancel login
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  </div>

      <main className="flex-1 flex flex-col min-w-0">
        
        {/* Header */}
        <header className="h-12 border-b border-border flex items-center justify-between px-6 bg-sidebar/50 backdrop-blur-sm z-10 shrink-0">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-text-secondary">{t.currentWorkspace}:</span>
            <span className="font-medium text-accent truncate">{projectName}</span>
            <span className="text-border mx-2">|</span>
            <span className="text-text-secondary truncate max-w-[200px] hidden sm:inline">{workspaceLabel}</span>
          </div>

          <div className="flex items-center gap-4">
            <button 
              onClick={() => setLanguage((value) => (value === "zh" ? "en" : "zh"))}
              className="p-2 text-text-secondary hover:text-accent transition-colors flex items-center gap-1 text-xs uppercase"
            >
              <Languages size={16} />
              {language}
            </button>
            <button 
              onClick={() => setTheme((value) => (value === "dark" ? "light" : "dark"))}
              className="p-2 text-text-secondary hover:text-accent transition-colors"
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>

        {/* Content Body */}
        <div className="flex-1 flex min-h-0 min-w-0">
          
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="h-11 shrink-0 border-b border-border bg-sidebar/40 px-2 flex items-end gap-1 overflow-x-auto no-scrollbar">
                {centerTabs.map((tab) => (
                  <div
                    key={tab.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setActiveCenterTabId(tab.id)}
                    onAuxClick={(event) => {
                      if (event.button === 1 && tab.type === "file") {
                        event.preventDefault();
                        closeCenterTab(tab.id);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setActiveCenterTabId(tab.id);
                      }
                    }}
                    className={cn(
                      "group mb-1 flex max-w-[220px] cursor-pointer items-center gap-2 rounded-t-lg border border-transparent px-3 py-1.5 text-xs transition-colors",
                      activeCenterTab?.id === tab.id
                        ? "border-border bg-bg text-text-primary"
                        : "text-text-secondary hover:bg-white/5 hover:text-text-primary"
                    )}
                    title={tab.type === "file" ? tab.path : tab.title}
                  >
                    {tab.type === "chat" ? <MessageSquare size={14} /> : <FileText size={14} />}
                    <span className={cn("truncate", tab.type === "file" && !tab.pinned && "italic")}>
                      {tab.title}
                    </span>
                    {tab.type === "file" ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          closeCenterTab(tab.id);
                        }}
                        className="rounded p-0.5 opacity-60 hover:bg-white/10 hover:opacity-100"
                        title="Close"
                      >
                        <X size={12} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="min-h-0 flex-1">
                {activeCenterTab?.type === "file" ? (
                  <FileEditorTab
                    key={activeCenterTab.path}
                    path={activeCenterTab.path}
                    name={activeCenterTab.title}
                    preview={!activeCenterTab.pinned}
                    onPromote={() => promoteFileTab(activeCenterTab.path)}
                  />
                ) : (
                  <ChatView
                    detail={threadDetail}
                    liveDeltas={liveDeltas}
                    pendingPrompt={
                      pendingPrompt && pendingPrompt.threadId === selectedThreadId
                        ? pendingPrompt.prompt
                        : null
                    }
                    detailRefreshing={threadDetailRefreshing}
                    onSend={sendPrompt}
                    onInterrupt={() => {
                      void interruptTurn();
                    }}
                    onSlashCommand={handleSlashCommand}
                    language={language}
                    workspaceName={projectName}
                    canSend={Boolean(selectedThreadId)}
                    sending={Boolean(pendingPrompt && pendingPrompt.threadId === selectedThreadId)}
                    appServerCatalog={snapshot.appServerCatalog}
                  />
                )}
              </div>
          </div>

          <aside className="hidden xl:flex w-[42%] flex-shrink-0 bg-sidebar border-l border-border flex-col shadow-inner min-w-0">
            <div className="h-12 border-b border-border flex items-center px-2 gap-1 overflow-x-auto no-scrollbar bg-sidebar/50 shrink-0">
              <button
                className={cn(
                   "flex items-center gap-2 px-3 py-1.5 rounded text-xs whitespace-nowrap transition-colors",
                   rightTab === "diff" ? "bg-accent/10 text-accent" : "text-text-secondary hover:bg-white/5 hover:text-text-primary"
                )}
                onClick={() => setRightTab("diff")}
              >
                <FileCode size={14} />
                <span>{t.tabs.diff}</span>
              </button>
              <button
                className={cn(
                   "flex items-center gap-2 px-3 py-1.5 rounded text-xs whitespace-nowrap transition-colors",
                   rightTab === "approvals" ? "bg-accent/10 text-accent" : "text-text-secondary hover:bg-white/5 hover:text-text-primary"
                )}
                onClick={() => setRightTab("approvals")}
              >
                <PanelRightOpen size={14} />
                <span>{t.tabs.approvals}</span>
              </button>
              <button
                className={cn(
                   "flex items-center gap-2 px-3 py-1.5 rounded text-xs whitespace-nowrap transition-colors",
                   rightTab === "settings" ? "bg-accent/10 text-accent" : "text-text-secondary hover:bg-white/5 hover:text-text-primary"
                )}
                onClick={() => {
                  setRightTab("settings");
                  setSettingsSection("overview");
                }}
              >
                <Settings size={14} />
                <span>{t.tabs.settings}</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar font-mono text-[11px] leading-relaxed p-4">
              {rightTab === "diff" ? <DiffViewer threadId={threadDetail?.id ?? null} turnId={activeTurnId} /> : null}
              {rightTab === "approvals" ? (
                <ApprovalDrawer
                  approvals={snapshot.approvals}
                  history={approvalHistory}
                  onResolve={(id, payload) => void resolveApproval(id, payload)}
                />
              ) : null}
              {rightTab === "settings" ? (
              <SettingsPanel 
                settings={snapshot.settings}
                catalog={snapshot.appServerCatalog}
                activeSection={settingsSection}
                onSectionChange={setSettingsSection}
                onRefreshCatalog={() => void refreshAppServerCatalog()}
                onRefreshApps={() => void refreshAppServerApps()}
                onReloadMcp={() => void reloadMcpConfig()}
                onReadPlugin={() => {
                  const plugin = snapshot.appServerCatalog.plugins[0];
                  if (!plugin) {
                    return;
                  }
                  void readPluginDetail(".", plugin.name);
                }}
                onExecCommand={(command, cwd) => {
                  if (!command.trim()) {
                    return;
                  }
                  void execCommandDebug(command.trim(), cwd);
                }}
                onReadFsFile={(path) => {
                  if (!path.trim()) {
                    return;
                  }
                  void readFsFileDebug(path.trim());
                }}
                onReadFsDirectory={(path) => {
                  if (!path.trim()) {
                    return;
                  }
                  void readFsDirectoryDebug(path.trim());
                }}
                onReadFsMetadata={(path) => {
                  if (!path.trim()) {
                    return;
                  }
                  void readFsMetadataDebug(path.trim());
                }}
                appServerAppsRaw={appServerAppsRaw}
                pluginReadRaw={pluginReadRaw}
                mcpReloadRaw={mcpReloadRaw}
                commandExecRaw={commandExecRaw}
                fsDebugRaw={fsDebugRaw}
              />
              ) : null}
            </div>
          </aside>
          
        </div>
      </main>

    </div>
  );
}

