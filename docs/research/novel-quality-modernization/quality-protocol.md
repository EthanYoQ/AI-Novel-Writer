# 中文质量预注册：Program v3 S00

现行 decision revision 为 `s14b-candidate-quality-and-comparison-v2`；`s14b-split-quality-gates-v1`、`s14b-reviewed-draft-v1` 及其结论保留为历史。candidate 字数标准仍采用 `draft-units-tolerance-30-v1`（2026-09-20 用户决定）；未来 post-UI 测试的评估策略 revision 为 `s14b-post-ui-reviewed-draft-must-show-unknown-v3`（用户批准采纳必现目标 unknown）；`s14b-post-ui-reviewed-draft-unknown-oracle-v2`（2026-09-27 用户批准 unknown 单独终点）保留为历史。保留 `pacing-readability-v1` 节奏规则。完整机器协议及其他 revision 见 [`protocol.json`](protocol.json)；新协议完整字节 hash 须重新冻结，旧目标拒绝漂移。本文件负责解释执行规则与冻结合同的显式取代关系。S10B/S11 的历史场景、失败和加性裁决保留各自版本；[日期化交接](../../handoffs/2026-09-20-program-v3-s11-pause-handoff.md)只证明当时状态，当前进度读唯一私有当前检查点。全部 Spec 的适用关系见[现行索引](current-spec-index.md)。合成验证、真实模型结果与文学质量结论分开记录。

## S14B 未来样本的门禁拆分

本 revision 仅适用于新冻结的 post-UI 与最终18章；事先冻结同一场景、seed、两臂顺序、次数和停止条件。生产链先通过技术门：baseline 原生产代码和原稿/成稿真实保存，正文 hash、来源、请求及项目身份、审修链、前驱和物理账本均可核验；candidate 同样须有完整技术终点。baseline 若在本地字数门抛错、缺 saved/后续审修或 full 前驱不可达，仍是技术无效，整组不得通过。第346–390行历史账本以原始字节 SHA-256 和15组 reserve/dispatch/settle 加性认证，原345行边界及全部历史失败不改。invocation `6df8518d-30ec-4b7c-9828-2393e751becf` 原 INCONCLUSIVE 不追溯改判。

第391–408行是旧 `s14b-split-quality-gates-v1` 协议在 invocation `0807270b-f5c5-495c-bd71-5f1d6e9a32c1` 下已经结算的六次真实请求：baseline 与 candidate 各三次，均为 reserve→dispatch→settle。`protocol.json` 的 `historicalPostUi408Boundary` 以原始前408行 SHA-256、顺序、attempt/invocation、终态和两臂 code/source/driver/parity 身份认证这一段；原390行边界和历史结论不改。第409行起的新增 reserve 必须使用当前协议 revision 与完整字节 hash；这次加性认证不恢复旧目标资格，也不将先前失败的 C16 预检 记成已派发。继续真实 C16 前须按新协议 hash 重新冻结目标。

第409–432行是同一 revision `s14b-candidate-quality-and-comparison-v2` 旧协议字节（hash `459faac1…4961`）下 C16–C18 真实 invocation `97b6ccf0-63b0-454e-97f5-71e5efc7b39c` 的八次 candidate-only 请求，均为 reserve→dispatch→settle，结论为永久 FAIL。`historicalC16Ee3435ecBoundary` 以原始前432行 SHA-256、顺序、attempt/invocation、终态、candidate 的 code（`ee3435ec`）/source/driver 身份及逐 attempt 的项目 parity（按 case 不同）认证这一段；该边界只登记 candidate 臂，出现 baseline 即拒绝。它只把这段视为历史，不改判、不恢复旧目标资格；第433行起的新增 reserve 必须使用当前协议 revision 与完整字节 hash。

第433–507行是同一 revision 旧协议字节（hash `7f4206ca…7092`）下的25次真实请求，均为 reserve→dispatch→settle：C16–C18 invocation `9cbac025-272e-489a-986a-e3fdf2568a04`（10次 candidate）、post-UI invocation `ae397af2-216d-4014-bb89-4b50ac72ae03`（baseline 3次、candidate 5次）与 C16–C18 invocation `24c90aec-80c8-411a-85b0-783c824ae7af`（7次 candidate，止于 C17-A）。`historicalC16Ccc70b31Boundary` 以原始前507行 SHA-256、顺序、attempt/invocation、终态、两臂 code/source/driver 身份，以及 baseline 整臂 parity、candidate 逐 attempt parity 加性认证这一段；它只把这段视为历史，不改判、不恢复旧目标资格。

第508–579行是同一 revision 旧协议字节（hash `68722f93…18e9`）下两次 C16–C18 candidate-only 真实 invocation 的24次请求，均为 reserve→dispatch→settle：`c9b88510-1c8d-4854-b589-714cf44b2d80`（第508–546行，13次，candidate code `4fc75f22`，结论 `FINALIZATION_EFFECT_MISSING`）与 `d8a30c11-95a7-46ad-8f22-82113fa95e8b`（第547–579行，11次，candidate code `5b6f0bf5`，结论 `CONTINUITY_CASE_EVIDENCE_MISSING`）。两次 candidate 代码身份不同，而 supersession 边界每臂只能登记一组 code/source/driver，因此按 `historicalC16Ccc70b31Boundary` 的同一规则拆成链在其后的 `historicalC16C9b88510Boundary`（507→546）与 `historicalC16D8a30c11Boundary`（546→579），各以原始前缀 SHA-256、顺序、attempt/invocation、终态、candidate 臂身份与逐 attempt parity 加性认证；只登记 candidate 臂。它们只把这段视为历史，不改判、不恢复旧目标资格。

第580–648行是同一 revision 旧协议字节（hash `a0a14777…990b`）下两次 C16–C18 candidate-only 真实 invocation 的23次请求，均为 reserve→dispatch→settle：`ca466d9a-cce5-4a30-a267-2a6d4044409a`（第580–615行，12次，candidate code `e797f2d2`，结论 `FINALIZATION_EFFECT_MISSING`）与 `73b46513-7371-4d9c-8ca1-671e3fd76349`（第616–648行，11次，candidate code `2275cdde`；自动结果 pending，两名独立评审 `review-r1.md`、`review-r2.md`（campaign 工作树 `.runtime/.cache/novel-quality-modernization/c16-c18-2275cdde-review-73b46513/`）均判 C17-B FAIL，其余六案 PASS）。两次 candidate 代码身份不同，按同一规则拆成链在 `historicalC16D8a30c11Boundary` 之后的 `historicalC16Ca466d9aBoundary`（579→615）与 `historicalC1673b46513Boundary`（615→648），各以原始前缀 SHA-256、顺序、attempt/invocation、终态、candidate 臂 code/source/driver 身份与逐 attempt parity 加性认证；只登记 candidate 臂，runner 的账本读写两入口都链到第648行。两段只视为历史，按原结论永久保留，不改判、不恢复旧目标资格。第649行起的新增 reserve 必须使用当前协议 revision 与完整字节 hash。

