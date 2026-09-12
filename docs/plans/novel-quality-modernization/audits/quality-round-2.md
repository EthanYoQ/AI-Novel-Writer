# 写作质量、预算与恢复独立复审（Round 2）

复审对象为同一计划 v2 的三个约束性组成部分：

- `01-PLAN.md`：`D44598A05DD2683E0225ED1513B49C3F2F03DA51E19B8DD509A614E4EABE8EB8`
- `03-CONTRACTS-AND-GATES.md`：`2AF730617CCAFF0303FEB5D4C9F300CAEB85491EE2814B0E9CFDA030269063C3`
- `04-EXECUTION-MATRIX.md`：`F67B9068E5A26AD8A6040E151DF4AC6900E62944C33A2C8DF8236B81611392C4`

上述 SHA256 已在本工作树复算一致。本轮仅复审 Round 1 的 Q1–Q7 是否关闭，以及新增约束之间是否存在阻断矛盾；未重复全仓调查，未运行模型、生产测试、安装或发布。

## Verdict

**PASS**

Round 1 的 6 项 P1 与 1 项阻断 Spec 的 P2 均已由 v2 的约束性契约和执行矩阵关闭。未发现新增 P0、P1 或影响实施拆分的 P2，也未发现 C01–C07、主计划 DAG 与执行矩阵之间的阻断矛盾。

本 PASS 仅表示该版本计划已经具备继续拆分 Sol/high Spec 的条件；不表示代码、迁移、真实模型质量、安装包、三平台资格或发布已经通过。

## 逐项复审

### Q1 → C01：CLOSED

Round 1 要求的是持久 root action、输入/输出/reasoning 的统一负债、原子 reserve/dispatch/settle，以及重启和并发下不能换 session 逃账。

v2 已明确：

- 主进程持久创建 `rootActionId`，幂等键包含项目、操作、冻结输入版本和 UI nonce；renderer 重启不得自报新动作（`03-CONTRACTS-AND-GATES.md:7-8`）。
- 根账覆盖请求数、输入+输出 token liability、单次输出和跨重启 active elapsed budget（`03:9`）。
- 每个物理请求有唯一 attempt/reservation，状态为 `reserve → dispatch-marked → settled | unknown`；未知发送不得自动释放或重发（`03:10-12`）。
- reasoning 的包含/独立计费不会重复相加，估计版本/余量进入 receipt，usage 超估计仍如实记账并停止后续请求（`03:11-13`）。
- 验收覆盖重复点击、重启、恢复、Agent 子调用、输入密集重试、发送前后取消、unknown、usage 超估计和并发 reserve（`03:16`）。

这足以排除“只持久化现有输出计数器”也能声称完成的实现。具体数值策略留给 S00/S07 校准，同时仍受 C01 的有限硬帽约束，职责划分合理。

### Q2 → C02：CLOSED

Round 1 的风险是周期 flush 乱序覆盖、重放重复、跨 attempt 拼接，以及 fingerprint 不完整。

v2 选择了单一、可实现的方案而非双重机制：

- 单 owner 将 provider delta/cumulative 规范化为 canonical visible prefix，以 `artifactId + attemptId + expectedRevision + nextRevision + textHash` 做 CAS 单调全文快照；回退、乱序和非前缀替换拒绝（`03:20`）。
- 网络重试是新 attempt，无可信事件 ID 的重连不能猜测去重；跨 attempt 只能走显式、有来源、验证重叠的候选组合（`03:22`）。
- fingerprint 覆盖项目/epoch、root lineage、本章 brief/作者指导、草稿与定稿依赖、ContextSnapshot、模板、Skill、模型租约/策略和输出契约（`03:24`）。
- flush 由 owner 排队，恢复只取最大已提交 revision；结构化残片可查看/复制/删除但不能进入正式表（`03:26-28`）。

验收包含 Round 1 所列乱序、竞争、崩溃、epoch、重连、源变化和磁盘满反例，Q2 已关闭。

### Q3 → C03：CLOSED

v2 没有把“前章候选”泛化成相关性搜索：

- 白名单仅允许作者显式选择的当前草稿，或同一冻结 batch lineage 中成功持久化、未被替换的直接前驱（`03:34`）。
- partial、recovery、source-conflict、discarded、stale、跨 batch 和未采用 revision 明确禁止自动进入（`03:34`）。
- ContextSnapshot 记录候选身份/状态/lineage/理由；候选或依赖变化使下游未接受成果转冲突候选，且未定稿文本不得写入角色/连续性事实（`03:34-36`）。
- 验收同时覆盖非法候选与合法待审 batch 前驱，没有以“只准定稿”破坏连续创作（`03:38`）。

这保留了现有“显式选中 + 内容依赖”的保护目的，并堵住废弃候选洗成定稿事实的反例。

### Q4 → C04：CLOSED

v2 对 name/alias 歧义采用 fail-closed：

- `character_id` 永久不变，历史引用同时保留 ID 与显示快照；别名按项目/角色/来源或版本范围解析为 resolved/ambiguous/unresolved，从不 first-match 或相似合并（`03:42`）。
- 旧 name-only 仅在唯一且有来源时自动绑定；歧义保留原字符串、source ref 和候选 ID 集合（`03:43`）。
- 正式关系、蓝图、连续性、审稿目标和 Agent 写入统一使用 ID；模型名字只能经过 resolver/批准边界（`03:44`）。
- ID 赋值、关系重映射和确认 effect 同事务且幂等；动态 provenance 继续服从 ADR0017（`03:46`）。

