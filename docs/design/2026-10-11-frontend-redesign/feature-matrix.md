# 前端重设计功能保全矩阵

本文盘点 1.2.2-Preview 渲染进程中用户可触达的功能与操作，供重设计的每个实施切片和审查者核对“没有丢功能”。前五列只记录 1.2.2-Preview 的现状，不含修改建议；RD-10 收尾时在每张表最后加了「新位置」一列，写明纸墨外壳里的规范入口与验证截图（截图在 `review/RD-10-matrix-*.png`，都在 RD-10 的最终构建 `8e519bc1` 上由 `drive.mjs` 的场景拍摄，场景跑通才算这个入口能完成）。随聊天隐藏的 9 项写明去向，不配截图。

## 范围与约定

- 基线：分支 `claude/frontend-redesign`，基于 `origin/master` `9c00fe56`。「当前入口」列的行号取自这个基线的源码；RD-10 删除旧外壳后，其中很多文件已不在当前源码里。
- 只看根目录 `src/`；未看 `Frontend-1.1.0/`。
- 已知问题见 `docs/research/ux-audit-1.2.2-preview-20261011/` 的 `README.md`（UX-01～07）、`design-redundancy.md`（UX-08～26）和 `req-hide-ai-chat.md`。
- 入口写法：不带前缀的路径相对 `src/components/`；以 `src/` 开头的路径相对仓库根。同一功能的不同入口（不同位置、右键、快捷键、自动触发）之间用“；”分隔；同一界面内的多个控件用“，”分隔。
- “待核”表示源码读到了入口，但实际行为没有实机验证。
- 备注里单独写的 `:NNN` 指同一行第一个被引用的文件；复核脚本不覆盖这类简写。
- 任务里提到的 `DiffViewer` 在当前源码中不存在；三方对比只有 `editor/ThreeWayMerge.tsx`。

## 1. 项目管理

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-001 | 新建项目（打开新建对话框） | layout/TitleBar.tsx:275；pages/v2/WelcomePageV2.tsx:47；src/App.tsx:233（⌘N/Ctrl+N）；panels/sidebar/ProjectTree.tsx:197；panels/sidebar/HomeSidebarPanel.tsx:83 | 无 | 顶栏叫“新建”，首页叫“新建作品”。ProjectTree 与 HomeSidebarPanel 两处实际不可见，见文末 (c) | 书房开始卡「新建作品」、空书房主按钮、Ctrl N、Ctrl K「新建作品」、作品菜单「新建作品…」；[RD-10-matrix-library-empty](review/RD-10-matrix-library-empty.png)、[RD-10-matrix-library-current](review/RD-10-matrix-library-current.png) |
| F-002 | 新建项目对话框：作品名称、保存位置“选择”、创建/取消 | dialogs/NewProjectDialog.tsx:96，dialogs/NewProjectDialog.tsx:107 | 对话框已打开 | 保存位置走系统文件夹选择 | 纸墨「新建作品」对话框：作品名、保存位置「选择」、创建作品、取消；[RD-10-matrix-new-work](review/RD-10-matrix-new-work.png) |
| F-003 | 打开项目（选文件夹） | layout/TitleBar.tsx:279；layout/TitleBar.tsx:247（顶栏项目名按钮）；pages/v2/WelcomePageV2.tsx:48；src/App.tsx:236（⌘O/Ctrl+O）；panels/sidebar/ProjectTree.tsx:204；panels/sidebar/HomeSidebarPanel.tsx:90 | 无 | 顶栏项目名按钮的 title 是“切换项目”，行为与“打开”相同 | 书房开始卡「打开作品」、Ctrl O、Ctrl K「打开作品」、作品菜单「打开其他作品…」；[RD-10-matrix-library-current](review/RD-10-matrix-library-current.png)、[RD-10-matrix-palette](review/RD-10-matrix-palette.png) |
| F-004 | 书架：预览最近项目概览 | pages/v2/WelcomePageV2.tsx:62（书名按钮 onPreview） | 首页；有最近项目 | 预览走 `project:peek-overview`，不正式打开（pages/v2/use-project-overview.tsx:84） | 书架点封面 → 右侧概览（只读，不打开作品）；[RD-10-matrix-library-preview](review/RD-10-matrix-library-preview.png) |
| F-005 | 书架：进入最近项目 | pages/v2/WelcomePageV2.tsx:62（“进入作品”）；panels/sidebar/HomeSidebarPanel.tsx:123 | 有最近项目 | HomeSidebarPanel 不可见 | 概览「打开《书名》」、双击封面、书本菜单「打开作品」、书房里 Ctrl K「打开《书名》」；[RD-10-matrix-library-preview](review/RD-10-matrix-library-preview.png) |
| F-006 | 从最近项目移除（带确认） | panels/sidebar/HomeSidebarPanel.tsx:139 | 有最近项目 | 唯一入口在不可见的 HomeSidebarPanel，书架上没有此操作，见 (c) | 书本菜单「从最近项目移除…」→ 纸墨确认（只删记录，文件留在原处）；[RD-10-matrix-library-remove](review/RD-10-matrix-library-remove.png) |
| F-007 | 删除当前项目（带确认，危险） | pages/v2/WelcomePageV2.tsx:54；panels/sidebar/HomeSidebarPanel.tsx:67 | 已打开项目，且首页未处于预览其他书的状态 | 共用 project-delete-action.ts:7 的确认。危险操作常驻首页（UX-13） | 当前作品书本菜单危险分组「删除作品…」→ 输入作品名后才能确认的危险确认；[RD-10-matrix-library-delete](review/RD-10-matrix-library-delete.png) |
| F-008 | 作品概览：统计、阶段进度、摘录 | pages/v2/WelcomePageV2.tsx:56 | 首页 | 只读展示 | 书房右侧概览：阶段进度、正文字数、定稿章节、角色、最近写下的一段；[RD-10-matrix-library-preview](review/RD-10-matrix-library-preview.png)、[RD-10-matrix-library-current](review/RD-10-matrix-library-current.png) |
| F-009 | 继续写作（从首页进入项目视图） | pages/v2/WelcomePageV2.tsx:59 | 已打开项目 | 只切换到项目侧栏视图 | 当前作品概览主按钮「继续写作 · 下一步」、书本菜单「回到作品」；[RD-10-matrix-library-current](review/RD-10-matrix-library-current.png) |
| F-010 | 导入旧项目副本 | pages/v2/WelcomePageV2.tsx:49 | 首页 | 只在首页；执行中按钮禁用并显示提示（:52） | 书房「导入」菜单「导入旧项目副本…」、空书房文字按钮；进行中禁用并在书房显示提示条；[RD-10-matrix-import-menu](review/RD-10-matrix-import-menu.png)、[RD-10-matrix-library-empty](review/RD-10-matrix-library-empty.png) |
| F-011 | 首页入口（回到写作书房） | layout/LeftToolWindowBar.tsx:104；updates/UpdateNotifier.tsx:44（更新提示“查看更新”） | 无 | 左栏标签“首页”，title 叫“欢迎页” | 顶栏作品菜单「回到书房」、Ctrl K「回到书房」；书房更新卡「查看更新」；[RD-10-matrix-library-current](review/RD-10-matrix-library-current.png) |
| F-012 | 清除项目生成内容（打开对话框，危险） | panels/sidebar/ProjectTree.tsx:257 | 已打开项目；工作流运行中禁用 | 按钮文案“清除全部”，对话框标题“清除项目生成内容”（UX-13） | 作品菜单危险分组「清除生成内容…」；[RD-10-matrix-clear](review/RD-10-matrix-clear.png) |
| F-013 | 清除对话框：勾选范围（故事架构与大纲、章节蓝图、草稿定稿与审稿产物）并“清除所选” | dialogs/ClearProjectDataDialog.tsx:33，dialogs/ClearProjectDataDialog.tsx:225 | 对话框已打开 | Esc 与点遮罩可关闭（:96、:128），清除中不可关 | 清除对话框：三类勾选、清除所选（标准危险确认；清除中不可关闭）；[RD-10-matrix-clear](review/RD-10-matrix-clear.png) |
| F-014 | 项目树刷新 | panels/sidebar/ProjectTree.tsx:269 | 已打开项目 | 另有蓝图、架构、知识库、角色各自的刷新按钮 | 不再有统一的项目树刷新：各页自带读取与刷新（角色名单底栏「刷新列表」、架构「刷新状态」、蓝图「重新加载蓝图」、知识库刷新），流程脊随工作流与保存自动重读；[RD-10-matrix-cast](review/RD-10-matrix-cast.png)、[RD-10-matrix-architecture](review/RD-10-matrix-architecture.png) |

## 2. 小说设定

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-015 | 打开小说配置 | panels/sidebar/ProjectTree.tsx:291；panels/sidebar/ProjectTree.tsx:297（右键“打开小说配置”）；panels/EditorArea.tsx:192（打开项目时自动打开） | 已打开项目 | 切换项目时会重新激活该项目的配置标签 | 流程脊「设定」→ 设定页；[RD-10-matrix-setup](review/RD-10-matrix-setup.png) |
| F-016 | 编辑配置字段：写作语言、类型、细分类型、受众、故事结构、叙事视角、总章数、每章字数 | editor/NovelConfigEditor.tsx:220，editor/NovelConfigEditor.tsx:263，editor/NovelConfigEditor.tsx:305 | 配置标签 | 故事结构、叙事视角带提示（tipItems） | 设定页首屏：核心大纲、类型、篇幅、目标读者，写作语言在大纲卡底；细分类型、故事结构、叙事视角等在「更多设定」；[RD-10-matrix-setup](review/RD-10-matrix-setup.png) |
| F-017 | 沉寂提醒阈值与“恢复默认值” | editor/NovelConfigEditor.tsx:342，editor/NovelConfigEditor.tsx:358 | 配置标签 | 排在核心大纲之前（UX-03） | 设定页「更多设定 · 高级」：沉寂提醒阈值与恢复默认值；[RD-10-matrix-setup](review/RD-10-matrix-setup.png) |
| F-018 | 编辑核心大纲、世界观、金手指、主角人设、全局写作要求、文风、参考作品 | editor/NovelConfigEditor.tsx:380，editor/NovelConfigEditor.tsx:456 | 配置标签 | 无 | 设定页核心大纲与「更多设定」里世界观、金手指、主角人设、全局写作要求、文风、参考作品各面板；[RD-10-matrix-setup](review/RD-10-matrix-setup.png) |
| F-019 | 单字段“AI 生成”（6 个字段各一个） | editor/NovelConfigEditor.tsx:515 | 配置标签；任一字段生成中时全部禁用 | 字段：:383、:394、:405、:416、:427、:443 | 核心大纲卡与各长字段面板的「AI 生成」；[RD-10-matrix-setup-fill](review/RD-10-matrix-setup-fill.png) |
| F-020 | AI 填充配置（打开生成配置对话框） | editor/NovelConfigEditor.tsx:205 | 配置标签 | 无 | 设定页底栏「AI 补全其余设定」；[RD-10-matrix-setup-fill](review/RD-10-matrix-setup-fill.png) |
| F-021 | 生成配置对话框：规模参数、创作脑洞、一键生成；已有内容时二次确认“继续扩写” | dialogs/GenerateConfigDialog.tsx:289；dialogs/GenerateConfigDialog.tsx:270（⌘/Ctrl+Enter）；dialogs/GenerateConfigDialog.tsx:102 | 对话框已打开 | 快捷键只在脑洞输入框内生效 | 「AI 补全其余设定」以核心大纲为脑洞、篇幅为规模；已有作者内容时纸墨确认扩写（不再弹重复的脑洞表单）；[RD-10-matrix-setup-fill](review/RD-10-matrix-setup-fill.png) |
| F-022 | 保存小说配置 | editor/NovelConfigEditor.tsx:209 | 配置标签 | 此页没有 ⌘S（⌘S 只在 CodeMirror 内生效，见 F-187） | 设定页 Ctrl S、底栏「保存」，「下一步：故事架构」先保存；失败时底栏提示可再保存；[RD-10-matrix-setup-save-fail](review/RD-10-matrix-setup-save-fail.png) |

