# AI Novel Writer DSH 插件 V2.2 规格

## Problem Statement

当前 DSH 插件可以被激活并展示侧边栏，但它的产品能力仍是“模型通过工具修改五个文件资产”。用户无法在侧边栏完成软件版的核心创作流程，模型生成的结果也不稳定地变成可见、可操作、可恢复的项目状态。长篇创作需要的章节版本、审稿、修稿、定稿、人物状态和任务进度没有持久领域模型。

## Solution

将插件重构为侧边栏主权的小说工作台。DSH 聊天窗负责自然语言输入和模型生成；侧边栏负责项目、架构、人物、章节、提案、任务和版本操作。每个 workspace 使用 `.ai-novel/novel.db` 作为随项目移动的权威库。模型只读项目并提交持久非权威 proposal；用户在侧边栏预览、应用、放弃或重试建议。权威提交只来自类型化 loopback 命令，并在项目库中留下审计。

## User Stories

1. 作为小说作者，我想在 DSH 侧边栏创建项目，以便不用理解底层文件结构也能开始写作。
2. 作为小说作者，我想让模型生成项目设置、架构、人物和章节蓝图，以便快速从一句话想法得到可编辑骨架。
3. 作为小说作者，我想在侧边栏看到模型建议队列，以便不用在聊天记录里寻找生成结果。
4. 作为小说作者，我想逐项查看建议 diff，以便知道每个字段和每章正文会发生什么变化。
5. 作为小说作者，我想按顺序应用建议中的多个变更，以便一次生成可以覆盖多个资产。
6. 作为小说作者，我想看到部分应用和失败状态，以便知道哪里成功、哪里需要重试。
7. 作为小说作者，我想手动编辑项目设置和故事架构，以便不依赖模型也能修改作品。
8. 作为小说作者，我想维护人物卡、关系和当前状态，以便长篇角色不漂移。
9. 作为小说作者，我想维护章节蓝图，以便每章有明确目的、事件和出场人物。
10. 作为小说作者，我想生成章节草稿版本，以便保留不同写作方案。
11. 作为小说作者，我想对草稿生成审稿报告，以便发现设定、时间线和角色一致性问题。
12. 作为小说作者，我想基于审稿生成修稿版本，以便按报告修复问题。
13. 作为小说作者，我想选择某个版本定稿，以便下一章使用明确的上一章状态。
14. 作为小说作者，我想查看任务进度和失败原因，以便知道长时间生成流程处于什么阶段。
15. 作为小说作者，我想刷新或重启 DSH 后恢复提案和任务，以便工作不会因连接中断丢失。
16. 作为小说作者，我想在 workspace 变化后先看到只读状态并显式重新绑定，以免把项目写进错误目录。
17. 作为小说作者，我想得到本地路径不暴露、无路径写入的安全界面，以便浏览器侧边栏不成为任意文件工具。
18. 作为模型使用者，我想让模型只看到 bounded novel context，以便请求成本和上下文不随全书无限增长。
19. 作为模型使用者，我想让模型不能权威写盘，以免模型误写或重复写。
20. 作为模型使用者，我想让模型建议持久保存但不改变权威资产，以便用户可以审阅。
21. 作为维护者，我想让每次权威提交有幂等审计，以便排查并发和重试。
22. 作为维护者，我想用显式迁移从 V1 进入 V2，以免静默迁移破坏旧项目。
23. 作为维护者，我想检测复制库和 workspace 绑定不匹配，以免产生双事实源。
24. 作为维护者，我想在两个 DSH 进程同时写入时 fail closed，以免数据库损坏。
25. 作为维护者，我想让插件 HMR 卸载时等待在途操作并释放锁，以免测试和开发环境留下半状态。
26. 作为测试者，我想用真实 Loader 和真实浏览器验证工作台，以免只依赖 mock 通过。
27. 作为测试者，我想用 keyless snapshot 固定模型可见输入，以便重构不改变 prompt 和工具面。
28. 作为发布者，我想打包 tarball 并安装到一次性 profile，以便验证用户实际安装路径。
29. 作为发布者，我想保持 DSH upstream 和桌面版源码零修改，以便插件独立发布。
30. 作为小说作者，我想在 390px 窄屏和 1440px 宽屏都能操作侧边栏，以便不同设备可用。

## Implementation Decisions

- `.ai-novel/novel.db` 是项目内容 artifact，不使用 DSH storage domain。
- NovelStore 使用 Node 内建 SQLite，动态导入驱动。
- 数据库设置 application id、schema version 2、外键、DELETE journal、FULL synchronous 和单写连接 EXCLUSIVE lock。
- projectId 与 workspace 绑定存储在数据库 meta 中；绑定不匹配时只读，显式 re-attach 后可写。
- ChangeSet 只修改一个聚合；Proposal Bundle 按顺序应用并显式呈现 partial 状态。
- 模型工具面只有 `novel_read` 和 `novel_propose_change`。
- proposal 是持久非权威 inbox，按 canonical hash 幂等，默认最大 2 MiB、20 条 pending。
- V2 Preset 使用新 ID，V1 Preset 与旧会话保留。
- 侧边栏继续使用 `/ai-novel` loopback connection RPC，端点封闭为 state/read、proposal/list、command/preview、command/commit、task/read。
- 权威提交审计存储在项目库 changes 表，不创建仓库外插件自定义 DSH SessionEvent。
- V1 迁移显式触发，归档源文件、staging 单事务导入、完整关闭并原子发布。
- `.vela` 桌面格式不读取、不写入。

## Testing Decisions

测试通过公开接口验证行为，不检查私有实现。主要 seam 是 NovelStore、模型工具、loopback RPC、浏览器 controller/view、真实 Loader 组合和安装 profile。测试先红后绿，并优先沿用现有 plugin 测试、snapshot、browser fixture 和 qualification 骨架。

必须覆盖 SQLite 事务与锁、workspace 绑定、迁移、ChangeSet 幂等、proposal inbox、模型工具隔离、RPC 路径拒绝、侧边栏 partial 恢复、一章闭环、真实浏览器布局、tarball 安装和真实模型人工链路。

## Out of Scope

知识库、向量/FTS、导入小说与仿写拆书、导出发布、批量多章自动创作、`.vela` 兼容、全屏工作台和多窗口编辑器。

## Further Notes

GLM 5.3/max 与 K3/max 已完成三轮对抗性审查；第三轮两者均 PASS。外部插件自定义 DSH SessionEvent 被明确否决，因为其不在 DSH 持久化已知事件集合内且公开 append API 不能标记 ignorable。

GitHub: https://github.com/EthanYoQ/AI-Novel-Writer/issues/118