技术门有效后，candidate 自身资格逐章独立判定事实（含时间）、全部必需事件、±30% 生产单位、复述、来源，以及自然度、人物动机和节奏的双评可读底线；baseline 文学内容 FAIL/UNKNOWN 不自动否决 candidate，也不变成 baseline PASS。两名未参与实现的独立盲评者只依据冻结的 candidate 成稿与作者材料，分别给三维 PASS/FAIL/INCONCLUSIVE，并引用可回查的原文：自然度须对话、叙述和动作表达通顺且符合当章语境，无持续机械重复或语气断裂妨碍理解；人物动机须关键选择能从已知目标、处境和知情事实理解，选择与结果有可辨联系，无缺少依据的重大反转；节奏按下述四项可读要求。任一评审指出具体不合格片段或两人分歧，最多一次独立仲裁；确认具体缺陷为 FAIL，证据不足、无仲裁资源或仲裁未决为 candidate INCONCLUSIVE，不得 PASS。candidate 任一绝对门 FAIL/INCONCLUSIVE 时自身资格不得 PASS。

与 baseline 的自然度、人物动机、节奏比较另逐章逐维披露：两名盲评引用两臂原文并说明可比性；可比时记优/平/劣，不可比的该维记 INCONCLUSIVE，不得当作平或改善。相对劣或不可比不改变已成立的 candidate 自身资格；改善声明只能引用可比且有两名评审一致证据的章节与维度。至少两个场景各一章一个维度一致优、其余章节逐维可比且无劣，才可称整体样本改善；存在较弱或不可比维度，只能在证据覆盖的范围内称改善并完整披露，不能称整体 non-inferior 或全面优于参考。自动 runner 最高只报 pending-independent-oracle-review，文学裁决由独立评审作出，不从模型审稿结果推算。此拆分只适用于新冻结目标；历史 FAIL/INCONCLUSIVE、原评分、旧账本与原目标不追溯改判。

## 测试专用成稿评估（第一切片）

产品已支持作者显式的 `【第N章必现】` 目标及作者选择后的一次修稿；这不自动改变测试预授权，必须另有测试政策决定。用户已批准以下决定，现行 post-UI 评估策略为 `s14b-post-ui-reviewed-draft-must-show-unknown-v3`，场景 revision 为 `s14b-post-ui-reviewed-budget-review-rebuild-must-show-v2`，只适用于未来一轮 S14B post-UI 固定实验场景1/1；early、full、C16–C18 的选择与场景不变。新场景 revision 只增加上述输入标记，继承原 `s14b-post-ui-reviewed-budget-review-rebuild-v1` 的全部登记，包括 `指定范围生成` 的一次结构化语法修复和 `成稿首审` 的一次 `review-chapter-rebuild`（见下文 S07 段），并非不带 rebuild 的新场景。

- 输入标记：该场景 revision 只在场景1作者世界设定末尾加入独立一行 `【第1章必现】林澄保管铜钥匙`（语义源 `scenarioAuthorSettingLines`）；原场景其余事实、事件、字数和 oracle 不变，其他 milestone/场景 revision 的作者设定字节不变。
- 选择范围：首审报告中全部 error/warning，加上 `goalId` 匹配 `^ch\d+:mustShow:\d+$`（本场景即 `ch1:mustShow:K`）且 severity 为 unknown 的项，按原报告顺序；与 error/warning 共用至多一次修稿与一次普通复评，`maxRevisions` 仍为 1。其余 unknown（蓝图 keyEvents、覆盖不完整）不采纳。
- 确认含义：视为作者已同意补写（测试预授权），确认快照原样保留 unknown，不得改称已确认错误；初稿、原 unknown 报告、确认快照、唯一修订、复评全部保留文件与 hash。
- 双臂实际路径：candidate 由生产 `freezeChapterGoals` 从作者世界设定解析标记，审稿报告 `items` 中出现带 `goalId` 的 unknown 投影，并由 review-cycle finding 绑定后经既有确认与修稿入口 apply。baseline（`2264390d`，不可改）不识别该标记，只把这行当普通设定文本，首审不会有 mustShow 项，其 unknown 只可能来自蓝图 keyEvents 或覆盖不完整，均不被采纳：首审有 error/warning 时仍按原规则只采纳 error/warning 修稿一次并复评，无 error/warning 时按原 unknown-only 规则保留初稿。candidate 被采纳的必现 unknown 确认项必须带产品 review-cycle 的 `findingId`，缺失即判审修链证据无效；baseline 没有 review-cycle，不要求。该不对称写入策略 `armAsymmetry` 字段，随协议、pair manifest 与每臂 receipt 披露；不得据此单独声称相对改善。
- 停止条件：首稿自然满足（无可采纳项）时记录修复分支未触发，不得制造触发；复评仍有问题也不追加修稿。

以下 `s14b-post-ui-reviewed-draft-unknown-oracle-v2` 段落及 `s14b-post-ui-reviewed-budget-review-rebuild-v1` 场景保留为历史 revision：它只采纳 error/warning；现行 driver 不再按其校验，旧目标因协议 hash 漂移被拒绝属预期，旧结论不追溯改判。除上述选择范围外，v3 沿用其余执行规则。

`s14b-post-ui-reviewed-draft-unknown-oracle-v2` 仅适用于未来 `post-ui early-budget` 资格测试；本切片不扩展 full、early-context 或 S11，不改变软件默认创作、自动审稿、确认、修稿或定稿流程。两臂均调用既有生产入口：生成并保存初稿、普通审稿；报告存在 error/warning 时，即使同时有 unknown，也只按原报告顺序预先授权采纳全部 error/warning，保存确认快照，执行一次修稿并接受唯一修订，再对修后全文普通审稿一次。全部 pass 时保留初稿，记录 `no-actionable-review`。仅 pass/unknown 且没有 error/warning 时，冻结初稿与完整原报告，记录单独的 `no-actionable-review-with-unresolved-goals`；不确认、不修稿、不复审，不把 unknown 改为 pass。复评仍有问题也不追加修稿或改选初稿。确认与合并是测试预授权规则，不冒称作者现场逐项核实。

两臂复评均使用普通审稿入口，不冒充旧版具有候选版原生定向复核状态机；既有 finding 状态不因此改为 resolved。初稿、原审稿、确认快照、唯一修订、合并正文和复评分别保留文件与 hash，最终评审正文须与数据库回读和 receipt 一致。请求按真实 attempt 继续 reserve/dispatch/settle/unknown；策略、协议字节、驱动、实际代码 SHA 和来源均随新目标冻结。旧目标拒绝新协议；真实执行前须将此前账本完整前缀重新登记为只读历史，不能改写原账本。