## 3. 故事架构

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-023 | 打开故事架构总览 | layout/LeftToolWindowBar.tsx:144（左栏“世界”）；panels/sidebar/ProjectTree.tsx:369 | 已打开项目 | 左栏叫“世界”，title 叫“世界观”，打开的是“故事架构”（UX-02、UX-14） | 流程脊「架构」→ 架构阶段页（四节卡片）；[RD-10-matrix-architecture](review/RD-10-matrix-architecture.png) |
| F-024 | 展开/折叠架构子项 | panels/sidebar/ProjectTree.tsx:374 | 项目树 | 源码注释写“双击展开”，实际是箭头按钮单击 | 架构阶段页四节卡片常显，不再需要展开折叠；[RD-10-matrix-architecture](review/RD-10-matrix-architecture.png) |
| F-025 | 打开单个架构文档（前提、角色图谱、世界观、情节大纲） | panels/sidebar/ProjectTree.tsx:470；panels/sidebar/ProjectTree.tsx:476（右键“打开文件”）；editor/WorldBuildingEditor.tsx:539（卡片） | 已打开项目 | 3 处入口 | 每节卡片「编辑」或「自己写」打开该节文档标签；角色名单一节「打开角色名单」「查看角色名单全文」；[RD-10-matrix-architecture](review/RD-10-matrix-architecture.png) |
| F-026 | 复制架构文件路径 | panels/sidebar/ProjectTree.tsx:483 | 项目树右键 | 路径是内部 `ai-novel://` 伪路径 | 按设计不再提供文件路径入口（ia.md：不暴露物理路径） |
| F-027 | 清空单个架构项（危险，带确认） | panels/sidebar/ProjectTree.tsx:493（右键）；panels/sidebar/ProjectTree.tsx:520（悬停垃圾桶） | 该项已生成；角色图谱项不提供 | 确认文案见 :440 | 每节「更多操作」危险分组「清空此节…」→ 危险确认；[RD-10-matrix-arch-clear](review/RD-10-matrix-arch-clear.png) |
| F-028 | AI 生成架构（打开架构确认对话框） | editor/WorldBuildingEditor.tsx:488；editor/ArchFileViewer.tsx:652（单文档“AI 生成/AI 重新生成”） | 已打开项目 | 同一对话框两处宿主（editor/WorldBuildingEditor.tsx:784、editor/ArchFileViewer.tsx:764） | 架构页头主按钮「AI 生成架构」、页头更多「AI 生成架构…」、每节「AI 生成此节…」；[RD-10-matrix-arch-generate](review/RD-10-matrix-arch-generate.png) |
| F-029 | 架构确认对话框：全选、逐步勾选、大纲章节范围、每章大纲目标字数、作者指导展开、确认 | dialogs/ArchitectureConfirmDialog.tsx:246，dialogs/ArchitectureConfirmDialog.tsx:261，dialogs/ArchitectureConfirmDialog.tsx:378，dialogs/ArchitectureConfirmDialog.tsx:421 | 对话框已打开 | 已生成项标“将覆盖/保留” | 纸墨「生成架构」对话框：全选、逐节勾选（覆盖已确认的节会标出）、章节范围、每章大纲字数、作者指导；[RD-10-matrix-arch-generate](review/RD-10-matrix-arch-generate.png) |
| F-030 | 刷新架构生成状态 | editor/WorldBuildingEditor.tsx:479 | 故事架构标签 | 无 | 架构页头更多「刷新状态」；[RD-10-matrix-architecture](review/RD-10-matrix-architecture.png) |
| F-031 | 架构单文档：从磁盘重新加载 | editor/ArchFileViewer.tsx:609 | 架构文档标签 | 无 | 架构文档标签「重新读取」；[RD-10-matrix-arch-rewrite](review/RD-10-matrix-arch-rewrite.png) |
| F-032 | 架构单文档：编辑并保存 | editor/ArchFileViewer.tsx:621；editor/CodeMirrorEditor.tsx:538（⌘S） | 架构文档标签；角色图谱项只读 | 角色图谱是投影（editor/ArchFileViewer.tsx:750 `editable={!isCharacterProjection}`） | 架构文档标签编辑，Ctrl S 保存；[RD-10-matrix-arch-rewrite](review/RD-10-matrix-arch-rewrite.png) |
| F-033 | 角色图谱：放弃旧草稿并加载投影 | editor/ArchFileViewer.tsx:720 | 角色图谱存在旧草稿时 | 条件出现 | 角色名单全文标签（「查看角色名单全文」）里「放弃旧草稿并加载投影」；[RD-10-matrix-architecture](review/RD-10-matrix-architecture.png) |
| F-034 | 修复角色名单（roster repair） | editor/ArchFileViewer.tsx:635；editor/WorldBuildingEditor.tsx:742 | 角色图谱可修复时 | 按钮文案来自 rosterPresentation，状态相关 | 角色名单全文标签里的修复角色名单；[RD-10-matrix-architecture](review/RD-10-matrix-architecture.png) |
| F-035 | 旧角色修复恢复：复制原文与候选、恢复原运行、明确重新开始、取消原运行 | editor/LegacyRosterRecoveryPanel.tsx:48，editor/LegacyRosterRecoveryPanel.tsx:49，editor/LegacyRosterRecoveryPanel.tsx:50，editor/LegacyRosterRecoveryPanel.tsx:51 | 有保存的旧修复运行 | 挂在 editor/WorldBuildingEditor.tsx:763 角色卡片内 | 架构页角色名单一节内的旧修复恢复面板：复制原文与候选、恢复原运行、重新开始、取消原运行；[RD-10-matrix-architecture](review/RD-10-matrix-architecture.png) |
| F-036 | 架构未完成候选：查看/收起候选、复制 | editor/WorldBuildingEditor.tsx:618，editor/WorldBuildingEditor.tsx:630 | 存在未完成候选 | 无 | 半途停下的节卡片：「查看未完成候选」「收起候选」「复制」；[RD-10-matrix-architecture](review/RD-10-matrix-architecture.png) |
| F-037 | 架构断点续写；情节大纲“编辑恢复稿” | editor/WorldBuildingEditor.tsx:642 | 存在可恢复候选 | 同一按钮按状态切换文案 | 节卡片「断点续写」；情节大纲「编辑恢复稿」；[RD-10-matrix-architecture](review/RD-10-matrix-architecture.png) |
| F-038 | 情节大纲：断点续写大纲、续批（第 N 章起） | editor/WorldBuildingEditor.tsx:685，editor/WorldBuildingEditor.tsx:709 | 大纲部分完成 | 只在架构总览的大纲卡片上 | 情节大纲卡「断点续写大纲」；对不上时「选章节范围生成…」；[RD-10-matrix-arch-rewrite](review/RD-10-matrix-arch-rewrite.png) |
| F-039 | 大纲恢复稿：设定保存到第几章、继续生成缺少的章节 | editor/ArchFileViewer.tsx:668，editor/ArchFileViewer.tsx:677 | 打开大纲恢复稿标签 | 恢复稿保存只写本地 | 情节大纲恢复稿标签：设定保存到第几章、继续生成缺少的章节；[RD-10-matrix-arch-rewrite](review/RD-10-matrix-arch-rewrite.png) |

## 4. 章节蓝图

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-040 | 打开章节蓝图 | layout/LeftToolWindowBar.tsx:134（左栏“蓝图”）；panels/sidebar/ProjectTree.tsx:319；panels/sidebar/ProjectTree.tsx:325（右键） | 已打开项目 | 左栏“蓝图”英文为 Plot（UX-14） | 流程脊「蓝图」→ 蓝图阶段页（左侧章节规划，右侧单章蓝图）；[RD-10-matrix-blueprint](review/RD-10-matrix-blueprint.png) |
| F-041 | AI 生成蓝图（打开目录配置对话框） | editor/ChapterCardEditor.tsx:920 | 蓝图标签 | 紧邻“清空全部蓝图”（UX-13） | 蓝图页头「AI 生成蓝图」（没有可写的章时为主按钮）；[RD-10-matrix-blueprint-overwrite](review/RD-10-matrix-blueprint-overwrite.png) |
| F-042 | 目录配置对话框：范围模式（前 N 章/指定范围/全部）、每章目标字数、追加或覆盖、确认 | dialogs/DirectoryConfigDialog.tsx:418，dialogs/DirectoryConfigDialog.tsx:437，dialogs/DirectoryConfigDialog.tsx:466，dialogs/DirectoryConfigDialog.tsx:512，dialogs/DirectoryConfigDialog.tsx:553 | 对话框已打开 | 覆盖模式会在 editor/ChapterCardEditor.tsx:751 二次确认 | 纸墨「AI 生成蓝图」对话框：范围、每章字数、追加或覆盖；覆盖先经危险确认；[RD-10-matrix-blueprint-overwrite](review/RD-10-matrix-blueprint-overwrite.png) |
| F-043 | 目录对话框：继续第 N 章起的剩余范围 | dialogs/DirectoryConfigDialog.tsx:361 | 存在已提交的部分范围 | 条件出现 | 生成蓝图对话框里的提示条「继续第 a～b 章」；[RD-10-matrix-blueprint-overwrite](review/RD-10-matrix-blueprint-overwrite.png) |
| F-044 | 目录对话框：重试角色同步 | dialogs/DirectoryConfigDialog.tsx:400 | 角色同步失败时 | 条件出现 | 生成蓝图对话框里的提示条「重试角色同步」；[RD-10-matrix-blueprint-overwrite](review/RD-10-matrix-blueprint-overwrite.png) |
| F-045 | 手动新建章节蓝图 | editor/ChapterCardEditor.tsx:930 | 蓝图标签；数据就绪 | 图标按钮“+” | 「更多蓝图操作」→ 新建章节；[RD-10-matrix-blueprint](review/RD-10-matrix-blueprint.png) |
| F-046 | 重新加载蓝图 | editor/ChapterCardEditor.tsx:927 | 蓝图标签 | 无 | 「更多蓝图操作」→ 重新加载蓝图；[RD-10-matrix-blueprint](review/RD-10-matrix-blueprint.png) |
| F-047 | 清空全部章节蓝图（危险，带确认） | editor/ChapterCardEditor.tsx:936 | 蓝图标签 | 确认见 :703 | 「更多蓝图操作」危险分组「清空全部蓝图…」→ 危险确认；[RD-10-matrix-blueprint](review/RD-10-matrix-blueprint.png) |
| F-048 | 选择章节蓝图 | editor/ChapterCardEditor.tsx:1035 | 蓝图标签 | 列表项显示“已有作者指导/章节要点”标记 | 左侧章节规划（标记为图标并带可访问名称，另显示该章正文进度）；[RD-10-matrix-blueprint](review/RD-10-matrix-blueprint.png) |
| F-049 | 编辑单章字段：标题、定位、出场人、冲突与转折、悬念钩子、作者微操指导、章节要点 | editor/ChapterCardEditor.tsx:1123 | 已选中一章 | 章节号只读（:1119） | 单章蓝图：标题、定位、出场人物、主角小目标、冲突与转折、悬念钩子、作者微操指导、章节要点；[RD-10-matrix-blueprint](review/RD-10-matrix-blueprint.png) |
| F-050 | 保存单章；保存全部 | editor/ChapterCardEditor.tsx:1103，editor/ChapterCardEditor.tsx:944 | 有改动（保存全部只在 dirty 时出现） | 头部重复显示“未保存”（UX-16） | 「保存此章」、「更多蓝图操作」→ 保存全部、Ctrl S；未保存只在顶栏提示；[RD-10-matrix-blueprint](review/RD-10-matrix-blueprint.png) |
| F-051 | 删除此章（危险，带确认） | editor/ChapterCardEditor.tsx:1099 | 已选中一章 | 紧邻“写作此章”（UX-13） | 单章「更多操作」危险分组「删除此章…」→ 危险确认；[RD-10-matrix-blueprint](review/RD-10-matrix-blueprint.png) |
| F-052 | 清除误导入正文 | editor/ChapterCardEditor.tsx:971 | 检测到旧版误导入时 | 条件出现，确认见 :803 | 检测到误导入正文时的提醒条 → 危险确认；[RD-10-matrix-blueprint](review/RD-10-matrix-blueprint.png) |
| F-053 | 蓝图恢复稿：编辑恢复稿 | editor/ChapterCardEditor.tsx:888；panels/AIOutputPanel.tsx:363 | 存在蓝图恢复候选 | 两处入口 | 蓝图页提示条「编辑恢复稿」；运行侧页的可恢复项；[RD-10-matrix-blueprint-recovery](review/RD-10-matrix-blueprint-recovery.png) |
| F-054 | 蓝图恢复稿标签：保存恢复蓝图、继续生成缺少的章节、查看原始候选 | editor/ChapterCardEditor.tsx:208，editor/ChapterCardEditor.tsx:209，editor/ChapterCardEditor.tsx:213 | 打开恢复稿标签 | 编辑区是 CodeMirror（:215） | 蓝图恢复稿纸墨页（RD-10）：保存恢复蓝图、继续生成缺少的章节、查看原始候选；[RD-10-matrix-blueprint-recovery](review/RD-10-matrix-blueprint-recovery.png) |

