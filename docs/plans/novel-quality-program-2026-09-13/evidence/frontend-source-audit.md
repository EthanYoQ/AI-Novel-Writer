# Frontend 1.1.0 贡献树源码审计

审计日期：2026-09-13  
审计方式：只读源码、Git 对象与静态契约比较；未启动 donor Electron，未调用模型，未打开真实项目，未执行按钮或测试。本文中的“已接链路”只表示源码上存在可追踪调用链，不表示运行正常。

## 结论先行

1. **它不是纯 HTML。** 两棵树都是 Electron + React 19 + TypeScript/TSX + Vite + Zustand。`index.html` 只是挂载壳；`src/main.tsx:1-10` 创建 React root，`package.json:12,14-25,72-82,104-119` 定义 Electron/Vite/React 构建与运行栈。
2. **贡献树不能覆盖式合并。** 它是在 `v1.1.0` 内容上叠加新 UI 与若干功能，而不是基于当前最新源码重放。直接覆盖会回滚当前已合入的世界观候选恢复/重校验和按章情节大纲投影，既有丢稿和上下文质量风险。
3. **“经典 / 写手”应复用贡献树已经存在的 v1/v2 壳层切换。** `ui-version-store` 默认 v2，`App` 在 `ShellV2` 与原壳之间切换；`ShellV2` 继续消费同一批 Sidebar/Editor/AI/Bottom React 节点。不要复制 handler/store/IPC 形成第二业务层。
4. **外观目前有三条独立轴：** 四种颜色主题、`classic/anime/custom` 图片皮肤、v1/v2 界面壳。计划必须给它们不同的领域名称和单一状态所有者，不能把现有 `SkinId='classic'` 与“经典界面”混为同一设置。
5. **不是所有按钮和接口都齐全。** v2 文件菜单中的“备份”明确是禁用占位，`onClick={() => undefined}`。另外“单独大纲章数”没有独立持久字段，只有总章数和一次生成的起止章范围。
6. **存在 P0 丢稿反例。** donor 切换作品后主动清除旧项目 tabs、保存 handler 和 draft ledgers，但打开作品入口只处理运行中的 workflow，没有未保存内容的“保存 / 放弃 / 取消”门禁。该行为不能进入整合包。

## 版本与变更边界

受审工作树：

- `HEAD = 731bda13ff9197d0abefaa353139df1359ce75cb`
- `origin/master = 2264390d6fb8b052cc14736d544df0cc74516649`
- `HEAD` 与 `origin/master` 代码树无差异。
- 本地 `master = ea48b6316bc30e23e1073d73443f32d2516f0fdb`，是陈旧引用，不能作为“最新源树”。
- `v1.1.0 = 879f83521414f66019488462830c3134c77dc4f8`

比较范围为 `src/`、`electron/`、`scripts/`、`test/`、`public/`、`.storybook/`，排除依赖、构建产物和运行数据：

| 比较 | 相同 | 内容不同 | 左侧独有 | donor 独有 | 说明 |
|---|---:|---:|---:|---:|---|
| v1.1.0 tag → donor | 734 | 57 | 0 | 69 | donor 保留 tag 的全部 791 个受审文件，再叠加 UI/头像/关系图等 |
| 当前 HEAD ↔ donor | 726 | 67 | 2 | 67 | 当前独有两份世界观恢复测试；67 个同路径文件内容不同 |

当前相对 `v1.1.0` 的生产差异集中于角色卡导入、世界观中断恢复、受限续写和草稿上下文修复；`git diff v1.1.0..HEAD` 在受审根下为 22 个文件、1640 行新增、99 行删除。donor 的主要新增边界则是 v2 壳层/样式、UI 版本 store、角色关系新视图和头像跨进程链路。

### 不能被 donor 回滚的当前修复

- 当前 `src/services/workflows/commands/architecture.command.ts:52,133-149,1654-1914` 持有 `world_building_partial_result`、可恢复错误、恢复选项、提交前重校验和候选保存；`src/services/workflows/architecture-workflow.ts:28,51,74,137`、`src/services/workflows/creative-workflow-launcher.ts:44,130`、`src/components/editor/WorldBuildingEditor.tsx:328` 把恢复意图贯通到生产入口。donor 不含这组 `resumeWorldBuilding` / `world_building_partial_result` 契约。
- 当前 `src/services/workflows/commands/generate-draft.command.ts:92,1202` 使用 `synopsisForDraftChapter` 把全书情节大纲投影到当前章；donor 不含该符号。回滚会重新扩大或错配草稿上下文，直接影响 token 和写作质量。
- donor 的 `src/components/editor/WorldBuildingEditor.tsx:118-143,532-567` 仍识别旧的情节大纲 checkpoint，并读取 `${projectPath}/.vela/partial_arch.json`。这只能说明旧 synopsis 续批 UI 存在，不能替代当前的世界观候选恢复，也与 Vela 路径清理目标冲突。

