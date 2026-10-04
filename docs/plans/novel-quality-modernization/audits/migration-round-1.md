# Vela 退出与数据迁移独立对抗审计（Round 1）

审计日期：2026-09-12  
审计对象：`01-PLAN.md` v1；`02-BASELINE-AND-BOUNDARIES.md` 仅作为现状证据附录  
源码基线：`731bda13ff9197d0abefaa353139df1359ce75cb`（代码树等同 `origin/master@2264390d6fb8b052cc14736d544df0cc74516649`）

## Verdict

**FAIL — 暂不可拆发 Sol/high 实施 Spec。**

没有发现 P0，但有 4 个 P1 和 1 个影响可实施性的 P2 尚未关闭。主要问题不是 Vela 字符串清单不够长，而是切换后的唯一写根、全局配置迁移启动门禁、数据库 schema 串行化和知识库原始文本保全都还没有形成不可绕过的实施契约。附录补足了部分消费者事实，但没有关闭这些状态机和所有权缺口。

## 阻断项

### MIG-R1-01 — P1：`switched` 之后仍可能同时存在新旧两个可写项目事实源

**计划位置**

- `01-PLAN.md:55-64` 要求探测、备份、`prepared → verified → switched`、切换后新格式唯一可写，并要求验证旧版重新打开。
- `01-PLAN.md:175` 把旧项目、WAL、混合路径和源稿新写入列入桌面验收。

**源码证据**

- `electron/services/project-access.ts:13,163-213,322-365`：现有版本只认 `.vela/project.json` 或 `.vela/vela.db` 指纹，并会为受信旧库写入 manifest。
- `electron/controllers/project-controller.ts:443-472`：打开项目时会 `adoptLegacyProject`，随后直接初始化数据库。
- `electron/database.ts:23-37`：初始化固定打开并写入 `.vela/vela.db`，启用 WAL 并执行 schema 创建/迁移。

**可失败反例**

1. 新版在 `P/.ai-novel/project.db` 完成迁移并记为 `switched`，但为“备份/隔离证据”仍把 `P/.vela/project.json` 和 `P/.vela/vela.db` 留在原位置。
2. 用户用 v1.1.0 或更旧受支持版本从最近项目再次打开 `P`。旧版不理解新 manifest，却仍信任 `.vela` 并向旧 DB/WAL 写入。
3. 用户再回新版；同一个可见项目根下已有两套各自成功写入的正文、角色和 outbox。迁移 journal 只能证明过去切换过，不能判断应合并哪一边，也不能满足“新格式唯一可写”。

初始迁移时检测“旧程序当前未运行”不能阻止上述未来重开。若“导出独立旧版副本”保留原 `projectId`，还会生成两个根目录共享同一稳定项目身份的第二个失败模式。

**最小修正**

在主计划中把切换提交点定义为物理可验证的单写根，而不是抽象的 `switched`：

1. journal 必须记录源路径、目标路径、源/目标指纹及物理布局阶段；应用在恢复完该状态前不得打开任一 DB。
2. 切换成功必须同时满足：规范 manifest/DB 已安装；原项目根的旧发现路径 `.vela/project.json`、`.vela/vela.db` 已通过同卷原子重命名移入**旧版不可发现**的隔离备份；普通代码不能再解析隔离位置。
3. 明确每个崩溃点的恢复方向，至少覆盖“目标已安装但旧路径尚未隔离”和“旧路径已隔离但 journal 尚未提交”；恢复过程不得双写或自动合并。
4. 切换后若需降级，只能导出到另一个根目录；副本获得新的 `projectId`，另存只读来源项目 ID/迁移 ID 作为 provenance，不得恢复成原项目中的第二写根。

**关闭条件**

- 用至少一个受支持旧安装版本实测：迁移后的原根无法被旧版写入；显式导出的旧版副本可写且 projectId 不与活动项目冲突。
- 对目录重命名前后和 journal 写入前后逐点注入崩溃，重启后只能得到“旧格式活动”或“新格式活动”之一；不存在两个活动写根。
- 新格式产生写入后，回退入口拒绝原地覆盖并只允许独立副本。

### MIG-R1-02 — P1：全局配置迁移没有“任何消费者写入前”的门禁，也没有旧源/新目标的双 locator 隔离契约

**计划位置**

