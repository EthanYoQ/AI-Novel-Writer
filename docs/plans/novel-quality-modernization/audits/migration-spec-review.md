# Vela 退出与迁移 Spec 拆分一致性审计

审计日期：2026-09-12  
受审对象：`05-SOL-EXECUTION.md`、`06-SPEC-INDEX.md`、`specs/S00.md` 至 `specs/S14D.md` 共 26 个文件  
基准契约：未改动的 v2 `01-PLAN.md`、`03-CONTRACTS-AND-GATES.md`、`04-EXECUTION-MATRIX.md`  
审计范围：迁移/资产/schema/共享所有权/旧版与资格边界的一致性；未运行实际迁移、测试、模型、安装或云端工作流

## 版本与机械结构核对

- `audits/SPEC-MANIFEST-v1.json` 中 26 个受审文件逐一重算 SHA-256，**26/26 匹配，0 mismatch**。
- v2 三份受审计划的 SHA-256 仍分别为：
  - `01-PLAN.md`：`D44598A05DD2683E0225ED1513B49C3F2F03DA51E19B8DD509A614E4EABE8EB8`
  - `03-CONTRACTS-AND-GATES.md`：`2AF730617CCAFF0303FEB5D4C9F300CAEB85491EE2814B0E9CFDA030269063C3`
  - `04-EXECUTION-MATRIX.md`：`F67B9068E5A26AD8A6040E151DF4AC6900E62944C33A2C8DF8236B81611392C4`
- 主线程已独立确认 24 个 Spec 的矩阵依赖一致、DAG 无环、必备字段齐全；本审计不重复把机械检查冒充迁移语义审查。

## Verdict

**REQUEST_CHANGES — 暂不可按当前 26 文件原样开始最终资格波次。**

C07–C09 对应的迁移实施片本身保持忠实：S00–S05、S08、S12、S13、S14C 没有弱化旧版隔离、全局启动门、schema lane、canonical 全文、未知资产或权限边界。但发现 1 个新的 **P1 拆分一致性阻断**：S14A 冻结候选 SHA 后，S14B/S14C/S14D 仍各自允许修改受跟踪的验证 runner、协议、smoke 或资格 workflow，因而无法保证中文质量、升级恢复和三平台资格确实针对同一源码 SHA。该缺口关闭前不能给 Spec 包 PASS。

## 阻断项

### MSR-01 — P1：最终验证片允许在冻结后继续改受审树，破坏“同一 SHA”资格链

**契约要求**

- `01-PLAN.md:187-189` 和 ADR0016 要求 Windows x64、macOS ARM64、macOS x64 及升级/质量结论分别报告，三平台基于同一 SHA。
- `04-EXECUTION-MATRIX.md:37-40` 的顺序是 S14A 冻结确定性候选，S14B/S14C 分别生成质量和升级证据，S14D 再验证同 SHA 三平台。
- `specs/S14D.md:10` 明确“最终候选与质量/升级证据必须同 SHA”。

**冲突证据**

- `specs/S14A.md:20-23,44` 要求先冻结 candidate SHA，再交给 S14B/C。
- `specs/S14B.md:14,39` 允许在 S14B “接管”并执行适配 `scripts/quality-modernization-run.mjs` 与受跟踪的 `protocol.json`；这可能产生新 commit/SHA 后才跑模型证据。
- `specs/S14C.md:14,39` 允许在 S14C 做安装/升级 smoke 适配；这同样可能改变受跟踪树后才跑旧版/崩溃证据。
- `specs/S14D.md:14,23` 又允许主集成者在 S14D 修改 `.release/`/`.github/` 资格脚本，并只说 SHA 变化时“按影响重做相关资格”，没有明确使已有 S14A/B/C 证据全部失效并重新冻结。
- `04-EXECUTION-MATRIX.md:42` 允许 S14B 与 S14C 并行。若两者都进行 tracked 适配，各自很容易基于不同子 SHA 产生证据，即使最终 merge 后 DAG 仍无环。

**可失败反例**

