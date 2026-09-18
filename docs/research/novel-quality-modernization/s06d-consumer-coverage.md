# S06D 当前消费者核销（源码快照）

本表记录 S06D 默认产品消费者的源码核销，配合各入口局部确定性及独立审查材料完成本片交接，不代表产品模型或安装资格。原 S00 inventory 及 s05/s06a coverage 是历史起点；私有 s06d-consumer-coverage-current.json 保留前次快照，最终以 s06d-consumer-coverage-final-current.json 及专属冻结收据为准。

| 入口 | 当前adapter | 当前有界证据 | 尚待完成 |
|---|---|---|---|
| 架构config/premise/角色/world/synopsis | architecture.command→Base selection→workflow-main-generation→main | 先前S06A本地确定性/guard恢复验收 | 本表不重复模型资格；角色UI后续S09C |
| directory 10/50/200范围 | directory.command→Base main +持久range progress | 先前S06A原root/范围guard | 预算校准S07，不扩帽 |
| planning-material/config字段/style独立 | 真实selection→main，guarded effect/dirty CAS | 先前S06A与新增import style seam | 不自动把候选当author source |
| 单章正文/批量正文 | generate-draft→main prepared context、draft commit、batch root | S06B原接线与恢复用例 | 本表不重申模型/安装资格 |
| review/refine/review-derived refine | review-revision-command→main dedicated context/effect | S06C已独审集成 | S11最终审稿完成语义递延 |
| Agent与start_workflow | agent-store→AgentGenerationClient→main agents；registration child同root/model | 当前actualowner、IPC、consumer有界测试 | 与其余默认入口一起完成源码核销；不代替真实模型资格 |
| import global/style/blueprints | import-novel/analyze-style→Base import slot；main execute ordinal+actual lease；prepared effectguard | 当前import owner14case与中央集成；本表不替代后续最新receipt | 最终整合freeze以root为准，不沿旧12caseauthority验收 |
| editor选区refine/expand/continue/dialogue | CodeMirrorEditor→EditorInlineGenerationClient→main editor context/task | main5case、恢复卡4case+旧11 browser | 作者替换只本地dirty；独立root终验为准 |
| 定稿notes/characters后处理 | finalize-chapter→专属main slot/context/task/effect；原attempt持久ACK | 实际SQLite、renderer及注册IPC；notes/blueprint/ACK同TX，角色字段保护与原epoch基线；详见专属证据 | scoped完成不代表真实模型/安装；旧直接派生写入与generic定稿执行已退役 |
| 剧情树 | graph-generation专属main context/task；来源与快照双CAS，原attempt ACK | SQLite owner、来源、renderer/Chromium及中央回归，详见s06d-graph-evidence.md | 独立SQLite17项、IPC18项通过；后续模型/安装资格分别记录 |
| 叙事计划/事件候选 | main实际source→固定task→作者确认stable index→同TX候选写入与ACK | 连续确认仅排除已证明的本次事件；外部变化拒绝；历史回执只读 | 候选不自动成为作者计划或事实 |
| 旧角色Markdown修复 | 两实际编辑器入口→共享恢复panel/hook→launcher→专属legacy-roster main | 实际来源、原六请求上限、原artifact提议、明确ID批准；主流程独立IPC22项及最终界面回归，详见s06d-legacy-roster-evidence.md | 原动态状态保留候选，不冒称定稿状态 |
| 旧角色既有卡片采用 | 同launcher的独立无模型分支→legacy-roster:adopt-existing | actual ID/facts/revision CAS，仅重建投影；独立SQLite20项通过 | 原角色、别名、关系、状态和旧Markdown保全 |

## LLM store 与legacy runtime核查

- src/stores/llm-store.ts generate定义仍在，并发往llm:generate；本轮非测试src引用核查未发现生产消费者调用generate。不能依据CodeGraph无caller单独宣告删除；保留为未使用兼容API，IPC仍存在。不把import orchestrator参数generate、review局部generate或provider.generate误算store调用。
- generateStream存在明确生产调用：generation-runtime.ts createDefaultEnvironment的llmStore.generateStream。旧runtime options无runHandle时才选此environment；main runHandle分支走main transport。故generateStream绝非无生产调用。
- 非测试src中createGenerationRuntime直接调用仍见于plot-tree-generator、narrative-thread-candidate-generator与Base。图谱默认入口已迁专属main，仅明确注入依赖时保留旧测试分支；旧角色默认command也已迁专属main，生产hook/launcher不传generationDependencies。旧能力仍存在，不能称已删除。
- CodeMirrorEditor仍useLLMStore只为初始defaultModelId；生成已走editor-inline client，不再store.generateStream。
- Agent engine的generate是注入函数/hosted client，不是useLLMStore.generate；Agent标题generateTitle为纯字符串逻辑。
- DSH/plugins按原Spec独立排除；其provider/runtime不能计作桌面S06D未迁，也不能据桌面通过宣告插件通过。

## 交接与资格边界

13 类默认产品入口的独立源码核销未发现剩余默认旧 runtime 消费者，私有 s06d-consumer-coverage-final-current.json 保留实际路径与哈希。旧角色界面两项独立反例修复后，最终 12/12 文件与冻结收据匹配，源码核销继续通过。本片提交作为 S07、S09C 的依赖；全量、真实模型及安装门继续按通用执行合同分阶段执行。

最新已完成 CI 普通测试通过，但 native worker 仍异常退出，根因未确认；这些代码及局部确定性结果不等于模型、安装或最终产品资格。真实模型调用仍为 0。