## 5. 章节写作与草稿

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-055 | 写作下一章（打开章节创作对话框） | editor/ChapterCardEditor.tsx:899（“写作第 N 章”）；editor/ChapterCardEditor.tsx:1093（“写作此章”） | 存在可写蓝图 | UX-09 写章节多入口 | 蓝图页头拆分主按钮「写第 N 章」，箭头打开写作弹层；[RD-10-matrix-write-popover](review/RD-10-matrix-write-popover.png) |
| F-056 | 定稿后自动打开下一章创作对话框 | src/App.tsx:154 | 设置“定稿后打开下一章”已开；单章定稿（批量不触发）；下一章有蓝图且无草稿 | 开关见 F-166 | 定稿后按设置「定稿后打开下一章」落到下一章并弹出写作弹层；[RD-10-matrix-write-popover](review/RD-10-matrix-write-popover.png) |
| F-057 | 章节创作对话框：本次模型、章节号、标题、目标字数、定位、出场角色、目的、关键事件、作者指导、知识库检索关键词、开始创作 | dialogs/ChapterCreationDialog.tsx:430，dialogs/ChapterCreationDialog.tsx:456，dialogs/ChapterCreationDialog.tsx:537，dialogs/ChapterCreationDialog.tsx:575 | 对话框已打开 | 字段与蓝图重复（UX-05） | 写作弹层：本次模型、作者微操指导、更多里的检索关键词；章号、标题、定位等取自蓝图，字数取设定的每章字数；[RD-10-matrix-write-popover](review/RD-10-matrix-write-popover.png) |
| F-058 | 一致性预检：保存安排、撤销安排、修改后重检、仅本次忽略并继续 | dialogs/ConsistencyPreflightPanel.tsx:48，dialogs/ConsistencyPreflightPanel.tsx:60，dialogs/ConsistencyPreflightPanel.tsx:68，dialogs/ConsistencyPreflightPanel.tsx:69 | 预检发现线索时 | 两处宿主：dialogs/ChapterCreationDialog.tsx:547、dialogs/BatchChapterCreationDialog.tsx:460 | 写作弹层与批量创作对话框里的一致性预检块；[RD-10-matrix-preflight](review/RD-10-matrix-preflight.png) |
| F-059 | 批量创作（打开对话框） | editor/ChapterCardEditor.tsx:909 | 存在可写蓝图 | 最多 10 章 | 蓝图页头「批量创作」；[RD-10-matrix-blueprint-batch](review/RD-10-matrix-blueprint-batch.png) |
| F-060 | 批量创作对话框：起始章、章数、完成模式（草稿待审/自动定稿）、模型、启动 | dialogs/BatchChapterCreationDialog.tsx:307，dialogs/BatchChapterCreationDialog.tsx:357，dialogs/BatchChapterCreationDialog.tsx:405，dialogs/BatchChapterCreationDialog.tsx:487 | 对话框已打开 | 自动定稿需二次确认（:492）；启动后自动打开底部任务（:261） | 纸墨「批量创作」对话框；启动后运行侧页出现批量卡；[RD-10-matrix-blueprint-batch](review/RD-10-matrix-blueprint-batch.png) |
| F-061 | 生成草稿后自动打开新草稿标签 | src/services/workflows/commands/generate-draft.command.ts:1306 | 单章草稿生成完成 | 自动行为 | 写完的草稿在这一章的标签里顶替待写视图；[RD-10-matrix-chapter-draft](review/RD-10-matrix-chapter-draft.png) |
| F-062 | 草稿箱：展开/折叠、按章展开、显示已归档 | panels/sidebar/DraftBoxGroup.tsx:57，panels/sidebar/DraftBoxGroup.tsx:150，panels/sidebar/DraftBoxGroup.tsx:186 | 已打开项目 | 空状态提示去蓝图“写作此章”（:80） | 章节头版本切换器「显示已归档」；[RD-10-matrix-chapter-draft](review/RD-10-matrix-chapter-draft.png) |
| F-063 | 打开草稿 | panels/sidebar/DraftBoxGroup.tsx:327；panels/sidebar/DraftBoxGroup.tsx:333（右键） | 有草稿 | 审稿、修稿、定稿入口只在打开具体草稿后出现（UX-04） | 流程脊章节列表、章节头版本切换器、Ctrl P 查找章节；[RD-10-matrix-chapter-draft](review/RD-10-matrix-chapter-draft.png) |
| F-064 | 复制草稿路径 | panels/sidebar/DraftBoxGroup.tsx:340 | 草稿右键 | 内部伪路径 | 按 ia.md 改为「复制本章正文」（不暴露物理路径）；[RD-10-matrix-chapter-draft](review/RD-10-matrix-chapter-draft.png) |
| F-065 | 删除这一稿（危险，带确认） | panels/sidebar/DraftBoxGroup.tsx:348（右键）；panels/sidebar/DraftBoxGroup.tsx:372（悬停） | 有草稿 | 确认见 :262 | 单章「更多操作」→「删除这一稿…」→ 危险确认；[RD-10-matrix-chapter-delete](review/RD-10-matrix-chapter-delete.png) |
| F-066 | 草稿编辑与保存 | editor/DraftEditor.tsx:689；editor/CodeMirrorEditor.tsx:538（⌘S） | 草稿未定稿、未归档、章节不忙 | 定稿/归档后只读（:808） | 单章视图纸面正文，Ctrl S 保存；[RD-10-matrix-chapter-draft](review/RD-10-matrix-chapter-draft.png) |
| F-067 | 正文章节：展开、打开 | panels/sidebar/ManuscriptGroup.tsx:283；panels/sidebar/ManuscriptGroup.tsx:353；panels/sidebar/ManuscriptGroup.tsx:359（右键） | 有定稿章节 | 无 | 流程脊点定稿章 → 定稿视图（只读原文）；[RD-10-matrix-chapter-finalize](review/RD-10-matrix-chapter-finalize.png) |
| F-068 | 复制正文路径 | panels/sidebar/ManuscriptGroup.tsx:366 | 正文右键 | 无 | 按 ia.md 改为「复制本章正文」；[RD-10-matrix-chapter-finalize](review/RD-10-matrix-chapter-finalize.png) |
| F-069 | 删除正文（危险，带确认） | panels/sidebar/ManuscriptGroup.tsx:374（右键）；panels/sidebar/ManuscriptGroup.tsx:387（悬停） | 有定稿章节 | 确认在 panels/sidebar/finalized-chapter-deletion.ts:141 | 定稿视图「更多操作」→「删除正文…」→ 纸墨危险确认；[RD-10-matrix-chapter-finalize](review/RD-10-matrix-chapter-finalize.png) |
| F-070 | 正文删除未完成：重试清理/确认人工核对并继续 | panels/sidebar/ManuscriptGroup.tsx:327 | 有中断的删除操作 | 条件出现 | 这一章待写视图的提示条：重试清理、确认人工核对并继续；[RD-10-matrix-cleanup-retry](review/RD-10-matrix-cleanup-retry.png) |
| F-071 | 实体正文文件编辑与保存 | panels/EditorArea.tsx:131；editor/CodeMirrorEditor.tsx:538（⌘S） | 打开非 `ai-novel://` 路径的章节 | 待核：正文章节以 `ai-novel://manuscript/` 打开，走 DraftEditor（panels/sidebar/sidebar-file-openers.ts:140），此分支的实际可达路径未找到 | ai-novel://manuscript/ 进定稿视图（只读）；[RD-10-matrix-chapter-finalize](review/RD-10-matrix-chapter-finalize.png) |
| F-072 | 恢复候选正文标签编辑与保存 | panels/EditorArea.tsx:639 | 从恢复候选“继续编辑”打开 | 标注“不会自动写入正式草稿” | 恢复候选纸墨正文页：编辑与保存（RD-10，替换旧编辑器标签）；[RD-10-matrix-candidate-page](review/RD-10-matrix-candidate-page.png) |
| F-073 | 选区 AI 操作：润色、扩写、续写、对话；预览后替换/取消；继续原运行 | editor/CodeMirrorEditor.tsx:675，editor/CodeMirrorEditor.tsx:636，editor/CodeMirrorEditor.tsx:628，editor/CodeMirrorEditor.tsx:622 | 在可编辑 CodeMirror 中选中文字 | 草稿、正文、架构文档、恢复稿都有；无独立菜单入口 | 正文选区的纸墨选区工具条：润色、扩写、续写、对话；预览后替换或取消；继续原运行；[RD-10-matrix-chapter-selection](review/RD-10-matrix-chapter-selection.png) |
| F-074 | 选区加粗（Markdown） | editor/CodeMirrorEditor.tsx:649 | document 模式（架构文档、蓝图恢复稿）选中文字 | 只在 document 模式 | document 模式选区工具条的加粗；[RD-10-matrix-chapter-selection](review/RD-10-matrix-chapter-selection.png) |

