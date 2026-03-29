export type PlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "unknown";

export type AccountMode = "chatgpt" | "apiKey" | "unknown";

export interface RateLimitWindowSummary {
  used?: number | null;
  limit?: number | null;
  resetsAt?: number | null;
  windowSeconds?: number | null;
}

export interface RateLimitSummary {
  planType?: PlanType | null;
  primary?: RateLimitWindowSummary | null;
  secondary?: RateLimitWindowSummary | null;
  creditsRemaining?: number | null;
}

export interface AccountSummary {
  loggedIn: boolean;
  mode: AccountMode;
  email?: string | null;
  planType?: PlanType | null;
  requiresOpenaiAuth?: boolean;
  rateLimits?: RateLimitSummary | null;
}

export interface WorkspaceOption {
  path: string;
  allowed: boolean;
}

export interface WorkspaceState {
  current: string | null;
  allowed: WorkspaceOption[];
}

export type ThreadStatus = "idle" | "inProgress" | "completed" | "failed" | "interrupted";

export interface ThreadSummary {
  id: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  modelProvider: string;
  cliVersion: string;
  source: string;
  status: ThreadStatus;
}

export interface ThreadItem {
  id: string;
  type: string;
  text?: string;
  summary?: string[];
  content?: string[];
  command?: string;
  cwd?: string;
  aggregatedOutput?: string | null;
  status?: string;
  changes?: FileChangeEntry[];
  tool?: string;
  server?: string;
  result?: unknown;
  error?: unknown;
}

export interface TurnSummary {
  id: string;
  status: string;
  error?: string | null;
  items: ThreadItem[];
}

export interface ThreadDetail extends ThreadSummary {
  turns: TurnSummary[];
}

export interface FileChangeEntry {
  path: string;
  kind: string;
  diff: string;
}

export type ApprovalKind = "command" | "fileChange" | "userInput" | "dynamicTool";
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface ApprovalRequest {
  id: string;
  requestId: string | number;
  kind: ApprovalKind;
  threadId: string;
  turnId: string;
  itemId: string;
  createdAt: number;
  status: "pending" | "resolved";
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  grantRoot?: string | null;
  tool?: string | null;
  arguments?: unknown;
  questions?: UserInputQuestion[];
  riskHint: string;
  resolvedAt?: number | null;
  resolutionDecision?: ApprovalDecision | null;
  resolutionAnswers?: Record<string, string> | null;
}

export interface UserInputQuestionOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputQuestionOption[];
}

export interface ApprovalResolution {
  decision: ApprovalDecision;
  answers?: Record<string, string>;
}

export interface DiffPreview {
  path: string;
  kind: string;
  original: string;
  modified: string;
  isBinary: boolean;
  rawDiff: string;
}

export interface SettingsSummary {
  host: string;
  serverPort: number;
  webPort: number;
  appServerPort: number;
  approvalPolicy: string;
  sandboxMode: string;
  allowedOrigins: string[];
  allowedWorkspaces: string[];
  codexCommand: string;
  codexCommandSource: "explicit" | "local" | "global";
  codexArgs: string[];
  codexHomeDir?: string;
  effectiveCodexHomeDir: string;
  codexConfigOverrideSources: string[];
  appServerConnected: boolean;
  appServerStatus: string;
}

export interface LoadedThreadsSummary {
  loadedThreadIds: string[];
  refreshedAt: number;
}

export interface PromptCommandDefinition {
  id: string;
  title: string;
  description: string;
  instruction: string;
}

export interface WorkspaceFileSuggestion {
  path: string;
}

export interface SkillSuggestion {
  id: string;
  name: string;
  path: string;
  description: string;
}

export interface AppServerSkillSummary {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
}

export interface AppServerPluginSummary {
  id: string;
  name: string;
  displayName: string;
  description: string;
  category: string | null;
  installed: boolean;
  enabled: boolean;
}

export interface AppServerModelSummary {
  id: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: string[];
  isDefault: boolean;
}

export interface AppServerCollaborationModeSummary {
  name: string;
  mode: string;
  reasoningEffort: string | null;
}

export interface AppServerExperimentalFeatureSummary {
  name: string;
  displayName: string;
  description: string;
  stage: string;
  enabled: boolean;
  defaultEnabled: boolean;
}

export interface AppServerCatalog {
  skills: AppServerSkillSummary[];
  plugins: AppServerPluginSummary[];
  models: AppServerModelSummary[];
  collaborationModes: AppServerCollaborationModeSummary[];
  experimentalFeatures: AppServerExperimentalFeatureSummary[];
  refreshedAt: number;
}

export interface McpServerSuggestion {
  name: string;
  status: string;
  description: string;
}

export interface McpToolSuggestion {
  server: string;
  name: string;
  description: string;
}

export interface McpComposerSuggestions {
  mode: "servers" | "tools";
  servers: McpServerSuggestion[];
  tools: McpToolSuggestion[];
}

export const PROMPT_COMMANDS: PromptCommandDefinition[] = [
  {
    id: "fix",
    title: "修复问题",
    description: "直接定位并修复问题，必要时补验证。",
    instruction: "请直接定位并修复问题，优先给出可执行修改，并在可行时运行必要验证。"
  },
  {
    id: "review",
    title: "代码审查",
    description: "按代码审查方式找风险、回归和缺失测试。",
    instruction: "请按代码审查方式处理，优先指出 bug、风险、行为回归和缺失测试，结论按严重程度排序。"
  },
  {
    id: "explain",
    title: "解释代码",
    description: "解释实现、调用链和关键设计。",
    instruction: "请解释相关代码的实现、调用链和关键设计取舍，优先帮助快速理解。"
  },
  {
    id: "test",
    title: "补测试",
    description: "围绕当前需求补测试并说明覆盖范围。",
    instruction: "请围绕当前需求补充或修正测试，并说明覆盖到的行为与仍未覆盖的风险。"
  },
  {
    id: "plan",
    title: "实现方案",
    description: "先梳理方案、拆分步骤和风险。",
    instruction: "请先给出精炼可执行的实现方案，拆分主要步骤、依赖和风险，再开始修改。"
  }
] as const;

export type FrontendEvent =
  | { type: "snapshot"; payload: SnapshotPayload }
  | { type: "account.updated"; payload: AccountSummary }
  | { type: "thread.started"; payload: { threadId: string } }
  | { type: "turn.started"; payload: { threadId: string; turnId: string } }
  | {
      type: "item.started" | "item.completed";
      payload: { threadId: string; turnId: string; item: ThreadItem };
    }
  | {
      type: "item.delta";
      payload: {
        threadId: string;
        turnId: string;
        itemId: string;
        stream: "assistant" | "command" | "fileChange" | "reasoning";
        delta: string;
      };
    }
  | {
      type: "approval.created" | "approval.resolved";
      payload: ApprovalRequest;
    }
  | {
      type: "turn.completed";
      payload: { threadId: string; turnId: string; status: string };
    }
  | {
      type: "diff.updated";
      payload: { threadId: string; turnId: string; diff: string };
    }
  | {
      type: "server.status";
      payload: { connected: boolean; status: string; error?: string };
    }
  | {
      type: "error";
      payload: { message: string; detail?: unknown };
    };

export interface SnapshotPayload {
  account: AccountSummary;
  workspace: WorkspaceState;
  threads: ThreadSummary[];
  loadedThreads: LoadedThreadsSummary;
  approvals: ApprovalRequest[];
  settings: SettingsSummary;
  appServerCatalog: AppServerCatalog;
}
