# Sol/high Spec 拆分一致性复审（Round 2）

复审对象：`audits/SPEC-MANIFEST-v2.json` 所列 26 个文件。已逐文件复算 SHA256，**26/26 全部匹配**。本轮仅复审 SR1 的关闭情况及新增 MSR-01/双目标约束是否引入阻断；未运行模型、代码、安装或发布测试。

## Verdict

**REQUEST_CHANGES**

SR1 对**最终 S14B** 已关闭，MSR-01 没有引入冻结后改 subject 的漏洞；但新增“双目标也用于 S07/S10B/S11 early gate”的责任只写在上游 S00，未进入这些实际 gate owner 的 Spec 或所有执行者必读的通用合同。按当前派发模板，三个 early gate 仍可在没有 candidate execution manifest、双目标 dry-run 或 arm-target receipt 的情况下被标为完成。这是 1 项影响质量门有效性的 P1，需最小补齐后再 PASS。

## SR1 复审

### 最终 S14B：CLOSED

先前要求的关键点均已成为可执行、fail-closed 的合同：

- 通用合同要求保存可再次启动的 baseline target；优先复用已注册工作树，否则只在 owner 仓库 `.worktrees` 准备独立冻结工作树/哈希构建产物，不 clone、不覆盖当前工作树。manifest 固定代码/产物/driver SHA、ABI、启动命令、入口、隔离根、旧布局和安全模型注入（`05-SOL-EXECUTION.md:43-45`）。
- `execution-targets.json` 必须含两份 manifest；dry-run 零模型调用但实际启动两目标、校验生产入口、真实路径/哈希、不同实现、根隔离和真实用户目录零消费。相同目标只能作非资格 placebo（`05:49`）。
- 旧/新物理 fixture 从同一语义源构造，parity receipt 覆盖作者动作、章节范围/顺序、brief/素材、模板/Skill、模型参数和 oracle；每个正式请求绑定 arm、target/driver SHA、subjectSha 与 parity ID（`05:51`）。
- S00 明确交付可运行 baseline manifest，且正确处理“S00 尚无 candidate”的依赖循环：本片只做 baseline 启动探针和合成 manifest 拒绝测试，不拿 baseline 两个副本冒充双臂（`specs/S00.md:25-26`、`48`）。
- S14A 在所有 tracked runner/protocol/smoke 适配完成后，交付对称 candidate target，完成真实双目标 dry-run/parity，才冻结 subjectSha（`specs/S14A.md:20-23`、`44`）。
- S14B 显式读取两份 target 与 parity，不信 arm 标签；命令包含 `--targets`，每个请求绑定实际目标，baseline 不可运行、目标相同、parity 失败或 subject 变化只能 blocked/inconclusive（`specs/S14B.md:20-24`、`32-35`、`40`）。
- 盲评者与仲裁者由主线程派发，S14B worker 不再开子代理，揭盲边界也已明确（`S14B.md:24`）。

这已经排除“同一候选程序跑两次贴不同标签”“用 S00 历史输出替代同时间窗 baseline”和“旧新磁盘格式输入不等价”的首轮反例。

## 新阻断 finding

### ER1 — P1：早期质量门没有接收新增的 candidate target / 双目标 dry-run 责任

**冲突位置**：

- S00 新增文字说：“真实双目标 dry-run 留给有对应候选的 S07/S10B/S11 与最终 S14A”，且“早期各片提供各自 candidate target”（`specs/S00.md:25-26`）。
- 但通用合同的双目标章节只为 S00 指定 baseline、为 S14A 指定最终 candidate；没有把 early candidate manifest/parity/dry-run 列为 S07/S10B/S11 的完成条件（`05-SOL-EXECUTION.md:43-55`）。
- 派发模板要求 worker 阅读主计划、C01–C09、执行矩阵、通用合同和**被指派的那一份 Spec**，没有要求重读上游 S00 Spec（`05-SOL-EXECUTION.md:3-7`）。
- S07、S10B、S11 的受审文件本轮未改。它们要求执行中文 early gate，但步骤、命令与必交物仍没有：当前切片 candidate execution manifest、`execution-targets.json`、双目标 dry-run、fixture parity receipt 或逐请求 arm-target SHA。其命令只列确定性/typecheck/browser 测试。

