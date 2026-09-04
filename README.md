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
