import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const repoRoot = path.resolve(desktopDir, "../..");
const bundleDir = path.join(desktopDir, "bundle");
const serverSourceDir = path.join(repoRoot, "apps", "server", "dist");
const webSourceDir = path.join(repoRoot, "apps", "web", "dist");
const serverTargetDir = path.join(bundleDir, "server");
const webTargetDir = path.join(bundleDir, "web");

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

ensureSourceExists(serverSourceDir, "Server build output");
ensureSourceExists(webSourceDir, "Web build output");

fs.rmSync(bundleDir, { recursive: true, force: true });
copyDirectory(serverSourceDir, serverTargetDir);
copyDirectory(webSourceDir, webTargetDir);

console.log(`Prepared desktop bundle at ${bundleDir}`);
