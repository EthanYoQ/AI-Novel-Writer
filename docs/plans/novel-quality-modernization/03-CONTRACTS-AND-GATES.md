# v2 约束性契约与验收

这是主计划的一部分，不是已实现接口。标识符为拟定契约；S01 可按现有结构调整文件位置，不得改变语义。需要改变语义时先补审，不交给多个开发者各自决定。

## C01 — 作者动作、物理请求与唯一预算账本

- 主进程创建、持久化 `rootActionId`。入口提交幂等键包含项目、操作类型、冻结目标/输入版本和 UI action nonce；相同 nonce 的重复点击返回原动作。renderer 重启从持久运行记录恢复，不能自行宣称新 action。
- 续写、修复、拆批、Agent 派生调用、恢复按钮沿用根动作。明确的“重新开始”是新动作：旧动作先被取消/封存，界面提示新预算且不抹掉旧账；源设定变化创建新的冻结候选谱系，不能沿旧稿盲续。
- 根账至少限制物理请求数、输入+输出总 token liability、单请求输出和 elapsed budget；活跃执行墙钟累计跨重启，用户暂停不继续扣时间，不能靠新 session 清零。商业金额可显示估算但不当唯一硬帽。
- 每个物理请求一个 `attemptId/reservationId`。事务 `reserve → dispatch-marked → settled | unknown`；先持久 dispatch-marked 再发网。崩溃在标记与发送之间属于不确定已发送，保守占用；恢复不自动重发同 attempt。新的网络重试是新 attempt，原未知账不释放。
- reservation 至少为输入估计上界 + 协议允许的最大输出开销。若 reasoning 已包含 completion/total，仅作为分项记录，不重复加；若独立计费则另预留。provider 对 usage 的字段口径、估计方法/版本/安全余量都入非敏感 receipt。
- 只有可证明尚未 dispatch 的取消能释放。可信实际 usage 可向下结算；实际超估计仍如实记账并停止后续请求，不能截平账单。缺失/坏 usage 或发送后断网按 reservation 保守结算；provider 无法给可约束的总开销时禁止自动链式重试，转显式容量说明。
- S07 输出版本化 `BudgetPolicy`：输入估计、上下文余量、max output、批量、父剩余额与选值原因。数值由 S00 合成场景及现有已知能力校准，有限硬帽必须在启用前冻结；校准不是取消上限的授权。
- 输入过长先减少非必需材料/拆任务，不能削掉作者必需约束；用户配置、模型能力、输入余量与父硬帽各自解释，不再把 4K/8K 固定阶段帽当成模型能力。

验收：重复点击/重启/恢复/Agent 子调用共享正确 root；输入密集重试耗尽总帽；发送前后取消、unknown、reasoning 包含/独立、usage 超估计、并发 reserve 都有确定性 fixture。一次物理请求仅一 reservation/终态记录；同一预算不能并发超额发出两个请求。只证明会计安全，不承诺 provider 精确计费。

## C02 — 可见前缀、候选与恢复

采用**单调全文快照**，不用同时实现第二套 append log：单 owner 把 adapter 的 delta/cumulative 转为 canonical visible prefix，再以 `artifactId + attemptId + expectedRevision + nextRevision + textHash` 写入。只允许当前 epoch，CAS 成功才确认 durable revision；幂等重复返回原收据，乱序/回退/非前缀替换拒绝。UI 已保存状态由持久收据驱动。

每个 attempt 独立候选片段；网络重试不是恢复同一供应商 stream，不能根据重复字串猜测去重。delta 重放只有提供可信事件标识/明确累计前缀时才能规范化；无标识的连接重建一律新 attempt。不跨 attempt 原地 append；续写组合是显式、有原片段来源的候选操作，只有验证覆盖与重叠后才采用。

冻结 fingerprint 包括 projectId/session epoch、root action lineage、chapter brief/作者指导、选择的草稿/定稿依赖哈希、ContextSnapshot ID/哈希、模板字节、Skill 快照、模型租约/策略和输出契约。session 重开保留旧 candidate 可查看，但新 epoch 必须通过当前源校验取得恢复授权，不能把 epoch 变化等同内容授权。

每约 1 秒或 4 KiB flush，终止再 flush；终态与定时 flush 由 owner 排队，只有已提交最大 revision 可恢复。DB 错误停后续请求，可复制未保存内存尾段；不承诺断电零丢失。结构化残片可在明确的候选页面查看、复制、删除，绝不保存隐藏 reasoning 或内部工具机密。

验收：乱序 flush、重复快照、终态竞争、提交前后崩溃、epoch 过期、重连、模型/模板/Skill/正文变化、磁盘满；恢复恰好为最大已确认前缀。部分 JSON 不入正式表，完整项目键幂等提交，已完成大纲范围不重生成。

