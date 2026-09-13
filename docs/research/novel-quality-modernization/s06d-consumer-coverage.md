# S06D 当前消费者核销（源码快照）

本次为source inventory，不是S06D complete或产品模型资格。原S00 inventory及s05/s06a coverage是历史起点；当前状态以私有 s06d-consumer-coverage-current.json 源码hash为准。

| 入口 | 当前adapter | 当前有界证据 | 尚待完成 |
|---|---|---|---|
| 架构config/premise/角色/world/synopsis | architecture.command→Base selection→workflow-main-generation→main | 先前S06A本地确定性/guard恢复验收 | 本表不重复模型资格；角色UI后续S09C |
| directory 10/50/200范围 | directory.command→Base main +持久range progress | 先前S06A原root/范围guard | 预算校准S07，不扩帽 |
| planning-material/config字段/style独立 | 真实selection→main，guarded effect/dirty CAS | 先前S06A与新增import style seam | 不自动把候选当author source |
| 单章正文/批量正文 | generate-draft→main prepared context、draft commit、batch root | S06B原接线与恢复用例 | 本表不重申模型/安装资格 |
| review/refine/review-derived refine | review-revision-command→main dedicated context/effect | S06C已独审集成 | S11最终审稿完成语义递延 |
| Agent与start_workflow | agent-store→AgentGenerationClient→main agents；registration child同root/model | 当前actualowner、IPC、consumer有界测试 | S06D全消费者仍未核销完 |
| import global/style/blueprints | import-novel/analyze-style→Base import slot；main execute ordinal+actual lease；prepared effectguard | 当前import owner14case与中央集成；本表不替代后续最新receipt | 最终整合freeze以root为准，不沿旧12caseauthority验收 |
| editor选区refine/expand/continue/dialogue | CodeMirrorEditor→EditorInlineGenerationClient→main editor context/task | main5case、恢复卡4case+旧11 browser | 作者替换只本地dirty；独立root终验为准 |
| 定稿notes/characters后处理 | finalize-chapter已有Base main selection与characters main proof | 已接main，不代表阶段durable恢复完成 | notes+blueprint双IPC非TX、contextId Map、原ACK持久/旧epoch恢复未完成；见s06d-finalization-recovery-plan |
| 剧情树 | plot-tree-generator默认createGenerationRuntime({budget,modelId,projectSession}) | 旧合同测试不等main迁移 | NOT MIGRATED；自动保存派生snapshot需来源/ACK guard |
| 叙事计划/事件候选 | narrative-thread-candidate-generator默认旧runtime | 旧候选parse/evidence测试不等main迁移 | NOT MIGRATED；作者确认才写plan/event，需main实际source context |
| 旧角色Markdown修复 | use-character-roster-repair→architecture-workflow.migrateLegacyCharacterRoster→RepairLegacyCharacterRosterCommand | 实际生产动态import与callLLM已确认 | NOT MIGRATED；execute无selection走Base legacy，bounded continuation/JSON repair尚无main root。legacy_cards_preserved的adopt分支无模型，不与Markdown路径混淆 |

## LLM store 与legacy runtime核查

- src/stores/llm-store.ts generate定义仍在，并发往llm:generate；本轮非测试src引用核查未发现生产消费者调用generate。不能依据CodeGraph无caller单独宣告删除；保留为未使用兼容API，IPC仍存在。不把import orchestrator参数generate、review局部generate或provider.generate误算store调用。
- generateStream存在明确生产调用：generation-runtime.ts createDefaultEnvironment的llmStore.generateStream。旧runtime options无runHandle时才选此environment；main runHandle分支走main transport。故generateStream绝非无生产调用。
- 非测试src中createGenerationRuntime直接调用仅plot-tree-generator、narrative-thread-candidate-generator、Base dependenciesFor/main?mainruntime:legacyruntime三处。这个“直接调用点三处”不等于“实际入口两个”：Base的legacy-character-roster-repair无selection是真实可达旧路径。正常已迁commands提供selection，fake dependency旧分支保单测兼容，但不能把全部Base旧分支说成仅测试。
- CodeMirrorEditor仍useLLMStore只为初始defaultModelId；生成已走editor-inline client，不再store.generateStream。
- Agent engine的generate是注入函数/hosted client，不是useLLMStore.generate；Agent标题generateTitle为纯字符串逻辑。
- DSH/plugins按原Spec独立排除；其provider/runtime不能计作桌面S06D未迁，也不能据桌面通过宣告插件通过。

## 当前阻断

S06D不得complete：plot、narrative候选、旧角色Markdown修复三条实际legacy生成仍待迁；定稿后处理已main但durable阶段效果/恢复未完成。CI timeout/native异常另案，不在本表抹掉。没有运行模型、没有新增生产或测试变更。
