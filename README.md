# Codex Web Local UI

一个本地 Web UI for Codex。前端运行在浏览器，后端运行在本机，默认只绑定 `127.0.0.1`，通过本机 `codex` 启动并管理官方 `app-server`。

`codex` 可执行文件的解析优先级现在是：

1. `.env` 或 `codex-web.config.json` 中显式指定的 `CODEX_APP_SERVER_COMMAND` / `codexCommand`
2. 当前项目本地安装的 `node_modules/.bin/codex`
3. 全局 PATH 中的 `codex`

这意味着如果你在当前仓库里安装了较新的 `@openai/codex`，`codex-web` 会优先使用它，而不是误命中系统里的旧版全局 `codex`。

## 协议参考

仓库内已整理了 `app-server` 的本地参考文档，后续开发建议优先查这两份：

- 接口索引（只列接口名称和分类）：
  - [docs/protocol/app-server-interface-index.md](/Users/lipeixu/Code/codex-web/docs/protocol/app-server-interface-index.md)
- 工程参考（保留关键说明、事件和注意点）：
  - [docs/protocol/app-server-reference.md](/Users/lipeixu/Code/codex-web/docs/protocol/app-server-reference.md)

如果需要更完整的字段说明、示例和兼容性说明，再回官方 README 或本地生成 schema：

- 官方 README：
  - https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- 本地 schema / TS：
  - `generated/schema`
  - `generated/ts`

## 配置文件

新增根目录配置文件 [codex-web.config.json](/Users/lipeixu/Code/codex-web/codex-web.config.json)，作为默认配置源；`.env` 用于覆盖它。

当前默认值：

- 前端 `10000`
- 后端 `9000`
- `app-server` 配置端口 `4500`
- 工作区持久化数据库：`data/workspaces.db`

## 已实现

- 本地后端自动启动 `codex app-server`
- 后端完成 `initialize` / `initialized`
- 复用官方 ChatGPT 登录流程
- 账号状态读取与登出
- 白名单工作目录选择与后端强校验
- 新增工作区与当前工作区切换，本地持久化到 SQLite
- 线程列表、新建线程、读取线程历史
- prompt 提交、流式事件展示、基础中断
- 命令/文件变更/工具用户输入审批 UI
- turn 级 diff 与文件 patch 预览
- 本地审计日志 `logs/*.log`
- 开发与构建脚本：`dev` / `build` / `start` / `lint`

## 架构

```text
Browser (React/Vite)
  -> HTTP + WebSocket
Local Node Server (127.0.0.1:9000)
  -> spawn child process
Codex app-server (official protocol)
  -> official ChatGPT auth flow in system browser
ChatGPT / OpenAI auth backend
```

## 关键说明

- 当前本机 `codex app-server` 的官方公开传输层是 `JSON-RPC over stdio(JSONL)`，不是 WebSocket。
- 因此本项目采用：
  - 前端 <-> 后端：HTTP + WebSocket
  - 后端 <-> `codex app-server`：官方 `JSON-RPC over stdio`
- 这是基于本机实际可用版本和 OpenAI 官方文章《Unlocking the Codex harness: how we built the App Server》的保守实现。
- 没有解析 Codex TUI 输出，也没有伪造或篡改认证文件。

## 依赖

- Node.js 22+
- npm 10+
- 已安装 `codex` CLI，并确保命令行可执行 `codex`

如果你希望 `codex-web` 固定使用项目本地版本，推荐在仓库根目录安装：

```bash
npm install -D @openai/codex
```

安装后，后端会优先使用本地 `node_modules/.bin/codex`。

## 安装

```bash
npm install
cp .env.example .env
```

Windows 可直接复制 `.env.example` 为 `.env`。

## 环境变量

核心配置集中在 [`.env.example`](/Users/lipeixu/Code/codex-web/.env.example)。

默认配置文件在 [codex-web.config.json](/Users/lipeixu/Code/codex-web/codex-web.config.json)。

重点变量：

- `HOST=127.0.0.1`
- `SERVER_PORT=9000`
- `WEB_PORT=10000`
- `APP_SERVER_PORT=4500`
- `CODEX_APP_SERVER_COMMAND=codex`
- `CODEX_APP_SERVER_ARGS=app-server`
- `DATA_DIR=data`
- `WORKSPACE_DB_FILE=workspaces.db`
- `ALLOWED_WORKSPACES=c:\code\proj1;c:\code\proj2`
- `DEFAULT_WORKSPACE=c:\code\proj1`
- `ALLOWED_ORIGINS=http://127.0.0.1:10000,http://localhost:10000`

