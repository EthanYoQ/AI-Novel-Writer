# 中文质量预注册：Program v3 S00

状态：现行 revision 为 `draft-units-tolerance-30-v1`（2026-09-20 用户决定）。机器协议见 [`protocol.json`](protocol.json)，本文件负责解释执行规则与冻结合同的显式取代关系。S10B/S11 的历史场景、失败和加性裁决保留各自版本；完成状态见[日期化交接](../../handoffs/2026-09-20-program-v3-s11-pause-handoff.md)，不由本实验说明维护进度。合成验证、真实模型结果与文学质量结论分开记录。

## 现行交付顺序与复用

[已采纳交付 delta](delivery-contract-delta-2026-09-21.md) 将 post-UI 模型资格放到 S14A 冻结候选后，与 S14B 共用配置核验和实际双臂零模型 dry-run。F05 先完成确定性 Preflight、Writer 默认激活和确定性 Final；三份 post-UI 子门在最终汇合前保持“待最终资格”，不能提前写 F05 整体 PASS。S13 可在这三份模型回执前执行。

post-UI 样本只在固定案例的触发条件、断言、两臂原始产物及独立评审完整覆盖最终案例时复用；逐 case 记录原 receipt、实际 `testedSha` 和断言对应。未覆盖案例照常执行。原始失败、物理账本和历史结论不改写；仅因文档变化不重跑模型。相关代码、配置或 driver 变化按实际影响重新资格。

## 现行字数标准

自本 revision 起，生产草稿目标与后续质量验收统一采用 **±30%（70%–130%）**，逐章判定。计数仍使用 `src/shared/draft-units.ts` 的 v3 draft-units 算法，下界向下取整、上界向上取整；900、2000、3000 单位的区间分别为 630–1170、1400–2600、2100–3900。

本 delta 仅取代冻结内核包 `01-PLAN.md`、`03-CONTRACTS-AND-GATES.md` C06、`specs/S07.md` 与 `specs/S14B.md` 的 ±20% 字数约束，并随 Program v3 覆盖合同一起使用。冻结包字节保持不变；所有必需事件、事实、复述与独立文学评审门继续有效。旧版 baseline 仍是冻结参考，其本地字数门及失败证据按原代码的 ±20% 解释，再按本文件的参考臂裁决规则处理；不修改旧版，不把参考失败自动等同于 candidate 失败。candidate 必须通过现行绝对门。

旧协议、原始产物和历史 PASS/FAIL 保留原标准，不按 ±30% 追溯改判，也不因此重启已完成的 S10B/S11。新实验必须提交并重新冻结当前 candidate、协议 hash 和 revision；已有 target 不能继续冒用。当前机器协议认证历史账本的前 222 行，既有账本不改写，新请求继续进入同一账本。此政策调整与确定性测试本身不构成最终模型质量资格。

## 冻结样本与判断

三场景分别为旧港来信、山城药铺、长夜观星台，每场景三章，目标依次为900、2000、3000生产draft-units单位；两臂最终共18章。逐章±30%、所有必需事件、身份/时间/知情/物品/计划历史零错误是并列硬门。不得用跨章平均或自然度弥补事实失败。

每臂前章独立生成、保存并供本臂后章使用。早期第二章案例使用语义源指定的作者前情，不能把另一臂的输出借入。S00 的 legacy/canonical 语义包仍只是格式合同材料；S07 early-budget 另从同一语义源构造各目标原生物理项目，并经实际 SQLite、提示词读取和模型配置入口回读 parity。此构造不声称验证旧项目迁移或其他阶段的项目 fixture。

复述判定：标注前章完整事件与本章非必要回顾的UTF-16 spans，以生产单位计数；重复既有完整事件超过本章10%失败。必须保存原文及hash，不能只按字符串相似度替代人工事件定位。文学自然度、节奏、人物动机由两位未参与实现且不是生成器自评的评审者逐章盲比较，附原文证据；全部维度均无劣才非劣。至少两个场景各一章一个维度两人一致优，其余非劣，才称样本改善。一次独立仲裁仍不明或无仲裁资源为inconclusive。

顺序固定在协议中，最终同时间窗交错两臂。seed固定；主集成者看输出前生成随机匿名标签并私存映射。远端版本不能锁定则记录可能漂移。所有失败、中止、缺章、重试进入意向分析表，旧S00输出不能代替最终baseline。

### S10B 决策 revision