## 6. 审稿/修稿/定稿

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-075 | AI 审稿（确认对话框含检查维度勾选） | editor/DraftEditor.tsx:776，editor/DraftEditor.tsx:912，editor/DraftEditor.tsx:964 | 打开可编辑草稿 | 工具栏顺序为修稿、审稿、定稿（UX-21） | 章节动作条拆分按钮「AI 审稿」，箭头勾检查维度；[RD-10-matrix-chapter-review](review/RD-10-matrix-chapter-review.png) |
| F-076 | 审稿完成后自动打开审稿报告标签 | src/services/workflows/commands/review-revision-command.ts:194 | 审稿成功 | 自动行为 | 审稿完成后审稿侧页展开（收起跟着工作流弹出的运行侧页）；[RD-10-matrix-chapter-review](review/RD-10-matrix-chapter-review.png) |
| F-077 | 打开最新审稿报告 | editor/DraftEditor.tsx:752 | 该草稿已有审稿报告 | 显示“审稿报告(N)” | 已审稿时侧页默认展开；「更多操作」→「审稿报告」；[RD-10-matrix-chapter-review](review/RD-10-matrix-chapter-review.png) |
| F-078 | 审稿报告：颜色说明 | editor/ReviewReport.tsx:941 | 报告标签 | 无 | 审稿侧页「标记说明」；[RD-10-matrix-chapter-review](review/RD-10-matrix-chapter-review.png) |
| F-079 | 审稿清单逐项：分类、严重度、问题、相关原文编辑；纳入/忽略；不修改此项；移除人工问题 | editor/ReviewReport.tsx:1104，editor/ReviewReport.tsx:1182，editor/ReviewReport.tsx:1200，editor/ReviewReport.tsx:1214 | 清单未确认或处于编辑 | 无 | 审稿侧页逐条意见：勾选纳入、编辑、不修改此项、移除我的意见；[RD-10-matrix-chapter-review](review/RD-10-matrix-chapter-review.png) |
| F-080 | 新增人工问题、总体修稿指导 | editor/ReviewReport.tsx:1286，editor/ReviewReport.tsx:1273 | 清单编辑中 | 无 | 审稿侧页「添加我的意见」与折叠的「总体修稿指导」；[RD-10-matrix-chapter-review](review/RD-10-matrix-chapter-review.png) |
| F-081 | 确认审稿清单；编辑已确认清单 | editor/ReviewReport.tsx:1291，editor/ReviewReport.tsx:1311 | 报告已关联草稿 | 未关联时提示（:1299） | 章节动作条「按 N 项意见修稿」确认清单；已确认后在侧页继续编辑；[RD-10-matrix-chapter-review](review/RD-10-matrix-chapter-review.png) |
| F-082 | 按确认意见修稿（选模型、开始修稿） | editor/ReviewReport.tsx:1322，editor/ReviewReport.tsx:1469，editor/ReviewReport.tsx:1512 | 清单已确认 | 与 F-083 是两条不同工作流 | 「按 N 项意见修稿」主按钮，箭头选本次模型；[RD-10-matrix-chapter-review](review/RD-10-matrix-chapter-review.png) |
| F-083 | AI 修稿（直接修稿，可附加要求） | editor/DraftEditor.tsx:764，editor/DraftEditor.tsx:964 | 打开可编辑草稿 | 与 F-082 名称相近、流程不同 | 「更多操作」→「直接修稿…」（可附加要求）；[RD-10-matrix-chapter-review](review/RD-10-matrix-chapter-review.png) |
| F-084 | 修稿完成后自动打开合并标签 | src/services/workflows/commands/review-revision-command.ts:205 | 修稿成功且待合并 | 自动行为，EditorArea 以对话框渲染（panels/EditorArea.tsx:759） | 修稿完成后摆出合并视图；[RD-10-matrix-chapter-merge](review/RD-10-matrix-chapter-merge.png) |
| F-085 | 打开待合并修稿 | editor/DraftEditor.tsx:739 | 存在待合并修稿 | 显示“待合并(N)” | 待合并时自动摆出最新一份；过期修稿提示条「查看修稿」或丢弃；[RD-10-matrix-chapter-merge](review/RD-10-matrix-chapter-merge.png) |
| F-086 | 三方合并：逐块切换、全部原稿、全部修稿、编辑合并结果、完成合并、取消 | editor/ThreeWayMerge.tsx:431，editor/ThreeWayMerge.tsx:372，editor/ThreeWayMerge.tsx:373，editor/ThreeWayMerge.tsx:376，editor/ThreeWayMerge.tsx:375 | 合并对话框已打开 | 两处宿主：editor/DraftEditor.tsx:1010、panels/EditorArea.tsx:792；Esc 与点外部不关闭（panels/EditorArea.tsx:779） | 合并视图逐段用原稿、用修稿或手动编辑；全部用原稿、全部用修稿、完成合并、稍后再合并；[RD-10-matrix-chapter-merge](review/RD-10-matrix-chapter-merge.png) |
| F-087 | 重试合并后复验 | editor/ReviewReport.tsx:1011 | 合并后复验失败 | 条件出现 | 审稿侧页「重试合并后复验」；[RD-10-matrix-recheck](review/RD-10-matrix-recheck.png) |
| F-088 | 定稿（危险，带确认） | editor/DraftEditor.tsx:788 | 打开可编辑草稿 | 确认见 :362，定稿后只读 | 已修稿时主按钮「定稿」，其余在「更多操作」→ 定稿确认；[RD-10-matrix-chapter-finalize](review/RD-10-matrix-chapter-finalize.png) |
| F-089 | 重试实体稿发布 | editor/DraftEditor.tsx:726；editor/DraftEditor.tsx:815 | 定稿已提交、实体稿待发布 | 两处按状态出现 | 定稿视图后处理「正文文件 · 重新写入正文」；[RD-10-matrix-chapter-finalize](review/RD-10-matrix-chapter-finalize.png) |
| F-090 | 修复定稿（重试失败的后处理） | editor/DraftEditor.tsx:827 | 已定稿且后处理失败 | 条件出现 | 定稿视图「重试失败步骤」；[RD-10-matrix-chapter-finalize](review/RD-10-matrix-chapter-finalize.png) |
| F-091 | 后处理状态：展开、重试单步、重试失败步骤 | ui/PostProcessStatusPanel.tsx:181，ui/PostProcessStatusPanel.tsx:251，ui/PostProcessStatusPanel.tsx:283 | 已定稿草稿 | 挂在 editor/DraftEditor.tsx:842 | 定稿视图「定稿后处理」各步状态与「重试」；[RD-10-matrix-chapter-finalize](review/RD-10-matrix-chapter-finalize.png) |

## 7. 版本与回退

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-092 | 打开版本历史 | layout/LeftToolWindowBar.tsx:168（左栏“历史”） | 已打开项目（无项目时点击无反应） | 唯一入口 | 流程脊「作品资料 · 版本历史」；[RD-10-matrix-history](review/RD-10-matrix-history.png) |
| F-093 | 选择章节查看版本列表 | editor/VersionHistory.tsx:237 | 版本历史标签 | 无 | 版本历史左列章节、中列时间线；[RD-10-matrix-history](review/RD-10-matrix-history.png) |
| F-094 | 与当前版本对比 | editor/VersionHistory.tsx:301 | 有历史版本 | 打开 `diff` 标签，复用“修稿合并”对话框（editor/VersionHistory.tsx:141）。待核：该标签没有 revisionPath，“完成合并”不写入也不关闭（panels/EditorArea.tsx:811） | 版本历史右列只读差异视图；[RD-10-matrix-history](review/RD-10-matrix-history.png) |
| F-095 | 回退到此版本（创建回滚草稿） | editor/VersionHistory.tsx:308 | 有历史版本 | 无确认；新建草稿，不覆盖原稿（:172） | 版本历史右列「回退到此版本…」，确认写明新建的版本号；[RD-10-matrix-history-revert](review/RD-10-matrix-history-revert.png) |

## 8. 剧情树与叙事线索

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-096 | 打开剧情树视图 | layout/LeftToolWindowBar.tsx:154（左栏“剧情”） | 已打开项目 | 与 F-097 同一编辑器，标题不同（UX-11） | 流程脊「剧情与伏笔」→ 剧情树；[RD-10-matrix-plot](review/RD-10-matrix-plot.png) |
| F-097 | 打开伏笔与叙事线索（计划清单视图） | panels/sidebar/ProjectTree.tsx:334 | 已打开项目 | 项目树此节点无右键菜单 | 剧情与伏笔页「伏笔线索」分段；[RD-10-matrix-threads](review/RD-10-matrix-threads.png) |
| F-098 | 编辑器内切换“剧情树/计划清单” | editor/NarrativeThreadEditor.tsx:836，editor/NarrativeThreadEditor.tsx:845 | 叙事线索标签 | 无 | 剧情与伏笔页头分段切换；[RD-10-matrix-plot](review/RD-10-matrix-plot.png) |
| F-099 | 剧情树：选模型、生成/刷新剧情树 | editor/PlotTreeView.tsx:94，editor/PlotTreeView.tsx:105 | 来源就绪 | 无 | 剧情树工具行模型下拉与主按钮；无快照时空状态主按钮；[RD-10-matrix-plot](review/RD-10-matrix-plot.png) |
| F-100 | 清除剧情树（危险） | editor/PlotTreeView.tsx:113 | 已有快照 | 无确认（editor/NarrativeThreadEditor.tsx:569） | 剧情树「更多 · 清除剧情树…」→ 危险确认；[RD-10-matrix-plot-clear](review/RD-10-matrix-plot-clear.png) |
| F-101 | 剧情树：上一组/下一组章节、选中事件、打开事件来源 | editor/PlotTreeView.tsx:146，editor/PlotTreeView.tsx:158，editor/PlotTreeView.tsx:219，editor/PlotTreeView.tsx:248 | 已有快照 | 无 | 剧情树工具行翻页、事件详情、「打开来源」；[RD-10-matrix-plot](review/RD-10-matrix-plot.png) |
| F-102 | 生成记录恢复：刷新记录、取消当前生成、恢复原生成、复制原结果、继续原运行、取消原运行、保存原剧情树 | editor/NarrativeThreadEditor.tsx:853，editor/NarrativeThreadEditor.tsx:854，editor/NarrativeThreadEditor.tsx:855，editor/NarrativeThreadEditor.tsx:864，editor/NarrativeThreadEditor.tsx:865，editor/NarrativeThreadEditor.tsx:866，editor/NarrativeThreadEditor.tsx:867 | 叙事线索标签 | 常驻在视图顶部 | 剧情树「更多 · 查看整理记录」；生成中或未保存时自动展开；[RD-10-matrix-plot](review/RD-10-matrix-plot.png) |
| F-103 | 新建/编辑叙事线索计划并保存 | editor/NarrativeThreadEditor.tsx:899，editor/NarrativeThreadEditor.tsx:907，editor/NarrativeThreadEditor.tsx:942 | 计划清单视图 | 无 | 伏笔线索「新建线索」、行菜单「编辑线索」；[RD-10-matrix-threads](review/RD-10-matrix-threads.png) |
| F-104 | 删除叙事线索计划（危险） | editor/NarrativeThreadEditor.tsx:944 | 有计划 | 无确认（:778） | 伏笔线索行菜单「删除线索…」→ 危险确认；[RD-10-matrix-thread-delete](review/RD-10-matrix-thread-delete.png) |
| F-105 | 确认定稿事件（埋设/推进/解决/放弃 + 证据 + 理由）并保存 | editor/NarrativeThreadEditor.tsx:943，editor/NarrativeThreadEditor.tsx:956 | 有定稿章节 | 无 | 伏笔线索行菜单「记录定稿里的变化」，右列表单；[RD-10-matrix-threads](review/RD-10-matrix-threads.png) |
| F-106 | AI 建议伏笔与线索；AI 识别定稿事件（候选对话框：选模型与蓝图章、生成候选、确认/拒绝候选、关闭） | editor/NarrativeThreadEditor.tsx:893，editor/NarrativeThreadEditor.tsx:957，editor/NarrativeThreadEditor.tsx:1036，editor/NarrativeThreadEditor.tsx:1016，editor/NarrativeThreadEditor.tsx:1027 | 有蓝图（建议）或定稿（识别） | 无 | 伏笔线索右列「AI 建议的伏笔」与「让 AI 识别」，候选就地确认或不采纳；[RD-10-matrix-threads](review/RD-10-matrix-threads.png) |