- `01-PLAN.md:49,53-63` 指定新全局根为 `app.getPath('appData')/ai-novel-writer`，要求配置迁移、密钥保密和同 ID 冲突选择。
- 切片顺序为 `S02 → S03`，但没有规定应用启动时谁先于 config、model、skin、MCP、update 和 renderer 初始化执行迁移。

**源码证据**

- `electron/utils/config-utils.ts:7-21,120-122`：现有 `AI_NOVEL_VELA_HOME`/`~/.vela` 同时承载 config、models、recent-projects、prompts 和 logs。
- `electron/ipc-handlers.ts:24-52`：启动先创建旧全局目录，再初始化 skin 并注册所有会读写全局资料的 controller。
- `electron/main.ts:237-264`：IPC/皮肤、窗口及更新运行时在同一启动链中开始工作。
- `electron/controllers/llm-controller.ts:32-54,269-350`：API Key 直接属于 `models.json` 的模型条目；默认模型引用另存在 `config.json`，两文件必须一致切换。
- `electron/mcp/mcp-manager.ts:120`、`electron/services/skin-service.ts:208`、`electron/controllers/app-data-controller.ts:202-308`：MCP、皮肤、全局 prompt/Skill 也是同一旧根的实际消费者。

**可失败反例**

1. 新版先创建新根并由主题/更新/模型初始化写入默认 `config.json`，随后迁移器才探测旧根。
2. “新配置优先”会把这个由本次启动刚创建的默认文件误判成用户选择；旧默认模型及其 API Key 没有迁入，或进入无法安全自动裁决的同 ID 冲突。
3. 在 smoke 中只把 `AI_NOVEL_VELA_HOME` 指向临时 fixture，而新 locator 固定指向真实 `%APPDATA%/ai-novel-writer`，测试会读取隔离旧源却写入用户真实新目录。
4. 若每次启动都重新比较旧根，用户之后用旧版改写 `~/.vela/models.json`，新版可能再次导入并覆盖切换后配置；若永不比较又没有 cutover 回执，用户无法区分“已迁移”与“旧版后续变更未同步”。

**最小修正**

1. 增加唯一的 startup migration coordinator；它必须在建新根、初始化 skin/MCP/update、注册可写 controller、创建可发 IPC 的窗口之前完成探测/恢复/用户裁决。未完成时只允许迁移 UI/只读诊断。
2. 分开注入 `legacySourceLocator` 与 `canonicalTargetLocator`。生产默认分别指向旧 `~/.vela` 和新 appData；测试/资格脚本必须把两者都置于同一个受控临时根，且断言真实 home/appData 未变化。不能让旧 `AI_NOVEL_VELA_HOME` 同时隐式代表源与目标。
3. 全局 journal 记录一次性 cutover 的源指纹、目标 generation 和每个对象的结果；切换后旧根只读且不再自动回灌。检测到旧根后续变化只能提示显式导入，不得静默覆盖。
4. 为 `models.json` 与 `config.json` 定义一个提交单元：同 ID 冲突 UI 只显示非密钥字段和“凭据不同”，选择结果先写模型，再验证/重映射默认 ID，最后提交 generation。日志和 receipt 不得包含 Key、Key 哈希或原文件全文。

**关闭条件**

- 冷启动 fixture 覆盖：仅旧根、仅新根、两根相同 ID/不同 Key、新根为本次崩溃留下的空/部分目录、损坏 JSON、迁移后旧根再次变化。
- 每个全局对象写入点注入崩溃后重启，不能得到悬空默认模型、丢失模型凭据或把默认文件冒充用户新配置。
- smoke/发行测试记录旧源和新目标的绝对隔离根，并证明真实用户 `.vela` 与 appData 均未写入。

### MIG-R1-03 — P1：S04/S05/S08/S12 可并发修改 schema，但计划没有一个可执行的数据库版本序列

**计划位置**

- `01-PLAN.md:133-151` 允许 S04、S05、S08 从不同依赖边并行推进，并承认它们都会修改 schema，只要求未来 Spec 再规定共享入口与迁移顺序。
- `01-PLAN.md:153` 规定跨模块契约先改 S01，但没有规定谁拥有 DB schema version、迁移注册表和发布顺序。

**源码证据**

