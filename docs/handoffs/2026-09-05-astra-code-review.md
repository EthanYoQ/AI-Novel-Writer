# Astra 无上下文代码审查与项目接手手册

日期：2026-09-05
仓库：`EthanYoQ/AI-Novel-Writer`
审查分支：`codex/plot-tree-update-reminder`
比较基线：`48c3b8a473da7d6d901ea087d13a32cd0e307f8a`
实现提交：`5c6e73e522a4499d1c90d389b548e2906fe820ef`
合并状态：禁止合并；本轮只要求独立代码审查。

## 1. 先读本节：证据规则

本文用于让没有会话上下文的审查 Agent 快速建立完整地图，不是新的产品事实库。现有 README、ADR、研究和旧 handoff 曾出现腐化、过时或互相冲突，不能单独用来证明当前行为。

审查时按以下证据优先级判断：

1. 固定提交上的生产代码和数据库约束；
2. 能在该提交复现的单元、浏览器和打包测试；
3. 两批开发中的真实 Electron、在线模型、日志、窗口与归档验证记录；
4. GitHub Issue 的原始报告和维护者评论；
5. 第一批开发任务 `019ffd05-7a56-7792-b0ef-f092e3bdfeaa` 与第二批当前任务的工作记录；
6. 现有 README、ADR、研究与旧 handoff，仅作为待核对线索。

本文的状态词：

- **代码确认**：可直接从实现和回归测试确认。
- **实机确认**：真实 Electron 或在线模型流程已经观察到。
- **历史记录**：开发记录中发生过，但当前未重新完整复现。
- **未知**：没有足够证据，不得宣称已解决。

审查代码范围：

```powershell
git fetch origin
git checkout codex/plot-tree-update-reminder
git status --short
git diff --stat 48c3b8a473da7d6d901ea087d13a32cd0e307f8a..5c6e73e522a4499d1c90d389b548e2906fe820ef
git diff 48c3b8a473da7d6d901ea087d13a32cd0e307f8a..5c6e73e522a4499d1c90d389b548e2906fe820ef
```

实现提交相对基线包含 222 个文件，约 `+14247/-1488`。不要只按提交大小判断质量；重点核对下文列出的事实边界、失败原子性和真实用户路径。

## 2. 软件是什么

AI Novel Writer 是本地优先的 Electron 长篇小说创作工作台。它负责项目状态、提示词组装、模型调用编排、角色与蓝图事实、草稿、审稿、修订、定稿、连续性、知识检索和本地落盘。模型由用户自行配置，产品不托管模型、不提供模型额度、不公开发布小说，也不是阅读社区或通用 Agent 平台。

主要技术：

- Electron 41、React 19、TypeScript、Vite；
- Zustand 管理前端状态；
- SQLite 保存项目结构化事实、流程收据和最终状态；
- FTS 与 LanceDB 提供知识检索；
- Vitest 覆盖 Node 与浏览器测试；
- electron-builder 生成桌面产物。

主要入口：

- Electron 生命周期和控制器：`electron/main.ts`、`electron/controllers/`；
- 数据库与持久化：`electron/database.ts`、`electron/repositories/`；
- 模型调用冻结层：`src/services/generation/generation-runtime.ts`；
- 写作流程：`src/services/workflows/`；
- Agent：`src/services/agent/`、`src/stores/agent-store.ts`；
- 主界面：`src/App.tsx`、`src/components/layout/`、`src/components/panels/`；
- 共享 IPC 与领域类型：`src/shared/`。

## 3. 当前必须保持的不变量

以下边界都能从当前代码和相邻测试交叉确认。任何“简化”不得破坏它们。

### 3.1 项目、事实和派生数据

- 小说项目目录是持久化和权限边界。
- 项目会话由路径和 lease 共同识别；同一路径关闭重开后，旧 lease 不能继续读写。
- 作者输入或人工确认的配置、角色、世界观、大纲、蓝图、叙事计划和正文是权威事实。
- 角色图谱、连续性摘要和剧情树是派生投影，不能反写或取代作者事实。
- 结构化角色名单是角色身份、资料和关系的事实源；画布只是展示。
- 生成失败不得提交部分角色、部分蓝图、不完整审稿或不完整正文。
- 蓝图提交和随后角色同步是两个可区分阶段；同步失败不能谎称蓝图未提交。
- 审稿意见必须经人工确认后才能进入修稿；修订稿必须经差异确认后才能合并。
- 定稿是项目内事务，知识库、摘要和角色状态后处理通过 outbox/receipt 跟踪。

### 3.2 冻结上下文

每个异步生成或工具任务必须在启动点冻结：

- 项目路径和项目 session lease；
- 选定模型及模型 revision/endpoint fingerprint；
- UI locale；
- 项目写作语言；
- 写作 Skill；
- 创作策略和生成预算。

任务运行时切换项目、语言、模型或设置，不能让正在运行的请求借用新状态。

### 3.3 语言和提示词

- UI locale 与项目写作语言相互独立。
- 界面、任务标题、日志和安全错误使用任务启动时冻结的 UI locale。
- 模型 system/user 指令和 observation 使用项目写作语言。
- 作者原文、角色名和引用资料保持原样，不因界面切换被翻译。
- 用户只能覆盖创作角色定位和任务指导；语言约束、JSON schema、工具协议和安全合同不可覆盖。
- 写作 Skill 只提供按阶段冻结的提示词指导，不执行 scripts、hooks、子代理或任意工具。

