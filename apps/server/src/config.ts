import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentFileDir, "../../..");

dotenv.config({ path: path.resolve(rootDir, ".env") });

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function expandTomlOverrideFile(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf8");
  const overrides: string[] = [];
  let sectionPath: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      sectionPath = sectionMatch[1]
        .split(".")
        .map((part) => part.trim())
        .filter(Boolean);
      continue;
    }

    const equalIndex = line.indexOf("=");
    if (equalIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalIndex).trim();
    const value = line.slice(equalIndex + 1).trim();
    if (!key || !value) {
      continue;
    }

    const dottedKey = [...sectionPath, key].join(".");
    overrides.push(`${dottedKey}=${value}`);
  }

  return overrides;
}

function existingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveCodexCommand(
  explicitCommand: string | undefined,
  cwd: string
): { command: string; source: "explicit" | "local" | "global" } {
  if (explicitCommand?.trim()) {
    return {
      command: explicitCommand.trim(),
      source: "explicit"
    };
  }

  const localBinName = process.platform === "win32" ? "codex.cmd" : "codex";
  const localCommand = existingPath([
    path.resolve(cwd, "node_modules", ".bin", localBinName),
    path.resolve(cwd, "apps/server", "node_modules", ".bin", localBinName),
    path.resolve(cwd, "apps/web", "node_modules", ".bin", localBinName)
  ]);

  if (localCommand) {
    return {
      command: localCommand,
      source: "local"
    };
  }

  return {
    command: "codex",
    source: "global"
  };
}

const configFilePath = path.resolve(rootDir, "codex-web.config.json");
const fileConfig = fs.existsSync(configFilePath)
  ? (JSON.parse(fs.readFileSync(configFilePath, "utf8")) as {
      host?: string;
      webPort?: number;
      serverPort?: number;
      appServerPort?: number;
      codexCommand?: string;
      allowedOrigins?: string[];
      allowedWorkspaces?: string[];
    })
  : {};
const host = process.env.HOST ?? fileConfig.host ?? "127.0.0.1";
const serverPort = parseNumber(process.env.SERVER_PORT, fileConfig.serverPort ?? 9000);
const webPort = parseNumber(process.env.WEB_PORT, fileConfig.webPort ?? 10000);
const appServerPort = parseNumber(process.env.APP_SERVER_PORT, fileConfig.appServerPort ?? 4500);
const auditLogDir = path.resolve(rootDir, process.env.AUDIT_LOG_DIR ?? "logs");
const dataDir = path.resolve(rootDir, process.env.DATA_DIR ?? "data");
const resolvedCodexCommand = resolveCodexCommand(
  process.env.CODEX_APP_SERVER_COMMAND ?? fileConfig.codexCommand,
  rootDir
);
const codexArgs = parseList(process.env.CODEX_APP_SERVER_ARGS).length
  ? parseList(process.env.CODEX_APP_SERVER_ARGS)
  : ["app-server"];
const allowedWorkspaces = (
  parseList(process.env.ALLOWED_WORKSPACES).length
    ? parseList(process.env.ALLOWED_WORKSPACES)
    : (fileConfig.allowedWorkspaces ?? [])
).map((entry) => path.resolve(entry));
const defaultWorkspace = process.env.DEFAULT_WORKSPACE
  ? path.resolve(process.env.DEFAULT_WORKSPACE)
  : allowedWorkspaces[0] ?? null;
const allowedOrigins = parseList(process.env.ALLOWED_ORIGINS).length
  ? parseList(process.env.ALLOWED_ORIGINS)
  : fileConfig.allowedOrigins?.length
    ? fileConfig.allowedOrigins
    : [`http://${host}:${webPort}`, `http://localhost:${webPort}`];

const codexConfigOverrideEntries = parseList(process.env.CODEX_CONFIG_OVERRIDES)
  .map((entry) => entry.trim())
  .filter(Boolean);
const codexConfigOverrideSources = codexConfigOverrideEntries.map((entry) => {
  const resolvedPath = path.resolve(rootDir, entry);
  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
    return resolvedPath;
  }
  return entry;
});
const codexConfigOverrides = codexConfigOverrideEntries.flatMap((entry) => {
  const resolvedPath = path.resolve(rootDir, entry);
  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
    return expandTomlOverrideFile(resolvedPath);
  }

  return [entry];
});

export const appConfig = {
  configFilePath,
  host,
  serverPort,
  webPort,
  appServerPort,
  auditLogDir,
  dataDir,
  workspaceDbPath: path.resolve(dataDir, process.env.WORKSPACE_DB_FILE ?? "workspaces.db"),
  codexCommand: resolvedCodexCommand.command,
  codexCommandSource: resolvedCodexCommand.source,
  codexArgs,
  codexHomeDir: process.env.CODEX_HOME_DIR
    ? path.resolve(process.env.CODEX_HOME_DIR)
    : undefined,
  codexConfigOverrideSources,
  codexConfigOverrides,
  allowedWorkspaces,
  defaultWorkspace,
  allowedOrigins,
  appServerRestartMs: parseNumber(process.env.APP_SERVER_RESTART_MS, 1500),
  approvalPolicy: process.env.DEFAULT_APPROVAL_POLICY ?? "on-request",
  sandboxMode: process.env.DEFAULT_SANDBOX_MODE ?? "workspace-write"
} as const;
