import { useState, type ReactNode } from "react";
import { Activity, FlaskConical, Package, Settings2, Shield, TerminalSquare, Wrench } from "lucide-react";
import type { AppServerCatalog, SettingsSummary } from "../shared";
import { cn } from "../lib/utils";

type SettingsSection = "overview" | "skills" | "plugins" | "models" | "modes" | "experimental";

interface Props {
  settings: SettingsSummary;
  catalog: AppServerCatalog;
  activeSection: SettingsSection;
  onSectionChange(section: SettingsSection): void;
  onRefreshCatalog(): void;
  onRefreshApps(): void;
  onReloadMcp(): void;
  onReadPlugin(): void;
  onExecCommand(command: string, cwd?: string | null): void;
  onReadFsFile(path: string): void;
  onReadFsDirectory(path: string): void;
  onReadFsMetadata(path: string): void;
  appServerAppsRaw: string | null;
  pluginReadRaw: string | null;
  mcpReloadRaw: string | null;
  commandExecRaw: string | null;
  fsDebugRaw: string | null;
}

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof Settings2 }> = [
  { id: "overview", label: "概览", icon: Settings2 },
  { id: "skills", label: "Skills", icon: Wrench },
  { id: "plugins", label: "Plugins", icon: Package },
  { id: "models", label: "Models", icon: Activity },
  { id: "modes", label: "Modes", icon: TerminalSquare },
  { id: "experimental", label: "Experimental", icon: FlaskConical }
];

function SectionCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="shell-card p-4">
      <p className="shell-section-label">{title}</p>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">{subtitle}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function SettingsPanel({
  settings,
  catalog,
  activeSection,
  onSectionChange,
  onRefreshCatalog,
  onRefreshApps,
  onReloadMcp,
  onReadPlugin,
  onExecCommand,
  onReadFsFile,
  onReadFsDirectory,
  onReadFsMetadata,
  appServerAppsRaw,
  pluginReadRaw,
  mcpReloadRaw,
  commandExecRaw,
  fsDebugRaw
}: Props) {
  const [commandInput, setCommandInput] = useState("");
  const [commandCwd, setCommandCwd] = useState("");
  const [fsPath, setFsPath] = useState("");
  const refreshedAtLabel = catalog.refreshedAt ? new Date(catalog.refreshedAt).toLocaleString() : "尚未刷新";
  const codexArgs = settings.codexArgs ?? [];
  const effectiveCodexHomeDir = settings.effectiveCodexHomeDir ?? settings.codexHomeDir ?? "~/.codex";
  const codexConfigOverrideSources = settings.codexConfigOverrideSources ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            return (
              <button
                key={section.id}
                onClick={() => onSectionChange(section.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors",
                  activeSection === section.id
                    ? "bg-accent/10 text-accent"
                    : "bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 hover:text-[var(--text-primary)]"
                )}
              >
                <Icon size={14} />
                <span>{section.label}</span>
              </button>
            );
          })}
        </div>
        <button
          onClick={onRefreshCatalog}
          className="rounded-md bg-white/5 px-3 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-white/10 hover:text-[var(--text-primary)]"
        >
          刷新能力目录
        </button>
      </div>

      {activeSection === "overview" ? (
        <SectionCard title="Settings" subtitle="本地后端与 app-server 状态">
          <div className="grid gap-3">
            <div className="shell-card flex items-center gap-3 p-3 text-sm text-[var(--text-secondary)]">
              <Activity size={16} className="text-[var(--accent)]" />
              <div>
                后端监听: {settings.host}:{settings.serverPort}
              </div>
            </div>
            <div className="shell-card flex items-center gap-3 p-3 text-sm text-[var(--text-secondary)]">
              <TerminalSquare size={16} className="text-[var(--accent)]" />
              <div>
                前端 {settings.webPort} / app-server {settings.appServerPort}
              </div>
            </div>
            <div className="shell-card flex items-center gap-3 p-3 text-sm text-[var(--text-secondary)]">
              <Shield size={16} className="text-[var(--accent)]" />
              <div>
                {settings.approvalPolicy} / {settings.sandboxMode}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs text-[var(--text-secondary)]">
              <div className="shell-card p-3">skills: {catalog.skills.length}</div>
              <div className="shell-card p-3">plugins: {catalog.plugins.length}</div>
              <div className="shell-card p-3">models: {catalog.models.length}</div>
              <div className="shell-card p-3">modes: {catalog.collaborationModes.length}</div>
            </div>
            <div className="break-all font-mono text-xs text-[var(--text-secondary)]">
              codex: {settings.codexCommand} {codexArgs.join(" ")}
            </div>
            <div className="text-xs text-[var(--text-secondary)]">
              来源:
              {" "}
              {settings.codexCommandSource === "local"
                ? "项目本地依赖"
                : settings.codexCommandSource === "explicit"
                  ? "显式配置"
                  : "全局 PATH"}
            </div>
            <div className="break-all text-xs text-[var(--text-secondary)]">状态目录: {effectiveCodexHomeDir}</div>
            <div className="break-all text-xs text-[var(--text-secondary)]">
              显式 CODEX_HOME: {settings.codexHomeDir ?? "未设置，使用默认 ~/.codex"}
            </div>
            <div className="text-xs text-[var(--text-secondary)]">MCP / 配置覆盖来源:</div>
            <div className="space-y-1 text-[10px] text-[var(--text-secondary)]">
              {codexConfigOverrideSources.length ? (
                codexConfigOverrideSources.map((source) => (
                  <div key={source} className="break-all font-mono">
                    {source}
                  </div>
                ))
              ) : (
                <div>无额外覆盖配置</div>
              )}
            </div>
            <div className="text-[10px] text-[var(--text-secondary)]">catalog refreshed: {refreshedAtLabel}</div>
            <div className="grid gap-2 md:grid-cols-3">
              <button
                onClick={onRefreshApps}
                className="rounded-md bg-white/5 px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-white/10 hover:text-[var(--text-primary)]"
              >
                Read app/list
              </button>
              <button
                onClick={onReloadMcp}
                className="rounded-md bg-white/5 px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-white/10 hover:text-[var(--text-primary)]"
              >
                Reload MCP config
              </button>
              <button
                onClick={onReadPlugin}
                className="rounded-md bg-white/5 px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-white/10 hover:text-[var(--text-primary)]"
              >
                Read first plugin
              </button>
            </div>
            {appServerAppsRaw ? (
              <pre className="max-h-56 overflow-auto rounded-md bg-black/30 p-3 text-[10px] text-[var(--text-secondary)]">
                {appServerAppsRaw}
              </pre>
            ) : null}
            {mcpReloadRaw ? (
              <pre className="max-h-40 overflow-auto rounded-md bg-black/30 p-3 text-[10px] text-[var(--text-secondary)]">
                {mcpReloadRaw}
              </pre>
            ) : null}
            {pluginReadRaw ? (
              <pre className="max-h-56 overflow-auto rounded-md bg-black/30 p-3 text-[10px] text-[var(--text-secondary)]">
                {pluginReadRaw}
              </pre>
            ) : null}
            <div className="grid gap-3 border-t border-white/10 pt-3">
              <div className="grid gap-2">
                <input
                  value={commandInput}
                  onChange={(event) => setCommandInput(event.target.value)}
                  placeholder="command, e.g. pwd"
                  className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
                />
                <input
                  value={commandCwd}
                  onChange={(event) => setCommandCwd(event.target.value)}
                  placeholder="cwd (optional)"
                  className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
                />
                <button
                  onClick={() => onExecCommand(commandInput, commandCwd || null)}
                  className="rounded-md bg-white/5 px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-white/10 hover:text-[var(--text-primary)]"
                >
                  Run command/exec
                </button>
                {commandExecRaw ? (
                  <pre className="max-h-56 overflow-auto rounded-md bg-black/30 p-3 text-[10px] text-[var(--text-secondary)]">
                    {commandExecRaw}
                  </pre>
                ) : null}
              </div>
              <div className="grid gap-2">
                <input
                  value={fsPath}
                  onChange={(event) => setFsPath(event.target.value)}
                  placeholder="filesystem path"
                  className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
                />
                <div className="grid gap-2 md:grid-cols-3">
                  <button
                    onClick={() => onReadFsDirectory(fsPath)}
                    className="rounded-md bg-white/5 px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-white/10 hover:text-[var(--text-primary)]"
                  >
                    fs/readDirectory
                  </button>
                  <button
                    onClick={() => onReadFsFile(fsPath)}
                    className="rounded-md bg-white/5 px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-white/10 hover:text-[var(--text-primary)]"
                  >
                    fs/readFile
                  </button>
                  <button
                    onClick={() => onReadFsMetadata(fsPath)}
                    className="rounded-md bg-white/5 px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-white/10 hover:text-[var(--text-primary)]"
                  >
                    fs/getMetadata
                  </button>
                </div>
                {fsDebugRaw ? (
                  <pre className="max-h-56 overflow-auto rounded-md bg-black/30 p-3 text-[10px] text-[var(--text-secondary)]">
                    {fsDebugRaw}
                  </pre>
                ) : null}
              </div>
            </div>
          </div>
        </SectionCard>
      ) : null}

      {activeSection === "skills" ? (
        <SectionCard title="Skills" subtitle={`app-server 当前发现 ${catalog.skills.length} 个 skill`}>
          <div className="space-y-2">
            {catalog.skills.map((skill) => (
              <div key={skill.name} className="shell-card p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium text-[var(--text-primary)]">{skill.displayName}</div>
                  <div className="text-[10px] uppercase text-[var(--text-secondary)]">
                    {skill.enabled ? "enabled" : "disabled"}
                  </div>
                </div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">${skill.name}</div>
                <div className="mt-2 text-xs text-[var(--text-secondary)]">{skill.description || "无描述"}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {activeSection === "plugins" ? (
        <SectionCard title="Plugins" subtitle={`app-server 当前发现 ${catalog.plugins.length} 个插件`}>
          <div className="space-y-2">
            {catalog.plugins.map((plugin) => (
              <div key={plugin.id} className="shell-card p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium text-[var(--text-primary)]">{plugin.displayName}</div>
                  <div className="text-[10px] uppercase text-[var(--text-secondary)]">
                    {plugin.installed ? "installed" : "available"} / {plugin.enabled ? "enabled" : "disabled"}
                  </div>
                </div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">
                  {plugin.name}
                  {plugin.category ? ` / ${plugin.category}` : ""}
                </div>
                <div className="mt-2 text-xs text-[var(--text-secondary)]">{plugin.description || "无描述"}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {activeSection === "models" ? (
        <SectionCard title="Models" subtitle={`app-server 当前暴露 ${catalog.models.length} 个模型`}>
          <div className="space-y-2">
            {catalog.models.map((model) => (
              <div key={model.id} className="shell-card p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium text-[var(--text-primary)]">{model.displayName}</div>
                  <div className="text-[10px] uppercase text-[var(--text-secondary)]">
                    {model.isDefault ? "default" : model.defaultReasoningEffort ?? "-"}
                  </div>
                </div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">{model.id}</div>
                <div className="mt-2 text-xs text-[var(--text-secondary)]">{model.description || "无描述"}</div>
                <div className="mt-2 text-[10px] text-[var(--text-secondary)]">
                  reasoning: {model.supportedReasoningEfforts.join(", ") || "-"}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {activeSection === "modes" ? (
        <SectionCard title="Modes" subtitle={`app-server 当前暴露 ${catalog.collaborationModes.length} 个协作模式`}>
          <div className="space-y-2">
            {catalog.collaborationModes.map((mode) => (
              <div key={mode.mode} className="shell-card p-3">
                <div className="font-medium text-[var(--text-primary)]">{mode.name}</div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">{mode.mode}</div>
                <div className="mt-2 text-xs text-[var(--text-secondary)]">
                  默认 reasoning: {mode.reasoningEffort ?? "-"}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {activeSection === "experimental" ? (
        <SectionCard title="Experimental" subtitle={`app-server 当前暴露 ${catalog.experimentalFeatures.length} 个实验特性`}>
          <div className="space-y-2">
            {catalog.experimentalFeatures.map((feature) => (
              <div key={feature.name} className="shell-card p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium text-[var(--text-primary)]">{feature.displayName}</div>
                  <div className="text-[10px] uppercase text-[var(--text-secondary)]">
                    {feature.stage} / {feature.enabled ? "enabled" : "disabled"}
                  </div>
                </div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">{feature.name}</div>
                <div className="mt-2 text-xs text-[var(--text-secondary)]">{feature.description || "无描述"}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