## 9. 角色

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-107 | 打开角色管理（侧栏列表 + 编辑区档案） | layout/LeftToolWindowBar.tsx:122（左栏“角色”） | 无 | 编辑区整页替换为角色档案（panels/EditorArea.tsx:449） | 架构页角色名单一节「打开角色名单」、Ctrl K「角色名单」→ 角色名单页（左名单右档案）；[RD-10-matrix-cast](review/RD-10-matrix-cast.png) |
| F-108 | 角色列表：搜索、选择、分页、刷新 | panels/sidebar/CharactersView.tsx:100，panels/sidebar/CharactersView.tsx:119，panels/sidebar/CharactersView.tsx:150，panels/sidebar/CharactersView.tsx:85 | 已打开项目 | 无 | 角色名单左栏：搜索、选择、分页、底栏「刷新列表」；[RD-10-matrix-cast](review/RD-10-matrix-cast.png) |
| F-109 | 新建角色 | panels/sidebar/CharactersView.tsx:88 | 数据就绪 | 无 | 角色名单左栏「新建角色」；[RD-10-matrix-cast](review/RD-10-matrix-cast.png) |
| F-110 | 编辑角色：头像（选择/替换、移除、取消更改）、姓名、性别、年龄、定位、外貌、性格、背景、能力、动机、关系网、成长轨迹、备注 | editor/CharacterEditor.tsx:372，editor/CharacterEditor.tsx:373，editor/CharacterEditor.tsx:374，editor/CharacterEditor.tsx:383，editor/CharacterEditor.tsx:403 | 已选中角色 | 关系网是自由文本，每行一位 | 档案「基础设定」：头像（选择/更换、移除、取消头像更改）、姓名、性别、年龄、定位、外貌、性格、背景、动机、能力、关系网、成长轨迹、备注；[RD-10-matrix-cast](review/RD-10-matrix-cast.png) |
| F-111 | 角色档案视图切换：基础设定/当前状态/关系图谱 | editor/CharacterEditor.tsx:243，editor/CharacterEditor.tsx:247，editor/CharacterEditor.tsx:251，editor/CharacterEditor.tsx:263 | 角色视图 | 当前状态档案含位置/阵营、关键道具、最近重要事件（editor/CharacterEditor.tsx:304） | 档案视图分段：基础设定、当前状态、关系图谱；[RD-10-matrix-cast](review/RD-10-matrix-cast.png)、[RD-10-matrix-graph](review/RD-10-matrix-graph.png) |
| F-112 | 保存角色；删除角色（危险，带确认） | editor/CharacterEditor.tsx:258，editor/CharacterEditor.tsx:254 | 已选中角色 | 确认见 :91 | 档案头部「保存角色」；「角色的更多操作」→「删除角色「名」…」→ 危险确认；[RD-10-matrix-cast](review/RD-10-matrix-cast.png) |
| F-113 | 删除全部角色与关系（危险，带确认） | editor/CharacterEditor.tsx:230 | 关系图谱视图 | 确认见 :152 | 「角色的更多操作」→「删除全部角色与关系…」→ 危险确认；[RD-10-matrix-cast](review/RD-10-matrix-cast.png) |
| F-114 | 关系图谱：缩放、适合视图、重置布局、折叠人物侧栏、滚轮缩放、拖拽、点击节点打开角色、搜索、以某人为中心、分页 | editor/RelationshipGraph.tsx:285，editor/RelationshipGraph.tsx:288，editor/RelationshipGraph.tsx:289，editor/RelationshipGraph.tsx:290，editor/RelationshipGraph.tsx:299，editor/RelationshipGraph.tsx:333，editor/RelationshipGraph.tsx:342，editor/RelationshipGraph.tsx:348，editor/RelationshipGraph.tsx:357 | 关系图谱视图 | 无 | 档案「关系图谱」视图：缩放、适合视图、重置布局、折叠人物侧栏、滚轮、拖拽、点人打开档案、搜索、以某人为中心、分页（1024 宽窗口下工具条不越出画布，RD-10）；[RD-10-matrix-graph](review/RD-10-matrix-graph.png) |
| F-115 | 粘贴/导入角色卡（粘贴文本、选择文件、清除文件、AI 提取并确认外发） | characters/CharacterCardImportButton.tsx:164；panels/sidebar/CharactersView.tsx:84；editor/ArchFileViewer.tsx:586 | 已配置默认模型；外发前确认（characters/CharacterCardImportButton.tsx:121） | 两处宿主；启动后自动打开底部任务（:137） | 角色名单左栏「粘贴 / 导入角色卡」：纸墨对话框，第二步外发确认；[RD-10-matrix-card-import](review/RD-10-matrix-card-import.png) |
| F-116 | 角色候选批量选择：对应已有角色/新建/暂不采用、编辑导入候选 | characters/CharacterProposalSelectionPanel.tsx:61，characters/CharacterProposalSelectionPanel.tsx:65 | 有角色提议批次 | 宿主：panels/WorkflowConfirmationPanel.tsx:57、characters/FinalizedCharacterProposalPanel.tsx:97 | 运行侧页「需要你确认」：批量选择角色采用方式、编辑导入候选；[RD-10-matrix-run-confirm](review/RD-10-matrix-run-confirm.png) |
| F-117 | 待处理角色决策：检查、接受、拒绝 | characters/FinalizedCharacterProposalPanel.tsx:91，characters/FinalizedCharacterProposalPanel.tsx:100，characters/FinalizedCharacterProposalPanel.tsx:99 | 定稿或导入产生角色决策 | 挂在 panels/sidebar/CharactersView.tsx:93 | 角色名单页顶上的提示条：定稿或导入角色决策「检查」、接受、拒绝；[RD-10-matrix-cast](review/RD-10-matrix-cast.png) |
| F-118 | 待处理角色状态建议：检查、接受、拒绝 | characters/FinalizedCharacterStateCandidatePanel.tsx:90，characters/FinalizedCharacterStateCandidatePanel.tsx:105，characters/FinalizedCharacterStateCandidatePanel.tsx:102 | 定稿产生状态建议 | 挂在 panels/sidebar/CharactersView.tsx:94 | 同一提示条：状态建议「检查」、接受、拒绝；[RD-10-matrix-cast](review/RD-10-matrix-cast.png) |

## 10. 知识库

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-119 | 打开知识库（侧栏已入库章节 + 编辑区总览） | layout/LeftToolWindowBar.tsx:122（左栏“小说”） | 无 | 左栏叫“小说”，打开的是知识库（UX-02） | 流程脊「作品资料 · 知识库」；[RD-10-matrix-kb](review/RD-10-matrix-kb.png) |
| F-120 | 侧栏：刷新、已入库章节分页 | panels/KnowledgePanel.tsx:151，panels/KnowledgePanel.tsx:210，panels/KnowledgePanel.tsx:218 | 已打开项目 | 只读列表 | 知识库刷新；「定稿章节」分段（滚动列表）；[RD-10-matrix-kb-finalized](review/RD-10-matrix-kb-finalized.png) |
| F-121 | 导入创作资料（导入后可确认外发提取角色卡） | pages/KnowledgeOverview.tsx:426 | 已打开项目 | 提取确认见 :373；提取启动后自动打开底部任务（:395）。UX-12 | 知识库左列「导入创作资料」，外发前确认写明模型与端点；[RD-10-matrix-kb](review/RD-10-matrix-kb.png) |
| F-122 | 清空知识库（危险，带确认） | pages/KnowledgeOverview.tsx:435 | 已打开项目 | 确认见 :301 | 知识库左列底部危险区 → 危险确认；[RD-10-matrix-kb](review/RD-10-matrix-kb.png) |
| F-123 | 知识库原文：打开、编辑项目副本、保存副本、更新本地全文索引 | pages/KnowledgeOverview.tsx:474，pages/KnowledgeOverview.tsx:485，pages/KnowledgeOverview.tsx:488，pages/KnowledgeOverview.tsx:489 | 有导入文档 | 切换文档时未保存会确认（:160） | 知识库中列：编辑项目副本、Ctrl S、「更新检索」，切换资料时未保存确认；定稿章节只读显示原文，副本改过还没更新检索时提示并给「更新检索」（RD-10，#391 第 1、2 项）；[RD-10-matrix-kb](review/RD-10-matrix-kb.png)、[RD-10-matrix-kb-finalized](review/RD-10-matrix-kb-finalized.png) |
| F-124 | 向量索引检查与重建（回填） | pages/KnowledgeOverview.tsx:549 | 已配置向量模型 | 文案由 rebuildPresentation 决定 | 设置「检索模型」页的检查与补全；知识库页提示「去设置补全」；[RD-10-matrix-index-model](review/RD-10-matrix-index-model.png) |
| F-125 | 语义检索：输入查询、Top K、检索、清除结果 | pages/KnowledgeOverview.tsx:600，pages/KnowledgeOverview.tsx:610，pages/KnowledgeOverview.tsx:616，pages/KnowledgeOverview.tsx:634 | 已打开项目 | 技术术语外露（UX-07） | 知识库右列查找：最多显示 5/10/20/50 条、清除；[RD-10-matrix-kb](review/RD-10-matrix-kb.png) |

