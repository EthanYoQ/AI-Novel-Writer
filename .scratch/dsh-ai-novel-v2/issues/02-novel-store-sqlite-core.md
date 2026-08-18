# 02 — NovelStore SQLite 核心

**What to build:** 创建 `.ai-novel/novel.db` 的权威领域库，能初始化项目、读写聚合、执行单聚合事务、递增 revision 并记录提交审计。

**Blocked by:** 01.

**Status:** ready-for-agent

- [x] schema 使用 application id、user version 2、外键和严格表约束。
- [x] 初始化生成项目身份、workspace 绑定、忽略规则和初始聚合。
- [x] 正常写连接独占持有到 dispose，诊断/绑定不匹配时只读。
- [x] 每个 ChangeSet 校验 aggregate/global revision、完整 next value 和幂等 id。
- [x] 事务部分失败完全回滚并保留稳定错误。
- [x] 重启后能读回项目、revision 和审计。

GitHub: https://github.com/EthanYoQ/AI-Novel-Writer/issues/120
