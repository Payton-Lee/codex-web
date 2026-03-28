import fs from "node:fs";
import path from "node:path";

export class AuditLogger {
  constructor(private readonly logDir: string) {
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  log(type: string, payload: Record<string, unknown>): void {
    const entry = {
      ts: new Date().toISOString(),
      type,
      payload
    };
    const line = `${JSON.stringify(entry)}\n`;
    const filePath = path.join(this.logDir, `${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(filePath, line, "utf8");
    if (type.startsWith("error") || type.includes("failed")) {
      console.error(`[${entry.ts}] ${type}`, payload);
      return;
    }
    console.log(`[${entry.ts}] ${type}`, payload);
  }
}

