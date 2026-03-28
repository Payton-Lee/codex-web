import { Activity, Shield, TerminalSquare } from "lucide-react";
import type { SettingsSummary } from "../shared";

export function SettingsPanel({ settings }: { settings: SettingsSummary }) {
  return (
    <section className="shell-card p-4">
      <p className="shell-section-label">Settings</p>
      <h2 className="mt-2 text-lg font-semibold text-[var(--text-primary)]">本地后端状态</h2>
      <div className="mt-4 grid gap-3">
        <div className="shell-card flex items-center gap-3 p-3 text-sm text-[var(--text-secondary)]">
          <Activity size={16} className="text-[var(--accent)]" />
          <div>后端监听: {settings.host}:{settings.serverPort}</div>
        </div>
        <div className="shell-card flex items-center gap-3 p-3 text-sm text-[var(--text-secondary)]">
          <TerminalSquare size={16} className="text-[var(--accent)]" />
          <div>前端 {settings.webPort} · app-server {settings.appServerPort}</div>
        </div>
        <div className="shell-card flex items-center gap-3 p-3 text-sm text-[var(--text-secondary)]">
          <Shield size={16} className="text-[var(--accent)]" />
          <div>{settings.approvalPolicy} · {settings.sandboxMode}</div>
        </div>
        <div className="font-mono text-xs text-[var(--text-secondary)] break-all">
          codex: {settings.codexCommand} {settings.codexArgs.join(" ")}
        </div>
        <div className="text-xs text-[var(--text-secondary)]">
          来源: {settings.codexCommandSource === "local" ? "项目本地依赖" : settings.codexCommandSource === "explicit" ? "显式配置" : "全局 PATH"}
        </div>
      </div>
    </section>
  );
}
