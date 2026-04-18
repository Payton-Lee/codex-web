import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultHost = process.env.HOST ?? "127.0.0.1";
const defaultWebPort = Number(process.env.WEB_PORT ?? 10000);
const defaultServerPort = Number(process.env.SERVER_PORT ?? 9000);

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let isQuitting = false;
let desktopLogFilePath: string | null = null;

function isDevMode(): boolean {
  return !app.isPackaged || process.env.CODEX_DESKTOP_DEV === "1";
}

function ensureDir(targetPath: string): string {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function initializeDesktopLogger(): void {
  const logsDir = ensureDir(path.join(app.getPath("userData"), "logs"));
  desktopLogFilePath = path.join(logsDir, "desktop-main.log");
  writeDesktopLog("logger.initialized", { logFilePath: desktopLogFilePath });
}

function writeDesktopLog(message: string, extra?: Record<string, unknown>): void {
  if (!desktopLogFilePath) {
    return;
  }

  const payload = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    message,
    ...(extra ?? {})
  };

  try {
    fs.appendFileSync(desktopLogFilePath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // Ignore logging failures to avoid breaking startup.
  }
}

function getProductionServerEntry(): string {
  return path.join(process.resourcesPath, "app.asar.unpacked", "bundle", "server", "index.js");
}

function getProductionWebDist(): string {
  return path.join(process.resourcesPath, "web");
}

function getPathDelimiter(): string {
  return process.platform === "win32" ? ";" : ":";
}

function getBundledCodexTriple(): string | null {
  if (process.platform === "win32" && process.arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return "aarch64-pc-windows-msvc";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "x86_64-apple-darwin";
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "x86_64-unknown-linux-musl";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "aarch64-unknown-linux-musl";
  }
  return null;
}

function getBundledCodexPaths(): {
  command: string;
  pathEntries: string[];
} | null {
  const triple = getBundledCodexTriple();
  if (!triple) {
    return null;
  }

  const codexBinaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const codexRoot = path.join(process.resourcesPath, "codex", triple);
  const command = path.join(codexRoot, "codex", codexBinaryName);
  const pathDir = path.join(codexRoot, "path");

  if (!fs.existsSync(command)) {
    return null;
  }

  const pathEntries = fs.existsSync(pathDir) ? [pathDir] : [];
  return { command, pathEntries };
}

function getDevelopmentRendererUrl(): string {
  return process.env.CODEX_DESKTOP_RENDERER_URL ?? `http://${defaultHost}:${defaultWebPort}`;
}

function getProductionServerUrl(): string {
  return `http://${defaultHost}:${defaultServerPort}`;
}

async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  const startedAt = Date.now();
  let attempts = 0;
  writeDesktopLog("server.wait.begin", { url, timeoutMs });

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    try {
      const response = await fetch(`${url}/api/health`);
      writeDesktopLog("server.wait.poll", {
        url,
        attempts,
        status: response.status,
        ok: response.ok
      });
      if (response.ok) {
        writeDesktopLog("server.wait.ready", {
          url,
          attempts,
          elapsedMs: Date.now() - startedAt
        });
        return;
      }
    } catch (error) {
      writeDesktopLog("server.wait.error", {
        url,
        attempts,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out while waiting for local server: ${url}`);
}

function stopServerProcess(): void {
  if (!serverProcess || serverProcess.killed) {
    writeDesktopLog("server.stop.skip", { hasProcess: Boolean(serverProcess) });
    serverProcess = null;
    return;
  }

  writeDesktopLog("server.stop.begin", { pid: serverProcess.pid ?? null });
  serverProcess.kill();
  serverProcess = null;
}

function createWindow(targetUrl: string): BrowserWindow {
  writeDesktopLog("window.create.begin", { targetUrl });
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: "#0d1117",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(currentDir, "preload.js")
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    writeDesktopLog("window.openExternal", { url });
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(targetUrl)) {
      writeDesktopLog("window.navigate.external", { url, targetUrl });
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    writeDesktopLog("window.load.failed", {
      errorCode,
      errorDescription,
      validatedURL
    });
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    writeDesktopLog("window.render-process-gone", {
      reason: details.reason,
      exitCode: details.exitCode
    });
  });

  window.once("ready-to-show", () => {
    writeDesktopLog("window.ready-to-show", { targetUrl });
    window.show();
  });

  void window.loadURL(targetUrl);
  return window;
}

function startBundledServer(): void {
  const userDataDir = app.getPath("userData");
  const serverEntry = getProductionServerEntry();
  const webDist = getProductionWebDist();
  const bundledCodex = getBundledCodexPaths();
  const logsDir = ensureDir(path.join(userDataDir, "logs"));
  const dataDir = ensureDir(path.join(userDataDir, "data"));
  const codexHomeDir = ensureDir(path.join(userDataDir, "codex-home"));
  const serverPath = [
    ...(bundledCodex?.pathEntries ?? []),
    process.env.PATH ?? ""
  ].filter(Boolean).join(getPathDelimiter());

  writeDesktopLog("server.start.prepare", {
    userDataDir,
    serverEntry,
    webDist,
    logsDir,
    dataDir,
    codexHomeDir,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    bundledCodexCommand: bundledCodex?.command ?? null,
    bundledCodexPathEntries: bundledCodex?.pathEntries ?? []
  });

  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Missing packaged server entry: ${serverEntry}`);
  }
  if (!fs.existsSync(webDist)) {
    throw new Error(`Missing packaged web assets: ${webDist}`);
  }

  serverProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOST: defaultHost,
      SERVER_PORT: String(defaultServerPort),
      CODEX_WEB_STATIC_DIR: webDist,
      DATA_DIR: dataDir,
      AUDIT_LOG_DIR: logsDir,
      CODEX_HOME_DIR: codexHomeDir,
      CODEX_APP_SERVER_COMMAND: bundledCodex?.command ?? "",
      ALLOWED_ORIGINS: [
        `http://${defaultHost}:${defaultServerPort}`,
        `http://localhost:${defaultServerPort}`
      ].join(","),
      PATH: serverPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  writeDesktopLog("server.start.spawned", {
    pid: serverProcess.pid ?? null,
    execPath: process.execPath,
    serverEntry
  });

  serverProcess.once("error", (error) => {
    writeDesktopLog("server.process.error", {
      error: error.message,
      name: error.name
    });
  });

  serverProcess.once("spawn", () => {
    writeDesktopLog("server.process.spawn", { pid: serverProcess?.pid ?? null });
  });

  serverProcess.stdout?.on("data", (chunk) => {
    writeDesktopLog("server.stdout", {
      pid: serverProcess?.pid ?? null,
      output: chunk.toString("utf8").trim()
    });
  });

  serverProcess.stderr?.on("data", (chunk) => {
    writeDesktopLog("server.stderr", {
      pid: serverProcess?.pid ?? null,
      output: chunk.toString("utf8").trim()
    });
  });

  serverProcess.once("exit", (code, signal) => {
    writeDesktopLog("server.process.exit", { code, signal, isQuitting });
    serverProcess = null;
    if (!isQuitting) {
      dialog.showErrorBox(
        "本地服务已退出",
        `桌面版依赖的本地服务已退出。\nexitCode=${code ?? "null"} signal=${signal ?? "null"}`
      );
      app.quit();
    }
  });
}

async function bootstrapApplication(): Promise<void> {
  writeDesktopLog("bootstrap.begin", {
    isPackaged: app.isPackaged,
    devMode: isDevMode(),
    platform: process.platform
  });

  if (isDevMode()) {
    const targetUrl = getDevelopmentRendererUrl();
    writeDesktopLog("bootstrap.dev", { targetUrl });
    mainWindow = createWindow(targetUrl);
    return;
  }

  startBundledServer();
  const serverUrl = getProductionServerUrl();
  await waitForServer(serverUrl);
  mainWindow = createWindow(serverUrl);
}

app.on("window-all-closed", () => {
  writeDesktopLog("app.window-all-closed", { platform: process.platform });
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  writeDesktopLog("app.before-quit");
  stopServerProcess();
});

app.on("activate", async () => {
  writeDesktopLog("app.activate", { windowCount: BrowserWindow.getAllWindows().length });
  if (BrowserWindow.getAllWindows().length === 0) {
    await bootstrapApplication();
  }
});

void app.whenReady()
  .then(() => {
    initializeDesktopLogger();
    writeDesktopLog("app.ready");
    return bootstrapApplication();
  })
  .catch((error) => {
    writeDesktopLog("app.bootstrap.failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    dialog.showErrorBox(
      "桌面版启动失败",
      error instanceof Error ? error.message : String(error)
    );
    app.quit();
  });