### 3.4 剧情树、更新和外部能力

- 剧情树只读地归纳大纲、蓝图、定稿摘要和已确认叙事资料，不进入正文提示词。
- 剧情树失败、源变化或来源删除时保留上一次结构有效的快照并标记过期。
- Windows 发现更新后必须等待用户明确点击下载。
- macOS 只检查正式 Release 并打开固定 GitHub Release 页面，不在应用内替换程序。
- 最近项目“移除记录”不等于删除磁盘项目；只有后者需要当前项目 lease。
- 外部文件只通过用户明确选择的文件能力读取。
- Windows 生产子进程不得弹出控制台窗口。

## 4. 开发历史时间线

### 4.1 v0.9.2 发布基线

`v0.9.2` 标签位于 `6912bc6f665411ef7869786770327012b2082381`。它是在错误的 v0.9.1 发布被撤回后重新执行三平台资格构建得到的正式基线。v0.9.1 曾绕过完整 Windows 门禁并发布错误资产；因此后续发布必须冻结同一 SHA、独立验证 Windows x64、macOS ARM64、macOS x64，并远端回读资产与摘要。

`v0.9.2` 后，主线又合入三次修复：

- `97daa443feefb240e83daed4fc351acf9cb8f149`：双语提示词和安全的写作 Skill；
- `807e12a`：加固双语生成、角色/蓝图和 Agent 工作流；
- `48c3b8a473da7d6d901ea087d13a32cd0e307f8a`：修复作者写作入口、导出 session 和蓝图角色同步。

当前审查分支正是从 `48c3b8a` 开始。

### 4.2 第一批开发记录

第一批开发记录位于任务 `019ffd05-7a56-7792-b0ef-f092e3bdfeaa`。该批先修复流式输出、端点、导入、写作闭环、双语提示词和发布问题，随后在 `48c3b8a` 之上开发剧情树与跨平台更新提醒。第一批尾部仍是未提交工作区，后来与第二批共同固定为实现提交 `5c6e73e`。

### 4.3 第二批开发记录

第二批是生成 `5c6e73e` 的当前任务。它接手第一批工作区，处理 GitHub #185/#187/#191 和人工测试发现的语言、角色、剧情树、连续性、篇幅、Agent 工具协议、终端弹窗等问题，并完成真实中英文四章流程、视觉审计、日志审计、Windows ZIP 和独立 code review。

由于两批连续修改了同一批核心文件，不能安全地按文件或补丁重新拆成两个实现提交。审查应使用时间线理解意图，但用一个固定 diff 判断最终状态。

## 5. 第一批 Bug 与修复台账

本节列出第一批记录中所有可识别的问题。中间尝试若后来被撤销，不作为当前设计。

### 5.1 流式输出、端点与推理

1. **#92 写作过程中输出区空白。** SSE chunk 已到 provider 层，但统一 Generation Runtime 没有继续传递 `onChunk`，UI 只能在 `complete()` 后一次性回填。修复为 runtime → workflow → 临时预览的 chunk 通路，并隔离临时文本与最终可持久化正文；处理跨 chunk `<think>`、取消、失败、迟到 chunk 和终态回填。历史实机从“约 90% 仍空白”变为数秒后持续出现正文。旧报告中的新建/导出 1–2 秒延迟没有稳定复现，仍属未知。
2. **#99 自定义 OpenAI-compatible URL 被强制追加 `/v1`。** 普通与流式请求各自拼 URL。修复为共享端点解析，支持完整 chat URL、`/v1`、`/v3`、`/v4`、路径前缀和尾斜杠。
3. **推理策略错误抽象。** 旧代码只有 `thinking:boolean`，无法表达供应商档位，并可能把未发送的“关闭推理”显示为已生效。修复为创作策略与供应商推理档分离，记录请求值和实际映射值；未知模型不猜测字段。DeepSeek V4 Flash 的 Off 与档位映射经过历史实机验证。文学质量提升仍需人工盲评。

### 5.2 Prompt、结构化输出与 Agent 协议

4. **完整 system prompt 被回显到用户对话。** Agent 可见输出只过滤工具标签。修复为在可见边界剔除已知完整 system prompt 回显，同时保留普通正文。
5. **BOM、零宽字符和完整 JSON 围栏导致合法结构化结果失败。** 修复为只接受裸完整 JSON 或一个完整 fence，并仅清理首尾 BOM/零宽残留；解释性散文、多对象、截断尾部仍拒绝。
6. **角色关系引用不存在的角色端点。** 历史中曾做过受限补卡，最终收敛为结构化身份清单 → 详情 → 原子名册提交；正文后处理不能猜测创建新角色，只有蓝图明确的长期候选可进入角色事实。审查当前代码时不要恢复已撤销的任意自动补卡策略。
7. **Provider 原始工具调用显示为文本而未执行。** 修复为只兼容已注册工具的 whole-response 形态，包括标准 JSON envelope、`<tool_call>`、SiliconFlow DSML、`<name>/<arguments>` 和单一空子标签。普通散文尾部 JSON 保持惰性，写工具仍需人工确认。
8. **中文提案别名无法进入已有确认流程。** 对确认卡可识别的中文配置/蓝图提案名称做窄兼容，不能扩展成任意自然语言工具执行。
9. **可选项目 `.vela/skills` 不存在时被当成错误。** 当前逻辑忽略“目录确实不存在”，但权限或读取失败仍显示真实错误。

### 5.3 仿写、作者稿与项目树

