# S06D 定稿后处理持久恢复

实施基线为 `7a4093381a04327cee3919a9dd9df6ddf5987bfa`，对应现有 Draft PR #230。此片只覆盖定稿后处理；剧情树、叙事候选和旧角色修复仍阻断 S06D/S07。原冻结 Plan/Spec 不变，未合并、发布或关单。

## 实际行为

- notes 与 characters 以原 finalization source、draft ID 和步骤键定位持久运行。主进程读取实际正文、冻结身份、字段基线、语言和模板，生成任务不由 renderer 构造。第二步沿用原 root/model；显式 batch parent 需要真实已提交正文凭据。
- 章节要点、连续性事实、蓝图 notes 与完整回执在同一 SQLite 事务写入。角色状态继续使用逐字段 CAS，作者保护字段只产生候选；未知身份继续需要明确批准。
- 回执保存在原 generation attempt 的现有 usage JSON。重复提交和重开后的回读验证原 artifact、attempt、冻结上下文及提议凭据，不重新应用字段，也不依赖后来默认模型。原 epoch 的冻结字段基线保持不变；恢复执行资格单独校验。
- 字符 JSON/schema 无效时最多在同 run 修复三次，保留全部原候选并共用预算。未知发送、length、取消或丢弃候选不触发这种修复；已完成且有效的请求只回读缓存。
- 已保存 effect 封存新的执行、重组、丢弃、恢复和重启修改；同 root 的后续合法步骤不因此被封存。原 finalization outbox、正文发布与 KB 后处理流程保持各自的职责。
- generic generation 的旧定稿新建/执行入口，以及 renderer 的三个直接派生写入接口已拒绝新写，避免绕过专属来源与回执。main 内部仓库仍可用于原子事务。旧 S09B 没有 effect 的历史字段写入不会被补造为原始 ACK。

## 验证记录

私有日志与收据位于任务 `.runtime/.cache/novel-quality-modernization/`，不进入 Git；下列计数有重叠，不相加。

| 检查 | 实际证据 |
|---|---|
| 主进程实际 file SQLite | `s06d-finalization-repair-receipt.json`：15 场景通过，覆盖事务回滚、原 ACK、两阶段、修复封顶、取消和旧 epoch |
| 原字段与身份回归 | `s09b-dedicated-migration-receipt.json`：12 场景迁到专属入口，保留来源、作者字段、provenance、回滚与提议批准断言 |
| Renderer 与真实 owner 集成 | `s06d-finalization-renderer-hashes.json`：六文件冻结；5 套 87 项通过，包括实际 SQLite 集成 15 项与 adapter 9 项 |
| 主集成者独立复跑 | `s06d-finalization-root-consumer-final.log`：6 套 108 项通过；最后封口后 `s06d-finalization-sealed-root-final.log`：6 套 92 项通过，含实际注册 IPC 原套件 22 项 |
| 稳定角色提议证明 | `finalized-proposal-proof-freeze.json` 与后续历史 fixture 增量：原上下文 epoch、当前写授权和稳定 proposal 身份分别验证 |

独立 IPC 审查已暴露并修复四类问题：旧 generic 定稿旁路、旧直接派生写入旁路、回执引用的提议缺失、修复回执错误关联旧 artifact。最后 22 项实际注册 IPC / file SQLite 独立探针全部通过，日志为 `finalization-main-independent-final.log`；其中包括三条旧写入逐条零写拒绝、实际 batch 原 root/model、存储失败回滚和作者字段保护。首次创建 owner 的中断恢复 bookkeeping 与后续纯 ACK 零写测量分开。

## 资格边界

所有 dispatch/SSE 为合成响应；真实模型调用仍为 0/80。这些结果不是实际 Electron 安装、Writer 全动作、中文 IME、portable/WebDAV、三平台发布或文学质量验收。

基线提交的 Windows CI [34740164318](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/34740164318) 仍失败：341 套通过，4 个测试超时，以及 vector worker 在 copy-enter 后以 `0xC0000409` 退出。三个超时相关套件本地 30/30 通过；它们共享 canonical fixture 建库步骤，但根因尚未确认。未通过扩大 timeout 或屏蔽用例宣称修复。
