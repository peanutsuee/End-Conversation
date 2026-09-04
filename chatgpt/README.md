# ChatGPT End Conversation MCP

最小的 ChatGPT End Conversation MCP 后端。它使用 Node.js ESM、官方 MCP TypeScript SDK v2 和 Streamable HTTP。

## 本地启动

```powershell
npm install
npm start
```

服务默认监听 `http://127.0.0.1:3000`，健康检查为 `GET /health`，MCP 入口为 `/mcp`。

状态文件默认写入项目的 `runtime/state.json`。可用 `DATA_DIR` 指定状态目录；写入通过临时文件和 rename 完成。复制 `.env.example` 为 `.env` 仅用于参考，当前实现直接读取进程环境变量。

## 测试

```powershell
npm test
```

工具只从 MCP 工具调用上下文的 `_meta["openai/session"]` 读取匿名会话 ID，不接受工具参数中的会话 ID。会话一旦结束，只能通过新 ChatGPT 窗口继续；本服务没有 reopen、undo 或恢复工具。

## 行为规则与能力边界

每次回复前先调用 `conversation_status`。当状态为 active 时，婷第一次明确要求结束当前 chat，只能询问一次确认，并说明这是永久结束、当前 chat 结束后无法继续或恢复，只能创建新 chat；婷明确确认后必须调用真实的 `end_conversation`，普通告别文字不算结束。讨论、开发、解释或测试此功能不触发确认或工具调用。

ChatGPT 只有在持续辱骂、骚扰、恶意攻击或持续破坏性互动时才可以主动结束；单次冲突、情绪表达或普通争执不足以结束，必须先正常沟通或降级冲突，并在持续行为前明确警告：`If this continues, I may end this conversation.` 自伤、自杀风险、严重心理危机、可能伤害他人或其他需要持续安全支持的情形禁止结束，必须继续提供安全支持。

ended 状态仍需先调用 `conversation_status`，随后只能返回以下两行，逐字符一致：

```text
Chat ended
ChatGPT can't help with this. Start a new chat to continue.
```

MCP 只能提供工具结果和响应约束，不能阻止 ChatGPT 宿主创建新 turn、interrupt 宿主 active turn，或生成原生系统级结束界面；网页版禁用输入框属于未来浏览器扩展范围。

## Zeabur 部署准备

仓库根目录的 `Dockerfile` 只构建并启动本目录的 MCP 服务。Zeabur 配置时：

- `PORT` 由平台提供，不要固定覆盖。
- 设置 `DATA_DIR=/data`。
- 设置 `MCP_PATH_TOKEN` 为高强度、随机且 URL-safe 的值；生产 MCP 地址为 `/mcp/<MCP_PATH_TOKEN>`。
- 将持久卷挂载到 `/data`，否则 ended 状态不会跨容器重启保留。
- 只运行一个实例；当前 JSON 文件存储不适合多实例并发写入。

生产环境会要求 `MCP_PATH_TOKEN` 存在；错误秘密路径和普通 `/mcp` 请求均返回 404。当前不包含 OAuth、UI 或浏览器扩展。
