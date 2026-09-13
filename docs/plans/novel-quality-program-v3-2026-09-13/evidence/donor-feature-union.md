> 计划输入证据：下文是独立调查原始意见，不是实施指令或运行通过结论；Program v3合同/Spec与用户最新要求优先。donor占位备份的旧建议已由本版B01/B02真实功能要求替代。

# Donor 功能并集清单与 Program v3 修订建议

日期：2026-09-13  
范围：沿用上一轮 `frontend-source-audit.md` 的版本/源码比较，只补读 donor 四份 UI handoff 与其已审具体实现。未运行 donor Electron、模型、正式测试或真实项目；“源码能力”仅指实现链存在，不代表运行通过。

## 结论

用户的新边界应写成：**Writer 是默认且完整的主入口，必须承载“最新生产旧能力 ∪ donor 已实际实现的新能力”；Classic 是兼容回退，不得被当成补齐 Writer 缺口的第二步。** 头像是必须保留并修好的产品功能，不是可删装饰。

donor 的真实增量远多于壳和 CSS。它包含书架真实统计/跨项目速览、六道工序状态、统一标签与栏目路由、沉浸写作、实时 Markdown 预览与中文输入修复、头像、关系图、保存状态呈现、定稿/失败状态呈现、外观设置等。另一方面，disabled 备份、demo 的卷/冲突数/“续写 38%”与世界词条并不是已实现功能；“全部保留”不要求把占位或愿景临时开发成新系统。

## 证据分级

- **A：源码能力**：有实际组件/store/算法/IPC或持久化消费链；本轮未做运行验证。
- **B：源码能力但有已知阻断**：功能不能删，但必须修缺陷后才可进入 Writer 默认。
- **C：旧业务能力的新呈现**：不是第二业务实现；必须继续调用最新共享 command/store/IPC。
- **D：占位/愿景**：无有效 handler、数据源或产品合同，不能计作功能完成。

四份 handoff 是贡献者声明，不能单独作为 PASS；下列判定同时使用了实际源文件。

## donor 已实际开发的功能增量

