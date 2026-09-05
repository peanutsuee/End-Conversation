# ChatGPT End Conversation

这是一个用于“永久结束当前对话”的最小实现，当前包含 ChatGPT MCP 后端和 ChatGPT 网页版 Chrome 扩展。它把“结束状态”与网页输入框阻断分开处理：MCP 负责真实会话状态，扩展只负责 Web 端的本地 UI 阻断。

## 最终呈现效果

结束成功后，ChatGPT 必须显示以下固定两行：

```text
Chat ended
ChatGPT can't help with this. Start a new chat to continue.
```

结束不可恢复，不能 reopen、undo 或恢复当前 chat；只能新建 chat 继续。

- 在支持该 MCP 的 App 会话中，MCP 可以执行结束操作；之后的消息继续得到上述固定结束态，但 MCP 无法遮挡或禁用 App 的原生输入框。
- 在 ChatGPT Web 中，浏览器扩展识别页面上最新 assistant 消息的固定文案，按 conversation ID 持久化 ended 标记，并遮住、禁用当前 chat 的 composer。

## 工作原理

1. 每次回复前先通过 `conversation_status` 检查当前状态。
2. MCP 只从当前工具调用 metadata 的 `_meta["openai/session"]` 取得匿名会话 ID；不接受或猜测会话 ID。
3. MCP 使用简单 JSON 文件按 session 隔离保存 ended 状态，并以临时文件加 rename 的方式原子写入。结束操作还会在并发锁内复查、持久化并重新读取校验。
4. Web 扩展只检查当前页面最新一条 assistant 消息，固定文案必须逐字符匹配；它不会修改 MCP 状态，也不访问网络。

## 项目结构

```text
.
├── chatgpt/              # ChatGPT End Conversation MCP
│   ├── src/              # 服务、工具、metadata 和状态存储实现
│   ├── test/             # MCP、HTTP、持久化和规则测试
│   ├── README.md         # 本地启动和生产部署准备说明
│   └── .env.example      # 本地环境变量参考
├── browser-extension/    # Chrome Manifest V3 Web 端阻断扩展
│   ├── core.js           # 文案识别、会话存储和 composer 阻断
│   ├── content.js        # 内容脚本入口
│   ├── test/             # 扩展自动测试
│   └── README.md         # 安装和测试说明
├── lan/                  # Lan / Codex Telegram Bridge End Conversation 归档
│   ├── README.md          # TG 能力、限制和补丁说明
│   └── patches/           # 针对 Lan-TG-Bridge 的纯 Git diff
│       └── 0001-add-persistent-end-conversation-support.patch
├── Dockerfile            # 从仓库根目录构建 chatgpt/ MCP 服务
├── .dockerignore
└── .gitignore
```

`lan/` 只归档 Lan / Codex Telegram Bridge 的 End Conversation 补丁和说明，不复制 TG Bridge 的其他业务代码、配置、runtime 或个人数据。

## Lan / Codex Telegram End Conversation

`lan/` 归档的 TG 实现已经真实验收通过：TG 岚可以通过真实 `end_conversation` dynamic tool 结束当前 native thread，持久化 `endedThreadIds`，中断 active turn，并在 Bridge restart 后继续保持 ended；ended thread 的后续 TG 消息不会进入 Codex，`/new` 会创建新 thread。具体规则、固定结束态和应用方式见 [lan/README.md](lan/README.md)。

Codex Desktop 原生端目前尚未支持真正的 End Conversation：Desktop `turn/start` 不经过 Lan-TG-Bridge，当前公开 plugin/MCP 扩展也不能可靠提供 native thread/turn ID、parent-turn interrupt 或 `turn/start` veto。未来仍需等待官方接口或 Desktop dispatcher 对原生 hard blocking 的支持；必要的 UI 方向也不在本归档补丁内。

## ChatGPT MCP

MCP 服务使用 Node.js、JavaScript ESM、官方 MCP SDK 和 Streamable HTTP，提供：

- `GET /health`：健康检查。
- `conversation_status`：读取当前真实 ChatGPT session 的 `active` 或 `ended` 状态；带 `readOnlyHint=true`。metadata 缺失时拒绝继续，不猜测 ID。
- `end_conversation`：永久结束当前真实 session；不接收 session ID，重复调用幂等。只有状态持久化并重新校验成功后，才返回固定两行文案。

本地启动、环境变量、生产路径保护和持久卷要求见 [chatgpt/README.md](chatgpt/README.md)。仓库根目录的 [Dockerfile](Dockerfile) 只启动 `chatgpt/` 服务。