整合要求：以当前 HEAD 为业务基线，逐块移植 donor 的 UI/新功能；恢复与草稿上下文相关文件必须三方合并，禁止 donor 覆盖。至少需要基于当前生产入口的恢复拒绝门、候选保留门和按章上下文回归测试。

## 外观分层与复用边界

### 已有三条状态轴

| 轴 | 当前实现 | 持久化 / 副作用 | 计划中的正确职责 |
|---|---|---|---|
| 色彩主题 | `src/stores/theme-store.ts:5,107,140`：`light/galaxy/paper/dark` | renderer 本地设置、CSS variables/classes；缩放另走 IPC | 只决定颜色、字体、字号/缩放 |
| 图片皮肤 | `src/stores/skin-store.ts:24-61,174-230` + `electron/controllers/skin-controller.ts:215-258` + `electron/services/skin-service.ts` | main process 持久化，支持 `classic/anime/custom` 与自定义资源 | 只决定背景/图片素材，不决定业务布局 |
| 界面壳 | donor `src/stores/ui-version-store.ts:14-20,31-76`：`v1/v2`，默认 v2 | localStorage `ai-novel-writer-ui-version` | 映射为用户命名的“经典 / 写手”，写手默认 |

donor `src/App.tsx:126,227-240,291-303` 在根节点设置 `data-ui` / `data-v2-theme`，并选择 `ShellV2`；`src/components/layout/v2/ShellV2.tsx:10-24` 接收 `sidebar/editor/aiPanel/bottom`，`App.tsx:299-303` 传入既有业务节点。因此：

- 新界面并非纯 CSS，因为壳、标题栏、欢迎页、关系图均有 React 组件分支；
- 业务页不应复制。应让两套壳消费相同 store/commands/IPC；
- 可以复用 donor 的 React 壳和 CSS，但要把 `uiVersion` 改成领域明确的 appearance/shell mode，或至少提供一次兼容迁移；
- `classic` 这个字符串已经属于图片 `SkinId`，新的界面模式不要复用同一枚举/同一 storage key 语义。

## P0：切换作品会静默清除未保存编辑

静态反例链：

1. donor `src/components/panels/EditorArea.tsx:185-205` 在 `currentProject.path` 变化后收集所有其他项目 tabs，并调用 `clearProjectTabs(staleKey)`。
2. donor `src/stores/editor-store.ts:405-422` 的 `clearProjectTabs` 先注销该项目的 exit-save handlers，再移除 tabs，并从所有 `draftLedgers` 中过滤该项目记录。
3. donor `src/stores/project-store.ts:448-476` 的 `openProject` 只调用 `confirmAndCancelProjectWorkflows`；该确认函数 `:96-123` 只询问是否取消运行中的创作任务，不统计/保存/放弃未保存编辑。
4. donor `src/components/layout/exit-guard.tsx:4-6,53-112,127-161` 虽有窗口退出时的保存/放弃/取消，但它只处理窗口关闭，不覆盖 `openProject`。
5. 当前经典版 `src/components/panels/EditorArea.tsx:170-182` 保留其他项目未保存 tab，没有 donor 的清除循环。

反例：用户在作品 A 的 CodeMirror/角色卡/配置编辑器中有未保存内容，直接从欢迎页或最近项目打开作品 B；B 被接受后 `EditorArea` 清 A 的 tab 与 ledger，退出 guard 也已失去检测和保存依据。

最小关闭条件：

- 所有新建、打开、最近项目、书架切换、关闭项目入口共用一个 project-transition coordinator；
- coordinator 在主进程接受切换前冻结旧 project session，统计 tabs + background draft ledgers，提供“保存并切换 / 放弃并切换 / 取消”；
- 保存任一失败、lease 改变或出现新输入时保持原项目和编辑器状态，不执行 clear；
- 只有保存成功或用户明确放弃后，才允许清理旧项目状态；
- 自动化覆盖 CodeMirror 正文、角色卡、小说配置和至少一种后台 ledger；v1/v2 两壳都走同一门禁；
- UI 壳切换虽未直接调用 `clearProjectTabs`，但会卸载/重挂壳层，仍需验证 dirty tab、selection、draft ledger 和 save handler 不丢失。

## 功能覆盖与接口判定

### 1. v2 壳与常用菜单：部分完整

