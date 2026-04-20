import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = path.resolve(__dirname, "../..");
const configPath = path.resolve(rootDir, "codex-web.config.json");
const fileConfig = fs.existsSync(configPath)
  ? (JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      host?: string;
      webPort?: number;
      serverPort?: number;
    })
  : {};
const host = process.env.HOST ?? fileConfig.host ?? "127.0.0.1";
const webPort = Number(process.env.WEB_PORT ?? fileConfig.webPort ?? 10000);
const serverPort = Number(process.env.SERVER_PORT ?? fileConfig.serverPort ?? 9000);
const backendTarget = `http://${host}:${serverPort}`;

function silenceTransientProxySocketErrors(proxy: {
  on(event: string, listener: (error: NodeJS.ErrnoException) => void): void;
}): void {
  proxy.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ECONNABORTED" || error.code === "ECONNRESET") {
      return;
    }
    console.error("[vite-proxy]", error);
  });
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../../packages/shared/src")
    }
  },
  server: {
    host,
    port: webPort,
    proxy: {
      "/api": {
        target: backendTarget,
        changeOrigin: false
      },
      "/help": {
        target: backendTarget,
        changeOrigin: false
      },
      "/ws": {
        target: backendTarget,
        ws: true,
        configure: silenceTransientProxySocketErrors
      }
    }
  }
});
