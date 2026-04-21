---
trigger: always_on
---

# Vela IDE — AI 驱动的小说创作 IDE 开发规范

> 本文档是 Vela 项目的完整开发规范，供 AI 编码助手和开发者共同遵循。
> 所有新代码、重构、组件开发都必须严格遵循以下规则。

---

## 一、项目概述

**Vela** 是一款基于 Electron + React + TypeScript 的 AI 深度驱动小说创作 IDE。
界面风格对标 JetBrains IDE（Darcula Warm / IntelliJ Light Warm），追求专业、紧凑、沉浸式写作体验。

### 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Electron 30 + Vite 5 |
| 前端 | React 18 + TypeScript 5（strict 模式） |
| 样式 | TailwindCSS 3 + CSS 变量主题系统 |
| 状态 | Zustand 5（无 Redux） |
| 编辑器 | CodeMirror 6（已从 TipTap 迁移） |
| UI 原语 | Radix UI（Dialog、Tooltip、Select 等） |
| 图标 | lucide-react |
| IPC | Electron ipcMain/ipcRenderer + 类型安全封装 |
| 数据库 | better-sqlite3（主进程） |
| 构建 | electron-builder |

### 目录结构

```
src/
├── App.tsx                    # 根组件（四区布局 + 全局弹窗挂载）
├── main.tsx                   # 入口
├── index.css                  # 全局样式 + CSS 变量主题 + @layer components
├── components/
│   ├── ui/                    # 公共 UI 组件（Button, Dialog, Toast 等）
│   ├── layout/                # 布局组件（TitleBar, StatusBar, ToolWindowBar 等）
│   ├── panels/                # 面板组件（Sidebar, EditorArea, BottomPanel, AIPanel）
│   ├── editor/                # 编辑器组件（CodeMirrorEditor, DraftEditor 等）
│   ├── dialogs/               # 业务对话框（NewProjectDialog, ChapterCreationDialog 等）
│   ├── settings/              # 设置面板（SettingsModal, ModelSettings）
│   ├── pages/                 # 页面组件（WelcomePage）
│   └── ErrorBoundary.tsx      # 全局错误边界
├── stores/                    # Zustand 状态仓库
│   ├── project-store.ts       # 项目状态
│   ├── editor-store.ts        # 编辑器 Tab 状态
│   ├── layout-store.ts        # 布局 + 全局弹窗状态
│   ├── theme-store.ts         # 主题 + 缩放 + 字体
│   ├── workflow-store.ts      # 工作流引擎
│   ├── llm-store.ts           # LLM 模型管理
│   ├── agent-store.ts         # AI 对话面板
│   └── draft-store.ts         # 草稿版本管理
├── services/                  # 业务逻辑服务
│   ├── ipc-client.ts          # 类型安全 IPC 客户端
│   ├── prompt-templates.ts    # Prompt 模板库（支持三级覆盖）
│   ├── workflow-guards.ts     # 工作流前置校验
│   ├── style-presets.ts       # 写作风格预设
│   ├── project-templates.ts   # 项目模板
│   ├── export-service.ts      # 导出服务
│   └── workflows/             # 工作流执行器
│       ├── architecture-workflow.ts  # 故事架构生成
│       ├── chapter-workflow.ts       # 章节创作流水线
│       └── directory-workflow.ts     # 章节蓝图生成
├── shared/                    # 渲染/主进程共享模块
│   ├── ipc-channels.ts        # IPC 频道类型定义（通信契约）
│   ├── project-paths.ts       # 项目目录结构常量
│   ├── draft-status.ts        # 草稿状态常量
│   └── provider-presets.ts    # LLM 服务商预设
├── hooks/                     # 自定义 React Hooks
│   └── useOutsideClick.ts     # 点击外部检测
├── lib/
│   └── utils.ts               # cn() 类名合并工具
└── utils/                     # 纯工具函数
    ├── frontmatter.ts         # YAML Frontmatter 解析
    ├── id.ts                  # UUID 生成
    └── time.ts                # 时间格式化
```

---

## 二、代码规范

### 2.1 语言与注释

```
✅ 所有代码注释必须使用中文
✅ JSDoc 注释使用中文描述
✅ 用户可见的文本（按钮、标签、提示）一律使用中文
✅ commit message 使用中文
```

### 2.2 文件命名规范