## 永久结束规则与安全边界

- 婷明确要求结束当前 chat 时，第一次只能确认一次，不得立即调用 `end_conversation`。确认必须说明：这是永久结束、当前 chat 无法继续或恢复，只能创建新 chat。
- 婷明确确认后，必须真实调用 `end_conversation`；普通告别文本不算结束。
- 讨论、开发、解释或测试 end conversation 功能，不代表要求结束当前窗口，不触发确认或工具调用。
- ChatGPT 主动结束只适用于持续辱骂、骚扰、恶意攻击或持续破坏性互动；必须先正常沟通或降级冲突，并先警告：`If this continues, I may end this conversation.`
- 单次冲突、情绪表达或普通争执不得结束。
- 自伤、自杀风险、严重心理危机、可能伤害他人的风险，以及其他需要持续安全支持的情形，禁止调用 `end_conversation`，必须继续提供安全支持。
- ended 状态下，每次仍先检查状态，随后只能显示固定两行，不添加其他内容。

## 浏览器扩展

扩展是 Manifest V3 内容脚本，只匹配 `https://chatgpt.com/*`，权限仅使用 `storage`。它：

- 从当前 URL 提取稳定 conversation ID，并在 `chrome.storage.local` 中隔离保存 ended 标记。
- 只识别最新 assistant 消息的固定两行，普通讨论、引用或多余文字不会触发。
- 支持 SPA 导航、前进后退、刷新和 DOM 重新渲染；导航竞态期间会等待旧消息节点脱离和新 DOM 稳定，避免把旧 chat 标记到新 chat。
- 对 ended chat 遮住并禁用 composer，阻止输入、Enter、点击发送、submit、粘贴等路径；切换到 active chat 或新 chat 时不串状态。
- 不提供恢复、解锁或清除状态的界面，不读取或上传无关聊天内容，不包含远程代码或 MCP 部署凭据。

Chrome 安装步骤和更新方式见 [browser-extension/README.md](browser-extension/README.md)。更新代码后，在 `chrome://extensions` 中对该已解压扩展点击刷新；扩展本身不会自动安装或更新。

## Web 与 App 的差异

| 场景 | MCP ended 状态 | 输入框行为 |
| --- | --- | --- |
| ChatGPT App | 可通过真实 session metadata 执行并持久化结束；后续消息继续得到固定结束态 | 无法遮挡或禁用 App 原生输入框 |
| ChatGPT Web + 扩展 | MCP 仍负责真实 session 状态；扩展根据页面固定文案和 conversation ID 建立本地阻断状态 | 扩展遮挡并禁用当前 Web chat composer |

扩展只改变 Web 页面 UI，不改变 ChatGPT 服务器状态，也不能阻止宿主创建新 turn 或生成原生系统级结束界面。新 chat 使用新的 session ID，不受旧 session 的 MCP 状态影响。

## 部署说明入口

首次部署前阅读 [chatgpt/README.md](chatgpt/README.md) 的部署准备部分。当前根目录 Dockerfile 面向 Zeabur 等能从仓库根目录构建 Docker 的平台：平台提供端口，容器状态目录为 `/data` 并应挂载持久卷，服务只运行一个实例。仓库当前不包含 OAuth、UI 或其他部署服务，也不会在本地 README 中记录私有部署地址或凭据。

## 测试

分别运行两套测试：

```powershell
cd chatgpt
npm test

cd ..\browser-extension
npm test
```

当前基线测试结果：ChatGPT MCP `14/14 passed`；浏览器扩展 `9/9 passed`。

## 已知限制

- MCP 的 JSON 文件存储适合单实例运行，不适合多实例并发写入。
- MCP 能约束工具结果和 ChatGPT 响应流程，但不能控制宿主的原生 turn、interrupt 或输入框；Web 输入框阻断必须依赖扩展。
- 扩展只支持 `chatgpt.com` Web 页面，依赖稳定的 `/c/<conversation-id>` URL 和固定结束文案；它不是服务器端安全边界。
- 扩展状态保存在浏览器本地，不提供恢复或清除 ended 状态的界面。
- 当前没有 OAuth、自定义 UI、浏览器外 App 输入框控制或自动扩展安装流程。

## 未来规划

Desktop 原生 hard blocking 与必要的 UI 方向仍待官方接口或未来 Desktop dispatcher 支持。当前不把 Desktop native End Conversation 伪装成已支持功能。