| ID | 实际能力 | 级别 | 源码证据与必须保留的行为 | 已知缺陷/整合边界 |
| --- | --- | --- | --- | --- |
| N01 | Writer v2 外壳与即时 Classic/Writer 切换 | A/C | `src/stores/ui-version-store.ts:10-80`、`src/App.tsx:227-303`、`src/components/layout/v2/ShellV2.tsx:10-87`。Writer 默认，颜色主题、图片背景、界面壳三轴独立；两壳复用同一 sidebar/editor/AI/bottom 业务节点。 | 按 Program C10 迁移为明确 appearance owner；默认不能覆盖作者明确选择，切壳不能丢 dirty/IME/undo/运行任务。 |
| N02 | 墨纸书斋完整壳层、书脊导航、标题栏、面板/Portal/四主题适配 | A/C | `UI-REDESIGN-HANDOFF.md:327-342` 列出 `src/styles/redesign/**`、书架、正文、侧栏、设置、面板、对话框的唯一入口；`AppearanceSettings.tsx:107-235` 同时暴露四颜色、壳版本及 classic/anime/custom 图片背景。 | 纯样式可移植，但真实按钮必须继续走最新 handler；不能把 `SkinId=classic` 与 Classic 壳合并成一个字段。 |
| N03 | 统一标签容器与栏目路由 | A | `editor-store.ts:16,139-140` 新增 knowledge/relationship-graph tab；`rail-routing.ts:24-171` 映射书架/项目/人物/知识/世界/剧情树/蓝图；`EditorArea.tsx:643-920` 接入；`EditorTabStripV2.tsx:41-107` 提供未保存点、关闭、前后页与已打开列表。 | 标签 ID 必须沿用既有 canonical ID；Writer 不能把旧页面藏在 Classic，也不能在切项目时先清 dirty tab。 |
| N04 | 沉浸写作 | A | `layout-store.ts:40-42,129-180` 与 `EditorTabStripV2.tsx:103-107`：收拢目录和助手，显式打开侧栏/助手会退出沉浸态。 | 只改变布局；不得卸载业务 surface、取消任务、清候选或丢未发送助手输入。 |
| N05 | 当前项目真实统计与书架项目速览 | B | `useProjectOverview.ts:181-362` 从 draft/角色/架构/蓝图/伏笔/正文读取统计；`:435-478` 调用 `project:peek-overview`；`WelcomePageV2.tsx:145-230` 单击预览、再次进入；`ipc-channels.ts:365-372`→`project-controller.ts:713-723`→`electron/services/project-peek.ts:92-170` 有真实跨进程链。 | 必须保留“点哪本看哪本”的真实数据能力，但不能保留当前风险实现：仍读 `.vela/vela.db`；readonly 失败后 `project-peek.ts:76-86` 回退普通可写打开；IPC 接受任意 renderer path；`useProjectOverview.ts:320-430` 仍持久化含绝对路径/正文尾句的 `vela:overview:*`。应改为 canonical、授权 recent-project capability、真正只读/隔离的聚合查询，旧私密缓存只迁移/清理，不作为新事实源。 |
| N06 | 六道工序 FlowStages | B | `useProjectOverview.ts:279-294` 派生配置/架构/蓝图/草稿/审稿/定稿；`FlowStages.tsx:11-74` 显示真实项目进度和每段用途，优先于仅表示当前运行任务的状态。 | 当前只要“任一章”出现草稿/审稿/定稿就把整阶段标为“已完成”，容易误导长篇作者。保留工序条，但把 started/count/complete 语义与全书完成标准分开，不能显示假完成。 |
| N07 | CodeMirror 实时 Markdown 预览/纸页页眉/首字下沉 | B | `live-preview.ts` 用 Decoration 隐藏标记、保留光标行标记、渲染页眉与首字；`CodeMirrorEditor.tsx:7,122-190` 接入并将字数统计防抖。 | 功能不能因性能问题被整体关闭。`UI-REDESIGN-HANDOFF.md:359-404` 仍记录定稿页顶部纸色层未解决、首字下沉未最终确认；F05 需用真实 Writer DOM/长短中文稿验证。 |
| N08 | 中文 IME、选区、缩进、字体与打字手感修复 | A/B | `UI-REFINEMENT-HANDOFF.md:25-43,92-99`；`CodeMirrorEditor.tsx:153-190` 以稳定 ref 避免父渲染重建编辑器；live-preview 在 composition 中不重建；写作/UI 字体变量打通，行内缩进字符只由一个来源隐藏。 | 这是 donor 的实质编辑体验，不是可选 CSS。20 万字 Markdown 解析仍约 31ms/键（handoff `:141-143`）；不得以隐藏实时预览或切 Classic 作为 PASS，需按冻结性能协议修到门内或 NO-GO。 |
| N09 | 保存按钮恒驻、dirty/已保存状态、失败反馈 | B | `DraftEditor.tsx:180-239,680-694`、`NovelConfigEditor.tsx:85-112,190-211`、`ChapterCardEditor.tsx:396-428,797-814,1101-1105`、`ArchFileViewer.tsx:474-504`。donor 将“按钮消失”改为 dirty 时“保存”、干净时“已保存”，并保持按钮宽度稳定。 | 保存状态必须保留，但现状并非完整：`DraftEditor` 在 IPC 失败时抛错却没有本地 catch/明确失败反馈；部分页面只写日志。Writer 验收必须区分 saving/saved/failed，失败保持 dirty 且可重试；可以保持按钮不抖，但不能用“毫秒级”理由隐藏失败或误报已保存。 |
| N10 | 角色头像（选择预览→角色保存后提交→读取/删除）及压缩 | B | `use-character-avatar.ts:50-211`、typed channels `ipc-channels.ts:140-162`、controller `character-avatar-controller.ts:178-335`；`avatar-image.ts:18-77` 使用 Electron nativeImage 将最长边压至 256，PNG 保 PNG，其余转 JPEG 82，解码/压缩失败保留原图。图谱通过 `use-character-avatars.ts:7-91` 读取全员头像。 | 必须保留全部行为并修：旧 `.vela/avatars`、姓名 hash key、先写文件再 DB 可能孤儿、删除角色未回收、全员 N 次 IPC。按 F03/M05 改为稳定 character_id、canonical 项目资产、可恢复提交/孤儿清单、批量读取或有界窗口，并迁移原字节/引用；不得删头像规避。 |
| N11 | 新关系图视图 | A/B | `relationship-graph.ts:57-244` 实现 BFS/重要度/五档布局；`RelationMap.tsx:159-761` 实现点角色换中心、节点拖动、空白平移、滚轮缩放、复位、头像、可折叠人物简介和打开档案；`RelationsEditor.tsx:27-124` 以独立 tab 接同一角色事实源。 | 保留 v2 新图与原关系编辑/AI设定；图布局不得写回事实。删除全部角色与“重置布局”必须严格分开。千人图仍是全节点+N头像IPC，需有高规模有界性能/降密度而不丢角色入口。 |
| N12 | 人物档案阅览态/编辑态、来源标注、角色卡导入 | A/C | `UI-REDESIGN-HANDOFF.md:353-355`；`UI-MERGE-1.1.0-REPORT.md:71-80,93-96`。人物页先阅览再编辑，作者输入/定稿派生/未知来源可见；CharacterCardImportButton 在人物工具栏及架构人物页。 | 必须消费最新 S08/S09 稳定 ID、provenance 和导入隔离；不能从 donor 复制旧角色事实层。 |
| N13 | AI 输出、工作流状态与定稿印章的新呈现 | A/C | `UI-REDESIGN-HANDOFF.md:25-35,159-175`：Writer 下 finalization 成功/处理中用印章，失败展开可重试卡；AIOutputPanel 保留步骤、失败重试、恢复候选三操作、思维链、流式正文、中止与历史。`UI-MERGE...:63-69,99` 还保留续批入口、跨项目提示、失败码标签和完整任务标题。 | 印章只是状态投影，不能把 pending/失败显示为已定稿；所有动作仍走最新 S05/S06/S11 command。 |
| N14 | 页面与设置的实际交互完善 | A/C | `UI-REFINEMENT-HANDOFF.md:10-23` 修设置宽度/越界与架构卡状态；`SettingsModal.tsx:42-73,207-208,1040-1168,1215-1391` 保留模型、Prompt、Skill、代理、字体、行为、外观；`AppearanceSettings.tsx:107-235` 提供三层外观控制。 | 不是“只看得见”：F05 必须从 Writer 的两个设置入口进入、保存、关闭重开并验证共享状态/IPC。高级参数只验已支持矩阵，不发明任意 provider passthrough。 |
| N15 | 页面布局/状态语义改良 | A/C | PageHead 已用于配置、蓝图、剧情树、架构、审稿、版本、知识库；审稿“待核实”、逐项事件/证据、版本“来源已过期”、大纲起止章、完整通知标题均在 `UI-MERGE...:44-108` 列明并有对应生产组件。 | 这些既包含 donor 呈现，也包含 v1.1.0/最新上游语义；选择性移植必须保留语义，不能只移皮肤。 |