## 11. 工作流运行与恢复

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-126 | 工作流启动时自动打开右侧“AI 输出” | src/stores/workflow-store.ts:672 | 任一工作流启动 | 首页时会先切到项目视图（src/stores/layout-store.ts:143） | 工作流启动时运行侧页「进行中」自动展开；[RD-10-matrix-run-live](review/RD-10-matrix-run-live.png) |
| F-127 | 打开“AI 输出”面板 | layout/RightToolWindowBar.tsx:67；layout/StatusBar.tsx:146（多任务“点击查看任务进度”）；layout/StatusBar.tsx:164（单任务胶囊）；layout/StatusBar.tsx:126（完成态胶囊）；src/App.tsx:150（完成 ActionToast“打开查看”）；panels/BottomPanel.tsx:362（“在 AI 输出中确认”） | 无 | 状态栏写“任务进度”却打开 AI 输出（UX-10）。再次点击右栏当前视图会收起面板（layout/RightToolWindowBar.tsx:30） | 顶栏运行胶囊、Ctrl K「运行侧页」、完成提示「打开查看」；[RD-10-matrix-run-live](review/RD-10-matrix-run-live.png) |
| F-128 | 工作流完成通知（ActionToast：打开查看/忽略） | src/App.tsx:138，ui/ActionToast.tsx:311，ui/ActionToast.tsx:312 | 当前项目的工作流完成 | 自动行为 | 纸墨提示栈的完成提示：「打开查看」落到历史并展开该运行；[RD-10-matrix-toasts](review/RD-10-matrix-toasts.png) |
| F-129 | AI 输出：多任务切换、当前生成、历史运行选择 | panels/AIOutputPanel.tsx:650，panels/AIOutputPanel.tsx:225，panels/AIOutputPanel.tsx:1172 | 有运行或历史 | 历史最多 10 条（:208） | 运行侧页「进行中」并列所有运行（等确认排前），「历史」分页逐条展开；[RD-10-matrix-run-live](review/RD-10-matrix-run-live.png) |
| F-130 | AI 输出：展开步骤输出 | panels/AIOutputPanel.tsx:811，panels/AIOutputPanel.tsx:1111 | 有输出 | 无 | 运行卡片步骤行展开：思考过程、输出、错误；[RD-10-matrix-run-live](review/RD-10-matrix-run-live.png) |
| F-131 | 工作流确认继续（含角色候选选择） | panels/WorkflowConfirmationPanel.tsx:70 | 工作流等待确认 | 底部任务面板只提供跳转（panels/BottomPanel.tsx:362） | 运行卡片确认区「需要你确认」：候选采用方式与主按钮；[RD-10-matrix-run-confirm](review/RD-10-matrix-run-confirm.png) |
| F-132 | 取消工作流 | panels/AIOutputPanel.tsx:739；panels/BottomPanel.tsx:337 | 活跃运行可取消 | 两处入口 | 运行卡片「取消」；[RD-10-matrix-run-cancel](review/RD-10-matrix-run-cancel.png) |
| F-133 | 暂停/继续批量创作 | panels/BottomPanel.tsx:304，panels/BottomPanel.tsx:319 | 批量创作运行中/已暂停 | 只在底部任务面板 | 批量运行卡片头部的暂停、继续；[RD-10-matrix-run-batch](review/RD-10-matrix-run-batch.png) |
| F-134 | 失败提示：打开小说配置；续写大纲 | panels/AIOutputPanel.tsx:1004，panels/AIOutputPanel.tsx:1032 | 失败类型匹配 | 条件出现 | 失败运行的失败提示条：打开小说配置、继续生成情节大纲；[RD-10-matrix-run-failure](review/RD-10-matrix-run-failure.png) |
| F-135 | 恢复候选：复制、继续编辑、放弃 | panels/AIOutputPanel.tsx:524，panels/AIOutputPanel.tsx:525，panels/AIOutputPanel.tsx:526 | 存在恢复候选 | “放弃”无二次确认（待核） | 运行侧页「可恢复的内容」卡片：继续编辑、复制、放弃（就地确认）；[RD-10-matrix-run-discard](review/RD-10-matrix-run-discard.png) |
| F-136 | 编辑器选区建议恢复：复制建议、复制未保存文字、复制原文稿、继续原选区任务 | panels/AIOutputPanel.tsx:378，panels/AIOutputPanel.tsx:382，panels/AIOutputPanel.tsx:384，panels/AIOutputPanel.tsx:390 | 有中断的选区 AI 任务 | 与 F-073 的“继续原运行”是同一类恢复的两处入口 | 可恢复卡片：复制建议、复制未保存文字、复制原文稿、继续原选区任务；[RD-10-matrix-run-discard](review/RD-10-matrix-run-discard.png) |
| F-137 | 审修候选恢复：复制、复制未保存文字、打开已保存结果/重新审稿/恢复此审修任务 | panels/AIOutputPanel.tsx:425，panels/AIOutputPanel.tsx:429，panels/AIOutputPanel.tsx:435 | 有中断的审稿或修稿 | 按钮按状态切换文案 | 可恢复卡片：复制、复制未保存文字、打开已保存结果、重新审稿、恢复此审修任务；[RD-10-matrix-run-discard](review/RD-10-matrix-run-discard.png) |
| F-138 | 批量正文恢复：继续此批次 | panels/AIOutputPanel.tsx:445 | 有中断批次且来源未变 | 无 | 可恢复卡片「继续此批次」；[RD-10-matrix-run-discard](review/RD-10-matrix-run-discard.png) |
| F-139 | 单章正文候选恢复：勾选片段、复制、重做细纲并继续/沿原细纲继续/确认继续已选正文 | panels/AIOutputPanel.tsx:458，panels/AIOutputPanel.tsx:463，panels/AIOutputPanel.tsx:476 | 有中断的单章生成 | 勾选顺序决定续接顺序（:472） | 可恢复卡片：勾选片段、复制、按状态的续写按钮；[RD-10-matrix-run-discard](review/RD-10-matrix-run-discard.png) |
| F-140 | 生成预算诊断（只读） | panels/GenerationBudgetDiagnostics.tsx:11 | 有诊断数据 | 在 AI 输出 4 处展示（panels/AIOutputPanel.tsx:372、:394、:413、:456） | 可恢复卡片里折叠的「预算诊断」；[RD-10-matrix-run-discard](review/RD-10-matrix-run-discard.png) |
| F-141 | 打开底部面板“任务”标签 | layout/LeftToolWindowBar.tsx:199；pages/KnowledgeOverview.tsx:395（自动）；characters/CharacterCardImportButton.tsx:137（自动）；dialogs/BatchChapterCreationDialog.tsx:261（自动） | 无 | 运行中左栏“任务”有脉冲点（:188） | tasks 意图落到运行侧页「进行中」；[RD-10-matrix-run-live](review/RD-10-matrix-run-live.png) |
| F-142 | 任务：活跃运行展开、步骤展开、历史任务列表 | panels/BottomPanel.tsx:261，panels/BottomPanel.tsx:431，panels/BottomPanel.tsx:182 | 有任务 | 历史只读 | 运行侧页进行中的卡片与步骤、历史分页；步骤日志在「诊断」的日志里；[RD-10-matrix-run-diagnostics](review/RD-10-matrix-run-diagnostics.png) |
| F-143 | 日志：自动滚动开关、清空日志 | panels/BottomPanel.tsx:548，panels/BottomPanel.tsx:554，layout/LeftToolWindowBar.tsx:199（左栏“日志”） | 无 | 清空无确认 | 运行侧页「诊断」：自动滚动开关、清空日志（就地确认）；[RD-10-matrix-run-diagnostics](review/RD-10-matrix-run-diagnostics.png) |
| F-144 | 模型调用记录：统计、明细表 | panels/BottomPanel.tsx:691，layout/LeftToolWindowBar.tsx:199（左栏“模型”） | 无 | 左栏叫“模型”，内容是调用记录（UX-14） | 「诊断」：模型调用统计格与明细表；[RD-10-matrix-run-diagnostics](review/RD-10-matrix-run-diagnostics.png) |
| F-145 | 复制安全诊断 | panels/BottomPanel.tsx:611 | 模型调用记录有行 | 每行一个按钮（:742） | 「诊断」明细表每行的复制按钮；[RD-10-matrix-run-diagnostics](review/RD-10-matrix-run-diagnostics.png) |
| F-146 | 关闭底部面板 | panels/BottomPanel.tsx:118；layout/LeftToolWindowBar.tsx:199（再次点击当前标签） | 面板已打开 | 再次点击收起见 src/stores/layout-store.ts:151 | 运行侧页 ×、Esc、再点胶囊；[RD-10-matrix-run-live](review/RD-10-matrix-run-live.png) |
| F-147 | 状态栏 AI 任务胶囊（进度、完成态） | layout/StatusBar.tsx:86 | 有运行或刚完成 | 完成态 1.8 秒后消失（:97） | 顶栏运行胶囊（进度、完成态）；[RD-10-matrix-run-live](review/RD-10-matrix-run-live.png) |

## 12. 导入导出备份

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-148 | 小说拆解与仿写（打开导入对话框） | layout/TitleBar.tsx:267；pages/v2/WelcomePageV2.tsx:50 | 无 | 顶栏叫“拆解仿写”，首页叫“小说拆解”（UX-14） | 书房「导入」菜单「小说拆解与仿写…」、空书房文字按钮、作品菜单、Ctrl K；[RD-10-matrix-import-menu](review/RD-10-matrix-import-menu.png)、[RD-10-matrix-import-novel](review/RD-10-matrix-import-novel.png) |
| F-149 | 导入对话框：文本用途（参考小说/我的原稿）、导入目标（新项目/当前项目）、选择文件、冲突预览、新项目名称与保存位置、预估消耗、开始 | dialogs/ImportNovelDialog.tsx:558，dialogs/ImportNovelDialog.tsx:568，dialogs/ImportNovelDialog.tsx:590，dialogs/ImportNovelDialog.tsx:608，dialogs/ImportNovelDialog.tsx:731，dialogs/ImportNovelDialog.tsx:876，dialogs/ImportNovelDialog.tsx:921 | 对话框已打开 | 选“我的原稿”时标题变为“导入作者原稿” | 导入对话框（纸墨浮笺）：文本用途、导入目标、选择文件、冲突预览、新项目名称与保存位置、预估消耗、开始；[RD-10-matrix-import-novel](review/RD-10-matrix-import-novel.png) |
| F-150 | 可继续的导入：选择、继续导入、重新开始 | dialogs/ImportNovelDialog.tsx:653，dialogs/ImportNovelDialog.tsx:696，dialogs/ImportNovelDialog.tsx:700 | 有中断导入 | 条件出现 | 导入对话框里可继续的导入：选择、继续导入、重新开始；[RD-10-matrix-import-novel](review/RD-10-matrix-import-novel.png) |
| F-151 | 导出项目：格式（合并 Markdown/分章 Markdown/TXT）、包含故事大纲、选择目录并导出 | layout/TitleBar.tsx:271，dialogs/ExportDialog.tsx:119，dialogs/ExportDialog.tsx:144，dialogs/ExportDialog.tsx:160 | 已打开项目 | 唯一入口是顶栏 | 作品菜单「导出…」、Ctrl K「导出」→ 导出对话框（纸墨浮笺）；[RD-10-matrix-export](review/RD-10-matrix-export.png) |
| F-152 | 项目备份（打开设置“项目备份”） | layout/TitleBar.tsx:263；pages/v2/use-project-overview.tsx:125（首页“项目备份”） | 无 | 三种叫法：备份、项目存档、项目备份（UX-14） | 作品菜单「项目备份」、Ctrl K「项目备份」→ 设置「项目备份」；[RD-10-matrix-backup](review/RD-10-matrix-backup.png) |
| F-153 | 导出本地存档；从本地存档恢复副本 | backups/ProjectBackupPanel.tsx:293；backups/ProjectBackupPanel.tsx:294；backups/ProjectBackupPanel.tsx:133 | 导出需打开项目；恢复不需要 | 恢复总是创建新副本 | 设置「项目备份」：导出本地存档、从本地存档恢复副本；[RD-10-matrix-backup](review/RD-10-matrix-backup.png) |
| F-154 | WebDAV：连接并绑定、确认父世代并重新绑定、刷新云端世代、清除本机凭据（二次确认） | backups/ProjectBackupPanel.tsx:322，backups/ProjectBackupPanel.tsx:323，backups/ProjectBackupPanel.tsx:324，backups/ProjectBackupPanel.tsx:325，backups/ProjectBackupPanel.tsx:330 | 已打开项目 | 无 | 设置「项目备份」WebDAV：连接并绑定、确认父世代并重新绑定、刷新云端世代、清除本机凭据；[RD-10-matrix-backup](review/RD-10-matrix-backup.png) |
| F-155 | 云备份：选择世代、立即云备份、恢复所选世代为副本、取消当前云操作 | backups/ProjectBackupPanel.tsx:340，backups/ProjectBackupPanel.tsx:346，backups/ProjectBackupPanel.tsx:347，backups/ProjectBackupPanel.tsx:348 | 绑定可写 | 无 | 设置「项目备份」云备份：选择世代、立即云备份、恢复为副本、取消当前云操作；[RD-10-matrix-backup](review/RD-10-matrix-backup.png) |

