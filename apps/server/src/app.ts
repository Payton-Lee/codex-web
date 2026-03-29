import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
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
  ThreadSummary
} from "../../../packages/shared/src/index.js";
import { appConfig } from "./config.js";
import { AuditLogger } from "./logger.js";
import { WorkspaceGuard } from "./workspace-guard.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { openSystemBrowser } from "./open-browser.js";
import { buildDiffPreview } from "./diff-preview.js";
import { searchSkills, searchWorkspaceFiles } from "./composer.js";

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

function toThreadSummary(thread: any, status: ThreadSummary["status"] = "idle"): ThreadSummary {
  return {
    id: thread.id,
    preview: thread.preview,
    cwd: thread.cwd,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    modelProvider: thread.modelProvider,
    cliVersion: thread.cliVersion,
    source: thread.source,
    status
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

export function createApp() {
  fs.mkdirSync(appConfig.auditLogDir, { recursive: true });
  const logger = new AuditLogger(appConfig.auditLogDir);
  const workspaceGuard = new WorkspaceGuard(
    appConfig.allowedWorkspaces,
    appConfig.defaultWorkspace,
    appConfig.workspaceDbPath
  );
  const env = {
    ...process.env
  };
  if (appConfig.codexHomeDir) {
    fs.mkdirSync(appConfig.codexHomeDir, { recursive: true });
    env.CODEX_HOME = appConfig.codexHomeDir;
  }
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
    try {
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
      broadcast({ type: "account.updated", payload: account });
      return nextAccount;
    } catch {
      const fallback = await client.request<any>("getAuthStatus", {}).catch(() => null);
      account = {
        loggedIn: Boolean(fallback?.loggedIn ?? fallback?.authMode),
        mode: fallback?.authMode === "chatgpt" ? "chatgpt" : "unknown",
        email: fallback?.email ?? null,
        planType: fallback?.planType ?? null,
        requiresOpenaiAuth: false,
        rateLimits: null
      };
      broadcast({ type: "account.updated", payload: account });
      return account;
    }
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
    return Array.from(latestThreads.values()).sort((a, b) => b.updatedAt - a.updatedAt);
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
      turnStatusByThread.set(params.thread.id, "idle");
      threads.set(params.thread.id, toThreadSummary(params.thread, "idle"));
      broadcast({ type: "thread.started", payload: { threadId: params.thread.id } });
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
      method === "account/login/completed" ||
      method === "authStatusChange" ||
      method === "loginChatGptComplete"
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

  app.get("/api/bootstrap", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    await refreshAccount();
    await refreshThreads();
    await refreshAppServerCatalog().catch(() => appServerCatalog);
    res.json(snapshot());
  });

  app.get("/api/account", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    res.json(await refreshAccount());
  });

  app.post("/api/account/login", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("account.login.requested", {});
    try {
      const login = await client.request<any>("account/login/start", { type: "chatgpt" });
      if (login?.authUrl) {
        openSystemBrowser(login.authUrl);
      }
      res.json(login);
      return;
    } catch {
      const fallback = await client.request<any>("loginChatGpt", undefined);
      if (fallback?.authUrl) {
        openSystemBrowser(fallback.authUrl);
      }
      res.json(fallback);
    }
  });

  app.post("/api/account/logout", async (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    await ensureClientReady();
    logger.log("account.logout.requested", {});
    await client.request("account/logout", undefined).catch(() => client.request("logoutChatGpt", undefined));
    res.json(await refreshAccount());
  });

  app.get("/api/workspaces", (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    res.json(workspaceGuard.list());
  });

  app.post("/api/workspaces", (req, res) => {
    if (!requireOrigin(req, res)) {
      return;
    }
    try {
      const added = workspaceGuard.addWorkspace(String(req.body.path ?? ""));
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
      const selected = workspaceGuard.setCurrentWorkspace(String(req.body.path ?? ""));
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
      experimentalRawEvents: false
    });
    const summary = toThreadSummary(response.thread, "idle");
    threads.set(summary.id, summary);
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

  const staticDir = path.resolve(process.cwd(), "apps/web/dist");
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get("*", (_req, res) => {
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
