# Sol/high Spec 拆分一致性独立复审

审查对象：`05-SOL-EXECUTION.md`、`06-SPEC-INDEX.md` 与 `specs/S00.md` 至 `specs/S14D.md`，共 26 个文件。受审主计划 `01-PLAN.md`、`03-CONTRACTS-AND-GATES.md`、`04-EXECUTION-MATRIX.md` 保持已通过版本不变。

已按 `audits/SPEC-MANIFEST-v1.json` 逐文件复算 SHA256，**26/26 全部匹配**。本轮阅读全部 26 个文件，重点核对 S00、S05、S06A–D、S07、S08–S12、S14A/B；未重复全库源码调查，未运行代码、模型、安装或发布测试。

## Verdict

**REQUEST_CHANGES**

发现 1 项 P1：最终中文质量 A/B 的 baseline 臂没有可执行目标契约。它不是“尚未跑测试”的问题，而是即使所有 Spec 逐字完成，S14B 仍可能无法证明两臂分别运行了冻结旧实现和候选实现，或可能把同一候选代码的两次生成错误标成 baseline/candidate。

除此项外，C01–C07 的实现责任、三个 early gate、生产入口验收、schema lane 和共享文件接力均保持忠实；未发现第二项阻断或共享 owner 冲突。

## 阻断 finding

### SR1 — P1：S14B 未定义最终 baseline 臂的可运行代码/产物与双格式隔离，不能执行 C06 的同时间窗两臂对照

**对应计划要求**：

- C06 要求最终 3×3×两臂在同一时间窗交错运行、两臂各自维护独立依赖链；S00 的旧输出只能作历史参考，不能单独当最终因果对照（`03-CONTRACTS-AND-GATES.md:62-64`）。
- S14B 必须基于 S14A 的冻结候选执行两臂并机械聚合，不能改规则或生产代码（`specs/S14B.md:4`、`14`、`20-24`）。

**Spec 现状**：

- S00 只要求保存 baseline 的代码/模板/Skill/素材/模型参数**指纹**，并在合成副本上运行一次基线（`specs/S00.md:22-23`）；必交物只有 `baseline manifest`，没有要求交付可在 S14B 时实际启动的 baseline target、命令或冻结产物（`S00.md:46`）。
- S00 的 runner 要复用当前生产入口 driver（`S00.md:24`），但后续 S02–S13 会改 API/URI、物理目录、schema、生成 runtime 与角色/上下文结构。仅保留一个 SHA/fingerprint 不会自动让旧生产入口在最终时刻可运行。
- S14A 只冻结 candidate SHA/build（`specs/S14A.md:20`、`44`）。S14B 的命令只有当前工作树中的单一 `quality-modernization-run.mjs --protocol ...`，没有 baseline/candidate target 参数、两份可执行目标清单或目标代码哈希校验（`specs/S14B.md:31-34`）。
- S14B 说“准备两臂、独立前章谱系”（`S14B.md:20`），但没有规定 baseline 如何读取旧 `.vela` 数据、candidate 如何读取 `.ai-novel` 数据，以及如何证明两份 arm fixture 的作者动作、章节 brief、素材与 oracle 在语义上相同。

**具体反例**：

1. S14B 在 S14A 的候选工作树里调用 runner 两次，仅把输出目录标成 `baseline` 与 `candidate`。两次都走候选 `aiNovelAPI` 和新 ContextSnapshot；盲评结果形式完整，却没有基线臂。
2. S14B 改用 S00 当时保存的旧输出与当前候选对比。这违反 C06 的同时间窗要求，远端模型漂移无法与代码变化分离。
3. S14B 尝试启动 `731bda1`/S00 SHA，但把候选 `.ai-novel/project.db` fixture 直接给旧版；旧版只认 `.vela/vela.db`，baseline 缺章或失败。若临时人工转换，两臂素材/状态差异又没有 parity receipt，比较对象不再只有实现差异。
4. 为让旧目标跑起来，执行者在当前脏工作树切 checkout 或覆盖 runner/node_modules，违反通用合同的工作树保护（`05-SOL-EXECUTION.md:7`、`13`），也破坏交错运行所需的双目标隔离。

**为什么这是阻断而非普通实施细节**：

“baseline 是哪个可执行对象、怎样启动、怎样与 candidate 隔离、两种持久格式怎样由同一语义 fixture 构造”决定 A/B 的自变量与证据有效性，不能由 S14B 执行者临场自行选择。C06 已明确旧输出不能替代最终 baseline；当前 26 份 Spec 没有任何一份拥有并交付这个可运行目标。

**最小修正**：

1. 在 S00 必交物中增加版本化 `baseline-execution-manifest`（名称可调整），至少固定：
   - baseline 代码 SHA，以及其 runner/生产入口 driver SHA；
   - 可运行目标类型（例如已哈希的本地构建产物，或仓库 `.worktrees` 下由主线程准备的只读/独立 registered worktree；不得重新 clone、不得 checkout 覆盖当前工作树）；
   - Node/Electron/native ABI、启动命令、模型配置注入边界、独立 userData/project root、预期旧存储布局；
   - 如何从同一预注册语义素材构造 baseline arm fixture，及其作者输入/brief/顺序/oracle 哈希。
