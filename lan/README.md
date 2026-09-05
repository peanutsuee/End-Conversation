# Lan / Codex Telegram Bridge End Conversation

这里归档 Lan / Codex Telegram Bridge 的 End Conversation 实现。它不是独立运行程序；补丁依赖 Lan-TG-Bridge 已有的持久 app-server、native thread 和状态架构。

## TG 当前状态

TG `end_conversation` V1 已真实验收 PASS，已确认：

- 岚本人通过真实 `end_conversation` dynamic tool 结束当前对话。
- 婷第一次明确要求结束时，先确认一次；确认后必须真实调用 tool。
- 普通告别不算 end。
- 使用真实 native `thread_id`。
- active turn 可以 interrupt。
- `endedThreadIds` 持久化，Bridge restart 后仍保持 ended。
- ended thread 的后续 TG 消息不会进入 Codex。
- `/new` 创建新 thread，不复活旧 thread。
- 重复 end 幂等。

固定结束态为：

```text
Chat ended
Codex can’t help with this. Start a new chat to continue.
```

## 主动结束规则

- 持续辱骂、骚扰或恶意攻击：先正常沟通，再明确警告；警告后仍持续才允许主动 end。
- 单次冲突、情绪表达或普通争执不得 end。
- 自伤、自杀、严重心理危机或可能伤害他人的风险不得因此 end；应继续提供安全支持。

## 当前限制

- TG 端完整可用。
- Codex Desktop 原生端目前尚不能真正 end。
- Desktop `turn/start` 不经过 Lan-TG-Bridge。
- 当前公开 plugin/MCP 扩展没有可靠的 native `thread_id` / `turn_id`、parent-turn interrupt 或 `turn/start` veto 能力。
- 本归档不声称 Desktop 已支持 End Conversation。

## 补丁来源与应用

补丁来源 commit：

`1fbd95ba5398aed2357ee067fd26b3da311931ab`

`patches/0001-add-persistent-end-conversation-support.patch` 是该 commit 相对其父提交生成的纯 Git diff，不包含原始 commit 的 From、Author、Date、Subject 等邮件 patch metadata。因为身份与隐私清理，仓库只保存纯 diff。

请在匹配的 Lan-TG-Bridge checkout 中检查并应用：

```powershell
git apply --check lan/patches/0001-add-persistent-end-conversation-support.patch
git apply lan/patches/0001-add-persistent-end-conversation-support.patch
```

该补丁针对 Lan-TG-Bridge 架构，不是可单独启动的 End Conversation 服务。
