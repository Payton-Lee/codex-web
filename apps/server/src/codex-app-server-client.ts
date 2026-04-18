import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import path from "node:path";

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ClientOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  restartMs: number;
  logger: { log(type: string, payload: Record<string, unknown>): void };
}

export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (value: any) => void; reject: (reason?: unknown) => void; method: string }
  >();
  private state: "stopped" | "starting" | "ready" | "error" = "stopped";
  private lastError: string | undefined;
  private manualStop = false;

  constructor(private readonly options: ClientOptions) {
    super();
  }

  getStatus() {
    return {
      connected: this.state === "ready",
      status: this.state,
      error: this.lastError
    };
  }

  async start(): Promise<void> {
    if (this.child || this.state === "starting" || this.state === "ready") {
      return;
    }

    this.state = "starting";
    this.manualStop = false;
    this.options.logger.log("app_server.starting", {
      command: this.options.command,
      args: this.options.args
    });

    const spawnSpec = this.resolveSpawnSpec();
    this.options.logger.log("app_server.spawn", {
      command: spawnSpec.command,
      args: spawnSpec.args,
      shell: spawnSpec.shell
    });

    this.child = spawn(spawnSpec.command, spawnSpec.args, {
      env: this.options.env,
      stdio: "pipe",
      shell: spawnSpec.shell
    });

    this.child.on("error", (error) => {
      this.lastError = error.message;
      this.state = "error";
      this.emit("status", this.getStatus());
      this.options.logger.log("error.app_server.spawn", { message: error.message });
    });

    this.child.on("exit", (code, signal) => {
      this.options.logger.log("app_server.exit", { code, signal, manualStop: this.manualStop });
      this.child = null;
      this.state = this.manualStop ? "stopped" : "error";
      this.emit("status", this.getStatus());
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Codex app-server 已断开"));
      }
      this.pending.clear();
      if (!this.manualStop) {
        setTimeout(() => {
          void this.start().catch((error) => {
            this.options.logger.log("error.app_server.restart", {
              message: error instanceof Error ? error.message : String(error)
            });
          });
        }, this.options.restartMs);
      }
    });

    const stdoutReader = createInterface({ input: this.child.stdout });
    stdoutReader.on("line", (line) => {
      this.handleLine(line);
    });

    const stderrReader = createInterface({ input: this.child.stderr });
    stderrReader.on("line", (line) => {
      this.options.logger.log("app_server.stderr", { line });
    });

    try {
      await this.initialize();
      this.state = "ready";
      this.lastError = undefined;
      this.emit("status", this.getStatus());
      this.options.logger.log("app_server.ready", {});
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = "error";
      this.emit("status", this.getStatus());
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.manualStop = true;
    this.child?.kill();
    this.child = null;
    this.state = "stopped";
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.child) {
      throw new Error("Codex app-server 尚未启动");
    }
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    this.write(payload);
    return promise;
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: JsonRpcId, message: string, data?: unknown): void {
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message, data }
    });
  }

  private resolveSpawnSpec(): { command: string; args: string[]; shell: boolean } {
    const command = this.options.command.trim();
    const args = [...this.options.args];
    const isWindows = process.platform === "win32";
    const extension = path.extname(command).toLowerCase();
    const needsCmdShim = isWindows && (extension === ".cmd" || extension === ".bat");

    if (!needsCmdShim) {
      return { command, args, shell: false };
    }

    return {
      command,
      args,
      shell: true
    };
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "codex_web_local",
        title: "Codex Web Local UI",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.write({ jsonrpc: "2.0", method: "initialized" });
  }

  private write(payload: Record<string, unknown>): void {
    if (!this.child) {
      throw new Error("Codex app-server 尚未启动");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcRequest | JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcRequest | JsonRpcResponse;
    } catch {
      this.options.logger.log("error.app_server.invalid_json", { line });
      return;
    }

    if ("method" in message && message.method) {
      if ("id" in message && typeof message.id !== "undefined") {
        this.emit("serverRequest", message);
        return;
      }
      this.emit("notification", message);
      return;
    }

    if ("id" in message && typeof message.id !== "undefined" && !("method" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if ("error" in message && message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve("result" in message ? message.result : undefined);
    }
  }
}
