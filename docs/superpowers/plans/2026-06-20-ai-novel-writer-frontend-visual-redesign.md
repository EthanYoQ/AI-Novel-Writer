# AI小说作家 Frontend Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the existing Vela frontend as `AI小说作家 / AI Novel Writer` while preserving the original layout, functions, buttons, panels, and workflows.

**Architecture:** Keep the current Electron + React shell intact. Add a small brand constant module, replace visible frontend copy, update existing theme tokens/CSS variables, and change the real mounted left rail (`LeftToolWindowBar`) from icon-only buttons to icon + Chinese labels. No IPC, database, provider, workflow, or project format changes.

**Tech Stack:** React 19, TypeScript, Vite, Electron, Tailwind CSS v4, Zustand, lucide-react, Vitest.

---

## Scope Lock

This plan implements only the confirmed frontend visual redesign spec:

- Spec: `docs/superpowers/specs/2026-06-20-ai-novel-writer-frontend-visual-redesign-design.md`
- Design target: `.superpowers/brainstorm/482-1781937336/content/retain-layout-labeled-nav-005.html`

Do not change:

- Project data directories or `.vela` project folders.
- `vela://` internal protocol.
- IPC channel names.
- LLM/model/generation/import/blueprint behavior.
- Main panel layout order or button actions.
- GitHub/README/package/appId rename. Those are out of scope.

## File Structure

- Create `src/shared/brand.ts`
  - Single source of truth for visible frontend brand copy.

- Create `src/shared/__tests__/brand.test.ts`
  - Verifies brand constants no longer expose `Vela`.

- Modify `src/tokens/index.ts`
  - Update `paper` theme to the accepted warm writer-studio token set.
  - Keep the `tokens` object shape unchanged.

- Create `src/tokens/__tests__/tokens.test.ts`
  - Verifies warm paper token values and no purple primary accent in `paper`.

- Modify `src/index.css`
  - Update visible comments and CSS custom properties for `:root` and `.paper`.
  - Add `.left-nav-label`, `.left-nav-button`, and warm brand utility styles.

- Modify `index.html`
  - Replace visible title and loader text with `AI小说作家`.
  - Keep existing `localStorage` theme key for compatibility.

- Modify `src/components/layout/LeftToolWindowBar.tsx`
  - Add labels to every far-left navigation item.
  - Keep existing actions and stores.
  - Use only lucide-react icons.

- Create `src/components/layout/__tests__/LeftToolWindowBar.test.tsx`
  - Server-renders the component and verifies labels exist.

- Modify `src/components/layout/TitleBar.tsx`
  - Replace visible app name with brand constants.

- Modify `src/components/layout/StatusBar.tsx`
  - Replace `Vela` status copy with brand constants.

- Modify `src/components/pages/WelcomePage.tsx`
  - Replace visible app copy and remove `Vela` from visible UI.

- Modify `src/components/panels/agent/AgentHeader.tsx`
  - Replace `AGENT` header with `AI 写作助手`.
  - Replace hand-written history SVG with lucide `History`.

- Modify `src/components/panels/agent/AgentConversation.tsx`
  - Replace empty-state brand text.
  - Replace hand-written SVG icons with lucide icons.
  - Keep conversation behavior unchanged.

- Modify `src/components/panels/AIOutputPanel.tsx`
  - Keep title/function, ensure icon style remains lucide-only.

## Task 1: Brand Constants And Visible Copy Tests

**Files:**

- Create: `src/shared/brand.ts`
- Create: `src/shared/__tests__/brand.test.ts`
- Modify: `index.html`
- Modify: `src/components/layout/TitleBar.tsx`
- Modify: `src/components/layout/StatusBar.tsx`
- Modify: `src/components/pages/WelcomePage.tsx`
- Modify: `src/components/panels/agent/AgentConversation.tsx`

- [ ] **Step 1: Write the failing brand constants test**

Create `src/shared/__tests__/brand.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { APP_BRAND } from '../brand'

describe('APP_BRAND', () => {
  it('uses AI小说作家 visible product language', () => {
    expect(APP_BRAND.zhName).toBe('AI小说作家')
    expect(APP_BRAND.enName).toBe('AI Novel Writer')
    expect(APP_BRAND.shortName).toBe('AI小说作家')
    expect(Object.values(APP_BRAND).join(' ')).not.toMatch(/\bVela\b/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm exec vitest -- run src/shared/__tests__/brand.test.ts
```

