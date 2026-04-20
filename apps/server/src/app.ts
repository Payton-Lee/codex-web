import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import express, { Request, Response } from "express";
import { WebSocketServer } from "ws";
import {
  AccountSummary,
  AppServerCatalog,
  ApprovalRequest,
  ApprovalResolution,
  DiffPreview,
  FrontendEvent,
  LoadedThreadsSummary,
  McpComposerSuggestions,
  SettingsSummary,
  SnapshotPayload,
  ThreadDetail,
  ThreadItem,
  ThreadStatus,
  ThreadSummary
} from "../../../packages/shared/src/index.js";
import { appConfig } from "./config.js";
import { AuditLogger } from "./logger.js";
import { WorkspaceGuard } from "./workspace-guard.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { openSystemBrowser } from "./open-browser.js";
import { openFolderDialog } from "./open-folder-dialog.js";
import { buildDiffPreview } from "./diff-preview.js";
import { searchSkills, searchWorkspaceFiles } from "./composer.js";
import { SessionStore } from "./session-store.js";

type JsonRpcServerRequest = {
  id: string | number;
  method: string;
  params?: any;
};

type JsonRpcNotification = {
  method: string;
  params?: any;
};

const ALL_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown"
] as const;

function normalizeThreadStatus(
  candidate: unknown,
  fallback: ThreadStatus = "idle"
): ThreadStatus {
  switch (candidate) {
    case "notLoaded":
    case "idle":
    case "inProgress":
    case "completed":
    case "failed":
    case "interrupted":
      return candidate;
    default:
      return fallback;
  }
}

function toThreadSummary(thread: any, fallbackStatus: ThreadSummary["status"] = "idle"): ThreadSummary {
  return {
    id: thread.id,
    name: typeof thread.name === "string" ? thread.name : null,
    preview: thread.preview,
    cwd: thread.cwd,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    modelProvider: thread.modelProvider,
    cliVersion: thread.cliVersion,
    source: thread.source,
    status: normalizeThreadStatus(thread.status, fallbackStatus)
  };
}

function normalizeChangeKind(kind: unknown): string {
  if (typeof kind === "string") {
    return kind;
  }
  if (!kind || typeof kind !== "object") {
    return "unknown";
  }

  const candidate = kind as { type?: unknown; move_path?: unknown };
  const type = typeof candidate.type === "string" ? candidate.type : "unknown";
  const movePath = typeof candidate.move_path === "string" && candidate.move_path.length > 0
    ? ` -> ${candidate.move_path}`
    : "";
  return `${type}${movePath}`;
}

function toThreadItem(item: any): ThreadItem {
  return {
    id: item.id,
    type: item.type,
    text: item.text,
    summary: item.summary,
    content: item.content,
    command: item.command,
    cwd: item.cwd,
    aggregatedOutput: item.aggregatedOutput,
    status: item.status,
    changes: (item.changes ?? []).map((change: any) => ({
      path: change.path,
      kind: normalizeChangeKind(change.kind),
      diff: change.diff
    })),
    tool: item.tool,
    server: item.server,
    result: item.result,
    error: item.error
  };
}

function toThreadDetail(thread: any, status: ThreadSummary["status"]): ThreadDetail {
  return {
    ...toThreadSummary(thread, status),
    turns: (thread.turns ?? []).map((turn: any) => ({
      id: turn.id,
      status: turn.status,
      error: turn.error?.message ?? null,
      items: (turn.items ?? []).map(toThreadItem)
    }))
  };
}

function isThreadNotMaterializedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("is not materialized yet");
}

function isThreadNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("thread not found");
}

function isAppServerUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Codex app-server") && message.includes("尚未启动");
}

function isLoginServerPortBlockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("failed to start login server") &&
    (message.includes("10013") || message.includes("访问权限不允许"))
  );
}

function loginServerPortBlockedMessage(): string {
  return "无法启动 ChatGPT 登录回调服务。Windows 当前阻止了 localhost:1455（常见于系统保留端口/Hyper-V/WSL/Docker/VPN 占用）。请避免退出当前登录态，或改用 API key 登录。";
}

function loginHelpDocPath(): string {
  return path.join(appConfig.rootDir, "docs", "Windows 登录失败 10013 处理提示.md");
}

function normalizeLoginStartResponse(login: any): {
  authUrl: string | null;
  loginId: string | null;
  browserOpen: { ok: boolean; message: string } | null;
  raw: any;
} {
  const authUrlCandidates = [
    login?.authUrl,
    login?.auth_url,
    login?.url,
    login?.loginUrl,
    login?.login_url,
    login?.data?.authUrl,
    login?.data?.auth_url,
    login?.data?.url,
    login?.data?.loginUrl,
    login?.data?.login_url
  ];
  const loginIdCandidates = [
    login?.loginId,
    login?.login_id,
    login?.id,
    login?.data?.loginId,
    login?.data?.login_id,
    login?.data?.id
  ];

  const authUrl =
    authUrlCandidates.find((entry) => typeof entry === "string" && entry.trim().length > 0)?.trim() ?? null;
  const loginId =
    loginIdCandidates.find((entry) => typeof entry === "string" && entry.trim().length > 0)?.trim() ?? null;

  return {
    authUrl,
    loginId,
    browserOpen: null,
    raw: login ?? null
  };
}

function parseRateLimits(rateLimits: any) {
  if (!rateLimits) {
    return null;
  }
  return {
    planType: rateLimits.planType ?? null,
    primary: rateLimits.primary
      ? {
          used: rateLimits.primary.used ?? null,
          limit: rateLimits.primary.limit ?? null,
          usedPercent: rateLimits.primary.usedPercent ?? null,
          resetsAt: rateLimits.primary.resetsAt ?? null,
          windowSeconds: rateLimits.primary.windowSeconds ?? null,
          windowDurationMins: rateLimits.primary.windowDurationMins ?? null
        }
      : null,
    secondary: rateLimits.secondary
      ? {
          used: rateLimits.secondary.used ?? null,
          limit: rateLimits.secondary.limit ?? null,
          usedPercent: rateLimits.secondary.usedPercent ?? null,
          resetsAt: rateLimits.secondary.resetsAt ?? null,
          windowSeconds: rateLimits.secondary.windowSeconds ?? null,
          windowDurationMins: rateLimits.secondary.windowDurationMins ?? null
        }
      : null,
    creditsRemaining: rateLimits.credits?.remaining ?? null
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    })
  ]);
}

