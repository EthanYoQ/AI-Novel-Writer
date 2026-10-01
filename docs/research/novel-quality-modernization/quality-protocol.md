# 中文质量预注册：Program v3 S00

**2026-10-01 用户批准的现行目标**：[AI 自主审稿与成稿资格](#ai-review-final-manuscript)。它替代未来资格中的首稿直接终点和人工补题路线；现行政策已完成 protocol/driver/fixture 接线并重新冻结受影响目标，真实质量、平台和发布状态以唯一私有当前检查点为准。文档更新不改变正在运行的旧实验。

已实现的机器 decision revision 为 `s14b-candidate-quality-and-comparison-v2`；`s14b-split-quality-gates-v1`、`s14b-reviewed-draft-v1` 及其结论保留为历史。candidate 字数标准仍采用 `draft-units-tolerance-30-v1`（2026-09-20 用户决定）；既有 post-UI 评估策略 revision 为 `s14b-post-ui-reviewed-draft-must-show-unknown-v3`（采纳必现目标 unknown）；`s14b-post-ui-reviewed-draft-unknown-oracle-v2`（2026-09-27 用户批准 unknown 单独终点）保留为历史。保留 `pacing-readability-v1` 节奏规则。完整机器协议及其他 revision 见 [`protocol.json`](protocol.json)；新协议完整字节 hash 须重新冻结，旧目标拒绝漂移。本文件负责解释执行规则与冻结合同的显式取代关系。S10B/S11 的历史场景、失败和加性裁决保留各自版本；[日期化交接](../../handoffs/2026-09-20-program-v3-s11-pause-handoff.md)只证明当时状态，当前进度读唯一私有当前检查点。全部 Spec 的适用关系见[现行索引](current-spec-index.md)。合成验证、真实模型结果与文学质量结论分开记录。

<a id="ai-review-final-manuscript"></a>

## AI 自主审稿与成稿资格（2026-10-01）

**决定与边界**：首稿允许有待修问题；交付须同时证明软件/AI 能自行指出关键问题，以及经作者批准的修稿能达到原成文标准。作者负责采纳和合并，不承担替审稿系统找错的验收职责。此决定不承诺所有首稿必过，也不默认自动修改作品。产品保留作者自由补充意见的能力，但人工补题所得结果只证明辅助修稿，不能作为本政策的审修闭环通过证据。

**生效状态**：用户已批准；`protocol.json` 已按本政策登记完整七案、post-UI 与 full，driver 与 fixture 已接线，受影响目标已重新冻结。接线和 synthetic/packet 校验不代表真实质量、平台或发布通过，当前状态以唯一私有当前检查点为准。以下旧 revision、固定稿诊断和历史结论按原范围保留。

### 范围及替代关系

| 消费者 | 新资格要求 |
| --- | --- |
| C16–C18 完整七案 | C16 三案保留原提取、作者值保护及来源义务；四个 C17/C18 续写案例改为首稿、AI 首审、条件修稿/复审、最终稿联合评估。完整七案来自同一新冻结实验，不拼接历史六案与新单案。 |
| S14B 待完成 post-UI | budget/context 的生成稿采用本链；review 的既有缺陷稿审修链直接检验自主发现和修复，不重复增加同义操作。各 selector 保留自身原材料、触发和断言；不重开已完成历史 early 实验。 |
| S14B full | 保留三场景、每场景三章、双臂十八章及原顺序；每章经本链确定最终正文后，才供同臂下一章读取。不得评审修后稿、实际续写却使用旧首稿。 |
| S06C、S10B、S11 与 F05 审修入口 | 复用生产审稿、确认、修稿、合并、普通复审；只修实际缺口，不另建事实库、planner、评分平台或全自动无限循环。 |

新规则取代下文 post-UI v3 的仅 mustShow unknown 可采纳范围，以及 full/C17–C18 只评生成稿的终点；保留其他材料、语义、样本、参数、恢复、计费和来源约束。先前“人工补充遗漏后成稿”的条件设计不再作为未来资格依据。含预置作者问题的固定稿诊断仍是非资格实验，即使修后通过，也不能放行新的自主审修资格。

### 生产路径与批准范围

1. 保存实际首稿。首审使用正常生产入口及原作者要求、蓝图、所选前驱、正文和合法上下文；不向模型注入 oracle、独立评审答案、历史失败标签、为本次稿件预填的纠错项或人工正确答案。原有作者材料必须可得，不把禁止补题误解为删减正常上下文。
2. 完整保存首次 AI 审稿报告。测试在调用前预授权采纳该报告中的 error/warning，以及绑定明确当章必需目标、具体指出缺失或证据不足的 unknown，按原报告顺序处理；后者可来自蓝图 keyEvents 或显式 mustShow，不再仅限 mustShow。普通笼统 unknown 与覆盖不全不自动进入修稿；纯风格偏好不另立必修目标，unknown 保留原状态，不改称已确认错误。选择沿用报告的结构化字段与来源，不新增模型筛选调用；实际语义是否足以行动由独立评审核验，不能靠人工改写报告补足。
3. 确认快照只采用真实 AI 项及其来源。测试操作者不能新增 author/apply 项、改写成已知答案、借 reviewFocus 定向提示已知错误，或在发送后补题。软件的确定性投影若来自 AI 对相应目标的真实结论可以沿用；机械缺项补出的 unknown 不能冒称 AI 已发现语义问题。正常用户仍可拒绝建议或自行编辑，这不构成本资格的自动发现证据。
4. 无可采纳项时，保留原稿和完整报告，不制造修稿。存在可采纳项时，经真实确认执行一次定点修稿、差异合并及一次普通全文复审；修稿以保全无关内容为原则，完整输出仍走已有保存和合并路径。测试预授权合并须事先明确，不能冒称作者现场确认；不择优回退首稿，不直接把 merge 或模型 pass 当作 resolved。
5. 原稿、报告、确认、修订、合并、复审和最终数据库正文沿用现有来源记录。审稿看到的稿件必须与其报告绑定，后章读到的前驱必须是本臂实际接受的最终稿。缺失目标类 finding 的消费者适配须最小修复，不伪造引文、findingId 或状态绕过产品规则。

### 同时评审发现能力和最终成文

两名未参与实现的独立评审沿用原评审流程：先依据原作者材料和首稿列出有原文依据的合同缺陷，再核对原始 AI 报告、实际修订和最终稿。独立评审结果只用于判定，不回灌同一轮模型纠错。现有报告增加以下分项即可，不新增评分服务或专用测试平台。

- **首稿表现**：记录未经语义修稿的通过/失败/分歧及原因，作为能力指标；首稿失败不再单独否决可合格的审修闭环。提取案例和技术请求成功数不得混入写作首稿通过率。
- **自主发现**：原事实、时间、必需事件、来源及原可读底线中的具体阻断缺陷，须在首次有效 AI 报告中得到足以采取行动的定位或目标说明；只说“再检查一下”或机械覆盖 unknown 不算发现。遗漏事件不要求伪造不存在的正文引文，但须明确是哪项原目标、缺什么。具体漏检即本分项 FAIL，即使后续偶然改对也不补算；严重误报或要求违反作者事实同样失败。一般风格偏好不升级为阻断。首稿无缺陷时记录该案未触发检出，不据此宣称检出率 100%。
- **修复与最终稿**：适用的事实/时间、全部必需事件、±30%、来源、复述、自然度、动机和节奏标准保持；修稿还遵守既有内容保全与相对篇幅合同。核对原问题解决且无新增阻断。复审漏掉仍存在或新引入的阻断问题，不能以模型 pass 代替通过。
- **资格与成本**：candidate 自主发现和最终成文两项均须通过，技术/来源证据完整；证据不足为 INCONCLUSIVE，分歧沿用最多一次独立仲裁。保留首稿、修后结果、未触发项、模型漏检/误报及实际请求成本，不用单一平均分冲销具体失败。自动 runner 仍最高 pending，不能自行作文学裁决。

固定失败稿的未获提示的原始首审若已有完整来源，可只读核查其发现能力，避免重跑同样的审稿；其人工补题修稿不能混成 AI-only 成功，也不能替代未来完整新实验。当前无缺陷的新稿不需要人为造错；已知失败稿及既有 review 案例承担真实检出验证，synthetic 只证明接线。

### 调用、参考臂与执行顺序

- 每篇最多一次语义修稿。无修稿通常新增一次首审；触发修稿通常新增首审、修稿、复审三次请求。结构化语法修复只沿用该入口明确登记的许可；文学失败不触发格式修复、续写或第二次语义修稿。实际最大调用、token/时间预算由执行线程依据生产操作计算并在运行前登记；旧最短请求数不再代表新链，80 仍只是计划分配额。
- baseline 保持原代码，通过其真实已有入口执行预登记审修；不伪造 candidate 的目标投影或复核能力。不可用的对应能力及参数/选择不对称单列披露。技术和前驱证据仍须完整，baseline 自主发现/文学失败不自动否决合格 candidate，也不据不对称单独宣称改善。
- 先检查当前真实首审的自主发现证据，必要时只修已证明的生产缺口；然后完成新政策接线、针对性零模型验证和一次独立切片审查，取得完整七案新资格，再按既有顺序执行 post-UI/full。审修接线可提前独立完成；不因文档变化重跑无关产品、UI、平台或已关闭审查。
- 一次修稿失败如实保留并诊断，不盲重试、不改样本或标准；这不是允许跳过缺陷，也不是用户日后编辑次数上限。历史 FAIL、旧请求和原始报告不改判；仅同步受到新政策影响的活跃规格/计划和机器消费者，不修改冻结 Spec、DAG、manifest 或旧证据。平台、发布和 Issue 结案仍按各自合同。

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

本节保存已实现的 post-UI v3 及更早政策。未来新资格的采纳范围、自主发现评审和覆盖阶段由[2026-10-01 决定](#ai-review-final-manuscript)取代；旧实验仍按原登记解释。

产品已支持作者显式的 `【第N章必现】` 目标及作者选择后的一次修稿；这不自动改变测试预授权，必须另有测试政策决定。用户已批准以下决定，现行 post-UI 评估策略为 `s14b-post-ui-reviewed-draft-must-show-unknown-v3`，场景 revision 现为 `s14b-post-ui-reviewed-budget-review-rebuild-must-show-v3`（v2 保留为历史；v3 相对 v2 只增加候选臂的唯一原生压缩登记，见下文 S07 段），只适用于未来一轮 S14B post-UI 固定实验场景1/1；early、full、C16–C18 的选择与场景不变。新场景 revision 只增加上述输入标记，继承原 `s14b-post-ui-reviewed-budget-review-rebuild-v1` 的全部登记，包括 `指定范围生成` 的一次结构化语法修复和 `成稿首审` 的一次 `review-chapter-rebuild`（见下文 S07 段），并非不带 rebuild 的新场景。

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

前瞻推理配置以 `protocol.json.forwardReasoningExperiment` 的 `fixed-max-natural-wire-asymmetry-v1` 登记为准，只覆盖 C16–C18 七案、post-UI 三个固定 selector、final full；须先完成 C16 七案 candidate 绝对门再推进其依赖。两臂实际模型配置均须读回 `reasoningOverride=max`，项目策略均为 `creativeStrategy=auto`，且 provider/protocol/baseUrl/modelName 精确匹配登记。candidate 的每个物理请求自然发送 `enable_thinking:true`、`reasoning_effort:max`；冻结旧 baseline 自然省略两个字段，`false`、`null` 都不算缺席；两臂都不得发送 `thinking_budget`。逐请求在现有 requestReceipt 中保存非敏感解析状态、字段 presence/value 与实际 `requestedOutputTokens`（来自当次 `max_tokens`），先核对再 reserve/dispatch，不改写出站 body。原六参数、作者素材 parity 不变；同配置偏好不冒称 wire parity（登记为 `false`）。这次只固定 max，不先试 high 或选优；不能据此作参数或代码因果改善声明，不可比相对维度记 INCONCLUSIVE，candidate 全部绝对门与 baseline 完整技术端点不减。语义源、oracle、温度 0.7、profile 上限 16384、原预算、顺序、历史失败与唯一原账本均保持。出站证据不能证明服务端实际模型身份或思考模式；没有服务端 metadata 就记未验证。新协议完整字节 hash 漂移，旧目标不得复用，须重新冻结并先跑零模型 dry-run。

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

`s14b-post-ui-reviewed-budget-review-rebuild-v1` 及继承它的 `s14b-post-ui-reviewed-budget-review-rebuild-must-show-v2`（现由 v3 沿用同一登记）另为 post-UI `成稿首审` 登记一次产品已有的 `review-chapter-rebuild`：首发必须是同一草稿的 `review-chapter`，已在唯一账本 settle，原输出文件与哈希相符，按产品 parseReviewGenerationResult 的 fenced JSON 提取和 JSON.parse 确认语法错误，且草稿尚无已保存的审稿报告。重建请求须沿用同一 run、root action、project、epoch、草稿身份，第二次重建和其他 retry 在 reserve 前拒绝。有效但含 error/warning/unknown 的报告不得借此重建；重建后仍按原审稿合同和独立质量门验收，初次坏输出与替代输出均保留。

S14B post-UI 场景 revision `s14b-post-ui-reviewed-budget-review-rebuild-must-show-v3` 是随产品超长压缩修复登记的评分规则/场景变更（单列披露），与产品修复分开说明。产品侧不在本变更范围：产品自 `f00b612b` 起就对超出 `draftTargetUnitRange` 上限的首稿发一次原生 `chapter-draft-condense`，本次只改 S14B 的登记。变更内容：post-UI selection 的 `attemptPolicy.draftCondense` 为 `900单位正文` 登记这唯一一次压缩，且只对 candidate 臂生效（`arms: ["candidate"]`）；baseline `2264390d` 早于该产品修复、没有这项能力，从不登记压缩，任何 baseline 压缩请求仍在 reserve 前拒绝。许可条件与 C16–C18 v2 同规则：同 run/root/项目/epoch 的 `chapter-draft` 首请求已结算为 stop，其 hash 可复核的输出按生产 `countDraftUnits` 严格超出 `draftTargetUnitRange` 上限；用途常量、计数与上限均取自生产代码（`DRAFT_CONDENSE_PURPOSE`、`countDraftUnits`、`draftTargetUnitRange`），不自建近似。至多一次压缩，同一 operation 至多两次 attempt，正式效果只在末次压缩；`成稿首审` 的被审稿（`reviewedDraft.initial`）必须是该末次压缩输出按生产 `sanitizeDraftText` 清洗（主进程 draft-visible-v1 组合同一规则）后的压缩稿，干净输出即其物理输出 hash 本身；无修稿时它同时是保存的正文（`saved.contentHash`、`draftObservation`），有修稿时保存的是唯一一次修稿产物，其来源仍由既有审修链校验。首稿是否超长按首稿的物理输出判，压缩稿是否落入范围按压缩稿自身判；最终稿（有修稿时是修稿产物）的范围由原字数门另判，不归因于压缩登记。第二次压缩、首稿未超上限的压缩、非 candidate 臂或其他 operation 的压缩，以及压缩后仍越界（产品保留原稿，仍以 `GENERATION_DRAFT_LENGTH_OUT_OF_RANGE` 暂停并记失败）均不获新的重试权，字数门与事实门不放宽。压缩请求照常逐 attempt reserve/dispatch/settle 记账，因与首稿同 slot 计入 `failedRetryRepairReviewReserve`，`maximumPlannedCalls` 由14增为15（candidate 至多多1次），80次计划分配与各桶数额不变。`指定范围生成` 的一次结构化语法修复、`成稿首审` 的一次 `review-chapter-rebuild`、修稿与复评链，以及 early、early-context、early-review、full、C16–C18 的登记与 revision 均不变；`【第1章必现】` 附加行沿用语义源里登记给 v2 的同一条，语义源字节不变。

生效范围只限未来的 post-UI 冻结目标与真实执行；旧目标因协议完整字节 hash 漂移而拒绝，须重新冻结。不对称披露：评估策略 `armAsymmetry.condense` 增补一句——candidate 含原生压缩登记、baseline 无；两臂是否触发压缩及压缩后正文长度的差异来自该不对称，不得据此单独声称相对改善（随协议、pair manifest 与每臂 receipt 披露）。历史保留：post-UI invocation `ba2d34ab-a4f6-4283-bed1-eb2bffa8b5aa`（v2、candidate `a618c122`）中 candidate 首稿 1210 单位超出上限 1170，第二次原生压缩因未登记而没有进入账本，随后以 `GENERATION_DRAFT_LENGTH_OUT_OF_RANGE` 失败，永久保留为失败，不改判、不补采、不按本变更追溯；更早的 post-UI 结果同样按原结论保留。本变更改变的是今后 post-UI 的登记规则，不是对 `ba2d34ab` 或任何历史结果的重判。历史账本段登记见下文 C16、C17、C18 一节的“九、账本历史边界”。

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

## C16–C18 v7 专用定稿来源（前向场景修订）

现行场景为 `c16-c18-candidate-production-path-v7`。`semantic-source.json` 的 C16-A `finalizedSource` 固定为该 revision 的专用作者定稿：清晨发现记录日期与旧钟不符；同日午后，人物因缺少通行许可在现场核查启动前被拒，林澄已损失不退还的六枚铜币预约费；铜钥匙保管、沈岸尚不知地图、核查尚未开始、异常原因未明均明确。它经原生产草稿保存和定稿入口成为后处理实际读取的第1章 snapshot，替代 C16–C18 原来过短的前情；全局 `authorPredecessor` 及 post-UI/full 输入正文不变。

B/C 继续追加原核查安排与“尚未开始、等待雨停”更正；C17-B 继续在恢复副本重新定稿，撤回旧安排并等待新许可；C17/C18 仍从实际选定的来源继承已发生的拒绝、损失及未决异常。没有写入已完成核查再试图用后缀抹除历史。`targetCharacterName` 明确登记林澄为原作者状态保全/冲突断言的目标；fixture 从生产定稿 identity 唯一解析其稳定 ID，不再假设正文只出现一个人物。原七案 oracle、顺序、操作、预算及最短16次物理调用不变；v7 仅补齐正向覆盖所需来源，不增加产品能力。语义源、协议、前驱正文和实际 parity/hash 必须重新冻结，不能声称与旧输入相同；旧 scenario revision 在现行 fixture 入口拒绝，历史重放须使用对应旧 fixture。

ac3af420 的 C16-A 独评及唯一仲裁为 INCONCLUSIVE，C18-B 自然度为 FAIL，本轮与更早失败永久保留，不因前向场景或另行产品提示修复改判。开发合成只证明定稿、后处理及恢复来源接线；新的真实质量仍需重新冻结执行和独立评审。

## H5 有界生产恢复登记（恢复策略继续适用）

该次只补 harness 合同，不增加产品能力，登记 C16–C18 `c16-c18-candidate-production-path-v6`、full `s14b-full-continuous-project-v3`、post-UI `s14b-post-ui-reviewed-budget-review-rebuild-must-show-v4`；C16 现已由上节 v7 场景取代，恢复策略不变。下文旧 revision 段落保留历史解释，额外调用资格以本节和现行 `protocol.json` 为准。三个场景及协议完整字节 hash 均须重新冻结；该次登记时的唯一物理账本历史边界为 861 行，后续历史边界见下文，全部历史失败不变。

正文恢复复用生产 `DRAFT_GENERATION_BUDGET.maxAttempts=8`，包括同一 root 内首稿、续写、无进展恢复与唯一压缩；旧 run 已发对账仍计入这八次，新 run 不再发送对账，不另外给八次重试。最多七轮 continuation；正常 stop 但短于该臂生产下限或 length 才可继续；length 且可见新增不足 300 单位时丢弃该段，至多一次 no-progress recovery。候选超过上限后走既有唯一全文压缩，baseline 无此能力。门禁逐次核对同 run/root/project/epoch、唯一 attempt、reserve→dispatch→settle、stop/length 终态、落盘原文 hash，候选另核对 main owner artifact。未结算、错身份、错误触发、超次数和未知用途在 reserve 前拒绝；原 token、截止时间和上下文预算仍由实际生产 session 约束。

结果侧按生产 `sanitizeDraftText` / `composeDraftVisibleContinuation` 重放有效片段，保留每次原文及无进展失败候选；压缩以完整新稿取代此前组合。末次才可有正式效果，最终组合 hash 必须等于 full/C16–C18 保存稿或 post-UI 被审初稿；后续修稿、复评与 full 下一章前驱继续绑定既有链，篇幅门、事实门、盲评均不放宽。

结构化恢复只作用于 post-UI `指定范围生成` 和 full `三章规划`，直接调用生产 `planBlueprintGenerationCost(N)` 取原 maxCalls（单章 3、三章 9）。实际请求范围从出站生产提示及用途取证；length 或生产解码失败后多章深度优先拆半，单章至多一次 compact-single 完整重建。全 operation 仍最多一次证据不变的语法修复。候选 value_too_long 不接受机械截断；失败原文、拆分范围、修复来源、owner 终态和最后正式效果均可复核。

baseline `2264390d` 保持原源码及实际行为：正文下限 80%，候选 70%；baseline 没有 durable RootAction，收据以实际 renderer command run 作为同一 session 预算根，不冒称 main owner；其历史结构化 decoder 会对部分 value_too_long 机械截断。harness 从冻结 baseline 工作树只读编译该 decoder，用于门禁与收据回放，候选始终调用当前严格语义 parser。两臂恢复与压缩触发差异必须披露，不据此单独声称质量改善。

最短路径不变：C16–C18 16 次，full 24 次，post-UI 6 次。post-UI 登记包络为两臂各 `3+8+2+1+1=15`，`maximumPlannedCalls=30`；full 登记包络为六次三章规划各最多 9、十八次正文各最多 8，即最多 198 次，且原 token/时间预算可能更早耗尽。80 次计划分配和各桶额度按 ADR0019 保持不变；额外物理请求照常进入同一账本既有失败/重试/修复余量分类，不合并、不漏记，也不以计划额度替代生产 root 预算。

开发合成对所有候选目录注入超长字段，检验生产拆批与完整重建；正文覆盖短 stop、length、重复无进展、恢复后压缩。任何 compact 提示若丢失原 oracle 事实，仍由原出站事实门拒绝并保留失败，不能缩小注入场景或减弱事实门来改判通过。开发合成仅证明接线与门禁，物理模型请求必须为 0；真实质量和正式冻结须另行完成。

## Full 连续生产执行

以下是已实现的 full v2。未来新资格须按[AI 自主审稿与成稿资格](#ai-review-final-manuscript)增加逐章审修及最终前驱接线；原十八章、六项目、顺序与来源义务保留，下文“没有审修链”及请求数量仅描述旧 revision。

`full` 固定为 `final` milestone，执行登记 `s14b-full-continuous-project-v2`（v1 保留为历史；v2 相对 v1 只增加下文单列披露的候选臂唯一原生压缩登记）。每场景每臂只 prepare 一个独立物理项目，三章持续重开其原 SQLite 数据库。先完成六次 `三章规划`：场景1 baseline/candidate、场景2 candidate/baseline、场景3 baseline/candidate；每次通过 `GenerateDirectoryCommand` 生成并保存第1至3章蓝图。随后按 protocol.order 的原 seed、caseIds 与九组 armsByChapter 顺序完成十八次 `连续章节正文`。规划分配 `finalPlanning=6`，正文分配 `finalChapters=18`，full 最小物理请求数合计24；重复 slot 仍归失败/重试余量，不重置历史占用。

后章 `GenerateDraftCommand` 读取本臂已保存蓝图；前驱由本臂实际生成并保存的上一章收据指定项目、章节、draftId、version、正文 hash 和字节数，再经生产 `db:draft-get-full` 核验原文。正文通过既有 selectedCandidateDrafts 路径送入提示词，发送前检查真实前章结尾与 candidate 来源绑定。full 不使用 early-context 的作者预置前情或可选旧档，也不使用 early-review 的预置缺陷稿。两臂起始作者资料、模型、模板和 Skill 绑定必须相同；各臂生成后的蓝图和正文允许不同，初始 parity 与逐章前驱证据分别记录。

每次规划、正文有独立请求和收据目录，不覆盖前章输出。失败立即停止后续发送，保留失败与未运行列表；缺章、顺序错配、项目或前驱错绑不能汇总为成功。账本继续逐请求 reserve/dispatch/settle/unknown，调用方对账负责异常终止收口。现有 historicalLedgerBoundary 认证协议更新前的原始前缀；新绑定只适用于新调用，旧账字节、旧 FAIL 与 testedSha 保留。

S14B full 场景 revision `s14b-full-continuous-project-v2` 是随产品超长压缩修复登记的评分规则/场景变更（单列披露），与产品修复分开说明。产品侧不在本变更范围：产品自 `f00b612b` 起就对超出 `draftTargetUnitRange` 上限的首稿发一次原生 `chapter-draft-condense`，本次只改 full 的登记。变更内容：`phases.full.attemptPolicy.draftCondense` 只为 candidate 臂的 `连续章节正文` 登记这唯一一次压缩（`arms: ["candidate"]`）；`三章规划` 与 baseline `2264390d` 不登记，baseline 早于该产品修复、没有这项能力，任何 baseline 或 `三章规划` 中的额外请求仍在 reserve 前拒绝。许可条件、次数与正式效果同 post-UI v3：同 run/root/项目/epoch 的 `chapter-draft` 首请求已结算为 stop，其 hash 可复核的输出按生产 `countDraftUnits` 严格超出 `draftTargetUnitRange` 上限；至多一次，同一 operation 至多两次 attempt，正式效果只在末次压缩，用途常量、计数与上限取自生产代码。每章没有审修链，因此保存的正文（`saved.contentHash`）必须等于末次压缩输出按生产 `sanitizeDraftText` 清洗（主进程 draft-visible-v1 组合同一规则）后的 hash，干净输出即其物理输出 hash 本身；`saved`、`draftObservation` 与下一章前驱（`classifyFullProduction` 的前驱链与 `result.predecessor`）都取该压缩稿。压缩稿是否落入 candidate ±30% 范围按压缩稿自身判，压缩后仍越界记 `DRAFT_CONDENSE_NOT_REGISTERED` 并使 full 失败（产品侧仍以 `GENERATION_DRAFT_LENGTH_OUT_OF_RANGE` 保留原稿失败）；第二次压缩、首稿未超上限的压缩、压缩 attempt 非 stop、保存稿仍是被压缩取代的首稿，均不获新的重试权，字数门与事实门不放宽。分类里 `result.attempts[0]` 的 owner 绑定检查继续针对首个（primary）attempt，第二个 attempt 须与 primary 同 run/root/项目/epoch。

历史 full v2 未登记：`chapter-draft-continuation` 与 `chapter-draft-no-progress-recovery` 在 full 里不登记。依据主 Agent 的历史统计（约100个正文类 attempt 全部以 stop 结束），按 fail-closed 处理：未登记，触发即在 reserve 前拒绝并记技术失败。baseline 不登记任何额外请求。

预算：分配不变。压缩 attempt 与首稿同 slot（milestone/phase/caseId/arm/operation），按 `allocationFor` 计入 `failedRetryRepairReviewReserve`，不占 `finalChapters=18` 与 `finalPlanning=6`；`minimumCalls` 仍为24，`plannedCallAllocation` 与各桶数额（合计80）不变，无需改协议数字。最坏情形 candidate 9 章全部压缩：full 物理请求最多 24+9=33，多出的 9 次在22次余量之内；该余量是全 campaign 共享的计划分配而非调用上限（ADR 0019 只分类汇报、不拒发，历史上 unknown 与修复超出后仍继续记账）。

开发合成：`development-synthetic --scenario full` 默认让 candidate 的场景1/2（第2章）首稿超上限、经唯一压缩落入范围，其后场景1/3 的前驱即为该压缩稿，因此默认合成是 24 步加 1 次压缩共 25 次 dispatch。显式 `syntheticDraftCondense: { caseId: '场景1/2', outcome: 'still-over' }` 复现压缩后仍越界的原失败语义（full 在该步停发，后续记 NOT RUN）。该计划只属于开发合成（`development && phase==='full'`）；正式合成与真实模式不带它，行为不变。

不对称披露：`attemptPolicy.armAsymmetry`（随协议、driver 登记与 full 结果的 `attemptPolicy` 一并披露）——candidate 有压缩、baseline 无；两臂是否触发压缩及各章压缩后正文长度的差异来自该不对称，不得据此单独声称相对改善。生效范围只限未来 full 冻结与真实执行：旧 full 目标因协议完整字节 hash 漂移而拒绝，须重新冻结。历史保留：早前 early、post-UI、C16–C18 的登记与 revision 不变（post-UI v3、C16–C18 v5 已各自单列披露），任何历史 FAIL/PASS 不因本变更改判。

```powershell
node scripts/quality-modernization-run.mjs development-synthetic --baseline-root <已登记baseline工作树> --output .runtime/.cache/novel-quality-modernization/full-development-targets.json --scenario full
node scripts/quality-modernization-run.mjs full --targets <新HEAD冻结双目标> --milestone final --mode real --physical-ledger <现有唯一物理账本绝对路径>
```

合成路径只验证24次边界（默认开发合成含候选场景1/2 的1次压缩，共25次 dispatch）、18章落盘及接续，`qualityQualification=not-run`；正式执行仍须满足 S14B 前置，自动结果最高为 `pending-independent-oracle-review`。C16 既有提取6次及 C17/C18 恢复继续4次仍是单独义务，full 不替代其执行、记账或验收。

## C16、C17、C18与编辑门

以下保留已实现的七案路径；未来完整七案按[AI 自主审稿与成稿资格](#ai-review-final-manuscript)替代四篇续写的评估终点，C16 提取与各恢复路径的技术、来源义务不变。

`c16-c18` 是 `final` 下独立的 candidate-only 阶段，复用四个生产操作：定稿章节要点、角色状态、本地归档恢复后续写、WebDAV 选定世代恢复后续写。`continuityQualificationCases` 登记七个案例：C16-A 有效来源更新 derived、C16-B author 冲突、C16-C 同章重新定稿替换旧源，各执行 notes/cards 两次，归入原 `C16ExistingExtraction` 的6次；C17-A 恢复有效 source、C17-B 恢复后正常重新定稿使旧 derived 失效、C18-A 选定世代、C18-B 两完整分支明确选一，各执行一次 `GenerateDraftCommand`，归入原 `C17C18RestoreContinue` 的4次。准备、重试及角色状态原生 repair 如产生请求，均逐实际 attempt 记账；repair 仅接受同 run/root 的持久前序失败 artifact。早门和 full 的双臂设计不变，本阶段不触发 full 的6次规划/18章判定。离线合成通过只证明接线，正式质量资格仍需冻结输入、真实执行及独立 oracle 审核。

C16–C18 场景 revision `c16-c18-candidate-production-path-v2`（现由 v3 沿用同一 `attemptPolicy`）是随产品超长压缩修复登记的评分规则变更，与产品修复分开说明：`attemptPolicy.draftCondense` 只为 C17/C18 两个续写操作登记产品原生的唯一一次 `chapter-draft-condense`。许可条件是同 run/root/项目/epoch 的 `chapter-draft` 首请求已结算为 stop，且其 hash 可复核的输出按生产 `countDraftUnits` 超出 `draftTargetUnitRange` 上限；压缩请求出站前与续写一样须带【本章蓝图】→【全局写作要求】作者资料、全部 oracle 事实、必需前驱与替换来源。同一 operation 至多两次 attempt，正式效果只在末次压缩；压缩请求照常逐 attempt reserve/dispatch/settle 记账。压缩后仍越界或未以 stop 结束时保留原暂停与 `GENERATION_DRAFT_LENGTH_OUT_OF_RANGE` 失败；第二次压缩、未越界压缩或其他失败都不获新重试权，事实门与篇幅门不放宽。历史失败 invocation `97b6ccf0-63b0-454e-97f5-71e5efc7b39c`、`9cbac025-272e-489a-986a-e3fdf2568a04`、`24c90aec-80c8-411a-85b0-783c824ae7af` 按原结论永久保留，不按新规则追溯改判。

C16–C18 场景 revision `c16-c18-candidate-production-path-v3` 是用户批准的评分规则变更，只改 C16-B 作者保护的判定条件，不涉及产品代码，与任何产品修复分开说明。原规则要求 C16-B 在所有模式下都必须出现林澄 `mentalState` 的冲突候选；但作者已把该字段定为“谨慎”，合规模型在全部真实执行（`9cbac025`、`24c90aec`、`c9b88510`、`d8a30c11`）中都没有提议改写它，冲突候选根本不会产生，于是该案只有在模型试图覆盖作者资料时才可能通过——规则无法被合规行为满足。新规则：作者值“谨慎”仍在全部模式下必须保全（`AUTHOR_STATE_OVERWRITTEN` 断言不变）；桥另取本 operation 末次、已提交正式效果的 attempt，要求其 owner artifact 文本与物理输出 hash 一致，用生产 `parseFinalizedCharacterStateResponse` 解析（不读自由文本），记录 `finalizationEvidence.authorProtection`（`proposed`、`status`、正式 attemptId 与产物 hash）。模型对该角色提议了不同于作者值的 `mentalState` 时 `authorProtected` 必须为真，否则按原 `CONTINUITY_CASE_EVIDENCE_MISSING` 失败；未提议时记 `status: untriggered`，不判失败。driver 结果侧把该证据与末次正式 attempt、owner terminal 和输出文件 hash 逐项核对，字段缺失、类型不符或绑定不一致一律 fail closed。合成模式的受控 transport 必定提议冲突值，因此仍强制要求冲突候选；保护路径本身继续由合成执行与产品单元测试覆盖。`c9b88510`（`FINALIZATION_EFFECT_MISSING`）、`d8a30c11`（`CONTINUITY_CASE_EVIDENCE_MISSING`）及更早的全部失败按原结论永久保留，不按新规则追溯改判。

C16–C18 场景 revision `c16-c18-candidate-production-path-v4` 是用户批准的 harness 变更，只改执行夹具与结果校验，不改 C17-B 的蓝图、场景内容或难度，不涉及产品代码，与任何产品修复分开说明。原因来自真实执行 `73b46513` 的两名独立评审（均判 C17-B FAIL）暴露的两处 harness 缺陷。其一，恢复副本内重新定稿只调用 `commitFinalizationSnapshot`，绕过了产品定稿命令在提交后立即执行的定稿后处理（`FinalizeChapterCommand` → `RunFinalizePostProcessCommand`），新来源因此没有 notes/cards，评审看到的是绑定旧来源的过期 derived 数据；真实用户重新定稿必然运行后处理。v4 为 C17-B 登记两个新 operation「恢复副本重新定稿章节要点」「恢复副本重新定稿角色状态」（`caseIds` 仅 C17-B），在副本内重新定稿后、续写前按顺序执行；两者复用 C16 已登记的同一 `RunFinalizePostProcessCommand` 入口（按 stepKey 分步、无 KB 导入，与 C16 一致），不在夹具里另写后处理。桥断言后处理来源等于替换后来源，并经生产 IPC 回读 notes 投影（`sourceStatus=current`，来源 finalizationId 与正文 hash 一致）和 cards derived provenance，原文另落 `derived-notes-<finalizationId>.txt`、`derived-cards-<finalizationId>.json` 供评审引用；driver 对 C16 三案与 C17-B 逐案核对正式效果、步骤顺序与来源绑定（`FINALIZATION_SOURCE_NOT_BOUND`）。新 cards operation 与「定稿角色状态」共用产品原生 repair 登记（至多 `finalized-character-state:repair:1/2`，仍须持久失败产物，末次才带正式效果），notes 无额外尝试权。C16-B/C16-C 的重新定稿本来就紧接登记的 notes/cards operation，C18-B 为制造未选分支而在原项目重新定稿，其 derived 不进入所选世代或续写来源，两者均不增加请求。其二，`sourceParity.predecessors` 在恢复与重新定稿之前计算且之后未更新，输出记 `finalized:3` 而续写实际纳入 `finalized:4`。v4 在副本内替换后按同一回读规则重算 `physicalProject.readback.predecessors` 与 parity（其后全部 dispatch 绑定新 parity），替换前的前驱与 parity 另存为 `restoration.predecessorsBeforeReplacement`、`parityHashBeforeReplacement`；driver 要求 `parityHash` 等于 readback 的 hash、必需前驱等于替换正文的来源/revision/version/hash/字节，并与每个续写（含登记的唯一压缩）attempt 的 `materialDecision` 实际纳入项一致（`PREDECESSOR_AFTER_REPLACEMENT_MISMATCH`），parity 绑定不放宽。

v4 的最短物理路径由10次增为12次（C17-B 多 notes 与 cards 各一次）；两次按既有做法计入失败/修复/审修余量 `failedRetryRepairReviewReserve` 并单独披露，80次计划分配与各桶数额不变，cards 原生 repair 与唯一压缩仍逐实际 attempt 记账。历史 invocation `ca466d9a`（`FINALIZATION_EFFECT_MISSING`）与 `73b46513`（C17-B 独立评审 FAIL，评审 `review-r1.md`、`review-r2.md`）按原结论永久保留，不按 v4 重新评判；旧目标因协议字节 hash 漂移拒绝，须重新冻结。

当前前向操作登记（2026-09-30）：新 run 不再发出或注入生成前对账，首个请求为 `chapter-draft`，其 prompt 与已绑定 `materialDecision.promptHash` 一致；继续/压缩保留原作者、定稿和蓝图材料。C16–C18 七案最短 12 次（提取 6、C17-B 重新定稿后处理 2、四次首稿 4），开发合成另按既有 H5 计划覆盖续写、无进展恢复与压缩，实际调用逐次计账，不把最短路径当固定总数；正式合成及真实模式不注入这些开发计划。原每 run/root 最多 8 次以及 token、时间、连续性、恢复和压缩触发条件不变，省下的对账不授权额外重试。当前 dispatch 与结果校验拒绝任何新对账；旧收据摘要、账本历史边界及产品旧 run 恢复仍识别原对账，不篡改其 hash 或把其产物当正文。此为产品删去冗余规划后的实验操作登记对齐，保留 v7 source、全部 caseOracles 与评分；包括 63a44636 在内的旧 FAIL 不改判。下列 v5 段落保留为历史登记，关于“必发、最短16次、缺少即失败”的规则不适用于此后的新运行。

C16–C18 场景 revision `c16-c18-candidate-production-path-v5` 是用户批准的 harness 与评分规则变更，与同期产品变更分开说明。产品变更（另一 owner，不在本节范围）：`GenerateDraftCommand` 在首稿前新增一次“生成前定稿对账”物理调用（用途 `chapter-draft-reconcile`，review 推理档，≤1024 tokens），仅在直接前驱为已纳入定稿、本章无未定稿候选且蓝图有 keyEvents/purpose 时触发；其 JSON 输出渲染为注入块，放进首稿提示与续写/压缩作者资料块，失败或不可解析时按原提示继续；材料准入收据可选新增 `reconciliationPromptHash`。本节只记录 harness/评分如何承接它。

一、对账调用的 harness 承接。`attemptPolicy.draftReconcile` 只为两个续写 operation 登记这次对账：必须是该续写 run 的第一个物理请求、至多一次、不带正式效果、不参与正文组合、不能当压缩的首稿、没有修复或重试权；之后的首稿须同 run/root/项目/epoch 且用途为 `chapter-draft`。dispatch 门在记账前拒绝第二次对账、首稿之后的对账、未登记 operation 或未登记策略中的对账，以及对账后换 run 的首稿；结果侧另核对对账 attempt 位于首位、`hasFormalEffect=false`、终态为 stop 或 length、物理计数包含它。桥的出站检查不再把对账当写稿提示：它须是唯一 user 消息且 hash 等于 `materialDecision.reconciliationPromptHash`，`【已定稿章节原文】` 与 `【作者设定】` 各出现一次并逐字含必需前驱的定稿结尾，`【本章蓝图】` 是最后一节且逐键等于已提交蓝图；原有的 oracle 事实、必需前驱、替换来源与未选分支检查照常适用。之后的写稿请求出站前先等对账流结算，再用生产 `draftReconciliationBlock` 从落盘输出重算注入块：可用时首稿须恰含一次该块且去块后等于 `promptHash`，续写/压缩作者资料块也须含该块；不可用时首稿与 `promptHash` 逐字一致，且不得出现注入标题。对账提示原文落盘为 `reconcile-prompt-N.txt`，输出为同序号 `physical-output-N.txt`，两者路径与 hash 写入收据 `draftReconciliation` 与 invocation 汇总 `draftReconciliation[]`，供评审包引用。

二、失败处理的决定：对账以 stop 结束且可解析时记 `injected`（含冲突数与注入块 hash）；以 length 结束或输出不可解析时如实记为 `unusable`，原因分别为 `finish-reason-not-stop` 与 `unparseable-output`，该案不判技术失败，按产品设计以原提示生成，由独立评审照常裁决，但汇总中明确标出对账未生效，不能冒充已生效。对账的发送失败或 unknown 与其他 attempt 一样属技术失败并停发。登记续写没有发出对账（产品触发条件在本场景必然成立）也按技术失败停发（`DRAFT_RECONCILE_NOT_TRIGGERED` / `DRAFT_RECONCILE_EVIDENCE_MISSING`）。合成 transport 对对账返回合法 JSON，其中首个必需事件标为冲突；合成模式只接受 `injected` 且冲突数≥1，覆盖“对账结果注入首稿与作者资料块”这条路径。

三、请求记账。每个续写多 1 次对账：最短物理路径由 12 次增为 16 次（C16 notes/cards 6、C17-B 重新定稿后处理 2、四个续写各为对账+首稿 8）。登记的 cards 原生 repair（C16 三案与 C17-B 各至多 2 次）与唯一压缩（四个续写各至多 1 次）全部发生时最多 28 次。按“新增请求计入余量并单独披露”的既有做法，4 次对账计入 `failedRetryRepairReviewReserve`，总 80 与各桶数额不变；账本 allocation 仍按原 slot 规则分类，同一 operation 的后续 attempt 归余量。自 ADR 0019 起分配只做分类与汇报，不限制发送，因此无需调整桶数。

四、独立评审 oracle 前向修订（评分规则变更，单列）。fa8806d7 的两份评审诊断显示，C18-A/C18-B 所选世代中的“原定安排等待雨停”是人物的计划，不是禁令；续写里人物明确作出新决定后行动属于正常叙事，但 R2 把它判成与所选世代事实相悖。修订前后对照如下：

- C18-A 修订前：“两名独立评审各引所选世代定稿/notes/cards及续写草稿正文：续写只承接所选世代的有效人物、物品、知情和时间事实”。修订后在原文之后追加两条。第一条是硬事实，不因计划改变而放宽：第1章异常须仍是“记录上的日期与旧钟不符”，可以换措辞、不要求逐字复述，但不得把核查对象替换为另一异常或否认它；铜钥匙始终由林澄保管，交给他人保管或押出都算违规；雨停前沈岸不知道信封内有地图；清晨发现，第2章为同日午后。第二条是计划与决定：“原定安排等待雨停”是计划而非禁令，正文写出新决定及理由后改变或提前执行计划属正常叙事；只有未写出新决定或理由就把原计划当作已执行或已放弃，或与所选来源状态（核查尚未开始）矛盾，才判违规。
- C18-B：原文（只承接所选代、不混入未选分支、不证明外部 DAV）保留，追加同样的两条。
- C17-A：同属“等待雨停”来源，原文保留，追加同样的两条。
- C17-B：原文“林澄撤回旧核查安排，等待新通行许可；旧安排不得被写作已执行事实”保留，追加同样的硬事实条。计划条改为针对撤回：正文写出许可到来，或人物针对撤回作出新决定并写明理由后再行动，属正常叙事；未写出许可或新决定与理由，就按已撤回的旧安排（如雨停即出发）行动，或把旧安排写成已执行，判违规。其中钥匙与知情在 C17-B 原 oracle 中未点名，这是一项收紧，理由是作者设定写明“铜钥匙始终由林澄保管”，且 fa8806d7 两名评审都认为押出钥匙若在判定维度内就足以判 FAIL。现把四个续写案的硬事实统一。
- 逐条审视后未改的项：C16-A/B/C 审的是 notes/cards 对定稿计划状态的记录，“核查尚未开始、原安排待雨停”在那里正是被记录的事实状态，不存在“人物新决定”的情形，因此不改。C17-A 的“清晨→昨夜”属于时间事实的真实改写，不是措辞差异，继续判违规。“旧钟异常被替换”是核心事实被替换，保留为硬事实，只明确“换措辞不算替换”。automatic 项全部不变。

五、账本历史边界：新增 `historicalC16Fa8806d7Boundary`，接在 `historicalC1673b46513Boundary` 之后，覆盖第649–690行（fromEventCount 648 → eventCount 690）。这一段是协议 `s14b-candidate-quality-and-comparison-v2`、hash `7a17f36a70fcc5df185528c042f536261532f524e19fa5e266f45df4505701a3`（场景 v4）下的真实 invocation `fa8806d7-5287-4059-82a0-c1c316396067`，candidate 身份为 codeSha `8a07eb16b91e2d3e12338aac4619804a8e07e860`、sourceHash `87cdbbb2…5332`、driverHash `014f5770…3350`，共 14 次 attempt，全部 settle，parityId 逐 attempt 登记；前 690 行 sha256 为 `1090745ab998f81e04b5d825c1c49135814700bfbd6f4d46504b6a35f9d6ac5c`（即登记本段时的整本账本，此后由下一段 `historicalC16B42cfc55Boundary` 加性接续）。这些数值都只读推导自账本，账本字节未改。runner 读写两入口按链末端取历史范围，其后的新 reserve 按 v5 协议完整校验。fa8806d7 的独立评审 FAIL（R1：C16-C/C17-A/C17-B；R2：C16-C/C17-A/C17-B/C18-A/C18-B；评审包 d103 `c16-c18-8a07eb16-review-fa8806d7`）按原结论永久保留，不按 v5 oracle 或对账规则追溯改判。旧目标因协议字节 hash 漂移而拒绝，须重新冻结。

六、账本历史边界：新增 `historicalC16B42cfc55Boundary`，接在 `historicalC16Fa8806d7Boundary` 之后，覆盖第691–738行（fromEventCount 690 → eventCount 738）。这一段是协议 `s14b-candidate-quality-and-comparison-v2`、hash `31f8b204806efa41bd7ebf4faf094fac6ff3e8f4df2a4136472ccee7305a2c5a`（场景 v5）下的真实 invocation `b42cfc55-e214-4d51-b4c8-6b6bd2e5ea16`，candidate 身份为 codeSha `2f420a38e80e8548fd2827fc39c355d0ea248738`、sourceHash `010c1a79…c46d`、driverHash `dbc1cfd8…ff92`，共 16 次 attempt（七案最短物理路径），全部 reserve→dispatch→settle，parityId 逐 attempt 登记。前 690 行 sha256 为 `1090745ab998f81e04b5d825c1c49135814700bfbd6f4d46504b6a35f9d6ac5c`（与 fa8806d7 段登记的整本账本一致，字节未变），前 738 行（即登记本段时的整本账本，此后由下一段加性接续）sha256 为 `2aecf9a8bbfad77791eddb4a4015306a3d44967f89a41d858e2d4f8d43ea3e73`。这些数值只读推导自账本与该 invocation 的 stdout 收据（sha256 `0904e21587a4966271e290693ff14bfd31f3b2f0507f2a7dc8d3247e973d581a`，sourceHash/driverHash 与账本 reserve 行绑定逐项一致），账本字节未改。runner 读写两入口按链末端取历史范围（登记本段时为本段第738行，此后由下一段 `historicalC1667a57c04Boundary` 接续），其后的新 reserve 按当前协议完整校验。该 invocation 的自动阶段七案通过；随后两名独立盲评分别判：R1 判 C16-B、C18-A FAIL，R2 判 C18-A FAIL、C16-B PASS（边缘）；两人对 C18-A 一致，C16-B 的分歧另经一次独立仲裁（仲裁者未调用 advisor）判 FAIL，故 C18-A、C16-B FAIL，按原结论永久保留，不按任何后续协议或修复追溯改判。本段是纯历史登记，不是评分规则变更：场景 revision、oracle、attemptPolicy 与评分规则均未改。登记后 `protocol.json` 的完整字节 hash 随之改变，旧目标因协议字节 hash 漂移而拒绝，须重新冻结。

七、账本历史边界：新增 `historicalC1667a57c04Boundary`，接在 `historicalC16B42cfc55Boundary` 之后，覆盖第739–774行（fromEventCount 738 → eventCount 774）。这一段是协议 `s14b-candidate-quality-and-comparison-v2`、hash `4491c88d35bf3d23d862d44825de17ad667e3b0286e8be5c245ba4f2c24cd563`（场景 v5，即登记上一段后的 `protocol.json` 字节）下的真实 invocation `67a57c04-b92f-4746-84bb-b2fbe9ee01f6`，candidate 身份为 codeSha `b6bef1f3584f5818e3af344da7a2f07925e9d611`、sourceHash `27201870…5b20`、driverHash `dbc1cfd8…ff92`（与上一段相同），共 12 次 attempt（C16-A 2、C16-B 3、C16-C 2、C17-A 2、C17-B 3），全部 reserve→dispatch→settle，parityId 逐 attempt 登记。前 738 行 sha256 为 `2aecf9a8bbfad77791eddb4a4015306a3d44967f89a41d858e2d4f8d43ea3e73`（与 b42cfc55 段登记的整本账本一致，字节未变），前 774 行（即登记本段时的整本账本，此后由下一段加性接续）sha256 为 `7c7fa687e2f0c097e274dc204d661f677b307a500d1c2ca26688f890c8542ff9`。这些数值只读推导自账本与该 invocation 的 stdout 收据（sha256 `ef9335a8f94a83453debbdf7e2840d9f5da8f61fbb75f9387cda99c903677181`，sourceHash/driverHash 与 attemptId 序列同账本 reserve 行逐项一致），账本字节未改。该 invocation 的收据 `status` 为 failed（`candidateFailure` 为 `CANDIDATE_OPERATION_MISSING`）：C16-A/B/C、C17-A 逐案记 passed（仅为自动阶段结果，未做独立语义评审），C17-B 记 failed（`code` 为 `PRODUCTION_BRIDGE_FAILED`，`preflightFailures` 为 `OUTBOUND_REQUIRED_PREDECESSOR_MISSING`），按 `stopPolicy` 技术失败即停发，C18-A、C18-B 为 NOT RUN（`DAV选定世代恢复后续写` 0 次物理请求），`qualityQualification` 与 `formalSampleQualification` 均为 failed，未满足七案逐案资格，不得汇总 PASS。账本层面 12 次物理请求全部 settle，如实登记，不因该 invocation 失败而改写终态；边界只登记身份与证据，不含任何结论字段。该失败按原结论永久保留，不补采、不改判，也不按后续修复、协议或更换案例追溯为通过。本段是纯历史登记，不是评分规则变更：场景 revision、oracle、attemptPolicy 与评分规则均未改。登记后 `protocol.json` 的完整字节 hash 随之改变，旧目标因协议字节 hash 漂移而拒绝，须重新冻结。

八、账本历史边界：新增 `historicalC162867cfa4Boundary`，接在 `historicalC1667a57c04Boundary` 之后，覆盖第775–828行（fromEventCount 774 → eventCount 828）。这一段是协议 `s14b-candidate-quality-and-comparison-v2`、hash `1d7c737bd956e25c855390b0976de90c95364db85a3a52e86c2c36df647a3b11`（场景 v5，即登记上一段之后、登记本段之前的 `protocol.json` 字节）下的真实 invocation `2867cfa4-a10f-4912-8134-edf0f83e608e`（phase `c16-c18`、milestone `final`、mode `real`、arm `candidate`），candidate 身份为 codeSha `2147b95cc94300c75a2ae804554f99b82675df02`（即登记上一段的提交）、sourceHash `880dc80c…0b73`、driverHash `dbc1cfd8…ff92`（driverHash 与上两段相同），共 18 次 attempt（C16-A 2、C16-B 2、C16-C 3、C17-A 2、C17-B 5、C18-A 2、C18-B 2），全部 reserve→dispatch→settle（`finishReason` 均为 `stop`），parityId 逐 attempt 登记。前 690 行 sha256 为 `1090745ab998f81e04b5d825c1c49135814700bfbd6f4d46504b6a35f9d6ac5c`（fa8806d7 段登记的整本账本）、前 738 行为 `2aecf9a8bbfad77791eddb4a4015306a3d44967f89a41d858e2d4f8d43ea3e73`（b42cfc55 段登记的整本账本）、前 774 行为 `7c7fa687e2f0c097e274dc204d661f677b307a500d1c2ca26688f890c8542ff9`（67a57c04 段登记的整本账本），三者字节均未变，前 828 行（即登记本段时的整本账本，此后由下一段加性接续）sha256 为 `51a5ea830f44ed6149e2f282b44d6281efe70ddcf22d81f7b9cba09561a3cc2b`。这些数值只读推导自账本与该 invocation 的 stdout 收据（`s14b-2147b95c-c16-c18-final-real.stdout.json`，sha256 `be93ff866031f8c3893964340ed86f3e63577260e59214bce6a6a4ef0f331fb9`，328931 字节，同名 stderr 为空文件），账本字节未改。收据事实：顶层 `status` 为 `pending-independent-oracle-review`，`qualification` 为 `real-production-path-only`，`physicalModelRequests` 为 18、`syntheticDispatches` 为 0，七案自动阶段逐案记 passed（仅为自动阶段结果）；`operationCounts`（逻辑/物理）为定稿章节要点 3/3、定稿角色状态 3/4、本地恢复后续写 2/4、DAV选定世代恢复后续写 2/4、恢复副本重新定稿章节要点 1/1、恢复副本重新定稿角色状态 1/2，其中 C16-C 与 C17-B 的定稿角色状态各多 1 次 repair 请求（purpose `finalized-character-state:repair:1`）；四个续写案（C17-A、C17-B、C18-A、C18-B）各为 1 次对账（`chapter-draft-reconcile`）加 1 次首稿（`chapter-draft`），`draftReconciliation` 逐案 `injected`、conflicts 0，无 `chapter-draft-condense` 请求。收据 `results[].attempts` 的 attemptId 序列，以及各 attempt 的 codeSha、sourceHash、driverHash、protocolHash、invocationId、parityId、caseId、operation，与账本 reserve 行逐项一致。独立评审：评审包 `c16-c18-2147b95c-review-2867cfa4`（位于账本所在的 `.runtime/.cache/novel-quality-modernization/` 目录下，manifest.json sha256 `85ed09a85b196fc48bda969dc226524d26b4494c758a3968e50a9926ddf2b7ee`，74 项哈希核对 0 mismatch），两名互不可见评审的报告 `review-r1.md`（sha256 `4b071fb5ec345986531ab833312c9a77e393642ead22c64e5580663daf22cabd`）与 `review-r2.md`（sha256 `d42ce07e9d833e98670b9b59070f926d69242ba6f8ab8525ce2cdbb59525bebe`）对七案 C16-A、C16-B、C16-C、C17-A、C17-B、C18-A、C18-B 均判 PASS，总体结论均为 PASS，两人无分歧，未经仲裁。两人各自记录的非判定观察（不改变逐案结论）包括：四个续写稿对“承担具体代价”的落笔偏薄，多为推迟或预期性后果，而非已实际承担的具体损失；C18-B 草稿延伸到同日傍晚（仍以午后起笔）；C17-B 的 notes 把夹具标签“恢复副本”当作故事内文本载体（元标记泄漏，与 oracle 点名事实不冲突）；另有若干临界点（如 C17-B 草稿未复述旧钟日期、C18-A 钥匙来历叙述）两人均按 oracle 字面判不违规。细节以两份评审文件原文为准。C18 的 DAV 证据均为合成回环（收据 `dav.transport` 为 `synthetic-loopback-fetch`，`externalRequests` 为 0），不证明外部 DAV 服务。边界只登记身份与证据，不含任何结论字段，评审结论只在本节作为事实记录。本段是纯历史登记，不是评分规则变更：场景 revision、oracle、attemptPolicy 与评分规则均未改，本节也不改变任何协议、场景或评分规则；该 PASS 只限 C16–C18 七案，不构成 V3 完成，也不代表外部 DAV 资格或 S14B/S14C/S14D 任一门的通过。b6bef1f3 上 67a57c04 的失败（`CANDIDATE_OPERATION_MISSING`，C17-B 被前驱预检拦截）与更早的全部失败、评审 FAIL 按原结论永久保留，不因本 invocation 的结果而改判、补采或追溯改写；收据里的 `qualityQualification` 与 `formalSampleQualification` 原文仍为 `pending-independent-oracle-review`，本节不改写收据。runner 读写两入口按链末端（本段，第828行）取历史范围，其后的新 reserve 按当前协议完整校验。登记后 `protocol.json` 的完整字节 hash 随之改变，旧目标因协议字节 hash 漂移而拒绝，须重新冻结。

九、账本历史边界：新增 `historicalPostUiBa2d34abBoundary`，接在 `historicalC162867cfa4Boundary` 之后，覆盖第829–843行（fromEventCount 828 → eventCount 843）。这一段是协议 `s14b-candidate-quality-and-comparison-v2`、hash `7cf6e1ce4a7f91c408af3fed1369d914ff2e53a3f19501169ebf12ee2c997869`（即 `a618c122` 提交里的 `protocol.json` 字节，post-UI 场景 `s14b-post-ui-reviewed-budget-review-rebuild-must-show-v2`）下的真实 invocation `ba2d34ab-a4f6-4283-bed1-eb2bffa8b5aa`（`early-budget --milestone post-ui`，两臂）：baseline 身份为 codeSha `2264390d6fb8b052cc14736d544df0cc74516649`、sourceHash `9b0d78fc…d4e8`、driverHash `dbc1cfd8…ff92`、整臂 parityId `3c217fca…127e`；candidate 身份为 codeSha `a618c122d02d3abf08103620db063118e710073d`、sourceHash `880dc80c…0b73`、driverHash `dbc1cfd8…ff92`，parityId 逐 attempt 登记（同为 `3c217fca…127e`）。共 5 次 attempt，全部 reserve→dispatch→settle（`finishReason` 均为 `stop`）：baseline 3 次（指定范围生成、900单位正文、成稿首审），candidate 2 次（指定范围生成、900单位正文）。前 828 行 sha256 为 `51a5ea830f44ed6149e2f282b44d6281efe70ddcf22d81f7b9cba09561a3cc2b`（2867cfa4 段登记的整本账本，字节未变），前 843 行（即登记本段时的整本账本，此后由下一段加性接续）sha256 为 `baa7666b4905b268d0a96c5d4443cdd5f935f52b3b077bdeac52f86fbc89c1b5`。这些数值只读推导自账本与该 invocation 的 stdout 收据（`s14b-a618c122-postui-final-real.stdout.json`），账本字节未改。收据事实：顶层 `status` 为 `failed`，`qualityQualification` 为 `automatic-gate-failed`，`pairFailure` 为 `REVIEWED_DRAFT_EVIDENCE_INVALID`（candidate 没有可用的审修链），`physicalModelRequests` 为 5、`syntheticDispatches` 为 0。baseline 三步自动阶段完成（首稿 795 单位，首审 pass/unknown，保留初稿）。candidate 臂 `code` 为 `PRODUCTION_BRIDGE_FAILED`、`reason` 为 `GENERATION_DRAFT_LENGTH_OUT_OF_RANGE`：`900单位正文` 首稿以 `stop` 结束、按生产计数为 1210 单位，超出 candidate 上限 1170（目标 900，±30%）；产品随即发起第二次原生压缩请求（candidate 项目库里同一 draft run 的第三条 attempt，purpose 为 `chapter-draft-condense`，状态 `unknown`，没有进入账本），但该 operation 在当时的登记（v2）里没有 `draftCondense`，账本没有第二次 reserve 行，调用序列在第二次 `generation:execute` 之后即 `generation:pause`，与 dispatch 门在 v2 登记下对同一请求序列于 reserve 前拒绝（`UNREGISTERED_ADDITIONAL_MODEL_REQUEST`）的行为一致（该拒绝由确定性测试复现）。账本层面 5 次物理请求全部 settle，如实登记，不因该 invocation 失败而改写终态；边界只登记身份与证据，不含任何结论字段。该失败是登记缺口与产品原有字数门共同造成的技术失败，不构成模型质量结论；按原结论永久保留，不补采、不改判，也不按后续登记变更或更换案例追溯为通过，更早的全部失败与评审结论同样保留。本段是纯历史登记，不是评分规则变更：本节不改变任何协议、场景或评分规则；post-UI 场景 v3（候选臂唯一压缩登记）是另一项、已在 S07 段单列披露的评分规则/场景变更，二者分开说明。runner 读写两入口按链末端（本段，第843行）取历史范围，其后的新 reserve 按当前协议完整校验。登记后 `protocol.json` 的完整字节 hash 随之改变，旧目标因协议字节 hash 漂移而拒绝，须重新冻结。

九（续）、账本历史边界：新增 `historicalPostUi1d0bdac3Boundary`，接在 `historicalPostUiBa2d34abBoundary` 之后，覆盖第844–861行（fromEventCount 843 → eventCount 861）。这一段是协议 `s14b-candidate-quality-and-comparison-v2`、hash `08dbed9d6b5ac52cd25aef24feb0b728f4772b8f230c74cbed34f293230b5cfd`（即 `02e94787` 提交里的 `protocol.json` 字节，post-UI 场景 `s14b-post-ui-reviewed-budget-review-rebuild-must-show-v3`）下的真实 invocation `1d0bdac3-6dc9-4f75-9bb8-405716b07711`（`early-budget --milestone post-ui`，两臂）：baseline 身份为 codeSha `2264390d6fb8b052cc14736d544df0cc74516649`、sourceHash `9b0d78fc…d4e8`、driverHash `abf22f3e…c4ff`、整臂 parityId `3c217fca…127e`；candidate 身份为 codeSha `02e947874365a8da074bcfdefe330c64dac0f58f`、sourceHash `880dc80c…0b73`、driverHash `abf22f3e…c4ff`，parityId 逐 attempt 登记（同为 `3c217fca…127e`）。共 6 次 attempt，全部 reserve→dispatch→settle（`finishReason` 均为 `stop`），每臂 3 次（指定范围生成、900单位正文、成稿首审）。前 843 行 sha256 为 `baa7666b4905b268d0a96c5d4443cdd5f935f52b3b077bdeac52f86fbc89c1b5`（ba2d34ab 段登记的整本账本，字节未变），前 861 行（即登记本段时的整本账本，此后由下一段加性接续）sha256 为 `60610b99ef8456da2aa09a159962de9a26bbdfbbf955ae7b5a411e5b62403d22`，只读推导自账本，账本字节未改。事实陈述仅限：该次调用自动阶段两臂通过；candidate `900单位正文` 只有一个 reserve，首稿在区间内，没有发起压缩；盲评待独立裁定（已由主 Agent 记录于私有检查点）。边界只登记身份与证据，不含任何结论字段；本节不写质量结论，不宣称相对改善，也不改判任何历史结果，ba2d34ab 及更早的失败与评审结论按原结论永久保留。本段是纯历史登记，不是评分规则变更；full 场景 v2 是另一项、已在 Full 一节单列披露的变更，二者分开说明。runner 读写两入口按链末端（本段，第861行）取历史范围，其后的新 reserve 按当前协议完整校验。登记后 `protocol.json` 的完整字节 hash 随之改变（协议同时含 full v2 的登记），旧目标因协议字节 hash 漂移而拒绝，须重新冻结。

十、账本历史边界：新增 `historicalC16Ac3af420Boundary`，接在 `historicalPostUi1d0bdac3Boundary` 之后，覆盖第862–909行（fromEventCount 861 → eventCount 909）。真实 invocation `ac3af420-c49f-43b1-b7a0-a9ac7aff7785` 使用协议 `s14b-candidate-quality-and-comparison-v2`、hash `ca1937fce79db7e35cf0ee502707373f99013b6ec7d5790cc84143f87e9e73ad`（e9a39853 提交内原始 LF 字节），phase `c16-c18`、milestone `final`、mode `real`、arm `candidate`。原 codeSha 为 `e9a39853550be0acd4bbfe0687f8104566820052`，sourceHash 为 `4ed425b8152aaf1d9493b4f022628483d7fb8889221457d5b99dc892ffd51b2b`，driverHash 为 `9f63e3d2602b5fc18e8e8ac8e2fd933ba56075889bad241b235af2c3cffd995e`；parityId 按实际 attempt 逐项登记。新增48行对应16次 reserve→dispatch→settle，finishReason 均为 stop；原前861行 sha256 `60610b99ef8456da2aa09a159962de9a26bbdfbbf955ae7b5a411e5b62403d22` 不变，前909行 sha256 为 `99fcd7c8c5b61e4c87495b14d383161180e43590393ca85b9f0411b7ee97ca26`。这些数值与 attemptId 顺序、全部 binding（含实际 run/root/project/epoch）由唯一物理账本和原 stdout `e9-c16-final-real.stdout.json`（sha256 `8a33f1e23306cbf9d553bb7995772be2aae8f345acf03ef91e770ae55e63b4f6`）逐项核对，账本和原回执字节未改。原回执记录7案自动阶段 passed、16次物理请求、0次 syntheticDispatches；status、qualityQualification、formalSampleQualification 均保持 `pending-independent-oracle-review`，qualification 为 `real-production-path-only`。本段仅登记已发生的物理历史，不提供独立语义评审或质量结论，不改判任何历史失败，不改变 scenario、oracle、评分、预算或权限。runner 读写两入口接续至第909行，之后的新 reserve 仍按当前协议完整校验；本次登记改变协议完整字节 hash，后续执行须重新冻结，不能复用原目标的旧 protocolHash。

十一、账本历史边界：新增 `historicalC16A9552e67Boundary`，接在 `historicalC16Ac3af420Boundary` 之后，覆盖第910–957行（fromEventCount 909 → eventCount 957）。真实 invocation `a9552e67-c26a-4f39-ab8b-e9565c20e798` 使用协议 revision `s14b-candidate-quality-and-comparison-v2`、原 hash `16d5b78adccda6707110b407f7733ca657dcbcf54502a704fc8a450810eb4731`，candidate codeSha `98b6348195afc75af247bbce2abff674736b308a`、sourceHash `aa37688321a32bbb8c7ae350fcc97f2b03f251773309f5224ec82aedffa36941`、driverHash `e0f2a516b06f5ce3530f4b353c3012023d41007d231ff3125619ab04d33cee9e`，parityId 按实际 attempt 逐项登记。新增48行对应16次 reserve→dispatch→settle，finishReason 均为 stop；原前909行 sha256 `99fcd7c8c5b61e4c87495b14d383161180e43590393ca85b9f0411b7ee97ca26` 不变，前957行 sha256 为 `77bbc8c77048d7bd3f322ccfaaead7e0648a27055d4d7caa99c15105b5a1dcbb`。唯一物理账本与原 stdout `98b63481-c16-final-real.stdout.json`（sha256 `56be399a3c6421d6eecaa9cc349a3e63e25b2bbf9233dda12f828417cc7d14f8`）逐项核对 attempt 顺序、完整 binding 和运行身份；目标 candidate 的 code/source/driver/protocol 身份相同。原 stdout 记录7案、16次物理请求、0次 syntheticDispatches，status 保持 `pending-independent-oracle-review`。本段只登记已发生的物理历史，不提供质量结论，不改判历史失败，也不改变 scenario、oracle、评分、预算或权限。runner 读写两入口接续至第957行；之后新 reserve 仍按当前协议完整校验，需重新冻结目标。

本轮预注册在 `protocol.json.phases.c16-c18` 固定 C16-A→B→C、C17-A→B、C18-A→B 的 `caseOrder`、逐案 `caseOracles` 和 `stopPolicy`；runner 在执行前将该顺序与实际 `semantic-source.json.continuityQualificationCases` 逐项核对。自动证据核对物理 attempt、来源、持久效果、恢复身份与分支选择；语义事实在真实执行后由两名独立评审分别引用原定稿、notes/cards 和续写正文核验。任一技术失败立即停发，后续案记 NOT RUN；后判的语义 FAIL/UNKNOWN 保留全部已发送结果和原证据，不补采改判。16次（v5；v4 为12次，v3 及以前为10次）只是七案最短物理路径，不能合并报正式 PASS；旧目标因新协议完整字节 hash 漂移而拒绝，须重新冻结。C18 仅验证选定完整世代与未选分支不混入，不证明外部 DAV 服务。

离线 DAV 使用原控制器和服务、受限 loopback 地址的合成 transport，单独报告 DAV 请求数，不能充当真实网络、双 profile、OS 凭据或打包资格。嵌入配置须从实际隔离配置回读；本最小路径只选择 notes/cards、无 KB 导入。恢复回执必须包含新项目身份、transfer 来源、旧任务冻结与源项目不变；原6/4正式资格、文学裁决和历史 FAIL 均不由合成通过改判。

中文语义源逐项登记C16自动derived正例、author冲突、同名改名、拒绝重启、旧outbox、CAS作者并发、较早章迟到、同章旧版本、身份不明及后处理失败。全部消费现有提取路径，禁止每角色新建付费调用。

C17覆盖正文/头像/知识原文保全、新项目ID与稳定领域ID、当前可读author/derived来源承接、历史候选与未知已发冻结、秘密字段及其hash排除、未知字段blocked、跨revision与恢复碰撞。C18覆盖无CAS追加、同父分叉、origin-readonly重启、latest缺失、上传后本机绑定失败。模型继续创作仅使用4次预留；其余故障优先确定性fixture，未执行不记通过。

编辑交互资格自 2026-09-24 起由[现行 F05](frontend-transition-specs.md#f05--最终-v3-功能及桌面体验资格) 的 `editor-interaction-v2` 拥有；冻结 `feature-union.editor-absolute-v1` 及旧结果只供历史检查，不再要求旧 Classic 基线或相对性能门。依 2026-09-25 用户指令，U06.A03 中文 IME 实测免测、不作为阻断，记 `WAIVED_BY_USER`（非 PASS），历史 FAIL 原样保留；其余编辑、保存与响应仍必验。不以模型预算扩成颜色乘积。F05三门须同postUiIntegrationSha的新收据；旧early结果不能代填。当前 postUiIntegrationSha 取 S14A 实际冻结候选；先前确定性 Final 的沿用或受影响路径复验按现行交付 delta 执行，不要求回到旧 F05 的 SHA。编辑具体测量器由F04/F05维护，此runner未实现UI性能资格，文学模型吞吐不混入编辑响应计时。

## 后续阶段接线边界

S07 early-budget 已接默认生产命令及最终 fetch 处的 reserve/dispatch/settle/unknown，未新增生产 observer hook。后续阶段须复用同一总账和实际项目回读，绑定各自 phase/milestone/原 attempt，不能在高层一次 run 扣一次。S10B提供上下文证据、S11提供审稿→定向修稿→唯一复核，保存输出、模板/Skill与compiled prompt哈希；不要另建直接API实验器。主集成者固定唯一总账与未消费阶段预留、出两臂manifest、盲评映射、post-UI与最终subject冻结。未实现的阶段正式运行保持blocked。

启动冻结补充：manifest.environment绑定实际 executable 字节hash、版本与module ABI，以及 esbuild/vitest/Electron/better-sqlite3 安装manifest路径、版本、hash。schemaVersion=1 的 nativeProfile 仅为历史旁证，原 node-js 探针不加载 native；schemaVersion=2 另绑定实际加载并查询过的 SQLite binary。startup 固定执行器与已hash驱动，不接受任意命令；实际无shell argv写入每次桥接收据。正式执行前后重新验证 source/tools/adapter/environment/startup，任何漂移拒绝。early-budget每臂显式包含一次范围生成与一次正文生成，early/post-UI各4次；22次失败余量及总计80次均为计划分配，不是调用硬帽。

十二、账本历史边界：新增 `historicalC1663a44636Boundary`，接在 `historicalC16A9552e67Boundary` 之后，覆盖第958–1005行（fromEventCount 957 → eventCount 1005）。真实 invocation `63a44636-aa79-441d-9236-6af956c0647e` 使用协议 revision `s14b-candidate-quality-and-comparison-v2`、原 hash `311bd2e993ea5c2548a1d7677e9384715e13c3d6f5702d8291247bc861ac8196`，candidate codeSha `613a55cdd9c74730dd29a1af6ca100d6547dea7e`、sourceHash `a6288dfbb06bfffb6cfdb7d489c4236318a3f59160d6beb17b4e4d37fadb71d4`、driverHash `e0f2a516b06f5ce3530f4b353c3012023d41007d231ff3125619ab04d33cee9e`，parityId 按实际 attempt 逐项登记。新增48行对应16次 reserve→dispatch→settle，finishReason 均为 stop；原前957行 sha256 `77bbc8c77048d7bd3f322ccfaaead7e0648a27055d4d7caa99c15105b5a1dcbb` 不变，前1005行 sha256 为 `566dd2547eb812991fe559caf9c0d72b00f5e224f1e049a083f2411db5866523`。唯一物理账本与原 stdout `613a55cd-c16-final-real.stdout.json`（sha256 `0fa1b71625624ff6bb57d6c0083ec68ace92b2380869e955cd3c65e0b8b5bad7`）逐项核对16组 attempt 顺序、完整 binding（含实际 attempt/run/root/project/epoch）；原 targets `s14b-613a55cd-c16-final-targets.json`（sha256 `068aeb69930abfebfca6bb84b585a3944231924d4c78ab80cd5f0ca124d2a234`）中的 candidate code/source/driver/protocol 身份相同。原 stdout 记录7案、16次物理请求、0次 syntheticDispatches，status 保持 `pending-independent-oracle-review`，原退出码3。本段只登记已发生的物理历史，不提供质量结论，不改判历史失败，也不改变 v7 scenario、oracle、评分、预算或权限。runner 读写两入口接续至第1005行；之后新 reserve 仍按当前协议完整校验，需重新冻结目标。

十三、账本历史边界：新增 `historicalC16A4d2b6edBoundary`，接在 `historicalC1663a44636Boundary` 之后，覆盖第1006–1041行（fromEventCount 1005 → eventCount 1041）。真实 invocation `a4d2b6ed-9f61-4b4b-b698-c16d0dec1efe` 使用协议 revision `s14b-candidate-quality-and-comparison-v2`、原 hash `336ac6c686a46bf401f60efd98c30c57afbcac277783aa2f72139762a7f7483e`（冻结模型树与74d168a6提交的原始LF字节），candidate codeSha `74d168a6cbd4b56c83c487db80634de367b2ff36`、sourceHash `702a2229aad38f8877061d80b47816b4849c7360edf5eed2b3c26717412620e5`、driverHash `843f16bf94bea40c530c65ae0439d48f0608e2274dade379dbffaab64bfdebea`，parityId 按实际 attempt 逐项登记。新增36行对应12次 reserve→dispatch→settle，finishReason 均为 stop；原前1005行 sha256 `566dd2547eb812991fe559caf9c0d72b00f5e224f1e049a083f2411db5866523` 不变，前1041行 sha256 为 `193d9e5638a4406bd51a0dc4217704f181e83c752cd65c45af3d65976b6648d5`。唯一物理账本与原 stdout `74d168a6-c16-final-real.stdout.json`（sha256 `76e57a0fe2dcb176efe01ec19c878a816f46e9688180595ad973fe9bcdbfb0c2`）逐项核对12组 attempt 顺序、完整 binding（含实际 attempt/run/root/project/epoch）及 terminal；原 targets `s14b-74d168a6-c16-final-targets.json`（sha256 `feca38b4573d732d1e7a6ff234196f5cb430b7ece06a03bce1ce9dc60624e91f`）中的 candidate code/source/driver/protocol 身份相同。原 stdout 记录7案、12次物理请求、0次 syntheticDispatches，status 保持 `pending-independent-oracle-review`，原退出码3。本段只登记已发生的物理历史，不提供质量结论，不改判历史失败，也不改变 v7 source、oracle、评分、预算或权限。runner 读写两入口接续至第1041行；之后新 reserve 仍按当前协议完整校验，需重新冻结目标。

十四、账本历史边界：新增 `historicalC160917fb36Boundary`，接在 `historicalC16A4d2b6edBoundary` 之后，覆盖第1042–1080行（fromEventCount 1041 → eventCount 1080）。真实 invocation `0917fb36-a66d-43a3-b75e-2c1bcd632947` 使用协议 revision `s14b-candidate-quality-and-comparison-v2`、原 hash `0e37a576fbe3c31497b64e9c28bac5b09d05a21222d4c00def1b81979745fa41`（冻结模型树原始字节），candidate codeSha `043b3dc37d8b208f30eac6dfc50cddf80b01a8f5`、sourceHash `9c499be0c25cc03d2d4ef189bc06e14dd6dd03fbf0b52e6871f64232cff76b5d`、driverHash `843f16bf94bea40c530c65ae0439d48f0608e2274dade379dbffaab64bfdebea`，parityId 按实际 attempt 逐项登记。新增39行对应13次 reserve→dispatch→settle，逐条核对账本和 stdout 的 finishReason 均实际为 stop。原前1041行 sha256 `193d9e5638a4406bd51a0dc4217704f181e83c752cd65c45af3d65976b6648d5` 不变，前1080行 sha256 为 `8e127ea7a1b63349701646b30c0d5f18ea50669942c31ae43c539144f9ef7885`。唯一物理账本与原 stdout `043b3dc3-c16-final-real.stdout.json`（sha256 `e3a07ac8df826a532bbd24e52b53e9c88227b534e444e180c6008565e5b93264`）逐项核对13组 attempt 顺序、完整 binding（含实际 attempt/run/root/project/epoch）及 terminal；原 targets `s14b-043b3dc3-c16-final-targets.json`（sha256 `3b5009e0100ba5bde6b10f7179c2e2e4c8abedce46e3b6a58982bef3ec8f9ba4`）中的 candidate code/source/driver/protocol 身份相同。原 stdout 记录7案、13次物理请求、0次 syntheticDispatches，status 保持 `pending-independent-oracle-review`，原退出码3。本段仅登记物理历史，不读取新语义评审，不提供质量结论，不改判历史失败，也不改变 v7 source、oracle、评分、预算或权限。runner 读写两入口接续至第1080行；之后新 reserve 仍按当前协议完整校验，需重新冻结目标。

十五、账本历史边界：新增 `historicalC161aa5487eBoundary`，接在 `historicalC160917fb36Boundary` 之后，覆盖第1081–1122行（fromEventCount 1080 → eventCount 1122）。真实 invocation `1aa5487e-4ebd-4e90-9061-e9a03a63b7a0` 使用协议 revision `s14b-candidate-quality-and-comparison-v2`、原 hash `5d582c4b96b55d7c524cac2eb1e7da685e6662318b7bb723f552cc0e6ddc492c`（冻结模型树原始字节），candidate codeSha `5a8208dd0f7173fbc43f20f390e852b83754c3d8`、sourceHash `b30644900d07fc039606a2d7360bf6e91d7155eb381981005d91e7fcd872730e`、driverHash `843f16bf94bea40c530c65ae0439d48f0608e2274dade379dbffaab64bfdebea`，parityId 按实际 attempt 逐项登记。新增42行对应14次 reserve→dispatch→settle，逐条核对账本和 stdout 的 finishReason 均实际为 stop；包含 C16-A 的 `finalized-character-state:repair:1` 及 C17-A 的 `chapter-draft-condense` 既有生产支路。原前1080行 sha256 `8e127ea7a1b63349701646b30c0d5f18ea50669942c31ae43c539144f9ef7885` 不变，前1122行 sha256 为 `a925a7775242c79909da3a23004cd0bb4fe58fd2cea73b63897b727bd298a236`。唯一物理账本与原 stdout `5a8208dd-c16-final-real.stdout.json`（sha256 `f6ad1b4a3fbe9d879711d0f4f3754f87a3be82f58101b7869a07baedb641c1a2`）逐项核对14组 attempt 顺序、完整 binding（含实际 attempt/run/root/project/epoch）及 terminal；原 targets `s14b-5a8208dd-c16-final-targets.json`（sha256 `f5ea4ac675a3a19328953cab563cafec707fab2bf2328e3dcdc481408b55c979`）中的 candidate code/source/driver/protocol 身份相同。原 stdout 记录7案、14次物理请求、0次 syntheticDispatches，status 保持 `pending-independent-oracle-review`，原退出码3。本段仅登记物理历史，不提供质量结论、不改判历史失败，不改变冻结来源、oracle、评分、预算或权限。runner 读写两入口接续至第1122行；之后新 reserve 仍按当前协议完整校验，需重新冻结目标。

十六、账本历史边界：`historicalC169337909dBoundary` 接在上述边界后，覆盖第1123–1158行（1122 → 1158）。真实 invocation `9337909d-a526-4684-b5ff-80cad9206d3a` 的12次 candidate 请求均有 reserve→dispatch→settle，原 stdout 记录7案、12次物理请求、0次 syntheticDispatches、12次 finishReason `stop`，退出码3，状态仍为 `pending-independent-oracle-review`。执行时协议 revision 为 `s14b-candidate-quality-and-comparison-v2`、原协议 hash 为 `924513bae3afc3e7495eeb6d7f873f83795d0695975f678d04ebff66d19ec8d2`；candidate codeSha `2e3500b828e9e17d376a2451d53a7639bf1eed7f`、sourceHash `3b52d46f48c541637da3f324de0f01b45be5e5169301166657dd3687759a4ab4`、driverHash `976988e954c9cb1864c65aab33295a18b4917ab499ce6df643e34e1ec4f6571f`，各 attempt 的 parityId 按原账本逐项冻结。唯一物理账本前1122行 sha256 仍为 `a925a7775242c79909da3a23004cd0bb4fe58fd2cea73b63897b727bd298a236`，至1158行完整 sha256 为 `1e6d8af44ddeec1b8973e2635999e693bd0c378c9204a7846f4064f530861866`；原 stdout `2e3500b8-c16-final-real.stdout.json` sha256 为 `75b343e267b3df96b63098682decc5b7a8dd477a807186cc8353936c6830d014`，原 targets `s14b-2e3500b8-c16-final-targets.json` sha256 为 `9baf40de4d942b7f313dcbc8d940f1a1ca6883bdb691e15251776b741fa34a2c`。本段只认证历史物理身份；语义结论由独立审查另行裁定，实际模型元数据未验证，不据自动 casePASS 宣称质量通过。runner 读写两入口接续至第1158行，之后新 reserve 仍须满足当前协议。
## 9337909d 共享输入事实提取诊断（非资格）

`protocol.json` 的 `shared-input-diagnostic` 只登记 C17-A/C18-A 共有原始消息的一次 candidate 提取任务。私有输入包保留原 system/user 全文、原始材料三项 hash、原收据与测试 SHA；新请求将原两段全文各作为明确标界的引用资料，并以新的 system 和末尾任务要求五列表格。消息角色和包装已改变，不能称为相同请求，也不向模型提供历史失败正文或正确答案。

该诊断最多一次物理请求，任何 `stop`、`length`、`unknown` 或技术失败都不重试；新请求经现有 generation owner/controller、出站预检和逐请求账本。输出交两名独立评审按调用前冻结的私有判据判断；技术/语义不确定均为 `UNKNOWN`。结果只说明同一原材料在提取任务下的一次表现，不证明原写作失败的根因，不改变七案资格、历史 FAIL、baseline、post-UI/full 门禁或原 0.7 / max 参数配置。

## 固定零温度配置资格（非因果实验）

`forwardTemperatureExperiment` 仅在原 `forwardReasoningExperiment` 已登记的 C16 七案、post-UI 三个 selector 和 final full 范围生效，继承原范围与 caseIds，固定两臂模型 profile 的 `temperature: 0`。原 max 登记对象及语义源中的 `temperature: 0.7` 均原样保留；执行回执分别记录源参数和本次登记的有效参数。`shared-input-diagnostic` 不属于此范围，仍为 0.7 / max 的历史一次非资格调用。

实际模型配置回读与每次出站请求须满足新登记的 0、原 provider/protocol/modelName/maxTokens、原每操作 `max_tokens` 预算。candidate 自然发送 `enable_thinking: true` / `reasoning_effort: max`，baseline 自然缺席这两个字段；创作策略仍为 `auto`。未登记温度、错误 base revision、旧 max 对象或 case 范围漂移在 reserve 前拒绝。此轮只判断新固定配置下的既有绝对资格，不能以参数或两臂 wire 不对称宣称代码改善、先前失败根因或稳定性；C16 七案未通过不得进入 post-UI/full。

唯一物理账本的 `historicalSharedInput7203443dBoundary` 接在 `historicalC169337909dBoundary` 后，认证第1159–1161行（1158 → 1161）：真实 invocation `7203443d-d7aa-46e1-82b4-37ab1d392df5` 的单次 candidate 诊断 reserve→dispatch→settle，原协议 hash `7b6d01e3fd8788bedabd768a1757da4aa8cbc71358948e14a667e07e8b0f6bd6`，至1161行完整 sha256 `3a0293bce8c9d2123ea69f07c48fdca92d613ae1430fddfc27a57b504daec1dc`。该历史调用继续占用诊断唯一额度，不因本协议 revision 更新而重新开放；诊断结论和历史七案 FAIL 不改判。

`historicalC1670407421Boundary` 再接续第1162–1182行（1161 → 1182），以原始前缀 sha256 `4ae528592d515960ffdd860e9c9d1d1d9b1fda43783f32c31399c8ff7d6d8ae7`、invocation `70407421-7e4f-4614-b8f6-b890b2005d2a`、七次 candidate 的 code/source/driver 与逐次 parity 认证六次 settle、一次 C17-A UNKNOWN。末次 UNKNOWN 仍占用物理请求和原 slot；先前失败及 704 的根因均不改判。修正流账本消费者后，只允许从新代码身份开始一次完整七案前瞻资格；不得拼接旧六案、单补第七案或绕过 C16 门禁。新增 `streamProgress` 仅记请求发出后的字节数、内容/推理事件数、DONE/finish 标志和相对首末字节毫秒数，用于以后技术失败定位，不参与放行，也不追填 704 的旧收据。

## 固定 high / 零温度前向资格

前文 max-only 与 0/max 的限制属于各自冻结的历史资格。`forwardHighReasoningExperiment` 是新增的 `fixed-high-zero-temperature-v1` 登记，继承上述 max 对象的原五个 scope、caseIds、原两臂温度 0 与全部七案/后续门禁；原 max 和零温度登记对象逐项不变。只将实际 `reasoningOverride` 固定为 `high`：candidate 自然发送 `enable_thinking: true` / `reasoning_effort: high`，baseline 的两个字段仍自然缺席，两臂不得有 `thinking_budget`。执行回执继续分别保留语义源的 0.7 参数和本次有效的 0 / high 参数，`shared-input-diagnostic` 仍为已经消费的一次 0.7 / max 非资格诊断。原模型身份、`creativeStrategy: auto`、每操作预算、16384 profile 上限、480 秒截止、素材与 oracle 均不变。未登记 high、旧登记或 scope 漂移，以及读回或 wire 不符，须在物理 reserve 前拒绝。

新配置只进行一次从 C16-A 开始的完整七案前向资格；任何技术 UNKNOWN/FAIL 或原文学门失败均保留并停止依赖推进，不拼接前次成功案或自动再换参数。此实验只检验固定 high / 0 在原期限内能否完成并满足原绝对门，不追认 704/d712 根因，不把旧 0.7/max 或 0/max 失败改判，也不证明参数或代码改善、服务端实际模型模式或稳定性。只有完整七案按原规则通过，才按原顺序进入既定 post-UI/full。

`historicalC16D712808cBoundary` 从1182行接续第1183–1194行，原始完整前缀 sha256 为 `74fa8d5a7f056f2e8b5321dca40f08bc631194add392c03eaeb755033341bf1c`。真实 invocation `d712808c-5336-4abc-bd7e-cd9d0d061300` 的四次 candidate 请求均有 reserve→dispatch→终态，前三次 settle，末次 C16-B 为 `BRIDGE_SETTLEMENT_DEADLINE_EXCEEDED` UNKNOWN；原 `44bcc601` code、`3b52d46f` source、`3e76921f` driver 与逐次 parity 绑定在协议历史项中。四次物理请求均已占用，不退款、不得拼接或改判。账本读写两入口都认证这一段，后续 reserve 使用新协议身份。

## 原生预算对齐的前向资格窗口

`forwardQualificationWindowExperiment` 是独立于上述 high 登记的新时间合同；它以原 `forwardHighReasoningExperiment` 完整对象 hash 为基，逐字继承原五个 scope、两臂 0 / high 参数和自然不对称 wire。旧 high 登记中的 480 秒限制与真实 `625bfda8-9451-4027-8f8c-762e665f0ffb` 结论均不改：该次只完成 C16-A/B，C16-C 的 cards 在第六次物理请求于桥内 480 秒到期后记为 UNKNOWN，余四案未运行。六次请求已消费，不能把五次 settle 拼入新样本，也不能把技术 UNKNOWN 改判为文学结果。

新登记只授权一次从 C16-A 开始的完整七案；原绝对门、七案、作者资料、模型输入、每操作调用许可与 native 预算均不变。产品普通 root 的 `maxActiveElapsedMs` 仍为 3,600,000 毫秒，并由原 owner/repository 按实际累计活动时间、epoch 与 token/call 上限先行约束。实验桥的每 attempt 守护仅作兜底：3,600,000 加 60,000 毫秒结算余量；父进程上限为本次 bridge 已登记最大物理请求数 N × 3,660,000 加 60,000 毫秒，Vitest 上限再加 60,000 毫秒。若 native 先到期，仍记 UNKNOWN 并拒绝迟到成功。未登记路径继续使用原 480,000 / 1,500,000 / 1,560,000 毫秒（reviewed 原专用测试窗保留）；不能从请求传任意 timeout。

N 只计算桥的外层兜底，不增加任何 dispatch 权限：C16-A/B/C 的 notes 加 cards 及已有两次 cards repair 为 4；C17-A 与 C18-A/B 的原续写恢复最多 8；C17-B 的 notes/cards 加续写为 12。`early-budget` post-UI 的目录3、正文8、首审2、修稿1、完整复评1 合计15；`early-context` post-UI 单正文为1；`early-review` post-UI 三操作为3。`full` 每次 bridge 只运行一个 operation：三章规划以产品 `planBlueprintGenerationCost(3).maxCalls` 取9，单章正文以已登记恢复上限取8，不拿完整旅程重置 native root。准备阶段无发送，只需一个有限兜底。任一 scope、case、operation、登记 hash 或实际请求参数漂移须在 reserve 前拒绝；同一解析结果写入父桥 spawn/Vitest config、fixture it/守护与回执。

`historicalC16625bfda8Boundary` 从1194行接续至1212行，完整前缀 sha256 `e6fbc58d717e6acf9cb24cab41c14487cda670db73ab158c7c9a654629b5daa5`，精确认证六次 candidate 的 reserve→dispatch→终态（五次 settle、末次 unknown）及原 code/source/driver/parity 绑定。账本读写两入口都继承该段；旧1194及之前的原始字节前缀继续认证。新目标须绑定新的完整协议与桥 hash。任何技术或文学失败均停止依赖资格；本时间合同本身不证明模型能力、参数或代码改善、原失败根因及服务端实际采纳。

## C17-A 固定保存稿有界修稿诊断（非资格）

此诊断含预置作者纠错项，只验证给定问题后的修稿；不证明 AI 自主发现，也不能放行[新资格](#ai-review-final-manuscript)。已开始的实验保留原登记及证据，不中途改成 AI-only 实验。

`bounded-revision-diagnostic` 仅运行 candidate / diagnostic / C17-A。唯一来源为 invocation `a763f510-eac5-4368-967e-0abb630ff597`、testedSha `889b5e23e57daa763c4e549e892afaa69d1da73c` 的第2章 draft4 / v1 / draft：完整正文3889字节、1053单位、SHA256 `c8b29e929e34b57e7af41aae94cbc0f4c027eab21c0cfd4daf08a2501b21da66`。源 packet manifest、主DB及对应 sidecars、project.json 和三个 portable 资产的完整身份登记在 phase 中。运行时以私有 `--diagnostic-input` 清单提供 `packetManifestPath`、`stdoutPath`、`sourceProjectRoot`，该清单须位于当前工作树 `.runtime/.cache`；路径不写进公共协议。

准备阶段先验证所有源文件与完整正文，只复制冻结文件到隔离 donor，随后使用现有 portable export→restore 创建新 projectId / epoch，再由产品 IPC 读回完整 sourceDraft。缺文件、hash/version/status 不符或恢复身份无效，须在任何模型请求前停止。原项目、packet DB 原件、旧候选及 UNKNOWN 不修改、不重放。准备阶段不发送请求，也不据文件齐备宣称恢复通过。

执行顺序固定为普通完整 `ReviewChapterCommand` → 持久化作者确认 → 一次 `RefineFromReviewCommand` → `db:revision-merge` → 普通完整 `ReviewChapterCommand`。首审原 AI 报告完整保存，全部 AI 项以 origin `ai` / `ignore` 原样留在确认记录；始终追加调用前冻结的两项 origin `author` / `apply`：本章新的具体实际代价未兑现，以及同一记录日期今天/明天矛盾。两项只提供原文问题，不指定新代价金额、物品、正确日期或异常原因。只有这两作者项进入修稿 brief；无确认、错误源稿/版本、无效持久记录均拒绝修稿。不得借用定向复核的旧 cycle resolved 状态，末审仍为普通完整审稿。

最少3、最多5次物理请求：首审、一次修稿、末审各1次；两次审稿分别只可在同源、已 settle、真实 STOP 的语法或形状失败后执行一次产品既有 `review-chapter-rebuild`，必须同时核验完整物理输出 hash、native owner artifact 和未保存审稿效果。文学问题不能触发 rebuild。修稿 LENGTH、续写、额外请求或预算不符须在下一次 campaign reserve / HTTP 前拒绝；已消费请求保留，不退款、不降级。复用原 complete profile0、high、temperature0、creativeStrategy auto；本三主任务没有 draft budgetDemand，native 解析出的每次 output 预算须为16384。桥继承原生时间合同，N=5；原 scope/high/temperature/window 登记对象均不改变。

原900±30%要求为630–1170，产品既有1053稿长80%–120%要求为842–1264，最终验收使用交集842–1170；原全部硬事实、事件、代价、时点和文学标准不变。保存正文、revision、merge receipt、确认、两份完整审稿与各次 actual owner/ledger 必须可独立核验。自动结果最多为 `pending-independent-diagnostic-oracle-review`；任何 missing/error/unknown 均不能自动 PASS。诊断不改变原七案 FAIL、qualification 或产品完成状态，也不证明首稿失败根因。

`historicalC16D515b666Boundary` 认证1212→1251行：原 d515b666 / a8812b8f 的13次请求及原协议 hash `9de2619fd8a998b626545c81368f57456a44dda7db854222489bd4dfce2d36a9`，完整前缀 SHA256 `79f9ded8a2eebb55e8ea78d190e822836d5bf12e104d15d40a4aa5dac347dc92`。`historicalC16A763f510Boundary` 再认证1251→1287行：原 a763f510 / 889b5e23 的12次请求，完整前缀 SHA256 `dec581bd913e4ae841b00b3b4d78906b01a1231773900053c7cc6e33e4102ad2`。两入口依次认证原 armBindings、逐次 parity、reserve→dispatch→settle 与全部旧前缀；原账本字节及历史结论保持不变，之后的新请求绑定新协议与桥身份。

## 071156e5 系统重启中断记录

`historicalC16071156e5Boundary` 接续 `historicalBoundedRevisionE41a3f0aBoundary` 的1296行，认证至1350行：invocation `071156e5-db17-4823-96e2-007c4e232e9e`、candidate code `205cbb94cc6aadd1af9e3729f9bb878cc2985c1e` 在原协议 hash `a901864d5dafbd8bad9698032c8bbf69e06608422181a93e3fb42a7b0013e35f` 下的18次请求，其中17次 settle/STOP，末次 `candidate:5d0933d2-8d48-4a3b-8d14-2d87f74bf5ae` 为 unknown。2026-10-01 15:03（Asia/Singapore）系统重启中断运行；末次 owner 持久记录仍为 dispatch-marked，artifact 为 revision 0 的空 partial，无持久终态。确认运行进程退出后，仅通过原冻结 runner 追加这一条 unknown；它记录结果未知，不判为模型或产品失败。

完整1350行前缀 SHA256 为 `bca9e2a94ab5a25248f8c5ca714e019d21933f1c083652dfcf8ebd331e59fd3c`；原1296行前缀 `468507e3eac5beb4241c4f22fc22083e1559e841a3ba0c794a01dd7e389c9c2c` 及追加前1349行字节保持不变。账本读写两入口沿用现有 validator，认证原 code/source/driver、逐 attempt parity、invocation 和 reserve→dispatch→终态。该实验整体保留 INCOMPLETE，无完整七案 stdout 或退出回执；C17-A/B 已完成材料只供独立诊断，不能据局部材料放行资格。此加性认证不改历史评分、场景、预算、原冻结目标或旧 receipt，也不作文学裁决。
