# Novel Quality Program v3 独立质量审计（Round 2）

日期：2026-09-13

## 裁决

**FAIL / REQUEST_CHANGES**

Round 1 的 Q1、Q2 已关闭，Q3 的产品阈值与文字合同已补齐，但它的机器 receipt/checker 仍可漏测必需动作后假通过，因此尚未具备无歧义派发条件。

- P0：0
- P1：1（Q3 残余接口缺口）
- P2：0 个新增阻断；Round 1 的 WebDAV P2 已关闭

本裁决仍只针对计划/合同可执行性。未运行生产代码、模型、Electron、正式中文 IME、归档或 WebDAV 产品测试；已记录的 9 个负例运行结果仅是冻结包提供的合同形状证据，不冒充产品通过。

## 冻结与 delta 完整性

- `audits/MANIFEST-v3-round-2.json` 的 28 个文件已逐项重算：**28/28 SHA-256 一致**。
- 相对 Round 1 manifest，变更为 13 个既有文件及新增 2 个 checker 文件；本轮只核这些变更和接口，没有重开已通过的头像、Writer 功能并集、默认时序、Issue、18 章/80 调用帽或旧 Spec 全量审计。
- 首审报告仅将误写的三个文件名更正为本包实际文件名：`01-MASTER-PLAN.md`、`02-FRONTEND-DECISION.md`、`05-INTEGRATION-CONTRACT.md`；原发现、严重度和日期未改。

## Round 1 逐项关闭判断

### Q1 — CLOSED：C16 已具备提交时 CAS、权威来源复核与派生来源单调序

**证据**

- `05-INTEGRATION-CONTRACT.md:79-89` 要求 patch 携带 `baseFieldRevision/baseValueHash/baseProvenance`，在同一 DB 事务提交时重读当前字段、项目 epoch 与权威定稿 source；任一变化拒绝旧 patch。
- 同一 `continuityEpoch` 内以 `(chapterNumber, authoritativeFinalizationRevision)` 排序：较早章迟到/重试不得覆盖较后章；同章只接受当前权威版本；author 并发编辑优先。
- `04-EXECUTION-MATRIX.md:23,51` 把实现责任固定给 S09B，限定复用现有 outbox/提取和事务，不建第二队列；`06-SPEC-INDEX.md:5` 明确派发旧 S09B 时必须同时附本包 C16 覆盖合同。
- `05-INTEGRATION-CONTRACT.md:89` 明列首审三个并发反例：提取后作者编辑、N+1 先写而 N 迟到、同章重定稿旧回包。

**反推结果**

- 作者在提取与提交间编辑会改变字段 revision/value/provenance，CAS 拒绝旧 patch。
- 第 4 章 derived 已写后第 3 章任务迟到，规范来源序较旧，不能覆盖。
- 同章旧 finalization 回包无法通过当前权威 source 与 revision 复核。

Round 1 Q1 的最小关闭条件已满足。实现与产品测试仍为 NOT RUN，不在本轮宣称代码完成。

### Q2 — CLOSED：功能并集已改为 153 个逐 action 合同，U16 所有权拆分正确

**证据**

- `feature-union.json:10-20` 定义逐 action 执行证据字段；153 个 action 均有稳定 `actionId`、`owner/uiOwner/qualificationOwner`、`requiredInWriter=true`、独立 evidence 与 `status=not-run`。
- `feature-union.json:3723-4029` 的 U16 将本地归档/恢复/失败保护/连续性承接交 B01，将 WebDAV 配置、凭据、上传、列出、下载、分叉和持久绑定交 B02；F04/F05 分别负责 UI 与资格。
- `feature-union.json:4048` 禁止独立手写组状态；`checks/feature-union-check.mjs:1-39` 从全部必需 action 派生组状态，拒绝组级 evidence/status、重复 ID、未知 owner、Classic 证据、错误 SHA、缺 evidence level 和重复 receipt step。
- `specs/F05.md:5` 明确每个 required action 只能由 Writer 生产入口取证，Classic/API 不代填；`04-EXECUTION-MATRIX.md:53-56` 与 B01/B02/F04/F05 文件责任一致。
- `checks/feature-union-check.test.mjs` 的负例范围覆盖首审要求；其注释和 `07-PACKAGE-CHECKS.md:13,17-19` 正确限定为合同形状，不冒充产品 PASS。

Round 1 Q2 已关闭。当前所有动作仍是 `not-run`，这是正确的规划状态。

### Q3 — PARTIALLY CLOSED / P1：文字门已补齐，但机器 receipt 仍能漏掉“选择响应”和 7 样本/MAD

**位置**