Expected: FAIL because `src/shared/brand.ts` does not exist.

- [ ] **Step 3: Add brand constants**

Create `src/shared/brand.ts`:

```ts
export const APP_BRAND = {
  zhName: 'AI小说作家',
  enName: 'AI Novel Writer',
  shortName: 'AI小说作家',
  tagline: '本地优先的 AI 长篇小说创作 IDE',
  assistantName: 'AI 写作助手',
} as const
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm exec vitest -- run src/shared/__tests__/brand.test.ts
```

Expected: PASS.

- [ ] **Step 5: Replace visible copy**

Update:

- `index.html`
  - `<title>AI小说作家 — AI Novel Writer</title>`
  - loader CSS class names may be kept or renamed, but visible text must be `AI小说作家 初始化中`.
  - Keep `localStorage.getItem('vela-theme')` unchanged for compatibility.

- `src/components/layout/TitleBar.tsx`
  - Import `APP_BRAND`.
  - Replace visible `Vela` with `APP_BRAND.shortName`.

- `src/components/layout/StatusBar.tsx`
  - Import `APP_BRAND`.
  - Replace segment title `Vela IDE` with `AI小说作家`.
  - Replace visible `Vela` with `APP_BRAND.shortName`.

- `src/components/pages/WelcomePage.tsx`
  - Import `APP_BRAND`.
  - Replace `欢迎使用 Vela` with ``欢迎使用 ${APP_BRAND.zhName}``.
  - Replace subtitle with `APP_BRAND.tagline`.
  - Replace `打开已有 Vela 项目` with `打开已有小说项目`.
  - Replace footer `Vela v0.1.0` with `${APP_BRAND.zhName} v0.1.0`.

- `src/components/panels/agent/AgentConversation.tsx`
  - Import `APP_BRAND`.
  - Replace empty-state `Vela` with `APP_BRAND.zhName`.

- [ ] **Step 6: Verify visible frontend source no longer contains Vela in targeted files**

Run:

```powershell
rg -n "\bVela\b" index.html src/components/layout src/components/pages src/components/panels/agent src/shared
```

Expected: no matches in those targeted frontend visible files.

- [ ] **Step 7: Commit task**

Run:

```powershell
git add index.html src/shared/brand.ts src/shared/__tests__/brand.test.ts src/components/layout/TitleBar.tsx src/components/layout/StatusBar.tsx src/components/pages/WelcomePage.tsx src/components/panels/agent/AgentConversation.tsx
git commit -m "feat: add AI novel writer frontend brand copy"
```

## Task 2: Warm Paper Design Tokens

**Files:**

- Modify: `src/tokens/index.ts`
- Modify: `src/index.css`
- Create: `src/tokens/__tests__/tokens.test.ts`

- [ ] **Step 1: Write the failing token test**

Create `src/tokens/__tests__/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { tokens } from '../index'

describe('paper theme writer-studio tokens', () => {
  it('uses the accepted warm paper palette', () => {
    expect(tokens.paper.color.bg).toBe('#F8F1E7')
    expect(tokens.paper.color.editorBg).toBe('#FFF9EF')
    expect(tokens.paper.color.sidebar).toBe('#EEE2D0')
    expect(tokens.paper.color.activityBar).toBe('#DDC8AA')
    expect(tokens.paper.color.accent).toBe('#7A5732')
    expect(tokens.paper.color.gold).toBe('#B68A4A')
    expect(tokens.paper.color.success).toBe('#5D8A67')
    expect(tokens.paper.color.warning).toBe('#C68A3A')
    expect(tokens.paper.color.accent).not.toBe('#9B8EC8')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm exec vitest -- run src/tokens/__tests__/tokens.test.ts
```

Expected: FAIL because `tokens.paper.color.bg` is currently `#F5F0E8` and `accent` is currently `#9B8EC8`.

- [ ] **Step 3: Update `tokens.paper.color`**

In `src/tokens/index.ts`, replace the `paper.color` object with:

