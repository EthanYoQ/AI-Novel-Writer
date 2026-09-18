# 写作质量、预算与恢复独立审计（Round 1）

审计对象：`01-PLAN.md` v1（2026-09-12）及事实附录 `02-BASELINE-AND-BOUNDARIES.md`。  
基线：`731bda1`，其代码树与 `origin/master@2264390` 相同。  
范围：写作质量、生成预算/恢复、上下文来源、角色身份、审稿闭环、质量实验和 Sol/high 可执行性。未运行模型、安装、发布或生产代码测试；未审计 DSH，也未重做全仓 Vela 扫描。

## Verdict

**REQUEST_CHANGES**

没有 P0。以下 6 项 P1 与 1 项影响 Spec 可实施性的 P2 尚未关闭。当前计划的方向大体正确，也明确保留了定稿、来源与人工确认边界；但仍允许“按文字实现却再次失控/污染/假通过”的路径。按计划第 7 节的门禁，当前版本不应拆发 Sol/high Spec。

## Findings

### Q1 — P1：父预算没有可持久识别的作者动作，也没有明确覆盖输入与推理用量

**计划位置**：`01-PLAN.md:73-83`、`01-PLAN.md:87-95`、`01-PLAN.md:163`。

**代码证据**：

- 当前 `GenerationHarnessPolicy` 只有次数、累计请求输出额度、单次请求输出额度和 deadline（`src/services/generation/generation-harness.ts:90-97`）；当前全局硬帽也只明确约束这些字段（同文件 `100-108`）。
- session 的 `attempts` 与 `cumulativeRequestedOutputTokens` 是进程内局部变量（同文件 `531-537`），发送前按 `maxOutputTokens` 累加（`576-593`、`650-651`）；receipt 虽可携带供应商 usage，但它不是现有预算扣账依据（`157`、`544`）。
- 章节写作当前另有 8 次、32768 累计请求输出 token、8192 单次上限（`src/services/workflows/commands/generate-draft.command.ts:231-233`）。因此“把 8K/4K 放开”和“持久父预算”必须同时定义新的计量与身份，不能只持久化现有计数器。

**具体反例**：

1. 用户启动 50 章大纲，已发送 6 个长输入请求；renderer 崩溃后从恢复入口重开。新 run 被当作“独立用户动作”，又获得完整额度。反复重启可绕过父额度，但每次实现都符合“一个 session 有上限”。
2. 一个 60k-token 输入因网络错误重发 10 次，每次只请求 1k 输出。若父预算只扣“requested output”，计划仍可宣称所有请求已记账，却没有限制最主要的输入消耗。
3. Agent 子任务、按钮重试和恢复入口对同一意图生成不同 runId；没有稳定 root action / idempotency identity 时，主进程无法判断应共享还是新建额度。

**最小修正**：

- 在 S01/S05 契约中定义由主进程创建并持久化的 `rootActionId`（或等价稳定身份）、入口幂等键和 lineage 规则；明确 renderer 重启、恢复、修复、拆批、Agent 子任务、用户显式“重新开始”分别如何归属，不能由调用方自报“新动作”获得新额度。
- 明确父预算的计量单位和至少三类账：输入、输出、可得的 reasoning/total usage。发送前以输入估计 + 最大输出 + 推理安全预留做原子 reserve；有可信 usage 后 reconcile；usage 缺失/网络未知按保守规则结算。保留静态次数、墙钟时间、单请求和父任务硬帽。
- 规定 `reserve -> send -> settle/unknown` 的事务/崩溃恢复语义，同一物理请求的 idempotency key 只能扣一次，但未知供应商结果不得释放为零。

**关闭条件**：

- 确定性测试覆盖 renderer 重启、恢复入口、Agent 子任务、重复点击、发送前取消、发送后断网、usage 缺失和超长输入；所有路径共享正确 root 账本，不能靠换 session 复位。
- receipt/ledger 能证明每个物理请求恰好一个 reservation 与终态，且输入密集型重试会触发父硬帽。
- S05/S07 Spec 明确同一张账本的 schema owner、迁移顺序和原子性，不留给各入口自行解释。