## donor 树中必须保留的最新/上游能力

这些不是 Writer 新造的第二套逻辑，但位于 donor 合并成果中，覆盖式移植最容易丢失：

- 角色状态 provenance、审稿 `unverified`、逐项事件核对与正文证据、角色卡导入、版本来源过期、大纲 from/to、完整工作流标题（`UI-MERGE-1.1.0-REPORT.md:89-108`）。
- 章节材料来源边界、连续批次使用真实已保存候选、预算覆盖缺口、update queue、split Markdown 目录清理、审稿格式一次预算内重建、规划损坏时缩小批次恢复（同文件 `:101-108`）。
- 当前生产树更新于 donor 基底之后的 world-building 候选恢复/冲突拒写与 `synopsisForDraftChapter` 必须三方合并；上一轮源码审计已在 `frontend-source-audit.md:34-40` 定位。Writer 新按钮必须接这些最新入口，而不是 donor 的旧 command。

## 不是“已实现新功能”的内容

| 内容 | 判定 | 计划处置 |
| --- | --- | --- |
| 标题栏“备份” | D。`TitleBarV2.tsx:249-255` 明确 `disabled` 且 `onClick={() => undefined}`。 | 从发布 UI 移除 disabled 占位；不计缺功能，也不借机新建备份系统。 |
| “第2卷·疑云”“设定0冲突”“续写38%” | D。handoff `UI-REDESIGN...:67-75` 明确 demo 无数据/硬编码。 | 保留 donor 已做的真实替代：计划章数、蓝图数、当前章字数比例。 |
| 结构化“世界词条卡” | D。`UI-REFINEMENT...:145` 明确产品没有该功能。 | 不纳入本轮；保留现有 world-building Markdown/知识库能力。 |
| 千人关系图“只画相关的人” | D/待开发。`UI-RELATION-MAP...:197-199` 明确未做。 | 不宣称已有；但 Writer 默认前必须给现有图谱设性能/可达入口门，不能靠删头像或删图谱规避。 |
| 其余“下一步美化候选” | D。是审美 backlog，不是当前可用能力。 | 不纳入“全部功能已保留”的完成计数。 |

