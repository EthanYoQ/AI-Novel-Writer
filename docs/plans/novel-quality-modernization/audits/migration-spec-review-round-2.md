# Vela 退出与迁移 Spec 拆分一致性复审（Round 2）

审计日期：2026-09-12  
受审清单：`audits/SPEC-MANIFEST-v2.json`（26 文件）  
复审范围：上一轮唯一阻断 MSR-01 及修订引入的新迁移/schema/资产/权限阻断；不重做已通过的全库调查，不运行迁移、测试、模型、安装或云端工作流

## 版本核对

- `SPEC-MANIFEST-v2.json` 中 26 个文件逐一重算 SHA-256：**26/26 匹配，0 mismatch**。
- 约束计划保持上一轮已审哈希：
  - `01-PLAN.md`：`D44598A05DD2683E0225ED1513B49C3F2F03DA51E19B8DD509A614E4EABE8EB8`
  - `03-CONTRACTS-AND-GATES.md`：`2AF730617CCAFF0303FEB5D4C9F300CAEB85491EE2814B0E9CFDA030269063C3`
  - `04-EXECUTION-MATRIX.md`：`F67B9068E5A26AD8A6040E151DF4AC6900E62944C33A2C8DF8236B81611392C4`
- v2 manifest 所列变更范围与实读文件一致：`05`、`06`、S00、S04、S13、S14A–D 共 9 个文件；其余 Spec 哈希保持 v1。

## Verdict

**PASS — MSR-01 已关闭，当前 26 文件可以按依赖拆发实施。**

本轮未发现新的 P0、P1 或影响实施的 P2。该 PASS 只表示 Spec 拆分与已审计划在迁移/退出维度一致，且最终证据链在文本上可执行；不表示生产代码、实际迁移、双目标运行、旧版二进制、中文质量、三平台资格、合并或发布已经通过。

## MSR-01 关闭裁决

### 1. tracked 适配已经前移到冻结之前 — CLOSED

- `05-SOL-EXECUTION.md:43-53` 明确：质量 runner 由 S00 提供、迁移 acceptance runner 由 S04 提供、release/smoke/workflow 适配由 S13/主集成者提供，且全部必须在 S14A 冻结前合入并验证。
- `specs/S00.md:24-26,48` 交付可执行质量 runner、双 target 输入、可再次启动的 baseline manifest 与 parity 合同；S00 不制造尚不存在的 candidate，也不拿历史输出替代最终 baseline。
- `specs/S04.md:20-24,41` 把 `scripts/project-migration-acceptance.mjs` 的实现和 help/dry-run 归给物理迁移 owner，复用既有 smoke/故障 fixture，不让 S14C 临时补脚本。
- `specs/S13.md:20-24` 要求主集成者在 S14A 前完成 tracked release/smoke/workflow 适配；S14D 不再拥有冻结后修改 workflow 的权限。

这关闭了上一轮 `H0` 冻结后，B/C/D 分别产生 `H1/H2/H3` 的第一条路径。

### 2. S14A 成为唯一 freeze 提交点 — CLOSED

- `specs/S14A.md:20-23` 的顺序不可逆：先合入全部 tracked 验证工具 → 跑针对性/全量测试与独立 review → 验证 candidate execution target → 与 baseline 做零模型双目标 dry-run/parity → 最后冻结唯一 `subjectSha` 和 artifact hash。
- 任何修复或工具变化都必须重新开始验证步骤；不能先冻结后补 runner。
- `specs/S14A.md:44` 必交同 subjectSha 的测试矩阵、candidate target、双目标 dry-run/parity receipt 和冻结构建，并将 report SHA 单列。

因此 S14A 的“通过”不再只是源码测试通过，而是冻结后的 B/C/D 已具备可执行输入。

### 3. S14B/C/D 对 subject tree 只读 — CLOSED

- `specs/S14B.md:14,20-24,40` 只读运行 S00 已提供的 runner/protocol；只拥有隔离运行数据、private receipts 和盲评包。任何 tracked 修改需求必须退 S00 并重走 S14A。
- `specs/S14C.md:14,20,39` 只读运行 S04 的迁移 runner/smoke；receipt 绑定 subjectSha/artifact hash。缺适配退 owner，旧 B/C/D 证据失效。
- `specs/S14D.md:14,20-23` 只读运行冻结前已合入的 `.release/.github`；缺任一相同 subjectSha 的 B/C 终态 receipt，只能 `blocked/not-qualified`。
- `05-SOL-EXECUTION.md:53-55` 统一规定任何 B/C/D 阶段的 tracked 修改都会废止旧证据；B/C 仅在相同 subjectSha、dry-run 已通过且数据根/ABI 独立时并行。
- `06-SPEC-INDEX.md:27-30,48` 同步表达 freeze → B/C 只读 → D 消费同 SHA receipt，不与未改的执行矩阵 DAG/owner 冲突。

