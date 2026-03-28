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
  appServerConnected: boolean;
  appServerStatus: string;
}

export interface LoadedThreadsSummary {
  loadedThreadIds: string[];
  refreshedAt: number;
}

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
}