改名、名字交换、共享别名、两来源同名、自由文本关系、旧候选、重复确认/中断均进入验收（`03:48`）。这已覆盖 Round 1 的所有歧义绑定反例。

### Q5 → C05：CLOSED

v2 将“提交成功”与“finding 已解决”拆成可验证状态：

- finding 锚点包含 sourceHash、span/occurrence、excerptHash、规范类别和稳定事实/目标 ID；无法唯一定位为 unverified（`03:52`）。
- 生成输出后与人工合并后都执行版本化 no-op 比较；证据 hunk 未改或只改无关处保持 unresolved，且不为假判绿调用模型（`03:52-54`）。
- 改写后的一次复核绑定 `mergedHash + findingSet`，逐项需要新证据与稳定目标；坏 JSON、缺失或定位失败为 unknown/unresolved（`03:54`）。
- `revision generated`、`merge committed`、`resolved`、`unresolved`、`unknown`、`author-waived` 独立；waived 只能由作者显式操作（`03:56`）。

对应验收覆盖重复 quote、只改格式/无关 hunk、部分合并、保留原稿、换句保留错误、源稿改变和提交崩溃（`03:58`），足以关闭假绿风险。

### Q6 → C06：CLOSED

v2 已把质量实验从主观组内评价改为可预注册、可复算的严格门：

- S00 在首次实验前冻结事实 oracle、严重度、rubric、复述定义、执行顺序和调用预算，并保存安全基线包（`03:62`）。
- 最终两臂在同时间窗交错、匿名随机，依赖链不串臂；模型版本不可锁时明确漂移限制（`03:64`）。
- 每章字数、必需事件和指定事实均为硬门，任何一章失败不能被组平均抵消（`03:66`）。
- 两名非实现评审者逐章、逐文学维度盲比；不劣与改善阈值、证据要求、仲裁及 inconclusive 均已定义（`03:68`）。
- S07/S10B/S11 设早期 stop/go，失败记录保留；80 次覆盖基线、早期门、最终两臂、失败、重试、修复、审稿和复核，缺样本不能按通过处理（`03:70-72`）。

该门可能严格到经常得到 inconclusive，但这是有界实验的诚实结果，不是规划缺陷；它消除了挑最好结果和迁移全部完成后才发现质量回退的路径。

### Q7 → C07 / 执行矩阵：CLOSED

v2 已提供足够细的计划级调度边界，正式 Spec 尚未生成并不构成缺口：

- 单一集成 owner 独占开库/schema registry、共享 IPC/bridge/startup/package 接线；业务 Agent 不并发修改共享区（`04-EXECUTION-MATRIX.md:5-11`）。
- schema 顺序固定为 M00→M04，业务开发者只提供 migration function/fixture，由唯一 owner 注册；开库顺序和失败拒写明确（`03:74-82`）。
- S06 拆为结构化规划、正文/批量、审修运行、Agent 四波；S09 拆为蓝图/关系、连续性/导入、Agent/UI；S10 先纯契约后生产编译；S14 拆成四份独立结论（`04:22-40`）。
- 入口兼容态明确要求未迁入口也经过同一持久 service/root budget，角色 name-only 不能绕 resolver，旧/新上下文装配不能同时注入事实（`04:48-56`）。
- 每个后续 Sol/high Spec 必须写唯一 owner、禁改共享区、完整路径、依赖 SHA、独立 fixture/命令、故障回退、中文验收和未执行项（`04:60-64`）。

因此 S05/S06/S09/S10 已可按矩阵继续细化为独立 Spec，不再存在“一个 Agent 全组随便改”或并发争抢 schema/IPC 的授权空洞。

## 新约束交叉一致性

未发现阻断矛盾：

- C01 的 root/attempt 账本与 C02 的 attempt 独立候选使用同一 lineage；重试既不会重用供应商 stream，也不会逃离父预算。
- C02 的冲突候选与 C03 的候选白名单一致：可保留、查看和复制，不会因“最近/相关”自动进入事实上下文。
- C03 的来源三态与 C04 的身份三态均 fail-closed；未知来源或歧义身份都不能被正式写入洗白。
- C05 的唯一一次复核受 C01 父预算约束，且 S11 同时拥有 ReviewCycle migration 与 UI/store 语义闭环，状态 owner 没有拆散。
- C06 的 S07/S10B/S11 早期门在 DAG 上均早于 S13；`S12 → S11 → S10B` 的依赖保证 S13 行虽简写为 `S12、S07`，三项质量门仍已到位。
- S04/S05/S08/S11/S12 的实现顺序与 C07 的 M00–M04 schema lane 一致；S03/S04 的真实作者迁移开关保持关闭，不与后置质量/升级资格门冲突。

## 非阻断说明

- C06 的仲裁如何呈现在最终表格、各 Spec 的精确文件清单和具体 schema 整数仍应在 S00/S01 Spec 中落实；v2 已规定语义、owner 和验收，当前无需继续回改计划。
- 后续任何 Spec 若弱化 C01–C07、合并矩阵中的独立结论，或绕过唯一共享 owner，应按主计划重新补审；本 PASS 不预先批准这种偏离。
