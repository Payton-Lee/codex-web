import type { AppServerCatalog } from "../shared";

export type ComposerTrigger = "/" | "@" | "$";

export type SlashCommandId =
  | "new"
  | "approvals"
  | "diff"
  | "settings"
  | "plugins"
  | "models"
  | "modes"
  | "experimental"
  | "runtime"
  | "skills"
  | "mcp"
  | "compact";

export interface SlashCommandDefinition {
  id: SlashCommandId;
  title: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { id: "new", title: "新线程", description: "创建一个新线程并切换过去" },
  { id: "approvals", title: "审批面板", description: "切到待审批项面板" },
  { id: "diff", title: "Diff 面板", description: "切到文件变更面板" },
  { id: "settings", title: "设置", description: "打开设置面板并查看 app-server 状态" },
  { id: "plugins", title: "Plugins", description: "查看 app-server 已发现的插件能力" },
  { id: "models", title: "Models", description: "查看 app-server 可用模型列表" },
  { id: "modes", title: "Modes", description: "查看协作模式，如 default / plan" },
  { id: "experimental", title: "Experimental", description: "查看实验特性及启用状态" },
  { id: "runtime", title: "Runtime", description: "当前 Web UI 暂未接入 runtime 面板" },
  { id: "skills", title: "Skills", description: "将输入转换为 $skill 引用" },
  { id: "mcp", title: "MCP", description: "保留 /mcp 前缀，继续输入 MCP 指令" },
  { id: "compact", title: "Compact", description: "当前 Web UI 暂未接入 compact" }
] as const;

export interface ActiveComposerToken {
  trigger: ComposerTrigger;
  query: string;
  start: number;
  end: number;
}

export type ComposerSuggestion =
  | { kind: "command"; key: string; value: string; label: string; detail: string; commandId: SlashCommandId }
  | { kind: "mcpServer"; key: string; value: string; label: string; detail: string }
  | { kind: "mcpTool"; key: string; value: string; label: string; detail: string }
  | { kind: "file"; key: string; value: string; label: string; detail: string }
  | { kind: "skill"; key: string; value: string; label: string; detail: string };

export function findActiveComposerToken(input: string, cursor: number): ActiveComposerToken | null {
  const safeCursor = Math.max(0, Math.min(cursor, input.length));
  let start = safeCursor;

  while (start > 0) {
    const previousChar = input[start - 1];
    if (/\s/.test(previousChar)) {
      break;
    }
    start -= 1;
  }

  const token = input.slice(start, safeCursor);
  const trigger = token[0];
  if (trigger !== "/" && trigger !== "@" && trigger !== "$") {
    return null;
  }

  const beforeStart = start === 0 ? " " : input[start - 1];
  if (!/\s/.test(beforeStart)) {
    return null;
  }

  return {
    trigger,
    query: token.slice(1),
    start,
    end: safeCursor
  };
}

export function replaceComposerToken(input: string, token: ActiveComposerToken, value: string): string {
  const prefix = input.slice(0, token.start);
  const suffix = input.slice(token.end);
  const nextToken = `${token.trigger}${value} `;
  return `${prefix}${nextToken}${suffix}`;
}

export function isMcpPrompt(input: string): boolean {
  return /^\/mcp(?:\s|$)/i.test(input.trimStart());
}

function commandDetail(command: SlashCommandId, catalog?: AppServerCatalog): string {
  if (!catalog) {
    return SLASH_COMMANDS.find((entry) => entry.id === command)?.description ?? "";
  }

  if (command === "plugins") {
    return `查看 ${catalog.plugins.length} 个插件能力`;
  }
  if (command === "models") {
    return `查看 ${catalog.models.length} 个可用模型`;
  }
  if (command === "modes") {
    return `查看 ${catalog.collaborationModes.length} 个协作模式`;
  }
  if (command === "experimental") {
    return `查看 ${catalog.experimentalFeatures.length} 个实验特性`;
  }
  if (command === "skills") {
    return `切换到 $skill 引用，当前可用 ${catalog.skills.length} 个 skill`;
  }
  return SLASH_COMMANDS.find((entry) => entry.id === command)?.description ?? "";
}

export function commandSuggestions(query: string, catalog?: AppServerCatalog): ComposerSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  return SLASH_COMMANDS.filter((entry) => {
    if (!normalizedQuery) {
      return true;
    }
    return `${entry.id} ${entry.title} ${entry.description}`.toLowerCase().includes(normalizedQuery);
  }).map((entry) => ({
    kind: "command" as const,
    key: entry.id,
    value: entry.id,
    label: `/${entry.id}`,
    detail: commandDetail(entry.id, catalog),
    commandId: entry.id
  }));
}