独立评审只对固定终点正文作本 revision 的结论，报告同时披露初稿到成稿的变化与成本。`unknown` 终点的每个必需目标须用可回查且符合既有逐字引文规则的原文证据逐项补足，并独立核查没有已识别待修缺陷；无法核实为 inconclusive，具体缺陷为 FAIL。事实、全部事件、现行字数、复述、来源及两名盲评要求均保留；自然度、动机、节奏按本 revision 的 candidate 独立可读底线判资格，相对比较只判改善声明；自动状态最高 `pending-independent-oracle-review`。模型审稿 pass 不是独立质量 PASS。原276/288行历史边界保留，新289–327行旧绑定以完整前缀 hash 和13组 reserve/dispatch/terminal 加性认证，末项 `unknown` 原样保留；invocation `13f33d55-016a-4db1-9993-c62f8f122ed7` 技术 FAIL 不改。所有旧 FAIL 原样保留，不追溯改判，不重采挑优。两臂合计无修稿需6次请求，两臂均修一次需10次；既有规划语法修复和新登记的首审语法重建各最多每臂一次，因此登记最大计划路径14次。原80次是历史计划分配而非硬帽，新增审修请求按真实 operation 计入既有失败/审修余量并单独披露；本切片不申请真实调用。原327行边界不变，invocation `a5be6f35-3568-4147-a238-403c67f4acfd` 的第328–345行另以原始字节 SHA-256 和六组 reserve/dispatch/settle 加性认证；baseline 首审非法 JSON 与旧 FAIL 不改。

## 现行交付顺序与复用

[现行变更规格](frontend-transition-specs.md)与[实施计划](frontend-transition-plan.md)区分核心可交接和最终产品资格：当前弃用 Writer 不再收齐旧 F05，核心工作与 PR #262 V3 接入可按依赖推进。新 V3 的 F04 完成、F05 确定性 Final 及 S13 完整清理后，S14A 才冻结最终候选。三份 post-UI 在冻结后与 S14B 共用配置核验和实际双臂零模型 dry-run；在最终汇合前保持待资格，不能提前写 F05 整体 PASS。核心里程碑不代替模型、升级或发布门。

post-UI 样本只在固定案例的触发条件、断言、两臂原始产物及独立评审完整覆盖最终案例时复用；逐 case 记录原 receipt、实际 `testedSha` 和断言对应。未覆盖案例照常执行。原始失败、物理账本和历史结论不改写；仅因文档变化不重跑模型。相关代码、配置或 driver 变化按实际影响重新资格。

## 现行字数标准

自本 revision 起，生产草稿目标与后续质量验收统一采用 **±30%（70%–130%）**，逐章判定。计数仍使用 `src/shared/draft-units.ts` 的 v3 draft-units 算法，下界向下取整、上界向上取整；900、2000、3000 单位的区间分别为 630–1170、1400–2600、2100–3900。

本 delta 仅取代冻结内核包 `01-PLAN.md`、`03-CONTRACTS-AND-GATES.md` C06、`specs/S07.md` 与 `specs/S14B.md` 的 ±20% 字数约束，并随 Program v3 覆盖合同一起使用。冻结包字节保持不变；所有必需事件、事实、复述与独立文学评审门继续有效。旧版 baseline 仍是冻结参考，其本地字数门及失败证据按原代码的 ±20% 解释，再按本文件的参考臂裁决规则处理；不修改旧版，不把参考失败自动等同于 candidate 失败。candidate 必须通过现行绝对门。

旧协议、原始产物和历史 PASS/FAIL 保留原标准，不按 ±30% 追溯改判，也不因此重启已完成的 S10B/S11。新实验必须提交并重新冻结当前 candidate、协议 hash 和 revision；已有 target 不能继续冒用。旧版 222 行认证边界的原始 SHA256 `00e07f37fd55e9c0c7cc304ab81c61a17df3956f0e7402cb6d3ac0c1c6fcf6d4` 保持有效；当前协议将其超集前 231 行（新增一次 post-UI 正式 FAIL 的三组 reserve→dispatch→settle）原字节认证为新边界。既有账本和该次 FAIL 不改写，新请求继续进入同一账本。此政策调整与确定性测试本身不构成最终模型质量资格。

## 冻结样本与判断

三场景分别为旧港来信、山城药铺、长夜观星台，每场景三章，目标依次为900、2000、3000生产draft-units单位；两臂最终共18章。逐章±30%、所有必需事件、身份/时间/知情/物品/计划历史零错误是并列硬门。不得用跨章平均或自然度弥补事实失败。

未来新冻结的盲评包须依据作者素材、当章事件与实际蓝图区分以下三类，逐项注明类别、来源和核查证据；上述 unknown 终点补证同样按此区分：

- 持续背景事实与禁止事项：检查正文中可达的矛盾；未提及不等于错误，也不等于正文已重新证明该事实。
- 当章冻结的必需事件与蓝图明确指定的呈现：须有积极、可回查的原文证据；不能用背景设定或未见矛盾代替实际发生或呈现。
- 有限视角下的人物猜测与世界事实分开判断；不能仅凭人物尚未确认就认定作者事实被改写，正文明确建立相反事实仍为 FAIL，实质歧义仍为 INCONCLUSIVE。

此分类只澄清未来测试的举证规则，不改变既有硬门、两名独立盲评与一次仲裁要求、机器协议字节或 revision，也不改变软件默认流程。`77928d0b` 本次原 FAIL、原盲评和 rubric 保持不变，不追溯改判，不授权同案再采。

每臂前章独立生成、保存并供本臂后章使用。早期第二章案例使用语义源指定的作者前情，不能把另一臂的输出借入。S00 的 legacy/canonical 语义包仍只是格式合同材料；S07 early-budget 另从同一语义源构造各目标原生物理项目，并经实际 SQLite、提示词读取和模型配置入口回读 parity。此构造不声称验证旧项目迁移或其他阶段的项目 fixture。

复述判定：标注前章完整事件与本章非必要回顾的UTF-16 spans，以生产单位计数；重复既有完整事件超过本章10%失败。必须保存原文及hash，不能只按字符串相似度替代人工事件定位。后续新冻结的 post-UI 与最终18章按本文件开头的 candidate 自身资格及独立比较拆分执行。节奏可读底线为：主要动作及顺序可追踪、必需情节实际发生、关键选择及其结果可识别、重复描写或心理回绕没有实质阻断本章推进。两名独立评审须对自然度、动机、节奏分别按预先冻结的最低描述及本节节奏四项判断，保留原文证据；一次仲裁及证据不足的 INCONCLUSIVE 规则同上。事实、必需事件、字数±30%、复述≤10%及来源门不变。本节对新目标取代冻结 S14B 的三维相对无劣资格门；逐章逐维比较继续披露并只支持有证据的改善声明。历史 FAIL 和原评分不追溯改判。