| 类型 | 命名规则 | 示例 |
|------|----------|------|
| React 组件（.tsx） | **PascalCase** | `NovelConfigEditor.tsx`, `IconBtn.tsx` |
| TypeScript 工具/服务（.ts） | **kebab-case** | `ipc-client.ts`, `prompt-templates.ts` |
| CSS 文件 | **kebab-case** | `novel-editor.css`, `index.css` |
| 共享常量/类型 | **kebab-case** | `ipc-channels.ts`, `project-paths.ts` |
| Zustand Store | **kebab-case + -store 后缀** | `project-store.ts`, `layout-store.ts` |

### 2.3 TypeScript 规范

```typescript
// ✅ 严格模式（tsconfig.json 中 strict: true）
// ✅ 使用 interface 优先于 type（公共 API 和 Props）
// ✅ 导出类型使用 export interface / export type
// ✅ 使用 Record<string, T> 代替 { [key: string]: T }
// ✅ 枚举值优先使用联合类型（type X = 'a' | 'b' | 'c'）

// 类型导入使用 import type
import type { ProjectData, NovelConfig } from '../shared/ipc-channels'

// Props 接口命名：组件名 + Props
export interface IconBtnProps {
  children: React.ReactNode
  title: string
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  badge?: number
  size?: number
}
```

### 2.4 导入路径规范

```typescript
// ✅ 相对路径导入（无 @ 别名）
import { useProjectStore } from '../stores/project-store'
import { ipc } from '../services/ipc-client'
import { Button } from './Button'

// ✅ 导入顺序（按层级）
// 1. React/第三方库
// 2. stores
// 3. services
// 4. shared/utils
// 5. components
// 6. 类型（import type）
```

### 2.5 ESLint / 代码质量

- 基于 `eslint:recommended` + `@typescript-eslint/recommended` + `react-hooks/recommended`
- `noUnusedLocals: true`，`noUnusedParameters: true`
- 禁止使用 `any`（尽可能用 `unknown` 替代）
- 禁止使用 `window.alert()` / `window.confirm()`（见交互规范）

---

## 三、UI 规范

### 3.1 设计风格

**核心风格：JetBrains IDE 风格（Darcula Warm / IntelliJ Light Warm）**

- 紧凑布局（22px 行高的树节点、24px 高度按钮、28px 面板标题栏）
- 低饱和色彩（品牌蓝紫 `#6b8afd`，非高饱和原色）
- 极简分割线（1px `--color-border`，几乎不可见）
- 无圆润泡泡风格，方正圆角（2-8px 阶梯）

### 3.2 主题系统

项目使用 **CSS 变量** 实现深色/浅色主题切换，所有颜色必须通过变量引用：

```css
/* ❌ 禁止硬编码颜色 */
color: #333;
background: rgba(0, 0, 0, 0.5);

/* ✅ 使用 CSS 变量 */
color: var(--color-text);
background: var(--color-sidebar);
border: 1px solid var(--color-border);
```

#### 颜色层次（从深到浅排列）

| 变量 | 用途 | 浅色值 | 深色值 |
|------|------|--------|--------|
| `--color-titlebar` | 标题栏 | `#e8e8e2` | `#1a1b1e` |
| `--color-activity-bar` | 活动栏 | `#e4e4de` | `#25272a` |
| `--color-sidebar` | 侧边栏/面板 | `#f0f0eb` | `#2b2d30` |
| `--color-bg` | 编辑器主体 | `#f8f8f2` | `#1e1f22` |
| `--color-hover` | 悬停态 | `#e1e1da` | `#35373b` |
| `--color-active` | 选中/激活态 | `#d5d5ce` | `#3d4045` |

#### 文字层次

| 变量 | 用途 | 浅色值 | 深色值 |
|------|------|--------|--------|
| `--color-text` | 主文字 | `#1a1a1e` | `#dde1e7` |
| `--color-text-secondary` | 次文字 | `#5c5f66` | `#9da3ae` |
| `--color-text-muted` | 弱化文字 | `#8c8f94` | `#828b9a` |

#### 强调色与语义色