**具体反例**：

S07 worker 按自己的 Spec 和通用合同实现 budget policy，运行单测，再用当前候选工作树调用一次真实模型，给出字数/范围 receipt 并标“第一个 early gate 通过”。它没有读取 S00 第 6/7 步，也没有构造 candidate target 或与冻结 baseline 做双目标 dry-run。S07 的当前必交字段仍能形式上满足；S13 只看到“early gate passed”便可继续。S10B/S11 可同样退化为单臂 smoke，导致 C06 所要求的“小型中文对照”失去 baseline，自然无法证明该 slice 未使质量变差。

这不是要求现在执行实验，而是职责没有进入实际 owner 的可下发合同。上游 S00 文档不能可靠地给三个后续、独立派发的 worker 增加未被其 Spec/通用合同引用的完成条件。

**最小修正**：

1. 在 `05-SOL-EXECUTION.md` 明确 early target 合同：S07、S10B、S11 各自在其已合入依赖 SHA 上生成/验证临时 candidate execution manifest，与 S00 baseline manifest 构成 `execution-targets.json`；运行对应 `--phase early-* --dry-run` 后才可发真实请求。每个请求同样绑定 arm/target/driver SHA 与 parity ID。
2. 在 `specs/S07.md`、`S10B.md`、`S11.md` 各增加一条步骤和必交物：消费 S00 runner/protocol/baseline，准备当前 slice candidate target，执行两目标零模型 dry-run/parity，再执行预注册 early 对照；baseline 不可用、目标相同、parity 失败、单臂或缺 arm-target receipt 均不得将 gate 标通过。
3. 命令中的具体 phase 名可由 S00 冻结后填写，不必现在猜 CLI；但 Spec 必须要求把实际 selector/命令/target manifest/receipt 记入交付。early target 只为该门，不替代 S14A 最终 subjectSha；后续代码变化不会继承早期结果。
4. `06-SPEC-INDEX.md` 或最终证据链补一句三个 early gate 也使用真实 baseline/candidate 双目标，避免索引继续只把双目标描述成 A/B 最终链。

**关闭条件**：

- 单独下发 S07、S10B 或 S11 时，worker 仅阅读派发模板要求的文件即可知道自己必须交 candidate target、双目标 dry-run/parity 和逐请求 arm-target receipt。
- 三份 Spec 均明确：单臂 smoke、同一实现两次运行、S00 历史输出、缺 baseline 或 parity 失败不能作为 early gate PASS。
- 责任补齐不改变 C06 的 80 次总帽，也不把早期 target 当作 S14A 最终 subjectSha。

## MSR-01 复审：CLOSED

新增冻结轨没有阻断矛盾：

- 质量 runner/protocol 归 S00，迁移 acceptance runner 前移到 S04，release/smoke/workflow 适配由 S13/主集成者在冻结前完成（`specs/S00.md:24-26`、`S04.md:24`、`S13.md:24`）。
- S14A 只在上述 tracked 工具全部合入并验证后冻结；任何修改重新验证，不先冻结再补工具（`specs/S14A.md:14`、`20-23`）。
- S14B/C/D 对 tracked subject 只读；需要修复则退原 owner 并重走 S14A，新 subjectSha 不继承旧 B/C/D 证据（`05-SOL-EXECUTION.md:53-55`；`specs/S14B.md:14`、`40`；`S14C.md:14`、`39`；`S14D.md:14`、`23`）。
- reportSha 与 subjectSha 分离，B/C 并行要求同 subjectSha、dry-run 已过且数据/ABI 隔离；D 只接受同 subjectSha 的终态收据。不存在“测试失败后改 tracked 脚本却沿用旧资格”的路径。

## 复审入口

只需更新通用合同、S07、S10B、S11 与必要索引/manifest，关闭 ER1。无需重改 S00/S14A/B 的最终双目标设计、MSR-01、主计划 C01–C09 或其他 Specs；也无需运行模型/生产测试来完成本轮规划复审。
