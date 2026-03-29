import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillSuggestion, WorkspaceFileSuggestion } from "../../../packages/shared/src/index.js";

const PROMPT_COMMANDS = [
  {
    id: "fix",
    instruction: "请直接定位并修复问题，优先给出可执行修改，并在可行时运行必要验证。"
  },
  {
    id: "review",
    instruction: "请按代码审查方式处理，优先指出 bug、风险、行为回归和缺失测试，结论按严重程度排序。"
  },
  {
    id: "explain",
    instruction: "请解释相关代码的实现、调用链和关键设计取舍，优先帮助快速理解。"
  },
  {
    id: "test",
    instruction: "请围绕当前需求补充或修正测试，并说明覆盖到的行为与仍未覆盖的风险。"
  },
  {
    id: "plan",
    instruction: "请先给出精炼可执行的实现方案，拆分主要步骤、依赖和风险，再开始修改。"
  }
] as const;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage"
]);

const MAX_FILE_SUGGESTIONS = 20;
const MAX_SKILL_SUGGESTIONS = 20;
const MAX_REFERENCE_COUNT = 6;
const MAX_FILE_CONTENT_CHARS = 12_000;
const MAX_SKILL_CONTENT_CHARS = 10_000;

function normalizeQuery(input: string): string {
  return input.trim().toLowerCase();
}

function isTextFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return ![".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".woff", ".woff2"].includes(
    extension
  );
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[内容已截断，共 ${text.length} 字符]`;
}

function safeRelativePath(root: string, targetPath: string): string {
  const relativePath = path.relative(root, targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("引用路径超出当前工作区范围");
  }
  return relativePath.split(path.sep).join("/");
}

function resolveWorkspaceFilePath(workspaceRoot: string, filePath: string): string {
  const normalizedPath = filePath.trim().replaceAll("\\", "/");
  if (!normalizedPath) {
    throw new Error("文件路径不能为空");
  }
  const absolutePath = path.resolve(workspaceRoot, normalizedPath);
  const relativePath = path.relative(workspaceRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`文件不在当前工作区内: ${filePath}`);
  }
  return absolutePath;
}

function scorePath(candidatePath: string, query: string): number {
  const normalizedPath = candidatePath.toLowerCase();
  if (!query) {
    return candidatePath.length;
  }
  if (normalizedPath === query) {
    return -2000;
  }
  if (normalizedPath.endsWith(`/${query}`) || normalizedPath.endsWith(query)) {
    return -1000;
  }
  const index = normalizedPath.indexOf(query);
  if (index >= 0) {
    return index * 10 + candidatePath.length;
  }
  return Number.MAX_SAFE_INTEGER;
}

function walkWorkspace(
  root: string,
  visit: (absolutePath: string, relativePath: string, stat: fs.Stats) => boolean | void
): void {
  const queue = [root];
  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (!currentPath) {
      continue;
    }
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".DS_Store")) {
        continue;
      }
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = safeRelativePath(root, absolutePath);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = fs.statSync(absolutePath);
      const shouldStop = visit(absolutePath, relativePath, stat);
      if (shouldStop === true) {
        return;
      }
    }
  }
}

export function searchWorkspaceFiles(workspaceRoot: string, query: string): WorkspaceFileSuggestion[] {
  const normalizedQuery = normalizeQuery(query);
  const matches: WorkspaceFileSuggestion[] = [];

  walkWorkspace(workspaceRoot, (_absolutePath, relativePath) => {
    const normalizedPath = relativePath.toLowerCase();
    if (normalizedQuery && !normalizedPath.includes(normalizedQuery)) {
      return false;
    }
    matches.push({ path: relativePath });
    return matches.length >= 200;
  });

  return matches
    .sort((left, right) => scorePath(left.path, normalizedQuery) - scorePath(right.path, normalizedQuery))
    .slice(0, MAX_FILE_SUGGESTIONS);
}

export function readWorkspaceFile(workspaceRoot: string, filePath: string): { path: string; content: string } {
  const absolutePath = resolveWorkspaceFilePath(workspaceRoot, filePath);
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`不是文件: ${filePath}`);
  }
  if (!isTextFile(absolutePath)) {
    throw new Error(`暂不支持引用二进制文件: ${filePath}`);
  }
  const relativePath = safeRelativePath(workspaceRoot, absolutePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  return {
    path: relativePath,
    content: truncate(content, MAX_FILE_CONTENT_CHARS)
  };
}

function skillRootPath(explicitCodexHomeDir?: string): string {
  return path.join(explicitCodexHomeDir ?? path.join(os.homedir(), ".codex"), "skills");
}

function readSkillDescription(skillFilePath: string): string {
  const raw = fs.readFileSync(skillFilePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const descriptionLine = lines.find((line) => !line.startsWith("#")) ?? "";
  return descriptionLine.slice(0, 160);
}

export function searchSkills(query: string, explicitCodexHomeDir?: string): SkillSuggestion[] {
  const root = skillRootPath(explicitCodexHomeDir);
  if (!fs.existsSync(root)) {
    return [];
  }

  const normalizedQuery = normalizeQuery(query);
  const matches: SkillSuggestion[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (!currentPath) {
      continue;
    }
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || entry.name !== "SKILL.md") {
        continue;
      }

      const skillDir = path.dirname(absolutePath);
      const relativePath = safeRelativePath(root, skillDir);
      const skillName = path.basename(skillDir);
      const searchTarget = `${skillName} ${relativePath}`.toLowerCase();
      if (normalizedQuery && !searchTarget.includes(normalizedQuery)) {
        continue;
      }
      matches.push({
        id: relativePath,
        name: skillName,
        path: relativePath,
        description: readSkillDescription(absolutePath)
      });
      if (matches.length >= 200) {
        break;
      }
    }
  }

  return matches
    .sort((left, right) => scorePath(`${left.name} ${left.path}`, normalizedQuery) - scorePath(`${right.name} ${right.path}`, normalizedQuery))
    .slice(0, MAX_SKILL_SUGGESTIONS);
}

export function readSkill(skillIdOrName: string, explicitCodexHomeDir?: string): SkillSuggestion & { content: string } {
  const matches = searchSkills(skillIdOrName, explicitCodexHomeDir);
  const normalizedNeedle = normalizeQuery(skillIdOrName);
  const exactMatch =
    matches.find((entry) => entry.id.toLowerCase() === normalizedNeedle) ??
    matches.find((entry) => entry.name.toLowerCase() === normalizedNeedle) ??
    matches[0];

  if (!exactMatch) {
    throw new Error(`未找到 skill: ${skillIdOrName}`);
  }

  const skillFilePath = path.join(skillRootPath(explicitCodexHomeDir), exactMatch.path, "SKILL.md");
  const content = truncate(fs.readFileSync(skillFilePath, "utf8"), MAX_SKILL_CONTENT_CHARS);
  return {
    ...exactMatch,
    content
  };
}

function uniqueMatches(tokens: string[]): string[] {
  return [...new Set(tokens.map((token) => token.trim()).filter(Boolean))].slice(0, MAX_REFERENCE_COUNT);
}

export function resolveComposerPrompt(
  prompt: string,
  workspaceRoot: string,
  explicitCodexHomeDir?: string
): string {
  const commandTokens = uniqueMatches(Array.from(prompt.matchAll(/(?:^|\s)\/([a-z][\w-]*)/gi), (match) => match[1] ?? ""));
  const fileTokens = uniqueMatches(Array.from(prompt.matchAll(/(?:^|\s)@([^\s@#$]+)/g), (match) => match[1] ?? ""));
  const skillTokens = uniqueMatches(Array.from(prompt.matchAll(/(?:^|\s)\$([a-z0-9._/-]+)/gi), (match) => match[1] ?? ""));

  const activeCommands = commandTokens
    .map((token) => PROMPT_COMMANDS.find((entry) => entry.id.toLowerCase() === token.toLowerCase()))
    .filter((entry): entry is (typeof PROMPT_COMMANDS)[number] => Boolean(entry));

  const cleanedPrompt = prompt
    .replace(/(^|\s)\/([a-z][\w-]*)/gi, " ")
    .replace(/(^|\s)@([^\s@#$]+)/g, " ")
    .replace(/(^|\s)\$([a-z0-9._/-]+)/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  const sections: string[] = [];

  if (activeCommands.length > 0) {
    sections.push(
      ["请优先遵循以下处理方式：", ...activeCommands.map((entry) => `- ${entry.instruction}`)].join("\n")
    );
  }

  if (cleanedPrompt) {
    sections.push(`用户请求：\n${cleanedPrompt}`);
  }

  if (fileTokens.length > 0) {
    const fileSections = fileTokens.map((filePath) => {
      const file = readWorkspaceFile(workspaceRoot, filePath);
      return [`文件引用：${file.path}`, "```", file.content, "```"].join("\n");
    });
    sections.push(fileSections.join("\n\n"));
  }

  if (skillTokens.length > 0) {
    const skillSections = skillTokens.map((skillName) => {
      const skill = readSkill(skillName, explicitCodexHomeDir);
      return [
        `Skill 引用：${skill.name} (${skill.path})`,
        skill.description ? `说明：${skill.description}` : "",
        "```md",
        skill.content,
        "```"
      ]
        .filter(Boolean)
        .join("\n");
    });
    sections.push(skillSections.join("\n\n"));
  }

  return sections.length > 0 ? sections.join("\n\n") : prompt.trim();
}
