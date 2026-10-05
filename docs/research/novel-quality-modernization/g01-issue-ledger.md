# G01：原问题逐症状验收台账

状态读取：2026-10-03。本次用 `gh` 只读获取全部 20 个开放 Issue（排除 PR），并核对原 10 项、[#279](https://github.com/EthanYoQ/AI-Novel-Writer/issues/279)、关联 PR、实质评论、检查及 Release。原 10 项仍为五开五关；其余开放项不自动扩大为本轮开发范围。G02 关单前须再次读取远端状态。

2026-10-03 远端快照读取时，[PR #230](https://github.com/EthanYoQ/AI-Novel-Writer/pull/230) 的 head 为 `7dc3e48da4496aa997b01c07d7ecfebfe7cd47d4`。当时产品修复汇总至 `6cf907211208d506b0afe6210128bfcfe5fb9dfd`。2026-10-05 本地证据更新至 `e5cdec5133516f3347265f4666d2b9944dbce36d`，没有重新读取远端。规划保存、成功 UI 和三项 Flash post-UI 集成已在各自有限范围闭合。正式 `99b3` 已失败收口，目标完成判断在当前固定条件下局部 BLOCKED。整体质量与最终包验收仍未满足，**V3 尚未完成，继续推进无依赖的平台资格。** 下述证据各自绑定原 tested SHA，不随本地 HEAD 前移。PR #230 保持开放草稿，不据本次更新解除 Draft。

现行产品只有 Writer V3 一个逻辑壳；Classic 用作历史基线及旧偏好兼容。旧 F05 原件已找到，本次只读核对 SHA256 为 `f465ebb9a0f33f84bbbbdddcd3d04f1a96aeb6b4bddd5434b96058cf9026ef4f`。其汇合 SHA 为 `bf3b31fdc6bd8cb625855ff745e69fe14f27cd7d`，153 项中 152 项 qualified、1 项用户豁免（U06.A03 真实中文 IME，非 PASS）。各动作仍沿用原 tested SHA 与复用边界；本次没有重跑 checker，也不声称当前版 153 项全量实测。

| 原 Issue／读取状态与独立症状 | 唯一验收 owner；现行实现消费者 | 已有证据层与仍需验收的边界 |
| --- | --- | --- |
| [#187 输出截断](https://github.com/EthanYoQ/AI-Novel-Writer/issues/187) **OPEN**：review-chapter、目录批次和 compact-single 三种用途分别可能遇到内部输出上限；错误提示不能把内部限制误归因于用户的 Max Tokens。 | S07；`review-chapter.command.ts`、`directory.command.ts`、生成预算运行入口。 | 目录与 compact 的精确 purpose 已有 main/provider 请求参数、真实 SQLite 候选保全、关闭重开与原 root 恢复合同测试。该补点在 `fb412b89` 工作树验证，使用受控响应，非真实模型。后续共同容量策略统一实际请求上限与原任务预算，作者可保存完整规划前缀并继续缺章；必需原文按实际模型容量准入，对账限于实际 OwnedAttempt。真实审稿保存/重开见下表；D02/D09 保留原范围。自然断流原因仍未知，最终包仍待验，不能宣称三种原症状均已根治。#229 合并不能替全部结案；#307 关闭未合并，只归入 #230 集成。 |
| [#191 自动角色卡与后续补充](https://github.com/EthanYoQ/AI-Novel-Writer/issues/191) **CLOSED**：文本／大纲导入可编辑角色卡，情节推进后补充派生状态，是两个不同需求。关闭原因是管理归并至 [#279 的 B01 待办项](https://github.com/EthanYoQ/AI-Novel-Writer/issues/279)，**并非全部实现完成**；此 B01 与 Program v3 的 B01 项目归档 Spec 无关。 | S09B；`CharacterCardImportButton.tsx`、`FinalizedCharacterStateCandidatePanel.tsx`、`CharactersView.tsx`、角色库的 derived-state 合并。 | 已有导入候选、状态补充与 CAS 合同；D01 新架构角色提议保留完整字段，旧提议按原版本核验。仍按文本/大纲来源、预览/确认/拒绝、作者保护、冲突提议、定稿后非冲突更新、重开和过期拒写验收。#279 B01 仍未勾选；已验派生能力可独立交付，不能替两项需求全部结案。 |
| [#199 故事架构/情节大纲范围与恢复](https://github.com/EthanYoQ/AI-Novel-Writer/issues/199) **CLOSED**：原症状是“AI 生成故事架构”中的 200 章情节大纲范围、截断后的续写与覆盖正确性。原 #201/#202/#203 实现已进入旧正式版。 | S06A；Writer V3“故事架构”→“AI 生成架构”→ `architecture-workflow.ts` 的 synopsis 步骤 → `GeneratePlotArchitectureCommand`（`architecture.command.ts`）。章节蓝图的 `DirectoryConfigDialog`/`directory.command.ts` 属另一入口，不能代证原情节大纲。 | 原 200 章范围聚合及历史恢复证据保留，不新增真实 200 章重复矩阵。当前单次规划默认 5 章、每章目标 600，输入目标最多 10 章、每章目标 1000，篇幅按项目写作语言计数，中文按字符数，英文按词数。这不是整本章数上限，也不是输出硬截断。完整有效的超目标规划保留原文。部分完整连续前缀可编辑、直接保存并继续缺章，结构无效或截断走有限恢复。`91f59903` 的实际六章接续保留完整超目标内容，保存与成功 UI 的有限验证见后文。蓝图证据不替原大纲症状，新 V3 资格也不从旧 Release 自动继承。 |
| [#205 连续性与逐目标审稿](https://github.com/EthanYoQ/AI-Novel-Writer/issues/205) **CLOSED**：冻结目标、三态审稿、证据引文及未来计划边界。原 #208 已合并并关闭。 | S11；`chapter-goal-review.ts`、写稿/审稿/修稿命令及章节共享证据。 | D02 保留审稿长字段，D03 保留定稿事实及证据尾部否定，均有保存/重开回归。T5 区分必需原文、可选材料与未来蓝图标签，不证明模型必然遵守。v9 的有限 Flash 采用出口和 Pro 原负例闭环各保留原范围。Formal96 与后续 `99b3` 均因 C18-B 静默遗漏当章硬目标而 FAILED_CLOSED。最新 GLM 固定负例技术 passed、语义 FAIL，目标完成判断局部 BLOCKED，详见后文；不能宣称通用漏检已修复。历史 R3 v5/W3/v8 失败不改判。D07 的合法包装接收、旧报告解释与恢复边界继续有效。 |
| [#211 图谱保存与角色卡导入](https://github.com/EthanYoQ/AI-Novel-Writer/issues/211) **CLOSED**：图谱/角色卡的导入、保存、错误可见性。#212 合并后关闭，晚于旧 v1.1.0。 | F04；`EditorArea` → `ArchFileViewer` → `CharacterCardImportButton`，角色管理与 Writer V3 导航。 | 有代码和合并记录；需验证 Writer V3 图谱只读与文件/粘贴导入、候选确认、无模型/失败/取消时原稿保全、重开及旧会话拒写。关闭和合并不证明对应正式版已包含，也不要求 Classic 双壳复验。 |
| [#213 云存档](https://github.com/EthanYoQ/AI-Novel-Writer/issues/213) **OPEN**：台式机与笔记本间完整项目手动备份和恢复。 | B02；`ProjectBackupPanel.tsx`、`cloud-backup-controller.ts`、`WebDavBackupService`，依赖 B01 完整归档/新副本恢复。 | 已有两个隔离 profile 的 WebDAV 备份、恢复新副本及凭据重启证据。完整资产/读取权威、新 projectId/旧任务冻结、分叉、中断、损坏与版本拒绝按原回执范围及 tested SHA 汇合，不重跑已闭恢复矩阵。源码 Electron 两份跨 profile 回执未记录 testedSha，保持未知。仍需正式 C17/C18 恢复后继续创作、最终三平台 native/包资格及 Release 包含链。受控 WebDAV 不证明商业云服务资格，历史编辑保存不代替真实模型成文，历史 SHA 不替代当前授权。 |
| [#219 主角缺失](https://github.com/EthanYoQ/AI-Novel-Writer/issues/219) **OPEN、needs-info**：生成人物时提示缺主角并卡住。根因尚未证实。 | S09A；人物生成/解析、`CharactersView.tsx`、角色库和身份准入。 | D01 字段完整性修复不能证明原缺主角故障。仍缺版本、系统、原模型/协议、入口及脱敏最小输出/错误，需分层核查解析、主角识别、落盘和 UI。#232 已关闭且未合并，只是候选 PR 清理，不是本单解决。保留既有信息请求，不放宽主角要求。此缺口仅限制本单判断与结案。 |
| [#221 角色、复述与未来剧情](https://github.com/EthanYoQ/AI-Novel-Writer/issues/221) **OPEN、needs-info**：①新增未批准角色；②第四章复述第三章；③第六章提前使用第八至十二章的未来剧情（后续反馈 #246 归并管理）。三个症状独立。 | S10B；章节上下文、`generate-draft.command.ts`、`review-chapter.command.ts`、`chapter-goal-review.ts`，角色准入由 S09A/B 提供。 | 有上下文选择、未来计划标签和目标审稿；仍需逐症状产品反例、跨章数据与人工语义核对。D04 保留不同场景的合法重复正文，不等于修复无意复述；D05 放行正常开头也不证明叙事质量。历史 R3 失败保留。v9 已达到所选 Flash 配置的原生出口，但不是本单三个原报告场景的复现或反证，也不覆盖后续 Formal96 的当章硬目标遗漏。原报告 provider 的资格不足仅限制该 provider 的修复宣称与本单结案，不新增全项目阻断。 |
| [#222 ActivityBar 残留](https://github.com/EthanYoQ/AI-Novel-Writer/issues/222) **CLOSED**：内部未使用组件清理。[#223](https://github.com/EthanYoQ/AI-Novel-Writer/pull/223) 已合并于 `a2948c16f0dba26f7abdc763792c2b97fc6c57d9`。 | S13；当前 Writer V3 使用 `LeftToolWindowBar.tsx`；旧 `ActivityBar.tsx` 已无当前生产引用。 | 合并记录与当前消费者检查支持窄内部清理；保留独立审查/相关检查边界，不将此单扩大成产品 Release 完成证明。 |
| [#224 设置白屏](https://github.com/EthanYoQ/AI-Novel-Writer/issues/224) **OPEN**：Windows 源码运行时设置窗口内容空白。[#225](https://github.com/EthanYoQ/AI-Novel-Writer/pull/225) 在 2026-10-03 快照仍 **OPEN**，head `e9aeb603241a573ae7de6a67d62767e1aa21e1ab`；当时读回 CI 成功。 | F04；`App.tsx` → `SettingsModal.tsx`，Writer V3 的标题栏/设置入口及各分类面板。 | `f625f1f54b7b4669c90f3359df052284f8d87d4d` 的真实 Windows 源码运行完成 17 个步骤、九类内容与 13 张独立核对截图。左栏/状态栏打开、备份直达、关闭重开与导航同步均通过，无模型请求。原回执仍为 PARTIAL，仅设置症状 PASS；旧失败保留。该源码回执未验设置保存及备份操作。另有 `70e1c3d893e0f6f0aff76b2c03debecd0513231e` 的 Windows `packaged-extracted` 设置旅程完成 15 步骤、两次真实进程与主题保存重开，0 模型/网络/error。它不是本机安装验证，不回填源码回执，也未执行 WebDAV 备份。最终候选须按消费者差异判断沿用，Release 包含链仍缺。 |

原 G01 在 2026-09-13 读取时十项均开放，现为五项开放（#187/#213/#219/#221/#224）、五项关闭（#191/#199/#205/#211/#222）。旧 v1.1.0 的 #199/#205 合并与发布包含关系、#211 后续合并、#222 窄内部清理都保留原有历史归因；不把这些旧结论重算成当前 V3 通过，也不因新的统一前端要求重开已关 Issue。#191 的迁移关闭只表示管理位置变化。

其余 15 个开放项也已读取正文和评论。以下以症状归属与证据核对为主；2026-10-03 用户另行批准 #306/#309 的最小移植，其他条目不因此新增实施范围。

| 其余开放项 | 当前证据与未覆盖范围 |
| --- | --- |
| [#238 审稿源变化拒绝保存](https://github.com/EthanYoQ/AI-Novel-Writer/issues/238) | S11 审稿来源/提交边界。已有 v1.1.0 完整响应后拒绝保存日志，尚未复现“来源确实未变仍拒绝”。当前 Electron 成功保存/重开及 D02 历史重放仅证明所测案例；仍需定位版本、hash、依赖或会话的具体差异，不能删除守卫结案。 |
| [#239 正文依赖拒绝保存](https://github.com/EthanYoQ/AI-Novel-Writer/issues/239) | S10B 写稿依赖/保存边界，与 #238 分开。第十一章、第六章、单章切连续生成是三个报告场景；只有原案例有完整 stop/候选日志。D04 组合保存回归不替原问题复现；仍需合法未变依赖、旧定稿和模式切换的最小失败夹具。 |
| [#303 修稿无变化](https://github.com/EthanYoQ/AI-Novel-Writer/issues/303)、[#275 作者设定遗漏](https://github.com/EthanYoQ/AI-Novel-Writer/issues/275) | S11 修稿采用链、S06A/S10B 作者材料链。T5 材料边界与本轮字段保真修复是相关证据，不证明意见已落实或模型遵守设定。#303 仍缺按钮顺序、最小原句/意见/结果及采用后版本；#275 已有 v1.1.0 与模型切换补充，仍需合成要求和实际输入/输出对照。 |
| [#305 蓝图失败后成果恢复](https://github.com/EthanYoQ/AI-Novel-Writer/issues/305)、[#244 大纲续写范围/衔接](https://github.com/EthanYoQ/AI-Novel-Writer/issues/244) | 分属目录批次恢复与 S06A 大纲范围消费者。#305 的 9 批中 7 批成功报告未独立复现，候选未提交不等于永久丢失；#308 关闭未合并，只归入 #230。当前大纲/蓝图可保存完整连续前缀并继续缺章。`3d90f75d` 的两条 Electron 恢复 UI 已验保存、正常退出、重开及新会话继续准备，均在模型发送前停止。`91f59903` 的实际规划保存和成功 UI 另有有限证据，不能倒推原九批已复现。#244 仍需实际请求范围/前序材料与合成输出，不能拿别案局部通过代证。 |
| [#280 输入 Tokens 偏高](https://github.com/EthanYoQ/AI-Novel-Writer/issues/280) | S07 预算及 S10B 上下文。旧版源码支持完整 synopsis 参与输入，但约 5 万 Tokens 的单次/累计归因未证实。仍缺入口、模型、请求次数与实际用量；与 #187 输出限制分开，不能截掉作者证据来降低统计。 |
| [#265 角色跨视图/保存](https://github.com/EthanYoQ/AI-Novel-Writer/issues/265)、[#245 删除范围](https://github.com/EthanYoQ/AI-Novel-Writer/issues/245) | F04/S09B 角色投影与稿件版本消费者。既有导入、派生及原稿保护证据不覆盖全部原报告。#265 分开核对字段保存、投影同步、关系连线；#245 仍需删除入口及前后版本数量，不能把同一版本消失当作无关版本误删，也不能反向认定没有误删。 |
| [#241 导入/拆解失败](https://github.com/EthanYoQ/AI-Novel-Writer/issues/241)、[#247 导入入口无响应](https://github.com/EthanYoQ/AI-Novel-Writer/issues/247)、[#248 选目录闪退](https://github.com/EthanYoQ/AI-Novel-Writer/issues/248) | F04 文件入口与导入消费者。历史 F05/native 及旧项目副本平台资格仅覆盖原步骤。#241 的读 TXT、第二章、进度回退、全局推演分别待定位；#247 仍缺具体入口/选择框状态，#248 仍缺版本及故障模块。通用选择目录成功不能替“对话框内新建目录后确认”复现。 |
| [#306 章节定位显示](https://github.com/EthanYoQ/AI-Novel-Writer/issues/306) | F04 蓝图编辑/创作弹窗。已在 `967cce46c1b4fff3d846f7b7d9a991d7b6a11823` 最小吸收 [#309](https://github.com/EthanYoQ/AI-Novel-Writer/pull/309)，参考 head `af283f5b23c670fc7d7008ddbb7382e3353e16b2`，作者 SIRIUS（skywolf123），保留 GPL-3.0 归属及 Co-authored-by。两组件共用定位词表，旧值、自定义、空白与空串保留原字符串；缺失值才使用默认值。两真实组件显示、保存及写稿 prepare 参数 31/31，shared/batch 38/38，独审 APPROVE。测试在主进程 prepare 边界停止，未调用模型，不称安装包验证。[现行 F04](frontend-transition-specs.md#chapter-role-preservation) 窄修复已完成，未发布或结案；没有引入 #308 或合并 master。 |
| [#279 功能待办](https://github.com/EthanYoQ/AI-Novel-Writer/issues/279)、[#310 审稿架构提案](https://github.com/EthanYoQ/AI-Novel-Writer/issues/310) | 独立提案。#279 各子项独立评估；#310 的判断模型路由尚非已批准实施合同。保留问题与建议，不把新模型接入、穷举审查或整份待办扩大为本轮修复。 |

2026-10-03 远端快照中，[v1.1.0](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v1.1.0) 是最新公开正式版，绑定 `879f83521414f66019488462830c3134c77dc4f8`。#201/#202/#203/#208 的合并提交均为该提交的祖先，#212 则不是；当前修复尚无公开 Release 包含证据。

本轮增量的定向测试在各自冻结文件内容上执行，经独立审查后提交；下表不表示在当前 HEAD 重跑全部套件。

| 修复提交 | 已验证行为与边界 |
| --- | --- |
| D01 `f52e2bef` | 新架构提议保留完整七项静态字段及状态，143 项定向测试、独审通过。旧 pending/approved 按持久版本核验，未知/错置版本及源篡改拒绝。 |
| D02 `9b3d5a3f` | 新审稿报告保留完整字段，145 项定向测试、独审通过。旧报告按原版本重放，未批量重写历史。 |
| D03 `45b12685` | 定稿事实和证据完整保留 407 字句尾否定，52 项定向测试、独审通过。保存、重开和确认重放保留原正文及作者后改。 |
| D04 `55fcc7ee` | 新 v2 组合保留不同场景的相同段落，246 项定向测试及 8 项浏览器测试、独审通过。旧 v1 收据仍按旧算法核验和继续；旧 pending 的去重语义未追溯修好，原 raw/hash 不变。 |
| D05 `9ec4f6fe` | 正常中英小说开头放行，明确“修订后的完整章节正文”等输出说明仍拒绝，86 项定向测试、原 finding 独立关闭。 |
| D09 `3e0eb8e3` | 官方 HTTPS 根地址与 `/v1` 能力一致，141 项定向测试、独审通过。保留作者较低上限和 endpoint 身份；旧 pending 能力变化时 execute/resume 拒绝且不新增 dispatch。显式 restart 新 root 保留旧 artifact/未知用量责任；该机制位于 main/IPC/transport，并非现成 UI 按钮。 |
| D06 `a0dc942a` | 37 项定向测试、独审通过。合法空数组保留；非法或部分非法候选整份拒绝，原输出保留。旧 graphEffects 只按原投影核验既有保存项，索引/hash/ACK 不变；不解除原领域上限。 |
| D07 `0da6dcee` | 118 项定向测试、独审通过。新定向复核接收唯一完整的合法包装报告；旧无标记报告保持严格解释，保存、重开、ACK、M03 和归档恢复使用同一版本，不追溯改判旧 unknown。 |
| D10 `6cf90721` | 95 项定向测试、独审通过。续接保留完整原始任务，仅限制已生成文本尾部；现有请求容量和根预算仍在发送前校验，拒绝时保留部分成果。验证包含 seed 恢复与兼容 harness；没有新增模型调用。 |
| 共同容量与规划 `685ee76b`、`5b5a25dc`；UI `fb9bcb4a`、`64f59757` | 共同入口按实际模型容量与原任务预算准入。新建/重置模型默认输出 65536，保留作者显式旧值；规划目标、完整超目标接收、前缀保存和缺章继续已完成定向验证及独审。必需原文保留，可选材料因预算省略时记录原因。原恢复 UI 的确认与尾注 finding 已由后继窄复验关闭，不把这些接线证据称为模型遵守保证。 |
| 限域对账 `6f93dba5` | 只结算实际 receipt 的 OwnedAttempt，保留旧 UNKNOWN 与历史失败。已完成定向验证及独审，不改成全局自动重试。 |
| [#318 历史 runner binding](https://github.com/EthanYoQ/AI-Novel-Writer/issues/318) `e5cdec51` | 最小认证旧目标诊断尾段，允许当前新条件严格登记。两个 owning suites 的 223 项通过，独审 PASS；原前缀、已消费机会与旧 FAIL 保留。该结果仅证明历史接线与记账边界，不是 GLM 文学能力修复，也不是本单公开结案。 |

| 真实运行／平台证据 | tested SHA 与实际范围 |
| --- | --- |
| Electron 审稿保存及重开 | `a95693cf6a64488bfc33d41880e3a50917dc4de6`。SiliconFlow 的 Qwen 两配置及 DeepSeek Flash 各发一次请求，报告保存、原稿保全、任务释放；新进程重开不发请求且报告/attempt 不变。Qwen 2048 样本约 143 秒，不声称均满足 120 秒。均为开发样本。 |
| “重新审稿”真实入口 | 同上 SHA。首次外发前受控注入连接中断，随后实际点击“重新审稿”，发出一次真实请求并保存报告；重开零请求，原未知 attempt 保留。该证据不解释历史自然网络中断原因。 |
| 原生 DeepSeek 保存及重开 | 同上 SHA。首次 HTTP 401 失败保留；授权更换凭据后一次请求 HTTP 200，报告保存、原稿保全，重开零请求且报告/attempt 不变。未计入正式文学样本。 |
| 精确三平台技术资格 | 仅 `7dc3e48da4496aa997b01c07d7ecfebfe7cd47d4`：[Windows](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/37114158297)、[macOS arm64](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/37114161254)、[macOS x64](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/37114164303)。Windows 九份、Mac 各三份回执通过，覆盖约定的旧版副本导入/保存/重开及原件保护。Windows 未签名，Mac 为 ad-hoc 且未公证；不外推到本次产品修复提交。 |

剩余必交项按[线程 10 交付计划](thread10-delivery-plan.md)执行。R3 v5 在 `11152245e3aa87f08797c089c57d71b06f5e493b` 的虚构历史时间 FAIL、第三槽未运行及其他历史失败和未知结果全部保留。产品 `69ed2a2f`、subject `c907f174` 的 v9 同一官方 Flash 配置已通过采用配置原生出口。3 槽中 2 条完整审修保存闭环语义通过，7 次请求，0 次引入无依据具体时间。槽 1 漏检仍为 FAIL；槽 3 的布料警告未核实，不称末审全绿。

W4 空项目旅程的语义要求及保存重开已通过，正常 UI 历史读取缺口由 `1d2819dc0f97f0c0e4d13cc03f142dcba04063e8` 补齐。各阶段沿用原 tested SHA，16K 失败、32K 成功和末审 warning 保留，不宣称整段旅程使用同一配置。W4 不填正式分母，也不代替 S14B。

`96f0dd9ad3646513d1a2d0bbc1b9cb1b18eccc1f` 的 Formal96 已 FAILED_CLOSED。已执行七案及 21 次结算请求，六案语义成功，C18-B 因静默遗漏当章硬目标失败；其技术失败和源完整性 inconclusive 保留。其余 23 槽保持 NOT_RUN，不复活该批次或跨批拼接成功样本。

后续 Pro 原负例由 `b0dff128` 首审自主发现三条问题，在 `68f89176` 完成一次修稿、普通全章末审和实际保存，独审为 PASS_NEGATIVE_CLOSURE_ONLY。`e60cdb31` 的对照技术 passed、没有严重误报，但第二目标的实际理由不足。模型前的合格仲裁与原独读 inconclusive 分别保留，不称全组语义 PASS。两者均不计正式分母，也不证明通用漏检已修。

规划生成与 UI build 仍绑定 `91f59903`，`94e9b048` 只修验证器的确认顺序并零模型核验原收据尾部。同一保存大纲接续六蓝图、短细纲、正文及审修保存已完成，完整超目标规划保留。成功 UI 12 视图已核，业务差异、网络与新增模型请求均为 0，正常退出且原项目不变。原 failed 收据、旧 UI 失败和末审 error/unknown 保留，不称文学全绿。

`94e9b048` 的 early-budget、early-context、early-review 三项 Flash post-UI 已通过各自独有集成合同。实际使用官方 DeepSeek Flash/high/32768、temperature=0，共 10 次 STOP，无 synthetic 或 UNKNOWN。必需材料消费、预算范围、原 AI 意见确认、修稿合并与普通全章末审保存身份均在各自范围内闭合。原机器 pending 状态保留，不填正式分母，也不补未触发的恢复分支。

旧 `3ad53715` 在首请求期间因用户重启电脑中断。一次已发送请求保持 UNKNOWN，另 29 槽未发，原 30 槽分母与收据保留。该原因是外部主机重启，不能归为测试程序或模型 bug；它没有正式语义裁决。`94e9b048` 的旧 Flash 正式登记仍为零请求，不能与其他批次拼接。

独立新批次 `99b3a129` 绑定 subject `e59501f3`，已 FAILED_CLOSED。原 30 槽中 14 槽技术执行完成，第一轮 7 槽已由两名独立读者审读，第二轮 7 槽未作语义裁决，另 16 槽未发。两名读者与主线程确认 C18-B 静默漏掉当章硬目标，触发[现行零容忍规则](thread10-delivery-plan.md#53-哪些错误不能被平均掉)。原分母、失败及争议记录保留，没有完整 CLI 裁决或全量分数，不重放该冻结批次。

后续 DeepSeek 目标对照修正条件在 `5294d5b8` 发出一次请求，技术 passed、语义 FAIL，正例 NOT_RUN。最新 GLM 5.3 固定负例在 `e5cdec51` 发出一次请求，HTTP 200、STOP 且技术 passed，独立语义裁决仍为 FAIL。模型列对了前章事实，却将本章确认、记账与接受旧损失误判为完成当章目标。正例按负例停止规则保持 NOT_RUN，两条件已封闭不重发，正式分母贡献均为 0，历史 Formal96、`99b3` 与 DeepSeek FAIL 不改判。

当前结论是“本固定条件下的目标完成判断能力局部 BLOCKED，尚无有证据的新产品修复路线”。依据[现行当章目标合同](delivery-contract-delta-2026-09-21.md)，确认或记账前章事件不能代替当前章目标。该结论不推断所有模型无解，也不暂停 V3 的独立工作。常规烟测与流程回归继续使用官方 DeepSeek Flash，GLM 仅是独立能力实验。

正式 C16 九案、恢复后十二条、连续九章及写作合计的资格要求仍未满足。按[交付计划第 6 节](thread10-delivery-plan.md#6-后续资格照常向交付推进)，继续无依赖的平台准备、审查与资格。必要文档提交后冻结最终 SHA，再取得同 SHA 成功 CI、三平台实际包及包内许可/字体、安装恢复与旧源保全证据。当前代码 CI 成功不代替这一最终候选义务。全部 34 项最终证据汇合、资产及保留期核对也仍待完成。U16 与其他已闭确定性范围按原证据和消费者差异沿用，不重跑全部功能。既有格式、供应商兼容及未证实输入风险仍按原分类保留，不宣称所有模型输出路径均已无缺陷。

G02 当前不新增可关闭建议。逐症状关单仍须串起复现/原因、修复提交、独审、中文生产/适用打包入口、公开 Release 及无否定新反例；#222 按窄内部合同处理。本次仅更新证据台账，未发表评论、关闭/重开 Issue、修改 PR 或发布 Release。