## 13. 设置

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-156 | 打开设置 | layout/TitleBar.tsx:239（☰）；layout/TitleBar.tsx:338（齿轮）；layout/LeftToolWindowBar.tsx:210；layout/StatusBar.tsx:58；layout/StatusBar.tsx:66 | 无 | 4 类入口（UX-09）。不带参数时都打开“AI 生成模型”页（src/stores/layout-store.ts:181），所以 ☰ 和齿轮也落在模型页；每次打开都按请求重置标签（settings/SettingsModal.tsx:81） | 流程脊底部「设置」、书房顶栏齿轮、Ctrl K「设置」；[RD-10-matrix-settings-appearance](review/RD-10-matrix-settings-appearance.png) |
| F-157 | 设置标签切换（9 个）；关闭设置 | settings/SettingsModal.tsx:121，settings/SettingsModal.tsx:151 | 设置已打开 | 标签定义 :57-65 | 设置页三组导航（常用、高级、其他）；返回、Esc、Ctrl W；[RD-10-matrix-settings-appearance](review/RD-10-matrix-settings-appearance.png) |
| F-158 | 外观：主题（4 种） | settings/AppearanceSettings.tsx:112；layout/TitleBar.tsx:321（顶栏循环切换） | 无 | 两处入口（UX-15） | 设置「外观」主题：浅色、深色（RD-10 起只有两套，旧配置 galaxy 迁为深色、paper 与 light 迁为浅色）；[RD-10-matrix-settings-appearance](review/RD-10-matrix-settings-appearance.png) |
| F-159 | 外观：皮肤（经典/动漫/自定义图片选择、更换、移除）、提示关闭 | settings/AppearanceSettings.tsx:140，settings/AppearanceSettings.tsx:193，settings/AppearanceSettings.tsx:171，settings/AppearanceSettings.tsx:181，settings/AppearanceSettings.tsx:207 | 无 | 皮肤只在设置里 | 按已确认的决定移除（RD-10）：图片皮肤迁为无皮肤，皮肤目录原样保留；[RD-10-matrix-settings-appearance](review/RD-10-matrix-settings-appearance.png) |
| F-160 | AI 生成模型：新增、设为默认、编辑、删除 | settings/SettingsModal.tsx:286，settings/SettingsModal.tsx:400，settings/SettingsModal.tsx:408，settings/SettingsModal.tsx:415 | 无 | 删除无确认（:339 直接调用 store） | 设置「AI 模型」：新增、设为默认、编辑、删除（危险确认）；[RD-10-matrix-settings-model](review/RD-10-matrix-settings-model.png) |
| F-161 | 模型表单：名称、服务商、协议、模型名（列表/手动）、base_url、API Key 显隐、获取模型列表、上下文窗口、能力来源与推理覆盖、高级设置（温度、最大输出、输出容量、恢复默认）、测试连接、保存、取消 | settings/SettingsModal.tsx:676，settings/SettingsModal.tsx:722，settings/SettingsModal.tsx:792，settings/SettingsModal.tsx:808，settings/SettingsModal.tsx:885，settings/SettingsModal.tsx:906，settings/SettingsModal.tsx:967，settings/SettingsModal.tsx:1009，settings/SettingsModal.tsx:1017 | 新增或编辑中 | 生成与向量共用表单 | 设置「AI 模型」的模型表单（沿用 ModelForm，纸墨配色）；[RD-10-matrix-first-model](review/RD-10-matrix-first-model.png) |
| F-162 | 服务商外链：SiliconFlow 邀请注册、官方控制台、官方文档 | settings/SettingsModal.tsx:305，settings/SettingsModal.tsx:849，settings/SettingsModal.tsx:852，settings/SettingsModal.tsx:855 | 向量模型页或对应服务商 | 外部链接 | 模型表单与检索模型页的服务商外链（免费模型「去注册」等）；[RD-10-matrix-first-model](review/RD-10-matrix-first-model.png)、[RD-10-matrix-index-model](review/RD-10-matrix-index-model.png) |
| F-163 | 向量模型：同 F-160/F-161，另有低显存参数预设、分块/重叠/批量 | settings/SettingsModal.tsx:164，settings/SettingsModal.tsx:982 | 无 | 无 | 设置「检索模型」；[RD-10-matrix-index-model](review/RD-10-matrix-index-model.png) |
| F-164 | 网络代理：启用、类型、主机、端口、保存 | settings/SettingsModal.tsx:1091，settings/SettingsModal.tsx:1106，settings/SettingsModal.tsx:1139 | 无 | 无 | 设置「网络代理」（纸墨表单）；[RD-10-matrix-settings-appearance](review/RD-10-matrix-settings-appearance.png) |
| F-165 | 编辑器：界面语言、界面字体、写作字体 | settings/SettingsModal.tsx:1316，settings/SettingsModal.tsx:1335，settings/SettingsModal.tsx:1346 | 无 | 标签说明写“字体大小、自动保存”，内容不含这两项，语言也放在这里 | 设置「外观」：界面语言、界面字体、写作字体；[RD-10-matrix-settings-appearance](review/RD-10-matrix-settings-appearance.png) |
| F-166 | 编辑器：定稿后打开下一章开关 | settings/SettingsModal.tsx:1356 | 无 | 驱动 F-056 | 设置「外观」：定稿后打开下一章；[RD-10-matrix-settings-appearance](review/RD-10-matrix-settings-appearance.png) |
| F-167 | 提示词模板：选择模板、编辑写作语言、插入变量、编辑角色定位与补充指导、保存到全局/项目、恢复默认 | settings/PromptSettings.tsx:365，settings/PromptSettings.tsx:186，settings/PromptSettings.tsx:404，settings/PromptSettings.tsx:473，settings/PromptSettings.tsx:483，settings/PromptSettings.tsx:493 | 保存到项目需打开项目 | 恢复默认无确认 | 设置「提示词模板」（沿用旧组件，纸墨配色）；[RD-10-matrix-settings-appearance](review/RD-10-matrix-settings-appearance.png) |
| F-168 | 写作 Skills：只读检查 GitHub 地址、确认安装、阶段绑定、卸载 | settings/SkillSettings.tsx:242，settings/SkillSettings.tsx:270，settings/SkillSettings.tsx:295，settings/SkillSettings.tsx:342 | 绑定需打开项目 | 无 | 设置「写作 Skills」（沿用旧组件，纸墨配色）；[RD-10-matrix-settings-appearance](review/RD-10-matrix-settings-appearance.png) |
| F-169 | 关于（版本、定位说明） | settings/SettingsModal.tsx:1374 | 无 | 不含检查更新 | 设置「关于与更新」；[RD-10-matrix-update](review/RD-10-matrix-update.png) |
| F-170 | 应用更新：官方主页、检查更新、下载、打开下载页、立即重启更新、7/30 天后提醒、关闭提醒、各类重试 | updates/UpdateSection.tsx:81，updates/UpdateSection.tsx:84，updates/UpdateStatusCard.tsx:71，updates/UpdateStatusCard.tsx:72，updates/UpdateStatusCard.tsx:73，updates/UpdateStatusCard.tsx:32，updates/UpdateStatusCard.tsx:87，updates/UpdateStatusCard.tsx:66 | 首页 | 只挂在首页（pages/v2/use-project-overview.tsx:129） | 设置「关于与更新」的检查与各动作；书房更新卡：下载、打开下载页、立即重启更新、7/30 天后提醒、重试；[RD-10-matrix-update](review/RD-10-matrix-update.png) |
| F-171 | 更新安装拦截：有任务时“返回处理任务”；未保存时“返回保存/放弃修改并重启” | updates/UpdateSection.tsx:99，updates/UpdateSection.tsx:109，updates/UpdateSection.tsx:110 | 点击安装时 | 放弃修改为危险操作 | 纸墨对话框「请先处理未保存的修改」：有任务只能返回处理任务；未保存时「返回保存」或危险的放弃修改并重启更新；[RD-10-matrix-update](review/RD-10-matrix-update.png) |
| F-172 | 新版本通知（ActionToast“查看更新”） | updates/UpdateNotifier.tsx:37 | 检测到新版本且未延后 | 自动行为，点后跳首页 | 纸墨提示栈的新版本通知「查看更新」回书房；[RD-10-matrix-toasts](review/RD-10-matrix-toasts.png) |

## 14. 应用外壳与窗口

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-173 | 沉浸写作（收起侧栏、助手、底栏） | layout/TitleBar.tsx:291 | 无 | 再点恢复；打开任一面板也会退出（src/stores/layout-store.ts:143） | 顶栏「进入沉浸写作」、Ctrl K「沉浸写作」：全出血纸面与底部字数进度，Esc 退出；[RD-10-matrix-chapter-focus](review/RD-10-matrix-chapter-focus.png) |
| F-174 | 缩放：缩小、重置、放大 | layout/TitleBar.tsx:297；layout/TitleBar.tsx:305；layout/TitleBar.tsx:313；layout/TitleBar.tsx:189（⌘=/⌘-/⌘0） | 无 | UX-15 | 设置「外观」界面缩放（−、+、还原），快捷键不变；[RD-10-matrix-settings-appearance](review/RD-10-matrix-settings-appearance.png) |
| F-175 | 中英切换 | layout/TitleBar.tsx:329；settings/SettingsModal.tsx:1316 | 无 | 两处入口 | 设置「外观」界面语言；[RD-10-matrix-settings-appearance](review/RD-10-matrix-settings-appearance.png) |
| F-176 | 保存状态提示（已保存/已修改） | layout/TitleBar.tsx:252 | 无 | 只读；与编辑器内保存提示重复（UX-16） | 顶栏保存状态「已保存」「未保存」（只此一处）；[RD-10-matrix-save](review/RD-10-matrix-save.png) |
| F-177 | 窗口最小化、最大化/还原、关闭 | layout/TitleBar.tsx:349，layout/TitleBar.tsx:357，layout/TitleBar.tsx:365 | 无 | 无 | 顶栏右端最小化、最大化/还原、关闭；[RD-10-matrix-shell](review/RD-10-matrix-shell.png) |
| F-178 | 退出拦截：未保存时“取消/放弃并退出/保存并退出”；有任务时只能“知道了” | layout/TitleBar.tsx:75，layout/TitleBar.tsx:393，layout/TitleBar.tsx:398，layout/TitleBar.tsx:401 | 关闭窗口时 | 放弃并退出为危险操作 | 关窗时纸墨退出确认「退出前处理未保存的内容」：取消、放弃并退出、保存并退出；有运行时只能知道了；[RD-10-matrix-exit-confirm](review/RD-10-matrix-exit-confirm.png) |
| F-179 | 左栏切换侧栏视图；再次点击当前项收起侧栏 | layout/LeftToolWindowBar.tsx:122，src/stores/layout-store.ts:121 | 无 | 收起行为没有可见提示 | 按设计不再有：没有左侧工具窗口栏，流程脊常驻 |
| F-180 | 拖拽调整资料栏、助手栏、任务栏尺寸 | layout/v2/ShellV2.tsx:53，layout/v2/ShellV2.tsx:57，layout/v2/ShellV2.tsx:63 | 首页不显示 | 无 | 按设计不再有：侧页与对话框尺寸由外壳决定，不提供拖拽 |
| F-181 | 窄窗口提示 | layout/v2/ShellV2.tsx:43 | 窗口窄时（CSS 控制） | 只读 | 按设计不再有窄窗口提示：最小窗口宽度下页面自适应（RD-10 修正 1024 宽关系图谱） |
| F-182 | 编辑区标签：切换、关闭（含未保存确认）、上一个/下一个 | panels/EditorArea.tsx:539，panels/EditorArea.tsx:580，panels/EditorArea.tsx:565，panels/EditorArea.tsx:598，panels/EditorArea.tsx:605 | 有标签 | 关闭逻辑会跳过 pinned 标签（src/stores/editor-store.ts:357），但源码中没有任何标签被设为 pinned | 内容区标签条：切换、关闭（未保存确认）、← → 移动、Delete 关闭；[RD-10-matrix-tabs](review/RD-10-matrix-tabs.png) |
| F-183 | 标签右键菜单：关闭、关闭其他、关闭右侧所有、关闭所有 | panels/EditorArea.tsx:540，panels/EditorArea.tsx:335 | 有标签 | 批量关闭含未保存时确认（:928） | 标签右键菜单：关闭、关闭其他、关闭右侧、关闭全部（RD-10）；[RD-10-matrix-tab-menu](review/RD-10-matrix-tab-menu.png) |
| F-184 | “已打开的编辑器”菜单：同上 4 项 + 标签列表跳转 | panels/EditorArea.tsx:614，panels/EditorArea.tsx:389，panels/EditorArea.tsx:436 | 有标签 | 与右键菜单重复 | 标签条「标签操作」菜单：同上四项与已打开页面列表（RD-10）；[RD-10-matrix-tab-menu](review/RD-10-matrix-tab-menu.png) |
| F-185 | ⌘W 关闭当前标签 | panels/EditorArea.tsx:277 | 有标签 | 无 | Ctrl W 关闭当前标签（设置页开着时关设置页）；[RD-10-matrix-tabs](review/RD-10-matrix-tabs.png) |
| F-186 | ⌘F 查找（CodeMirror 搜索面板开关） | editor/CodeMirrorEditor.tsx:521 | 焦点在 CodeMirror | 无可见入口 | 正文 Ctrl F 打开搜索框，Esc 只关搜索；[RD-10-matrix-focus-search](review/RD-10-matrix-focus-search.png) |
| F-187 | ⌘S 保存 | editor/CodeMirrorEditor.tsx:538 | 焦点在 CodeMirror（草稿、正文、架构文档、恢复稿） | 表单页（配置、蓝图、角色）不响应 | Ctrl S 保存当前页；[RD-10-matrix-save](review/RD-10-matrix-save.png) |
| F-188 | Tab 键插入首行缩进（两个 em 空格） | editor/CodeMirrorEditor.tsx:339 | prose 模式、无选区 | 无可见入口 | 正文 Tab 插入两个全角空格；先 Esc 再 Tab 离开编辑区；[RD-10-matrix-chapter-draft](review/RD-10-matrix-chapter-draft.png) |
| F-189 | 活动标签同步左栏高亮 | panels/EditorArea.tsx:205 | 项目视图 | 自动行为 | 当前标签同步流程脊的当前阶段与章；[RD-10-matrix-shell](review/RD-10-matrix-shell.png) |
| F-190 | 组件渲染失败时“重试” | src/components/ErrorBoundary.tsx:87 | 侧栏、编辑区或 AI 面板渲染出错 | 三处包裹（src/App.tsx:262、:267、:272） | 外壳渲染出错时的纸墨兜底「重试」；整页载入失败时「重新载入」；[RD-10-matrix-lazy-retry](review/RD-10-matrix-lazy-retry.png) |
| F-191 | 启动检查：重新检查、关闭应用；迁移提示“知道了” | startup/RendererStartup.tsx:89，startup/RendererStartup.tsx:90，startup/RendererStartup.tsx:72 | 启动阻塞或有迁移提示 | 无 | 启动检查：重新检查、关闭应用；迁移提示「知道了」（书房顶部）；[RD-10-matrix-library-empty](review/RD-10-matrix-library-empty.png) |
| F-192 | 通用 Toast 关闭 | ui/Toast.tsx:141 | 有提示 | 无 | 纸墨提示栈每条「关闭通知」；[RD-10-matrix-toasts](review/RD-10-matrix-toasts.png) |

