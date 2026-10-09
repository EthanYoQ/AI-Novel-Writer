# Vela 退出与数据迁移独立对抗复审（Round 2）

审计日期：2026-09-12  
审计对象：v2 的约束性整体：`01-PLAN.md`、`03-CONTRACTS-AND-GATES.md`、`04-EXECUTION-MATRIX.md`  
复审范围：逐项裁决 Round 1 的 MIG-R1-01 至 MIG-R1-05，并检查新增迁移状态、schema lane 和执行矩阵是否互相矛盾；未重做全库逐行审查  

## 受审版本核对

本轮开始时实测 SHA-256 与主线程提供值完全一致：

| 文件 | SHA-256 |
| --- | --- |
| `01-PLAN.md` | `D44598A05DD2683E0225ED1513B49C3F2F03DA51E19B8DD509A614E4EABE8EB8` |
| `03-CONTRACTS-AND-GATES.md` | `2AF730617CCAFF0303FEB5D4C9F300CAEB85491EE2814B0E9CFDA030269063C3` |
| `04-EXECUTION-MATRIX.md` | `F67B9068E5A26AD8A6040E151DF4AC6900E62944C33A2C8DF8236B81611392C4` |

## Verdict

**PASS — 迁移/退出计划已具备拆发 Sol/high 实施 Spec 的条件。**

Round 1 的 4 个 P1 和 1 个阻断性 P2 均已由约束性正文关闭。本轮没有发现新的 P0/P1 或影响可实施性的 P2。此 PASS 只表示三份同哈希计划在迁移与 Vela 退出维度具备实施条件，不表示任何代码、实际迁移、旧安装版、中文质量、桌面资格、合并或发布已经通过。

## Round 1 逐项裁决

### MIG-R1-01 — CLOSED：旧版重开与两个写根

**修订证据**

- `01-PLAN.md:61-63` 把 journal 扩展为 `prepared → verified → legacy-isolated → target-installed → switched`，并把移除旧版可发现路径、旧版拒写原根、新 ID 独立副本设为硬约束。
- `03-CONTRACTS-AND-GATES.md:88-102`（C08）明确源/目标句柄关闭、journal 的身份/路径/指纹、五个物理阶段、各中间布局的前进/撤回规则，以及未知双根不得开放或猜合并。
- C08 还固定至少 v1.1.0/v1.0.0 的旧二进制重开矩阵；无法证明的更旧版本只走独立新根导入。新写入后的降级副本取得新 projectId，并保留来源 provenance。
- `04-EXECUTION-MATRIX.md:21,39,51,58` 将物理转换、旧版重开和代码回滚后的 forward-fix/独立副本边界放入 S04/S14C 与兼容波次。

**对原反例的裁决**

迁移成功后把 `P/.vela` 留在原位已被 C08 明确禁止；旧版不能再从原发现路径打开旧 DB。崩溃时也不能仅凭“两目录存在”判成功，必须先按 journal 指纹收敛到唯一活动根。独立旧版副本复用 projectId 的身份冲突同样已禁止。

**实施关闭测试仍须兑现**

在 S04/S14C 对每个 rename/journal 边界注入崩溃，并用受支持旧二进制实测“原根拒写、不重建旧 DB、独立副本新 ID 可写”。这些是实施门，不再是计划缺口。

### MIG-R1-02 — CLOSED：全局启动门、双 locator 与模型/API Key generation

**修订证据**

- `01-PLAN.md:64,68` 保留“只迁本产品有证据对象、不整体搬 `.vela`、冲突显式裁决”，并新增所有可写消费者之前的全局迁移门、双 locator 和单 generation。
- `03-CONTRACTS-AND-GATES.md:104-110`（C08 全局）规定 startup migration coordinator 必须早于默认配置、skin/MCP/update、可写 controller 和普通 renderer；迁移未完成时仅允许迁移 UI/只读诊断。
- 同一段把 legacy source 与 canonical target 分开注入，要求测试连同 userData/会写状态全部隔离，旧环境变量只代表旧源；models/config 在 staging 中作为单 generation 校验默认引用并切换。
- 同 ID 凭据冲突只显示非密钥字段和“凭据不同”；损坏 JSON 不以默认值覆盖；旧源切换后变化只能提示显式导入，不能自动回灌。
- `04-EXECUTION-MATRIX.md:7,20,42` 将 `electron/main.ts` 启动接线和共享 bridge/IPC 交给唯一集成者，并禁止 S03/S04 接线并行。

**对原反例的裁决**

默认 config 抢先创建、迁移 smoke 读临时旧源却写真实 appData、models/config 分裂提交、旧版后续改动静默回灌，均被 C08 的时序和 generation 契约直接禁止。

**实施关闭测试仍须兑现**

S03 fixture 仍须覆盖仅旧/仅新、同 ID 不同 Key、损坏 JSON、部分 staging、切换后旧源变化及真实 home/appData 零改动；计划已给出可以据此写 Spec 的唯一语义。

### MIG-R1-03 — CLOSED：单一 schema lane 与共享文件所有权

**修订证据**

- `03-CONTRACTS-AND-GATES.md:74-82`（C07）指定 S01 集成 owner 独占 manifest 版本、DB registry/runner、开库顺序和共享 IPC；未知高版本只读拒写，旧无版本库须有证据 fingerprint。
- 版本序列固定为 `M00(S04) → M01(S05) → M02(S08) → M03(S11) → M04(S12)`，具体连续整数由 S01 在最新 registry 上冻结，Agent 不得自行抢号。
- 每步须声明 from/to、事务/重启判据并执行 integrity/foreign-key/领域不变量；开库拆为 read-only probe、schema migration、验证、session fencing、repository/controller。
- `01-PLAN.md:149-161` 已把 S05 改为依赖 S04，并重复固定 schema 次序。
- `04-EXECUTION-MATRIX.md:5-11,17-35,42` 给出共享接线区唯一 owner、各切片 migration function 归属和只能串行注册/执行的接力方式。

