# Novel Quality Program v3 独立质量审计（Round 3）

日期：2026-09-13

## 裁决

**PASS**

Program v3 Round 3 已关闭 Round 2 唯一剩余的 Q3 ABI 阻断，现具备派发实施条件。

此 PASS 仅代表冻结计划、机器合同与 Spec 接口一致；不表示生产代码、真实 Windows 中文 IME、Electron、模型、归档、WebDAV、安装包或发布已经测试/通过。

- P0：0
- P1：0
- P2：0 个新增项

## 冻结与 delta 完整性

- 已按 `audits/MANIFEST-v3-round-3.json` 逐项重算 28 个文件：**28/28 SHA-256 一致**。
- 与 Round 2 manifest 比较，只有以下 4 个文件变更，符合提交说明：
  - `feature-union.json`
  - `specs/F05.md`
  - `checks/feature-union-check.mjs`
  - `checks/feature-union-check.test.mjs`
- 其余 24 个受审文件 hash 未变；本轮没有重开已关闭的 Q1、Q2、WebDAV P2 或其他既定范围。

## Q3 关闭证据

### 1. 机读协议已经逐动作、逐原样本表达

- `feature-union.json:4049-4067` 将动作固定为 `input` 与 `selection`，并冻结 `warmupCount=3`、`sampleCount=7`、`maxMadToMedian=0.1`、`maxRerunIndex=1`。
- receipt 形状明确为 `samples[units][shell][action]`，每格包含 `warmupSamplesMs[3]`、`rawSamplesMs[7]`、`longTasksMs[]`；不再用一个汇总值冒充两个动作。
- 原有 production CodeMirror、Writer 实时预览开启、3000/200000 中文单位、median ≤ 50 ms、最坏有效样本 ≤ 100 ms、长任务 ≤ 50 ms、Writer 相对 Classic 不恶化超过 20% 与精确 IME 门均保留。

### 2. Checker 从原始样本计算，不信任自报 summary/unstable

- `checks/feature-union-check.mjs:41-61` 对每个 `units × shell × action` 强制检查动作存在、3 个 warmup、7 个原始有效样本以及 long-task 数组。
- checker 自行计算 median、worst、MAD 与 MAD/median，并逐动作执行绝对门和相对 20% 门；调用者自报的 summary 或 `unstable` 不参与通过判定。
- `rerunIndex` 只允许 0 或 1；超出一次重跑直接拒绝。IME 正文、选区、undo 精确一致与零丢字/零重复仍是独立强门。

### 3. Round 2 反例均被机器接口覆盖

- `checks/feature-union-check.test.mjs:40-45` 覆盖：缺少 selection、只有 6 个 raw samples、高 MAD 但自报稳定、selection 相对回归、少 warmup、长任务超限。
- 原“两壳同慢”“IME 丢字”“关闭 Writer 实时预览”负例仍保留；合计 15 个合同负例。
- `specs/F05.md:18` 与 JSON/checker 使用相同的动作、原样本、MAD、重跑和阈值定义，并明确不能丢弃慢样本求稳定。

因此 Round 2 的具体假通过路径——只测输入不测选择、无 7 个原样本、自报稳定绕过高 MAD——均已关闭。

## 保留边界复核

本轮四文件变更未弱化以下已通过边界：

- 头像仍为完整 MUST，不能删除、隐藏或只迁移不接 Writer。
- Writer 仍须独立覆盖旧能力与 donor 实际能力并集，Classic 不能补缺；默认激活与同 SHA 资格时序未变。
- 153 个 required action 的逐 action owner/evidence/status、U16 的 B01/B02 分工及组状态派生未变。
- C16 的字段级提交时 CAS、权威 source 复核与派生来源单调序未变。
- 18 章、80 次真实模型调用总帽、双目标、post-UI 同 integration SHA 与 subjectSha 冻结未变；本次 checker 增强不增加模型调用。
- 不可变 WebDAV generation 仍为真相、`latest` 仍是可选 hint，未扩成实时同步或新云平台。

## 实施提示（非新门）

派发时应保留 checker 顶部已有免责声明：合同形状 PASS 不能证明外部 receipt 真实。真实 production editor、Windows IME 和 Writer 实时预览仍须在 F05/最终资格阶段按冻结协议取证；当前全部产品证据仍是 NOT RUN。