| 变量 | 用途 |
|------|------|
| `--color-accent` | 主强调色（蓝紫） |
| `--color-accent-hover` | 强调悬停 |
| `--color-accent-rgb` | accent RGB 分量（用于 `rgba()` 半透明） |
| `--color-success` | 成功（绿） |
| `--color-warning` | 警告（黄） |
| `--color-error` | 错误（红） |
| `--color-info` | 信息（同 accent） |

### 3.3 尺寸规范

```css
/* 已在 :root 中定义的全局尺寸 */
--height-titlebar:    36px;
--height-statusbar:   22px;
--height-tab:         32px;
--height-panel-header: 28px;
--width-left-bar:     36px;
--width-right-bar:    30px;
--width-bottom-bar:   28px;

/* 圆角阶梯 */
--radius-sm: 2px;   /* 图标按钮、最小元素 */
--radius-md: 4px;   /* 按钮、输入框 */
--radius-lg: 6px;   /* 弹窗、卡片 */
--radius-xl: 8px;   /* 大型容器 */

/* 阴影层级 */
--shadow-sm:      轻微阴影
--shadow-md:      中等阴影
--shadow-lg:      强阴影
--shadow-popover: 弹出层阴影
```

### 3.4 过渡与动画

```css
/* 过渡时间 */
--transition-fast:   0.08s ease;   /* 悬停、颜色变化 */
--transition-normal: 0.15s ease;   /* 展开/收起、位移 */

/* 内置 Tailwind 动画 */
animate-fade-in          /* 淡入 */
animate-slide-in-right   /* 从右滑入 */
animate-slide-in-left    /* 从左滑入 */
animate-slide-in-up      /* 从下滑入 */
```

### 3.5 字体系统

```css
/* 三套字体族，均已本地内置（public/fonts/） */
--font-sans:    'Inter', system-ui, sans-serif;          /* UI 界面 */
--font-mono:    'JetBrains Mono', 'Fira Code', monospace; /* 代码 */
--font-writing: 'LXGW WenKai', 'Noto Serif SC', serif;  /* 写作正文 */
```

- UI 字体和写作字体均可在设置中独立切换
- 通过 `theme-store.ts` 的 `setUiFont()` / `setWritingFont()` 动态切换
- 可选字体：Inter、思源黑体、霞鹜文楷、思源宋体、系统默认

### 3.6 全局缩放

- 支持 70%-150% 缩放范围，步进 5%
- Electron 环境使用原生 `zoomFactor`，浏览器降级到 `html font-size`
- 快捷键：`Cmd/Ctrl + =` 放大、`Cmd/Ctrl + -` 缩小、`Cmd/Ctrl + 0` 重置

### 3.7 滚动条

- 宽度 6px，圆角 3px
- 轨道透明，滑块半透明灰色
- 深色/浅色模式分别定义

---

## 四、公共组件使用规范

### 4.1 按钮系统

#### `<Button>` — 主力按钮组件

基于 `class-variance-authority` 的多变体按钮。

```tsx
import { Button } from '../ui/Button'

// 变体（variant）
<Button variant="default">主要按钮</Button>        // 纯色 accent 背景
<Button variant="outline">描边按钮</Button>         // 透明背景 + 边框
<Button variant="ghost">幽灵按钮</Button>           // 无背景，悬停出现
<Button variant="destructive">危险操作</Button>     // 红色描边
<Button variant="gradient">渐变按钮</Button>        // accent→紫渐变
<Button variant="success">成功按钮</Button>         // 绿色渐变
<Button variant="pink">粉色按钮</Button>            // 粉红渐变

// 尺寸（size）
<Button size="sm">小按钮 (20px)</Button>
<Button size="default">默认 (24px)</Button>
<Button size="lg">大按钮 (28px)</Button>
<Button size="icon">图标按钮 (20x20)</Button>
```

#### `<IconBtn>` — 图标按钮

替代所有自定义图标按钮，统一样式。

```tsx
import { IconBtn } from '../ui/IconBtn'
import { Plus, Settings } from 'lucide-react'

<IconBtn title="添加" onClick={handleAdd}>
  <Plus size={14} />
</IconBtn>

<IconBtn title="设置" active={isActive} badge={3}>
  <Settings size={14} />
</IconBtn>

// Props
// - title: string          必需，鼠标悬停提示
// - active?: boolean       高亮激活态
// - badge?: number         > 0 时显示蓝色小圆点
// - disabled?: boolean     禁用
// - size?: number          尺寸因子（默认 6，即 24px）
```