**新增矛盾检查**

矩阵的逻辑并行不会破坏 schema 顺序：S08 虽可与 S06 入口 lane 并行，但 M02 只能由共享 schema lane 在 M01 后注册/执行；S11 依赖 S10B，而 S10B 经 S09C 已依赖 S08，因此 M03 不会越过 M02；S12 明确依赖 S11。S04 在 staging 运行同一 registry，而不是维护第二套最终 schema。

**对原反例的裁决**

四片各自在 `electron/database.ts` 做 ad-hoc ALTER、重复分配版本或以列缺失猜修复，已被 C07 和共享 owner 表禁止。剩余风险属于 Spec 是否忠实落实，而不是计划无序。

### MIG-R1-04 — CLOSED：WAL、LanceDB canonical 全文和索引代际

**修订证据**

- `01-PLAN.md:59-63,68` 保留 SQLite backup/WAL、源目标句柄关闭和物理阶段，并明确 canonical chunks/documents 不可丢，只有向量代际可在全文保留后重建。
- `03-CONTRACTS-AND-GATES.md:88-100` 要求验证后关闭源与目标 SQLite/LanceDB/枚举句柄，再执行同卷物理切换；中间态不能同时打开新旧库。
- `03-CONTRACTS-AND-GATES.md:118-123`（C09）把 DB/WAL、canonical chunks/documents、`chunks__space_*`/registry、旧 `vectors.json`/journal 分开规定：全文逐条迁移并校验文本哈希，半迁移不能猜拼，不自动付费 embedding。
- `03-CONTRACTS-AND-GATES.md:130` 明列外部原文件已删除、FTS-only、多向量代际、半迁移、Windows 句柄占用等验收场景。

**对原反例的裁决**

删除了原 PDF 后把整座 LanceDB 当“可重建索引”丢弃 canonical 文本，或目标验证句柄占用导致 Windows 切换半完成，均已成为契约性禁止项并有对应 fixture 门。

### MIG-R1-05 — CLOSED：完整 disposition 与 reparse-point 边界

**修订证据**

- `03-CONTRACTS-AND-GATES.md:112-130`（C09）要求 S00 的 disposition manifest 成为 S04 前置；存在项未分类即禁止切换，S13 再逐项核销。
- 强制表覆盖 manifest/DB/WAL、LanceDB/registry/旧 vector journal、项目 prompt、Skill 与绑定、partial/recovery、UI/发行/import/outbox 证据、已证死文件和未知文件。
- symlink/junction/reparse point 默认不跟随；必需资产只有 realpath 位于授权根、类型和 capability 正确时才可消费。未知项只随整个旧目录隔离，不遍历、不执行、不默默导入。
- `04-EXECUTION-MATRIX.md:17,21,36,50-56` 将清单、资产迁移和最终 terminal disposition 分配给 S00/S04/S13，不允许靠词法零命中代替行为证明。

**对原反例的裁决**

项目 prompt、Skill 绑定或 partial recovery 因未列入 DB 迁移而静默消失，以及 allowlist 递归跟随项目外 junction，均已被 C09 的“未分类不切换”和 no-follow 规则关闭。

## 新增阻断矛盾检查

本轮未发现新增阻断：

1. **物理状态与逻辑状态一致**：C08 不声称多目录 rename 是单原子操作，而是把每步物理事实纳入 journal/recovery；这与“只有一个写根”一致。
2. **迁移先开发、后启用**：S04 只对合成 fixture 启用；作者升级须等 S13/S14C 相关门，避免先发布一个只能创建新格式、不能安全接旧小说的中间版本。
3. **schema DAG 一致**：C07 的 M00-M04 与主计划、矩阵逐项一致；入口 lane 的有限并行不授权并发改共享开库/registry 文件。
4. **旧适配退出不等于删除恢复能力**：S02 允许旧持久 URI 只读解析，S13 只保留隔离 legacy import/fixture/历史许可；这与旧项目迁移及最终生产消费者归零不冲突。
5. **回滚边界一致**：新持久数据写入后不自动降 schema/恢复旧快照，只能 forward fix 或新 ID 独立副本，符合 ADR0001 的项目身份保护。

## 非阻断执行提醒

1. S03 Spec 应把全局 `recent-projects`、用户 prompts/Skills、skin、MCP、更新偏好和任何实际命中的产品自有对象逐项放入全局 disposition/conflict 表；v2 已通过 S00 清单、S03“全局对象迁移”、C08 显式裁决提供了约束入口，因此这不再构成计划阻断。
2. C08 所称“平台等价持久策略”应在 Spec 中写出 Windows/macOS 的实际 API/可验证回执；不能把调用普通 rename 后写日志当作 durability 证据。
3. 迁移 journal 的专用位置应由 S01 固定为不随 `.vela` 隔离或 staging 安装而失联的可探测位置，并纳入深路径/大小写/移动目录 fixture。C08 已要求开业务 DB 前可读和按真实路径/指纹裁决，具体文件名可以留给 Spec。
4. 正式 Spec 拆分完成后仍需按 `04-EXECUTION-MATRIX.md:60-64` 复核每片的依赖 SHA、唯一 owner、共享接线请求和退出证据；本 PASS 不为偏离矩阵的 Spec 背书。

## 最终边界

本轮仅审阅计划文本和既有首轮证据，没有运行实际迁移、旧安装二进制、数据库故障注入、模型、打包或三平台资格测试。上述项目仍必须在各实施门产生真实命令、退出码、fixture 哈希和未执行项记录，才能获得对应的实现/升级/发布结论。
