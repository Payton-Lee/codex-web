import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Monitor, Play, RefreshCw, Terminal, Trash2 } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";

type TerminalTabProps = {
  cwd?: string | null;
};

type ExecDeltaEvent = {
  type: "command.exec.delta";
  payload: {
    processId: string;
    stream: "stdout" | "stderr";
    deltaBase64: string;
    capReached: boolean;
  };
};

function isExecDeltaEvent(value: unknown): value is ExecDeltaEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "command.exec.delta") {
    return false;
  }
  const payload = record.payload;
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const payloadRecord = payload as Record<string, unknown>;
  return (
    typeof payloadRecord.processId === "string" &&
    typeof payloadRecord.deltaBase64 === "string" &&
    (payloadRecord.stream === "stdout" || payloadRecord.stream === "stderr")
  );
}

function base64ToText(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function makeShellCommand(command: string): string[] {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  return ["sh", "-lc", command];
}

function normalizeWindowsPath(pathValue: string | null | undefined): string | undefined {
  if (!pathValue) {
    return undefined;
  }
  return pathValue.startsWith("\\\\?\\") ? pathValue.slice(4) : pathValue;
}

function nextProcessId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `terminal-${Date.now()}`;
}

function getResponseProcessId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const processId = record.processId;
  return typeof processId === "string" && processId.trim() ? processId : null;
}

export function TerminalTab({ cwd }: TerminalTabProps) {
  const interactiveSupported = false;
  const [command, setCommand] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState(cwd ?? "");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [processId, setProcessId] = useState<string | null>(null);
  const [capReached, setCapReached] = useState(false);
  const [launching, setLaunching] = useState(false);
  const outputRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    setWorkingDirectory(cwd ?? "");
  }, [cwd]);

  useEffect(() => {
    outputRef.current?.scrollTo({
      top: outputRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [output]);

  useEffect(() => {
    if (!interactiveSupported) {
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as unknown;
      if (!isExecDeltaEvent(message)) {
        return;
      }
      if (!processId || message.payload.processId !== processId) {
        return;
      }
      const text = base64ToText(message.payload.deltaBase64);
      setOutput((previous) => `${previous}${text}`);
      setCapReached(message.payload.capReached);
    };
    return () => {
      socket.close();
    };
  }, [interactiveSupported, processId]);

  const statusLabel = useMemo(() => {
    if (launching) {
      return "Starting";
    }
    if (running) {
      return "Running";
    }
    return "Idle";
  }, [launching, running]);

  const startCommand = async () => {
    const trimmed = command.trim();
    if (!trimmed) {
      return;
    }
    const nextId = nextProcessId();
    setError(null);
    setOutput((previous) =>
      previous.length > 0 ? `${previous}\n\n$ ${trimmed}\n` : `$ ${trimmed}\n`
    );
    setCapReached(false);
    setProcessId(nextId);
    setRunning(true);
    setLaunching(true);
    try {
      const response = await api.execCommandInteractive({
        command: makeShellCommand(trimmed),
        cwd: normalizeWindowsPath(workingDirectory || cwd || undefined),
        processId: nextId,
        tty: interactiveSupported,
        disableTimeout: false
      });
      const resolvedProcessId = getResponseProcessId(response) ?? nextId;
      setProcessId(resolvedProcessId);
      setLaunching(false);
      setRunning(false);
      if (response && typeof response === "object") {
        const record = response as Record<string, unknown>;
        if (typeof record.stdout === "string" && record.stdout) {
          setOutput((previous) => `${previous}${record.stdout}`);
        }
        if (typeof record.stderr === "string" && record.stderr) {
          setOutput((previous) => `${previous}${record.stderr}`);
        }
      }
    } catch (startError) {
      setLaunching(false);
      setRunning(false);
      setError(startError instanceof Error ? startError.message : String(startError));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Terminal size={16} className="text-emerald-300" />
            <span>Terminal</span>
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-text-secondary">{statusLabel}</span>
            {capReached ? <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-200">Output capped</span> : null}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-text-secondary" title={workingDirectory || cwd || ""}>
            {workingDirectory || cwd || "Default shell cwd"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setOutput("");
              setError(null);
              setCapReached(false);
            }}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
          >
            <Trash2 size={13} className="inline" />
            <span className="ml-1">Clear</span>
          </button>
          <button
            type="button"
            onClick={() => void startCommand()}
            disabled={launching}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-black disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Play size={13} className="inline" />
            <span className="ml-1">{launching ? "Running..." : "Run"}</span>
          </button>
        </div>
      </div>

      <div className="grid gap-3 border-b border-border bg-sidebar/30 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void startCommand();
            }
          }}
          placeholder="Command, e.g. python -m pytest"
          className="rounded-lg border border-border bg-black/20 px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-secondary"
        />
        <div className="flex items-center gap-2 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm text-text-secondary">
          <Monitor size={14} />
          <input
            value={workingDirectory}
            onChange={(event) => setWorkingDirectory(event.target.value)}
            placeholder="Working directory"
            className="w-full bg-transparent text-text-primary outline-none placeholder:text-text-secondary"
          />
        </div>
        <button
          type="button"
          onClick={() => void startCommand()}
          className="rounded-lg border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          <RefreshCw size={14} className={cn("inline", launching && "animate-spin")} />
          <span className="ml-1">Start</span>
        </button>
      </div>

      {!interactiveSupported ? (
        <div className="mx-4 mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-300" />
            <div>
              Windows sandbox currently supports one-off command execution only.
              Interactive stdin, stop, resize, and PTY streaming are disabled here.
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="m-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden bg-[#111111]">
        <pre
          ref={outputRef}
          className="h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[13px] leading-6 text-[#d4d4d4]"
        >
          {output || "Run a command to display stdout and stderr here."}
        </pre>
      </div>

      <div className="flex gap-3 border-t border-border bg-sidebar/30 p-4">
        <input
          value=""
          readOnly
          disabled
          placeholder="Interactive stdin is unavailable in the current Windows sandbox runtime"
          className="flex-1 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="button"
          disabled
          className="rounded-lg border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
