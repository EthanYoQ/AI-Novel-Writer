# G01：原问题逐症状验收台账

2026-10-05 最新远端只读核对列出 30 个开放 Issue，排除 PR，包含新建的 #322。2026-10-05T09:04:51.5689681Z 的原 29 项快照保留。原十项仍为五开五关，具体状态见下表。2026-10-03 的正文、评论和标签核对保留原范围，本次快照只刷新状态。其余开放项不自动扩大为本轮开发范围。本次已按最新只读结果核对 G02 的状态，未远端写入。

本地产品修复汇总至 `625078b1a1d36bec85ffa34f7b6947872a060b59`。正式 `f371` 的 30 槽均已执行，110 次 STOP 全结算，0 pending；技术 29 槽 passed、1 槽 failed。三轮 c16-c18 双读结果依次为 7 success、5 success 加 2 failure、5 success 加 2 failure。full 九槽已完成双读及字段仲裁，4 success、5 failure，未解决字段分歧为 0。原始 CLI 批判定为 failed，写作 12/21，不支持整批文学通过。旧 `f432` 的 CI、三平台、15 份回执、7 份资产和实际 ASAR 核验仅属历史资格。最终发行资格须由文档提交后的同一精确 SHA 的私有 CI、平台包及资格收据共同绑定。下述证据保留各自 tested SHA，不随 HEAD 前移。

