# S05 renderer facade 消费覆盖

依赖：`86d4ab043acc111d2614449385e507ff9d6ecb38`。本文件只记录 S05 facade 切片，不替代 main 持久账本或真实 provider 证据。

## 新接缝

`createGenerationRuntime({runHandle}, transport)` 选择唯一 main owner 分支；显式 `createMainOwnedGenerationRuntime` 还公开 `read/cancel`。`installMainGenerationTransport` 由中央入口安装 typed IPC adapter，未安装拒绝，绝不回退旧模型 store。

`session.complete(task, {invocationNonce})` 仅传 handle、nonce、语义 task。main 创建根、attempt、reservation，校验完整冻结来源，计算 liability 并唯一发送；facade 不创建根/lease、不猜 fingerprint、不重试请求。重复 nonce 原样交 main 幂等层；本模块测试仅证明不改 nonce、不自动重试，不证明数据库幂等。

`onSnapshot` 接收同 epoch/运行的全文、attempt/artifact、textHash、revision/durableRevision。旧/重复快照不回退展示，冲突阻止后续执行。`onChunk` 在新分支明确拒绝，避免跨 attempt 原地拼接；S06 调用者须采用全文快照。`signal` 不承担第二个终态 owner：新分支要求显式 `runtime.cancel()`，已经 aborted 的请求不发送。`close()` 仅注销观察，不取消根、不释放未知预算。`readMainGenerationRun/listMainGenerationRuns` 为 F04 提供壳无关的只读入口。

## 生产消费者状态

| 现有文件/入口 | S05 状态 | S06 必需接线 |
| --- | --- | --- |
| `src/services/workflows/commands/base-command.ts` dependenciesFor/createRuntime | NOT MIGRATED | 外层动作先取得 main handle；各步骤和结构修复共享 root；传 nonce、全文 observer |
| `src/services/workflows/commands/generate-draft.command.ts` runtime dependencies | NOT MIGRATED | 正文/续写/恢复同 root；移除 catch-only 候选第二 writer；冻结全部来源 |
| `src/services/workflows/commands/directory.command.ts` runtime factory | NOT MIGRATED | 分批规划沿父 root，范围不变时不刷新预算 |
| `src/stores/agent-store.ts` runAgent runtime | NOT MIGRATED | Agent 和派生调用共享 main root；未授权子动作不能自行新建 |
| `src/components/editor/CodeMirrorEditor.tsx` AI 补写 | NOT MIGRATED | 作者动作 nonce、当前正文 fingerprint、候选 CAS 和 dirty 冲突 |
| `src/services/plot-tree-generator.ts` runtime factory | NOT MIGRATED | 绑定冻结项目来源和 main handle |
| `src/services/narrative-thread-candidate-generator.ts` runtime factory | NOT MIGRATED | 绑定冻结项目来源和 main handle |

旧 `createGenerationRuntime({budget,...})` 路径及 `createGenerationHarness` 保持兼容和原参数/输出校验，仍是 renderer 会话内预算，不能计作 C01/C02 全覆盖。主进程未接 typed transport 或业务入口未提供完整 fingerprint 时，此覆盖表不得标为 migrated。

## 验证边界

专属 owner 测试使用确定性 transport，不调用模型；覆盖无旧 provider 调用、关闭/取消分离、nonce 传递、缺接线拒绝、读取失败清订阅、portable nonReplayable、快照乱序/重复/旧 epoch/hash/非前缀/跨 attempt 拒绝。既有 runtime/harness 测试保留。真实 M01、并发 reserve、crash、usage、provider dispatch 与完整 IPC 接线由 main owner/中央集成测试证明。

复审补充：终态 artifact 的正文/hash/revision 均冻结；异步 hash 校验后再次检查 closed，关闭期间排队的快照不再回调 UI。两项均有确定性反例测试。

## Renderer typed IPC 接线

`main-generation-transport.ts` 已按 `generation-owner-contract.ts` 提供 typed execute/read/list/cancel、begin/pause/resume/restart/discard。`main.tsx` 只安装惰性 transport，不捕获会话、不发 IPC。所有 invoke 都携带调用前冻结的 ProjectSessionContext；已有 handle 绑定保持当时会话，项目切换后不借用另一项目新租约，最终是否失效由 main 拒绝。旧 epoch 历史可在当前同项目会话读取，但不能直接执行；resume/restart/discard 显式携带当前会话交 main 重新校验，resume 返回当前 epoch 的同 run/root handle。订阅按 projectId/epoch/rootActionId/runId 全匹配，close 仅退订。

MainGenerationRunView 可携带 main 实际 ledger（RootBudget、tokenLiability、physicalRequests、activeElapsedMs、blockedCode），F04 不必误用旧输出预算兼容字段。root 承诺事件仅为持久全文，最长约 1 秒 flush，revision=durableRevision；renderer 不自建持久定时器或伪造 durable ack。typed transport 会话/replay/外来事件与 facade、旧IPC会话测试 28/28 通过，typecheck/ESLint 通过；业务覆盖状态仍全部 NOT MIGRATED。


## 内置 Skill 单一数据来源与恢复接缝

`src/shared/builtin-writing-skills.ts` 是纯数据/纯 inspection 模块，registry 使用 `getBuiltinWritingSkills()`，main 可注入 `readBuiltinWritingSkill(name, language)`。7 项原始 literal 数组（规范换行）的移动前后 SHA256 均为 `cf8c2d38c090ba52afa7371e4f90bbd337e62ac0630b3d624b9aa7271dbd6f34`；metadata、原 shortened inspection 与 14 份语言正文未改变。getter 提供 inspection metadata frontmatter 与真实语言正文，不引入第二套提示词或 renderer 依赖。真实完整中文 review-chapter 被通用外部 Skill inspector 判定 tool-dependency；原 registry 的短 inspection 及产品兼容判定仍保留，不通过删正文绕过。

`resumeMainGeneration(currentSession, oldHandle)` 允许同项目历史 epoch 交 main 重新源码校验，成功回执必须当前 epoch、原 run/root。直接 execute 仍拒绝历史 epoch。view 的可选 candidates/unsavedTails 只承载 main 返回的历史指纹候选/内存尾巴，不混入 durable artifacts。
