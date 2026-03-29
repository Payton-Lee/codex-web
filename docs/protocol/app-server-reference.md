# App Server 本地参考

这份文档是基于官方 `codex-rs/app-server/README.md` 整理的本地开发参考，重点保留当前 `codex-web` 最常用的协议、接口和注意事项，便于在本仓库内直接查阅。

官方来源：
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Experimental API Opt-in: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#experimental-api-opt-in

## 1. 基本协议

- `codex app-server` 使用双向 JSON-RPC 2.0。
- 支持两种 transport：
  - `stdio://`，默认，按行传输 JSON
  - `ws://IP:PORT`，实验性 websocket
- websocket 监听还会暴露基础探活：
  - `GET /readyz`
  - `GET /healthz`

当前项目默认通过子进程 + `stdio` 与 `app-server` 通信，不直接依赖 websocket。

## 2. 三个核心对象

- `Thread`
  - 一条完整对话
- `Turn`
  - 一次用户输入和一次 agent 处理过程
- `Item`
  - turn 内部的原子条目，例如：
  - `userMessage`
  - `agentMessage`
  - `reasoning`
  - `commandExecution`
  - `fileChange`

当前 Web UI 的线程页、聊天区和 diff 区，本质上都在消费这三层结构。

## 3. 生命周期

典型顺序：

1. `initialize`
2. `initialized`
3. `thread/start` 或 `thread/resume`
4. `turn/start`
5. 持续接收事件：
   - `turn/started`
   - `item/started`
   - `item/.../delta`
   - `item/completed`
   - `turn/completed`

如果需要继续旧线程，优先使用 `thread/resume`，不要新建线程伪装成继续会话。

## 4. 初始化

连接建立后必须先发一次 `initialize`，然后再发 `initialized`。

关键参数：

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": {
      "name": "codex_web_local",
      "title": "Codex Web Local UI",
      "version": "0.1.0"
    },
    "capabilities": {
      "experimentalApi": true
    }
  }
}
```

注意：
- 一个连接只允许初始化一次
- 未初始化前，其他请求会被拒绝
- `experimentalApi` 是否开启，在初始化时一次性协商完成

当前项目已经在 [app.ts](/Users/lipeixu/Code/codex-web/apps/server/src/app.ts) 里启用了：

```ts
capabilities: {
  experimentalApi: true
}
```

## 5. 常用请求

### 线程

- `thread/start`
  - 创建新线程
- `thread/resume`
  - 恢复旧线程到可继续对话状态
- `thread/fork`
  - 基于现有线程分叉
- `thread/list`
  - 列表线程
- `thread/read`
  - 读取线程详情
- `thread/loaded/list`
  - 读取当前已 materialized 的线程

### 回合

- `turn/start`
  - 开始一次用户输入
- `turn/interrupt`
  - 中断当前 turn

### 账户

- `account/read`
  - 读取账户状态
- `account/rateLimits/read`
  - 读取 ChatGPT 配额窗口
- `account/login/start`
  - 启动登录流程
- `account/logout`
  - 登出

### 技能 / 插件 / 模型 / 模式

- `skills/list`
- `plugin/list`
- `model/list`
- `collaborationMode/list`
- `experimentalFeature/list`

### MCP / Apps

- `mcpServerStatus/list`
  - MCP server 状态、tools、resources、auth
- `config/mcpServer/reload`
  - 重载 MCP 配置
- `mcpServer/oauth/login`
  - MCP 登录
- `app/list`
  - 列出 apps / connectors

## 6. 常用通知

### 线程 / 回合

- `thread/started`
- `turn/started`
- `turn/completed`
- `turn/diff/updated`

### item 级别

- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/reasoning/textDelta`
- `item/reasoning/summaryTextDelta`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`

当前 Web UI 聊天区的实时内容，主要就是靠这些通知拼出来的。

## 7. 审批相关

审批请求来自 `server -> client` 的 JSON-RPC request，而不是普通 notification。

当前重点方法：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`