10. **参考小说被写入用户草稿/定稿体系。** 参考作品现在只进入 reference knowledge；受污染项目使用需要确认的清理入口，保留蓝图、角色、架构和知识库。
11. **存在第 2–5 章定稿时，写作入口错误跳到第 6 章。** 旧逻辑使用最大定稿章号。修复为打开最早存在蓝图但尚未定稿的章节。
12. **作者原稿没有蓝图时左侧为空。** 草稿 store 旧逻辑只围绕蓝图加载。修复为受 session 保护的全量草稿元数据读取，项目树按实际 draft/finalized 事实分组。
13. **参考蓝图覆盖作者定稿标题。** 项目树优先蓝图标题，且资源缓存只用 draft ID，跨项目会串。修复为定稿优先使用冻结作者标题，缓存按 `projectPath + resource path` 定域。
14. **导入逐步确认可能被模态窗口遮住。** 第一批确认过这一症状，但当前没有同等安装态复现证据。审查时应把它作为需复核项，而不是已完成结论。
15. **文件树刷新阻塞已提交导入事实。** 派生 `fs:list-dir` pending 被当成硬门槛。修复为派生刷新限时，超时只告警，不回滚权威事实。
16. **架构/蓝图提交后项目树不刷新。** 第二批补充资源事件订阅，使架构四项和蓝图计数不需要等待另一工作流状态变化。

### 5.4 模型选择和错误归因

17. **右侧 Agent 选择 Grok，但正文仍由全局默认模型生成。** Agent 模型与写作模型是两个入口，旧写作工作流没有本次选择器。修复为单章、批量、审稿驱动修稿冻结本次 generation model；不改全局默认，也不允许模型通过工具参数伪造模型 ID。
18. **`content_filter`、`length` 等被泛化为“工作流未完成”。** finish reason 现在贯通命令、步骤、工作流和 AI 输出面板；不完整结果不落盘，并显示冻结语言下的安全原因。

### 5.5 审稿、修稿、合并和定稿

19. **AI 审稿后缺少人工确认闭环。** 修复为逐条编辑、忽略、恢复、新增人工问题和总体指导；生成不可变 `human-confirmed-review`，修稿只读取确认项，修订先进入差异视图，人工合并后才更新草稿。
20. **自动打开审稿页时修稿按钮消失。** 入口漏传 `chapterDir/reviewId`。修复后相同页面可以定位原审稿与确认来源。
21. **合并后修订记录仍显示待合并。** `vela://revision/1` 的匹配少了一个斜杠；修正 URI 解析。
22. **新增人工问题为空时只有通用错误。** 该项本来必须由作者填写，不能让 AI 伪造。修复为双语占位和确认前明确要求填写或删除。
23. **定稿后处理“尚未开始”显示成红色失败。** 数据库用 `ok=false / attempt=0 / error=null` 表示 pending。UI 现在只有存在真实错误证据才显示失败。

### 5.6 模型配置、启动和编辑体验

24. **模型配置死循环。** 没有已保存模型就不能拉列表、没有列表又不能保存，测试成功后仍可能禁用保存。修复为使用表单临时 URL/API Key 拉取、允许手工 model ID、显示名可空、连接测试不阻止保存，设置页只能主动关闭。
25. **新建/打开项目报 `better-sqlite3` ABI 141/145。** Node 测试和 Electron 41 需要不同 ABI。`predev` 现在检测并只在不匹配时 rebuild Electron native；错误选择父目录仍被安全拒绝。
26. **EPUB 依赖被打进主进程 bundle 后 `require("fs")` 崩溃。** 调整外部依赖/bundle 边界；生产构建与 Electron 启动历史验证通过。
27. **EPUB 不支持。** 增加无 DRM EPUB 2/3、UTF-8/UTF-16、spine 顺序和单 XHTML 多章节拆分。复杂实体、CDATA、损坏 EPUB、PDF/OCR 不在本次保证内。
28. **编辑器 caret 与背景同色。** 各主题使用独立高对比光标色，并通过真实浏览器聚焦验证。
29. **同一资源可重复启动多个工作流。** 现在按项目和资源建立类型化互斥；同一蓝图/角色/世界观等不能重复，不同资源不被无必要全局串行。
30. **没有一键清理角色图谱。** 因图谱只是角色名单投影，清理动作明确为删除全部角色与关系，二次确认后走原子名册通道。
31. **伏笔能力存在但不可发现。** UI 改为“伏笔与叙事线索”，支持埋设、推进、回收、放弃、候选建议、沉寂和超期提示。
32. **小说配置/故事前提没有可靠进入后续生成。** 统一 prompt 渲染补齐作者权威上下文；自定义模板缺少变量时由入口补充，而不是悄悄丢事实。
33. **目标 3000 字却生成约 8455 字，批量目标未传递。** 第一批统一中文汉字/英文单词计量、冻结单章目标、82% 下限和 12% 上浮；第二批进一步取消盲截断，改为完整压缩/重写。
34. **第二章变慢、资源占用高。** 只确认异常长输出会增加耗时，没有独立证明内存泄漏。仍属未知。

### 5.7 导入恢复和收据