1. S14A 在 `H0` 通过全量确定性测试并冻结候选。
2. S14B 为 runner 增加必要适配形成 `H1`，在 `H1` 完成 18 章质量实验。
3. 与之并行的 S14C 从 `H0` 为升级 smoke 增加适配形成 `H2`，在 `H2` 完成旧版重开与崩溃矩阵。
4. 集成得到 `H3`；S14D 又修改 workflow 得到 `H4` 并完成三平台构建。
5. 四片都能按各自文本声称通过，但不存在一个 SHA 同时拥有 S14A 的代码回归、S14B 的质量证据、S14C 的迁移证据和 S14D 的三平台资格。`H4` 甚至可能从未运行过 S14C 的物理迁移矩阵。

这不是“测试尚未执行”的预期边界，而是按当前职责分配执行后也无法可靠形成计划要求的同 SHA 证据链。

**最小修正**

无需新增 Spec 或通用发布框架；只需收紧现有波次：

1. 把所有会修改受跟踪的质量 runner/protocol、迁移 acceptance runner/smoke、`.release/.github` 资格适配前移到 S00/S04/S13 或 S14A 的**冻结前准备**，由原 owner/主集成者完成并测试。
2. S14A 在这些工具与 workflow 已合入后冻结唯一 `subjectSha`。S14B、S14C、S14D 对该 subject tree 只读执行；它们可以产生外置/private receipts 和事后报告，但不得悄悄修改 subject 后沿用旧证据。
3. 任一验证片发现必须改 tracked 文件时，停止并退回对应 owner；新提交产生新 `subjectSha` 后重新执行 S14A。因为契约要求**完全同 SHA**，此前 S14B/C/D 证据均不得自动继承；只能在新 SHA 重跑或明确保持 not-run/blocked。
4. S14B 与 S14C 只有在记录相同冻结 `subjectSha`、runner 已 dry-run 且各自数据根/ABI 隔离后才可并行。S14D 只能消费两者针对同一 subjectSha 的终态 receipt。
5. 区分“证据报告文件的后续提交 SHA”和“被验证的 subjectSha”；报告必须记录 subjectSha 与 artifact hash，不能把报告 commit 冒充被测源码。

**关闭条件**

- 修订 `05-SOL-EXECUTION.md`、执行矩阵/索引及 S14A–D 中受影响段落，形成明确的 freeze → read-only evidence → qualification 链；同步更新 spec manifest 哈希。
- 静态反例检查必须得出：S14B、S14C、S14D 任一请求 tracked 适配都会使当前 candidate 失效并返回 S14A，而不是在原波次继续。
- S14B/C 的必交 receipt 都要求相同 `subjectSha`；S14D 在缺任一相同 SHA 终态 receipt 时只能 `blocked/not-qualified`。

## 已通过的一致性项

以下各项在当前 Spec 包中没有发现弱化；MSR-01 修订时不得回退：

### 1. S00 资产/消费者前置清单 — PASS

- `specs/S00.md:20-28,44-46` 同时覆盖 src/electron/scripts/release/package、词法与行为台账、项目/全局 disposition、动态消费者和 ABI/旧安装来源。
- 已知 prompt、Skill、partial recovery、LanceDB canonical 文本、MCP/skin/update 被显式点名；未分类对象阻塞 S04，而不是实现者临场猜测。

### 2. S01/C07 schema 与共享所有权 — PASS

- `specs/S01.md:14,20-27` 只拥有契约、runner/registry 和 ADR；M00–M04 具体编号、from/to、重启语义由唯一 owner 冻结。
- `05-SOL-EXECUTION.md:11-24` 与 `04-EXECUTION-MATRIX.md:5-11` 一致地保留 database/main/preload/IPC/channels/client/package/release 的共享接线所有权，业务 Agent 只交一个接线请求。
- 未知高版本拒写，probe/migrate/verify/fence 分离，没有退回当前开库时 ad-hoc ALTER 的弱化。

### 3. S02/S03 API 与全局启动门 — PASS

