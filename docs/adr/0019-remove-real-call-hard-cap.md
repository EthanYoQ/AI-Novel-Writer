# 移除真实模型调用硬上限

2026-09-18 由用户决定：**移除真实模型调用的硬上限**，账本记账不变。

## 背景

Program v3 把「同一实验的总物理请求帽 80 次」写进了受审规划
（`docs/plans/novel-quality-modernization/03-CONTRACTS-AND-GATES.md`，契约 C06 ），
并在 runner 里以 `export const CAP = 80` 强制：超出即 `fail('PHYSICAL_CALL_CAP_EXHAUSTED')`。
该约束的原文明确写着「不够则缩小可声明结论、报告未完成，**不擅自扩帽**」。

用户要求移除这个上限，以便在不被人工天花板阻断的情况下推进真实调用（当前余额 80 次，实际用了 0 次）。

## 决定

1. 全局硬上限移除：runner 不再因调用次数拒绝请求，`updateLedger` 返回 `cap: null`。
2. 80 降级为**计划分配额**（协议字段 `physicalCallCap` → `plannedCallAllocation`），
   只用于协议一致性校验与汇报，不再具有拒绝力。
3. **逐条记账不变且更重要**：每一次真实发送（含失败、unknown、重试）仍必须进入同一账本
   `physical-ledger.jsonl`，锁、fsync、残缺记录拒绝等机制全部保留。
   移除的是「拒绝」，不是「记录」。
4. 分阶段的 `allocation`（early三门 4+2+6 等）**保留**：它是实验设计的样本量，不是上限。
5. campaign id 从 `novel-quality-program-v3-80-v1` 改为 `novel-quality-program-v3-uncapped-v1`，
   避免与 80 帽时期的收据混为一谈。

## 没有做什么

**未改写受审规划字节。** `docs/plans/**` 本次 diff 为 0。该目录是两名独立审计者复核过哈希的证据，
改写它会切断审计链。取代关系记录在本 ADR 与 `docs/research/novel-quality-modernization/quality-protocol.md`，
而不写进受审文件。

## 后果

- **好**：真实调用不再被人工天花板阻断；计划分配额仍作为设计意图保留并可校验。
- **风险**：没有自动拒绝机制后，失控的重试循环不再有硬性刹车。缓解：账本仍逐条记录，
  每次运行前后可读占用数；`blocked/inconclusive` 仍是**结论口径**——即不会因为「花超了」就
  把结论算成通过，只是不再阻止继续调用。
- **可追溯性**：任何引用 80 帽的旧收据都与新 campaign id 分离，不会被误当作同一 campaign。
