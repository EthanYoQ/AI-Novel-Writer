# 写作质量拆分复审 Round 3（ER1）

审计日期：2026-09-12  
审计范围：仅复审 ER1 及 `SPEC-MANIFEST-v3.json` 相对 v2 变更的 5 个文件：`05-SOL-EXECUTION.md`、`06-SPEC-INDEX.md`、`S07.md`、`S10B.md`、`S11.md`。不重开已关闭的 SR1、MSR-01 或其他 Spec，不代表代码、模型实验或发布资格已执行。  
完整性：按 v3 manifest 重新计算 26 个受审文件 SHA256，26/26 一致。

## Verdict：PASS

ER1 已关闭；这 5 份修订没有引入新的阻断性矛盾。当前拆分已把三个 early gate 从“依赖 S00 隐含完成”改成各门 owner 可直接执行、可失败关闭、可独立交付收据的责任。

## ER1 关闭证据

1. **责任已经下沉到可派发切片。** 通用合同明确 S07、S10B、S11 各自负责消费 S00 的 runner/protocol/可执行 baseline，取得当前已合入切片对应的 candidate manifest，执行固定 selector，并把命令、双 manifests、dry-run/parity 和逐请求 receipts 作为各自必交物（`05-SOL-EXECUTION.md:57-63`）。索引也同步把该要求写入早期门总览（`06-SPEC-INDEX.md:50`）。
2. **三片都有实际执行入口，而非仅引用 S00。** S07、S10B、S11 分别给出 `early-budget`、`early-context`、`early-review` 的显式 `--targets`、`--phase`、零模型 `--dry-run` 和正式两臂命令（`S07.md:32-38`；`S10B.md:32-38`；`S11.md:32-39`）。因此 worker 不需要从另一片猜 phase 或补命令。
3. **目标真实性和 fixture parity 均为 fail-closed。** 三片都要求可运行 baseline、当前切片 candidate、生产入口、隔离根、同语义 fixture parity，并明确单臂、同目标、历史输出或缺 receipt 不得 PASS（`S07.md:23-24`；`S10B.md:23-24`；`S11.md:23-24`）。这关闭了“同一实现贴两个 arm 标签”及“只有 API smoke 也过门”的反例。
4. **收据足以追溯实际执行臂。** 通用合同要求每次请求绑定 arm、实际 target code/artifact/driver SHA、parity ID 与该门 candidate SHA（`05-SOL-EXECUTION.md:61`）；三片交付条款分别再次要求逐请求 arm/target/driver SHA（`S07.md:44`；`S10B.md:44`；`S11.md:45`）。调用方标签不再是唯一身份依据。
5. **预算与 SHA 资格边界保持一致。** 三门真实调用继续进入 C06 的同一 80 次物理请求帽，不创建 early 旁路预算；不足只能 not-run/blocked/inconclusive（`05-SOL-EXECUTION.md:63`）。early 结果只覆盖各门当时 SHA，不能替代 S14A 最终 `subjectSha` 或 S14B 完整质量结论；三片交付条款与索引均保持这一边界。

## 新增约束交叉检查

- `early-budget` / `early-context` / `early-review` 在通用合同、各自 Spec 和索引中一一对应；由 S00 按共同合同写入 protocol，不形成未分配的 protocol owner。
- S00 仍拥有共享 runner/protocol/baseline；三个 early owner 只拥有各自临时候选清单、执行与 receipts；candidate manifest 由主集成者基于已合入切片生成，未制造共享源码所有权竞争。
- 三片使用同一 `scripts/quality-modernization-run.mjs` 实验入口。Spec 中“目标代码/产物/driver 身份不同”按通用合同解释为**两个 execution target 的实际身份必须不同，同时逐臂记录 driver SHA**，不要求为了制造差异而改写共同实验 runner；这一解释与显式相同 CLI 及 fixture parity 控制相容。
- 零模型 dry-run 不消耗模型调用，正式 early 请求进入现有 80 次总账；未发现重复计费或把 80 次扩成每门各 80 次的措辞。

## 关闭条件结论

ER1 的规划关闭条件已满足：三个 early gate 均有直接 owner、可运行双目标输入、固定 phase、零模型真实性/parity 探针、同时间窗两臂执行、逐请求身份收据和 fail-closed 判定。后续是否真实 PASS 必须由实施产物与实际执行证明，本次 PASS 仅表示 Spec 包已具备实施条件。
