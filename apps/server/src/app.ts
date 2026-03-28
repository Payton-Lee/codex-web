import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express, { Request, Response } from "express";
import { WebSocketServer } from "ws";
import {
  AccountSummary,
  ApprovalRequest,
  ApprovalResolution,
  DiffPreview,
  FrontendEvent,
  LoadedThreadsSummary,
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
          resetsAt: rateLimits.primary.resetsAt ?? null,
          windowSeconds: rateLimits.primary.windowSeconds ?? null
        }
      : null,
    secondary: rateLimits.secondary
      ? {
          used: rateLimits.secondary.used ?? null,
          limit: rateLimits.secondary.limit ?? null,
          resetsAt: rateLimits.secondary.resetsAt ?? null,
          windowSeconds: rateLimits.secondary.windowSeconds ?? null
        }
      : null,
    creditsRemaining: rateLimits.credits?.remaining ?? null
  };
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
      settings: settingsSummary()
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

    const requestId = String(message.id);
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
    const response = await client.request<any>("turn/start", {
      threadId: req.params.threadId,
      cwd,
      input: [{ type: "text", text: prompt, text_elements: [] }]
    });
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
    server.on("error", (error) => {
      logger.log("error.server.listen", {
        message: error instanceof Error ? error.message : String(error),
        host: appConfig.host,
        port: appConfig.serverPort
      });
    });
    server.listen(appConfig.serverPort, appConfig.host, () => {
      logger.log("server.started", {
        host: appConfig.host,
        port: appConfig.serverPort
      });
    });
  };

  return { app, start };
}