- `src/App.tsx:298-303` 与 `ShellV2.tsx:10-24` 表明 v2 复用同一业务组件；这是正确的整合方向。
- `src/components/layout/v2/TitleBarV2.tsx:249-255` 的“备份 / Backup”菜单项是 `disabled` 且 `onClick={() => undefined}`，是明确占位，不是可用功能。
- 新建、打开、导入、导出、设置、主题、缩放和窗口控制可在源码上追到现有 layout/project/theme/IPC handler，但本次没有 Electron 或真实项目运行证据，状态只能记为“静态链存在”。

关闭条件：占位按钮在发布壳中删除/隐藏，或实现明确备份格式、目标位置、覆盖/失败/恢复合同与端到端测试；不能把 disabled 占位计入“按钮齐全”。

### 2. 角色图：静态链完整，适合复用

- donor `src/components/editor/RelationsEditor.tsx:22-27,49-55,114-128` 明确以 v1 `RelationshipGraph` / v2 `RelationMap` 投影同一份角色数据，打开档案复用 `openBuiltinEditor`。
- `RelationMap.tsx:71-81,159-194,500-506` 从角色名单和关系文本构图，没有第二份关系事实库；清空图谱实质会删除全部角色。
- `use-clear-all-characters.ts:32-71` 有确认后调用现有 `characterStore.clearAllCharacters` 的链路。

判定：新视图是同一事实源的只读投影，接口方向正确；但“清空图谱”属于删除角色的破坏性动作，文案、确认与 v1/v2 行为必须一致，不能被理解为仅清布局。

### 3. 角色头像：新跨层链存在，但路径和原子性阻断直接照搬

- renderer `src/components/editor/use-character-avatar.ts:100,128,166,188` 调用 read/choose/commit/remove。
- typed contract 在 `src/shared/ipc-channels.ts:140-162`。
- `electron/ipc-handlers.ts:18,52` 注册 `registerCharacterAvatarController`；handler 在 `electron/controllers/character-avatar-controller.ts:178-321`。
- 但该 controller `:7` 明确写入 `<项目>/.vela/avatars`，与“Vela 残留全量改写/无效残留删除”冲突。
- commit `:283-289` 先写文件，再 `CharacterRepository.setAvatar`；数据库失败路径会留下孤儿文件。批量删除角色是否回收头像也不能从此链证明。

关闭条件：头像存储使用新命名且纳入项目数据迁移/导出/备份/删除合同；commit 失败清理文件或采用可恢复两阶段提交；角色删除、重命名、项目迁移和失败注入均有测试。

### 4. 审稿与审修：既有静态生产链完整，未获运行证明

- `src/services/workflows/commands/review-chapter.command.ts:214-217,292-358,380-443` 读取连续性上下文，要求结构化报告，校验/重建后经 `db:review-create` 持久化并打开 `review-report` tab。
- `src/components/editor/ReviewReport.tsx:428-608` 读取最新/完整审稿，保存人工确认快照。
- `src/services/workflows/commands/refine-from-review.command.ts:94-167,227-279` 重新校验持久审稿与基准草稿，调用模型后用 `db:revision-replace-pending` 创建审修版本。

判定：不是静态假按钮，但 donor 没有为这条业务链提供本次运行证据。整合时必须保留当前质量现代化计划的 reviewer/事实边界，不能因新 UI 只测组件渲染就判通过。

### 5. 恢复：旧 synopsis 恢复存在，最新 world-building 恢复会被回滚

donor 的 `.vela/partial_arch.json` 是旧架构情节大纲 checkpoint；当前 HEAD 新增的是世界观正文候选保留、恢复请求和提交前事实/配置/模板/正式内容重校验，两者不是同一功能。恢复验收必须分别覆盖：

- synopsis 分批/续批；
- world-building 中断候选保留与安全恢复；
- 草稿/审修未保存内容的项目切换与退出；
- Vela 路径迁移后旧 checkpoint 的一次性兼容读取与新路径写入。

### 6. “单独大纲章数”：独立配置缺失

- `src/components/editor/NovelConfigEditor.tsx:312-316` 只有 `config.totalChapters`。
- `src/components/dialogs/ArchitectureConfirmDialog.tsx:69-126,289-338` 提供“本次生成范围”的起止章，大项目默认 1–20；该值是一次 workflow 参数，不是独立持久的 `outlineChapterCount`。
- 在 donor 的 `src/shared` 与配置 UI 中没有 `outlineChapterCount` 类字段。

判定：如果需求是“每次大纲生成可指定章数”，现有 from/to 范围已静态实现；如果需求是“项目设置中有独立于总章数的默认大纲章数”，则目前缺字段、持久化、迁移和 workflow 消费契约，必须由计划明确二选一。