```ts
color: {
  bg: '#F8F1E7',
  sidebar: '#EEE2D0',
  panel: '#F5EBDD',
  titlebar: '#E8D8C1',
  activityBar: '#DDC8AA',
  hover: '#EFE1CD',
  active: '#E1C49A',
  text: '#2E261D',
  textSecondary: '#6F5F4A',
  textMuted: '#9A866E',
  border: '#D4BFA4',
  accent: '#7A5732',
  accentHover: '#684929',
  accentRgb: '122, 87, 50',
  gold: '#B68A4A',
  success: '#5D8A67',
  warning: '#C68A3A',
  error: '#B94A48',
  info: '#6E7F8F',
  tabBg: 'transparent',
  tabActive: '#FFF9EF',
  tabBorder: 'transparent',
  tabIndicator: '#7A5732',
  statusbar: '#E8D8C1',
  statusbarText: '#6F5F4A',
  titlebarText: '#2E261D',
  activityIcon: '#7B6A55',
  activityIconActive: '#2E261D',
  activityIndicator: '#7A5732',
  editorBg: '#FFF9EF',
  editorLineHighlight: 'rgba(122, 87, 50, 0.05)',
  editorSelection: 'rgba(122, 87, 50, 0.16)',
  sash: 'transparent',
  sashHover: 'rgba(122, 87, 50, 0.16)',
  focusRing: 'rgba(122, 87, 50, 0.38)',
  backdrop: 'rgba(46, 38, 29, 0.28)',
  tooltipBg: '#2E261D',
  tooltipText: '#FFF9EF',
  skeleton: 'rgba(122, 87, 50, 0.08)',
  badgeBg: 'rgba(122, 87, 50, 0.10)',
  badgeText: '#7A5732',
},
```

- [ ] **Step 4: Update `src/index.css` paper variables and brand utilities**

In the `.paper` block in `src/index.css`, apply matching CSS variable values from Step 3.

Also update these utilities:

```css
.brand-gradient {
  background: linear-gradient(135deg, #7A5732, #B68A4A);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.ai-glow {
  position: relative;
  background: linear-gradient(135deg, #7A5732, #B68A4A);
  color: #fff;
  border: none;
  transition: box-shadow var(--transition-normal),
              transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}
```

Keep the rest of `.ai-glow` behavior intact.

- [ ] **Step 5: Run token test to verify it passes**

Run:

```powershell
npm exec vitest -- run src/tokens/__tests__/tokens.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit task**

Run:

```powershell
git add src/tokens/index.ts src/tokens/__tests__/tokens.test.ts src/index.css
git commit -m "feat: apply warm writer studio tokens"
```

## Task 3: Left Navigation Labels And Lucide Icon Style

**Files:**

- Modify: `src/components/layout/LeftToolWindowBar.tsx`
- Create: `src/components/layout/__tests__/LeftToolWindowBar.test.tsx`

- [ ] **Step 1: Write the failing left navigation test**

Create `src/components/layout/__tests__/LeftToolWindowBar.test.tsx`:

```tsx
import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import LeftToolWindowBar from '../LeftToolWindowBar'