### 4.2 对话框系统

#### `<Dialog>` — Radix 对话框封装

```tsx
import {
  Dialog, DialogContent, DialogHeader, DialogFooter,
  DialogTitle, DialogDescription,
} from '../ui/Dialog'

<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>对话框标题</DialogTitle>
      <DialogDescription>描述文本</DialogDescription>
    </DialogHeader>
    {/* 内容 */}
    <DialogFooter>
      <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
      <Button onClick={handleConfirm}>确认</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

#### `confirm()` — 异步确认对话框

**替代 `window.confirm()`**，返回 `Promise<boolean>`。

```tsx
import { confirm } from '../ui/Confirm'

const ok = await confirm('确定要删除此章节吗？', {
  title: '删除确认',         // 可选，默认 "确认操作"
  confirmText: '删除',       // 可选，默认 "确认"
  cancelText: '取消',        // 可选
  danger: true,              // 红色确认按钮
})
if (ok) { /* 执行删除 */ }
```

#### `alertError()` — 错误弹窗

**替代 `window.alert()`**，返回 `Promise<void>`。

```tsx
import { alertError } from '../ui/AlertDialog'

// fire-and-forget（不阻塞）
alertError('不是有效的 Vela 项目目录', { title: '打开项目失败' })

// 或等待用户确认后继续
await alertError('写入失败，请检查磁盘权限。')
```

### 4.3 通知系统

#### `toast` — 非阻塞 Toast 通知

```tsx
import { toast } from '../ui/Toast'

toast.success('保存成功')           // 3.5s 自动消失
toast.warning('字数超出限制')       // 4.5s
toast.info('提示信息')              // 4s
toast.error('操作失败')             // 5s

// 自定义持续时间
toast.success('已导出', 2000)
```

**使用优先级**：
1. **toast** — 轻量操作反馈（保存成功、复制完成等）
2. **alertError** — 关键错误（项目加载失败、文件读写错误）
3. **confirm** — 需要用户决策（删除、归档、覆盖等）

### 4.4 表单控件

#### `<Input>` — 文本输入框

```tsx
import { Input } from '../ui/Input'
<Input placeholder="请输入..." value={val} onChange={e => setVal(e.target.value)} />
// 高度 28px，圆角 md，聚焦时 accent 环
```

**⚠️ 数字输入框特殊规范（极其重要）**：
为了保证用户能够将输入框的内容完全删空，禁止在 `onChange` 中使用 `parseInt(val) || defaultValue` 强制转换并回退默认值。
必须使用以下模式：
```tsx
const [num, setNum] = useState<number | ''>(10)

<Input
  type="number"
  value={num}
  // 1. onChange 中允许空字符串
  onChange={e => setNum(e.target.value === '' ? '' : Number(e.target.value))}
  // 2. 在 onBlur 中处理最小值和默认值回退
  onBlur={() => {
    const v = Number(num)
    if (!v || v < 1) setNum(1) // 假设最小值为 1
  }}
/>
```

#### `<Textarea>` — 多行文本

```tsx
import { Textarea } from '../ui/Textarea'
<Textarea placeholder="请输入..." rows={4} />
// 可拖拽调整高度，最小 60px
```

#### `<NativeSelect>` — 原生下拉选择

```tsx
import { NativeSelect } from '../ui/NativeSelect'
<NativeSelect value={val} onChange={e => setVal(e.target.value)}>
  <option value="a">选项 A</option>
  <option value="b">选项 B</option>
</NativeSelect>
// 轻量替代 Radix Select，适合简单场景
```

#### `<Label>` — 表单标签

```tsx
import { Label } from '../ui/Label'
<Label htmlFor="name">名称</Label>
// text-xs，color-text-muted，block 布局
```

### 4.5 右键菜单

#### `<ContextMenu>` — 通用右键菜单

```tsx
import { ContextMenu, type ContextMenuEntry } from '../ui/ContextMenu'

const items: ContextMenuEntry[] = [
  { key: 'edit', label: '编辑', icon: <Edit size={14} />, onClick: handleEdit },
  { key: 'copy', label: '复制', shortcut: '⌘C', onClick: handleCopy },
  { key: 'div1', type: 'divider' },
  { key: 'delete', label: '删除', danger: true, onClick: handleDelete },
]