优先级：

1. `.env`
2. `codex-web.config.json`
3. 代码内默认值

`CODEX_APP_SERVER_COMMAND` 如果不填，后端会自动按“项目本地 -> 全局 PATH”的顺序解析 `codex`。

## 工作区持久化

- 工作区列表和当前工作区会持久化到 `data/workspaces.db`
- 只有位于 `ALLOWED_WORKSPACES` 白名单根目录内的路径才能被添加
- 服务重启后，会自动恢复上次添加过的工作区和当前工作区

如果当前环境对默认 `~/.codex` 没有写权限，可以额外设置：

- `CODEX_HOME_DIR=./.codex-home`

这仍然走官方登录流程，只是把 Codex 本地状态放到自定义目录。

## 启动

开发模式：

```bash
npm run dev
```

生产构建：

```bash
npm run build
npm run start
```

默认地址：

- Web: `http://127.0.0.1:10000`
- Server API: `http://127.0.0.1:9000`

## 登录流程

1. 打开 Web UI
2. 点击“使用 ChatGPT 登录”
3. 后端调用官方 `account/login/start`，若当前版本只支持旧接口则回退到 `loginChatGpt`
4. 后端在系统浏览器打开 `authUrl`
5. 登录完成后，UI 会通过通知和轮询刷新账号状态

## 安全策略

- 仅监听 `127.0.0.1`
- 后端限制 `Origin`
- 只允许白名单工作目录
- 审批决策写入 `logs/`
- app-server 异常、登录状态变化、线程创建、prompt 提交都会记录审计日志

## 常见问题

### 1. 提示无法启动 `codex app-server`

先检查：

```bash
codex --help
codex app-server -h
```

再查看 `logs/` 中的 `error.app_server.*` 记录。

### 2. 点击登录后浏览器没有打开

系统浏览器打开是由本地后端调用系统命令触发的。请确认：

- Windows 的默认浏览器关联正常
- macOS 上 `open` 可用
- Linux 上 `xdg-open` 可用

### 3. 为什么后端到 app-server 不是 WebSocket

因为当前官方可确认的稳定 transport 是 `stdio(JSONL)`。本项目按“优先使用官方协议、以本地实际行为为准”的原则实现，并在前端侧仍提供 WebSocket 流式体验。

`APP_SERVER_PORT=4500` 目前作为显式配置项保留在设置与配置文件中，用于和官方桌面端口约定保持一致，以及后续如果官方公开 socket transport 时便于切换；当前版本实际通信仍走官方 `stdio(JSONL)`。

## Windows 注意事项

- `ALLOWED_WORKSPACES` 使用分号分隔，例如 `C:\code\a;C:\code\b`
- 若 PowerShell/终端里 `codex` 不在 PATH，需先确认 `codex --help` 可运行
- 某些公司环境下默认浏览器或安全软件会拦截本地唤起浏览器，需要手动放行

## 已实现 / 假设 / 待确认边界

已实现：

- v2 `account/read`
- v2 `account/login/start`
- v2 `thread/list`
- v2 `thread/start`
- v2 `thread/read`
- v2 `turn/start`
- v2 `turn/interrupt`
- 命令/文件变更审批请求
- turn diff 通知

假设：

- 某些字段如 rate limit window 的具体数值结构在不同版本可能有差异，当前按本机生成 schema 做宽松读取

待确认：

- 动态工具调用 `item/tool/call` 的完整 UI 交互，本版仅返回“不支持动态工具”
- diff 目前主要依据 patch hunk 生成前后片段，不是完整文件历史快照
- 不依赖 git；若未来接入 git 存在时的增强 diff，可进一步完善

## 主要文件

- [apps/server/src/app.ts](/Users/lipeixu/Code/codex-web/apps/server/src/app.ts)
- [apps/server/src/codex-app-server-client.ts](/Users/lipeixu/Code/codex-web/apps/server/src/codex-app-server-client.ts)
- [apps/server/src/workspace-guard.ts](/Users/lipeixu/Code/codex-web/apps/server/src/workspace-guard.ts)
- [apps/web/src/App.tsx](/Users/lipeixu/Code/codex-web/apps/web/src/App.tsx)
- [packages/shared/src/index.ts](/Users/lipeixu/Code/codex-web/packages/shared/src/index.ts)
