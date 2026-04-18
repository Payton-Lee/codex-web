import { spawn } from "node:child_process";

export type FolderDialogResult =
  | { canceled: true; path: null }
  | { canceled: false; path: string };

function runCommand(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function openFolderDialogWindows(): Promise<FolderDialogResult> {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select workspace folder'",
    "$dialog.ShowNewFolderButton = $true",
    "$result = $dialog.ShowDialog()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  Write-Output $dialog.SelectedPath",
    "}"
  ].join("; ");

  const result = await runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-Command",
    script
  ]);

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Folder picker exited with code ${result.code ?? "unknown"}`);
  }

  const selectedPath = result.stdout.trim();
  if (!selectedPath) {
    return { canceled: true, path: null };
  }
  return { canceled: false, path: selectedPath };
}

async function openFolderDialogMac(): Promise<FolderDialogResult> {
  const result = await runCommand("osascript", [
    "-e",
    'POSIX path of (choose folder with prompt "Select workspace folder")'
  ]);
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    if (stderr.includes("User canceled")) {
      return { canceled: true, path: null };
    }
    throw new Error(stderr || `Folder picker exited with code ${result.code ?? "unknown"}`);
  }
  const selectedPath = result.stdout.trim();
  if (!selectedPath) {
    return { canceled: true, path: null };
  }
  return { canceled: false, path: selectedPath };
}

export async function openFolderDialog(): Promise<FolderDialogResult> {
  if (process.platform === "win32") {
    return openFolderDialogWindows();
  }
  if (process.platform === "darwin") {
    return openFolderDialogMac();
  }
  throw new Error("Folder picker is not implemented for this platform yet.");
}