35. **蓝图恢复把合法 `pending → completed` 判定为损坏。** 旧代码把冻结 receipt 与当前权威状态逐字段相等比较。现在 immutable 字段严格核对，只允许有权威角色名册操作证明的状态推进。
36. **同一 import run 续跑时 active/history 重复。** 注册 active run 时移除同 runId 的旧失败历史，并以真实 SQLite 覆盖失败 → 重启 → replay → completed。
37. **取消或刷新让已提交事实被误报为失败。** 蓝图/角色原子提交成功后，checkpoint、派生刷新或角色同步失败不能反转提交；提交后取消也不能声称“零写入”。
38. **#177 已有角色项目导入时收据校验失败。** 写入端合并角色，校验端却要求合并后数量等于本次新增数量。修复为验证本次推断的每个名称都存在于回读快照。
39. **#171 蓝图角色同步失败后无法继续。** 蓝图事实已提交，但旧同步待办永久禁用后续操作。角色同步现在是独立可重试派生步骤，并保留真实提交收据。
40. **#174 合法角色详情超过 300/500 字即失败。** 移除旧硬失败，后来在第二批对安全描述字段使用明确 Unicode 上限；身份、关系和必填结构继续严格。
41. **#175 模型到输出上限。** 应用继续拒绝不完整结果，不把 `length` 伪装成成功；第一批改善诊断，第二批补齐 bounded completion。
42. **#179 “没有安全输出空间”难以定位。** 预算错误增加上下文、估算输入、输出预留和主要 prompt 分区；没有为了绕过错误降低安全门槛。

### 5.8 双语提示词与写作 Skill

43. **英文项目仍发送中文 system/user prompt。** 配置字段、编辑器改写、首章/续章、审稿、修稿和 Agent 工具曾有硬编码中文。提示模板现在按 `prompt key + writingLanguage` 隔离，项目写作语言独立于 UI locale。
44. **“白金作家”“Qwen3 14B Q4”等过时、地区化或模型绑定描述。** 改成中性的 fiction writer/editor/story architect，并保持作者事实优先、因果推进、角色选择与代价、连续性和禁止元话术。
45. **提示词覆盖迁移和损坏隔离缺陷。** 修复冷启动未水合、单语言损坏影响另一语言、中文保存误清英文诊断、旧 `key.json` 重复迁移、设置预加载缺少 writing language。
46. **创作提示词可编辑与安全合同混在一起。** 高级设置只开放角色定位和任务指导；语言、JSON、工具和数据安全合同隐藏且不可覆盖。
47. **写作 Skill 容易膨胀成任意插件运行时。** 当前只支持自包含提示词型 Skill，按规划、正文、审稿、修稿四阶段绑定并冻结；不执行 scripts/hooks/references。内置 Skill 不可覆盖，内容有哈希和预算归因。

### 5.9 第一批尾部：剧情树与更新提醒

48. **缺少主线/支线剧情树。** 增加固定章节轨道的只读派生快照，与叙事计划同编辑器双视图，替换左栏重复 AI 设置入口；没有引入 React Flow、图数据库或布局持久化。
49. **剧情树按秒级时间戳判断来源变化，同秒修改会漏判。** 改为确定性来源 SHA-256 revision。
50. **来源被删除时旧剧情树也被丢弃。** 读取只验证快照自身结构，新保存才验证当前来源；旧快照保留并标 stale。
51. **支线没有父主线也可保存。** 当前合同要求每条 subplot 指向现有 main，main 不得有 parent。
52. **损坏、幻觉来源或 generation 期间源变化可能覆盖旧快照。** 严格核对 source ID、章节和 planned/occurred 状态，保存前再次比较 revision；失败保留旧快照。
53. **剧情树只显示泛化失败。** `length`、content policy、cancel、deadline、provider、invalid JSON、invalid contract 使用不同安全错误。
54. **剧情树所选模型被删除后状态错误。** 显示模型不可用并禁用刷新。
55. **更新提醒只在欢迎页可见。** 增加全局 `UpdateNotifier`，复用 ActionToast，点击回到已有更新区。
56. **自动更新检查在联网前写入“今日已检查”。** 只有成功取得最新正式版信息才消耗每日资格；失败后下次启动可重试，手动检查仍可强制。
57. **Windows 检查到新版本就开始下载。** 改为 `available` 后等待用户明确点击；并发下载请求只能启动一次。
58. **macOS 更新完全禁用。** 打包态 macOS 读取固定仓库的稳定 Release metadata，发现新版只打开固定 Release 页面。
59. **Toast 在容器挂载前丢失。** 增加 pending queue 和 dismiss disposer。
60. **延后提醒后相同版本无法再次出现。** 延后期间移除 active notice，期限结束后允许同一版本重新提醒。
61. **英文 `App updates` 在窄卡片中逐词断行。** 修正窄宽布局并增加 448px 浏览器回归。

## 6. 第二批 Bug 与修复台账

### 6.1 项目导航、语言和冻结 session