顺序固定在协议中，最终同时间窗交错两臂。seed固定；主集成者看输出前生成随机匿名标签并私存映射。远端版本不能锁定则记录可能漂移。所有失败、中止、缺章、重试进入意向分析表，旧S00输出不能代替最终baseline。

### S10B 决策 revision

`s10b-reference-baseline-v2` 只改变成对结果的裁决，不改 campaign、语义样本、物理账本或历史事实。冻结 baseline 是参考臂：只有其本地 `TARGET_UNITS_FAILED` 同时带有结构化字数门身份、持久化观察和 hash 可复核正文时，才记为 `reference-nonconforming`，不再自动否决满足绝对门的 candidate。baseline 的 provider/IPC 失败、缺产物或产物不可验证仍是无效对照，整对失败；不得用错误字符串猜测原因。

本历史 revision 的 candidate 单位门为 80%–120%；后续执行使用上文现行 ±30% 标准，并须提供可复核保存产物。自动门通过后的最高状态只是 `pending-independent-oracle-review`；必需事件、事实、recap 和 style 必须由未参与实现的独立评审者检查，runner exit 0 或字数合格不能写成质量 PASS。

旧 revision `s10b-paired-hard-gate-v1` 的两次失败 invocation `5b460511-b426-42e1-b8c3-903ff25668f9`、`f5291452-2bf6-4344-9677-d8cc75bbb7c6` 永久保留在 intention-to-treat 中；本 revision 不追溯改判、不删除、不挑优。S10B scenario v1 invocation `e8900180-945a-4211-b0c9-8427389c0625` 同样永久保留：两位独立评审一致判定 candidate 虽通过绝对事件、事实与 recap，但自然度、节奏、人物动机三维均劣于 reference，质量结论为 FAIL。scenario v2 invocation `5a7f78fd-d0db-4b63-8564-bdce426b73f0` 也永久保留：实际正文在两位独立评审中都发生时点与节奏失败；但该 pair 同时违反生成权威与前驱准入前提，因此只能记为 `observed-quality-failure-experiment-inconclusive`，不能用于 candidate 因果归因，也不能放行。scenario v3 改用第三章：第二章作者前情是唯一必需当前前驱，第一章中性旧档是独立的可选当前候选，从而符合主进程“每章只允许当前草稿”的来源约束；逐章时点写入作者可见 guidance。可选旧档仍可按预算省略，必需前驱装不下则容量冲突。协议文件完整字节 hash 与 `decisionRevision` 必须同时写入新冻结目标、每条新 reserve 和每份桥收据。协议以 `historicalLedgerBoundary` 及已登记的 supersession 边界逐段冻结既有物理账本的原始字节 hash；具体行数、证据 invocation 与 reserve attempt 以 `protocol.json` 为准；历史段内 legacy/旧 binding 只读保留，第580行起的每条 reserve 一律必须等于当前 binding。任一前缀缺失、字节漂移或新 reserve 缺少当前 binding 均拒绝；旧 target 在协议漂移后 fail closed，必须重新冻结才能实验。

### S11 场景 revision

`s11-early-review-per-attempt-deadline-v3` 只用于新的 `early-review` 冻结目标。它保留 v2 的已实现代价语义与两臂三操作、同 root、逐层 hash、一次复核和全部物理账本要求，并继续固定 `model-positive-is-pending-author-verification-v2`：模型给出的唯一逐字证据只证明证据可定位，不能独自把 finding 写成 `resolved`；正向判断落为 `unknown` 等待作者核实，负向判断仍可落为 `unresolved`，不增加第二次复核。历史收据继续按各自版本验证。

invocation `48fa1d89-d3b3-4aa7-9881-fa842ae3e974` 与 `e83f9577-45d0-4bfd-9414-3b296db03fb8` 永久保留为实际质量失败：两次 candidate 都只把“暂不承担任何代价”改成抽象的“承担代价”，未呈现具体代价；后一轮还记录了 baseline 第三操作未持久化。invocation `e55774ec-b72b-44cb-bd0b-16a31c19f453` 因历史账本边界漂移在 provider 发送前失败，保留为技术失败；invocation `77ee6fa8-91ff-43a5-b0ad-e1d16f799a01` 的六次物理调用和技术链有效，但 candidate 只签字承担未来看守责任，没有发生具体损失，独立内容结论为质量 FAIL。新 revision 不追溯改判、不挑优。

v2 将源稿改为自然行为链：正文提供留守、即时垫付与牺牲设备电量等多种现实代价的情境可供性，但不泄露固定答案。review finding、作者确认与修稿/复核合同统一使用中立三项标准：人物已执行选择、损失或牺牲已经发生、后文没有反证。签字认责、保证负责、未来承诺和简单否定翻转都不算代价。夹具确定性反例必须拒绝这些词面修补，并至少接受两种不同的有效修订，以证明没有锁定唯一答案。不得增加生产正则语义门；v2 fail-closed 与独立内容 oracle 继续承担最终质量裁决。

v2 invocation `70964dde-14b2-437a-9dc1-414f6a06c040` 永久保留为 invalid reference：candidate 三操作与内容质量独立通过，但 baseline 一次复核在全桥共享的 480 秒结算守卫到点后记为 `unknown`，缺少第三产物，pair 技术门正确失败。v3 只修正 runner 预算作用域：每个已 dispatch attempt 从自己的发送时刻获得完整 480 秒结算预算；三操作外层 spawn/test 预算覆盖三个完整 attempt；超时时仍先写带稳定原因码的 `unknown` 再 abort。不得以 v3 追溯改判 v2。runner 的最高自动状态仍为 `pending-independent-oracle-review`；只有 pair 技术门和独立内容绝对门都通过，才可把 S11 质量层记为 PASS。

加性裁决 `s11-reference-no-actionable-review-v1` 落实已批准的“旧版只作参考”语义，不覆写原 pair receipt，也不补造 baseline 的修稿或复核。它只接受一种窄形状：baseline 唯一审稿请求已在物理账本 `settle(stop)`，原始审稿 artifact 与 receipt hash 可核验且 items 全部为 pass，调用轨迹只有一次模型生成和一次审稿持久化并以 `db:review-get-full` 结束；此时从可观察终态派生 `baseline-all-pass-review-terminal`，记为 `reference-nonconforming-no-actionable-review`，不把历史 redacted 错误猜成某个异常码。candidate 仍须完整通过三操作、同 root、逐层 hash、正式 effect、保存与单次复核技术链，自动结果最高为 `pending-independent-oracle`，再由未参与实现者检查全部绝对内容门。缺少 artifact/hash、调用轨迹、结算或 candidate 任一证据均 fail closed。历史原始 FAIL 永久保留，新裁决是独立派生证据，不追溯修改原收据。

