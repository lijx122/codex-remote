# adapters

渠道适配器，每个适配器只调用 `codex-follower-core` 或 `codex-control-plane`，不直接访问 IPC 管道。

**当前可用：**

- `web/` — Web 前端，由 codex-control-plane 提供服务
- `wxbot/` — 微信渠道，通过 iLink Bot API 收发消息

**接入规则：**

所有 adapter 必须遵守 `BASE_LAYER_INTEGRATION.md` 中的对接规范。
