# App Server 接口索引

这份文档只做接口列举，不展开详细参数和用法。

用途：
- 先快速确认 `app-server` 有哪些 request / notification / server request
- 需要详细字段、示例、兼容性说明时，再去看：
  - 官方 README
  - 本地 schema：`generated/schema`、`generated/ts`
  - 本地参考：[app-server-reference.md](/Users/lipeixu/Code/codex-web/docs/protocol/app-server-reference.md)

主要来源：
- 官方 README
- 本地生成 schema 中的：
  - `generated/ts/ClientRequest.ts`
  - `generated/ts/ServerNotification.ts`
  - `generated/ts/ServerRequest.ts`

## 1. Client -> Server Requests

### 初始化

- `initialize`

### Thread

- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/archive`
- `thread/name/set`
- `thread/unarchive`
- `thread/compact/start`
- `thread/rollback`
- `thread/list`
- `thread/loaded/list`
- `thread/read`

### Turn / Review

- `turn/start`
- `turn/interrupt`
- `review/start`

### Skills

- `skills/list`
- `skills/remote/read`
- `skills/remote/write`
- `skills/config/write`

### Apps / Plugins / Models / Modes

- `app/list`
- `model/list`
- `collaborationMode/list`

### MCP

- `mcpServer/oauth/login`
- `config/mcpServer/reload`
- `mcpServerStatus/list`

### Account / Auth

- `account/read`
- `account/login/start`
- `account/login/cancel`
- `account/logout`
- `account/rateLimits/read`

### Config

- `config/read`
- `config/value/write`
- `config/batchWrite`
- `configRequirements/read`

### Commands / Feedback

- `command/exec`
- `feedback/upload`

### 历史会话兼容接口

- `newConversation`
- `getConversationSummary`
- `listConversations`
- `resumeConversation`
- `forkConversation`
- `archiveConversation`
- `sendUserMessage`
- `sendUserTurn`
- `interruptConversation`
- `addConversationListener`
- `removeConversationListener`

### 旧账户 / 兼容接口

- `loginApiKey`
- `loginChatGpt`
- `cancelLoginChatGpt`
- `logoutChatGpt`
- `getAuthStatus`
- `getUserSavedConfig`
- `setDefaultModel`
- `getUserAgent`
- `userInfo`

### 本地辅助 / 搜索 / 工具

- `fuzzyFileSearch`
- `execOneOffCommand`
- `gitDiffToRemote`

### 实验接口

- `mock/experimentalMethod`

## 2. Server -> Client Notifications

### 通用

- `error`

### Thread / Turn

- `thread/started`
- `thread/name/updated`
- `thread/tokenUsage/updated`
- `turn/started`
- `turn/completed`
- `turn/diff/updated`
- `turn/plan/updated`
- `thread/compacted`

### Item 生命周期

- `item/started`
- `item/completed`
- `rawResponseItem/completed`

### 流式文本 / 推理 / 计划

- `item/agentMessage/delta`
- `item/plan/delta`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/textDelta`

### 命令 / 文件 / MCP / 工具进度

- `item/commandExecution/outputDelta`
- `item/commandExecution/terminalInteraction`
- `item/fileChange/outputDelta`
- `item/mcpToolCall/progress`
- `mcpServer/oauthLogin/completed`

### Account / Auth

- `account/updated`
- `account/rateLimits/updated`
- `account/login/completed`
- `authStatusChange`
- `loginChatGptComplete`
- `sessionConfigured`

### 警告 / 兼容 / 配置

- `deprecationNotice`
- `configWarning`
- `windows/worldWritableWarning`

## 3. Server -> Client Requests

这些不是 notification，而是 app-server 主动要求客户端响应的 request。

### 审批

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `applyPatchApproval`
- `execCommandApproval`

### 用户输入 / 工具

- `item/tool/requestUserInput`
- `item/tool/call`

### Auth

- `account/chatgptAuthTokens/refresh`

## 4. 当前项目已实际接入的重点接口

### 已直接调用

- `initialize`
- `thread/start`
- `thread/resume`
- `thread/list`
- `thread/loaded/list`
- `thread/read`
- `turn/start`
- `turn/interrupt`
- `skills/list`
- `plugin/list`
- `model/list`
- `collaborationMode/list`
- `experimentalFeature/list`
- `app/list`
- `mcpServerStatus/list`
- `account/read`
- `account/login/start`
- `account/logout`
- `account/rateLimits/read`

### 已直接消费的通知

- `thread/started`
- `turn/started`
- `turn/completed`
- `turn/diff/updated`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`
- `item/reasoning/textDelta`
- `item/reasoning/summaryTextDelta`
- `account/updated`
- `account/rateLimits/updated`
- `account/login/completed`
- `authStatusChange`
- `loginChatGptComplete`

### 已直接处理的 server request

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/tool/requestUserInput`
- `item/tool/call`
- `account/chatgptAuthTokens/refresh`

## 5. 查详细说明时的顺序建议

1. 先查本地索引
2. 再查本地参考：[app-server-reference.md](/Users/lipeixu/Code/codex-web/docs/protocol/app-server-reference.md)
3. 再查本地生成 schema：
   - `generated/ts/ClientRequest.ts`
   - `generated/ts/ServerNotification.ts`
   - `generated/ts/ServerRequest.ts`
4. 最后回官方 README 看上下文说明和字段语义
