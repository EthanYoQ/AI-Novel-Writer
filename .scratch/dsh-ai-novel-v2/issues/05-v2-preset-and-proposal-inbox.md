# 05 — V2 Preset 与 Proposal Inbox

**What to build:** 新 Preset 只暴露 `novel_read` 与 `novel_propose_change`，模型建议持久进入非权威 inbox 并可在重启后恢复。

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] V2 Preset ID 与 V1 分离，旧 Preset 继续服务旧会话。
- [ ] 模型工具面不包含权威写盘工具。
- [ ] proposal 写入 inbox 但不改变权威资产。
- [ ] Host 从 ToolRunContext 获取 session/call provenance，不信任模型参数。
- [ ] canonical hash 幂等去重。
- [ ] 默认 2 MiB、20 pending 限制，超限不丢弃旧建议。

GitHub: https://github.com/EthanYoQ/AI-Novel-Writer/issues/123