describe('LeftToolWindowBar', () => {
  it('renders visible Chinese labels for every left navigation item', () => {
    const html = renderToString(<LeftToolWindowBar />)

    for (const label of ['首页', '项目', '小说', '蓝图', '角色', '世界', 'AI', '任务', '设置']) {
      expect(html).toContain(label)
    }
  })

  it('does not render old Vela sidebar labels as primary nav labels', () => {
    const html = renderToString(<LeftToolWindowBar />)

    expect(html).not.toContain('项目结构</span>')
    expect(html).not.toContain('知识库</span>')
    expect(html).not.toContain('角色管理</span>')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm exec vitest -- run src/components/layout/__tests__/LeftToolWindowBar.test.tsx
```

Expected: FAIL because `LeftToolWindowBar` currently renders only icons and lacks labels such as `首页`, `小说`, `蓝图`, `世界`, `AI`, `设置`.

- [ ] **Step 3: Update imports and nav config**

In `src/components/layout/LeftToolWindowBar.tsx`, replace imports with:

```ts
import {
  FolderOpen,
  BookOpen,
  Users,
  Home,
  ListTree,
  Globe2,
  Bot,
  ListChecks,
  Settings,
  ScrollText,
  Cpu,
} from 'lucide-react'
```

Set nav arrays:

```ts
const sidebarActivities: Array<{ id: SidebarView; icon: typeof FolderOpen; label: string }> = [
  { id: 'project', icon: FolderOpen, label: '项目' },
  { id: 'knowledge', icon: BookOpen, label: '小说' },
  { id: 'characters', icon: Users, label: '角色' },
]

const secondaryActivities: Array<{ icon: typeof ListTree; label: string; onClick: () => void }> = [
  { icon: ListTree, label: '蓝图', onClick: () => useLayoutStore.getState().setSidebarView('project') },
  { icon: Globe2, label: '世界', onClick: () => useLayoutStore.getState().setSidebarView('knowledge') },
  { icon: Bot, label: 'AI', onClick: () => useLayoutStore.getState().openRightPanel('agent') },
]

const bottomTabs: Array<{ id: BottomTab; icon: typeof ListChecks; label: string }> = [
  { id: 'tasks', icon: ListChecks, label: '任务' },
  { id: 'log', icon: ScrollText, label: '日志' },
  { id: 'models', icon: Cpu, label: '模型' },
]
```

- [ ] **Step 4: Add reusable nav button helper**

Inside `LeftToolWindowBar.tsx`, add:

```tsx
function LeftNavButton({
  icon: Icon,
  label,
  active,
  pulse,
  onClick,
  title,
}: {
  icon: typeof FolderOpen
  label: string
  active?: boolean
  pulse?: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <div className="relative w-full px-1">
      <button
        onClick={onClick}
        title={title ?? label}
        className="left-nav-button"
        style={{
          color: active ? 'var(--color-activity-icon-active)' : 'var(--color-activity-icon)',
          backgroundColor: active ? 'var(--color-active)' : 'transparent',
          boxShadow: active ? 'inset 2px 0 0 var(--color-activity-indicator)' : 'none',
        }}
      >
        <Icon size={16} strokeWidth={active ? 2 : 1.75} />
        <span className="left-nav-label">{label}</span>
      </button>
      {pulse && (
        <span
          className="absolute top-[5px] right-[5px] w-[5px] h-[5px] rounded-full animate-pulse pointer-events-none"
          style={{ backgroundColor: 'var(--color-accent)' }}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 5: Render labeled nav while preserving actions**

In the component JSX:

- Set root width to `var(--width-left-bar)`.
- Render home as:

```tsx
<LeftNavButton
  icon={Home}
  label="首页"
  active={homeActive}
  onClick={() => setSidebarView('home')}
  title="欢迎页"
/>
```

- Render `sidebarActivities` with `setSidebarView(id)`.
- Render `secondaryActivities` after a divider.
- Render bottom tabs with `setBottomTab(id)`.
- Add settings button at bottom:

```tsx
<LeftNavButton
  icon={Settings}
  label="设置"
  onClick={() => useLayoutStore.getState().openSettings()}
/>
```

- [ ] **Step 6: Add CSS for labeled nav**

In `src/index.css`, add under `@layer components`:

```css
.left-nav-button {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 32px;
  padding: 6px 7px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-activity-icon);
  cursor: pointer;
  transition: color var(--transition-fast),
              background var(--transition-fast),
              box-shadow var(--transition-fast);
}

.left-nav-button:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.left-nav-label {
  min-width: 0;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  letter-spacing: 0;
}
```

Update width variables:

- In `src/index.css`, set `--spacing-activity-bar: 72px;`
- In `:root`, set `--width-left-bar: 72px;`
- In `.paper` no separate width override is needed.
- In `src/tokens/index.ts`, set all theme `height.leftBar` to `'72px'` only if the current token naming is used as width elsewhere; otherwise leave token untouched and rely on CSS variable.

- [ ] **Step 7: Run left navigation test**

Run:

```powershell
npm exec vitest -- run src/components/layout/__tests__/LeftToolWindowBar.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit task**

Run:

```powershell
git add src/components/layout/LeftToolWindowBar.tsx src/components/layout/__tests__/LeftToolWindowBar.test.tsx src/index.css src/tokens/index.ts
git commit -m "feat: add labeled writer navigation rail"
```

## Task 4: Remove Hand-Written SVG Icons In Touched Panels And Verify Frontend

**Files:**

- Modify: `src/components/panels/agent/AgentHeader.tsx`
- Modify: `src/components/panels/agent/AgentConversation.tsx`

- [ ] **Step 1: Write source hygiene test**

Create `src/components/panels/agent/__tests__/agent-icon-hygiene.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const files = [
  'src/components/panels/agent/AgentHeader.tsx',
  'src/components/panels/agent/AgentConversation.tsx',
]

describe('agent panel icon hygiene', () => {
  it('does not contain hand-written inline svg icons in touched agent panels', () => {
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(source, file).not.toMatch(/<svg\b/)
      expect(source, file).not.toMatch(/<path\b/)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm exec vitest -- run src/components/panels/agent/__tests__/agent-icon-hygiene.test.ts
```

Expected: FAIL because `AgentHeader.tsx` and `AgentConversation.tsx` currently contain inline `<svg>`/`<path>`.

- [ ] **Step 3: Replace inline SVG in `AgentHeader.tsx`**

Update import:

```ts
import { Plus, MoreHorizontal, X, Server, Sparkles, ChevronRight, History } from 'lucide-react'
```

Replace the history `IconBtn` child:

```tsx
<History size={15} strokeWidth={1.5} />
```

Change the panel title:

```tsx
AI 写作助手
```

- [ ] **Step 4: Replace inline SVG in `AgentConversation.tsx`**

Update import:

```ts
import { Trash2, ArrowDown, Workflow } from 'lucide-react'
```

Replace scroll-to-bottom inline SVG:

```tsx
<ArrowDown size={13} strokeWidth={2.25} />
```

Replace AI workflow inline SVG:

```tsx
<Workflow size={12} strokeWidth={1.75} />
```

- [ ] **Step 5: Run hygiene test**

Run:

```powershell
npm exec vitest -- run src/components/panels/agent/__tests__/agent-icon-hygiene.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run targeted tests**

Run:

```powershell
npm exec vitest -- run src/shared/__tests__/brand.test.ts src/tokens/__tests__/tokens.test.ts src/components/layout/__tests__/LeftToolWindowBar.test.tsx src/components/panels/agent/__tests__/agent-icon-hygiene.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run TypeScript verification**

Run:

```powershell
npm exec tsc -- --noEmit
```

Expected: exit code 0.

- [ ] **Step 8: Run source checks**

Run:

```powershell
rg -n "\bVela\b" index.html src/components/layout src/components/pages src/components/panels/agent src/shared
rg -n "<svg\b|<path\b" src/components/layout/LeftToolWindowBar.tsx src/components/panels/agent/AgentHeader.tsx src/components/panels/agent/AgentConversation.tsx
git status --short
```

Expected:

- First command: no visible frontend matches in targeted files.
- Second command: no matches in touched icon files.
- `git status --short`: no `.superpowers/`, `.codegraph/`, `.env`, `.vela`, user project data, model files, or local generated images staged or unstaged by this task.

- [ ] **Step 9: Commit task**

Run:

```powershell
git add src/components/panels/agent/AgentHeader.tsx src/components/panels/agent/AgentConversation.tsx src/components/panels/agent/__tests__/agent-icon-hygiene.test.ts
git commit -m "refactor: align agent panel icons with writer console style"
```

## Final Verification

- [ ] **Step 1: Run full TypeScript check**

```powershell
npm exec tsc -- --noEmit
```

Expected: exit code 0.

- [ ] **Step 2: Run all related tests**

```powershell
npm exec vitest -- run src/shared/__tests__/brand.test.ts src/tokens/__tests__/tokens.test.ts src/components/layout/__tests__/LeftToolWindowBar.test.tsx src/components/panels/agent/__tests__/agent-icon-hygiene.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Start dev server for visual inspection**

```powershell
npm run dev
```

Expected:

- Vite starts at `http://127.0.0.1:5180`.
- If Electron starts, the app opens without crashing.

- [ ] **Step 4: Inspect the browser/app visually**

Check:

- Main layout order unchanged.
- Left rail has readable labels: 首页 / 项目 / 小说 / 蓝图 / 角色 / 世界 / AI / 任务 / 设置.
- Existing panels remain in the same locations.
- Button positions remain stable.
- Warm paper palette is visible in paper theme.
- No obvious text overflow in left rail labels.

- [ ] **Step 5: Privacy and staging audit**

```powershell
git status --short
git diff --cached --name-only
rg -n "api[_-]?key|secret|token|sk-[A-Za-z0-9]|xai-|gsk_|AIza|Authorization: Bearer" .
```

Expected:

- No local model files, `.superpowers/`, `.codegraph/`, `.env`, `.vela`, user novels, chats, outlines, screenshots, or generated design assets are staged.
- Secret scan may find source-code field names such as `apiKey`, but no real credentials may be staged.

