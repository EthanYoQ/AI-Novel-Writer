# AI小说作家 Frontend Visual Redesign Design

## Goal

将现有 Vela 前端可见界面重写为 `AI小说作家 / AI Novel Writer` 的新视觉语言，同时严格保留原本设计结构、功能、按钮、布局和工作流。

本阶段只做前端视觉重写，不改变业务逻辑、数据结构、项目文件格式、模型调用链、导入/生成/蓝图/写稿流程。

## Confirmed Visual Target

用户已确认 `retain-layout-labeled-nav-005` 方案。

本方案的设计依据：

- 保留现有 Electron/React IDE 型布局。
- 保留顶部标题栏、左侧主导航、项目结构侧栏、中心编辑区、右侧 AI 面板、底部任务区、状态栏。
- 左侧主导航从纯图标改为 `图标 + 中文文字标签`。
- 颜色从当前深色/冷色系改为暖纸感写作工作台。
- 图标采用剧情控制台风格：统一、线性、功能明确、Lucide-like。
- 可见品牌文案从 `Vela` 改为 `AI小说作家 / AI Novel Writer`。

浏览器设计稿位于本地设计会话：

- `C:\SoftWare\FUN\Local AI\apps\vela\.superpowers\brainstorm\482-1781937336\content\retain-layout-labeled-nav-005.html`
- `C:\SoftWare\FUN\Local AI\apps\vela\.superpowers\brainstorm\482-1781937336\content\ai-novel-writer-retain-layout-labeled-nav.png`

这些文件是本地设计参考，不提交到 Git。

## Hard Constraints

必须保留：

- 原有功能。
- 原有按钮位置。
- 原有主布局。
- 原有面板分区。
- 原有业务流程。
- 原有项目数据读写路径和协议行为。
- 原有模型配置、生成、导入、蓝图、角色、世界观、草稿、审阅、任务等入口。

允许改变：

- 可见品牌文案。
- 颜色 token。
- 图标风格。
- 左侧主导航宽度与标签显示。
- 加载页视觉文案和 CSS class 命名。
- README 中与前端视觉相关的截图说明，后续发布阶段另行处理。

禁止改变：

- 不新增新的 dashboard 信息架构。
- 不移动项目结构侧栏、中心编辑区、右侧 AI 面板、底部任务区。
- 不删除现有按钮。
- 不改变按钮触发的行为。
- 不改变 IPC channel 名称。
- 不改变 `vela://` 内部协议。
- 不改数据库 schema。
- 不改项目 `.vela` 数据目录。
- 不引入 emoji、Unicode 伪图标、手写 SVG path 或几何占位图标。
- 不引入无关图像、营销页、hero 页面或装饰性光斑。

## Product Name And Copy

主产品名：

- 中文：`AI小说作家`
- 英文：`AI Novel Writer`

前端可见位置替换：

- 窗口标题栏中的 `Vela`。
- 欢迎页标题 `欢迎使用 Vela`。
- 欢迎页副标题。
- 状态栏 `Vela v0.1.0`。
- AI 面板中的助手品牌名。
- HTML 初始加载页标题与加载文案。

可见文案不得再出现 `Vela`。

非本阶段范围：

- `package.json` 包名、`electron-builder` appId/productName、配置目录、内部协议、日志前缀、README/GitHub 发布文案的完整去 Vela 化。这属于发布重命名与隐私清理阶段，后续单独计划，避免破坏当前前端视觉改造的低风险边界。

## Layout Specification

整体布局保持现状：

- `TitleBar`：保留标题栏高度、窗口控制区、缩放/主题/设置入口。
- `ActivityBar`：改为带文字标签的主导航栏。
- `Sidebar`：保留项目结构、树节点、最近项目、上下文菜单。
- `EditorArea`：保留 tab、编辑器、配置编辑、正文编辑、diff/review 视图。
- `AIPanel` / `AIOutputPanel`：保留右侧 AI 输入与输出区域。
- `BottomPanel`：保留任务面板。
- `StatusBar`：保留模型、项目、任务、版本状态。

左侧主导航标签：

- `首页`
- `项目`
- `小说`
- `蓝图`
- `角色`
- `世界`
- `AI`
- `任务`
- `设置`

导航交互要求：

- 图标与文字对齐，文字必须可读。
- 当前激活项有明确背景与状态提示。
- tooltip 可保留，但不能成为识别入口的唯一方式。
- 右键项目菜单、最近项目、关闭项目行为保持不变。

## Design Tokens

使用暖纸感 token，不采用单一紫蓝或深 slate 主导。

建议色值：

| Token | Value | Purpose |
|---|---:|---|
| `bg` | `#F8F1E7` | app 背景 |
| `editorBg` | `#FFF9EF` | 编辑器与正文区域 |
| `sidebar` | `#EEE2D0` | 左侧项目侧栏 |
| `panel` | `#F5EBDD` | 面板底色 |
| `titlebar` | `#E8D8C1` | 顶部标题栏 |
| `activityBar` | `#DDC8AA` | 左侧主导航 |
| `hover` | `#EFE1CD` | hover |
| `active` | `#E1C49A` | active 背景 |
| `text` | `#2E261D` | 主文字 |
| `textSecondary` | `#6F5F4A` | 次级文字 |
| `textMuted` | `#9A866E` | 弱文字 |
| `border` | `#D4BFA4` | 边框 |
| `accent` | `#7A5732` | 主按钮与选中 |
| `accentHover` | `#684929` | 主按钮 hover |
| `gold` | `#B68A4A` | 次强调 |
| `success` | `#5D8A67` | 成功状态 |
| `warning` | `#C68A3A` | 警告状态 |
| `error` | `#B94A48` | 错误状态 |
| `info` | `#6E7F8F` | 信息状态 |
| `focusRing` | `rgba(122, 87, 50, 0.38)` | 焦点 |