### 7. Skill：既有静态链完整

- `src/components/settings/SkillSettings.tsx:139-208,241-341` 提供 GitHub 来源检查、安装、阶段绑定、卸载。
- `src/shared/ipc-channels.ts:638-656` 声明 skills typed channels，main controller 有相应 IPC handler。
- `src/services/agent/writing-skill-bindings.ts:121-180` 保存阶段绑定并在 workflow 启动时冻结本次内容；review/refinement command 会传 `writingSkillStage`。

判定：不是 donor 新造的 UI-only 功能，整合应复用当前业务层。仍需用生产入口验证安装失败、非法 Skill、卸载已绑定 Skill、项目切换和实际 prompt 注入；本次审计没有这些运行证据。

### 8. 高级模型参数：已实现的范围有限且可追到 provider

- `ModelSettings.tsx:155-165,220-250` 允许 context window、max output tokens、temperature。
- `ReasoningPolicySettings.tsx:113-129` 允许 auto/off/low/medium/high reasoning override。
- `src/shared/ipc-channels.ts:743-755` 的 `ModelProfile` 持有 temperature/capabilities/maxTokens/reasoningOverride。
- `electron/llm/generation-parameter-policy.ts:52-75` 解析 temperature/maxTokens/reasoning，provider（例如 `electron/llm/openai-provider.ts:34-42`）消费解析值。

判定：这些参数有静态端到端链；没有发现 top-p、frequency penalty 等任意 provider 参数透传。计划不能笼统宣称“高级模型参数全部齐全”，应列出支持矩阵并以实际请求体/模型兼容性测试验收。

### 9. 批量：已有受控批量大纲与批量写作链

- 大纲：`ArchitectureConfirmDialog.tsx:69-126,289-338` 限定本次情节大纲范围。
- 章节蓝图：`DirectoryConfigDialog.tsx:176-294,367` 生成连续范围，`ChapterCardEditor.tsx:580-610` 通过 `launchCreativeWorkflow(generate_blueprint)` 启动。
- 批量写作：`ChapterCardEditor.tsx:748-757,871-875` 打开 dialog；`BatchChapterCreationDialog.tsx:81-102,245-260` 冻结模型/章数/模式，创建并启动 workflow；`batch-chapter-workflow.ts:17-54,286-368` 将批次限制在 1–10 章并按章执行。

判定：静态链存在；但 donor 会回滚草稿按章 synopsis 投影，因此整合后的批量链必须基于当前 `generate-draft.command`，并验证停止边界、项目 lease、模型冻结、草稿待审/自动定稿、失败后不继续下一章。

## 计划必须设置的整合门

### 合并前硬门

1. 当前 HEAD/`origin/master` 为业务基线；donor 仅作为冻结输入，禁止目录覆盖。
2. 先落统一 shell-mode 状态与 v1/v2 公共业务节点，再移植页面样式；不得分叉 store/commands/IPC。
3. 删除 donor 的项目切换清理逻辑，或先实现集中式未保存内容门禁；没有保存/放弃/取消回归测试不得启用写手默认。
4. world-building recovery、候选重校验、`synopsisForDraftChapter` 三组当前修复必须保留。
5. `.vela/avatars` 和 `.vela/partial_arch.json` 必须纳入 Vela 迁移 DAG；新代码不得继续写旧路径。
6. “备份”占位不能作为完成按钮；独立大纲章数需求必须明确语义后再分 Spec。

### 静态测试不足以关闭的运行门

- 两壳下逐个生产入口的按钮 smoke（不是只调用 store/API）；
- 有未保存正文/角色/配置/ledger 时切换作品和切换壳；
- 当前世界观/情节大纲恢复与拒绝提交反例；
- 批量写作基于当前上下文投影且停止/失败边界正确；
- 审稿→人工确认→审修→revision 的真实项目链；
- Skill prompt 实际注入与不兼容 Skill 拒绝；
- 高级参数在支持的 provider 请求体中出现、不支持的组合 fail closed；
- 头像导入、删除、重命名、DB 失败、迁移与导出/备份。

## 审计判定

donor 是可复用的 React 前端贡献，不是可直接替换的完整 1.1.0 产品。可复用优先级最高的是 `ShellV2`、v2 样式/页面编排、`ui-version-store` 的迁移思路、同事实源的 `RelationMap`；需要契约性重做的是项目切换清理、头像存储事务/Vela 路径；必须以当前源码为准保留的是世界观恢复、候选安全门和按章上下文投影。任何“所有功能/按钮/接口齐全”或“按钮均正常”的结论都没有证据支持。