## 15. 随聊天隐藏的能力

按 `req-hide-ai-chat.md` 决定隐藏，不要求新位置。代码保留。

| ID | 功能 | 当前入口 | 前置条件/状态依赖 | 备注 | 新位置（纸墨外壳规范入口；验证截图） |
|---|---|---|---|---|---|
| F-193 | 打开 AI Agent 聊天面板 | layout/RightToolWindowBar.tsx:49；src/stores/layout-store.ts:98（默认 rightView 为 agent）；src/App.tsx:273 | 无 | 需求表第 1、2 项 | 随聊天隐藏（ADR-0008），代码保留 |
| F-194 | AI 输出“切换回 Agent” | panels/AIOutputPanel.tsx:253 | AI 输出面板 | 需求表第 3 项；它也是 AI 输出头部唯一的关闭样式按钮 | 随聊天隐藏（ADR-0008），代码保留 |
| F-195 | 助手任务恢复：复制回复、恢复此助手任务（跳回聊天） | panels/AIOutputPanel.tsx:401，panels/AIOutputPanel.tsx:402 | 有中断的助手任务 | 需求表第 4 项 | 随聊天隐藏（ADR-0008），代码保留 |
| F-196 | 新建对话、历史对话、选择/删除对话 | panels/agent/AgentHeader.tsx:71，panels/agent/AgentHeader.tsx:80，panels/agent/AgentConversation.tsx:279，panels/agent/AgentConversation.tsx:327 | 聊天面板 | 无 | 随聊天隐藏（ADR-0008），代码保留 |
| F-197 | 更多菜单：MCP 服务器列表、技能列表、清空所有对话 | panels/agent/AgentHeader.tsx:116，panels/agent/AgentHeader.tsx:122，panels/agent/AgentHeader.tsx:128 | 聊天面板 | MCP 只读列表，唯一入口；隐藏后 MCP 仍在启动时初始化（src/App.tsx:131） | 随聊天隐藏（ADR-0008），代码保留 |
| F-198 | 关闭 Agent 面板 | panels/agent/AgentHeader.tsx:162 | 聊天面板 | 无 | 随聊天隐藏；关闭按钮关的是旧外壳右侧面板，RD-10 随该面板状态一起删除 |
| F-199 | 输入框：添加上下文（媒体文件、@提及、工作流命令）、深度/快速模式、选择模型、发送/停止 | panels/agent/AgentInputBox.tsx:323，panels/agent/AgentInputBox.tsx:277，panels/agent/AgentInputBox.tsx:278，panels/agent/AgentInputBox.tsx:284，panels/agent/AgentInputBox.tsx:379，panels/agent/AgentInputBox.tsx:395，panels/agent/AgentInputBox.tsx:462 | 聊天面板 | `/` 与 `@` 菜单见 SlashCommandMenu、MentionMenu | 随聊天隐藏（ADR-0008），代码保留 |
| F-200 | 对话内：切换到 AI 输出、回到底部、复制消息、复制工具结果、工具确认卡（确认/拒绝/取消生成）、助手文件产物卡 | panels/agent/AgentConversation.tsx:213，panels/agent/AgentConversation.tsx:162，panels/agent/AgentMessage.tsx:44，panels/agent/ToolCallBlock.tsx:115，panels/agent/ConfirmCard.tsx:90，panels/agent/ArtifactCard.tsx:53 | 聊天面板 | 修改提案预览见 DomainProposalDiff、ConfigImpactPreview | 随聊天隐藏（ADR-0008），代码保留 |
| F-201 | 助手打开编辑器工具（由对话触发打开标签） | src/services/agent/tools/open-editor.tool.ts:72 | 聊天中调用 | 唯一能打开 `character` 类型标签的路径（待核） | 随聊天隐藏（ADR-0008），代码保留 |

## 统计与发现

### (a) 统计

- 功能总数：201（F-001～F-201）。其中随聊天隐藏 9 项（F-193～F-201），其余 192 项需要保留。
- 多入口功能数：36（“当前入口”列含“；”的行）。同一对话框或面板挂在多个宿主里的（如 F-058、F-086、F-116），记在备注，不计入。
- 另有 3 组按行拆开、但操作重叠的功能：关闭标签（F-182～F-185）、剧情树与叙事线索打开（F-096、F-097）、修稿两条路径（F-082、F-083）。

### (b) 只在单一深层位置可达的功能

判定标准：必须先进入特定编辑器、对话框或特定状态才能看到，且没有快捷键、状态栏、侧栏等替代入口。

- 版本历史全部操作（F-092～F-095）：只有左栏“历史”一个入口。
- 导出项目（F-151）：只在顶栏。
- 复制安全诊断（F-145）：只在底部“模型”调用记录表的行内。
- 暂停/继续批量创作（F-133）：只在底部任务面板。
- 放弃旧草稿并加载投影、旧角色修复恢复（F-033、F-035）：只在角色图谱相关视图，且需特定状态。
- 断点续写大纲、续批（F-038）：只在故事架构总览的大纲卡片。
- 清除误导入正文（F-052）：只在蓝图页且检测到旧数据时。
- 修复定稿、后处理重试（F-090、F-091）：只在已定稿草稿页。
- 重试合并后复验（F-087）：只在审稿报告页。
- WebDAV 与云备份（F-154、F-155）：只在设置“项目备份”。
- 定稿后打开下一章开关（F-166）：只在设置“编辑器”。
- 剧情树生成记录恢复（F-102）：只在叙事线索编辑器顶部。
- 应用更新（F-170）：只在首页底部。
- 角色状态建议与角色决策（F-117、F-118）：只在角色侧栏顶部。
- 选区 AI 操作与 ⌘F、Tab 缩进（F-073、F-186、F-188）：只能通过选中文字或快捷键触发，没有可见菜单。

### (c) design-redundancy.md 未记录的冗余或隐藏入口

1. HomeSidebarPanel 实际不可见。`panels/Sidebar.tsx:53` 只在 `sidebarView === 'home'` 时渲染它，而这时 `src/App.tsx:257` 传入 `home=true`，`layout/v2/ShellV2.tsx:50` 给侧栏 Panel 传 `hidden`；该库把未声明的属性透传到 DOM，`src/styles/redesign/writer-shell.css:23` 对 `[hidden]` 设 `display: none !important`。`src/stores/layout-store.ts:143` 等处在首页打开任何面板前都先切到项目视图，也与此一致。以上为源码推断，未实机截图。因此它的新建、打开、最近项目、删除项目入口都看不到，“从最近项目移除”（F-006，panels/sidebar/HomeSidebarPanel.tsx:139）没有任何可见入口。
2. 同理，ProjectTree 与 CharactersView、KnowledgePanel 的“未打开项目”空状态不可见。无项目时 `home` 恒为 true，侧栏被隐藏。design-redundancy.md 把“项目树空状态”算作打开、新建的入口（矩阵“打开项目”“新建项目”行），实际不可达。
3. 未挂载的界面代码：`settings/ModelSettings.tsx` 没有非测试引用者，`settings/ReasoningPolicySettings.tsx` 的默认导出只被它使用；`pages/WelcomePage.tsx` 也没有引用者。推理相关控件仍以具名导出挂在设置的模型表单里（settings/SettingsModal.tsx:877、:967），没有丢失。
4. 版本“对比”复用修稿合并对话框。`editor/VersionHistory.tsx:141` 打开 `type: 'diff'` 标签，`panels/EditorArea.tsx:759` 把它渲染为标题“修稿合并”的模态框，带“完成合并”按钮；但该标签没有 `revisionPath`，`panels/EditorArea.tsx:811` 的条件不成立，点击后不写入也不关闭（推断，待实机核对）。
5. 关闭类入口命名不一。AI 输出头部的 × 实际是“切换回 Agent”（panels/AIOutputPanel.tsx:253），不是关闭；关闭右侧面板只能再次点击右栏当前按钮（layout/RightToolWindowBar.tsx:30）。左栏按钮与底栏标签也靠“再次点击收起”（src/stores/layout-store.ts:121、:151），没有提示。
6. 底部面板的 3 个标签只能从左栏切换。`BottomPanel.tsx` 头部只有标题和关闭按钮，面板内没有标签切换。
7. 危险操作缺少确认：删除叙事线索计划（editor/NarrativeThreadEditor.tsx:778）、清除剧情树（editor/NarrativeThreadEditor.tsx:569）、删除模型配置（settings/SettingsModal.tsx:339）、清空日志（panels/BottomPanel.tsx:554）。同类的删除草稿、删除章节、清空蓝图都有确认。
8. 两种修稿并存。草稿页“AI 修稿”（editor/DraftEditor.tsx:764）直接修稿，审稿报告“按确认意见修稿”（editor/ReviewReport.tsx:1322）走清单；完成后都打开合并，标签名分别是“修稿合并”和“审稿修复”（src/services/workflows/commands/review-revision-command.ts:207）。
9. 写作对话框里还有一处“本次创作模型”，审修有“本次修稿模型”、剧情树有“本次分析模型”、叙事线索有“本次识别模型”。design-redundancy.md 的“模型”行只记了写作弹窗一处。
10. ⌘S 只在 CodeMirror 内生效（editor/CodeMirrorEditor.tsx:538；全局 keydown 只有 src/App.tsx:229、layout/TitleBar.tsx:186、panels/EditorArea.tsx:275）。design-redundancy.md UX-16 把 ⌘S 列为蓝图页的保存方式之一，但蓝图表单不在 CodeMirror 内，小说配置和角色页同样不响应。
11. 设置“编辑器”标签说明写“字体大小、自动保存”（settings/SettingsModal.tsx:61），实际内容是界面语言、两种字体和“定稿后打开下一章”。
12. 无项目时点左栏“角色”或“小说”，编辑区会离开欢迎页，显示带“请先打开项目”的角色档案或知识库页（panels/EditorArea.tsx:463），侧栏仍被隐藏，页面上没有新建或打开入口。
13. 首页隐藏右侧工具栏（`src/styles/redesign/v3-magazine.css:316`），AI 输出和聊天按钮在首页都不可见。
14. 选区 AI 操作（润色、扩写、续写、对话）只能在选中文字后的浮动条触发（editor/CodeMirrorEditor.tsx:669），没有菜单或按钮入口，与 AI 聊天无关，隐藏聊天后仍保留。

## 复核方法

「当前入口」的行号指向基线 `9c00fe56`，用下面的脚本从这个提交逐条打印源码，审查者重跑即可核对：

```bash
cd "<工作树根>"
grep -oE '(src/)?[A-Za-z0-9_./-]+\.(tsx|ts):[0-9]+' docs/design/2026-10-11-frontend-redesign/feature-matrix.md | sort -u | while IFS=: read -r f n; do
  case "$f" in src/*) p="$f";; *) p="src/components/$f";; esac
  printf '%s:%s: %s\n' "$f" "$n" "$(git show "9c00fe56:$p" | sed -n "${n}p" | sed 's/^ *//' | cut -c1-140)"
done
```

多入口计数：

```bash
grep -E '^\| F-[0-9]+' docs/design/2026-10-11-frontend-redesign/feature-matrix.md | awk -F'|' '$4 ~ /；/' | wc -l
```