- `feature-union.json:4049-4064`
- `checks/feature-union-check.mjs:41-54`
- `checks/feature-union-check.test.mjs:24-32`
- `specs/F05.md:18`

**已关闭部分**

- `editor-absolute-v1` 在候选结果前冻结 3000/200000 中文单位、production CodeMirror、Writer 实时预览开启、median ≤ 50 ms、最坏有效样本 ≤ 100 ms、主线程长任务 ≤ 50 ms，并保留 Writer 相对 Classic 中位数恶化不超过 20%。
- F05 还要求真实 Windows 中文 IME 最终正文/选区精确一致、零丢字零重复；两壳同慢、IME 损坏、关闭预览三个负例均明文拒绝。

**仍可假通过的具体反例**

协议文本写的是“3 warmups + 7 valid samples per shell/action”，F05 同时要求“输入/选择响应”达标并保存原样本、median/MAD。但 `checkEditorReceipt()` 的实际接口只有：

`receipt.samples[units][shell] = { medianMs, worstMs, longTaskMs }`

它没有 action 维度、没有 7 个原始样本，也不接收/计算 MAD；稳定性只相信调用方给出的 `receipt.unstable` 布尔值。因此执行者可以只测一次或只测键盘输入，完全不测拖选/选区响应，自报合格 summary 和 `unstable=false`，仍获机器 PASS。现有 9 个负例没有覆盖“缺选择动作”“缺 7 个原样本”“自报稳定但原样本 MAD 超限”。这与“唯一机读协议”及 F05 的逐动作绝对门相冲突。

**为什么阻断**

这不是要求再造 benchmark 平台，而是冻结协议与其唯一 checker 的 ABI 不一致。Sol/high 若按 checker 实施，会在没有完成计划明文要求的情况下得到合法 PASS receipt，Q3 原“两个壳都慢/写作输入不可用仍通过”的假通过风险只被部分消除。

**最小修订**

- 在 `editorProtocol` 固定待计时动作，例如 `actions: [input, selection]`；receipt 以 `units → shell → action → rawSamples[7]` 表达，不能用一个 summary 代替两个动作。
- checker 验证每个长度、壳、动作恰有 7 个有限有效样本，并从原样本自行计算 median、worst、MAD/median；不得信任调用方自报 `unstable` 或 summary。
- relative 20% 也逐 action 比较；保留现有 production/live-preview/IME exact 门。
- 增加三个合同负例：缺 selection；不足 7 个 raw samples；原样本 `MAD/median > 10%` 却自报稳定。仍复用同一小 checker，无需新增平台或模型调用。

**关闭条件**

上述 schema、checker、F05 三者使用同一动作和原样本结构，三个新负例均被拒绝；现有绝对/相对/IME 负例保持通过。产品实测仍留到实施资格，不要求在计划审计时运行。

## Round 1 P2 与其余 delta

### N1 — CLOSED：不可变 generation 已成为唯一真相

- `05-INTEGRATION-CONTRACT.md:113-121` 与 `specs/B02.md:3-7` 明确 generation 不覆盖、完成描述符校验、列表/恢复不依赖 `latest`；`latest` 仅为支持安全条件写时的可选 hint。
- 持久 parent binding、同父分叉、恢复副本 `origin-readonly` 与重启语义避免 fresh latest 偷换已认可基准；B02 为本机 binding 唯一 writer，未与 B01 归档解释权冲突。

该修改关闭 Round 1 P2，且没有扩成实时同步、通用版本 DAG、远端 GC 或新云平台。

### 其他 delta — 未发现新增阻断

- B01 对可携带当前连续性与冻结旧执行权限作了区分；敏感混合 receipt 不携原值或对排除字节的 digest/MAC，transfer receipt 不复活模型/outbox/候选授权。
- F03 的 `m05-integrated` 已成为 B01 的明确 required gate，`dag.json:173-195`、`04-EXECUTION-MATRIX.md:65` 与 `specs/F03.md:14` 一致，避免头像迁移在归档之后才接线。
- WebDAV 根内 href、跨 origin/降级 redirect、XML/大小边界以及两个隔离 profile 的持久绑定/分叉场景均有责任和验证落点。
- 头像 MUST、Writer 自身完整入口与默认时序、实质 Issue 关闭、18 章/80 次总帽、双目标/同 integration SHA/subjectSha 冻结均未被本轮修改弱化。

## 最终关闭门

下一轮只需修复 Q3 的 receipt/checker ABI 并用新增三个合同负例证明拒绝；无需重开 Q1、Q2、WebDAV P2 或全包范围。修订后重新冻结 manifest，再作一次有界 delta 复审即可。