{showMenu && (
  <ContextMenu
    items={items}
    position={{ x: menuPos.x, y: menuPos.y }}
    onClose={() => setShowMenu(false)}
  />
)}
```

### 4.6 菜单项

#### `<MenuItem>` — 通用菜单项按钮

```tsx
import { MenuItem } from '../ui/MenuItem'

<MenuItem label="新建章节" icon={<Plus size={14} />} onClick={handleNew} />
<MenuItem label="删除" danger onClick={handleDelete} />
<MenuItem label="即将推出" disabled />
```

### 4.7 CSS 组件类（@layer components）

在 `index.css` 的 `@layer components` 中定义了可复用 CSS 类：

| 类名 | 用途 | 示例 |
|------|------|------|
| `.panel-header` | 面板标题栏 | `<div className="panel-header">` |
| `.tree-item` | 树节点 | `<div className="tree-item active">` |
| `.btn-primary` | 主色按钮（CSS） | 优先使用 `<Button>` 组件 |
| `.btn-ghost` | 幽灵按钮（CSS） | 优先使用 `<Button variant="ghost">` |
| `.icon-btn` | 图标按钮（CSS） | 优先使用 `<IconBtn>` 组件 |
| `.config-input` | 配置编辑器输入框 | 简单表单场景 |
| `.tool-btn` | 工具窗口栏按钮 | LeftToolWindowBar 专用 |
| `.bottom-tool-btn` | 底部工具栏按钮 | BottomToolWindowBar 专用 |

### 4.8 通用 Hooks

#### `useOutsideClick` — 点击外部检测

```tsx
import { useOutsideClick } from '../hooks/useOutsideClick'

const menuRef = useRef<HTMLDivElement>(null)
const [open, setOpen] = useState(false)

// 第三个参数 enabled：菜单关闭时暂停监听，减少事件开销
useOutsideClick(menuRef, () => setOpen(false), open)
```

### 4.9 工具函数

```typescript
// 类名合并（Tailwind + clsx）
import { cn } from '../lib/utils'
className={cn('base-class', isActive && 'active-class', className)}

// UUID 生成
import { randomUUID } from '../utils/id'
const id = randomUUID()

// 时间格式化
import { formatRelativeTime, formatDate } from '../utils/time'
formatRelativeTime(timestamp)  // → "5分钟前"
formatDate(timestamp)          // → "2026/04/07 17:52"

// Frontmatter 解析
import { extractFrontmatter, mergeFrontmatterBody } from '../utils/frontmatter'
const { frontmatter, body } = extractFrontmatter(fileContent)
```

---

## 五、交互规范

### 5.1 弹窗与通知

| 场景 | 组件 | 示例 |
|------|------|------|
| 操作成功反馈 | `toast.success()` | 保存成功、导出完成 |
| 操作警告 | `toast.warning()` | 字数不足、配置不完整 |
| 一般信息 | `toast.info()` | 提示信息 |
| 关键错误 | `alertError()` | 项目加载失败、磁盘权限 |
| 用户决策确认 | `confirm()` | 删除、归档、覆盖 |
| 复杂表单/配置 | `<Dialog>` | 新建项目、章节创建、导出 |

**严禁使用**：
```
❌ window.alert()
❌ window.confirm()
❌ window.prompt()
```

### 5.2 全局弹窗控制

所有全局弹窗（设置、新建项目、导出等）通过 `layout-store` 管理，**禁止使用 `window.dispatchEvent` 事件总线**。

```typescript
import { useLayoutStore } from '../stores/layout-store'

// ✅ 正确：通过 store 控制
useLayoutStore.getState().openSettings()
useLayoutStore.getState().openNewProject()
useLayoutStore.getState().openChapterCreation({ chapterNumber: 5 })

// ❌ 错误：事件总线
window.dispatchEvent(new CustomEvent('open-settings'))
```

### 5.3 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd/Ctrl + N` | 新建项目 |
| `Cmd/Ctrl + O` | 打开项目 |
| `Cmd/Ctrl + =` | 放大 |
| `Cmd/Ctrl + -` | 缩小 |
| `Cmd/Ctrl + 0` | 重置缩放 |

### 5.4 编辑器 Tab 状态管理