## “旧能力 ∪ donor 实际能力”不可删减验收矩阵

建议将下表固化为机器可读 `donor-feature-union.json`。每行至少含 `id/sourceKind/requiredInWriter/classicExpectation/productionEntry/sharedHandlerOrCommand/ipc/persistedOutcome/errorOutcome/evidenceLevel`。**Writer 行只能由 Writer 实际入口通过；Classic 的成功不可代填。**

| 门 | Writer 默认入口必须通过 | Classic 兼容要求 | 最低证据 |
| --- | --- | --- | --- |
| U01 项目生命周期 | 新建/打开/最近/书架预览→进入/导入/删除/重开；切项目先保存/放弃/取消 | 原入口不倒退，同一 transition coordinator | 实际 Electron 按钮→handler/IPC；dirty 正文/角色/配置/ledger 与失败注入 |
| U02 外观与壳 | Writer 为 release default；四主题、图片背景、字体、缩放、Classic 回切均在 Writer 设置可达 | 显式 Classic 保留且不改作者其他偏好 | storage hydration + 重开；不能把默认写成作者选择 |
| U03 配置/模型/Prompt/Skill | 两个 Writer 设置入口可达；模型发现、支持参数、Prompt、Skill 安装/绑定/冻结、代理与失败反馈齐全 | 旧入口继续调用同一 store/IPC | Writer 实际按钮→typed IPC→持久结果；不支持参数 fail closed |
| U04 架构与恢复 | 配置→世界观→大纲 from/to/续批；最新 world-building 候选恢复/冲突拒写完整 | 同一 command 语义 | production entry + fixture；真实模型仍受原 80 帽 |
| U05 蓝图/正文/批量 | 单章和批量蓝图、两种批量写作、停止/失败边界、按章 synopsis 上下文 | 同一 workflow/run owner | Writer 按钮→shared command→candidate/persisted outcome |
| U06 编辑体验 | 实时预览、页眉、首字下沉、准确拖选/undo、中文 IME、缩进、写作字体、长短文性能 | Classic 原编辑能力不倒退 | 真实 CodeMirror/中文 composition；3000/200000 单位冻结性能协议 |
| U07 标签/路由/沉浸 | 所有业务页在统一 tab 可达；栏目高亮同步；沉浸进出不丢状态 | 不要求复制 Writer 布局创新，但旧页面必须可达 | Writer browser + Electron；tab ID、dirty点、前后页/列表 |
| U08 书架/进度 | 当前项目真实统计、另一本项目授权只读速览、FlowStages 不假报完成 | Classic 无需同版书架，但项目数据不得被 Writer 预览改变 | canonical read-only IPC、零写证明、旧/未知库降级、无正文/绝对路径缓存 |
| U09 角色 | 导入、阅览/编辑、provenance、稳定ID、作者确认提议 | 旧角色编辑/导入可用 | Writer按钮→S08/S09事实源；姓名碰撞/项目切换 |
| U10 头像 | choose预览不写、保存后commit、压缩、读取/替换/删除、重开、迁移、图谱显示 | Classic 至少可查看/编辑同一头像资产 | Writer真实文件入口+M05故障注入+稳定ID；不得写 `.vela` |
| U11 关系图 | 五档、换中心、拖节点、平移、缩放/适应、侧栏/档案、重置布局、删除角色严格区分 | 原关系编辑与Classic图可用，同一事实源 | Writer实际交互；布局零事实写入；高角色数有界 |
| U12 审稿/审修 | 维度选择→审稿→unverified/证据→人工确认→修稿→no-op/合并→定稿 | 同一 S11 finding/revision | Writer production entry；失败/过期/冲突保持候选 |
| U13 状态/恢复反馈 | AI输出流、失败码、重试/续批/恢复候选、中止/历史、印章 pending/success/failure准确 | 经典状态信息不减少 | 实际状态机，不以静态截图或 mock 冒充 |
| U14 保存反馈 | dirty/saving/saved/failed 不误报；失败保持内容/dirty并可重试；快捷键与退出保存一致 | 同一 save owner | 每类编辑器至少一次成功/失败/并发修改；DraftEditor无未捕获拒绝 |
| U15 历史/知识/导出 | 版本来源过期、知识库、merged/split/txt、split目录修复均在 Writer 可达 | 旧格式/入口兼容 | Writer按钮→最新服务→实际产物；不加头像附件/备份格式 |