62. **已移动/不存在的最近项目无法移除。** UI 错把“移除最近记录”调用成“删除磁盘项目”，后端要求当前 verified session。新增 `project:recent-remove`，只删导航记录，不访问项目目录；真实删除仍需要 lease。
63. **英文界面只翻译顶部，侧栏、正文区、任务、日志和设置仍为中文。** 补齐 shell、项目树、Agent、架构、蓝图、知识库、版本历史、后处理、导出、设置、时间和数字的 locale surface。
64. **切换语言后，必须点击其他页面才局部刷新。** locale store 的读取函数 identity 固定，部分组件没有订阅可变 state。现在 reader identity 随 locale 更新，已有标签页标题同步刷新。
65. **英文界面中的运行中工作流仍为中文。** 工作流启动时冻结 UI locale，任务标题、步骤、日志、取消和失败在整个 run 中保持一致；切换 UI 不会让同一任务半中半英。
66. **英文 Agent 回复中文。** UI locale、writing language 和后端安全错误曾混用。现在工具卡/错误使用 UI locale，给模型的 observation 使用 writing language，英文工具目录不再回退中文。
67. **Agent 报“缺少冻结项目会话，已拒绝工具项目访问”。** Agent turn 过晚读取 mutable active project，工具只携带路径。现在 turn 启动前冻结完整 ProjectSessionContext；所有 project-scoped 工具在 IPC 前后校验 lease。
68. **无项目 Agent turn 中途打开项目后可能借用新项目。** 无项目边界也被冻结；中途打开项目不会给旧 turn 增加权限。
69. **生成 Runtime 在异步打开模型 lease 后才读取项目/策略。** Runtime 现在接受调用方冻结的 project session、模型、语言、策略和预算。
70. **英文导出日志、写入失败和后处理仍出现中文。** 导出与后处理使用启动时冻结 UI locale，模型输入仍按 writing language。

### 6.2 角色生成与图谱

71. **架构和蓝图生成后角色图谱为空。** 原因组合包括 manifest 合同过严、只允许恰好一个主角、角色详情单项调用过多、可恢复 provider 形态被拒绝、对话框复用旧缺失状态以及项目树不刷新。当前允许至少一个主角和双主角，详情 batch 为 3，安全归一化数值/字符串/数组形态，原子名册提交后 readback 才成功；对话框重开恢复缺失项默认选择，项目树订阅提交事件。
72. **角色详情过长造成调用和上下文膨胀。** 描述字段和状态字段使用 Unicode-safe 的明确上限；身份、角色类型、关系端点和必填结构仍严格，不能把截短扩大到事实字段。
73. **角色图谱所有角色只能整块拖动。** 指针先转换到 world coordinate 并 hit-test；点中节点只更新该节点，空白处平移画布，缩放和适合视图继续工作。
74. **角色图谱文字重叠。** 节点名最多 8 个 Unicode 字符，关系标签最多 6，其余显示 `+N`；完整内容保留在详情/可访问描述。互为双向关系合并成一条概览边，边距增加。
75. **角色列表多时无法快速定位。** #185 附加实现按姓名片段、不区分大小写搜索，清空后恢复完整列表。

### 6.3 剧情树超时与结构安全

76. **剧情树连续三次超时，第二次才偶尔成功。** 对输入做确定性有界投影；模型预算最多两次、累计 16,384 output tokens、十分钟 planning window。一次 initial 后只允许一次结构 replacement，不无限重试。
77. **超长项目素材直接塞入剧情树 prompt。** synopsis、blueprints、finalized chapters、plans 和 events 分别设上限；长篇的均匀采样仍可能漏局部支线，这是已知边界。
78. **剧情树错误把模型原文暴露给 UI。** invalid JSON、contract、deadline/provider 只显示安全错误码和冻结语言文案，不回显模型响应。

### 6.4 Windows 弹窗

79. **写作或审稿合并时弹出多个终端窗口。** 已确认的生产路径是 MCP stdio child process；`electron/mcp/mcp-manager.ts` 使用 `windowsHide:true`。最终 Windows EXE 的 PE subsystem 为 2。审查仍应搜索所有生产 `spawn/exec`，确认没有其他漏项。

### 6.5 跨章节重复和篇幅

80. **第 1 章末尾与第 2 章开头逐字复用，并出现时间线回退。** 用户样本包括脚步声、活体引信和暗红虫等重复。旧 prompt 提供上一章尾部，却没说明它已经完成，也没有生成后门禁。现在 `previousChapterEnding()` 从自然边界截取，prompt 明确“从其后继续，禁止重演/复述”。
81. **下一章约 700 字只用于承接上一章。** 新章开头与上一章结尾进行确定性检查：NFKC、小写、去空白/标点/符号；中文 8 字 n-gram、英文 20 字 n-gram；连续匹配至少 80，或至少两段累计 36 时拒绝。短状态回声和常用短语允许。
82. **同一生成结果内部出现重复长段。** continuation 合并前清理已有尾部复用，模型被要求只输出新增正文。
83. **批量生成下一章没有 finalized previous chapter。** 同一批次使用 ephemeral previous ending，只作为 prompt 边界，不伪造成定稿事实。
84. **`length` 达到 82% 后被误当可接受。** 82% 只判断篇幅，不代表 provider 完整终止；非 `stop` 结果继续补写或失败关闭。
85. **空续写或只有少量新正文被反复拼接。** 新增不足 300 单位时不当作有效进展，最多一次 no-progress recovery，不形成无限循环。
86. **超长完整正文被盲截断。** 当前顺序为同 session 完整压缩、必要时从空白页完整重写、有限补救；最终仍超出或不足则不保存。
87. **第一次长度修复把 2863 单位压成约 1835，低于下限后直接失败。** 现在首次 repair 无论过长或过短，都进入已有 final full rewrite；真实英文第四章由此完成。
88. **正文单位在生成与定稿不一致。** `draft unit algorithm` 升级，finalization 使用同一 `countDraftUnits`；中文按汉字、英文按词。
89. **语义改写后的重复或时间线回退。** 当前门禁只检测字面复用，没有新增语义模型审查。这是刻意的最小边界，仍属未知风险。

### 6.6 配置、蓝图、审稿和结构化执行

