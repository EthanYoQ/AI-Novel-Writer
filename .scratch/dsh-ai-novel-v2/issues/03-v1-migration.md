# 03 — V1 显式迁移

**What to build:** 用户显式把 V1 五资产项目迁移到 V2 项目库，迁移过程可验证、可重试且不修改 V1 源文件。

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] 迁移前计算 V1 文件 fingerprint 并展示预览。
- [ ] 源文件复制到 fingerprint archive。
- [ ] staging SQLite 单事务导入全部 V1 资产并写入 receipt。
- [ ] staging 完整关闭、checkpoint、确认无 sidecar 后原子发布。
- [ ] archive 已发布但 DB 未发布时可幂等恢复。
- [ ] V1 fingerprint漂移时 fail loud。

GitHub: https://github.com/EthanYoQ/AI-Novel-Writer/issues/121