## C03 — 来源、候选准入与上下文

SourceRef 只索引现有事实，不建立第二份可写事实库。正文位置统一以 UTF-16 code unit（与 JS 编辑器一致）记 span，内容校验 hash 使用未改写文本的 UTF-8 字节；不得规范化作者原稿后声称 hash 相同。估计器另记字节/词元方法版本。

候选白名单只有：作者显式选择的当前草稿，或同一冻结 batch lineage 中成功保存且未被替换的直接前驱。partial、recovery、source-conflict、discarded、stale、跨 batch、未采用 revision 都不能按“最近/相关”自动选入。定稿证据与未定稿衔接文本分槽；后者不得写入角色/连续性事实。

ContextSnapshot 保存 source ID/revision/hash、候选状态/lineage/选择理由、必需覆盖、纳入/省略原因与估计量。候选被替换或依赖变更，使下游未接受成果成为冲突候选；不删除已有正文，不自动继续/定稿。角色与定稿派生索引 stale 时只可用于定位并回读原文，不能把 unknown/legacy 变成 author。

验收：同章双候选、废弃/冲突恢复、跨 batch、合法待审前驱、最终稿替换、未来计划/既成事实、长设定、stale 摘要、必需材料装不下。相同冻结输入在写/审/修入口采用同一种证据语义；不能把剧情树塞入正文或运行写作 Skill 脚本。

## C04 — 角色身份与批准

- `character_id` 永久不变。显示名可重用；别名具有项目/角色/来源或有效版本范围，查询结果为 `resolved/ambiguous/unresolved`，从不 first-match 或相似度合并。历史引用保留 ID 与当时显示快照。
- 旧 name-only 只有唯一且有来源的关联能自动绑定；歧义保留原字符串、source ref、候选 ID 集合，成为待确认 proposal，不编造指向。兼容 importer 的输出只能是确定绑定或待确认项。
- 切换后的正式关系、蓝图角色引用、连续性、审稿目标和 Agent 写入用 ID。模型可返回名字/提议，但必须经 resolver/批准边界；不接受名字当写入主键。
- 明确的“生成角色卡/导入并采用角色”可在已有预览确认中一次批量批准，复用当前 UI，不要求每人弹窗；静默蓝图同步、从正文推断、规划/导入提取默认 proposal。作者直接编辑确认的是 author；模型生成后作者采用保留 generated/derived 来源与批准收据，不把 AI 出身抹掉。
- 确认 effect、ID 赋值、关系重映射同事务，重复确认幂等；取消无半套关系。动态 author/derived/legacy 规则延续 ADR0017，不把静态来源标签覆盖动态来源。

验收：改名、名字交换、共享别名/称谓、两来源同名、相似名、自由文本关系、旧恢复候选、重复批准和中断；无静默合并、无任意绑定、正文原字节不变。未解决身份可以供作者查看；正式事实提交不能猜测填 ID。

## C05 — 审稿与实质改稿

finding 锚点为 sourceHash + span/occurrence + excerptHash + 规范类别 + 稳定事实/目标 ID。无法唯一定位为 unverified；不能仅用模型意见的自由文本当 key。比较规则版本化：生成输出后和人工合并后均检测完全相同/只不可见格式变更。

先确定性定位与 hunk 比较；选中意见的相关证据未改则 unresolved，不自动付费复核。只改无关位置不能令该项变绿。quote 删除但矛盾改写到别处不视为已解决，进入绑定 `mergedHash + findingSet` 的一次复核；每项需新证据、稳定目标与状态，缺失/坏 JSON/定位失败为 unknown 或 unresolved。

文学风格建议与客观错误分开，格式修复的可见标点变化按其原意判断，不能全都作为 substantive factual fix。重复意见仅在同稿本、同证据/类别合并。revision generated、merge committed、resolved、unresolved、unknown、author-waived 独立展示；waived 只能来自作者显式操作，保留原 hunk 不自动等同 waived。复核不绕过 C01，最多一次，无全绿自动循环。

验收：重复 quote、只标点/空白、无关 hunk、部分合并、保留原 hunk、换句保留错误、源稿改变、无证据/坏 JSON、提交后崩溃；不假绿，不破坏原子合并/outbox。

## C06 — 预注册中文质量门

S00 在首次实验前冻结：合成素材/模板/Skill、逐章必需事件与事实 oracle、严重度、段落复述定义、评分说明、对照顺序和调用预算。保存安全基线包：代码 SHA、模型/配置 revision、脱敏 endpoint fingerprint（不含查询凭据）、能力/采样参数、receipts、输出原文及哈希。正文限合成作品，密钥及其哈希不入证据。