90. **AI 生成“全局写作要求”变成完整逐章大纲。** 旧模板要求前中后和高潮频率。现在只要求 4–8 条跨章节长期规则，最多 600 单位，禁止逐章枚举和重述大纲。
91. **长配置全部带入每章导致 prompt 膨胀。** 持久化作者事实保持完整；正文请求使用自然边界投影，单项至多 1000、后续蓝图 5 章、active threads 6 条/1200、previous tail 1000、knowledge top 5。
92. **AI 生成配置会覆盖作者已有内容。** 完整配置和单字段生成都改成扩写作者内容；显式 genre/audience/structure/POV 等选择保持原值，避免重复追加已有原文。
93. **蓝图单次输出过长，compact fallback 仍达到上限。** 多项 batch 可二分，单项使用不超过 16KiB 的 bounded-facts reconstruction；最近蓝图、架构 excerpt 和 system role 分别受限。整个范围验证后只提交一次。
94. **合法蓝图描述因为过小上限失败。** `keyEvents`、role、purpose 等描述上限调大；安全自由文本可确定性 Unicode 截短，缺 title、关系或章节等事实仍拒绝。
95. **结构化 batch 后段失败却可能保留前段。** shared executor 先验证所有 item，最后单次事务提交；receipt 记录 calls、splits、tokens、attempts 和 diagnostic。
96. **架构或蓝图被完整 JSON fence 包裹时无谓重试。** 只要 fence 覆盖完整响应就直接解析；散文围栏、多围栏和尾随解释仍拒绝。
97. **AI 审稿输出过长、格式变化或内容太散。** 当前 contract 为 summary + 1..10 items，severity enum，summary 120、description 200、quote 160；`length` 只允许一次 replacement，非法结果不保存，并兼容已验证的 DeepSeek envelope。
98. **定稿角色抽取只看章节开头。** 对长章在一个有界请求中采样前后两端，避免遗漏后半章角色变化。
99. **生成的钩子为空或蓝图事件缺乏具体动作。** semantic contract 要求具体 suspense hook 和有限、可写的 key events；没有悬疑题材也要给下一章驱动力。

### 6.7 #185/#191 作者规划材料与角色提取

100. **#185 没有入口导入数万字作者前置规划。** 文件由用户选择后先本地进入 project knowledge，不冒充 reference novel。
101. **规划材料导入隐式依赖 embedding 模型。** 默认 FTS-only；确认提取角色前不调用 embedding provider，也不激活残缺向量空间。
102. **材料可能未经说明被发送给远端模型。** UI 在调用前披露文件、用途、模型和 endpoint，用户确认后才开始提取。
103. **#191 从文本提取角色后直接污染角色事实。** 模型结果先成为候选预览；第二次人工确认后才以 operationId/revision 原子合并名册。取消任一确认都不提交角色。
104. **同一角色在多个 chunk 中信息被覆盖或重复。** 同名候选合并互补事实，已有作者字段优先。
105. **固定字符分块切断段落或 Unicode surrogate pair。** 优先在邻近段落边界切分；硬边界保护 surrogate pair。
106. **提取结果夹杂散文或多个 JSON。** 只接受裸完整 JSON 或一个完整 fence；非 JSON、散文围栏、多围栏和截断结果拒绝。
107. **知识检索把字符拆成 `%a%b%c%` 且先 limit 后 rank。** 现在按 Unicode 字母/数字/连字符分词、去重、小写、OR LIKE；全部 lexical match 排序后再 topK，显式 `knowledgeQueryHint` 优先。
108. **日志缺少当前应用版本和候选过程。** Bottom Panel 日志显示运行版本、候选预览、确认动作和安全错误。

### 6.8 Agent 工具供应商兼容

109. **SiliconFlow 返回 `<tool_call><name>list_chapters</name><arguments>{}</arguments></tool_call>`，旧解析器丢弃并结束。** 增加只针对显式 tool_call、已注册 name 和严格 JSON arguments 的兼容。
110. **SiliconFlow 又返回 `<tool_call><read_blueprint></read_blueprint></tool_call>`。** 只兼容显式 wrapper 内唯一、已注册、无属性、无内容、无嵌套的空工具标签，并映射为 `{}`；未知、带属性、非空和需要参数但缺参数的调用继续拒绝。
111. **普通散文尾部看似 JSON 时被误执行。** whole-response 要求保持；散文尾部 JSON 即使命名已注册写工具也必须惰性。
112. **工具失败把中文后端错误暴露给英文用户。** UI 使用冻结 locale 的安全错误，模型 observation 使用 writing language，原始错误只进入内部诊断。

## 7. GitHub #185、#187、#191 的准确状态

| Issue | GitHub 状态（2026-09-05） | 当前实现结论 | 不应做的表述 |
| --- | --- | --- | --- |
| #185 `创作增强-导入大纲设定` | OPEN | 实现了本地规划材料导入、FTS-only、外发披露、角色候选预览/二次确认、原子名册合并、角色搜索和日志增强 | 仅推送审查分支，不能写成已合并或已发布；本轮不关闭 |
| #187 `最大输出 Tokens` | OPEN；维护者评论“已在 1.0.0 修复” | 用户要求已修则忽略。本轮没有建立独立 #187 补丁；现有 bounded completion、审稿 replacement、蓝图 split/compact 和正文重写覆盖同类症状 | 不能写成“本轮独立复现并关闭 #187” |
| #191 `根据文本自动生成人物卡` | OPEN | 由 #185 的规划材料提取纵向切片覆盖：候选预览、二次确认、原子 merge、保留作者字段 | 不能让普通正文自由猜角色；是否关闭由维护者后续决定 |