尺寸约束：

- 主布局尺寸保持现有 token，不做大规模间距重排。
- 左侧主导航可加宽到适合 `图标 + 标签` 的固定宽度。
- 卡片/按钮圆角不超过 8px，除非现有组件已使用更大圆角且回收成本不值得。
- 字体不随视口宽度缩放。
- letter spacing 保持 `0`。

## Icon System

优先使用项目已有 `lucide-react`。

图标规则：

- 统一线性风格。
- 建议 stroke width：`1.75` 或项目全局统一值。
- 同组图标尺寸统一。
- 所有按钮图标必须能表达功能。
- 不使用 emoji。
- 不使用手写 SVG path。
- 不使用纯几何占位图标。
- 如 lucide 缺失，先通过本地 MCP 搜索补齐，再决定是否引入。

左侧导航建议映射：

| Label | Icon Intent |
|---|---|
| 首页 | Home |
| 项目 | Folder / FolderOpen |
| 小说 | BookOpen |
| 蓝图 | ListTree / Workflow |
| 角色 | Users |
| 世界 | Globe2 |
| AI | Sparkles / Bot |
| 任务 | ListChecks |
| 设置 | Settings |

## Component Impact

预计改动文件：

- `src/tokens/index.ts`
  - 增加或替换暖纸感主题 token。
  - 保留 token shape，避免破坏现有 CSS 变量注入。

- `src/index.css`
  - 更新全局 CSS 变量映射。
  - 更新 loader、brand-gradient、ai-glow、panel、input、button、scrollbar、selection 等视觉样式。

- `index.html`
  - 初始加载页从 `Vela` 改为 `AI小说作家`。
  - `localStorage` theme key 优先保留旧 key 兼容，不做破坏性迁移。
  - CSS class 可从 `vela-*` 改为中性或 `ainw-*`，前提是同步更新引用。

- `src/components/layout/TitleBar.tsx`
  - 可见品牌改为 `AI小说作家`，保留按钮与布局。

- `src/components/layout/ActivityBar.tsx`
  - 保留原交互。
  - 将 icon-only 改为 icon + text label。
  - 导航项扩展为明确标签。
  - 不移动项目菜单逻辑。

- `src/components/layout/StatusBar.tsx`
  - 可见品牌改为 `AI小说作家` 或 `AI Novel Writer`。
  - 保留状态 segment 行为。

- `src/components/pages/WelcomePage.tsx`
  - 可见品牌与副标题改写。
  - 保留三项操作按钮和最近项目布局。

- `src/components/panels/AIPanel.tsx`
  - 可见助手名称改写。
  - 保留输入框、模型选择、发送按钮、slash/mention 逻辑。

- `src/components/panels/AIOutputPanel.tsx`
  - 标题和颜色 token 调整。
  - 保留输出、任务状态、停止生成行为。

- `src/components/ui/Icon.tsx`
  - 如需要，集中设置 lucide 默认 stroke width 和 class。
  - 不改变调用方 API。

## Data And Behavior

本阶段不得修改：

- Electron IPC channel。
- LLM provider。
- OpenAI/Ollama 配置。
- 参考小说导入流程。
- 蓝图生成流程。
- 草稿生成流程。
- 数据库 schema。
- 项目路径解析。
- `.vela` 项目目录。

## Acceptance Criteria

必须满足：

- 应用可启动。
- 所有现有主面板仍可打开。
- 左侧主导航显示图标和文字。
- 左侧导航标签不溢出、不遮挡侧栏。
- 项目结构侧栏仍正常展示。
- 中心编辑区仍正常展示配置、正文、蓝图、审阅等 tab。
- 右侧 AI 面板仍可打开并保留输入/输出控件。
- 底部任务面板仍展示任务状态。
- 可见界面不出现 `Vela`。
- 界面无 emoji 图标、无手写 SVG path、无几何占位图标。
- 主色与背景符合暖纸感 token。
- `npm exec tsc -- --noEmit` 通过。
- 相关组件测试通过；如无测试，补最小渲染/行为测试。
- 不提交 `.superpowers/`、`.codegraph/`、本机小说数据、API key、模型路径、用户配置。

## Verification Plan

代码验证：

- `npm exec tsc -- --noEmit`
- 运行受影响组件测试。
- 搜索可见品牌字符串，确认 UI 文案不再出现 `Vela`。
- 搜索 emoji/伪图标模式，确认左侧导航和状态文案不使用 emoji。

视觉验证：

- 启动 Vite/Electron 开发环境。
- 截图欢迎页、项目打开页、小说配置页、角色页、AI 输出页。
- 对照设计稿检查：
  - 主布局未变。
  - 左侧导航有文字。
  - 图标风格统一。
  - 文本不溢出。
  - 按钮位置未移动。
  - 面板边界清晰。

隐私验证：

- `git status --short` 确认不会提交 `.superpowers/`、`.codegraph/`、用户项目、`.env`、`.vela` 配置、小说正文或大纲。
- `rg` 检查 API key/token 模式，发现后不得提交。

## Out Of Scope For This Spec

以下任务后续单独处理：

- 整仓库、包名、appId、配置目录、内部协议、日志前缀的完整去 Vela 化。
- GitHub 新仓库创建与推送。
- README 中英文重写。
- 隐私清理与发布包审计。
- 图标 MCP 补齐以外的新图标库引入。
- 业务功能修复或重构。