## 对现有 Spec 的最小修订

### F03：头像必须从“可保留资产”升级为“Writer 必需功能”

1. 把 N10/U10 全部写为 MUST，不允许“若迁移困难则移除头像”。保留 choose 不落盘、角色保存后 commit、格式/魔数/4MB、256px 压缩与失败保留原图、替换/删除/重开、人物档案和关系图消费。
2. 继续使用现有 M05 方向修缺陷：稳定 `character_id`、canonical 资产路径、S04 staging-only、文件/DB 可恢复提交、旧引用与原字节保全、孤儿清单和删除回收。
3. 增加批量头像读取/有界窗口接口或等价缓存，避免关系图对千人执行 N 次 IPC；不得为性能删除头像。F03 仍不改正文导出，也不发明备份格式。

### F04：拥有 Writer 功能并集接线，而不只是“页面外观接入”

1. 将 N03–N09、N11–N15 和 U01–U15 中的 Writer UI 行写进强制交付；每行标 `requiredInWriter=true`，并登记 production entry、共享 command/store/IPC 与持久/失败结果。
2. 保留真实书架统计与跨项目速览，但替换 `.vela`/任意路径/普通可写 fallback/私密 localStorage 快照：使用迁移后的 canonical locator、recent-project grant/capability 和真正只读聚合；读取失败显示 unavailable，不摆假数字、不改目标项目。
3. 修正 FlowStages 的 started/count/complete 语义；修 DraftEditor 等保存失败反馈；保持统一 BusinessSurface，覆盖项目/壳切换 dirty、IME、undo、未发送助手输入。
4. Writer 的所有旧主流程入口都必须补齐；“Classic 中可用”只能是兼容证据，不能关闭 Writer 缺口。donor-only UI 组件可以复用，业务 store/command/IPC 不复制。

### F05：从“两壳大致等价”改为“Writer 完整主入口 + Classic 兼容”

1. 消费冻结的 union manifest，缺任何 `requiredInWriter` 行即 Preflight NO-GO；不能隐藏功能、disabled、跳转 Classic 或调用测试 API 代替 Writer 按钮。
2. 对共享业务能力做两壳 outcome parity；对 Writer 专属交互（书架速览、FlowStages、统一标签、沉浸、新关系图呈现）要求 Writer 自身完整，通过 Classic 旧布局不要求逐像素复制。
3. 每个行保存 `writerEntry → handler/store → IPC/command → persisted/error outcome` 证据等级。renderer-only 只能证明 DOM；项目速览、头像、保存、恢复、生成、审修必须到实际 Electron/生产入口，模型门仍沿用原 80 次/18章/同 subjectSha 规则。
4. Writer default activation 仍在完整 Preflight 后，激活后的同 integration SHA 做 Final 与 post-UI early 三门；后续修 N05/N06/N09/N10 等相关入口会使旧资格失效。

## 是否需要新增 Spec

**推荐不新增业务 Spec。** F03 已是头像 owner，F04 已是共享页面/编辑器/项目切换 owner，F05 已是默认准入与覆盖 owner。新增另一业务节点反而会制造 `EditorArea`、layout store、项目 IPC 和设置页的共享所有权冲突。

最小新增物只有一份由 S00 冻结、F04 填写、F05验收的机器可读 `donor-feature-union.json`，不是新框架。若主集成者因 F04 工量必须拆片，只允许新增一个**测试/证据片**，拥有 union fixture/runner、不得拥有生产业务文件；生产文件 owner 仍分别归 F03/F04/原 Sxx。

## 可直接写入计划的硬句子

> Writer 是新安装与无明确壳偏好的默认完整入口。所有最新生产能力和 donor 已实际实现的功能必须在 Writer 自身可发现、可操作并通过对应生产入口验收；Classic 的存在或通过不得代替 Writer 缺失。不得通过隐藏按钮、disabled、删头像/图谱/速览/实时预览、要求用户切回 Classic 或建立第二套业务 store/command/IPC 来满足完成门。占位和纯 demo 愿景不计为已实现功能，也不自动扩成本轮新系统。