```typescript
import { useEditorStore } from '../stores/editor-store'

// 打开文件（已打开则激活）
useEditorStore.getState().openFile({
  id: 'unique-id',
  name: '第1章',
  type: 'chapter',        // 支持类型见 EditorTab['type']
  filePath: '/path/to/file.md',
  content: '...',
})

// 用户编辑 → 标记 dirty
updateTabContent(tabId, newContent)    // 亮起未保存指示灯

// AI 生成刷新 → 静默同步（不标记 dirty）
syncTabContent(tabId, aiGeneratedText)

// 保存后清除 dirty
markTabSaved(tabId)
```

### 5.5 侧边栏视图切换

```typescript
// 点击活动栏图标：如果已是当前视图则 toggle 侧边栏，否则切换视图
setSidebarView(view: 'project' | 'knowledge' | 'characters' | 'settings')
```

---

## 六、状态管理规范（Zustand）

### 6.1 Store 命名与导出

```typescript
// 文件名：xxx-store.ts
// Hook 名：useXxxStore
// 导出方式：named export

// ✅ 标准模式
export const useProjectStore = create<ProjectState>()((set, get) => ({
  // 状态
  currentProject: null,

  // Actions（直接在对象中定义）
  openProject: async (path) => { ... },
}))
```

### 6.2 Store 职责划分

| Store | 职责 |
|-------|------|
| `project-store` | 项目 CRUD、小说配置、文件树 |
| `editor-store` | Tab 列表、active tab、dirty 状态 |
| `layout-store` | 面板开关、尺寸、全局弹窗开关 |
| `theme-store` | 主题、缩放、字体（持久化到 localStorage） |
| `workflow-store` | 工作流引擎、步骤状态、全局日志 |
| `llm-store` | 模型管理、生成请求 |
| `agent-store` | AI 对话面板、会话管理 |
| `draft-store` | 草稿版本管理、定稿操作 |

### 6.3 跨 Store 调用

```typescript
// ✅ 在 action 内跨 store 调用（通过 getState()）
openProject: async (path) => {
  const result = await ipc.invoke('project:open', path)
  // 跨 store 操作
  useEditorStore.getState().clearTabs()
}

// ❌ 避免循环依赖（使用延迟导入）
let _clearEditorTabs: (() => void) | null = null
async function clearEditorTabs() {
  if (!_clearEditorTabs) {
    const { useEditorStore } = await import('./editor-store')
    _clearEditorTabs = () => useEditorStore.getState().clearTabs()
  }
  _clearEditorTabs()
}
```

### 6.4 数据持久化

- `theme-store` 使用 `zustand/middleware/persist` 自动持久化到 `localStorage`
- 项目数据通过 IPC 持久化到文件系统（`project:save`）
- 模型配置通过 IPC 持久化到 `~/.vela/` 目录

---

## 七、IPC 通信规范

### 7.1 类型安全调用

所有 IPC 调用必须通过 `ipc-client.ts` 封装，确保类型安全：

```typescript
import { ipc } from '../services/ipc-client'

// ✅ 类型安全调用（自动推断参数和返回类型）
const result = await ipc.invoke('project:open', projectPath)
// result 类型自动为 { success: boolean; project: ProjectData | null; error?: string }

// ✅ 监听事件（返回 unsubscribe 函数）
const unsub = ipc.on('llm:stream-chunk', (data) => {
  console.log(data.chunk)  // data 类型自动推断
})
// 组件卸载时取消
useEffect(() => unsub, [])
```

### 7.2 IPC 频道命名

```
namespace:action
```

| 命名空间 | 用途 | 示例 |
|----------|------|------|
| `config:` | 全局配置 | `config:get`, `config:set` |
| `project:` | 项目管理 | `project:create`, `project:open` |
| `fs:` | 文件系统 | `fs:read-file`, `fs:write-file` |
| `llm:` | LLM 调用 | `llm:generate`, `llm:generate-stream` |
| `db:` | 数据库 | `db:upsert-chapter`, `db:get-all-chapters` |
| `kb:` | 知识库 | `kb:import-document`, `kb:search` |
| `dialog:` | 原生对话框 | `dialog:select-folder` |

### 7.3 新增 IPC 频道

在 `src/shared/ipc-channels.ts` 中：
1. 在对应的 `interface XxxChannels` 中添加新频道定义
2. 在主进程 `electron/ipc-handlers.ts` 中添加处理器
3. 所有频道返回值统一使用 `{ success: boolean; error?: string; ... }` 模式