## 唯一总账（无调用硬上限，记账不变）

**2026-09-18 用户决定移除真实调用硬上限。** 原先的 80 次总帽不再拒绝请求；它降级为**计划分配额**（协议里的 `plannedCallAllocation`），用于一致性校验与汇报。这是对冻结规划 `docs/plans/novel-quality-modernization/03-CONTRACTS-AND-GATES.md` 中"不擅自扩帽"一句的**有意取代**，记录见 `docs/adr/0019-remove-real-call-hard-cap.md`。受审规划字节未被改写。

计划分配（仍是分阶段设计的样本量，不是上限）：S00 0；early三门4+2+6；post-UI重跑三门4+2+6；最终18章；规划6；C16既有提取6；备份恢复继续创作4；失败/重试/修复/审稿/复核余量22，合计80。一次逻辑动作可能消耗多次物理调用；此表是可容纳的最小路径，不保证输出、自动续写或失败路径都在配额内成功。

**上限是决策，记账是证据。** 硬上限移除后，账本的地位更重要而不是更轻：每一次真实发送（包括失败、unknown、重试）仍必须逐条进入同一账本，花费因此仍然完整可审计。移除的是"拒绝"，不是"记录"。

正式集成必须固定 `.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl` 为本次campaign唯一账本，所有owner消费它。`updateLedger`持有排他wx锁，逐条append+fsync；锁存在不抢占，残缺记录拒绝继续。reserve先占位，dispatch先落盘再发网络；仅reserve可取消释放，dispatch后settle/unknown均占位。重试用新attempt，不能复用未知请求。调用后缺失usage仍以预留保守记账；本账本仅管实验物理次数，产品token/时间预算仍需S07 C01生产账本，不能拿这个替代。

S07 的 early-budget 驱动在每次最终 provider fetch 前持锁 reserve→dispatch。重复物理发送单独记录，不抵消后续阶段的样本义务，也不按皮肤扩样或开新账。真实模式使用上述 campaign 总账；合成模式使用明确标注的独立模拟账本。网络流结束后 settle/unknown，未知不得退款；前置失败不伪造已发送。结论缺少所需样本或证据时为 blocked/inconclusive，不能仅因超过计划次数拒绝请求，也不能因继续调用而自动判定通过。其他阶段仍须接入同一账本，未实现的阶段拒绝执行。

### campaign 身份取代与复验边界

2026-09-19 在 `972a073` 工作树只读核对：`protocol.json` 已使用 `plannedCallAllocation: 80`，`id` 保留 `novel-quality-program-v3-80-v1`；[ADR0019](../../adr/0019-remove-real-call-hard-cap.md) 第 5 项要求执行账本使用 `novel-quality-program-v3-uncapped-v1`。`scripts/quality-modernization-run.mjs` 的 `CAMPAIGN_ID_SUPERSESSION` / `campaignIdFor` 已显式映射二者，并导出 `CAMPAIGN_ID`。这不是尚待实现的映射，也不能仅凭字面差异判定混账。接手时仍须核对实际 runner/bridge/manifest 与历史账本的身份一致性；本次只读源码核对不代替运行证据。不要直接修改协议 ID、重命名旧账本或重复实现映射。

获准安全参数：provider=`openai`、protocol=`openai`、endpointHost=`api.siliconflow.cn`、modelName=`deepseek-ai/DeepSeek-V4-Flash`、temperature=0.7、maxTokens=16384。配置declared context=null/output=16384/reasoning=false/structuredOutput=false/usage=false不等于实测能力；不推测结构化支持、usage或上下文上限。密钥只通过现有安全模型入口，禁止fixture/receipt/日志携带密钥或密钥hash。旧qualification driver模拟的其他模型名称仅是其自带模拟样本，绝不是正式获准provider配置。

## 可运行入口及证据边界

```
node scripts/quality-modernization-run.mjs help
node scripts/quality-modernization-run.mjs baseline-probe --targets <私有execution-targets.json>
node scripts/quality-modernization-run.mjs dry-run --targets <真实双目标execution-targets.json>
node scripts/quality-modernization-run.mjs early-budget --targets <双目标> --milestone early
node scripts/quality-modernization-run.mjs early-context --targets <双目标> --milestone post-ui
node scripts/quality-modernization-run.mjs early-review --targets <双目标> --milestone post-ui
node scripts/quality-modernization-run.mjs full --targets <双目标> --milestone final --mode synthetic
pnpm exec vitest run scripts/__tests__/quality-modernization-run.test.mjs
```

help不启动目标。baseline-probe实际运行独立冻结树的既有 `real-provider-generation-qualification.mjs --dry-run`，网络阻断且不传秘密环境；该driver以模拟completion触达生产generation runtime。`quality-modernization-driver.mjs`另外调用目标树已有三条测试，实际触达规划、正文、审稿command：精确范围提交、900目标80%边界、审稿仅定稿历史来源。其IPC是注入测试边界，不是数据库/Electron启动证据。三个入口fixture为中文，不跑英文产品用例。

manifest绑定协议 decision revision 与完整协议字节 hash、实际HEAD、仅src/electron生产实现hash（排除tests/fixtures/stories）、独立scripts/package/lock工具hash、既有driver hash与当前runner adapter hash、四个隔离根及fixture字节hash。排除plugins/DSH、计划/报告/缓存；隔离根必须在本工作树任务cache内，realpath检查防交叉、链接逃逸。双目标不能同HEAD/同实现源hash/同realpath，即使标签不同也拒绝；candidate subjectSha必须等于其实际codeSha，参数/作者素材/格式不等拒绝。两个真实目标均启动探针后dry-run才可报通过。hash是完整性而非签名，恶意修改runner本身不在此资格范围。

schemaVersion=1 的 S00 manifests 保持历史探针行为，formal 阶段仍返回 exit2 `PRODUCTION_COMMAND_DRIVER_NOT_INTEGRATED`。schemaVersion=2 的三个 early selector 与 full 使用下述默认生产桥。baseline 生产源码保持原样。

## S07 默认生产双路径与冻结顺序

新桥位于 `scripts/fixtures/quality-modernization-production.fixture.mjs`。它实例化各目标的默认 `GenerateDirectoryCommand`、`GenerateDraftCommand`，不传 `createRuntime`、completion、repository 或 command dependencies。Electron 的传输外壳由测试桥实现，处理器、项目权限、模型租约、provider、解析、提交均调用各目标实际源码；SQLite 使用真实隔离文件。候选臂走已注册的 generation main owner，基线走其原有 renderer runtime 和注册 LLM controller。两者都在同一个最终 fetch 边界切换 synthetic/real；不存在直接 API 质量实验器。

