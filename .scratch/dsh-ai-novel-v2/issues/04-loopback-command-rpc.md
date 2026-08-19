# 04 — Loopback Command RPC

**What to build:** 侧边栏通过封闭 `/ai-novel` RPC 读取状态、预览命令并提交单聚合 ChangeSet，浏览器不能提供路径或任意 patch。

**Blocked by:** 02.

**Status:** completed

- [x] 支持 state/read、command/preview、command/commit、proposal/list、task/read 封闭端点。
- [x] 请求只接受 branded WorkspaceId 和类型化 payload。
- [x] Host 解析 workspace 并拒绝未知、路径和任意 JSON patch。
- [x] preview 从权威库生成实体级 diff。
- [x] commit 在事务内重校验 revision 并写入审计。
- [x] 稳定错误不泄漏本地路径。

## Known issues

- [x] K3 Standards MAJOR：command RPC 曾重复实现 nextValue 校验；已改为外层 wire envelope 解析后统一委托 `validateNovelChangeSet`，preview 与 commit 共享同一权威语义。
- [x] 审查补充：未初始化读路径曾可能创建空库；已为 RPC 读路径使用 `create: false`，失败后不留下 `.ai-novel` 或 `novel.db`。

GitHub: https://github.com/EthanYoQ/AI-Novel-Writer/issues/122