---

## 八、项目目录结构常量

所有项目内的文件/目录路径通过 `src/shared/project-paths.ts` 集中管理：

```typescript
import { CONFIG_FILE, DIR_ARCHITECTURE, DIR_CHARACTERS, ... } from '../shared/project-paths'

// 顶层目录按创作工作流阶段编号：
// 01_novel_config.json   — 小说配置
// 02_architecture/       — 故事架构
// 03_characters/         — 角色卡
// 04_blueprints/         — 章节蓝图
// 05_global_summary.md   — 全局摘要
// 06_drafts/             — 草稿
// 07_manuscript/         — 定稿正文
// 08_prompts/            — 项目提示词
// .vela/                 — 内部系统（数据库等）

// ✅ 正确：通过常量拼接路径
const configPath = `${project.path}/${CONFIG_FILE}`

// ❌ 错误：硬编码路径
const configPath = `${project.path}/01_novel_config.json`
```

---

## 九、Prompt 规范

### 9.1 模板系统架构

Prompt 模板定义在 `src/services/prompt-templates.ts`，支持三级覆盖：

```
内置模板 → 全局自定义（~/.vela/prompts/） → 项目级覆盖（08_prompts/）
```

### 9.2 模板结构

```typescript
export interface PromptTemplate {
  key: string                          // 模板唯一标识
  name: string                         // 显示名称
  description: string                  // 用途说明
  content: string                      // 模板内容（支持 {{变量}} 插值）
  variables: Record<string, string>    // 可用变量说明
}
```

### 9.3 变量插值

```typescript
import { getPromptTemplate, renderPrompt } from '../services/prompt-templates'

const template = getPromptTemplate('core_seed')!
const rendered = renderPrompt(template, {
  genre: '玄幻',
  topic: '少年意外获得上古传承...',
  number_of_chapters: '200',
  // ...
})
```

### 9.4 内置 Prompt 模板清单

| Key | 名称 | 用途 |
|-----|------|------|
| `generate_global_config` | 全文配置生成 | 一句话灵感 → 完整配置 JSON |
| `core_seed` | 故事前提 | 架构第1步：Logline + 冲突链 |
| `character_dynamics` | 角色图谱 | 架构第2步：角色关系网 |
| `world_building` | 世界观构建 | 架构第3步：世界观矩阵 |
| `plot_architecture` | 情节大纲 | 架构第4步：按结构模式生成大纲 |
| `chapter_blueprint` | 章节蓝图（全量） | 一次性生成所有章节蓝图 |
| `chapter_blueprint_chunk` | 章节蓝图（分块） | 续写后续章节蓝图 |
| `first_chapter_draft` | 第一章草稿 | 黄金第一章创作 |
| `next_chapter_draft` | 后续章节草稿 | 基于上下文续写 |
| `refine_chapter` | 大神级修稿 | 草稿 → 精修版 |
| `consistency_check` | 一致性审稿 | 检查角色/剧情/世界观一致性 |
| `update_global_summary` | 更新全局摘要 | 定稿后更新编年史 |
| `update_character_state` | 更新角色状态 | 定稿后更新角色档案 |
| `generate_chapter_notes` | 章节要点生成 | 定稿后生成结构化要点 |
| `update_character_cards` | 更新角色卡状态 | 以 JSON 更新角色卡 currentState |
| `infer_novel_config` | 逆向推演配置 | 从已有内容反推配置（旧作续写） |

### 9.5 Prompt 设计原则

1. **角色设定**：始终赋予 AI 一个专业角色（"顶尖网文白金作家"、"资深主编"等）
2. **结构化输出**：明确要求输出格式（JSON / Markdown 小节标题）
3. **参数注入**：使用 `{{变量名}}` 占位符，由 `renderPrompt()` 填充
4. **防偏离守则**：关键参数（如总章数）反复强调，防止 AI 忽略
5. **负面约束**：明确列出禁忌（"禁止废话"、"禁止 Markdown 代码块"）
6. **格式限制**：JSON 输出要求 "直接可 `JSON.parse`，不含代码块标签"

### 9.6 自定义 Prompt