function normalizeMcpServerStatusEntries(
  response: any
): Array<{
  name: string;
  status: string;
  authStatus: string;
  description: string;
  tools: Array<{ name: string; description: string }>;
  resources: number;
  resourceTemplates: number;
}> {
  const rawEntries = response?.data ?? response?.servers ?? response?.items ?? [];
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  return rawEntries
    .map((entry: any) => {
      const name = String(
        entry?.name ?? entry?.server ?? entry?.serverName ?? entry?.id ?? entry?.slug ?? ""
      ).trim();
      if (!name) {
        return null;
      }
      const status = String(entry?.status ?? entry?.state ?? entry?.connectionStatus ?? "unknown");
      const authStatus = String(entry?.authStatus ?? entry?.auth?.status ?? entry?.authenticationStatus ?? "unknown");
      const description = String(
        entry?.description ?? entry?.message ?? entry?.detail ?? entry?.error ?? ""
      ).trim();
      const tools = Array.isArray(entry?.tools)
        ? entry.tools
            .map((tool: any) => {
              const toolName = String(tool?.name ?? tool?.id ?? "").trim();
              if (!toolName) {
                return null;
              }
              return {
                name: toolName,
                description: String(tool?.description ?? tool?.title ?? tool?.summary ?? "").trim()
              };
            })
            .filter(Boolean)
        : [];
      const resources = Array.isArray(entry?.resources) ? entry.resources.length : 0;
      const resourceTemplates = Array.isArray(entry?.resourceTemplates)
        ? entry.resourceTemplates.length
        : Array.isArray(entry?.resource_templates)
          ? entry.resource_templates.length
          : 0;
      return { name, status, authStatus, description, tools, resources, resourceTemplates };
    })
    .filter(Boolean) as Array<{
      name: string;
      status: string;
      authStatus: string;
      description: string;
      tools: Array<{ name: string; description: string }>;
      resources: number;
      resourceTemplates: number;
    }>;
}

const DEFAULT_APP_SERVER_ENV_ALLOWLIST = [
  "APPDATA",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "COMPUTERNAME",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "NODE",
  "NODE_EXTRA_CA_CERTS",
  "NVM_HOME",
  "NVM_SYMLINK",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TZ",
  "USERNAME",
  "USERPROFILE",
  "WINDIR"
] as const;

function buildAppServerEnv() {
  const env: NodeJS.ProcessEnv = {};
  const retainedKeys = new Set<string>();
  const strippedCodexEnvKeys: string[] = [];
  const droppedParentEnvKeys: string[] = [];
  const extraPassthroughKeys = appConfig.codexAppServerPassthroughEnv.map((entry) => entry.toUpperCase());
  const allowlist = new Set<string>(
    [...DEFAULT_APP_SERVER_ENV_ALLOWLIST, ...extraPassthroughKeys].map((entry) => entry.toUpperCase())
  );

  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) {
      continue;
    }

    if (key.startsWith("CODEX_")) {
      strippedCodexEnvKeys.push(key);
      continue;
    }

    if (allowlist.has(key.toUpperCase())) {
      env[key] = value;
      retainedKeys.add(key);
      continue;
    }

    droppedParentEnvKeys.push(key);
  }

  fs.mkdirSync(appConfig.codexHomeDir, { recursive: true });
  env.CODEX_HOME = appConfig.codexHomeDir;

  return {
    env,
    retainedEnvKeys: Array.from(retainedKeys).sort(),
    strippedCodexEnvKeys: strippedCodexEnvKeys.sort(),
    droppedParentEnvKeys: droppedParentEnvKeys.sort()
  };
}

