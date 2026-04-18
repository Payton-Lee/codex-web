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

function isDevMode(): boolean {
  return !app.isPackaged || process.env.CODEX_DESKTOP_DEV === "1";
}

function resolvePackagedResourceDir(): string {
  return process.resourcesPath;
}

function getPackagedAppRoot(): string {
  return app.getAppPath();
}

function ensureDir(targetPath: string): string {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function getProductionServerEntry(): string {
  return path.join(resolvePackagedResourceDir(), "app.asar.unpacked", "bundle", "server", "index.js");
}

function getProductionWebDist(): string {
  return path.join(resolvePackagedResourceDir(), "web");
}

function getDevelopmentRendererUrl(): string {
  return process.env.CODEX_DESKTOP_RENDERER_URL ?? `http://${defaultHost}:${defaultWebPort}`;
}

function getProductionServerUrl(): string {
  return `http://${defaultHost}:${defaultServerPort}`;
}

async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out while waiting for local server: ${url}`);
}

function stopServerProcess(): void {
  if (!serverProcess || serverProcess.killed) {
    serverProcess = null;
    return;
  }
  serverProcess.kill();
  serverProcess = null;
}

function createWindow(targetUrl: string): BrowserWindow {
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
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(targetUrl)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  void window.loadURL(targetUrl);
  return window;
}

function startBundledServer(): void {
  const userDataDir = app.getPath("userData");
  const serverEntry = getProductionServerEntry();
  const webDist = getProductionWebDist();
  const logsDir = ensureDir(path.join(userDataDir, "logs"));
  const dataDir = ensureDir(path.join(userDataDir, "data"));
  const codexHomeDir = ensureDir(path.join(userDataDir, "codex-home"));

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
      ALLOWED_ORIGINS: [
        `http://${defaultHost}:${defaultServerPort}`,
        `http://localhost:${defaultServerPort}`
      ].join(",")
    },
    stdio: "ignore"
  });

  serverProcess.once("exit", (code, signal) => {
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
  if (isDevMode()) {
    mainWindow = createWindow(getDevelopmentRendererUrl());
    return;
  }

  startBundledServer();
  const serverUrl = getProductionServerUrl();
  await waitForServer(serverUrl);
  mainWindow = createWindow(serverUrl);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopServerProcess();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await bootstrapApplication();
  }
});

void app.whenReady()
  .then(bootstrapApplication)
  .catch((error) => {
    dialog.showErrorBox(
      "桌面版启动失败",
      error instanceof Error ? error.message : String(error)
    );
    app.quit();
  });