- `electron/database.ts:62-589,591-1058` 当前把大量 `CREATE TABLE IF NOT EXISTS`、逐列 `ALTER TABLE`、表重建及数据回填集中在打开流程；没有项目级单调 `user_version`/等价 schema generation。
- `electron/database.ts:951-963` 打开还会修改运行租约状态并初始化角色 roster，不是纯 schema 探测。
- `electron/repositories/character-roster-schema.ts:8-71` 另有角色局部 schemaVersion=1，但它不是整个项目数据库版本。

**可失败反例**

S04 从旧库生成 `project.db`；并行的 S05 增加 run/attempt 表，S08 给角色增加稳定 ID，S12 重建 import ledger。每片都在自己的基线使用“列不存在则 ALTER”并通过测试。集成时，某片先重建表或标记迁移完成，另一片随后按过期列集合回填；崩溃后重开可能只看到部分 DDL，却没有一个版本号能决定从哪里继续。更糟时，S04 的旧库到新库转换按旧目标 schema 复制，会丢掉先合入的 run/角色字段。

**最小修正**

在拆 Spec 前先写入计划的 schema lane 契约：

1. S01 指定一个集成者独占 manifest schema、项目 DB 版本注册表和迁移 runner；各切片只能提交有唯一递增编号、`from/to`、事务边界和幂等复验的迁移，不得各自改开库顺序。
2. 明确顺序：S04 先把旧存储转换到一个冻结的 canonical DB 基线；S05/S08/S12 的 schema migration 按编号串行合入。若允许先开发后集成，也不得并发执行/发布 schema 迁移。
3. 每次迁移前后执行明确的 `integrity_check`/`foreign_key_check`、schema generation 检查和领域不变量；失败保留源备份且不开放写入。
4. 把当前“开库即迁移并修改业务状态”拆为只读 probe、schema migration、session fencing 三个有顺序的阶段；迁移验证不能意外领取/失效运行租约。

**关闭条件**

- 主计划或其约束性附录给出唯一 schema owner、编号策略和 S04/S05/S08/S12 的串行集成顺序，不能留到四份独立 Spec 各自决定。
- 从每个受支持旧 schema 逐版本升级，以及在每一步 DDL/回填后崩溃重启，最终 schema/数据哈希一致；不会跳过或重复角色、运行、import migration。
- 同一目标 schema 的重复打开不再产生新的业务数据变化，只执行明确的 session fencing。

### MIG-R1-04 — P1：计划没有钉死 LanceDB 的 `chunks` 是不可丢的全文事实，而不是可随时重建的向量索引

**计划位置**

- `01-PLAN.md:57-58` 要求关闭向量库、复制允许资料，并称“检索索引可重建但不能丢原始资料”。
- `01-PLAN.md:106,175` 禁止自动全书重抽取/付费，并要求覆盖向量空间迁移。

**源码证据**

- `electron/vector-store.ts:1-5,15-44,86-99,107-131` 明确 `chunks` 是始终可用的全文文本事实源，包含 `text`；每个 `chunks__space_*` 才是按模型代际隔离的 embedding 表。
- `electron/database.ts:578-587` 的 `import_reference_documents` 只保存 content/chunk-set 哈希、计数和状态，不保存原始全文。
- `electron/vector-store.ts:146-151` 连接池需要显式关闭；目标验证连接同样会占用待重命名目录。

**可失败反例**

用户曾通过短期外部文件授权导入一份 PDF，之后删除了原 PDF。项目 DB 只剩文档/块哈希，完整检索文本只在 LanceDB `chunks.text`。实现者依据“索引可重建”只迁移 `embedding-spaces.json` 或直接删除整个 lancedb 并计划稍后重建；结果全文无法从项目 DB、原 PDF或模型恢复，知识库永久为空。另一种失败是验证阶段保持目标 LanceDB/SQLite 句柄打开，Windows 在目录切换时 `EPERM`，留下目标和旧源并存。

**最小修正**

1. 在计划中明确分类：`chunks`/`documents` 的规范文本和元数据属于必须逐行语义迁移、计数并哈希验证的原始资料；只有 `chunks__space_*` 向量代际可在保留规范块后标为可重建。
2. 对旧 `vectors.json`、其迁移 journal、canonical chunks/documents、embedding registry 和每个 generation 分别定义迁移/保留动作；发现未完成旧向量迁移时 fail closed，不从两个来源拼出未经证明的新真相。
3. 切换前关闭**源与目标**的 SQLite、LanceDB 和文件枚举句柄；目标验证使用可释放句柄，关闭后再做最终指纹/目录切换。不得在迁移中自动发 embedding 请求。