上一轮“每片各自通过但无共同 SHA”的反例现在会在发生 tracked 修改时立即失效并回到 S14A，不能继续向 D 传播。

### 4. subjectSha 与 reportSha 已分离 — CLOSED

- `05-SOL-EXECUTION.md:47,53`、S14A、S14D 均明确事后报告提交 SHA 不等于产品 `subjectSha`。
- 验证 receipt 绑定 arm、实际 target code/artifact/driver SHA、candidate subjectSha 和 fixture parity ID；后续提交报告不会冒充重新验证过产品。

这允许保存审计报告，同时保持被测源码/产物身份不可变。

## 新增阻断检查

### 双目标与语义 parity — PASS

- baseline 是可再次启动的旧实现或带哈希构建产物，不是历史文本；candidate 必须来自最终 subjectSha。
- dry-run 必须实际验证两个 target 可启动、生产入口可达、代码/产物/driver 身份不同、数据根不相交且真实用户目录不被消费。相同 target 只能做 placebo 诊断，不能得出改善结论。
- 旧/新物理格式由同一个不可变中文语义源构建；作者动作、章节范围/顺序、brief/材料、模板/Skill、模型参数与 oracle 做 parity。系统 prompt 可以不同，但必须留 hash，避免把不同作者输入伪装成实现收益。
- S00 没有 candidate 时只验证 baseline 与双目标拒绝逻辑；最终真实双目标验证在 S14A，不形成 S00→candidate 的循环依赖。

未发现 baseline 为迁就 candidate 被重写、两个 arm 指向同实现或格式差异改变作者输入的可执行漏洞。

### 迁移 acceptance runner 所有权 — PASS

- S04 同时拥有物理迁移实现和 acceptance runner，但明确复用现有 smoke/同一故障 fixture，不新造第二迁移框架。
- S14C 只执行真实旧版、独立副本和物理崩溃矩阵，不再拥有修 runner 的权限；发现缺口会回 S04→S14A。
- 这与 C08/C09 的五阶段 journal、canonical 文本、未知资产、reparse 和新 ID 副本边界一致。

### schema lane 与共享文件 — PASS

- 本轮未修改 S01/S05/S08/S11/S12；M00→M04、唯一 registry/开库 owner 与 shared-wiring 请求规则保持 v1 审计通过状态。
- S04 新增 acceptance runner 不取得 database/registry/main 共享接线权；S13 的 release 适配仍由主集成者写，未把 package/lock/.github/.release 权限下放给普通业务 worker。
- 未改的执行矩阵允许 B/C 并行；新执行合同把这种并行限制为冻结后相同 subjectSha、独立数据根和 ABI，因此没有引入共享写冲突。

### 权限与未知版本 — PASS

- S14B/C/D 只生成隔离输出/private receipts；真实模型、系统安装、远端工作流各自仍需已有授权，缺失即 `blocked/not-run/not-qualified`。
- S14C 对未取得的旧二进制不声称支持，未知版本只走独立新 ID 副本，不移动/删除真实旧目录。
- 双目标 manifest 明确隔离 userData、配置和项目根；API Key 不进入 manifest、fixture 或公开 receipt。

## 非阻断执行提醒

1. S14A 冻结 receipt 应保存 `git status`/tracked tree clean 证据以及 candidate artifact hash；B/C/D 开始和结束时复核二者，能更直接证明只读执行。现有“任何 tracked 变化即失效”已足够形成门禁，因此这只是证据格式建议。
2. B/C/D 的 private 输出目录应由 S14A manifest 给出互不重叠的绝对/规范化根，避免并行任务只靠相对路径约定隔离；执行合同已经要求根不相交，可在实现 receipt 中落实。
3. 若远端资格工作流本身会生成报告 commit，应把该 commit 作为 `reportSha`/evidence carrier，而不是新的 subject；workflow 检出的 build commit 仍须等于 subjectSha。

## 最终边界

本轮 PASS 不继承任何未运行测试的成功含义。正式执行时，缺 baseline/candidate 任一可运行目标、parity 失败、tracked tree 变化、B/C subjectSha 不同或 D 缺同 SHA 终态 receipt，都必须按修订后的 Spec 停在 `blocked/inconclusive/not-qualified`，不能写成迁移、质量或发布通过。