### Q2 — P1：流式持久化只有 offset，没有幂等块与单调提交协议，可能重复、回退或拼接错稿

**计划位置**：`01-PLAN.md:74-83`。

**代码证据**：

- 计划的 `ArtifactRef` 只有 `durable offset`，而“每 1 秒或 4 KiB 写一批”没有定义块身份、CAS 或并发 flush 顺序。
- 当前恢复候选只保存一个完整 `visibleText` 与 `sourceHash/contentHash`（`src/shared/recovery-candidate.ts:19-30`、`36-52`）；当前写稿是在失败后调用一次 `db:recovery-candidate-record`（`src/services/workflows/commands/generate-draft.command.ts:881-909`），并没有可直接沿用的分块协议。
- 当前 provider seam 的 `onChunk(chunk: string)` 也没有 sequence/offset 语义（`src/services/generation/generation-runtime.ts:25-35`、`190-207`）。不同 provider 可能给 delta，适配器重连也可能重放已见文本。

**具体反例**：

1. chunk A 已落盘；断线重试从 A 开始重放，恢复器仅按 durable offset 追加，得到 `A+A+B`。
2. 定时 flush F2（较长文本）先完成，较早启动的 F1 后完成并覆盖同一行，数据库从 8 KiB 回退到 4 KiB；UI 仍显示 8 KiB，重启后静默丢稿。
3. 续写尝试更换模型或 ContextSnapshot 后仍向同一 artifact 追加；source fingerprint 未明确包含模型租约、冻结作者指导和精确上下文快照，两个来源不同的半章被拼成一个候选。

**最小修正**：

- 在 S01/S05 定义一种小而明确的持久协议：可采用 append-only chunk（`artifactId + attemptId + monotonically increasing sequence + previous/content hash`），或带 `expectedRevision` 的单调全文 snapshot；两者都必须拒绝重复、跳号、较短回写和跨 attempt 拼接。
- 定义 provider 的 chunk 先由单一 owner 规范化成 canonical visible prefix，再持久化；不能让各 provider 的 delta/cumulative 差异穿透领域层。
- source fingerprint 的规范输入至少列出：项目/session epoch、本章 brief 与用户指导、所选草稿/定稿依赖及内容哈希、ContextSnapshot、模板字节、冻结 Skill、模型租约/策略和输出契约。变化后新建冲突候选，不向旧 artifact 追加。
- 正常结束、取消、DB 失败与进程崩溃均只能推进 durable revision；存储失败后停止新模型请求的规则保留。

**关闭条件**：

- 确定性故障注入覆盖重复 chunk、乱序 flush、进程在 commit 前/后崩溃、终态 flush 与定时 flush 竞争、重连重放、模型/模板/Skill/源稿变化。
- 重启后恢复内容等于“最大已确认 canonical prefix”，既不重复也不回退；旧 epoch 或不匹配 fingerprint 的写入被拒绝且候选仍可查看/复制。

### Q3 — P1：`前章候选` 的准入条件被泛化，可能让废弃或冲突候选自我繁殖成小说事实

**计划位置**：`01-PLAN.md:97-106`，尤其 `101`；关联 `01-PLAN.md:76-83`。

**代码/ADR 证据**：

- ADR0013/0017 要求连续性投影只源于定稿事实；候选可以作为写作衔接材料，但不能被升格为历史事实。
- 当前实现并不是从项目里随意取“最近候选”：`GenerateDraftCommand` 只接收调用者显式传入的 `selectedCandidateDrafts`（`src/services/workflows/commands/generate-draft.command.ts:241-244`、`599-627`）。批量草稿待审模式只把**本次批次已成功保存**的前章放入该集合（`src/services/workflows/batch-chapter-workflow.ts:210-232`），新草稿还记录候选依赖内容哈希（`generate-draft.command.ts:812-826`）。
- `chapter-materials.ts` 明确把它标成未定稿候选，并与定稿分开（`191-205`、`223-226`）。这些现有约束没有完整写入 S10 的准入契约。

