# End Conversation for ChatGPT

这是一个 Chrome Manifest V3 内容脚本扩展，只在 `https://chatgpt.com/*` 页面工作。它只观察当前页面最新一条 assistant 消息；当正文逐字符匹配 MCP 的固定结束文案时，按当前 URL 的 conversation ID 持久化 ended 状态，并遮住、禁用该 chat 的 composer。

扩展不访问网络，不包含或读取 MCP 服务的秘密路径凭据，不保存无关聊天内容，也不提供恢复、解锁或清除 ended 状态的界面。它只负责网页 UI 阻断，不能改变 ChatGPT 服务器状态或阻止宿主创建新的 turn。

版本 0.1.1 在 SPA 导航期间等待旧消息节点脱离并让新 DOM 稳定后，才识别并持久化 ended 文案；已确认 ended 的 conversation ID 仍可立即恢复阻断。首次运行 0.1.1 时会一次性清除 0.1.0 可能写入的 ended 标记，真实 ended chat 会在固定文案再次出现后重新记录。

## 本地安装

1. 打开 `chrome://extensions`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 `browser-extension` 文件夹

## 测试

在此目录执行：

```powershell
npm test
```