本轮按用户要求没有处理 #185、#187、#191 之外的新 GitHub Issue，也不修改 Issue 状态。

## 8. 当前代码验证证据

### 8.1 自动化和静态门禁

实现提交对应的工作树已经通过：

- 单元测试：588/588 suites；2343 tests 中 2334 passed、0 failed、9 skipped；
- 浏览器测试：80/80 suites，239/239 tests；
- `pnpm run typecheck`；
- `pnpm run check:i18n`；
- `pnpm run lint`；
- `git diff --check`；
- Windows production build 和原生依赖验证；
- 独立固定基线 review：无 P1/P2，唯一 P3 重复注释已删除；
- 最终 ZIP 独立复核：无 P1/P2/P3。

两次完整单测曾分别触发 60ms release-monitor 时序波动和首次 Vite optimizer 冷启动超时；对应单文件复跑通过。最终使用四 workers 的完整 run 全绿。审查者应区分环境时序波动与功能失败，不要通过放宽业务断言来消除波动。

这些是实现提交形成前、源代码内容相同的工作树证据，不是 GitHub CI 对远端 SHA 的证明。推送后应查看远端 checks；pending 必须仍标 pending。

### 8.2 中文真实四章流程

使用隔离项目和真实在线模型完成：

- 四章：2324、2312、2823、2401，总计 9860 个中文正文单位；
- 8 个角色、4 个蓝图；
- 剧情树存在且可解析；
- 审稿 8 条、修订 4 次、合并 4 次；
- 四章定稿和后处理全部成功；
- failed LLM calls 为 0；
- 相邻章节最大 exact reuse 为 5、10、8。

### 8.3 英文真实四章流程

使用隔离项目和真实在线模型完成：

- 四章：2337、2253、2161、2374 words，总计 9125 words；
- 四章 Han ratio 均为 0；
- 7 个角色、4 个蓝图；
- 剧情树存在、长度 4956、可解析；
- 相邻章节最长 exact reuse 为 15、23、23，重复完整句为 0；
- 8 条审稿、4 次修订、4 次合并；
- 4 个 finalization outbox 均为 published；
- 4 次后处理共 12 个步骤全部成功；
- 58 次 LLM call 全部成功。

### 8.4 视觉、日志和 Windows 运行

真实 UI 逐层检查覆盖：首页、项目、小说、角色列表、角色图谱、架构、蓝图、剧情树、任务、日志、模型、设置、Agent、审稿、修订、合并和定稿。英文 shell 除用户自定义供应商名称和“中文”切换项外没有非预期中文。角色图谱实测单节点可独立移动。stale recent project 可移除且不删除磁盘内容。页面错误、失败请求和可见终端窗口均为 0。

最终 Windows ZIP：

- 7-Zip 完整性通过；
- 1012 files + 47 folders；
- 唯一根目录 `win-unpacked`；
- 无重复、绝对、反斜杠或 `..` 越界 entry；
- EXE PE subsystem 为 2；
- package native bindings 可加载；
- ZIP 中 EXE/app.asar 与完成真实验收的构建完全同哈希。

## 9. 隐私、仓库卫生和禁止提交内容

实现提交形成前，对准备上传的 222 个文件扫描四个真实 credential 值和本机路径标记，命中为 0。最终 ZIP 另以五项真实敏感值扫描，命中为 0。

以下内容不得进入 Git：

- `.runtime/**`、`release/**`、`dist/**`、`dist-electron/**`、`node_modules/**`；
- Electron userData、`AI_NOVEL_VELA_HOME`、模型配置、API Key、endpoint credential；
- 测试小说数据库、知识库、LanceDB、写作历史、真实模型 request/response；
- 用户提供的 TXT/EPUB、临时截图、聊天附件和绝对本机路径；
- package-build、evidence、浏览器/单元 JSON 结果和 scratch owner marker；
- 浏览器运行自动生成但未被测试引用的 `src/**/__screenshots__/*.png`；
- 本机 `AGENTS.md`、`CONTEXT.md`、`.agents/`、`.codex/`、`.claude/`。

审查分支应只包含源代码、测试、必要静态夹具和可公开文档。本文只总结真实验收，不复制小说正文、请求体、响应体或密钥。

## 10. Astra 推荐审查顺序

### 10.1 冻结对象

- 确认 base=`48c3b8a...`、implementation=`5c6e73e...`。
- 确认 fresh checkout 干净。
- 检查完整 diff 和所有新文件，尤其不能漏掉 untracked-origin production files。

### 10.2 Session、权限与语言

优先审查：

- `src/shared/ipc-channels.ts`；
- `src/stores/project-store.ts`；
- `src/services/generation/generation-runtime.ts`；
- `src/services/agent/context-builder.ts`；
- `src/services/agent/tools/project-context.ts`；
- project-scoped Electron controllers。

证明 picker、export、Agent、workflow、plot tree、knowledge import 都携带同一冻结 lease；同路径重开和中途切换项目必须被拒绝。

### 10.3 Agent 工具协议

审查 `src/services/agent/agent-engine.ts` 和 tool registry：

- 注册表校验是否在执行前足够靠前；
- whole-response 要求是否阻止散文尾部 JSON；
- 空直接子标签是否仅接受唯一、无属性、无内容的已注册工具；
- 写工具确认是否不可绕过；
- 原始 provider error 是否只进内部诊断。

### 10.4 数据原子性与恢复