**具体反例**：

第 5 章第一次生成让角色提前知道秘密，作者废弃该候选后又生成正确版本。共享上下文服务按“相关 + 最近”选中废弃版本作为第 6 章的前章候选；第 6 章继续引用该秘密，随后被定稿，错误便从未确认文本洗成了正式连续性事实。恢复冲突候选、审稿修订候选也有同样风险。

**最小修正**：

- 明确候选准入白名单：只能是作者显式选择的当前草稿，或同一冻结 batch lineage 中已成功持久化且未被替换的直接前驱；`partial`、recovery、source-conflict、discarded、stale、未选 revision 一律不得由“相关性”自动选入。
- ContextSnapshot 必须记录候选身份、状态、版本、内容哈希、选择理由和 lineage；它在提示词中仍标记为未定稿衔接文本，不进入连续性事实/角色事实/摘要真相。
- 候选被替换、废弃或源依赖变化时，下游未接受成果转冲突候选，不自动继续或定稿。

**关闭条件**：

- 场景测试覆盖同章多个候选、废弃恢复稿、冲突候选、跨 batch 候选、草稿待审 batch 的合法直接前驱和已定稿前驱。
- 证明非法候选不进入写稿/审稿/修稿上下文；合法 batch 前驱仍可保持章节连续，不以“只允许定稿”破坏草稿待审模式。

### Q4 — P1：稳定角色 ID 没有处理 name/alias 冲突与不可判定旧关联，迁移可能把事实接到错误人物

**计划位置**：`01-PLAN.md:108-115`。

**代码证据**：

- 当前表以 `characters.name` 为主键（`electron/database.ts:122-132`），领域 identity key 与蓝图同步也按名字索引（`src/shared/character-roster.ts:17`；`src/services/workflows/blueprint-character-sync.ts:172-185`、`201-209`）。
- 当前蓝图声明的 `newCharacterCandidates` 会被构造成候选并直接通过 `db:character-roster-commit` 写入角色名单（`blueprint-character-sync.ts:160-185`、`246-262`）。计划正确提出改为 proposal，但“逐条分配 ID 并保持旧关联”没有说明遇到歧义时怎样 fail closed。

**具体反例**：

1. 角色“张岚”曾改名“岚姐”，项目里后来确有另一人叫“岚姐”；旧关系 target、蓝图 `characters` 和正文提及只有字符串。把旧 key/别名自动映射到任一 ID 都会污染关系与知情状态。
2. 两个导入来源各有“队长”，其角色卡内容不同。稳定 ID 迁移不合并两人，但 name-only 蓝图关系仍可能被 first-match 接到其中一人。
3. 先交换两名角色显示名，再恢复旧候选；若候选只带 name，可能把旧人物提议晋升为另一 ID 的事实。

**最小修正**：

- 为 name/alias 映射定义 `resolved / ambiguous / unresolved` 三态。只有唯一、有可验证来源的旧关联可自动绑定；相似名、别名冲突、同显示名、跨来源冲突不得 first-match 或自动合并，保留原字符串与 source ref 作为待确认 proposal。
- 明确 alias 的作用域、冲突行为和历史显示快照；显示名重用必须合法但不能改变旧引用所指身份。
- cutover 后所有新关系、蓝图角色、连续性、review finding 和 Agent 工具写入都使用 `character_id`；只有兼容 importer 可接收 name-only，且输出 unresolved proposal 而非正式事实。
- 迁移与 proposal 确认必须是事务化、可重跑的 effect；取消确认不能留下半套 ID/name 引用。

**关闭条件**：

- fixture 覆盖改名、名字交换、同显示名、共享别名、称谓“队长”、相似名、两来源导入、旧关系自由文本和恢复候选；逐项证明无静默合并、无任意绑定、正文不被改写。
- Spec 给出 schema/外键迁移顺序、兼容读取边界、每个 name-only 生产消费者的退出测试，以及 proposal 的批量确认 UI/事务验收。

