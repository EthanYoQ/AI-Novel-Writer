# 项目文档导航

本目录保存用户说明、领域规则、架构决定和开发证据。桌面版本为 `1.2.0-Preview`，属于公开测试。插件独立发布，不使用桌面版本号。

## 先找到需要的文档

- [中文使用说明](../README.md)介绍安装、写作、模型配置、旧项目导入和备份。[中文副本](../README_zh.md)保持相同内容。

- [English user guide](../README_en.md) covers the same desktop behavior in English.

- [Preview 更新说明](../.release/notes/v1.2.0-Preview.md)列出本次用户可见变化。精确发布资产以对应 Release 为准。

- [产品领域词汇](product-domain.md)定义项目事实、草稿、定稿、恢复候选和更新行为。

- [架构决定记录](adr/)保存难以逆转的设计决定。新决定必须说明取代范围。

- [Agent 执行规则](agents/)介绍任务分流、Issue 标签、领域文档和开发协作。

- [实施计划](plans/)保存受审范围、依赖和验收条件。冻结文件中的旧状态不代表当前进度。

- [调研与实施证据](research/)保存来源、实验和验证结果。阅读时核对日期、源码提交和验证范围。

- [任务交接](handoffs/)保存指定分支的日期化快照。后续提交可能使快照过时。

- [DeepSeek Harness 插件说明](../plugins/dsh-ai-novel-writer/)介绍独立插件的安装和使用，不定义桌面版行为。

## 进入 V3 开发资料

V3 是当前桌面写作界面及相关项目流程。开发和审查先读现行规格，再查对应实现及证据。

1. 打开[现行规格索引](research/novel-quality-modernization/current-spec-index.md)。索引连接 34 项原规格及其替代条款。

2. 查看[线程 10 交付计划](research/novel-quality-modernization/thread10-delivery-plan.md)。该计划记录材料补齐、写前细纲和模型实验的要求。

3. 查看[S07 通用模型兼容要求](plans/novel-quality-modernization/specs/S07.md#generic-model-compatibility)。该入口负责模型兼容和参数匹配的详细合同。

4. 查看[总实施计划](research/novel-quality-modernization/frontend-transition-plan.md)和[现行变更规格](research/novel-quality-modernization/frontend-transition-specs.md)。两者覆盖界面、导入、平台和发布要求。

5. 查看[交付变更范围](research/novel-quality-modernization/delivery-contract-delta-2026-09-21.md)。该文说明哪些冻结条款已被替代。

6. 阅读[开发执行规则](agents/delivery.md)，核对调试、审查和收尾要求。

7. 按需查阅[冻结 Program v3 合同](plans/novel-quality-program-v3-2026-09-13/00-START-HERE.md)。其中未被替代的要求仍适用，旧任务状态不代表当前调度。

8. 查阅[实施证据索引](research/novel-quality-modernization/evidence-index.md)和[质量协议](research/novel-quality-modernization/quality-protocol.md)。区分实现接线、模型实验与安装包验证。

历史测试通过不代表新提交或新安装包已通过。规格生效也不等于实现完成。实际进度应读取当前任务的唯一检查点。

## 核对被替代的要求

- [ADR 0006](adr/0006-unified-cross-platform-github-release.md)记录最初的 Windows 和 macOS ARM64 发布方案。

- [ADR 0016](adr/0016-three-target-release-and-platform-update-actions.md)取代上述平台方案，规定三个发布目标及各平台更新动作。

- [ADR 0019](adr/0019-remove-real-call-hard-cap.md)取消全局 80 次模型调用硬限制。80 次保留为计划分配额，逐请求记账和产品安全限额继续适用。

- [ADR 0020](adr/0020-legacy-project-copy-import.md)规定旧项目以完整副本导入。旧目录保留，转换不调用 AI，导入后的两份项目独立保存。

- [现行 F05](research/novel-quality-modernization/frontend-transition-specs.md#f05--最终-v3-功能及桌面体验资格)负责 V3 操作、旧项目资料保全和桌面体验验证。

- [正文篇幅要求](plans/novel-quality-modernization/specs/S06B.md#prose-length-overrun)保留一次超长压缩。完整正文仍超长时提示并继续，偏短处理不变。

- [历史字数规则与实验](research/novel-quality-modernization/quality-protocol.md#现行字数标准)保留原标准和原结果，不能按后来的标准改判。

- [AI 自主审稿与成稿验证](research/novel-quality-modernization/quality-protocol.md#ai-review-final-manuscript)区分 AI 自行发现的问题和作者补充的问题。机器一致性不证明审稿语义正确。

线程 10 计划调整了实验和采样要求。旧 CLI、历史 PASS 和冻结文件都不能单独证明现行资格已满足。

## 保持文档与源码对应

文档只代表所在工作树及其提交。引用未提交的授权规格时，记录来源、内容 hash 和未提交状态。不要把其他工作树的资料称为当前提交已包含的内容。

[2026-09-05 审查交接](handoffs/2026-09-05-astra-code-review.md)固定于 `7ea4d96`，仅供历史查询。当前行为应核对当前分支的代码和测试。

本机 `AGENTS.md` 和 `CONTEXT.md` 是可选的 Agent 上下文。两者不属于公共文档，不能覆盖产品领域词汇或已接受的架构决定。

包含本机路径或未公开证据的交接默认只供本地使用。公开前先脱敏并核对链接，不将私有交接设为公共导航的必需入口。

## 放置新文档

- 用户可见行为写入中英文 README。两种语言保持同一范围。

- 正式发布资产合同由[发布配置](../.release/release-profile.json)维护。README 不复制资产校验值清单。

- 稳定术语写入[产品领域词汇](product-domain.md)。本机 `CONTEXT.md` 只补充当前工作树说明。

- 难以逆转的设计决定写入连续编号的 ADR。待办、实现进度和测试记录不写入 ADR。

- 调研保留来源、日期和适用范围。实现完成不会自动把调研变成产品合同。

- 临时计划和交接使用日期化文件。记录分支、基准 SHA、未提交修改和未验证事项。

不要复制 API Key、模型凭据、私人小说内容、本机用户目录或可重建的构建输出。

## 核对工作树

接手任务时，先查看工作树清单。进入目标工作树后，再记录该工作树的分支、提交和未提交修改。

```sh
git worktree list --porcelain
git branch --show-current
git rev-parse HEAD
git status --short
```

移动、合并或删除工作树属于单独操作。文档维护不包含这些操作的授权。
