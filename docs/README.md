# 项目文档导航与治理约定

本目录保存可随代码审查、发布和长期维护的项目文档。不同 Worktree 是独立的代码与文档快照；只有当前分支中已跟踪的文件能作为该分支的文档证据，不能把其他 Worktree 的未提交材料当成当前事实。

[`handoffs/2026-09-05-astra-code-review.md`](handoffs/2026-09-05-astra-code-review.md) 是固定到提交 `7ea4d96` 的历史审查快照，记录当时的比较基线、实现提交、两批开发历史、Bug 台账、真实验收和审查顺序；后续审查必须以当前分支代码和测试为准，不能把该快照或其他 README、ADR、旧 handoff 单独当作当前行为证据。

## 文档权威层级

| 文档 | 用途 | 权威与生命周期 |
| --- | --- | --- |
| [`README.md`](../README.md)、[`README_en.md`](../README_en.md) | 面向用户的产品定位、安装、隐私和能力概览 | 当前公开产品说明；中英文需要同步 |
| [`docs/product-domain.md`](product-domain.md) | 稳定产品术语、事实源和边界 | 可发布的领域词汇表；实现和规格应使用这里的名称 |
| [`docs/adr/`](adr/) | 难以从代码恢复的架构决定、边界和取舍 | 已接受决定；后续变化应明确扩展或取代原决定 |
| [`docs/agents/`](agents/) | Issue、领域文档和 Agent 协作规则 | 当前贡献流程；不得承载临时任务状态 |
| [`docs/plans/`](plans/) | 受审实施范围、依赖和验收合同 | Program v3 保存冻结范围；当前剩余工作由活跃规格/计划及显式 delta 调度，冻结包不回填进度 |
| [`docs/research/`](research/) | 调研、实施证据及实验执行说明 | 按各文件的日期和角色使用；历史回执不自动成为当前资格，活跃执行说明须与已接受 ADR 一致 |
| [`docs/handoffs/`](handoffs/) | 指定分支或任务的交接快照 | 有日期的任务状态；完成或分支变化后可能过时 |
| [`plugins/dsh-ai-novel-writer/`](../plugins/dsh-ai-novel-writer/) | DeepSeek Harness 插件的独立使用与开发说明 | 由插件包维护，不替代桌面版文档 |

根目录 `AGENTS.md` 与 `CONTEXT.md` 是可选的本机 Agent 上下文，按仓库卫生规则保持忽略，不是公共文档，也不能覆盖 [`docs/product-domain.md`](product-domain.md) 或 ADR。需要进入公共仓库的稳定产品边界写入领域词汇表或 ADR；公开用户行为同步到中英文 README。

## 已取代的决定

- [`0006-unified-cross-platform-github-release.md`](adr/0006-unified-cross-platform-github-release.md) 保存最初的 Windows + macOS ARM64 发布决定，当前三目标发布与平台更新动作由 [`0016-three-target-release-and-platform-update-actions.md`](adr/0016-three-target-release-and-platform-update-actions.md) 取代。
- [`0019-remove-real-call-hard-cap.md`](adr/0019-remove-real-call-hard-cap.md) 取代冻结实验合同的全局 80 次调用硬帽；80 保留为计划分配额，逐请求记账和产品安全限额继续有效。
- [`0020-legacy-project-copy-import.md`](adr/0020-legacy-project-copy-import.md) 将旧小说兼容改为保留原件的完整项目导入，禁止 AI 重建或覆盖既有设定；取代旧根退役/永久拒写要求。[现行 F05](research/novel-quality-modernization/frontend-transition-specs.md#f05--最终-v3-功能及桌面体验资格) 同时拥有新版编辑交互验收，旧版性能基线不再阻断新版。
- [现行字数标准](research/novel-quality-modernization/quality-protocol.md#现行字数标准) 自 2026-09-20 起将冻结规格中的 ±20% 取代为 ±30%；旧规格与实验回执保留原字节和历史结论。

## Program v3 开发入口

1. [当前实施计划](research/novel-quality-modernization/frontend-transition-plan.md)：核心收尾、PR #262 V3 接入与最终资格的执行顺序；先核对其审计状态。
2. [当前剩余规格](research/novel-quality-modernization/frontend-transition-specs.md)：原八个未完成 Spec 加 F04 局部重开；G01 贯穿。新执行线程从这里读取目标。
3. [交付 delta](research/novel-quality-modernization/delivery-contract-delta-2026-09-21.md)：明确替代冻结合同哪些条款；[执行规则](agents/delivery.md)管理 Skills、调试和审查。
4. [冻结 Program v3](plans/novel-quality-program-v3-2026-09-13/00-START-HERE.md)：34 节点原合同与未被替代的核心要求；其 DAG/NOT STARTED 不代表当前调度或状态。
5. [实施证据索引](research/novel-quality-modernization/evidence-index.md)与[质量协议](research/novel-quality-modernization/quality-protocol.md)：历史证据与现行实验规则分开，历史 PASS 不自动成为新前端资格。

本机续开发快照使用 `docs/handoffs/` 下日期化文件；包含本机路径或未公开证据的文件默认仅供本地接管，不作为公共导航的必需依赖。公开提交前单独脱敏并核对链接。

## 新文档放置规则

- 当前用户行为写入 README；不要复制发布资产清单，精确资产合同由 [`.release/release-profile.json`](../.release/release-profile.json) 维护。
- 稳定领域术语先更新 [`docs/product-domain.md`](product-domain.md)；本机 `CONTEXT.md` 只能补充当前 checkout 的 Agent 说明。
- 难以逆转的架构决定新增连续编号 ADR。实现进度、测试记录和待办不写入 ADR。
- 带日期的调研保留来源、采集时间和适用边界；实现完成不会自动把调研升级为产品合同。
- 临时计划和交接使用日期化文件。交接文档必须注明分支、基准 SHA、脏状态和未验证事项。
- 不在文档中复制 API Key、模型凭据、小说测试内容、用户目录或可再生构建输出。

## Worktree 边界

审计或接手任务时先运行 `git worktree list --porcelain`，再在目标 Worktree 内记录分支、SHA 和 `git status --short`。移动、合并或删除 Worktree 属于单独的清理任务；文档治理不授权这些操作。