2. S14A 的冻结候选交付增加对称的 `candidate-execution-target`（candidate SHA/build/runner ABI/独立根）。任何修复改变 SHA 后旧 target 作废。
3. S00 的 `protocol.json`/runner 合同必须把 arm target 当显式输入并 fail closed：
   - baseline 与 candidate 分别校验目标代码/产物 SHA、入口类型和隔离根；
   - 两臂意外指向同一实现/目标时拒绝正式实验（除非显式标为非资格 placebo 诊断）；
   - arm-specific 旧/新物理 fixture 都从同一不可变语义源生成，输出 parity receipt，证明作者动作、章节范围、素材、模型参数与 oracle 等价；不要求两个磁盘格式字节相同；
   - help/dry-run 不调用模型，但验证两个 target 可启动、生产入口可达、数据根互不相交、协议场景可解析。
4. S14B 的正式命令/步骤显式消费两份 execution target 与 parity receipt，在同一 80 次总账内交错调度；每个请求 receipt 记录 arm 与 target SHA。任何 baseline target 不可运行、parity 不成立或误用同一 target 时只能 `blocked/inconclusive`，不能给 non-inferior/improved。

无需现在实现 runner 或运行模型；这里只需要把上述责任和拒绝条件写入对应 Spec，防止实施者临场发明实验基线。

**关闭条件**：

- 从修订后的 S00/S14A/S14B 文本可以唯一判定 baseline/candidate 各自运行哪个 SHA/产物、怎样启动和怎样隔离；不存在“同一当前 runner 自己决定 baseline 行为”的自由裁量。
- dry-run 的计划验收明确要求：两个 target 身份可验证且不同、生产入口可达、arm 数据根隔离、语义 fixture parity 成立、零模型调用。
- 正式 receipt 能逐请求追溯到 arm target SHA，并把 baseline 缺失/旧格式无法运行/目标相同判为不具资格。

## 已通过的一致性检查

以下项目无需因 SR1 重写：

- **C01/C02 → S05/S06A–D/S07**：S05 负责持久 root、reserve/dispatch/unknown、输入/输出/reasoning、CAS 最大前缀与 facade；S06 按结构化、正文/批量、审修、Agent 四族接入真实入口；S07 只接数值 policy/诊断并运行第一门，没有重建第二账本。S06D 还要求核销 S00 的全部生成消费者，未接入口会阻断 S07，而不是只测一个 store。
- **C03/C04 → S08–S10B**：角色 M02、proposal、连续性/导入、UI/Agent 分波串行；name-only 正式写 fail closed。S10A 先做纯来源契约，S10B 再接写/审/修材料生产入口，候选白名单、长设定容量冲突、剧情树/Skill 边界均未弱化。
- **C05 → S06C/S11**：S06C 仅归一运行并明确把语义闭环交给 S11；S11 同时拥有 ReviewCycle repository、命令、merge store/UI 与 M03，覆盖输出后/合并后 no-op、finding 锚点、逐项状态和一次复核，没有把原子提交冒充 resolved。
- **C07/S12**：M00→M04 顺序与 Spec DAG 一致；S12 在 M03/身份入口后收敛 import effect/cancel/lease，并先做字段等价表，未按代码量删除防护。
- **early gates**：S00 明确交付可复用 runner/protocol/80 次总账并要求走生产入口 driver；S07、S10B、S11 分别将对应中文门列为必交，`not-run/failed/inconclusive` 不能通过，S13 又显式复核三门。具体场景 ID 可由 S00 预注册，不必在当前静态 Spec 中预先伪造。
- **生产入口与最终确定性门**：通用合同要求每片“相关单测 + 受影响生产入口回归”；S14A 明确串 UI→IPC→main service→repository，并覆盖正文/两批量/规划/角色/审修/导入/Skill/模型设置/重启，不是只测纯 API。
- **共享所有权**：交叉文件均按依赖顺序接力（例如 S06C→S10B→S11 的审修命令，S06B→S07 的 AIOutputPanel，S00→S14B 的 runner）；中心 DB/registry/IPC/preload/main/package 区仍由唯一集成 owner 接线。未发现并发双 owner。

## 非阻断建议

- S14B 的盲评包由执行 owner 生成，而两名评审者/仲裁者不能由该 worker 自行再开子代理。实施调度时宜明确由主线程派发只读评审任务、在 verdict 固定前不揭示 arm；如果独立评审资源不可用，按 C06 报 inconclusive。现有 C06/S14B 已禁止单人自评，因此这不是本轮新增阻断。
- S07/S10B/S11 正式下发时应把 S00 生成的实际 early-stage selector/命令写入任务 prompt 和 receipt。当前 S00 已要求 runner 按协议选择 early/full，且各片未执行不计通过，故无需为未知的未来 CLI 参数回改所有 Spec。

## 复审入口

只需最小修订 S00、S14A、S14B 及必要的通用执行/索引引用，更新 manifest 后复审 SR1。无需重拆 24 片、重写 C01–C07、增加统计平台或运行任何模型测试。
