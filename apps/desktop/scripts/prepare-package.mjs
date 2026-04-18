import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const repoRoot = path.resolve(desktopDir, "../..");
const bundleDir = path.join(desktopDir, "bundle");
const desktopPackageJsonPath = path.join(desktopDir, "package.json");
const desktopNodeModulesDir = path.join(desktopDir, "node_modules");
const rootNodeModulesDir = path.join(repoRoot, "node_modules");
const serverSourceDir = path.join(repoRoot, "apps", "server", "dist");
const webSourceDir = path.join(repoRoot, "apps", "web", "dist");
const codexVendorSourceDir = path.join(
  repoRoot,
  "node_modules",
  "@openai",
  resolveCodexPlatformPackageName(),
  "vendor"
);
const serverTargetDir = path.join(bundleDir, "server");
const webTargetDir = path.join(bundleDir, "web");
const codexTargetDir = path.join(bundleDir, "codex");
const serverRuntimeModules = ["better-sqlite3", "bindings", "file-uri-to-path"];

function resolveCodexPlatformPackageName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32" && arch === "x64") {
    return "codex-win32-x64";
  }
  if (platform === "win32" && arch === "arm64") {
    return "codex-win32-arm64";
  }
  if (platform === "darwin" && arch === "x64") {
    return "codex-darwin-x64";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "codex-darwin-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return "codex-linux-x64";
  }
  if (platform === "linux" && arch === "arm64") {
    return "codex-linux-arm64";
  }

  throw new Error(`Unsupported platform for packaged Codex bundle: ${platform}/${arch}`);
}

function ensureSourceExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`);
  }
}

function copyDirectory(sourceDir, targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getElectronRebuildCommand() {
  if (process.platform === "win32") {
    return path.join(desktopNodeModulesDir, ".bin", "electron-rebuild.cmd");
  }
  return path.join(desktopNodeModulesDir, ".bin", "electron-rebuild");
}

function preparePackagedServerRuntime() {
  const runtimeNodeModulesDir = path.join(serverTargetDir, "node_modules");
  const desktopPackageJson = readJsonFile(desktopPackageJsonPath);
  const electronVersion = desktopPackageJson.devDependencies?.electron;

  if (!electronVersion) {
    throw new Error(`Missing devDependencies.electron in ${desktopPackageJsonPath}`);
  }

  const runtimePackageJson = {
    name: "@codex-web/desktop-server-runtime",
    private: true,
    type: "module",
    dependencies: Object.fromEntries(
      serverRuntimeModules.map((moduleName) => {
        const modulePackageJsonPath = path.join(rootNodeModulesDir, moduleName, "package.json");
        const modulePackageJson = readJsonFile(modulePackageJsonPath);
        return [moduleName, modulePackageJson.version];
      })
    )
  };

  fs.writeFileSync(
    path.join(serverTargetDir, "package.json"),
    `${JSON.stringify(runtimePackageJson, null, 2)}\n`,
    "utf8"
  );

  for (const moduleName of serverRuntimeModules) {
    copyDirectory(
      path.join(rootNodeModulesDir, moduleName),
      path.join(runtimeNodeModulesDir, moduleName)
    );
  }

  const rebuildResult = spawnSync(
    getElectronRebuildCommand(),
    ["-v", electronVersion, "-m", serverTargetDir, "-w", "better-sqlite3", "-f"],
    {
      cwd: desktopDir,
      stdio: "inherit",
      shell: process.platform === "win32"
    }
  );

  if (rebuildResult.status !== 0) {
    throw new Error(
      `electron-rebuild failed for packaged server runtime (exit=${rebuildResult.status ?? "null"})`
    );
  }
}

ensureSourceExists(serverSourceDir, "Server build output");
ensureSourceExists(webSourceDir, "Web build output");
ensureSourceExists(codexVendorSourceDir, "Codex vendor bundle");

fs.rmSync(bundleDir, { recursive: true, force: true });
copyDirectory(serverSourceDir, serverTargetDir);
copyDirectory(webSourceDir, webTargetDir);
copyDirectory(codexVendorSourceDir, codexTargetDir);
preparePackagedServerRuntime();

console.log(`Prepared desktop bundle at ${bundleDir}`);