完整对照 3 场景 × 3 章 × 两臂=18 章；依赖链在各自臂内独立，不能把候选臂较好的前章给基线。最终同时间窗交错两臂、随机匿名标签，执行顺序/seed 在看结果前冻结。远端模型版本不可锁时标记不可排除漂移；S00 老输出是历史参考，不能单独当最终因果对照。

每个候选章节必须：用户目标 ±20%；全部必需事件覆盖；指定身份、时间、知情、物品和计划/历史 oracle 零错误。任何一项失败均失败，不能被别章优点抵消。前章复述按预注册“非必要回顾中重复既有完整事件且占本章 >10% 单位”为失败（明确要求回顾的 fixture 另标），并给原文证据。

自然度、节奏、人物动机三个维度由两名未参与实现、非生成器自评的评审者逐章盲比较（劣/平/优，必须附证据）。**非劣**要求两人对所有章节/所有维度均不判劣；至少两个场景各一章在一个维度获两人一致优且其余维度非劣，才称本组样本改善。分歧由一次独立仲裁；无独立仲裁条件或仍无法确定则 inconclusive，不能按平局通过。作者可决定采用，但不能改写实验结论。

早期门：S07 章长/规划范围与预算；S10B 人物/证据/长设定衔接；S11 no-op/定向修稿。每门至少一个固定中文对照案例与相关确定性集均通过，才进下一质量门及 S13。失败可修代码后重测，但保留所有失败历史、明确新 revision，不挑优输出冒充首跑。

80 次是同一实验的总物理请求帽，包含 S00、早期对照、最终两臂、失败、重试、修复、审稿和复核。S00 先按必需路径分配并证明最小实验可容纳；不够则缩小可声明结论、报告未完成，不擅自扩帽。优先完成必需样本，不做无问题的无关重跑；模型不可用不换模型冒充通过。任何缺章/中止/网络失败保留在意向分析表。

## C07 — 单一 schema lane 与共享入口

S01 的集成 owner 独占项目 manifest 版本、单调 DB schema registry/runner、`electron/database.ts` 开库顺序及共享 IPC 注册。用一种既有 SQLite 可支持的版本机制（首选 `PRAGMA user_version`）；未知较高版本只读拒写，旧无版本库只能经有证据的 fingerprint 识别，不能凭列缺失随便修。

相对序列固定：M00 当前已知库规范基线（S04）→ M01 Run/Attempt/Artifact（S05）→ M02 ID/provenance（S08）→ M03 ReviewCycle（S11）→ M04 import ledger（S12）。S01 在最新 registry 上分配具体连续整数并冻结，不能让各 Agent 自取相同编号。表/列的小步可分子 migration，但顺序不得改变。DB migration、物理格式版本、模型配置 generation 不共用一个版本号。

开发者在自己的 module 提供 migration function/回填/fixture；只有集成 owner 在单一 lane 注册/执行，不并行开库迁移或改中心文件。每步声明 from/to、事务边界与重启判据，执行前后 integrity_check、foreign_key_check 及领域不变量。失败不开放写入。

开库流程为 read-only probe → 必要 schema migration → 验证 → session fencing → repositories/controller；probe/验证不得领取租约或把运行置失败。相同 schema 重开不再回填业务状态；fencing 作为单独可观测动作。S04 的物理 converter 先冻结 M00，再在 staging 中跑同一 registry 到目标版本，不能单独写第二套最终表结构。

## C08 — 迁移的物理提交点与全局启动门

### 项目

只在已关闭旧软件、有效项目身份/排他权及一致性快照成立后迁移。读取 WAL 用 SQLite backup；完成验证后关闭**源与目标** SQLite/LanceDB/枚举句柄。保留安装 appId 与单实例协调的兼容身份，不能因 global root 改名绕开旧版实例检测；不能证明无旧写者则阻塞该项目的原地升级。

journal 记录迁移 ID、原根真实路径、源/目标/备份指纹、源 schema、目标 schema 和物理阶段；放在可在开业务 DB 前读取的专用迁移位置。路径必须都在验证过的同卷项目范围内。每次 rename/提交都要 fsync 或平台等价持久策略，不把多目录 rename 伪装成一个原子动作。

