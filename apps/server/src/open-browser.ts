import { spawn } from "node:child_process";

export interface BrowserOpenResult {
  ok: boolean;
  message: string;
}

function buildOpenCommand(url: string): { command: string; args: string[] } {
  const platform = process.platform;

  if (platform === "win32") {
    // `start` is a cmd builtin. Wrap the URL so `&` inside OAuth query strings
    // is treated as part of the argument instead of a command separator.
    return {
      command: "cmd",
      args: ["/d", "/s", "/c", "start", "", `"${url.replace(/"/g, '""')}"`]
    };
  }

  if (platform === "darwin") {
    return {
      command: "open",
      args: [url]
    };
  }

  return {
    command: "xdg-open",
    args: [url]
  };
}

export function openSystemBrowser(url: string): Promise<BrowserOpenResult> {
  return new Promise((resolve) => {
    const { command, args } = buildOpenCommand(url);

    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    let settled = false;

    child.once("error", (error) => {
      settled = true;
      resolve({
        ok: false,
        message: error.message
      });
    });

    child.once("spawn", () => {
      if (settled) {
        return;
      }
      settled = true;
      child.unref();
      resolve({
        ok: true,
        message: `opened via ${command}`
      });
    });
  });
}