2026-10-05 快照中，[PR #230](https://github.com/EthanYoQ/AI-Novel-Writer/pull/230) 为 OPEN、Draft，head 为 `f43292ebcf044f5eee896d676cf6e5a74f31daa0`。master 为 `992b3f5f40165b59be7f1c126166235e7a7f807e`。本地产品 SHA 不等于远端 PR head，也不表示已发布。本次只更新交付文档，不改变 PR、Issue 或 Release。

现行产品只有 Writer V3 一个逻辑壳；Classic 用作历史基线及旧偏好兼容。旧 F05 原件已找到，本次只读核对 SHA256 为 `f465ebb9a0f33f84bbbbdddcd3d04f1a96aeb6b4bddd5434b96058cf9026ef4f`。其汇合 SHA 为 `bf3b31fdc6bd8cb625855ff745e69fe14f27cd7d`，153 项中 152 项 qualified、1 项用户豁免（U06.A03 真实中文 IME，非 PASS）。各动作仍沿用原 tested SHA 与复用边界；本次没有重跑 checker，也不声称当前版 153 项全量实测。

| 原 Issue／读取状态与独立症状 | 唯一验收 owner；现行实现消费者 | 已有证据层与仍需验收的边界 |
| --- | --- | --- |
| [#187 输出截断](https://github.com/EthanYoQ/AI-Novel-Writer/issues/187) **OPEN**：review-chapter、目录批次和 compact-single 三种用途分别可能遇到内部输出上限；错误提示不能把内部限制误归因于用户的 Max Tokens。 | S07；`review-chapter.command.ts`、`directory.command.ts`、生成预算运行入口。 | 目录与 compact 的精确 purpose 已有 main/provider 请求参数、真实 SQLite 候选保全、关闭重开与原 root 恢复合同测试。该补点在 `fb412b89` 工作树验证，使用受控响应，非真实模型。后续共同容量策略统一实际请求上限与原任务预算，作者可保存完整规划前缀并继续缺章；必需原文按实际模型容量准入，对账限于实际 OwnedAttempt。真实审稿保存/重开见下表；D02/D09 保留原范围。自然断流原因仍未知。历史 `f43292eb` 包已核验，最终 DOCONLY 包仍待验，不能宣称三种原症状均已根治。#229 合并不能替全部结案；#307 关闭未合并，只归入 #230 集成。 |
| [#191 自动角色卡与后续补充](https://github.com/EthanYoQ/AI-Novel-Writer/issues/191) **CLOSED**：文本／大纲导入可编辑角色卡，情节推进后补充派生状态，是两个不同需求。关闭原因是管理归并至 [#279 的 B01 待办项](https://github.com/EthanYoQ/AI-Novel-Writer/issues/279)，**并非全部实现完成**；此 B01 与 Program v3 的 B01 项目归档 Spec 无关。 | S09B；`CharacterCardImportButton.tsx`、`FinalizedCharacterStateCandidatePanel.tsx`、`CharactersView.tsx`、角色库的 derived-state 合并。 | 已有导入候选、状态补充与 CAS 合同；D01 新架构角色提议保留完整字段，旧提议按原版本核验。仍按文本/大纲来源、预览/确认/拒绝、作者保护、冲突提议、定稿后非冲突更新、重开和过期拒写验收。#279 B01 仍未勾选；已验派生能力可独立交付，不能替两项需求全部结案。 |
| [#199 故事架构/情节大纲范围与恢复](https://github.com/EthanYoQ/AI-Novel-Writer/issues/199) **CLOSED**：原症状是“AI 生成故事架构”中的 200 章情节大纲范围、截断后的续写与覆盖正确性。原 #201/#202/#203 实现已进入旧正式版。 | S06A；Writer V3“故事架构”→“AI 生成架构”→ `architecture-workflow.ts` 的 synopsis 步骤 → `GeneratePlotArchitectureCommand`（`architecture.command.ts`）。章节蓝图的 `DirectoryConfigDialog`/`directory.command.ts` 属另一入口，不能代证原情节大纲。 | 原 200 章范围聚合及历史恢复证据保留，不新增真实 200 章重复矩阵。当前单次规划默认 5 章、每章目标 600，输入目标最多 10 章、每章目标 1000，篇幅按项目写作语言计数，中文按字符数，英文按词数。这不是整本章数上限，也不是输出硬截断。完整有效的超目标规划保留原文。部分完整连续前缀可编辑、直接保存并继续缺章，结构无效或截断走有限恢复。`91f59903` 的实际六章接续保留完整超目标内容，保存与成功 UI 的有限验证见后文。蓝图证据不替原大纲症状，新 V3 资格也不从旧 Release 自动继承。 |
| [#205 连续性与逐目标审稿](https://github.com/EthanYoQ/AI-Novel-Writer/issues/205) **CLOSED**：冻结目标、三态审稿、证据引文及未来计划边界。原 #208 已合并并关闭。 | S11；`chapter-goal-review.ts`、写稿/审稿/修稿命令及章节共享证据。 | D02 保留审稿长字段，D03 保留定稿事实及证据尾部否定，均有保存/重开回归。T5 区分必需原文、可选材料与未来蓝图标签，不证明模型必然遵守。v9 的有限 Flash 采用出口和 Pro 原负例闭环各保留原范围。Formal96 与后续 `99b3` 均因 C18-B 静默遗漏当章硬目标而 FAILED_CLOSED。最新 GLM 固定负例技术 passed、语义 FAIL。用户仅接受已确认的当章目标判断失败完整留存为已知限制，详见后文；不能宣称通用漏检已修复。历史 R3 v5/W3/v8 失败不改判。D07 的合法包装接收、旧报告解释与恢复边界继续有效。 |
| [#211 图谱保存与角色卡导入](https://github.com/EthanYoQ/AI-Novel-Writer/issues/211) **CLOSED**：图谱/角色卡的导入、保存、错误可见性。#212 合并后关闭，晚于旧 v1.1.0。 | F04；`EditorArea` → `ArchFileViewer` → `CharacterCardImportButton`，角色管理与 Writer V3 导航。 | 有代码和合并记录；需验证 Writer V3 图谱只读与文件/粘贴导入、候选确认、无模型/失败/取消时原稿保全、重开及旧会话拒写。关闭和合并不证明对应正式版已包含，也不要求 Classic 双壳复验。 |
| [#213 云存档](https://github.com/EthanYoQ/AI-Novel-Writer/issues/213) **OPEN**：台式机与笔记本间完整项目手动备份和恢复。 | B02；`ProjectBackupPanel.tsx`、`cloud-backup-controller.ts`、`WebDavBackupService`，依赖 B01 完整归档/新副本恢复。 | 已有两个隔离 profile 的 WebDAV 备份、恢复新副本及凭据重启证据。完整资产/读取权威、新 projectId/旧任务冻结、分叉、中断、损坏与版本拒绝按原回执范围及 tested SHA 汇合，不重跑已闭恢复矩阵。源码 Electron 两份跨 profile 回执未记录 testedSha，保持未知。当前正式 C17/C18 恢复后继续创作已完成执行和双读，原技术及语义失败仍保留。历史 `f43292eb` 三平台资格不替代最终 DOCONLY 包或 Release 包含链。受控 WebDAV 不证明商业云服务资格，历史编辑保存不代替真实模型成文，历史 SHA 不替代当前授权。 |
| [#219 主角缺失](https://github.com/EthanYoQ/AI-Novel-Writer/issues/219) **OPEN、needs-info**：生成人物时提示缺主角并卡住。根因尚未证实。 | S09A；人物生成/解析、`CharactersView.tsx`、角色库和身份准入。 | D01 字段完整性修复不能证明原缺主角故障。仍缺版本、系统、原模型/协议、入口及脱敏最小输出/错误，需分层核查解析、主角识别、落盘和 UI。#232 已关闭且未合并，只是候选 PR 清理，不是本单解决。保留既有信息请求，不放宽主角要求。此缺口仅限制本单判断与结案。 |
| [#221 角色、复述与未来剧情](https://github.com/EthanYoQ/AI-Novel-Writer/issues/221) **OPEN、needs-info**：①新增未批准角色；②第四章复述第三章；③第六章提前使用第八至十二章的未来剧情（后续反馈 #246 归并管理）。三个症状独立。 | S10B；章节上下文、`generate-draft.command.ts`、`review-chapter.command.ts`、`chapter-goal-review.ts`，角色准入由 S09A/B 提供。 | 有上下文选择、未来计划标签和目标审稿；仍需逐症状产品反例、跨章数据与人工语义核对。D04 保留不同场景的合法重复正文，不等于修复无意复述；D05 放行正常开头也不证明叙事质量。历史 R3 失败保留。v9 已达到所选 Flash 配置的原生出口，但不是本单三个原报告场景的复现或反证，也不覆盖后续 Formal96 的当章硬目标遗漏。原报告 provider 的资格不足仅限制该 provider 的修复宣称与本单结案，不新增全项目阻断。当前 `f371` 连续章节的既往事实与同章动作回述矛盾可关联本单“章节连续性偏移”症状，但不是用户同一原案的复现。 |
| [#222 ActivityBar 残留](https://github.com/EthanYoQ/AI-Novel-Writer/issues/222) **CLOSED**：内部未使用组件清理。[#223](https://github.com/EthanYoQ/AI-Novel-Writer/pull/223) 已合并于 `a2948c16f0dba26f7abdc763792c2b97fc6c57d9`。 | S13；当前 Writer V3 使用 `LeftToolWindowBar.tsx`；旧 `ActivityBar.tsx` 已无当前生产引用。 | 合并记录与当前消费者检查支持窄内部清理；保留独立审查/相关检查边界，不将此单扩大成产品 Release 完成证明。 |
| [#224 设置白屏](https://github.com/EthanYoQ/AI-Novel-Writer/issues/224) **OPEN**：Windows 源码运行时设置窗口内容空白。[#225](https://github.com/EthanYoQ/AI-Novel-Writer/pull/225) 在 2026-10-03 快照仍 **OPEN**，head `e9aeb603241a573ae7de6a67d62767e1aa21e1ab`；当时读回 CI 成功。 | F04；`App.tsx` → `SettingsModal.tsx`，Writer V3 的标题栏/设置入口及各分类面板。 | `f625f1f54b7b4669c90f3359df052284f8d87d4d` 的真实 Windows 源码运行完成 17 个步骤、九类内容与 13 张独立核对截图。左栏/状态栏打开、备份直达、关闭重开与导航同步均通过，无模型请求。原回执仍为 PARTIAL，仅设置症状 PASS；旧失败保留。该源码回执未验设置保存及备份操作。另有 `70e1c3d893e0f6f0aff76b2c03debecd0513231e` 的 Windows `packaged-extracted` 设置旅程完成 15 步骤、两次真实进程与主题保存重开，0 模型/网络/error。它不是本机安装验证，不回填源码回执，也未执行 WebDAV 备份。最终候选须按消费者差异判断沿用，Release 包含链仍缺。 |

原 G01 在 2026-09-13 读取时十项均开放，现为五项开放（#187/#213/#219/#221/#224）、五项关闭（#191/#199/#205/#211/#222）。旧 v1.1.0 的 #199/#205 合并与发布包含关系、#211 后续合并、#222 窄内部清理都保留原有历史归因；不把这些旧结论重算成当前 V3 通过，也不因新的统一前端要求重开已关 Issue。#191 的迁移关闭只表示管理位置变化。

2026-10-03 读取的其余 15 个开放项，在 2026-10-05 快照中仍为 OPEN。以下保留原正文和评论核对；新出现的 #313 至 #321 另行列出。2026-10-03 用户批准 #306/#309 的最小移植，其他条目不因此新增实施范围。

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

2026-10-05 远端快照中，[v1.1.0](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v1.1.0) 是最新公开正式版，绑定 `879f83521414f66019488462830c3134c77dc4f8`。#201/#202/#203/#208 的合并提交均为该提交的祖先，#212 则不是；当前修复尚无公开 Release 包含证据。

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
| D10 `6cf907211208d506b0afe6210128bfcfe5fb9dfd` | 95 项定向测试、独审通过。续接保留完整原始任务，仅限制已生成文本尾部；现有请求容量和根预算仍在发送前校验，拒绝时保留部分成果。验证包含 seed 恢复与兼容 harness；没有新增模型调用。 |
| 共同容量与规划 `685ee76b`、`5b5a25dc`；UI `fb9bcb4a`、`64f59757` | 共同入口按实际模型容量与原任务预算准入。新建/重置模型默认输出 65536，保留作者显式旧值；规划目标、完整超目标接收、前缀保存和缺章继续已完成定向验证及独审。必需原文保留，可选材料因预算省略时记录原因。原恢复 UI 的确认与尾注 finding 已由后继窄复验关闭，不把这些接线证据称为模型遵守保证。 |
| 限域对账 `6f93dba5` | 只结算实际 receipt 的 OwnedAttempt，保留旧 UNKNOWN 与历史失败。已完成定向验证及独审，不改成全局自动重试。 |
| [#319 修稿数值](https://github.com/EthanYoQ/AI-Novel-Writer/issues/319) `2bc56925` | 该提交当时的修稿正文以冻结源稿长度 ±30% 校验；章节目标 ±30% 是另一个约束。21 项独立定向测试及 main owner、修稿合并、普通末审、SQLite 回读验证通过。蓝图内规划正文容量提示也统一 ±30%，不是蓝图自身长度门。原 C18 前后探针零新增模型请求，旧 failed 收据不改。2026-10-05 前瞻篇幅要求改由 [S06B](../../plans/novel-quality-modernization/specs/S06B.md#prose-length-overrun)拥有，本行保留原修复及验证记录。 |
| [#320 蓝图字段](https://github.com/EthanYoQ/AI-Novel-Writer/issues/320) `625078b1` | 删除 Spec 未规定的姓名 32 字符、关系 80 字符拒收及提示。81 项直接测试、56 项相邻测试、独立 81 项与 15 个探针通过。真实 SQLite 关闭重开保留 41 字符姓名和 133 字符关系全文。类型、非空、身份、枚举、关系端点和章节覆盖保护保留。S06A 同步两行。此局部结果不等于整批文学或最终包通过。 |
| [#318 历史 runner binding](https://github.com/EthanYoQ/AI-Novel-Writer/issues/318) `e5cdec5133516f3347265f4666d2b9944dbce36d` | 最小认证旧目标诊断尾段，允许当前新条件严格登记。两个 owning suites 的 223 项通过，独审 PASS；原前缀、已消费机会与旧 FAIL 保留。该结果仅证明历史接线与记账边界，不是 GLM 文学能力修复，也不是本单公开结案。 |

| 真实运行／平台证据 | tested SHA 与实际范围 |
| --- | --- |
| Electron 审稿保存及重开 | `a95693cf6a64488bfc33d41880e3a50917dc4de6`。SiliconFlow 的 Qwen 两配置及 DeepSeek Flash 各发一次请求，报告保存、原稿保全、任务释放；新进程重开不发请求且报告/attempt 不变。Qwen 2048 样本约 143 秒，不声称均满足 120 秒。均为开发样本。 |
| “重新审稿”真实入口 | 同上 SHA。首次外发前受控注入连接中断，随后实际点击“重新审稿”，发出一次真实请求并保存报告；重开零请求，原未知 attempt 保留。该证据不解释历史自然网络中断原因。 |
| 原生 DeepSeek 保存及重开 | 同上 SHA。首次 HTTP 401 失败保留；授权更换凭据后一次请求 HTTP 200，报告保存、原稿保全，重开零请求且报告/attempt 不变。未计入正式文学样本。 |
| 精确三平台技术资格 | 仅 `7dc3e48da4496aa997b01c07d7ecfebfe7cd47d4`：[Windows](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/37114158297)、[macOS arm64](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/37114161254)、[macOS x64](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/37114164303)。Windows 九份、Mac 各三份回执通过，覆盖约定的旧版副本导入/保存/重开及原件保护。Windows 未签名，Mac 为 ad-hoc 且未公证；不外推到本次产品修复提交。 |
| 历史候选三平台技术资格 | 仅 `f43292ebcf044f5eee896d676cf6e5a74f31daa0`：[Windows](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/37261259126) attempt 1、[macOS arm64](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/37261261468) attempt 1、[macOS x64](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/37261263717) attempt 2。15 份回执及 7 份资产通过；实际 ASAR 的六项字体、四项 OFL、声明和图标许可已核验。Windows 未签名，macOS 为 ad hoc 且未公证。CI `37257426260` attempt 2 成功；原 CI 失败和 x64 attempt 1 超时保留，根因未知。不外推到 625 或最终 DOCONLY SHA，也不代替正式文学资格或 Release。 |

剩余必交项按[线程 10 交付计划](thread10-delivery-plan.md)执行。R3 v5 在 `11152245e3aa87f08797c089c57d71b06f5e493b` 的虚构历史时间 FAIL、第三槽未运行及其他历史失败和未知结果全部保留。产品 `69ed2a2f`、subject `c907f174` 的 v9 同一官方 Flash 配置已通过采用配置原生出口。3 槽中 2 条完整审修保存闭环语义通过，7 次请求，0 次引入无依据具体时间。槽 1 漏检仍为 FAIL；槽 3 的布料警告未核实，不称末审全绿。

W4 空项目旅程的语义要求及保存重开已通过，正常 UI 历史读取缺口由 `1d2819dc0f97f0c0e4d13cc03f142dcba04063e8` 补齐。各阶段沿用原 tested SHA，16K 失败、32K 成功和末审 warning 保留，不宣称整段旅程使用同一配置。W4 不填正式分母，也不代替 S14B。

`96f0dd9ad3646513d1a2d0bbc1b9cb1b18eccc1f` 的 Formal96 已 FAILED_CLOSED。已执行七案及 21 次结算请求，六案语义成功，C18-B 因静默遗漏当章硬目标失败；其技术失败和源完整性 inconclusive 保留。其余 23 槽保持 NOT_RUN，不复活该批次或跨批拼接成功样本。

后续 Pro 原负例由 `b0dff128` 首审自主发现三条问题，在 `68f89176` 完成一次修稿、普通全章末审和实际保存，独审为 PASS_NEGATIVE_CLOSURE_ONLY。`e60cdb31` 的对照技术 passed、没有严重误报，但第二目标的实际理由不足。模型前的合格仲裁与原独读 inconclusive 分别保留，不称全组语义 PASS。两者均不计正式分母，也不证明通用漏检已修。

规划生成与 UI build 仍绑定 `91f59903`，`94e9b048` 只修验证器的确认顺序并零模型核验原收据尾部。同一保存大纲接续六蓝图、短细纲、正文及审修保存已完成，完整超目标规划保留。成功 UI 12 视图已核，业务差异、网络与新增模型请求均为 0，正常退出且原项目不变。原 failed 收据、旧 UI 失败和末审 error/unknown 保留，不称文学全绿。

`94e9b048` 的 early-budget、early-context、early-review 三项 Flash post-UI 已通过各自独有集成合同。实际使用官方 DeepSeek Flash/high/32768、temperature=0，共 10 次 STOP，无 synthetic 或 UNKNOWN。必需材料消费、预算范围、原 AI 意见确认、修稿合并与普通全章末审保存身份均在各自范围内闭合。原机器 pending 状态保留，不填正式分母，也不补未触发的恢复分支。

旧 `3ad53715` 在首请求期间因用户重启电脑中断。一次已发送请求保持 UNKNOWN，另 29 槽未发，原 30 槽分母与收据保留。该原因是外部主机重启，不能归为测试程序或模型 bug；它没有正式语义裁决。`94e9b048` 的旧 Flash 正式登记仍为零请求，不能与其他批次拼接。

独立批次 `99b3a129` 绑定 subject `e59501f3`，已 FAILED_CLOSED。原 30 槽中 14 槽技术执行完成，现已全部完成双独立审读，另 16 槽未发。第二轮十项裁决字段全部一致，无新仲裁：5 案 success、C17-B 为 minor-omission、C18-B 为 failure，七案来源完整性通过。C17-B 正文合格，但非逐字引文使目标保存为 unknown；C18-B 仍把前章损失或记账误判为完成当章目标。仅当章目标判断失败按用户例外完整留存，原分母、分数及争议记录保持。原 closure 不改写，不运行历史全量 CLI 裁决，不重放该批次，也不把旧槽拼入当前 `f371`。原输入、raw、报告、收据及双读记录保留；原请求没有完整逐字 wire 正文，不能事后伪补。

后续 DeepSeek 目标对照修正条件在 `5294d5b8` 发出一次请求，技术 passed、语义 FAIL，正例 NOT_RUN。最新 GLM 5.3 固定负例在 `e5cdec51` 发出一次请求，HTTP 200、STOP 且技术 passed，独立语义裁决仍为 FAIL。模型列对了前章事实，却将本章确认、记账与接受旧损失误判为完成当章目标。正例按负例停止规则保持 NOT_RUN，两条件已封闭不重发，正式分母贡献均为 0，历史 Formal96、`99b3` 与 DeepSeek FAIL 不改判。

用户仅接受已确认的当章目标判断失败作为已知限制，并要求保留完整记录。依据[现行当章目标合同](delivery-contract-delta-2026-09-21.md)，确认或记账前章事件不能代替当前章目标。该例外不豁免篇幅失败、必要前情回顾的严重误报、数据源错误、作者硬事实遗漏或覆盖、保存或恢复缺陷，不重写分数。常规烟测与流程回归继续使用官方 DeepSeek Flash，GLM 仍是独立能力实验。

历史 `666c7608-49da-4a95-921c-9ba8056f76fa` 绑定 `f43292eb`，执行已闭。7 槽执行，23 槽未发，29 次物理请求，5 槽技术通过、2 槽技术失败。补充 addendum 已完成七槽双独立审读；原 closure 的 IN_PROGRESS_SOURCE_FIRST 字段保留为历史。C17-A 的 1268/900 超出 ±30%；C17-B/C18-A 必要前情回顾误报不在目标例外内。目标误判单列，原失败、分母和缺失原 wire 的边界保留。

历史 `819b6463-560d-4aed-b64b-607cb43d9cf4` 的 tested SHA 为 `2bc56925cb0d65e52dc91d613a99a19a1d8d3add`。7 槽执行并完成双独立审读，0 槽未读，23 槽未发送，24 次 STOP。双方十字段一致，七案闭环均为 success。C17-B/C18-A 原首稿 fail 和 C18-A/C18-B 两处目标论证缺陷保留。C18-A 的原 error 已自主指出新代价缺失并被实际采纳，目标字段错误与闭环结果分别记录。initial 派生摘要错误及更正保留。B 读者曾接触历史摘要，不称严格盲读。详见本机 `thread12-prerelease-819b-reading-addendum.md/json`。该证据不重标为 625，也不证明完整批次合格。

当前正式批次 `f3717636-67fe-42b0-8e1a-2edaaa648cd8` 绑定 `625078b1a1d36bec85ffa34f7b6947872a060b59`。

- 第一轮七槽技术通过，23 次 STOP 全结算，0 pending。七槽完整双独立审读已闭，十字段一致，均为 success。四篇首稿 pass，检出能力为 not-applicable。C17-A/C18-A 的 AI 目标理由错误保留。独立来源仲裁及拟失败撤回过程保留，不额外要求金钱损失或最低严重度。证据为 `thread12-prerelease-f371-r1-reading-addendum.md/json`。
- 第二轮六槽技术 passed，C18-B 为 failed、PRODUCTION_BRIDGE_FAILED。1379 个正文单位对目标 900，超过上限 1170，原失败保留。22 次 STOP 全结算，0 pending。完整双读为 5 success、2 failure。技术状态不代替文学判断。证据为 `thread12-prerelease-f371-r2-settlement.json` 和该轮完整审读记录。
- 第三轮七槽已执行并完成双读，5 success、2 failure。C18-A 的 source-only 裁决在见 AI 前锁定 firstDraft pass，检出能力为 not-applicable；原 A fail 和 B pass 报告保持不变。前情复述 error 与两个目标 unknown 作为同一已选集合触发无谓修稿，严重误报保留，不能将全部新增剧情单独归因于复述项。证据为 `thread12-prerelease-f371-r3-reading-addendum.md/json` 与 `thread12-prerelease-f371-r3-full-arbitration/report.md/json`。
- full 三项目各三章的九槽均已生成、完成双读及字段仲裁，4 success、5 failure，未解决字段分歧为 0。场景2/2沿用见 AI 前的 source-only pass；制伏后重接动作是省略，正文没有明写同时制伏与撬柜。其余八槽原结论不变。证据为 `thread12-prerelease-f371-full-reading-addendum.json` 和该轮字段仲裁原件。
- 当前批次总计 30 槽执行、110 次 STOP、0 pending，没有 Token 截断；技术 29 passed、1 failed，原账本 prefix 保持。原始 CLI 已执行，`thread12-prerelease-f371-adjudication.json` 的 status 为 failed：提取 9/9、恢复 8/12、连续 4/9，写作合计 12/21。silentHardConstraint 为 3，silentOther 为 2，integrityFailure 为 false，unresolvedCritical 为 true。技术完成与成功保存不改称文学资格通过。

当章目标判断例外仅另列第三轮 C17-A 与 full 场景1/3的当前 objective 状态，不重写其原失败字段。第二轮 C18-A 实际未产出当章必需事件，不是纯判断误报；第二轮 C18-B 的 1379/900 篇幅失败及第三轮 C18-A 的非目标复述误报也不在例外内。第三轮 C18-A 的非目标 error 与两个目标 unknown 同选集合只对应一次修稿，不能把全部变化单归因于复述项。独立 `thread12-prerelease-f371-disposition.md/json` 将这两项目标判断失败单列为允许留存，另七项非豁免失败原样保留。原合同文学资格仍为 BLOCKED，继续独立技术 CI 与三平台资格不表示可合并、打标签或发布。

既定正式合同为七样例三轮共 21 槽，其中 C16 九槽、恢复十二槽，另有三项目各连续三章共九槽，总计 30 槽。C16 源、操作和作者保护要求 9/9，语义至少 8/9；恢复至少 10/12，连续至少 7/9，写作合计至少 18/21。不跨批拼成功，不加第四轮补槽。目标例外单列，不能将其他失败改为 PASS。当前恢复 8/12、连续 4/9 和写作 12/21 未达到上述最低分子。三处 silentHardConstraint 包括第二轮 C18-A 当章必需事件实际未完成，以及 full 场景3/1和3/2的作者知识时点违反。两处 silentOther 是 full 场景2/3和3/3的实际既往事实或同章动作回述矛盾。原始分子及零容忍失败全部保留。

全部 34 项的当前分范围核对见本机 `thread12-prerelease-625-spec-reconcile/report.md/json` 与 `34spec-reconciled.json`。33 份 Spec 哈希与原 map 一致，S06A 的两行字段同步为已解释变化。原文档 map 中 G01、notes 的旧哈希不覆盖；本次 preparation 已记录其当前输入。引用文件缺失条数为 0，文件存在不等于 Spec 通过。各项保留原 tested SHA、混合来源及消费者边界；B02 两份原 Electron 回执的 testedSha 仍未知。

三条原 Flash post-UI 回执分别保留 `94e9b048` 身份。它们包含 refine，early-budget 还包含 directory。当前以 21 项修稿回归、81+56 项蓝图回归、SQLite 原文回读和既定 625 正式生产链补证，不新增三次 post-UI 重跑门。上述补证仍保留各自 tested SHA；正式文学结果单独核对。153 项 UI 保持 152 qualified 加 1 项 IME WAIVED_BY_USER，不能写成 153 PASS；Classic 仅为历史基线与偏好兼容。

最终发行资格以文档提交后的同一精确 SHA 的成功 CI、Windows、macOS arm64、macOS x64 实际包、15 份回执、7 份资产及实际 ASAR 许可核对为准。34 项汇合、资产保留期及远端祖先关系由对应私有收据绑定。当前台账只陈述 `625078b1` 已有产品证据，没有预填最终 SHA、CI 或平台运行 ID。模型证据只有在有效 runtime、配置、输入及 semantic source 身份未变时才可条件复用，原 testedSha 不改。历史 `f432` 包不能替代最终包；不为回填后续资格再作一次 tracked 文档收尾提交。

G02 下表仅保留私有交付建议。“可交付”只指限定范围已有证据，不表示已发布或已关闭。“待复现或限定”表示原症状或交付链仍有缺口。“已有反例”保留原失败。逐症状关单仍须串起复现、原因、修复提交、独审、中文生产或适用打包入口、公开 Release 及无否定新反例。#222 按窄内部合同处理。本次未发表评论、关闭或重开 Issue、修改 PR 或发布 Release。

| Issue | 建议 | 限定范围 |
| --- | --- | --- |
| #187 | 待复现或限定 | 三用途内部限制已有窄修复；自然断流根因未知，不称原症状全修。 |
| #191 | 待复现或限定 | 派生状态可限域交付；原文本/大纲导入两半及 #279 B01 未全部结案。 |
| #199 | 可交付 | 现行规划范围、软目标、前缀保存与继续的已验范围；旧200章证据原样沿用。 |
| #205 | 已有反例 | 目标误判与目标 unknown 保留；仅目标判断失败按用户例外完整留存，其他缺陷不豁免。 |
| #211 | 待复现或限定 | 合并不代替完整原图谱/角色导入交互和公开包含链。 |
| #213 | 待复现或限定 | 手动完整归档与隔离profile恢复已有证据；当前正式恢复后续写与审读已完成，原失败保留，不是商业云资格。 |
| #219 | 待复现或限定 | 原缺主角故障未确认，需要原入口、模型和最小脱敏输出。 |
| #221 | 待复现或限定 | 三个用户原场景仍须分别核对；当前 f371 连续性事实缺陷可关联同类症状，不称复现同一原案。 |
| #222 | 可交付 | 仅已完成的未使用 ActivityBar 内部清理；非整体发布证明。 |
| #224 | 可交付 | 设置可见性及限定 Windows packaged-extracted 主题保存重开；不代 WebDAV 或全保存操作。 |
| #238 | 待复现或限定 | 未复现来源确实未变仍拒保存；成功样本不能删除来源守卫。 |
| #239 | 待复现或限定 | 正文依赖及单章切连续生成原场景缺最小失败夹具。 |
| #303 | 待复现或限定 | 仍缺最小原句、意见、结果及采用后的版本。 |
| #275 | 待复现或限定 | 材料传递证据不能证明原模型遵守作者设定，仍缺输入输出对照。 |
| #305 | 待复现或限定 | 前缀恢复与真实UI已验；原九批中的七成功场景未独立复现。 |
| #244 | 待复现或限定 | 原续写范围与衔接仍缺实际请求范围及前序材料。 |
| #280 | 待复现或限定 | 原约五万输入Tokens的单次或累计归因未证实。 |
| #265 | 待复现或限定 | 原字段保存、视图同步及关系连线分别待复现。 |
| #245 | 待复现或限定 | 缺删除入口及前后版本数量，不能先断定误删或无误删。 |
| #241 | 待复现或限定 | TXT、第二章、进度回退及全局推演场景分别待定位。 |
| #247 | 待复现或限定 | 缺具体导入入口和选择框状态。 |
| #248 | 待复现或限定 | 缺版本与故障模块；普通目录选择不代对话框内新建目录场景。 |
| #306 | 可交付 | 967cce46 的定位词表保真及31/31、38/38边界检查；非模型或完整安装验证。 |
| #279 | 待复现或限定 | 各子项是独立提案，迁移管理不代表全部功能完成。 |
| #310 | 待复现或限定 | 判断模型路由提案不是已批准实施合同。 |
| #318 | 可交付 | e5cdec51 的历史runner binding窄修复、223项检查及独审；非模型文学能力修复。 |

2026-10-05 快照另列 #313、#314、#315、#316、#317、#319、#320、#321 为 OPEN，#318 也仍为 OPEN。#319 与 #320 的本地窄修复证据见上表，未公开发布或结案。#321 的必要前情回顾误报不属于目标判断例外。#313 至 #317 保留各自历史症状和修复边界，本任务不补造原因或发布链，也不新增实施范围。

[#322 作者知识时点漏检](https://github.com/EthanYoQ/AI-Novel-Writer/issues/322) 为 OPEN、needs-triage。正式连续章节中，审稿静默漏掉作者规定的人物知情时点。独立离线诊断重建实际审稿 user prompt，hash 与发送记录匹配；完整首稿、两处作者约束均在，实际短细纲也禁止提前告知。现有证据支持模型语义错判，未发现客户端上下文丢失、截断或接线缺陷。诊断未新增模型请求，不称传递 bug，也不把此硬事实遗漏纳入当章目标判断例外。私有诊断为 `thread12-prerelease-f371-author-fact-diagnosis/report.md/json`。

本机证据名均相对 `.runtime/.cache/v3-resume-20260930/`。这些私有原件不是公开文档依赖；公开说明依靠本台账记录的事实与范围，原件按保留约定保存。本次文档更新不改写账本、原收据、原报告或历史分数。