审查角色名册、蓝图范围提交、finalization/outbox、import receipt、角色同步和 plot-tree snapshot：

- 所有 item 验证后是否只提交一次；
- 后段失败是否可能留下未声明 partial facts；
- 提交后派生失败是否如实显示；
- stale/corrupt/legacy snapshot 是否符合保留规则；
- cancellation 在每个提交边界的文案和事实是否一致。

### 10.5 长文本与结构化输出

审查 `generate-draft.command.ts`、`bounded-completion.ts`、`structured-batch-executor.ts`、`directory.command.ts` 和 `review-chapter.command.ts`：

- 重试、split、repair、rewrite 的次数是否有界；
- 所有调用是否使用同一冻结 session；
- deterministic trim 是否只作用于安全描述；
- 正文是否从不盲截断；
- batch split 是否 exact coverage；
- 非 `stop` 终态是否绝不落盘。

### 10.6 #185/#191 数据外发

审查 `KnowledgeOverview.tsx`、`planning-material-workflow.ts`、`planning-material.command.ts`、`knowledge-service.ts`：

- 本地导入是否先于远端调用；
- 披露的文件、模型、endpoint、用途和实际请求是否一致；
- 取消是否零角色提交；
- 候选预览与第二次确认是否不可跳过；
- FTS-only 是否不会偷偷使用残缺向量；
- 大 corpus 先取全部 lexical matches 再 topK 的性能是否可接受。

### 10.7 图谱、i18n、更新与 Windows

- 角色图谱：缩放后的 world coordinate、节点 hit-test、DPI、边去重和可访问详情；
- 剧情树：来源核对、stale 保存、失败保留旧快照；
- i18n：初始渲染、热切换、运行时冻结、UI/writing language 组合；
- 更新：auto/manual 并发、失败不消费每日资格、Windows 显式下载、mac 固定地址、Toast 生命周期；
- Windows：搜索全部生产 `spawn/exec`，确认无可见 console 漏项。

### 10.8 测试价值和简化

测试很多是因为 diff 跨越项目 lease、持久化、外部模型、结构化协议和桌面进程边界。可以合并纯重复断言，但不要删除以下类别的代表性测试：

- session lease 和同路径重开；
- 原子提交、失败恢复和 cancellation；
- raw tool parser 的正反例；
- 中英文四种 UI/writing language 组合；
- `length/content_filter/cancelled/error`；
- 规划材料外发披露和二次确认；
- Windows child process、package native 和 PE subsystem；
- cross-chapter reuse 的拒绝与允许样本。

## 11. Astra 最应寻找的风险

以下不是已确认 Bug，而是下一轮 review 的高价值问题：

1. Agent raw tool parser 的注册校验和可见文本清理顺序；
2. 同一路径重开项目后的 lease 隔离；
3. structured batch split 后 exact coverage 与最终单次提交；
4. 蓝图提交成功、角色同步失败时的事实和 UI 状态；
5. 规划材料全量分块外发披露是否与实际完全一致；
6. FTS-only 与已有 LanceDB generation 的降级/重建规则；
7. 大 FTS corpus 全匹配再排序的性能；
8. n-gram 门禁在 motif-heavy 小说中的误报和语义重复漏报；
9. 超长正文 repair/rewrite 是否始终复用同一冻结 session；
10. 角色描述截短是否可能触及身份或关系事实；
11. 角色画布在非 100% DPI、缩放和平移组合下的坐标；
12. UI locale 与 writing language 的所有交叉组合；
13. UpdateNotifier、ActionToast 挂载/卸载/延后恢复竞态；
14. MCP 之外的生产 child process 是否全部隐藏窗口；
15. 安装态 Windows in-app upgrade 尚不能由 portable ZIP 证明；
16. 语义改写导致的时间线回退当前没有自动检测；
17. 长篇剧情树的有界均匀采样可能遗漏局部支线；
18. 群像项目虽然允许多个 protagonist，后续 prompt 是否仍隐含单主角。

## 12. 推荐验证命令

环境要求：Node.js 20+、pnpm 11.11.0。fresh checkout 首次验证：

```powershell
pnpm install --frozen-lockfile
pnpm run prepare:native-node
pnpm run typecheck
pnpm run check:i18n
pnpm run lint
pnpm test -- --maxWorkers=4
pnpm run test:browser
git diff --check 48c3b8a473da7d6d901ea087d13a32cd0e307f8a..5c6e73e522a4499d1c90d389b548e2906fe820ef
```

Windows package review另执行：

```powershell
pnpm run build:win-dir
pnpm run verify:win-package
```

Node 测试会把 `better-sqlite3` 准备为 Node ABI；之后启动 Electron 前应由 `pnpm dev` 的 `predev` 恢复 Electron ABI。不要把 ABI 切换误诊为业务回归。

## 13. 审查输出要求

Astra 应输出：

- 固定 base 和 reviewed head；
- Standards 与 Spec 两个维度；
- 每个 finding 的文件、行号、触发路径、用户影响和最小修复；
- 将确认 Bug、证据不足风险、文档腐化和测试缺口分开；
- 明确哪些命令真实运行、哪些证据只来自历史；
- 不修改 Issue、不推送修复、不创建 Release、不合并分支，除非维护者另行授权。

完成标准不是“读完本文”，而是：审查者能解释项目事实边界，逐一覆盖第 10 节审查面，核对第 5–7 节台账与当前代码是否一致，并对第 11 节每项给出已排除、已确认或仍未知的结论。