```typescript
import { saveCustomPrompt, deleteCustomPrompt } from '../services/prompt-templates'

// 保存自定义覆盖（存到 ~/.vela/prompts/xxx.json）
await saveCustomPrompt({
  key: 'core_seed',  // 同名覆盖内置
  name: '自定义故事前提',
  description: '...',
  content: '...',
  variables: { ... },
})

// 删除自定义覆盖（恢复为内置版本）
await deleteCustomPrompt('core_seed')
```

---

## 十、工作流规范

### 10.1 工作流引擎

工作流通过 `workflow-store.ts` 管理，支持步进模式、暂停、取消。

```typescript
import { useWorkflowStore, type WorkflowDefinition } from '../stores/workflow-store'

const definition: WorkflowDefinition = {
  type: 'architecture_generation',
  title: 'AI 生成故事架构',
  steps: [
    {
      name: '生成故事前提',
      description: '提炼核心卖点与冲突链',
      executor: async (step, context, callbacks) => {
        callbacks.log('开始生成...')
        callbacks.setProgress(50)
        callbacks.appendText('流式文本...')
        // context.data 可在步骤间传递数据
        context.data.coreSeed = result
        return result
      },
    },
    // ...更多步骤
  ],
}

// 启动（stepByStep=true 每步完成后暂停等待确认）
await useWorkflowStore.getState().startWorkflow(definition, true)
```

### 10.2 工作流前置校验

在启动工作流前必须通过 `workflow-guards.ts` 校验上游数据：

```typescript
import { guardArchitectureGeneration, guardDirectoryGeneration } from '../services/workflow-guards'

// 示例：生成架构前校验
const guard = guardArchitectureGeneration()
if (!guard.ok) {
  alertError(guard.message!, { title: '无法生成架构' })
  return
}
```

### 10.3 工作流类型

| 类型 | 步骤 |
|------|------|
| `architecture_generation` | 故事前提 → 角色图谱 → 世界观 → 情节大纲 |
| `chapter_creation` | 写稿 → 修稿 → 审稿 → 定稿 |
| `new_project_setup` | 配置 → 架构 → 目录 |
| `batch_generate` | 批量生成 |

---

## 十一、错误处理规范

### 11.1 组件级

- 关键面板使用 `<ErrorBoundary>` 包裹，防止单个组件崩溃连带整个应用
```tsx
<ErrorBoundary fallbackLabel="侧边栏渲染失败">
  <Sidebar />
</ErrorBoundary>
```

### 11.2 IPC 调用

```typescript
// ✅ 检查返回值的 success 字段
const result = await ipc.invoke('project:open', path)
if (!result.success) {
  alertError(result.error ?? '未知错误', { title: '打开项目失败' })
  return
}

// ✅ try-catch 包裹 IPC 调用
try {
  const result = await ipc.invoke('fs:read-file', path)
  // ...
} catch (e) {
  alertError(String(e), { title: '文件读取异常' })
}
```

### 11.3 日志规范

```typescript
// 使用 console 命名空间前缀
console.log('[Project] 打开成功:', path)
console.warn('[Vela IPC] velaAPI 未注入')
console.error('[ErrorBoundary] 组件崩溃:', error)

// 工作流日志通过 workflow-store
useWorkflowStore.getState().addLog('info', '🚀 工作流已启动')
useWorkflowStore.getState().addLog('error', '❌ 步骤失败: ...')
```

---

## 十二、关键设计决策记录

1. **不使用 Redux** — 全部使用 Zustand，减少样板代码
2. **不使用 @ 路径别名** — 全部使用相对路径（团队共识）
3. **禁止 window 事件总线** — 全局状态通过 `layout-store` 管理
4. **CSS 变量 > Tailwind 颜色** — 所有颜色通过 CSS 变量实现主题切换
5. **编辑器迁移到 CodeMirror 6** — 替代 TipTap，更好的性能和滚动稳定性
6. **Electron 原生缩放** — 优先使用 `webContents.setZoomFactor()`
7. **目录编号排列** — `01_xxx` 格式，用户在文件管理器中一目了然
8. **草稿 Frontmatter** — 使用 YAML frontmatter 管理草稿元数据（状态、版本号）
9. **数字无补零** — 章节号等数字不补零（`ch1` 而非 `ch001`），依赖数值排序
10. **字体本地化** — 所有字体内置到 `public/fonts/`，不依赖外部 CDN