**关闭条件**

- fixture 的外部源文件在迁移前删除；迁移后仍能以 byte/Unicode 规范明确的同一文本返回全部 document/chunk，文档数、块数、文本哈希和 corpus kind 相同。
- 分别覆盖 FTS-only、多个 embedding generation、building/inactive generation、旧 `vectors.json` 未完成 journal；可重建项被标 stale 而非冒充 active。
- Windows 在目标验证后可完成目录切换，句柄泄漏注入会在 `switched` 前失败并安全恢复。

### MIG-R1-05 — 阻断性 P2：项目 `.vela` 资产只有原则性 allowlist，没有逐类处置和 reparse-point 边界

**计划位置**

- `01-PLAN.md:51-58,64,175` 要求集中路径、允许清单和多类旧项目 fixture，但没有把消费者清单强制转换为迁移资产处置表。
- `02-BASELINE-AND-BOUNDARIES.md:23-29` 要求 Vela 消费者台账，却尚未要求每一项成为 S04 的输入/验收项。

**源码证据**

除 DB/LanceDB 外，当前项目根还实际消费 `.vela/prompts`（`src/services/prompt-catalog.ts:351-467`）、`.vela/writing-skills.json`（`src/services/agent/writing-skill-bindings.ts:31`）、`.vela/partial_arch.json`（`src/services/workflows/commands/architecture.command.ts:925-942`）和 `.vela/chapter_creation_log.json`（`src/components/dialogs/ChapterCreationDialog.tsx:57,163`）。其中 prompt、Skill 绑定和 partial architecture 不是都可以静默丢弃的缓存。

**可失败反例**

迁移实现只按主计划正文列出的 manifest/DB/向量/配置复制，生成内容和角色表都验证通过，但作者的项目 prompt、已冻结/绑定的写作 Skill 或世界观中断候选没有进入新根。应用可以正常启动，直到下一次生成才悄悄使用默认 prompt，或恢复入口消失；表面端到端 smoke 仍可能通过。若 allowlist 递归复制一个 junction/symlink 指向项目外目录，还可能把不属于项目的数据带入备份或新根。

**最小修正**

1. 要求 S00 交付的每个项目资产都在 S04 开工前进入约束性 disposition manifest：`migrate-as-source`、`rebuild-from-preserved-source`、`legacy-backup-only`、`verified-dead`；没有分类的已存在项不得删除，也不得让项目进入 `switched` 后才报缺失。
2. 最少显式覆盖 manifest、DB/WAL、LanceDB/registry/旧 vectors journal、项目 prompts、Skill 文件与绑定、所有可见 recovery candidate、导入/发布/outbox 证据、UI-only 历史参数和未知文件。
3. 迁移器对 symlink/junction/reparse point 默认不跟随；只有 canonical realpath 位于项目根、类型符合预期且通过现有文件能力边界的资产才可读取。未知项原样留在隔离备份并给出非敏感警告。

**关闭条件**

- disposition manifest 成为 S04 Spec 的前置输入，并由 S13 的最终 Vela 退出台账逐项核销。
- fixture 为每种资产放入非默认内容，迁移后分别验证可读、被明确重建或只在隔离备份；未知文件和外部 junction 不会被删除、跟随或静默导入。

## 非阻断建议

1. 不需要为关闭上述问题新增通用迁移平台或分布式协调器。一个启动迁移 coordinator、一个项目 journal、一个全局 journal、一个 schema runner 和明确的物理切换表已足够；应保留计划现有的“暂停通用化、给出较小替代”止损线。
2. 把“Vela 词法退出”和“旧能力被领域契约替换”保留为两张验收表。CSS class、DOM id、日志前缀、localStorage key 可以机械迁移，但不能用它们的零命中替代 DB/URI/写入所有权验证；历史/许可/fixture 命中继续按计划豁免。
3. S14 报告应把“旧版拒绝原根”“旧版独立副本可用”“新版恢复崩溃中间态”拆成三个结论，避免一个笼统的“旧项目迁移通过”掩盖双写风险。

## 复审入口

修订版至少应逐项回应 MIG-R1-01 至 MIG-R1-05，并标出新增的约束性段落。只有 4 个 P1 和阻断性 P2 均有明确契约与可执行关闭测试后，本审计才会给出 PASS；添加事实附录或把决定推迟到各切片 Spec 不等于关闭。
