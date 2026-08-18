# 09 — Workspace 绑定与并发恢复

**What to build:** 项目库随 workspace 移动时具备只读检测、显式 re-attach、HMR dispose 和双进程 fail closed 行为。

**Blocked by:** 06.

**Status:** ready-for-agent

- [ ] workspace/path 不匹配时进入只读。
- [ ] 显式 re-attach 更新绑定并可写。
- [ ] 复制库必须显式 clone/re-id。
- [ ] 插件 HMR 先拒绝新命令并等待在途操作。
- [ ] 第二个 DSH 写进程 fail closed。
- [ ] dispose 关闭连接并释放 EXCLUSIVE 锁。

GitHub: https://github.com/EthanYoQ/AI-Novel-Writer/issues/127