`s10b-reference-baseline-v2` 只改变成对结果的裁决，不改 campaign、语义样本、物理账本或历史事实。冻结 baseline 是参考臂：只有其本地 `TARGET_UNITS_FAILED` 同时带有结构化字数门身份、持久化观察和 hash 可复核正文时，才记为 `reference-nonconforming`，不再自动否决满足绝对门的 candidate。baseline 的 provider/IPC 失败、缺产物或产物不可验证仍是无效对照，整对失败；不得用错误字符串猜测原因。

本历史 revision 的 candidate 单位门为 80%–120%；后续执行使用上文现行 ±30% 标准，并须提供可复核保存产物。自动门通过后的最高状态只是 `pending-independent-oracle-review`；必需事件、事实、recap 和 style 必须由未参与实现的独立评审者检查，runner exit 0 或字数合格不能写成质量 PASS。

旧 revision `s10b-paired-hard-gate-v1` 的两次失败 invocation `5b460511-b426-42e1-b8c3-903ff25668f9`、`f5291452-2bf6-4344-9677-d8cc75bbb7c6` 永久保留在 intention-to-treat 中；本 revision 不追溯改判、不删除、不挑优。S10B scenario v1 invocation `e8900180-945a-4211-b0c9-8427389c0625` 同样永久保留：两位独立评审一致判定 candidate 虽通过绝对事件、事实与 recap，但自然度、节奏、人物动机三维均劣于 reference，质量结论为 FAIL。scenario v2 invocation `5a7f78fd-d0db-4b63-8564-bdce426b73f0` 也永久保留：实际正文在两位独立评审中都发生时点与节奏失败；但该 pair 同时违反生成权威与前驱准入前提，因此只能记为 `observed-quality-failure-experiment-inconclusive`，不能用于 candidate 因果归因，也不能放行。scenario v3 改用第三章：第二章作者前情是唯一必需当前前驱，第一章中性旧档是独立的可选当前候选，从而符合主进程“每章只允许当前草稿”的来源约束；逐章时点写入作者可见 guidance。可选旧档仍可按预算省略，必需前驱装不下则容量冲突。协议文件完整字节 hash 与 `decisionRevision` 必须同时写入新冻结目标、每条新 reserve 和每份桥收据。协议以 `historicalLedgerBoundary` 冻结当前 revision 前既有物理账本的原始字节 hash；具体行数、证据 invocation 与 reserve attempt 以 `protocol.json` 为准；该前缀内 legacy/旧 binding 只读保留，前缀后的每条 reserve 一律必须等于当前 binding。前缀缺失、字节漂移或新 reserve 缺少当前 binding 均拒绝；旧 target 在协议漂移后 fail closed，必须重新冻结才能实验。

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
node scripts/quality-modernization-run.mjs full --targets <双目标> --milestone final
pnpm exec vitest run scripts/__tests__/quality-modernization-run.test.mjs
```

help不启动目标。baseline-probe实际运行独立冻结树的既有 `real-provider-generation-qualification.mjs --dry-run`，网络阻断且不传秘密环境；该driver以模拟completion触达生产generation runtime。`quality-modernization-driver.mjs`另外调用目标树已有三条测试，实际触达规划、正文、审稿command：精确范围提交、900目标80%边界、审稿仅定稿历史来源。其IPC是注入测试边界，不是数据库/Electron启动证据。三个入口fixture为中文，不跑英文产品用例。

manifest绑定协议 decision revision 与完整协议字节 hash、实际HEAD、仅src/electron生产实现hash（排除tests/fixtures/stories）、独立scripts/package/lock工具hash、既有driver hash与当前runner adapter hash、四个隔离根及fixture字节hash。排除plugins/DSH、计划/报告/缓存；隔离根必须在本工作树任务cache内，realpath检查防交叉、链接逃逸。双目标不能同HEAD/同实现源hash/同realpath，即使标签不同也拒绝；candidate subjectSha必须等于其实际codeSha，参数/作者素材/格式不等拒绝。两个真实目标均启动探针后dry-run才可报通过。hash是完整性而非签名，恶意修改runner本身不在此资格范围。

schemaVersion=1 的 S00 manifests 保持历史探针行为，formal 阶段仍返回 exit2 `PRODUCTION_COMMAND_DRIVER_NOT_INTEGRATED`。schemaVersion=2 使用下述 S07 默认生产桥。未迁移的 early-context、early-review、full 返回 `PHASE_PRODUCTION_ADAPTER_NOT_INTEGRATED`。baseline 生产源码保持原样。

## S07 默认生产双路径与冻结顺序

新桥位于 `scripts/fixtures/quality-modernization-production.fixture.mjs`。它实例化各目标的默认 `GenerateDirectoryCommand`、`GenerateDraftCommand`，不传 `createRuntime`、completion、repository 或 command dependencies。Electron 的传输外壳由测试桥实现，处理器、项目权限、模型租约、provider、解析、提交均调用各目标实际源码；SQLite 使用真实隔离文件。候选臂走已注册的 generation main owner，基线走其原有 renderer runtime 和注册 LLM controller。两者都在同一个最终 fetch 边界切换 synthetic/real；不存在直接 API 质量实验器。

candidate 每次发送前从实际 fixture 数据库查询唯一 `dispatch-marked` attempt，并核对当前默认 command 持有的 project/epoch/root/run、attemptId 和真正输出上限；零条、多条或不匹配都拒发。收尾再核对原 attempt 的 stop、artifact 与正式 effect。已知 stop 且 usage 不可信时保留产品账本的 unknown liability，不谎称可信用量或失败退款。baseline 不伪造它没有的 main attempt，使用独立物理 ID 并绑定原实现哈希。

两臂的模板输入采用对称映射：从不可变 baseline `2264390d6fb8b052cc14736d544df0cc74516649` 提取 `chapter_blueprint_chunk` 和 `first_chapter_draft` 的完整原模板；两臂作为相同的自定义作者模板读回。语义源那句无占位符的 `template` 完整写入双方 `globalGuidance`，不会用它覆盖生产模板并丢掉作者素材。模板原字节、guidance 字节、实际项目回读哈希保存在私有 receipt；各臂编译后的 system/完整 prompt 哈希另列，允许体现实现差异。角色原始名字与身份约束完整保存在作者素材及主角档案，本门不凭名字凭空创建已批准角色卡。第二、三章作者预置蓝图用于验证本次第1章范围提交没有改写范围外内容。

执行环境由每臂实际探针决定。当前基线依赖使用 Electron ABI145，可用其 Electron executable 的 `ELECTRON_RUN_AS_NODE=1` 执行；候选使用本树 Node ABI141。二者都实际加载其自身 better-sqlite3 并查询，不把 package 版本或历史 native 收据当加载证明；不切换当前树 ABI，不改基线源码。差异写入 manifest，不声称环境完全相同，也不声称这是安装版 Electron UI 验收。

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

## C16、C17、C18与编辑门

中文语义源逐项登记C16自动derived正例、author冲突、同名改名、拒绝重启、旧outbox、CAS作者并发、较早章迟到、同章旧版本、身份不明及后处理失败。全部消费现有提取路径，禁止每角色新建付费调用。

C17覆盖正文/头像/知识原文保全、新项目ID与稳定领域ID、当前可读author/derived来源承接、历史候选与未知已发冻结、秘密字段及其hash排除、未知字段blocked、跨revision与恢复碰撞。C18覆盖无CAS追加、同父分叉、origin-readonly重启、latest缺失、上传后本机绑定失败。模型继续创作仅使用4次预留；其余故障优先确定性fixture，未执行不记通过。

编辑绝对门仍消费Program v3 `feature-union.editor-absolute-v1`：3000/200000单位、IME、绝对/相对性能与逐action失败反例，不以模型预算扩成颜色乘积。F05三门须同postUiIntegrationSha的新收据；旧early结果不能代填。编辑具体测量器由F04/F05维护，此runner未实现UI性能资格。

## 后续阶段接线边界

S07 early-budget 已接默认生产命令及最终 fetch 处的 reserve/dispatch/settle/unknown，未新增生产 observer hook。后续阶段须复用同一总账和实际项目回读，绑定各自 phase/milestone/原 attempt，不能在高层一次 run 扣一次。S10B提供上下文证据、S11提供审稿→定向修稿→唯一复核，保存输出、模板/Skill与compiled prompt哈希；不要另建直接API实验器。主集成者固定唯一总账与未消费阶段预留、出两臂manifest、盲评映射、post-UI与最终subject冻结。未实现的阶段正式运行保持blocked。

启动冻结补充：manifest.environment绑定实际 executable 字节hash、版本与module ABI，以及 esbuild/vitest/Electron/better-sqlite3 安装manifest路径、版本、hash。schemaVersion=1 的 nativeProfile 仅为历史旁证，原 node-js 探针不加载 native；schemaVersion=2 另绑定实际加载并查询过的 SQLite binary。startup 固定执行器与已hash驱动，不接受任意命令；实际无shell argv写入每次桥接收据。正式执行前后重新验证 source/tools/adapter/environment/startup，任何漂移拒绝。early-budget每臂显式包含一次范围生成与一次正文生成，early/post-UI各4次；22次失败余量及总计80次均为计划分配，不是调用硬帽。