处理原则：

- 必须保留原始 JSON-RPC `id`
- 回审批结果时，`respond(id, result)` 里的 `id` 类型不能被改写
- 如果把数字 `id` 强转成字符串，后续审批链路可能断掉

这条规则已经在当前项目里踩过坑，后端现在必须原样保留 `message.id`。

## 8. ChatGPT 配额接口

官方示例：

```json
{ "method": "account/rateLimits/read", "id": 7 }
{ "id": 7, "result": { "rateLimits": { "primary": { "usedPercent": 25, "windowDurationMins": 15, "resetsAt": 1730947200 }, "secondary": null } } }
{ "method": "account/rateLimits/updated", "params": { "rateLimits": { ... } } }
```

字段说明：

- `usedPercent`
  - 当前窗口已使用百分比
- `windowDurationMins`
  - 窗口长度，单位分钟
- `resetsAt`
  - 下次重置时间，Unix 时间戳，单位秒

注意：
- 这里不一定返回 `used/limit`
- 对接时要优先兼容 `usedPercent`
- 前端如果显示“余量”，应按产品需要决定展示“已用百分比”还是“剩余百分比”

## 9. Apps / Mentions

`app/list` 用于拿 connector 列表。

推荐做法：

- UI 层展示 `$app-slug`
- 真正发给 `app-server` 时使用 `mention` 输入项
- `path` 采用：
  - `app://<connector-id>`
  - `plugin://<plugin-name>@<marketplace-name>`

这样比只传字符串名字更稳定。

## 10. MCP 集成注意点

- 不要依赖未文档化接口作为主路径
- MCP 建议列表优先基于 `mcpServerStatus/list`
- server / tools / auth / resources 都应从真实返回中归一化
- 如果需要项目内默认 MCP，优先通过项目配置覆盖注入，而不是要求用户全局预装

## 11. Experimental API Opt-in

官方说明：

- 默认只暴露稳定接口
- 想访问实验字段/方法，必须在 `initialize` 时声明：

```json
{
  "capabilities": {
    "experimentalApi": true
  }
}
```

如果没有 opt-in：

- 请求实验方法会被拒绝
- 使用实验字段也会被拒绝
- 错误格式类似：

```text
<descriptor> requires experimentalApi capability
```

示例：

- `mock/experimentalMethod`
- `thread/start.mockExperimentalField`
- `askForApproval.granular`

## 12. 本地生成 schema

为了保证和当前安装版本一致，可以直接用本地 codex 生成：

```bash
codex app-server generate-ts --out generated/ts
codex app-server generate-json-schema --out generated/schema
```

如果要包含实验 API：

```bash
codex app-server generate-ts --out generated/ts --experimental
codex app-server generate-json-schema --out generated/schema --experimental
```

这份生成结果是“和当前 codex 版本完全一致”的本地协议依据，比手写字段猜测更可靠。

## 13. 当前项目对照

本仓库里对应的关键位置：

- app-server 子进程与 initialize：
  - [codex-app-server-client.ts](/Users/lipeixu/Code/codex-web/apps/server/src/codex-app-server-client.ts)
- 服务端协议适配：
  - [app.ts](/Users/lipeixu/Code/codex-web/apps/server/src/app.ts)
- 前端聊天与流式渲染：
  - [ChatView.tsx](/Users/lipeixu/Code/codex-web/apps/web/src/components/ChatView.tsx)
- 前端状态同步：
  - [store.ts](/Users/lipeixu/Code/codex-web/apps/web/src/store.ts)
- 共享协议类型：
  - [index.ts](/Users/lipeixu/Code/codex-web/packages/shared/src/index.ts)

## 14. 使用建议

- 协议问题优先以本地生成 schema 和官方 README 为准
- 前端不要猜字段
- 服务端适配层要负责归一化不同版本返回
- 任何调试接口都只能辅助排查，正式功能应回到官方接口