candidate 每次发送前从实际 fixture 数据库查询唯一 `dispatch-marked` attempt，并核对当前默认 command 持有的 project/epoch/root/run、attemptId 和真正输出上限；零条、多条或不匹配都拒发。收尾再核对原 attempt 的 stop、artifact 与正式 effect。已知 stop 且 usage 不可信时保留产品账本的 unknown liability，不谎称可信用量或失败退款。baseline 不伪造它没有的 main attempt，使用独立物理 ID 并绑定原实现哈希。

`early-budget` 的 `s14b-post-ui-budget-syntax-repair-v1` 只让 post-UI `指定范围生成` 在两臂首发之后，各按现有产品路径增加最多一次 `chapter-blueprint-directory:structured-syntax-repair`。candidate 从唯一 SQLite owner attempt 的 `usage_receipt_json.purpose` 证明主发与修复身份，并保持原 run/root/project/epoch；baseline 从实际 `llm:generate-stream` IPC 的 requestId、purpose 与当前 run/session 证明归属，不伪造 main owner。额外请求仍逐次写入唯一物理账本和桥收据、保存每次可核验输出；缺身份、其他 retry 或第三次请求在发送前拒绝。pair 技术门允许这一次已登记修复，但实际产品失败、缺产物或独立质量门失败仍为 FAIL。全局 `draft-units-tolerance-30-v1` 字数标准与历史 FAIL 均不改判。

`s14b-post-ui-reviewed-budget-review-rebuild-v1` 及继承它的现行 `s14b-post-ui-reviewed-budget-review-rebuild-must-show-v2` 另为 post-UI `成稿首审` 登记一次产品已有的 `review-chapter-rebuild`：首发必须是同一草稿的 `review-chapter`，已在唯一账本 settle，原输出文件与哈希相符，按产品 parseReviewGenerationResult 的 fenced JSON 提取和 JSON.parse 确认语法错误，且草稿尚无已保存的审稿报告。重建请求须沿用同一 run、root action、project、epoch、草稿身份，第二次重建和其他 retry 在 reserve 前拒绝。有效但含 error/warning/unknown 的报告不得借此重建；重建后仍按原审稿合同和独立质量门验收，初次坏输出与替代输出均保留。

两臂的模板输入采用对称映射：从不可变 baseline `2264390d6fb8b052cc14736d544df0cc74516649` 提取 `chapter_blueprint_chunk` 和 `first_chapter_draft` 的完整原模板；两臂作为相同的自定义作者模板读回。语义源那句无占位符的 `template` 完整写入双方 `globalGuidance`，不会用它覆盖生产模板并丢掉作者素材。模板原字节、guidance 字节、实际项目回读哈希保存在私有 receipt；各臂编译后的 system/完整 prompt 哈希另列，允许体现实现差异。角色原始名字与身份约束完整保存在作者素材及主角档案，本门不凭名字凭空创建已批准角色卡。第二、三章作者预置蓝图用于验证本次第1章范围提交没有改写范围外内容。

执行环境由每臂实际探针及冻结 manifest 决定，不沿用历史运行的 Node/Electron ABI 数字。基线若使用 Electron executable 的 `ELECTRON_RUN_AS_NODE=1`，仍须核对该 executable、实际 ABI 和其自身 better-sqlite3；候选同样实际加载其对应运行时的 better-sqlite3 并查询。不能把 package 版本或历史 native 收据当加载证明；共享工作树的 ABI 切换串行，不改基线源码。差异写入 manifest，不声称环境完全相同，也不声称这是安装版 Electron UI 验收。

开发阶段先运行（只能生成 `development-only-unfrozen` 收据）：

```powershell
node scripts/quality-modernization-run.mjs development-synthetic --baseline-root <已登记baseline工作树> --output .runtime/.cache/novel-quality-modernization/s07-development-targets.json
node node_modules/vitest/vitest.mjs run scripts/__tests__/quality-modernization-run.test.mjs
```

主集成者完成本片全部源码与驱动提交后，才冻结正式目标：

```powershell
node scripts/quality-modernization-run.mjs freeze-targets --baseline-root <同一baseline工作树> --output .runtime/.cache/novel-quality-modernization/s07-targets.json --model-id <获准模型ID>
node scripts/quality-modernization-run.mjs dry-run --targets .runtime/.cache/novel-quality-modernization/s07-targets.json
```

freeze 拒绝未提交 candidate、未提交驱动、变更的 baseline；manifest 绑定目标源、执行工具、桥、native 二进制和固定启动身份。每次执行在其四个隔离根下建立新的短路径子目录，dry-run 不污染随后真实执行的项目。原有目录/receipt 不覆盖，所有输出与失败保留。

真实执行由主集成者在候选提交与 dry-run 通过后顺序开展。先通过已有安全配置路径，把获准模型记录注入每臂 manifest 指定的隔离 `config/models.json`，不从脚本自动寻找用户 home，不把 key 或其 hash 放进参数、fixture 或 receipt。驱动只读取明确模型 ID，核对预注册 provider、protocol、modelName、endpointHost、temperature 与 maxTokens，拒绝无凭据或参数漂移：

```powershell
node scripts/quality-modernization-run.mjs early-budget --targets .runtime/.cache/novel-quality-modernization/s07-targets.json --milestone early --mode real
```

裸 early-budget 不默认发模型，必须显式选择模式。兼容 `--phase early-budget --dry-run` 写法，但 `--protocol` 只接受实际 `docs/research/novel-quality-modernization/protocol.json`；冻结旧 Spec 示例中不存在的 test/fixtures 路径不会被悄悄替换。退出码0只表示自动/合成技术检查成功，不代表质量通过；1表示自动执行失败，2表示前置阻断，3表示已取得可评审产物但仍为 `pending-independent-oracle-review`。真实结果须独立评审原文事件、事实和质量，不能把 runner exit 0、合成正文或字数合格直接记为 C06 PASS。

## Full 连续生产执行

`full` 固定为 `final` milestone，执行登记 `s14b-full-continuous-project-v1`。每场景每臂只 prepare 一个独立物理项目，三章持续重开其原 SQLite 数据库。先完成六次 `三章规划`：场景1 baseline/candidate、场景2 candidate/baseline、场景3 baseline/candidate；每次通过 `GenerateDirectoryCommand` 生成并保存第1至3章蓝图。随后按 protocol.order 的原 seed、caseIds 与九组 armsByChapter 顺序完成十八次 `连续章节正文`。规划分配 `finalPlanning=6`，正文分配 `finalChapters=18`，full 最小物理请求数合计24；重复 slot 仍归失败/重试余量，不重置历史占用。