### Q5 — P1：ReviewCycle 缺少“合并后文本—finding”的稳定锚点，仍可把未修改意见标成 resolved

**计划位置**：`01-PLAN.md:117-125`。

**代码证据**：

- 当前完整性检查只拒绝明显过短的修稿（`src/services/workflows/commands/refinement-completeness.ts:3-39`），因此等长 no-op 或无关改动可以成为修订稿。
- 当前合并提交接受 `mergedText` 并原子写入（`src/stores/draft-store.ts:377-395`）；用户可以在 ThreeWayMerge 中对某个 hunk 保留原稿。原子成功证明文本已提交，不证明某条意见已处理。
- 当前人工确认项有 quote/stableFactKey/sourceChapter/goalId，但没有可靠的 source span/occurrence identity（`src/shared/human-confirmed-review.ts:16-25`）。相同句子出现两次时，quote 本身不足以定位。

**具体反例**：

作者选择修复“钥匙仍在甲手中”，模型只改了别处标点；三方合并又保留了含错误事实的原 hunk。自动复核看到整章语言更顺，输出“已解决”。如果 finding 只靠自由文本 key/quote，系统无法证明复核的是同一处证据，UI 又可能把已提交等同 resolved。

**最小修正**：

- Review finding 在冻结源稿上使用可验证锚点（source hash + 起止位置/occurrence + excerpt hash；无法唯一定位则状态为 unverified），finding key 由规范类别、稳定目标与证据身份派生，不能只由模型自由文本决定。
- 合并后先做确定性判定：若该证据对应文本/相关 hunk 未发生实质变化，所选项保持 unresolved，且不消耗自动复核调用；整稿 no-op 与“只改不可见格式”在**模型输出后和人工合并后**都检测。
- 模型复核必须绑定 `merged hash + finding set`，逐项返回新证据；解析/定位失败为 unresolved/unknown，不得 resolved。`author-waived` 只能来自作者显式动作，不能由模型或“保留原稿”推断。

**关闭条件**：

- 测试覆盖重复 quote、quote 被删除但事实换句保留、只改标点/空白、修改无关 hunk、作者保留原 hunk、部分合并、源稿变化、复核无证据/坏 JSON。
- UI/持久记录分别显示 `revision generated`、`merge committed`、`resolved/unresolved/author-waived/unknown`，任一存储或复核失败不产生绿色 resolved。

### Q6 — P1：质量实验判定规则可被主观聚合和后置执行假通过，且质量反馈发生得过晚

**计划位置**：`01-PLAN.md:135-149`、`01-PLAN.md:158-178`。

**具体反例**：

1. 某组 3 章中候选一章明显更好、两章节奏更差；审查者以“组内总体改善”判该组改善。另一组全平，第三组一章新增中等事实错但未被定义成“严重”。于是满足“至少两组不劣且出现改善”，尽管多数章节体验下降。
2. S00 的 baseline 未冻结可重放产物；数周后远端同名模型更新。S14 再跑 baseline/candidate，差异混入模型漂移，paired 标签并不能归因于实现。
3. 所有 S02-S13 完成后才在 S14 运行候选质量门。若 S10 的上下文选择降低文风、S11 的审稿引入机械化改写，50–90 人日后才发现，质量已不再是推进顺序上的首要门槛。

**最小修正**：

