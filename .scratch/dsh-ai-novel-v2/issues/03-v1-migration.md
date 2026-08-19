# 03 — V1 显式迁移

**What to build:** 用户显式把 V1 五资产项目迁移到 V2 项目库，迁移过程可验证、可重试且不修改 V1 源文件。

**Blocked by:** 02.

**Status:** ready-for-agent

- [x] 迁移前计算 V1 文件 fingerprint 并展示预览。
- [x] 源文件复制到 fingerprint archive。
- [x] staging SQLite 单事务导入全部 V1 资产并写入 receipt。
- [x] staging 完整关闭、checkpoint、确认无 sidecar 后原子发布。
- [x] archive 已发布但 DB 未发布时可幂等恢复。
- [x] V1 fingerprint漂移时 fail loud。

## Known issues

- [x] K3 Standards MAJOR：symlink workspace root 的拒绝改为语义化 `lstat` 检查，不依赖 alias 与目标的相对路径形态。
- [x] K3 Standards MAJOR：跨设备 hard-link 发布在 README 中明确为稳定 `WRITE_FAILED`，不会替换已有数据库。

GitHub: https://github.com/EthanYoQ/AI-Novel-Writer/issues/121
