# 07 — 架构与人物 Proposal Bundle

**What to build:** 模型一次生成项目设置、架构和人物等多个建议，侧边栏支持逐项 diff、顺序应用、partial 恢复和重新生成。

**Blocked by:** 06.

**Status:** ready-for-agent

- [ ] Proposal Bundle 能包含多个单聚合 ChangeSet。
- [ ] 每项独立显示 base revision 和 diff。
- [ ] 顺序应用、失败即停。
- [ ] partial 状态可恢复，已应用项不重复提交。
- [ ] 可逐项重试、放弃或重新生成。
- [ ] stale proposal 不能 blind apply。

GitHub: https://github.com/EthanYoQ/AI-Novel-Writer/issues/125