| 物理阶段 | 允许动作与崩溃恢复 |
| --- | --- |
| prepared | 来源 `.vela` 活动；staging 未验证，禁止使用；失败仅清理任务自有可重建 staging。 |
| verified | 目标验证完成且句柄已关闭；来源仍唯一活动；可安全取消。 |
| legacy-isolated | 将整个项目 `.vela` 同卷 rename 到带迁移 ID 的不可发现隔离备份；不留旧 manifest/DB 或 symlink 别名。两格式暂均不开业务。 |
| target-installed | verified staging 原子 rename 为 `.ai-novel`；若 journal 落后，按指纹识别物理事实，确认旧路径已隔离后向前完成；不同时打开新旧库。 |
| switched | 新根唯一可写，正常 locator 不解析隔离备份；持久 generation/receipt 后才开放业务。 |

隔离后目标尚未安装：优先从已验证 staging 向前完成；staging 不可用且新格式未写入时，验证旧备份后恢复旧发现路径并撤销迁移。目标存在而旧路径也存在：未验证来源不开放写入；按 journal 指纹识别本次中间态并先隔离，未知双根需人工裁决，不合并。不能从目录存在推测成功。

至少 v1.1.0 和拟支持的 v1.0.0 安装二进制进入旧版重开矩阵；只有实测拒绝原根且不创建旧 DB 的版本可宣传安全原地升级。更旧/不可获版本不假定遵守 marker，提供单独新根导入副本（新 projectId + 来源 provenance），明确原项目与新副本不互相同步。新库写入后降级只可显式导出到独立旧版项目、新 ID；不原地恢复旧快照。备份按用户选择保留/回收，不自动销毁。

### 全局

唯一 startup migration coordinator 必须在 config 默认写入、skin/MCP/update、可写 controller 和普通 renderer 启动前运行；未完成时仅迁移 UI/只读诊断。不在 import module 顶层触发 ensure/write。先探测后创建本次 staging，避免默认空目录被当作者新配置。

`legacySourceLocator` 与 `canonicalTargetLocator` 分别注入；测试两者与 userData/会写状态全部指向合成隔离根，证明真实 home/appData 未变。旧环境变量仅兼容旧源；新显式变量名在 S01 固定，不能同一变量指两个写根。

models/config 为单 generation 提交：staging 写入模型、校验默认模型引用并重映射、原子切换 generation/locator。冲突只显示非密钥字段及“凭据不同”，不显示 Key/Key hash。损坏 JSON 保留并阻塞该对象裁决，不写默认覆盖。journal 区分本次未完成目标与用户已有目标，记录一次性切换；旧源之后改变只提示显式导入，不自动回灌。

## C09 — 资产处置、原文与退场

S00 的 disposition manifest 是 S04 前置输入；每个存在项必须归类，否则禁止切换。S13 逐项核销，不能只统计 Vela 命中数。

| 资产 | 强制动作 |
| --- | --- |
| project manifest、DB/WAL | 一致性迁移身份、正文、定稿/outbox、角色、导入/运行/恢复；验证数量/语义/原文字节哈希；WAL 不简单拷贝覆盖。 |
| LanceDB canonical chunks/documents | 原始全文与元数据，逐条保全并校验 ID、文档/块数、文本哈希、corpus kind；外部源已删也必须能读。 |
| chunks__space_* / embedding registry | 有证据可完整迁移；不兼容代际只在 canonical 文本保留后标 stale/待重建，禁止自动 embedding 付费。 |
| vectors.json 与旧迁移 journal | 依已有收据判断完整性；半迁移禁止从两套来源猜拼，先安全恢复/明确阻塞。 |
| 项目 prompts、Skill 文件/绑定 | 按原字节/引用迁移，阶段冻结保留；不因名称变化改写作者模板正文。 |
| partial_arch、所有可见 recovery | 迁为候选而非正式成果，源/状态不明标冲突，仍可查看/复制。 |
| 章节历史参数、UI 状态、release/import/outbox 证据 | 逐项 classify；活跃可恢复状态迁移，纯 UI 缓存可重建需非敏感说明；安全/落盘收据不能按 UI 缓存删。 |
| 已证明死文件 | 清单证明消费者为零；源保留在隔离备份，应用代码/依赖由 S13 删除。 |
| 未知文件 | legacy-backup-only，不删除/不执行/不默默导入；显示非敏感存在提示。 |

默认不跟随 symlink/junction/reparse point，拒绝通过 allowlist 扩展到项目外。必须读的已知资产只有 canonical realpath 位于授权根、类型和现有 capability 边界正确时才可消费；遇必需资产为外链则阻塞并请求作者整理，不假装迁移完成。隔离 rename 原目录保留未知文件/链接本身，不遍历链接内容。

验收：每类放非默认 fixture；外部 PDF 已删除、FTS-only、多代向量、半迁移、项目 Skill、恢复残片、未知文件、外链、Windows 句柄占用、深路径/大小写/目录移动。逐项报告 migrated/rebuilt/backup-only/blocked；无用户真实数据进入仓库或日志。