- `specs/S02.md:20-27` 覆盖 typed URI、角色只读投影、旧引用只读迁入、bridge/direct consumer 及越权拒绝；新 API 不可用时不 fallback 到旧写接口。
- `specs/S03.md:20-27,38-40` 枚举 config/models/recent、用户 prompt/Skill、MCP、skin、update、产品日志；coordinator 先于普通窗口和可写消费者，source/target/userData 均隔离。
- models/config 同 generation；损坏/半目标/凭据冲突 fail closed；旧源之后只显式导入，不回灌。API Key 与 hash 不进入展示或 fixture。

### 4. S04/C08/C09 物理迁移与 canonical 原文 — PASS

- `specs/S04.md:20-27,38-40` 要求 SQLite backup 处理 WAL、staging 跑同一 registry、源目标句柄关闭、五阶段 journal、旧发现路径消失、新 ID 独立副本和未知双根人工裁决。
- canonical chunks/documents 逐条保全；外部原件已删、FTS-only、多代向量、半迁移、reparse、深路径、句柄占用和每个 rename/journal 崩溃点均进入 fixture。
- 仅合成 fixture 启用，旧二进制未实测前不宣称作者升级安全。

### 5. S05/S08/S12 schema 接力 — PASS

- `specs/S05.md:14,20-27` 的 M01、`specs/S08.md:14,20-27` 的 M02、`specs/S12.md:14,20-27` 的 M04 分属模块 migration function，中心注册仍交唯一 owner。
- 依赖链保证 M01 在 M00 后、M02 在 M01 后、M04 在 S11/M03 后；S08 可与入口 lane 并行不等于 schema 注册或开库并行。
- 新 ID 写入不回退 name 主键，歧义保留；import effect/取消/租约不会以删除安全边界换简化。

### 6. S13 退出与死代码 — PASS

- `specs/S13.md:20-27,38-42` 要求三个 early gate、词法/行为/资产三表全部 terminal disposition 后才清理。
- 动态 import/barrel/glob/构建/UI 消费者为零才删模块/依赖；集中 legacy importer、历史/许可/fixture 有理由保留，DSH、LICENSE、作者文本和未知备份不删。
- package/lock/release 的实际修改仍归主集成者，未向清理 Agent 放开共享文件。

### 7. S14C 旧版、未知版本与权限边界 — PASS（除 MSR-01 的冻结时序）

- `specs/S14C.md:20-27,37-41` 要求真实 v1.0.0/v1.1.0 二进制、隔离 userData/source/target、三份独立结论、每个物理断点和新 ID 旧版副本。
- 缺旧二进制不能声称支持；更旧/未知版本只提供独立副本导入，不移动真实旧目录。
- 安装操作只由主线程在实际授权下执行；通用合同要求缺权限/平台/二进制即 `blocked/not-run`，不以 mock 或 Windows 结果冒充 macOS。

### 8. S14D 发布权限与平台边界 — PASS（除 MSR-01 的冻结时序）

- `specs/S14D.md:20-27,38-42` 要求三个真实目标各自 receipt，缺平台/签名/权限据实不合格。
- 当前本地 Spec 不授权 push、工作流、promotion、merge、tag、release 或 Issue closure；这与原任务权限边界一致。

## 非阻断建议

1. S14C 的 `project-migration-acceptance.mjs` 最终实现位置和 S04 的物理迁移 fixture 应在冻结前建立单一 owner，避免两个名字不同但语义重复的故障注入框架；复用现有 smoke 即可。
2. S03 的全局 disposition 应继续把“产品自有 logs/metadata”按内容和来源逐项识别，不要仅凭位于 `.vela` 就迁移；该边界已在 S00/S03 写明，可在实施清单落实。
3. 所有 Spec 的 `Blocked by` 表达的是“已合入且验证的实际 SHA”。实现排程应保留 receipt 中的 dependency SHA，避免主集成者接线后的新 SHA 仍沿用接线前测试结论。

## 复审入口

本审计只要求关闭 MSR-01。修订后请提供更新的 manifest 和受影响文件哈希；复审将检查最终四波是否共享一个不可变 subjectSha，以及 tracked 适配是否全部位于 freeze 之前。该项关闭后，其余已通过迁移一致性项无需重做全库审计。