function detectCodexBinaryVersion(command: string, env: NodeJS.ProcessEnv, logger: AuditLogger): string | null {
  const normalizedCommand = command.trim();
  const extension = path.extname(normalizedCommand).toLowerCase();
  const needsCmdShim = process.platform === "win32" && (extension === ".cmd" || extension === ".bat");

  try {
    const result = spawnSync(normalizedCommand, ["--version"], {
      env,
      encoding: "utf8",
      shell: needsCmdShim,
      timeout: 5000
    });
    const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const match = combinedOutput.match(/codex-cli\s+([0-9A-Za-z.+-]+)/i);
    const version = match?.[1] ?? null;
    logger.log("app_server.version.detected", {
      command: normalizedCommand,
      version,
      shell: needsCmdShim,
      status: result.status,
      signal: result.signal
    });
    return version;
  } catch (error) {
    logger.log("app_server.version.detect_failed", {
      command: normalizedCommand,
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

export function createApp() {
  fs.mkdirSync(appConfig.auditLogDir, { recursive: true });
  const logger = new AuditLogger(appConfig.auditLogDir);
  const workspaceGuard = new WorkspaceGuard(
    appConfig.allowedWorkspaces,
    appConfig.defaultWorkspace,
    appConfig.workspaceDbPath
  );
  const sessionStore = new SessionStore(appConfig.workspaceDbPath);
  const { env, retainedEnvKeys, strippedCodexEnvKeys, droppedParentEnvKeys } = buildAppServerEnv();
  const codexBinaryVersion = detectCodexBinaryVersion(appConfig.codexCommand, env, logger);
  logger.log("app_server.env.prepared", {
    codexHomeStrategy: appConfig.codexHomeStrategy,
    codexHomeDir: appConfig.codexHomeDir,
    codexBinaryVersion,
    passthroughEnvKeys: retainedEnvKeys,
    strippedCodexEnvKeys,
    droppedParentEnvKeyCount: droppedParentEnvKeys.length,
    droppedParentEnvKeysSample: droppedParentEnvKeys.slice(0, 40)
  });
  const client = new CodexAppServerClient({
    command: appConfig.codexCommand,
    args: [...appConfig.codexArgs, ...appConfig.codexConfigOverrides.flatMap((entry) => ["-c", entry])],
    env,
    restartMs: appConfig.appServerRestartMs,
    logger
  });

  let account: AccountSummary = {
    loggedIn: false,
    mode: "unknown",
    planType: null,
    rateLimits: null,
    requiresOpenaiAuth: false
  };
  const threads = new Map<string, ThreadSummary>();
  let loadedThreads: LoadedThreadsSummary = {
    loadedThreadIds: [],
    refreshedAt: 0
  };
  let appServerCatalog: AppServerCatalog = {
    skills: [],
    plugins: [],
    models: [],
    collaborationModes: [],
    experimentalFeatures: [],
    refreshedAt: 0
  };
  const turnStatusByThread = new Map<string, ThreadSummary["status"]>();
  const turnDiffs = new Map<string, string>();
  const pendingApprovals = new Map<string, ApprovalRequest>();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  function isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) {
      return true;
    }
    return appConfig.allowedOrigins.includes(origin);
  }

  function settingsSummary(): SettingsSummary {
    const status = client.getStatus();
    return {
      host: appConfig.host,
      serverPort: appConfig.serverPort,
      webPort: appConfig.webPort,
      appServerPort: appConfig.appServerPort,
      approvalPolicy: appConfig.approvalPolicy,
      sandboxMode: appConfig.sandboxMode,
      allowedOrigins: appConfig.allowedOrigins,
      allowedWorkspaces: appConfig.allowedWorkspaces,
      codexCommand: appConfig.codexCommand,
      codexCommandSource: appConfig.codexCommandSource,
      codexArgs: appConfig.codexArgs,
      codexBinaryVersion,
      codexHomeStrategy: appConfig.codexHomeStrategy,
      codexHomeDir: appConfig.codexHomeDir,
      effectiveCodexHomeDir: appConfig.codexHomeDir ?? path.join(os.homedir(), ".codex"),
      codexConfigOverrideSources: appConfig.codexConfigOverrideSources,
      appServerConnected: status.connected,
      appServerStatus: status.status
    };
  }

  function snapshot(): SnapshotPayload {
    return {
      account,
      workspace: workspaceGuard.list(),
      threads: Array.from(threads.values()).sort((a, b) => b.updatedAt - a.updatedAt),
      loadedThreads,
      approvals: Array.from(pendingApprovals.values()).filter((entry) => entry.status === "pending"),
      settings: settingsSummary(),
      appServerCatalog
    };
  }

  function broadcast(event: FrontendEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of wss.clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }

  async function refreshAccount(): Promise<AccountSummary> {
    const response = (await client.request<any>("account/read", { refreshToken: false })) ?? {};
    const rateLimitsResponse = await client.request<any>("account/rateLimits/read", undefined).catch(
      () => null
    );
    const nextAccount: AccountSummary = {
      loggedIn: Boolean(response.account),
      mode: response.account?.type ?? "unknown",
      email: response.account?.email ?? null,
      planType: response.account?.planType ?? null,
      requiresOpenaiAuth: Boolean(response.requiresOpenaiAuth),
      rateLimits: parseRateLimits(rateLimitsResponse?.rateLimits)
    };
    account = nextAccount;
    sessionStore.upsertAccount(nextAccount);
    broadcast({ type: "account.updated", payload: account });
    return nextAccount;
  }

  async function refreshThreads(): Promise<ThreadSummary[]> {
    const response = await client.request<any>("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      archived: false,
      sourceKinds: [...ALL_THREAD_SOURCE_KINDS]
    });
    const latestThreads = new Map<string, ThreadSummary>();
    for (const thread of response.data ?? []) {
      latestThreads.set(thread.id, toThreadSummary(thread, turnStatusByThread.get(thread.id) ?? "idle"));
    }
    const loaded = await client.request<any>("thread/loaded/list", {
      limit: 100
    }).catch(() => null);
    for (const threadId of loaded?.data ?? []) {
      if (latestThreads.has(threadId)) {
        continue;
      }
      const detail = await client
        .request<any>("thread/read", {
          threadId,
          includeTurns: false
        })
        .catch(() => null);
      if (detail?.thread) {
        latestThreads.set(
          detail.thread.id,
          toThreadSummary(detail.thread, turnStatusByThread.get(detail.thread.id) ?? "idle")
        );
      }
    }
    threads.clear();
    for (const [threadId, thread] of latestThreads.entries()) {
      threads.set(threadId, thread);
    }
    loadedThreads = {
      loadedThreadIds: [...(loaded?.data ?? [])],
      refreshedAt: Date.now()
    };
    const orderedThreads = Array.from(latestThreads.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    sessionStore.syncThreads(orderedThreads);
    return orderedThreads;
  }

  async function readSessionOrRespond(
    req: Request,
    res: Response
  ): Promise<import("../../../packages/shared/src/index.js").SessionSummary | null> {
    await ensureClientReady();
    const currentAccount = await refreshAccount();
    const sessionId = String(req.params.sessionId ?? req.body?.sessionId ?? "").trim();
    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return null;
    }
    const session = sessionStore.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: `session not found: ${sessionId}` });
      return null;
    }
    if (!currentAccount.loggedIn || !currentAccount.email) {
      res.status(401).json({ error: "current account is not signed in" });
      return null;
    }
    if (currentAccount.email.trim().toLowerCase() !== session.accountEmail.trim().toLowerCase()) {
      res.status(403).json({ error: "session does not belong to current account" });
      return null;
    }
    return session;
  }

  async function resolveSessionForCurrentContext(
    workspacePath: string,
    threadId?: string | null
  ): Promise<import("../../../packages/shared/src/index.js").SessionSummary | null> {
    const currentAccount = await refreshAccount();
    if (!currentAccount.loggedIn || !currentAccount.email) {
      return null;
    }
    const knownThread = threadId ? threads.get(threadId) ?? null : null;
    return sessionStore.resolveSession({
      account: currentAccount,
      workspacePath,
      threadId: threadId ?? null,
      threadSummary: knownThread
    });
  }

  async function refreshAppServerCatalog(): Promise<AppServerCatalog> {
    const [skillsResponse, pluginsResponse, modelsResponse, collaborationModesResponse, experimentalFeaturesResponse] =
      await Promise.all([
        client.request<any>("skills/list", {}),
        client.request<any>("plugin/list", {}),
        client.request<any>("model/list", {}),
        client.request<any>("collaborationMode/list", {}),
        client.request<any>("experimentalFeature/list", {})
      ]);

    const skills = (skillsResponse?.data ?? []).flatMap((entry: any) =>
      (entry.skills ?? []).map((skill: any) => ({
        name: String(skill.name ?? ""),
        displayName: String(skill.interface?.displayName ?? skill.name ?? ""),
        description: String(skill.interface?.shortDescription ?? skill.description ?? ""),
        enabled: Boolean(skill.enabled)
      }))
    );

    const plugins = (pluginsResponse?.marketplaces ?? []).flatMap((marketplace: any) =>
      (marketplace.plugins ?? []).map((plugin: any) => ({
        id: String(plugin.id ?? ""),
        name: String(plugin.name ?? ""),
        displayName: String(plugin.interface?.displayName ?? plugin.name ?? ""),
        description: String(plugin.interface?.shortDescription ?? plugin.interface?.longDescription ?? ""),
        category: typeof plugin.interface?.category === "string" ? plugin.interface.category : null,
        installed: Boolean(plugin.installed),
        enabled: Boolean(plugin.enabled)
      }))
    );

    const models = (modelsResponse?.data ?? []).map((model: any) => ({
      id: String(model.id ?? model.model ?? ""),
      displayName: String(model.displayName ?? model.model ?? model.id ?? ""),
      description: String(model.description ?? ""),
      defaultReasoningEffort:
        typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null,
      supportedReasoningEfforts: (model.supportedReasoningEfforts ?? [])
        .map((entry: any) => String(entry.reasoningEffort ?? ""))
        .filter(Boolean),
      isDefault: Boolean(model.isDefault)
    }));

    const collaborationModes = (collaborationModesResponse?.data ?? []).map((mode: any) => ({
      name: String(mode.name ?? mode.mode ?? ""),
      mode: String(mode.mode ?? ""),
      reasoningEffort: typeof mode.reasoning_effort === "string" ? mode.reasoning_effort : null
    }));

    const experimentalFeatures = (experimentalFeaturesResponse?.data ?? []).map((feature: any) => ({
      name: String(feature.name ?? ""),
      displayName: String(feature.displayName ?? feature.name ?? ""),
      description: String(feature.description ?? feature.announcement ?? ""),
      stage: String(feature.stage ?? "unknown"),
      enabled: Boolean(feature.enabled),
      defaultEnabled: Boolean(feature.defaultEnabled)
    }));

    appServerCatalog = {
      skills,
      plugins,
      models,
      collaborationModes,
      experimentalFeatures,
      refreshedAt: Date.now()
    };
    return appServerCatalog;
  }

  async function listMcpServerStatusRaw(): Promise<any> {
    const pages: any[] = [];
    let cursor: string | null = null;

    for (let index = 0; index < 10; index += 1) {
      const response: any = await withTimeout(
        client.request<any>("mcpServerStatus/list", { limit: 100, cursor }),
        2500,
        null
      ).catch(() => null);
      if (!response) {
        break;
      }
      pages.push(response);
      const nextCursor: string | null =
        typeof response.nextCursor === "string"
          ? response.nextCursor
          : typeof response.next_cursor === "string"
            ? response.next_cursor
            : null;
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }

    return {
      data: pages.flatMap((page) => {
        const entries = page?.data ?? page?.servers ?? page?.items ?? [];
        return Array.isArray(entries) ? entries : [];
      }),
      pages
    };
  }

  async function listMcpServers(): Promise<
    Array<{
      name: string;
      status: string;
      authStatus: string;
      description: string;
      tools: Array<{ name: string; description: string }>;
      resources: number;
      resourceTemplates: number;
    }>
  > {
    const response = await listMcpServerStatusRaw();
    return normalizeMcpServerStatusEntries(response);
  }

  async function searchMcpComposerSuggestions(query: string): Promise<McpComposerSuggestions> {
    const normalizedQuery = query.trimStart();
    const matched = /^\/mcp(?:\s+([^\s]+))?(?:\s+(.*))?$/i.exec(normalizedQuery);
    const serverQuery = matched?.[1] ?? "";
    const toolQuery = matched?.[2]?.trim() ?? "";
    const hasTrailingServerSpace = /^\/mcp\s+[^\s]+\s+$/i.test(normalizedQuery);

    const servers = await listMcpServers();
    const toServerSuggestion = (entry: (typeof servers)[number]) => ({
      name: entry.name,
      status: entry.status,
      description:
        entry.description ||
        `auth=${entry.authStatus} · tools=${entry.tools.length} · resources=${entry.resources} · templates=${entry.resourceTemplates}`
    });

    if (!serverQuery) {
      return {
        mode: "servers",
        servers: servers
          .filter((entry) => entry.name.toLowerCase().includes(toolQuery.toLowerCase()))
          .map(toServerSuggestion),
        tools: []
      };
    }

    const matchedServers = servers.filter((entry) => entry.name.toLowerCase().includes(serverQuery.toLowerCase()));
    const selectedServer =
      servers.find((entry) => entry.name === serverQuery) ??
      (matchedServers.length === 1 ? matchedServers[0] : null);

    if (!selectedServer || (!toolQuery && !hasTrailingServerSpace && !servers.some((entry) => entry.name === serverQuery))) {
      return {
        mode: "servers",
        servers: matchedServers.map(toServerSuggestion),
        tools: []
      };
    }

    const normalizedToolQuery = toolQuery.toLowerCase();
    return {
      mode: "tools",
      servers: [toServerSuggestion(selectedServer)],
      tools: selectedServer.tools
        .map((entry) => ({
          server: selectedServer.name,
          name: entry.name,
          description: entry.description
        }))
        .filter((entry) => {
          if (!normalizedToolQuery) {
            return true;
          }
          return `${entry.name} ${entry.description}`.toLowerCase().includes(normalizedToolQuery);
        })
    };
  }

  function requireOrigin(req: Request, res: Response): boolean {
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin)) {
      res.status(403).json({ error: "origin 不被允许" });
      return false;
    }
    return true;
  }

  async function ensureClientReady(): Promise<void> {
    const status = client.getStatus();
    if (status.connected) {
      return;
    }
    await client.start();
  }

  async function resumeThread(threadId: string): Promise<boolean> {
    try {
      await client.request("thread/resume", { threadId });
      await refreshThreads().catch(() => undefined);
      return true;
    } catch (error) {
      logger.log("thread.resume.failed", {
        threadId,
        message: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  client.on("status", (status) => {
    broadcast({
      type: "server.status",
      payload: {
        connected: status.connected,
        status: status.status,
        error: status.error
      }
    });
  });

  client.on("notification", (message: JsonRpcNotification) => {
    const { method, params } = message;
    if (method === "thread/started") {
      const status = normalizeThreadStatus(params.thread?.status, "idle");
      turnStatusByThread.set(params.thread.id, status);
      threads.set(params.thread.id, toThreadSummary(params.thread, status));
      broadcast({ type: "thread.started", payload: { threadId: params.thread.id } });
      return;
    }

    if (method === "thread/status/changed") {
      const status = normalizeThreadStatus(params.status, "idle");
      turnStatusByThread.set(params.threadId, status);
      const thread = threads.get(params.threadId);
      if (thread) {
        thread.status = status;
      }
      broadcast({
        type: "thread.status",
        payload: { threadId: params.threadId, status }
      });
      return;
    }

    if (method === "thread/archived") {
      const threadId = String(params.threadId ?? params.thread?.id ?? "");
      if (threadId) {
        threads.delete(threadId);
        turnStatusByThread.delete(threadId);
        broadcast({ type: "thread.archived", payload: { threadId } });
      }
      return;
    }

    if (method === "thread/unarchived") {
      const threadId = String(params.thread?.id ?? params.threadId ?? "");
      if (params.thread?.id) {
        threads.set(params.thread.id, toThreadSummary(params.thread, "idle"));
      }
      if (threadId) {
        broadcast({ type: "thread.unarchived", payload: { threadId } });
      }
      return;
    }

    if (method === "thread/name/updated") {
      const threadId = String(params.threadId ?? params.thread?.id ?? "");
      const name = typeof params.name === "string"
        ? params.name
        : typeof params.thread?.name === "string"
          ? params.thread.name
          : null;
      const thread = threadId ? threads.get(threadId) : undefined;
      if (thread) {
        thread.name = name;
      }
      if (threadId) {
        broadcast({ type: "thread.named", payload: { threadId, name } });
      }
      return;
    }

    if (method === "turn/started") {
      turnStatusByThread.set(params.threadId, "inProgress");
      const thread = threads.get(params.threadId);
      if (thread) {
        thread.status = "inProgress";
      }
      broadcast({
        type: "turn.started",
        payload: { threadId: params.threadId, turnId: params.turn.id }
      });
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      broadcast({
        type: method === "item/started" ? "item.started" : "item.completed",
        payload: {
          threadId: params.threadId,
          turnId: params.turnId,
          item: toThreadItem(params.item)
        }
      });
      return;
    }

    if (method === "item/agentMessage/delta") {
      broadcast({
        type: "item.delta",
        payload: {
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          stream: "assistant",
          delta: params.delta
        }
      });
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      broadcast({
        type: "item.delta",
        payload: {
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          stream: "command",
          delta: params.delta
        }
      });
      return;
    }

    if (method === "item/fileChange/outputDelta") {
      broadcast({
        type: "item.delta",
        payload: {
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          stream: "fileChange",
          delta: params.delta
        }
      });
      return;
    }

    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      broadcast({
        type: "item.delta",
        payload: {
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          stream: "reasoning",
          delta: params.delta
        }
      });
      return;
    }

    if (method === "turn/diff/updated") {
      turnDiffs.set(`${params.threadId}:${params.turnId}`, params.diff);
      broadcast({
        type: "diff.updated",
        payload: { threadId: params.threadId, turnId: params.turnId, diff: params.diff }
      });
      return;
    }

    if (method === "turn/completed") {
      const nextStatus = params.turn.status === "failed"
        ? "failed"
        : params.turn.status === "interrupted"
          ? "interrupted"
          : "completed";
      turnStatusByThread.set(params.threadId, nextStatus);
      const thread = threads.get(params.threadId);
      if (thread) {
        thread.status = nextStatus;
      }
      void refreshThreads().catch(() => undefined);
      broadcast({
        type: "turn.completed",
        payload: {
          threadId: params.threadId,
          turnId: params.turn.id,
          status: params.turn.status
        }
      });
      return;
    }

    if (
      method === "account/updated" ||
      method === "account/rateLimits/updated" ||
      method === "account/login/completed"
    ) {
      logger.log("account.status.changed", { method });
      void refreshAccount().catch(() => undefined);
      return;
    }

    if (method === "error") {
      broadcast({
        type: "error",
        payload: {
          message: params.message ?? "app-server 返回错误",
          detail: params
        }
      });
    }
  });

  client.on("serverRequest", (message: JsonRpcServerRequest) => {
    if (message.method === "account/chatgptAuthTokens/refresh") {
      client.respondError(message.id, "当前 Web UI 不支持外部 token 刷新模式，请使用官方 ChatGPT 登录流程");
      return;
    }

    if (message.method === "item/tool/call") {
      client.respond(message.id, {
        success: false,
        contentItems: [{ type: "inputText", text: "当前 Web UI 未注册动态工具。" }]
      });
      return;
    }

    if (
      message.method !== "item/commandExecution/requestApproval" &&
      message.method !== "item/fileChange/requestApproval" &&
      message.method !== "tool/requestUserInput"
    ) {
      logger.log("server.request.unsupported", { method: message.method });
      client.respondError(message.id, `Unsupported server request: ${message.method}`);
      return;
    }

    const requestId = message.id;
    const params = message.params ?? {};
    const approval: ApprovalRequest = {
      id: crypto.randomUUID(),
      requestId,
      kind:
        message.method === "item/commandExecution/requestApproval"
          ? "command"
          : message.method === "item/fileChange/requestApproval"
            ? "fileChange"
            : "userInput",
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      createdAt: Date.now(),
      status: "pending",
      reason: params.reason ?? null,
      command: params.command ?? null,
      cwd: params.cwd ?? null,
      grantRoot: params.grantRoot ?? null,
      tool: params.tool ?? null,
      arguments: params.arguments,
      questions: params.questions,
      resolvedAt: null,
      resolutionDecision: null,
      resolutionAnswers: null,
      riskHint:
        message.method === "item/commandExecution/requestApproval"
          ? "命令可能修改文件、执行程序或访问网络。"
          : message.method === "item/fileChange/requestApproval"
            ? "文件变更可能扩大可写目录或落盘修改。"
            : "工具请求需要用户输入后才能继续执行。"
    };
    pendingApprovals.set(approval.id, approval);
    logger.log("approval.created", approval as unknown as Record<string, unknown>);
    broadcast({ type: "approval.created", payload: approval });
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      appServer: client.getStatus()
    });
  });

  app.get("/help/windows-login-10013", (_req, res) => {
    const helpPath = loginHelpDocPath();
    if (!fs.existsSync(helpPath)) {
      res.status(404).type("text/plain; charset=utf-8").send("未找到登录失败处理说明文档。");
      return;
    }
    res.type("text/markdown; charset=utf-8");
    res.sendFile(helpPath);
  });

  app.get("/api/bootstrap", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    try {
      await ensureClientReady();
      await refreshAccount();
      await refreshThreads();
      await refreshAppServerCatalog().catch(() => appServerCatalog);
      res.json(snapshot());
    } catch (error) {
      if (isLoginServerPortBlockedError(error)) {
        res.status(503).json({
          error: loginServerPortBlockedMessage(),
          code: "LOGIN_SERVER_PORT_BLOCKED",
          appServer: client.getStatus()
        });
        return;
      }
      if (isAppServerUnavailableError(error)) {
        res.status(503).json({
          error: "Codex app-server 尚未就绪",
          appServer: client.getStatus()
        });
        return;
      }
      throw error;
    }
  });

  app.get("/api/account", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    try {
      await ensureClientReady();
      res.json(await refreshAccount());
    } catch (error) {
      if (isAppServerUnavailableError(error)) {
        res.status(503).json({
          error: "Codex app-server 尚未就绪",
          appServer: client.getStatus()
        });
        return;
      }
      throw error;
    }
  });

  app.post("/api/account/login", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    try {
      await ensureClientReady();
      const loginParams = {
        type: "chatgpt",
        ...(req.body ?? {})
      };
      logger.log("account.login.requested", { type: loginParams.type });
      const login = await client.request<any>("account/login/start", loginParams);
      const normalized = normalizeLoginStartResponse(login);
      if (normalized.authUrl) {
        normalized.browserOpen = await openSystemBrowser(normalized.authUrl);
      }
      logger.log("account.login.started", {
        loginId: normalized.loginId,
        hasAuthUrl: Boolean(normalized.authUrl),
        browserOpenOk: normalized.browserOpen?.ok ?? false,
        browserOpenMessage: normalized.browserOpen?.message ?? null,
        responseKeys:
          normalized.raw && typeof normalized.raw === "object"
            ? Object.keys(normalized.raw).slice(0, 20)
            : []
      });
      res.json(normalized);
    } catch (error) {
      if (isAppServerUnavailableError(error)) {
        res.status(503).json({
          error: "Codex app-server 尚未就绪",
          appServer: client.getStatus()
        });
        return;
      }
      throw error;
    }
  });

  app.post("/api/account/login/cancel", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const loginId = String(req.body?.loginId ?? "").trim();
    if (!loginId) {
      res.status(400).json({ error: "loginId is required" });
      return;
    }
    logger.log("account.login.cancel.requested", { loginId });
    res.json(await client.request<any>("account/login/cancel", { loginId }));
  });

  app.post("/api/account/logout", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("account.logout.requested", {});
    await client.request("account/logout", undefined);
    res.json(await refreshAccount());
  });

  app.get("/api/sessions/:sessionId", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    const session = await readSessionOrRespond(req, res);
    if (!session) {
      return;
    }
    res.json(session);
  });

  app.post("/api/sessions/resolve", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const workspacePath = String(req.body?.workspacePath ?? workspaceGuard.getCurrentWorkspace() ?? "").trim();
    const threadId =
      typeof req.body?.threadId === "string" && req.body.threadId.trim().length > 0
        ? req.body.threadId.trim()
        : null;
    if (!workspacePath) {
      res.status(400).json({ error: "workspacePath is required" });
      return;
    }
    const session = await resolveSessionForCurrentContext(workspacePath, threadId);
    if (!session) {
      res.status(400).json({ error: "current account does not support session resolution" });
      return;
    }
    res.json(session);
  });

  app.get("/api/workspaces", (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    res.json(workspaceGuard.list());
  });

  app.post("/api/workspaces/pick", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    try {
      const picked = await openFolderDialog();
      if (picked.canceled || !picked.path) {
        res.json({
          canceled: true,
          workspace: workspaceGuard.list()
        });
        return;
      }
      const added = workspaceGuard.addWorkspace(picked.path, "folder_picker");
      logger.log("workspace.picked", { path: added });
      res.json({
        canceled: false,
        path: added,
        workspace: workspaceGuard.list()
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/workspaces", (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    try {
      const added = workspaceGuard.addWorkspace(String(req.body.path ?? ""), "manual_input");
      logger.log("workspace.added", { path: added });
      res.json(workspaceGuard.list());
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/workspaces/select", (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    try {
      const selected = workspaceGuard.setCurrentWorkspace(String(req.body.path ?? ""), "manual_select");
      logger.log("workspace.selected", { path: selected });
      res.json(workspaceGuard.list());
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/threads", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    res.json(await refreshThreads());
  });

  app.get("/api/threads/loaded", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    await refreshThreads();
    res.json(loadedThreads);
  });

  app.get("/api/composer/files", (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    const cwd = workspaceGuard.getCurrentWorkspace();
    if (!cwd) {
      res.status(400).json({ error: "请先选择白名单内的工作目录" });
      return;
    }
    try {
      const query = String(req.query.query ?? "");
      res.json(searchWorkspaceFiles(cwd, query));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/composer/skills", (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    try {
      const query = String(req.query.query ?? "");
      res.json(searchSkills(query, appConfig.codexHomeDir));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/composer/mcp", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    try {
      const query = String(req.query.query ?? "");
      const payload = await searchMcpComposerSuggestions(query);
      logger.log("composer.mcp.query", {
        query,
        mode: payload.mode,
        serverCount: payload.servers.length,
        toolCount: payload.tools.length
      });
      res.json(payload);
    } catch (error) {
      logger.log("composer.mcp.failed", {
        query: String(req.query.query ?? ""),
        message: error instanceof Error ? error.message : String(error)
      });
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/debug/mcp-status", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    try {
      res.json(await listMcpServerStatusRaw());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/app-server/catalog", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    try {
      res.json(await refreshAppServerCatalog());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/app-server/apps", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    try {
      res.json(await client.request<any>("app/list", req.query ?? {}));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/app-server/plugin/read", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const marketplacePath = String(req.body?.marketplacePath ?? "").trim();
    const pluginName = String(req.body?.pluginName ?? "").trim();
    if (!marketplacePath || !pluginName) {
      res.status(400).json({ error: "marketplacePath and pluginName are required" });
      return;
    }
    logger.log("plugin.read.requested", { marketplacePath, pluginName });
    try {
      res.json(await client.request<any>("plugin/read", {
        marketplacePath,
        pluginName
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/app-server/marketplaces", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("marketplace.add.requested", {
      marketplacePath: req.body?.marketplacePath ?? null
    });
    try {
      res.json(await client.request<any>("marketplace/add", req.body ?? {}));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/app-server/plugin/install", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("plugin.install.requested", {
      marketplacePath: req.body?.marketplacePath ?? null,
      pluginName: req.body?.pluginName ?? null
    });
    try {
      res.json(await client.request<any>("plugin/install", req.body ?? {}));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/app-server/plugin/uninstall", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("plugin.uninstall.requested", {
      marketplacePath: req.body?.marketplacePath ?? null,
      pluginName: req.body?.pluginName ?? null
    });
    try {
      res.json(await client.request<any>("plugin/uninstall", req.body ?? {}));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/app-server/skills/config", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("skills.config.write.requested", {
      skillName: req.body?.skillName ?? null
    });
    try {
      res.json(await client.request<any>("skills/config/write", req.body ?? {}));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/app-server/mcp/reload", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("config.mcp_server.reload.requested", {});
    try {
      res.json(await client.request<any>("config/mcpServer/reload", {}));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/app-server/config", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    try {
      res.json(await client.request<any>("config/read", req.query ?? {}));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/app-server/config-requirements", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    try {
      res.json(await client.request<any>("configRequirements/read", req.query ?? {}));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/app-server/config/value", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const key = String(req.body?.key ?? "").trim();
    if (!key) {
      res.status(400).json({ error: "key is required" });
      return;
    }
    logger.log("config.value.write.requested", { key });
    try {
      res.json(await client.request<any>("config/value/write", {
        key,
        value: req.body?.value
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/app-server/config/batch", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
    if (!entries) {
      res.status(400).json({ error: "entries are required" });
      return;
    }
    logger.log("config.batch_write.requested", { entryCount: entries.length });
    try {
      res.json(await client.request<any>("config/batchWrite", {
        entries
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/app-server/experimental-features/:name/enablement", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const enabled = Boolean(req.body?.enabled);
    logger.log("experimental_feature.enablement.set.requested", {
      name: req.params.name,
      enabled
    });
    try {
      res.json(await client.request<any>("experimentalFeature/enablement/set", {
        name: req.params.name,
        enabled
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/commands/exec", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("command.exec.requested", {
      cwd: typeof req.body?.cwd === "string" ? req.body.cwd : null,
      command: typeof req.body?.command === "string" ? req.body.command : null
    });
    try {
      res.json(await client.request<any>("command/exec", req.body ?? {}));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/commands/exec/:processId/write", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const processId = Number(req.params.processId);
    if (!Number.isFinite(processId)) {
      res.status(400).json({ error: "processId must be a number" });
      return;
    }
    logger.log("command.exec.write.requested", { processId });
    try {
      res.json(await client.request<any>("command/exec/write", {
        processId,
        ...(req.body ?? {})
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/commands/exec/:processId/resize", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const processId = Number(req.params.processId);
    if (!Number.isFinite(processId)) {
      res.status(400).json({ error: "processId must be a number" });
      return;
    }
    logger.log("command.exec.resize.requested", { processId });
    try {
      res.json(await client.request<any>("command/exec/resize", {
        processId,
        ...(req.body ?? {})
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/commands/exec/:processId/terminate", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const processId = Number(req.params.processId);
    if (!Number.isFinite(processId)) {
      res.status(400).json({ error: "processId must be a number" });
      return;
    }
    logger.log("command.exec.terminate.requested", { processId });
    try {
      res.json(await client.request<any>("command/exec/terminate", { processId }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/fs/read-file", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const pathValue = String(req.body?.path ?? "").trim();
    if (!pathValue) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    logger.log("fs.read_file.requested", { path: pathValue });
    try {
      res.json(await client.request<any>("fs/readFile", {
        path: pathValue
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/fs/write-file", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const pathValue = String(req.body?.path ?? "").trim();
    const dataBase64 = String(req.body?.dataBase64 ?? "").trim();
    if (!pathValue || !dataBase64) {
      res.status(400).json({ error: "path and dataBase64 are required" });
      return;
    }
    logger.log("fs.write_file.requested", { path: pathValue });
    try {
      res.json(await client.request<any>("fs/writeFile", {
        path: pathValue,
        dataBase64
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/fs/create-directory", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const pathValue = String(req.body?.path ?? "").trim();
    if (!pathValue) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    logger.log("fs.create_directory.requested", { path: pathValue });
    try {
      res.json(await client.request<any>("fs/createDirectory", {
        path: pathValue,
        recursive: req.body?.recursive
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/fs/metadata", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const pathValue = String(req.body?.path ?? "").trim();
    if (!pathValue) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    logger.log("fs.metadata.requested", { path: pathValue });
    try {
      res.json(await client.request<any>("fs/getMetadata", {
        path: pathValue
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/fs/read-directory", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const pathValue = String(req.body?.path ?? "").trim();
    if (!pathValue) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    logger.log("fs.read_directory.requested", { path: pathValue });
    try {
      res.json(await client.request<any>("fs/readDirectory", {
        path: pathValue
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/fs/remove", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const pathValue = String(req.body?.path ?? "").trim();
    if (!pathValue) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    logger.log("fs.remove.requested", { path: pathValue });
    try {
      res.json(await client.request<any>("fs/remove", {
        path: pathValue,
        recursive: req.body?.recursive,
        force: req.body?.force
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/fs/copy", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const source = String(req.body?.source ?? "").trim();
    const destination = String(req.body?.destination ?? "").trim();
    if (!source || !destination) {
      res.status(400).json({ error: "source and destination are required" });
      return;
    }
    logger.log("fs.copy.requested", { source, destination });
    try {
      res.json(await client.request<any>("fs/copy", {
        source,
        destination,
        recursive: req.body?.recursive
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/fs/watch", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const pathValue = String(req.body?.path ?? "").trim();
    const watchId = String(req.body?.watchId ?? "").trim();
    if (!pathValue || !watchId) {
      res.status(400).json({ error: "path and watchId are required" });
      return;
    }
    logger.log("fs.watch.requested", { path: pathValue, watchId });
    try {
      res.json(await client.request<any>("fs/watch", {
        path: pathValue,
        watchId
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/fs/unwatch", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const watchId = String(req.body?.watchId ?? "").trim();
    if (!watchId) {
      res.status(400).json({ error: "watchId is required" });
      return;
    }
    logger.log("fs.unwatch.requested", { watchId });
    try {
      res.json(await client.request<any>("fs/unwatch", {
        watchId
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/threads", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const cwd = workspaceGuard.getCurrentWorkspace();
    if (!cwd) {
      res.status(400).json({ error: "请先选择白名单内的工作目录" });
      return;
    }
    logger.log("thread.created", { cwd });
    const response = await client.request<any>("thread/start", {
      cwd,
      approvalPolicy: appConfig.approvalPolicy,
      sandbox: appConfig.sandboxMode,
      experimentalRawEvents: false,
      ...(req.body ?? {})
    });
    const summary = toThreadSummary(response.thread, "idle");
    threads.set(summary.id, summary);
    sessionStore.upsertThread(summary);
    res.json(summary);
  });

  app.post("/api/threads/:threadId/fork", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const response = await client.request<any>("thread/fork", {
      threadId: req.params.threadId,
      ...(req.body ?? {})
    });
    const summary = toThreadSummary(response.thread, "idle");
    threads.set(summary.id, summary);
    sessionStore.upsertThread(summary);
    await refreshThreads().catch(() => undefined);
    res.json(summary);
  });

  app.get("/api/threads/:threadId", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    try {
      const response = await client.request<any>("thread/read", {
        threadId: req.params.threadId,
        includeTurns: true
      });
      res.json(toThreadDetail(response.thread, turnStatusByThread.get(req.params.threadId) ?? "idle"));
    } catch (error) {
      if (!isThreadNotMaterializedError(error)) {
        throw error;
      }
      const response = await client.request<any>("thread/read", {
        threadId: req.params.threadId,
        includeTurns: false
      });
      res.json({
        ...toThreadSummary(response.thread, turnStatusByThread.get(req.params.threadId) ?? "idle"),
        turns: []
      } satisfies ThreadDetail);
    }
  });

  app.post("/api/threads/:threadId/turns", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const cwd = workspaceGuard.getCurrentWorkspace();
    if (!cwd) {
      res.status(400).json({ error: "请先选择白名单内的工作目录" });
      return;
    }
    const prompt = String(req.body.prompt ?? "").trim();
    if (!prompt) {
      res.status(400).json({ error: "prompt 不能为空" });
      return;
    }
    logger.log("prompt.submitted", { threadId: req.params.threadId, cwd, prompt });
    const threadId = req.params.threadId;
    const startTurn = () =>
      client.request<any>("turn/start", {
        threadId,
        cwd,
        input: [{ type: "text", text: prompt, text_elements: [] }]
      });

    if (!loadedThreads.loadedThreadIds.includes(threadId)) {
      await resumeThread(threadId);
    }

    let response;
    try {
      response = await startTurn();
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }
      const resumed = await resumeThread(threadId);
      if (!resumed) {
        throw error;
      }
      response = await startTurn();
    }
    res.json({ turnId: response.turn.id });
  });

  app.post("/api/threads/:threadId/steer", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const params = {
      threadId: req.params.threadId,
      ...(req.body ?? {})
    } as Record<string, unknown>;
    if (prompt && !params.input) {
      params.input = [{ type: "text", text: prompt, text_elements: [] }];
    }
    if (!params.input) {
      res.status(400).json({ error: "prompt or input is required" });
      return;
    }
    logger.log("turn.steer.requested", { threadId: req.params.threadId });
    res.json(await client.request<any>("turn/steer", params));
  });

  app.post("/api/threads/:threadId/review", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const params = {
      threadId: req.params.threadId,
      ...(req.body ?? {})
    };
    logger.log("review.start.requested", { threadId: req.params.threadId });
    res.json(await client.request<any>("review/start", params));
  });

  app.post("/api/threads/:threadId/interrupt", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    await client.request("turn/interrupt", {
      threadId: req.params.threadId,
      turnId: req.body.turnId
    });
    res.json({ ok: true });
  });

  app.post("/api/threads/:threadId/archive", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    await client.request("thread/archive", { threadId: req.params.threadId });
    await refreshThreads().catch(() => undefined);
    res.json({ ok: true });
  });

  app.post("/api/threads/:threadId/unarchive", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const response = await client.request<any>("thread/unarchive", { threadId: req.params.threadId });
    await refreshThreads().catch(() => undefined);
    res.json(response?.thread ? toThreadSummary(response.thread, "idle") : response);
  });

  app.post("/api/threads/:threadId/name", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const name = typeof req.body?.name === "string" ? req.body.name : null;
    await client.request("thread/name/set", {
      threadId: req.params.threadId,
      name
    });
    const thread = threads.get(req.params.threadId);
    if (thread) {
      thread.name = name;
    }
    res.json({ ok: true, threadId: req.params.threadId, name });
  });

  app.post("/api/threads/:threadId/metadata", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("thread.metadata.update.requested", {
      threadId: req.params.threadId
    });
    const response = await client.request<any>("thread/metadata/update", {
      threadId: req.params.threadId,
      ...(req.body ?? {})
    });
    if (response?.thread) {
      const status = normalizeThreadStatus(response.thread.status, "idle");
      const summary = toThreadSummary(response.thread, status);
      threads.set(summary.id, summary);
      turnStatusByThread.set(summary.id, status);
      sessionStore.upsertThread(summary);
      res.json(toThreadDetail(response.thread, status));
      return;
    }
    res.json(response);
  });

  app.post("/api/threads/:threadId/compact", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("thread.compact.requested", { threadId: req.params.threadId });
    await client.request("thread/compact/start", {
      threadId: req.params.threadId,
      ...(req.body ?? {})
    });
    res.json({ ok: true });
  });

  app.post("/api/threads/:threadId/rollback", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const requestedTurnCount = Number(req.body?.turnCount ?? req.body?.count ?? 1);
    const turnCount = Number.isFinite(requestedTurnCount) && requestedTurnCount > 0
      ? Math.floor(requestedTurnCount)
      : 1;
    logger.log("thread.rollback.requested", {
      threadId: req.params.threadId,
      turnCount
    });
    const response = await client.request<any>("thread/rollback", {
      threadId: req.params.threadId,
      turnCount
    });
    if (response?.thread) {
      const status = normalizeThreadStatus(response.thread.status, "idle");
      const summary = toThreadSummary(response.thread, status);
      threads.set(summary.id, summary);
      turnStatusByThread.set(summary.id, status);
      sessionStore.upsertThread(summary);
      res.json(toThreadDetail(response.thread, status));
      return;
    }
    await refreshThreads().catch(() => undefined);
    res.json(response);
  });

  app.post("/api/threads/:threadId/background-terminals/clean", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("thread.background_terminals.clean.requested", {
      threadId: req.params.threadId
    });
    await client.request("thread/backgroundTerminals/clean", {
      threadId: req.params.threadId
    });
    res.json({ ok: true });
  });

  app.post("/api/threads/:threadId/shell-command", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("thread.shell_command.requested", {
      threadId: req.params.threadId
    });
    res.json(await client.request<any>("thread/shellCommand", {
      threadId: req.params.threadId,
      ...(req.body ?? {})
    }));
  });

  app.post("/api/threads/:threadId/items/inject", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) {
      res.status(400).json({ error: "items are required" });
      return;
    }
    logger.log("thread.inject_items.requested", {
      threadId: req.params.threadId,
      itemCount: items.length
    });
    res.json(await client.request<any>("thread/inject_items", {
      threadId: req.params.threadId,
      items
    }));
  });

  app.post("/api/threads/:threadId/memory-mode", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const mode = String(req.body?.mode ?? "").trim();
    if (mode !== "enabled" && mode !== "disabled") {
      res.status(400).json({ error: "mode must be enabled or disabled" });
      return;
    }
    logger.log("thread.memory_mode.set.requested", {
      threadId: req.params.threadId,
      mode
    });
    res.json(await client.request<any>("thread/memoryMode/set", {
      threadId: req.params.threadId,
      mode
    }));
  });

  app.post("/api/memory/reset", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("memory.reset.requested", {});
    res.json(await client.request<any>("memory/reset", req.body ?? {}));
  });

  app.post("/api/threads/:threadId/unsubscribe", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("thread.unsubscribe.requested", { threadId: req.params.threadId });
    await client.request("thread/unsubscribe", {
      threadId: req.params.threadId
    });
    res.json({ ok: true });
  });

  app.post("/api/threads/:threadId/mcp/resource/read", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const serverName = String(req.body?.server ?? "").trim();
    const uri = String(req.body?.uri ?? "").trim();
    if (!serverName || !uri) {
      res.status(400).json({ error: "server and uri are required" });
      return;
    }
    res.json(await client.request<any>("mcpServer/resource/read", {
      threadId: req.params.threadId,
      server: serverName,
      uri
    }));
  });

  app.post("/api/threads/:threadId/mcp/tool/call", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const serverName = String(req.body?.server ?? "").trim();
    const tool = String(req.body?.tool ?? "").trim();
    if (!serverName || !tool) {
      res.status(400).json({ error: "server and tool are required" });
      return;
    }
    res.json(await client.request<any>("mcpServer/tool/call", {
      threadId: req.params.threadId,
      server: serverName,
      tool,
      arguments: req.body?.arguments,
      _meta: req.body?._meta
    }));
  });

  app.get("/api/threads/:threadId/diffs/:turnId", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const response = await client.request<any>("thread/read", {
      threadId: req.params.threadId,
      includeTurns: true
    });
    const turn = (response.thread.turns ?? []).find((entry: any) => entry.id === req.params.turnId);
    const fileChanges = (turn?.items ?? []).filter((item: any) => item.type === "fileChange");
    const previews: DiffPreview[] = fileChanges.flatMap((item: any) =>
      (item.changes ?? []).map(buildDiffPreview)
    );
    res.json({
      diff: turnDiffs.get(`${req.params.threadId}:${req.params.turnId}`) ?? "",
      previews
    });
  });

  app.get("/api/approvals", (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    res.json(Array.from(pendingApprovals.values()).filter((entry) => entry.status === "pending"));
  });

  app.post("/api/approvals/:approvalId/decision", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    const approval = pendingApprovals.get(req.params.approvalId);
    if (!approval) {
      res.status(404).json({ error: "审批请求不存在" });
      return;
    }
    const resolution = req.body as ApprovalResolution;
    if (approval.kind === "command") {
      client.respond(approval.requestId, { decision: resolution.decision });
    } else if (approval.kind === "fileChange") {
      client.respond(approval.requestId, { decision: resolution.decision });
    } else {
      client.respond(approval.requestId, {
        decision: resolution.decision,
        answers: resolution.answers ?? {}
      });
    }
    approval.status = "resolved";
    approval.resolvedAt = Date.now();
    approval.resolutionDecision = resolution.decision;
    approval.resolutionAnswers = resolution.answers ?? null;
    pendingApprovals.set(approval.id, approval);
    logger.log("approval.resolved", {
      approvalId: approval.id,
      decision: resolution.decision,
      answers: resolution.answers
    });
    broadcast({ type: "approval.resolved", payload: approval });
    res.json({ ok: true });
  });

  app.get("/api/settings", (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    res.json(settingsSummary());
  });

  const staticDir = appConfig.webStaticDir;
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    // Express 5 requires a named wildcard parameter for SPA fallbacks.
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  server.on("upgrade", (req, socket, head) => {
    if (!isOriginAllowed(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "snapshot", payload: snapshot() } satisfies FrontendEvent));
  });

  const start = async () => {
    server.on("error", (error) => {
      logger.log("error.server.listen", {
        message: error instanceof Error ? error.message : String(error),
        host: appConfig.host,
        port: appConfig.serverPort
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(appConfig.serverPort, appConfig.host, () => {
        logger.log("server.started", {
          host: appConfig.host,
          port: appConfig.serverPort
        });
        resolve();
      });
    });

    void (async () => {
      try {
        await client.start();
        await refreshAccount();
        await refreshThreads();
      } catch (error) {
        logger.log("error.app_server.init", {
          message:
            error instanceof Error
              ? error.message
              : "无法初始化 codex app-server，请确认 codex 已安装且可执行"
        });
      }
    })();
  };

  return { app, start };
}
