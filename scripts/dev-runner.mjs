import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(rootDir, "codex-web.config.json");
const args = new Set(process.argv.slice(2));
const desktopMode = args.has("--desktop");

const fileConfig = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};

const host = process.env.HOST ?? fileConfig.host ?? "127.0.0.1";
const serverPort = Number(process.env.SERVER_PORT ?? fileConfig.serverPort ?? 9000);
const webPort = Number(process.env.WEB_PORT ?? fileConfig.webPort ?? 10000);
const processes = [];
let shuttingDown = false;

function prefixOutput(name, colorCode, stream) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      process.stdout.write(`\u001b[${colorCode}m[${name}]\u001b[0m ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) {
      process.stdout.write(`\u001b[${colorCode}m[${name}]\u001b[0m ${buffer}\n`);
    }
  });
}

function createSpawnSpec(commandArgs) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `npm.cmd ${commandArgs.join(" ")}`]
    };
  }

  return {
    command: "npm",
    args: commandArgs
  };
}

function spawnProcess(name, colorCode, commandArgs, options = {}) {
  const spec = createSpawnSpec(commandArgs);
  const child = spawn(spec.command, spec.args, {
    cwd: rootDir,
    env: { ...process.env, FORCE_COLOR: "1" },
    shell: false,
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });

  prefixOutput(name, colorCode, child.stdout);
  prefixOutput(name, colorCode, child.stderr);

  child.on("exit", (code, signal) => {
    const detail = signal ? `signal=${signal}` : `code=${code ?? "null"}`;
    process.stdout.write(`\u001b[${colorCode}m[${name}]\u001b[0m exited (${detail})\n`);
    if (!shuttingDown) {
      shutdown(typeof code === "number" ? code : 1);
    }
  });

  child.on("error", (error) => {
    process.stdout.write(`\u001b[${colorCode}m[${name}]\u001b[0m failed to start: ${error.message}\n`);
    if (!shuttingDown) {
      shutdown(1);
    }
  });

  processes.push(child);
  return child;
}

function ensurePortAvailable(port, label, hostAddress = host) {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();

    tester.once("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        reject(new Error(`${label} port ${hostAddress}:${port} is already in use`));
        return;
      }
      reject(error);
    });

    tester.once("listening", () => {
      tester.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve();
      });
    });

    tester.listen(port, hostAddress);
  });
}

async function waitForHttpReady(url, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown error";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`${label} did not become ready in time: ${lastError}`);
}

function waitForSharedReady(child, timeoutMs = 30000) {
  const readyPattern = /(Watching for file changes\.|Found \d+ errors?\.\s*Watching for file changes\.)/i;

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error("shared watcher did not report ready in time"));
    }, timeoutMs);

    const onData = (chunk) => {
      const text = String(chunk);
      if (readyPattern.test(text)) {
        cleanup();
        resolve();
      }
    };

    const onExit = (code) => {
      cleanup();
      reject(new Error(`shared watcher exited before ready (code=${code ?? "null"})`));
    };

    const cleanup = () => {
      clearTimeout(deadline);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const child of processes) {
    if (!child.killed) {
      child.kill();
    }
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 50);
}

async function main() {
  process.stdout.write("Starting codex-web dev runner...\n");
  process.stdout.write(`Order: shared -> server -> web${desktopMode ? " -> desktop" : ""}\n`);
  process.stdout.write(`Server health: http://${host}:${serverPort}/api/health\n`);
  process.stdout.write(`Web url:       http://${host}:${webPort}/\n`);

  const shared = spawnProcess("shared", "36", ["run", "dev:shared"]);
  await waitForSharedReady(shared);
  process.stdout.write("[runner] shared is watching for changes\n");

  await ensurePortAvailable(serverPort, "server");
  spawnProcess("server", "32", ["run", "dev", "-w", "@codex-web/server"]);
  await waitForHttpReady(`http://${host}:${serverPort}/api/health`, "server");
  process.stdout.write("[runner] server is ready\n");

  await ensurePortAvailable(webPort, "web");
  spawnProcess("web", "35", ["run", "dev", "-w", "@codex-web/web"]);
  await waitForHttpReady(`http://${host}:${webPort}/`, "web");
  process.stdout.write("[runner] web is ready\n");

  if (desktopMode) {
    spawnProcess("desktop", "33", ["run", "start:dev", "-w", "@codex-web/desktop"]);
    process.stdout.write("[runner] desktop process started\n");
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

process.on("uncaughtException", (error) => {
  console.error("[runner] uncaught exception:", error);
  shutdown(1);
});

process.on("unhandledRejection", (error) => {
  console.error("[runner] unhandled rejection:", error);
  shutdown(1);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[runner] failed:", error instanceof Error ? error.message : String(error));
    shutdown(1);
  });
}
