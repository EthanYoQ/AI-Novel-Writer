# 迁移 / Spec 拆分审计：v3 delta

## Verdict

**PASS**

本结论仅表示 `SPEC-MANIFEST-v3.json` 相对已通过的 v2 拆分没有破坏冻结、迁移、schema lane 或共享所有权契约，并且 early gate 的双目标责任已具备可执行归属。它不表示实现、迁移、模型实验、平台测试或发布已经通过；本轮按约束未运行这些活动。

## 受审边界与完整性

- 以 `audits/SPEC-MANIFEST-v3.json` 为边界重新计算 26 个受审文件 SHA-256，结果为 **26/26 匹配**。
- 与 `SPEC-MANIFEST-v2.json` 逐项比较，变化严格限于 `05-SOL-EXECUTION.md`、`06-SPEC-INDEX.md`、`specs/S07.md`、`specs/S10B.md`、`specs/S11.md` 五个文件。
- `01-PLAN.md`、`03-CONTRACTS-AND-GATES.md`、`04-EXECUTION-MATRIX.md` 哈希保持已审值；S00–S05、S08、S12–S14D 等迁移、schema 与最终资格 Spec 未变。因此本轮不重新宣称全库或全部 Spec 已审，只裁决这五个 delta 对既有 PASS 的影响。

## Delta 裁决

### 1. 最终冻结链未被 early 证据旁路

`05` 仍要求所有 tracked runner/protocol/smoke/release workflow 适配先合入并验证，再由 S14A 冻结唯一 `subjectSha`；S14B/C/D 仍只读冻结 subject，任何 tracked 改动都必须退回 owner 并重新冻结，旧证据不自动继承。新增规则又明确 early 结果只覆盖各门当时的 candidate SHA，不等于最终 `subjectSha`，也不替代 S14B 完整质量结论。

可失败反例已被合同排除：S07 在 SHA-A 通过后，S10B 或 S11 的实现使候选变为 SHA-B，不能拿 SHA-A 的 early receipt 证明 SHA-B 或最终冻结 SHA 合格。

### 2. early 双目标责任已落到直接执行 Spec

`05` 与 `06` 将 `early-budget`、`early-context`、`early-review` 分别归给 S07、S10B、S11。三份 Spec 均要求：消费 S00 的可执行 baseline/runner/protocol；使用主集成者为当前已合入切片生成的 candidate execution manifest；先做零模型双目标 dry-run，再在同一时间窗执行两臂；交付 targets、parity、dry-run 与逐请求 arm-target receipt。

可失败反例已被明确判负：只有 candidate 单臂 smoke、把同一程序启动两次贴成 A/B、复用 S00 历史输出、baseline 不可启动，或 receipt 缺实际 code/artifact/driver SHA 与 parity ID，均不得标 early PASS。

### 3. 共享所有权与 schema lane 没有被扩张

- S00 仍拥有质量 runner/protocol 与三个 phase selector；S07/S10B/S11 是消费者和各自 early gate 的执行/证据 owner，没有取得共享 runner 的修改所有权。
- 临时 candidate execution manifest 由主集成者针对“当前已合入切片”提供，三片负责组成自己的双目标清单；这没有把 shared wiring 或 release workflow 的 tracked 所有权转移给它们。
- S11 仍处于 C07 的 M03 位置；v3 未改变矩阵中的 `M00 S04 → M01 S05 → M02 S08 → M03 S11 → M04 S12` 独占序列，也未修改迁移资产、旧版隔离、新 ID 副本、C08/C09 或 S14 契约。

### 4. 调用预算没有被三个 early gate 各自重置

`05`、`06` 和三份执行 Spec 均写明所有真实调用共同计入 C06 的**同一 80 次总帽**；复核与失败调用也计入，不足只能记为 `not-run` / `blocked` / `inconclusive`，不能扩帽或以单臂结果补位。因此新增的三组两臂责任没有制造 3×80 的隐含预算。

## 阻断项与关闭条件

本轮未发现新增 P0、P1 或实施阻断 P2；上一轮冻结链阻断未复发。v3 delta 可在既定边界内进入后续实施。

实施期的通过仍须由各 Spec 产出其约定的双目标 manifest、零模型 dry-run/parity、逐请求 receipt 和预算账本，并由 S14A 重新冻结最终 `subjectSha`；这些是未来验收条件，不是本次静态审计已获得的运行证据。
