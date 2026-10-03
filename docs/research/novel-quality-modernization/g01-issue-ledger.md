# G01：原问题逐症状验收台账

状态读取：2026-10-03。本次用 `gh` 只读获取全部 20 个开放 Issue（排除 PR），并核对原 10 项、[#279](https://github.com/EthanYoQ/AI-Novel-Writer/issues/279)、关联 PR、实质评论、检查及 Release。原 10 项仍为五开五关；其余开放项不自动扩大为本轮开发范围。G02 关单前须再次读取远端状态。

本次汇总的产品修复提交为 `6cf907211208d506b0afe6210128bfcfe5fb9dfd`。读取时 [PR #230](https://github.com/EthanYoQ/AI-Novel-Writer/pull/230) 的远端 head 仍为 `7dc3e48da4496aa997b01c07d7ecfebfe7cd47d4`。下述测试、真实运行和平台证据各自绑定原 tested SHA，不随本地 HEAD 前移。**V3 尚未完成。**

现行产品只有 Writer V3 一个逻辑壳；Classic 用作历史基线及旧偏好兼容。旧 F05 原件已找到，本次只读核对 SHA256 为 `f465ebb9a0f33f84bbbbdddcd3d04f1a96aeb6b4bddd5434b96058cf9026ef4f`。其汇合 SHA 为 `bf3b31fdc6bd8cb625855ff745e69fe14f27cd7d`，153 项中 152 项 qualified、1 项用户豁免（U06.A03 真实中文 IME，非 PASS）。各动作仍沿用原 tested SHA 与复用边界；本次没有重跑 checker，也不声称当前版 153 项全量实测。

| 原 Issue／读取状态与独立症状 | 唯一验收 owner；现行实现消费者 | 已有证据层与仍需验收的边界 |
| --- | --- | --- |
| [#187 输出截断](https://github.com/EthanYoQ/AI-Novel-Writer/issues/187) **OPEN**：review-chapter、目录批次和 compact-single 三种用途分别可能遇到内部输出上限；错误提示不能把内部限制误归因于用户的 Max Tokens。 | S07；`review-chapter.command.ts`、`directory.command.ts`、生成预算运行入口。 | 目录与 compact 的精确 purpose 已有 main/provider 请求参数、真实 SQLite 候选保全、关闭重开与原 root 恢复合同测试。该补点在 `fb412b89` 工作树验证，使用受控响应，非真实模型。真实审稿保存/重开见下表；D02 保留报告长字段，D09 对齐官方 DeepSeek 两种地址能力。三用途仍须分别汇合有效上限、截断候选、重复恢复、提示及完整产品/打包证据。#229 合并不能替全部结案；#307 关闭未合并，只归入 #230 集成。 |
| [#191 自动角色卡与后续补充](https://github.com/EthanYoQ/AI-Novel-Writer/issues/191) **CLOSED**：文本／大纲导入可编辑角色卡，情节推进后补充派生状态，是两个不同需求。关闭原因是管理归并至 [#279 的 B01 待办项](https://github.com/EthanYoQ/AI-Novel-Writer/issues/279)，**并非全部实现完成**；此 B01 与 Program v3 的 B01 项目归档 Spec 无关。 | S09B；`CharacterCardImportButton.tsx`、`FinalizedCharacterStateCandidatePanel.tsx`、`CharactersView.tsx`、角色库的 derived-state 合并。 | 已有导入候选、状态补充与 CAS 合同；D01 新架构角色提议保留完整字段，旧提议按原版本核验。仍按文本/大纲来源、预览/确认/拒绝、作者保护、冲突提议、定稿后非冲突更新、重开和过期拒写验收。#279 B01 仍未勾选；已验派生能力可独立交付，不能替两项需求全部结案。 |
| [#199 故事架构/情节大纲范围与恢复](https://github.com/EthanYoQ/AI-Novel-Writer/issues/199) **CLOSED**：原症状是“AI 生成故事架构”中的 200 章情节大纲范围、截断后的续写与覆盖正确性。原 #201/#202/#203 实现已进入旧正式版。 | S06A；Writer V3“故事架构”→“AI 生成架构”→ `architecture-workflow.ts` 的 synopsis 步骤 → `GeneratePlotArchitectureCommand`（`architecture.command.ts`）。章节蓝图的 `DirectoryConfigDialog`/`directory.command.ts` 属另一入口，不能代证原情节大纲。 | 旧版代码/发布包含关系与当前故事架构大纲的范围、checkpoint、正文覆盖检查是不同证据；需核验 200 章有界批次、截断时未完成标记与原数据保全、续写不重复/覆盖作者编辑、取消/切项目/坏 checkpoint、UI 完成状态。蓝图批次覆盖可另验，但不替代本单。既有关闭保持历史事实；新 V3 资格不能从旧 Release 自动继承。 |
| [#205 连续性与逐目标审稿](https://github.com/EthanYoQ/AI-Novel-Writer/issues/205) **CLOSED**：冻结目标、三态审稿、证据引文及未来计划边界。原 #208 已合并并关闭。 | S11；`chapter-goal-review.ts`、写稿/审稿/修稿命令及章节共享证据。 | D02 保留审稿长字段，D03 保留定稿事实及证据尾部否定，均有保存/重开回归。T5 已区分当前作者材料与未来蓝图标签。仍需验证必现/可选/未知、当章与未来、引文定位与语义真实性、伪引文不默认修稿、作者确认、预算与恢复。R3 v5 的虚构历史时间 FAIL 不改判；D07 已修复合法包装的定向复核接收，并保留旧报告解释与恢复；不代表时间归属语义已经通过。 |
| [#211 图谱保存与角色卡导入](https://github.com/EthanYoQ/AI-Novel-Writer/issues/211) **CLOSED**：图谱/角色卡的导入、保存、错误可见性。#212 合并后关闭，晚于旧 v1.1.0。 | F04；`EditorArea` → `ArchFileViewer` → `CharacterCardImportButton`，角色管理与 Writer V3 导航。 | 有代码和合并记录；需验证 Writer V3 图谱只读与文件/粘贴导入、候选确认、无模型/失败/取消时原稿保全、重开及旧会话拒写。关闭和合并不证明对应正式版已包含，也不要求 Classic 双壳复验。 |
| [#213 云存档](https://github.com/EthanYoQ/AI-Novel-Writer/issues/213) **OPEN**：台式机与笔记本间完整项目手动备份和恢复。 | B02；`ProjectBackupPanel.tsx`、`cloud-backup-controller.ts`、`WebDavBackupService`，依赖 B01 完整归档/新副本恢复。 | 已有 WebDAV、归档/恢复实现和历史 F05 证据；仍需当前版两个隔离 profile、完整资产/读取权威、新 projectId/冻结旧任务、凭据重启绑定、分叉/中断/损坏/版本拒绝、C17/C18 恢复后继续创作及三平台 native/打包证据。历史 SHA 的通过不能替代当前授权和平台资格。 |
| [#219 主角缺失](https://github.com/EthanYoQ/AI-Novel-Writer/issues/219) **OPEN、needs-info**：生成人物时提示缺主角并卡住。根因尚未证实。 | S09A；人物生成/解析、`CharactersView.tsx`、角色库和身份准入。 | D01 字段完整性修复不能证明原缺主角故障。仍缺版本、系统、原模型/协议、入口及脱敏最小输出/错误，需分层核查解析、主角识别、落盘和 UI。#232 已关闭且未合并，只是候选 PR 清理，不是本单解决。保留既有信息请求，不放宽主角要求。此缺口仅限制本单判断与结案。 |
| [#221 角色、复述与未来剧情](https://github.com/EthanYoQ/AI-Novel-Writer/issues/221) **OPEN、needs-info**：①新增未批准角色；②第四章复述第三章；③第六章提前使用第八至十二章的未来剧情（后续反馈 #246 归并管理）。三个症状独立。 | S10B；章节上下文、`generate-draft.command.ts`、`review-chapter.command.ts`、`chapter-goal-review.ts`，角色准入由 S09A/B 提供。 | 有上下文选择、未来计划标签和目标审稿；仍需逐症状产品反例、跨章数据与人工语义核对。D04 保留不同场景的合法重复正文，不等于修复无意复述；D05 放行正常开头也不证明叙事质量。R3 仍失败。原报告 provider 的资格不足仅限制该 provider 的修复宣称与本单结案，不新增全项目阻断。 |
| [#222 ActivityBar 残留](https://github.com/EthanYoQ/AI-Novel-Writer/issues/222) **CLOSED**：内部未使用组件清理。[#223](https://github.com/EthanYoQ/AI-Novel-Writer/pull/223) 已合并于 `a2948c16f0dba26f7abdc763792c2b97fc6c57d9`。 | S13；当前 Writer V3 使用 `LeftToolWindowBar.tsx`；旧 `ActivityBar.tsx` 已无当前生产引用。 | 合并记录与当前消费者检查支持窄内部清理；保留独立审查/相关检查边界，不将此单扩大成产品 Release 完成证明。 |
| [#224 设置白屏](https://github.com/EthanYoQ/AI-Novel-Writer/issues/224) **OPEN**：Windows 源码运行时设置窗口内容空白。[#225](https://github.com/EthanYoQ/AI-Novel-Writer/pull/225) 仍 **OPEN**，head `e9aeb603241a573ae7de6a67d62767e1aa21e1ab`；本次读回 CI 成功。 | F04；`App.tsx` → `SettingsModal.tsx`，Writer V3 的标题栏/设置入口及各分类面板。 | `f625f1f54b7b4669c90f3359df052284f8d87d4d` 的真实 Windows 源码运行完成 17 个步骤、九类内容与 13 张独立核对截图。左栏/状态栏打开、备份直达、关闭重开与导航同步均通过，无模型请求。原回执仍为 PARTIAL，仅设置症状 PASS；旧失败保留。未验设置保存及备份操作，也不能将后续三平台通用资格代作最终 SHA 的设置专项或 Release。 |

原 G01 在 2026-09-13 读取时十项均开放，现为五项开放（#187/#213/#219/#221/#224）、五项关闭（#191/#199/#205/#211/#222）。旧 v1.1.0 的 #199/#205 合并与发布包含关系、#211 后续合并、#222 窄内部清理都保留原有历史归因；不把这些旧结论重算成当前 V3 通过，也不因新的统一前端要求重开已关 Issue。#191 的迁移关闭只表示管理位置变化。

其余 15 个开放项也已读取正文和评论。以下以症状归属与证据核对为主；2026-10-03 用户另行批准 #306/#309 的最小移植，其他条目不因此新增实施范围。

| 其余开放项 | 当前证据与未覆盖范围 |
| --- | --- |
| [#238 审稿源变化拒绝保存](https://github.com/EthanYoQ/AI-Novel-Writer/issues/238) | S11 审稿来源/提交边界。已有 v1.1.0 完整响应后拒绝保存日志，尚未复现“来源确实未变仍拒绝”。当前 Electron 成功保存/重开及 D02 历史重放仅证明所测案例；仍需定位版本、hash、依赖或会话的具体差异，不能删除守卫结案。 |
| [#239 正文依赖拒绝保存](https://github.com/EthanYoQ/AI-Novel-Writer/issues/239) | S10B 写稿依赖/保存边界，与 #238 分开。第十一章、第六章、单章切连续生成是三个报告场景；只有原案例有完整 stop/候选日志。D04 组合保存回归不替原问题复现；仍需合法未变依赖、旧定稿和模式切换的最小失败夹具。 |
| [#303 修稿无变化](https://github.com/EthanYoQ/AI-Novel-Writer/issues/303)、[#275 作者设定遗漏](https://github.com/EthanYoQ/AI-Novel-Writer/issues/275) | S11 修稿采用链、S06A/S10B 作者材料链。T5 材料边界与本轮字段保真修复是相关证据，不证明意见已落实或模型遵守设定。#303 仍缺按钮顺序、最小原句/意见/结果及采用后版本；#275 已有 v1.1.0 与模型切换补充，仍需合成要求和实际输入/输出对照。 |
| [#305 蓝图失败后成果恢复](https://github.com/EthanYoQ/AI-Novel-Writer/issues/305)、[#244 大纲续写范围/衔接](https://github.com/EthanYoQ/AI-Novel-Writer/issues/244) | 分属目录批次恢复与 S06A 大纲范围消费者。#305 的 9 批中 7 批成功报告未独立复现，候选未提交不等于永久丢失；#308 关闭未合并，只归入 #230。#244 仍需实际请求范围/前序材料与合成输出，不能拿 #199 或 #187 的局部通过代证。 |
| [#280 输入 Tokens 偏高](https://github.com/EthanYoQ/AI-Novel-Writer/issues/280) | S07 预算及 S10B 上下文。旧版源码支持完整 synopsis 参与输入，但约 5 万 Tokens 的单次/累计归因未证实。仍缺入口、模型、请求次数与实际用量；与 #187 输出限制分开，不能截掉作者证据来降低统计。 |
| [#265 角色跨视图/保存](https://github.com/EthanYoQ/AI-Novel-Writer/issues/265)、[#245 删除范围](https://github.com/EthanYoQ/AI-Novel-Writer/issues/245) | F04/S09B 角色投影与稿件版本消费者。既有导入、派生及原稿保护证据不覆盖全部原报告。#265 分开核对字段保存、投影同步、关系连线；#245 仍需删除入口及前后版本数量，不能把同一版本消失当作无关版本误删，也不能反向认定没有误删。 |
| [#241 导入/拆解失败](https://github.com/EthanYoQ/AI-Novel-Writer/issues/241)、[#247 导入入口无响应](https://github.com/EthanYoQ/AI-Novel-Writer/issues/247)、[#248 选目录闪退](https://github.com/EthanYoQ/AI-Novel-Writer/issues/248) | F04 文件入口与导入消费者。历史 F05/native 及旧项目副本平台资格仅覆盖原步骤。#241 的读 TXT、第二章、进度回退、全局推演分别待定位；#247 仍缺具体入口/选择框状态，#248 仍缺版本及故障模块。通用选择目录成功不能替“对话框内新建目录后确认”复现。 |
| [#306 章节定位显示](https://github.com/EthanYoQ/AI-Novel-Writer/issues/306) | F04 蓝图编辑/创作弹窗。2026-10-03 在 #230 的 `1d51bfa8` 核实两套词表、自定义/空白显示和空字符串初始化缺口。用户批准最小吸收 [#309](https://github.com/EthanYoQ/AI-Novel-Writer/pull/309)，参考 head `af283f5b`，作者 SIRIUS（skywolf123）。产品要求及测试归[现行 F04](frontend-transition-specs.md#chapter-role-preservation)；尚无本轮移植提交或组件通过证据，保持待修。不得引入 #308、合并 master 或关闭 PR/Issue。 |
| [#279 功能待办](https://github.com/EthanYoQ/AI-Novel-Writer/issues/279)、[#310 审稿架构提案](https://github.com/EthanYoQ/AI-Novel-Writer/issues/310) | 独立提案。#279 各子项独立评估；#310 的判断模型路由尚非已批准实施合同。保留问题与建议，不把新模型接入、穷举审查或整份待办扩大为本轮修复。 |

本次核对 [v1.1.0](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v1.1.0) 仍是最新公开正式版，绑定 `879f83521414f66019488462830c3134c77dc4f8`。#201/#202/#203/#208 的合并提交均为该提交的祖先，#212 则不是；当前修复尚无公开 Release 包含证据。

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

| 真实运行／平台证据 | tested SHA 与实际范围 |
| --- | --- |
| Electron 审稿保存及重开 | `a95693cf6a64488bfc33d41880e3a50917dc4de6`。SiliconFlow 的 Qwen 两配置及 DeepSeek Flash 各发一次请求，报告保存、原稿保全、任务释放；新进程重开不发请求且报告/attempt 不变。Qwen 2048 样本约 143 秒，不声称均满足 120 秒。均为开发样本。 |
| “重新审稿”真实入口 | 同上 SHA。首次外发前受控注入连接中断，随后实际点击“重新审稿”，发出一次真实请求并保存报告；重开零请求，原未知 attempt 保留。该证据不解释历史自然网络中断原因。 |
| 原生 DeepSeek 保存及重开 | 同上 SHA。首次 HTTP 401 失败保留；授权更换凭据后一次请求 HTTP 200，报告保存、原稿保全，重开零请求且报告/attempt 不变。未计入正式文学样本。 |
| 精确三平台技术资格 | 仅 `7dc3e48da4496aa997b01c07d7ecfebfe7cd47d4`：[Windows](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/37114158297)、[macOS arm64](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/37114161254)、[macOS x64](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/37114164303)。Windows 九份、Mac 各三份回执通过，覆盖约定的旧版副本导入/保存/重开及原件保护。Windows 未签名，Mac 为 ad-hoc 且未公证；不外推到本次产品修复提交。 |

剩余必交项按[线程 10 交付计划](thread10-delivery-plan.md)执行：R3 v5 在 `11152245e3aa87f08797c089c57d71b06f5e493b` 为 **FAIL**，三槽仅一槽语义通过。第二槽存在虚构历史时间，第三槽未运行，历史不改判。正式 C16 九案、恢复后十二案、连续九章尚未完成；受影响 early-context 尚待复验；其余 post-UI/U16 断言按现行计划汇合原证据及实际变更范围，不重跑全部功能。最终汇合 SHA 的 CI/三平台仍待验。D06、D07、D10 已按上表完成窄修复，不能据此关闭 R3。审计中的语法修复容量限制、其他任务的格式兼容、Gemini 特定 SSE 包装、导入人物数下限及尚未证实的输入/提示风险仍按原分类保留，不宣称所有模型输出路径均已无缺陷。

G02 当前不新增可关闭建议。逐症状关单仍须串起复现/原因、修复提交、独审、中文生产/适用打包入口、公开 Release 及无否定新反例；#222 按窄内部合同处理。本次仅更新证据台账，未发表评论、关闭/重开 Issue、修改 PR 或发布 Release。