后章 `GenerateDraftCommand` 读取本臂已保存蓝图；前驱由本臂实际生成并保存的上一章收据指定项目、章节、draftId、version、正文 hash 和字节数，再经生产 `db:draft-get-full` 核验原文。正文通过既有 selectedCandidateDrafts 路径送入提示词，发送前检查真实前章结尾与 candidate 来源绑定。full 不使用 early-context 的作者预置前情或可选旧档，也不使用 early-review 的预置缺陷稿。两臂起始作者资料、模型、模板和 Skill 绑定必须相同；各臂生成后的蓝图和正文允许不同，初始 parity 与逐章前驱证据分别记录。

每次规划、正文有独立请求和收据目录，不覆盖前章输出。失败立即停止后续发送，保留失败与未运行列表；缺章、顺序错配、项目或前驱错绑不能汇总为成功。账本继续逐请求 reserve/dispatch/settle/unknown，调用方对账负责异常终止收口。现有 historicalLedgerBoundary 认证协议更新前的原始前缀；新绑定只适用于新调用，旧账字节、旧 FAIL 与 testedSha 保留。

```powershell
node scripts/quality-modernization-run.mjs development-synthetic --baseline-root <已登记baseline工作树> --output .runtime/.cache/novel-quality-modernization/full-development-targets.json --scenario full
node scripts/quality-modernization-run.mjs full --targets <新HEAD冻结双目标> --milestone final --mode real --physical-ledger <现有唯一物理账本绝对路径>
```

合成路径只验证24次边界、18章落盘及接续，`qualityQualification=not-run`；正式执行仍须满足 S14B 前置，自动结果最高为 `pending-independent-oracle-review`。C16 既有提取6次及 C17/C18 恢复继续4次仍是单独义务，full 不替代其执行、记账或验收。

## C16、C17、C18与编辑门

`c16-c18` 是 `final` 下独立的 candidate-only 阶段，复用四个生产操作：定稿章节要点、角色状态、本地归档恢复后续写、WebDAV 选定世代恢复后续写。`continuityQualificationCases` 登记七个案例：C16-A 有效来源更新 derived、C16-B author 冲突、C16-C 同章重新定稿替换旧源，各执行 notes/cards 两次，归入原 `C16ExistingExtraction` 的6次；C17-A 恢复有效 source、C17-B 恢复后正常重新定稿使旧 derived 失效、C18-A 选定世代、C18-B 两完整分支明确选一，各执行一次 `GenerateDraftCommand`，归入原 `C17C18RestoreContinue` 的4次。准备、重试及角色状态原生 repair 如产生请求，均逐实际 attempt 记账；repair 仅接受同 run/root 的持久前序失败 artifact。早门和 full 的双臂设计不变，本阶段不触发 full 的6次规划/18章判定。离线合成通过只证明接线，正式质量资格仍需冻结输入、真实执行及独立 oracle 审核。

C16–C18 场景 revision `c16-c18-candidate-production-path-v2`（现由 v3 沿用同一 `attemptPolicy`）是随产品超长压缩修复登记的评分规则变更，与产品修复分开说明：`attemptPolicy.draftCondense` 只为 C17/C18 两个续写操作登记产品原生的唯一一次 `chapter-draft-condense`。许可条件是同 run/root/项目/epoch 的 `chapter-draft` 首请求已结算为 stop，且其 hash 可复核的输出按生产 `countDraftUnits` 超出 `draftTargetUnitRange` 上限；压缩请求出站前与续写一样须带【本章蓝图】→【全局写作要求】作者资料、全部 oracle 事实、必需前驱与替换来源。同一 operation 至多两次 attempt，正式效果只在末次压缩；压缩请求照常逐 attempt reserve/dispatch/settle 记账。压缩后仍越界或未以 stop 结束时保留原暂停与 `GENERATION_DRAFT_LENGTH_OUT_OF_RANGE` 失败；第二次压缩、未越界压缩或其他失败都不获新重试权，事实门与篇幅门不放宽。历史失败 invocation `97b6ccf0-63b0-454e-97f5-71e5efc7b39c`、`9cbac025-272e-489a-986a-e3fdf2568a04`、`24c90aec-80c8-411a-85b0-783c824ae7af` 按原结论永久保留，不按新规则追溯改判。

C16–C18 场景 revision `c16-c18-candidate-production-path-v3` 是用户批准的评分规则变更，只改 C16-B 作者保护的判定条件，不涉及产品代码，与任何产品修复分开说明。原规则要求 C16-B 在所有模式下都必须出现林澄 `mentalState` 的冲突候选；但作者已把该字段定为“谨慎”，合规模型在全部真实执行（`9cbac025`、`24c90aec`、`c9b88510`、`d8a30c11`）中都没有提议改写它，冲突候选根本不会产生，于是该案只有在模型试图覆盖作者资料时才可能通过——规则无法被合规行为满足。新规则：作者值“谨慎”仍在全部模式下必须保全（`AUTHOR_STATE_OVERWRITTEN` 断言不变）；桥另取本 operation 末次、已提交正式效果的 attempt，要求其 owner artifact 文本与物理输出 hash 一致，用生产 `parseFinalizedCharacterStateResponse` 解析（不读自由文本），记录 `finalizationEvidence.authorProtection`（`proposed`、`status`、正式 attemptId 与产物 hash）。模型对该角色提议了不同于作者值的 `mentalState` 时 `authorProtected` 必须为真，否则按原 `CONTINUITY_CASE_EVIDENCE_MISSING` 失败；未提议时记 `status: untriggered`，不判失败。driver 结果侧把该证据与末次正式 attempt、owner terminal 和输出文件 hash 逐项核对，字段缺失、类型不符或绑定不一致一律 fail closed。合成模式的受控 transport 必定提议冲突值，因此仍强制要求冲突候选；保护路径本身继续由合成执行与产品单元测试覆盖。`c9b88510`（`FINALIZATION_EFFECT_MISSING`）、`d8a30c11`（`CONTINUITY_CASE_EVIDENCE_MISSING`）及更早的全部失败按原结论永久保留，不按新规则追溯改判。