- S00 预注册并冻结 fixture、逐章事实 oracle、严重度定义、rubric、聚合方法、tie/non-inferiority 阈值、盲化与顺序随机化方法、评审者数量/分歧处理、允许缺失数据和 80 次总调用的停止规则。事件覆盖与事实错误按逐项可核验证据判定，开放文学维度不得用一个优秀样本抵消多个退步样本。
- 保存安全的 baseline 运行包：代码 SHA、模板/Skill/材料哈希、模型配置 revision/endpoint fingerprint、能力与采样参数、调用/usage receipts、匿名化输出哈希及可供盲评的正文。无法固定远端模型版本时明确“同时间窗对照、不可归因模型漂移”，不能声称纯代码因果改善。
- 将确定性来源/恢复门放进每个相关切片；在 S07、S10、S11 各自完成后运行对应的小型候选 smoke/盲评。完整 18 章仍可留在 S14，但质量 slice 未达到预设 stop/go 条件时不得继续 Vela 最终清理和大范围迁移集成。
- 明确 80 次包含 baseline、candidate、重试、修复、审稿和复核的全部物理请求；报告按意向分析保留首个合格运行，不能丢弃差结果后补跑。

**关闭条件**：

- 审计者仅看预注册表与盲评数据即可机械复算结论；任一章新增指定客观事实错误直接失败，文学非劣/改善的章节到场景聚合无自由裁量空洞。
- S00/S07/S10/S11/S14 Spec 都有各自质量证据与 stop/go；baseline 漂移、调用不足、评审分歧只能报告 inconclusive/failed，不能写“质量提升”。

### Q7 — P2（阻断 Spec 拆发）：S05/S06/S09/S10 的共享面仍过大，所有权与可独立验收边界不足

**计划位置**：`01-PLAN.md:133-154`。

**为何影响实施**：

计划已提醒 IPC/schema 冲突并限制并发，这是正确的；但 S06“各生成入口接入”、S09“全入口身份引用”、S10“共享上下文编译”仍同时跨 main process、DB migration、IPC types、renderer workflow、UI 与多个生产入口。若直接各分给一个 Sol/high，任务既不小也无法在其他 slice 未完成时独立验证；若拆给多个 Agent，又会竞争 `ipc-channels.ts`、database/repository 和共享 prompt contract。S05 在 Q1/Q2 的预算/恢复契约未定时先落持久 schema，也会造成返工。

**最小修正**：

- 正式 Spec 前补一张“共享契约/文件唯一 owner + 入口迁移 wave + 每 wave 兼容状态”矩阵。S01 owner 先落经过 Q1-Q5 修订的类型与迁移骨架；后续 Agent 只拥有明确入口适配器与测试，不并发改共享 schema/IPC。
- 至少把 S06 按可验证入口族拆开（结构化规划、章节正文/批量、审稿/修稿、Agent），把 S09 按存储迁移、蓝图/关系、连续性、Agent/UI 分 wave；每 wave 可在兼容 facade 下独立回归和回退。
- S10 先交付 source-selection/ContextSnapshot 的纯确定性 contract 与 fixtures，再逐入口接入；S14 分为确定性 E2E、真实模型质量、旧项目升级、三平台资格四份证据，不能用一个“完成”状态吞掉未测项。

**关闭条件**：

- 每份 Sol/high Spec 都有唯一 owner 文件、禁止触碰文件、输入契约、可独立执行命令/fixture、兼容/回退点、依赖 SHA 和不超过一个共享写入口。
- 集成者可按 wave 串行合并；任一入口未迁移时旧 facade 仍有明确状态，且最终消费者台账能证明退出而非靠字符串计数。

## 非阻断建议

- `ContextSnapshot` 的 token 估计记录 estimator 版本、编码单位和安全余量，offset 同时注明字符/UTF-8 字节口径，避免跨平台重放歧义。
- 对“只保存用户可见内容”补一句：隔离的结构化残片是否属于可恢复用户成果；若保存，应在 UI 可见并允许删除，不保存 reasoning/tool 隐藏内容。
- 真实模型报告把“产品质量结论”和“供应商当日可用性/模型漂移”分栏，避免将网络或供应商更新误写为产品回归。

## Round 1 复审入口

修订计划后，本审计者只需逐项核对 Q1-Q7 的“最小修正/关闭条件”是否进入主计划或有等价、可验证契约，并检查切片依赖/owner 是否同步。没有必要增加通用分布式调度、第二套事实库、全书自动抽取或统计显著性系统；本轮要求的是把现有正确护栏写成不可绕过的最小领域契约。
