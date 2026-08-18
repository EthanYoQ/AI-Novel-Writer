# 04 — Loopback Command RPC

**What to build:** 侧边栏通过封闭 `/ai-novel` RPC 读取状态、预览命令并提交单聚合 ChangeSet，浏览器不能提供路径或任意 patch。

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] 支持 state/read、command/preview、command/commit、proposal/list、task/read 封闭端点。
- [ ] 请求只接受 branded WorkspaceId 和类型化 payload。
- [ ] Host 解析 workspace 并拒绝未知、路径和任意 JSON patch。
- [ ] preview 从权威库生成实体级 diff。
- [ ] commit 在事务内重校验 revision 并写入审计。
- [ ] 稳定错误不泄漏本地路径。

GitHub: https://github.com/EthanYoQ/AI-Novel-Writer/issues/122