C16–C18 场景 revision `c16-c18-candidate-production-path-v4` 是用户批准的 harness 变更，只改执行夹具与结果校验，不改 C17-B 的蓝图、场景内容或难度，不涉及产品代码，与任何产品修复分开说明。原因来自真实执行 `73b46513` 的两名独立评审（均判 C17-B FAIL）暴露的两处 harness 缺陷。其一，恢复副本内重新定稿只调用 `commitFinalizationSnapshot`，绕过了产品定稿命令在提交后立即执行的定稿后处理（`FinalizeChapterCommand` → `RunFinalizePostProcessCommand`），新来源因此没有 notes/cards，评审看到的是绑定旧来源的过期 derived 数据；真实用户重新定稿必然运行后处理。v4 为 C17-B 登记两个新 operation「恢复副本重新定稿章节要点」「恢复副本重新定稿角色状态」（`caseIds` 仅 C17-B），在副本内重新定稿后、续写前按顺序执行；两者复用 C16 已登记的同一 `RunFinalizePostProcessCommand` 入口（按 stepKey 分步、无 KB 导入，与 C16 一致），不在夹具里另写后处理。桥断言后处理来源等于替换后来源，并经生产 IPC 回读 notes 投影（`sourceStatus=current`，来源 finalizationId 与正文 hash 一致）和 cards derived provenance，原文另落 `derived-notes-<finalizationId>.txt`、`derived-cards-<finalizationId>.json` 供评审引用；driver 对 C16 三案与 C17-B 逐案核对正式效果、步骤顺序与来源绑定（`FINALIZATION_SOURCE_NOT_BOUND`）。新 cards operation 与「定稿角色状态」共用产品原生 repair 登记（至多 `finalized-character-state:repair:1/2`，仍须持久失败产物，末次才带正式效果），notes 无额外尝试权。C16-B/C16-C 的重新定稿本来就紧接登记的 notes/cards operation，C18-B 为制造未选分支而在原项目重新定稿，其 derived 不进入所选世代或续写来源，两者均不增加请求。其二，`sourceParity.predecessors` 在恢复与重新定稿之前计算且之后未更新，输出记 `finalized:3` 而续写实际纳入 `finalized:4`。v4 在副本内替换后按同一回读规则重算 `physicalProject.readback.predecessors` 与 parity（其后全部 dispatch 绑定新 parity），替换前的前驱与 parity 另存为 `restoration.predecessorsBeforeReplacement`、`parityHashBeforeReplacement`；driver 要求 `parityHash` 等于 readback 的 hash、必需前驱等于替换正文的来源/revision/version/hash/字节，并与每个续写（含登记的唯一压缩）attempt 的 `materialDecision` 实际纳入项一致（`PREDECESSOR_AFTER_REPLACEMENT_MISMATCH`），parity 绑定不放宽。

v4 的最短物理路径由10次增为12次（C17-B 多 notes 与 cards 各一次）；两次按既有做法计入失败/修复/审修余量 `failedRetryRepairReviewReserve` 并单独披露，80次计划分配与各桶数额不变，cards 原生 repair 与唯一压缩仍逐实际 attempt 记账。历史 invocation `ca466d9a`（`FINALIZATION_EFFECT_MISSING`）与 `73b46513`（C17-B 独立评审 FAIL，评审 `review-r1.md`、`review-r2.md`）按原结论永久保留，不按 v4 重新评判；旧目标因协议字节 hash 漂移拒绝，须重新冻结。

本轮预注册在 `protocol.json.phases.c16-c18` 固定 C16-A→B→C、C17-A→B、C18-A→B 的 `caseOrder`、逐案 `caseOracles` 和 `stopPolicy`；runner 在执行前将该顺序与实际 `semantic-source.json.continuityQualificationCases` 逐项核对。自动证据核对物理 attempt、来源、持久效果、恢复身份与分支选择；语义事实在真实执行后由两名独立评审分别引用原定稿、notes/cards 和续写正文核验。任一技术失败立即停发，后续案记 NOT RUN；后判的语义 FAIL/UNKNOWN 保留全部已发送结果和原证据，不补采改判。12次（v4；v3 及以前为10次）只是七案最短物理路径，不能合并报正式 PASS；旧目标因新协议完整字节 hash 漂移而拒绝，须重新冻结。C18 仅验证选定完整世代与未选分支不混入，不证明外部 DAV 服务。

离线 DAV 使用原控制器和服务、受限 loopback 地址的合成 transport，单独报告 DAV 请求数，不能充当真实网络、双 profile、OS 凭据或打包资格。嵌入配置须从实际隔离配置回读；本最小路径只选择 notes/cards、无 KB 导入。恢复回执必须包含新项目身份、transfer 来源、旧任务冻结与源项目不变；原6/4正式资格、文学裁决和历史 FAIL 均不由合成通过改判。

中文语义源逐项登记C16自动derived正例、author冲突、同名改名、拒绝重启、旧outbox、CAS作者并发、较早章迟到、同章旧版本、身份不明及后处理失败。全部消费现有提取路径，禁止每角色新建付费调用。

C17覆盖正文/头像/知识原文保全、新项目ID与稳定领域ID、当前可读author/derived来源承接、历史候选与未知已发冻结、秘密字段及其hash排除、未知字段blocked、跨revision与恢复碰撞。C18覆盖无CAS追加、同父分叉、origin-readonly重启、latest缺失、上传后本机绑定失败。模型继续创作仅使用4次预留；其余故障优先确定性fixture，未执行不记通过。

编辑交互资格自 2026-09-24 起由[现行 F05](frontend-transition-specs.md#f05--最终-v3-功能及桌面体验资格) 的 `editor-interaction-v2` 拥有；冻结 `feature-union.editor-absolute-v1` 及旧结果只供历史检查，不再要求旧 Classic 基线或相对性能门。依 2026-09-25 用户指令，U06.A03 中文 IME 实测免测、不作为阻断，记 `WAIVED_BY_USER`（非 PASS），历史 FAIL 原样保留；其余编辑、保存与响应仍必验。不以模型预算扩成颜色乘积。F05三门须同postUiIntegrationSha的新收据；旧early结果不能代填。当前 postUiIntegrationSha 取 S14A 实际冻结候选；先前确定性 Final 的沿用或受影响路径复验按现行交付 delta 执行，不要求回到旧 F05 的 SHA。编辑具体测量器由F04/F05维护，此runner未实现UI性能资格，文学模型吞吐不混入编辑响应计时。

## 后续阶段接线边界

S07 early-budget 已接默认生产命令及最终 fetch 处的 reserve/dispatch/settle/unknown，未新增生产 observer hook。后续阶段须复用同一总账和实际项目回读，绑定各自 phase/milestone/原 attempt，不能在高层一次 run 扣一次。S10B提供上下文证据、S11提供审稿→定向修稿→唯一复核，保存输出、模板/Skill与compiled prompt哈希；不要另建直接API实验器。主集成者固定唯一总账与未消费阶段预留、出两臂manifest、盲评映射、post-UI与最终subject冻结。未实现的阶段正式运行保持blocked。

启动冻结补充：manifest.environment绑定实际 executable 字节hash、版本与module ABI，以及 esbuild/vitest/Electron/better-sqlite3 安装manifest路径、版本、hash。schemaVersion=1 的 nativeProfile 仅为历史旁证，原 node-js 探针不加载 native；schemaVersion=2 另绑定实际加载并查询过的 SQLite binary。startup 固定执行器与已hash驱动，不接受任意命令；实际无shell argv写入每次桥接收据。正式执行前后重新验证 source/tools/adapter/environment/startup，任何漂移拒绝。early-budget每臂显式包含一次范围生成与一次正文生成，early/post-UI各4次；22次失败余量及总计80次均为计划分配，不是调用硬帽。
