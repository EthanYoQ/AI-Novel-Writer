# AI Novel Writer Redesign, Clear, Prompts, and Imitation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI小说作家 match the approved product-design mock much more closely, add one-click clearing for generated creative data, strengthen Qwen3-14B-Q4 local-model prompts, remove Vela/support-payment traces, and expose a reference-novel decomposition/imitation workflow.

**Architecture:** Treat the accepted mock image as the visual source of truth and implement it inside the existing Electron/React/Vite app without changing the core app layout model. Data reset and reference imitation must go through repository + IPC boundaries so UI actions remain testable and database-safe. Prompt changes live in the prompt template layer and are injected into existing workflow builders rather than hardcoded in commands.

**Tech Stack:** Electron, React, TypeScript, Zustand, Vite, better-sqlite3, lucide-react, Vitest, Playwright/Chrome channel for Product Design QA.

---

## Evidence And Confirmed Facts

- Product Design source visual: `C:\SoftWare\FUN\Local AI\apps\vela\.superpowers\brainstorm\482-1781937336\content\ai-novel-writer-retain-layout-labeled-nav.png`.
- Current implementation screenshot from previous smoke showed warm theme but not 1:1 with mock: top toolbar, icon sizing, action buttons, panel density, center forms, right AI panel, bottom task table all differ.
- `src/components/settings/SettingsModal.tsx` `AboutSection()` still renders `Vela IDE`, `heider`, sponsorship text, and imported QR assets from `/buyme/*.jpg?url`.
- `src/components/dialogs/ImportNovelDialog.tsx` still says “Vela 将自动拆章...”.
- `electron/repositories/blueprint-repository.ts` has `delete(chapterNumber)` but no clear-all method.
- `electron/repositories/draft-repository.ts` has `delete(id)` but no clear-all-by-scope method.
- `electron/controllers/db-controller.ts` exposes upsert/read/update channels but no bulk clear channels.
- `src/services/workflows/import-workflow.ts` already imports text, infers global config, extracts writing style, infers blueprints, and refreshes data.
- `src/services/workflows/commands/analyze-style.command.ts` writes only `writingStyle`; there is no separate imitation profile / structure template / workflow guide artifact.
- `src/services/workflows/commands/generate-draft.command.ts` injects `writingStyle` into chapter generation but has no dedicated `imitationGuide` or reference structure constraints.
- Full “remove all Vela traces” is larger than visible rebrand: it includes `VELA_HOME`, `.vela`, `vela://`, `window.velaAPI`, comments/log labels, Storybook names, and data paths. This must be handled with compatibility aliases to avoid breaking existing user projects.

## Product Design Brief Playback

Design target: replicate the approved “剧情控制台 / 专业写作 IDE” mock as the source of truth.

Implementation level: full interactivity. Existing controls keep working; no static chrome.

Non-negotiables:
- Keep existing functional layout regions: title bar, left rail, project tree, editor tabs/content, right AI panel, bottom task panel, status bar.
- Improve visual fidelity to the mock: top command bar, dark walnut rails, warm paper canvas, compact tab strips, brass primary buttons, consistent icon scale, tighter typography, table-like task panel, right AI output stack.
- Use icon library assets only. No emoji pseudo-icons, no handwritten inline SVG paths.
- Do Product Design QA with source image and implementation screenshot at same 1440x900 viewport.

---

## File Structure

### Visual Redesign

- Modify: `src/index.css`
  - central design tokens and component classes for writer-console surfaces.
- Modify: `src/tokens/index.ts`
  - keep token source aligned with CSS.
- Modify: `src/components/layout/TitleBar.tsx`
  - top command bar must match the mock.
- Modify: `src/components/layout/LeftToolWindowBar.tsx`
  - left rail spacing, active state, icon/text lockup.
- Modify: `src/components/layout/StatusBar.tsx`
  - bottom status layout and support-link removal.
- Modify: `src/components/panels/sidebar/ProjectTree.tsx`
  - project tree visual hierarchy and entry point for reference imitation when project is open.
- Modify: `src/components/pages/WelcomePage.tsx`
  - center welcome cards match mock density and colors.
- Modify: `src/components/panels/agent/AgentHeader.tsx`
- Modify: `src/components/panels/agent/AgentConversation.tsx`
  - right AI panel fidelity and empty state.
- Modify: `src/components/panels/AIOutputPanel.tsx`
- Modify: `src/components/panels/BottomPanel.tsx` or actual bottom panel component if named differently after inspection.
- Create: `design-qa.md`
  - Product Design QA report after implementation.

### One-Click Clear

- Modify: `electron/repositories/project-core-repository.ts`
  - add reset methods for story architecture/config fields.
- Modify: `electron/repositories/blueprint-repository.ts`
  - add `clearAll()`.
- Modify: `electron/repositories/draft-repository.ts`
  - add `clearAll()` with content cleanup.
- Modify: `electron/repositories/revision-repository.ts`
- Modify: `electron/repositories/review-repository.ts`
- Modify: `electron/repositories/summary-repository.ts`
  - add clear helpers where needed.
- Modify: `electron/controllers/db-controller.ts`
  - add typed IPC clear channels.
- Modify: `src/shared/ipc-channels.ts`
  - add clear channel typings.
- Modify: `src/stores/project-store.ts`, `src/stores/draft-store.ts`, `src/stores/editor-store.ts`
  - refresh/close affected tabs after clear.
- Create: `src/services/project-clear-service.ts`
  - renderer orchestration for clear actions.
- Create: `src/components/dialogs/ClearProjectDataDialog.tsx`
  - confirmation modal with checkboxes.
- Modify: `src/components/editor/NovelConfigEditor.tsx`
- Modify: `src/components/editor/ChapterCardEditor.tsx`
- Modify: `src/components/panels/sidebar/ProjectTree.tsx`
  - entry buttons or menu items for clearing relevant sections.

### Reference Novel Decomposition / Imitation

- Modify: `electron/repositories/project-core-repository.ts`
  - add `imitationGuide` and `referenceStructure` if schema supports migration, or store in existing `referenceWorks/globalGuidance` only as a fallback.
- Modify: `electron/database.ts`
  - migrate `project_core` columns for imitation profile if absent.
- Modify: `src/shared/ipc-channels.ts`
  - type new fields.
- Modify: `src/services/prompt-templates.ts`
  - add/edit prompts:
    - `analyze_reference_imitation_profile`
    - `infer_novel_config_with_vectors`
    - `infer_single_chapter_blueprint`
    - `first_chapter_draft`
    - `next_chapter_draft`
- Modify: `src/services/prompts/prompt-builder.ts`
  - add `.withImitationGuide()` and `.withReferenceStructure()`.
- Create: `src/services/workflows/commands/analyze-reference-imitation.command.ts`
  - local-model-friendly chunking + summary pipeline.
- Modify: `src/services/workflows/import-workflow.ts`
  - add explicit step after style analysis: “拆解参考小说并生成仿写指南”.
- Modify: `src/services/workflows/commands/generate-draft.command.ts`
  - inject `imitationGuide/referenceStructure` into draft prompts.
- Modify: `src/components/dialogs/ImportNovelDialog.tsx`
  - make entry copy clear: “导入并拆解为仿写参考”.
- Modify: `src/components/editor/NovelConfigEditor.tsx`
  - show `referenceStructure/imitationGuide` section and “从参考小说拆解” entry.

### Qwen3 Local Model Prompt Rewrite

- Modify: `src/services/prompt-templates.ts`
  - rewrite all builtin system roles and editable prompt content for Qwen3 14B Q4:
    - smaller step scope
    - strict JSON only where required
    - no long meta-explanations
    - explicit anti-repeat rules
    - chunk-first analysis
    - writing output rules for Chinese longform and NSFW fictional adult prose without policy/safety boilerplate.
- Modify: `src/services/workflows/commands/generate-field.command.ts`
  - replace hardcoded generic system prompt with template-oriented, local-model concise role.
- Modify: `src/services/workflows/commands/base-command.ts`
  - verify max token / JSON call settings do not overask local Q4 model.

### Remove Vela Traces

- Modify visible surfaces:
  - `src/components/settings/SettingsModal.tsx`
  - `src/components/layout/StatusBar.tsx`
  - `src/components/dialogs/ImportNovelDialog.tsx`
  - `src/components/pages/WelcomePage.tsx`
  - `src/services/agent/context-builder.ts`
  - `src/stores/agent-store.ts`
  - `electron/main.ts`
  - `src/index.css`, `src/tokens/*`, Storybook files if still in project.
- Compatibility migration surfaces:
  - `electron/utils/config-utils.ts`
  - `src/shared/project-paths.ts`
  - `src/services/vela-protocol.ts`
  - `src/services/ipc-client.ts`
  - `electron/preload.ts`
  - `electron/database.ts`
  - Do not delete existing `.vela` data without migration. Introduce new names while accepting old names.

---

## Task 1: Visual Fidelity Harness And Product Design QA Baseline

**Files:**
- Create: `src/components/layout/__tests__/visual-fidelity-contract.test.ts`
- Create: `design-qa.md`
- Read: `.superpowers/brainstorm/482-1781937336/content/ai-novel-writer-retain-layout-labeled-nav.png`

- [ ] **Step 1: Write the failing visual contract test**

Create `src/components/layout/__tests__/visual-fidelity-contract.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const files = [
  'src/components/layout/TitleBar.tsx',
  'src/components/layout/LeftToolWindowBar.tsx',
  'src/components/layout/StatusBar.tsx',
  'src/components/pages/WelcomePage.tsx',
  'src/components/panels/agent/AgentHeader.tsx',
  'src/components/panels/agent/AgentConversation.tsx',
  'src/index.css',
]

function source(file: string) {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('writer console visual fidelity contract', () => {
  it('uses the approved writer console token classes and no pseudo-icons', () => {
    const combined = files.map(source).join('\n')
    expect(combined).toContain('writer-topbar')
    expect(combined).toContain('writer-command-button')
    expect(combined).toContain('writer-project-tree')
    expect(combined).toContain('writer-task-table')
    expect(combined).toContain('writer-ai-panel')
    expect(combined).not.toMatch(/[❤️☕✨✅❌]/)
    expect(combined).not.toMatch(/<svg\b|<path\b/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm exec vitest -- run "src/components/layout/__tests__/visual-fidelity-contract.test.ts"
```

Expected: FAIL because `writer-topbar` and related classes do not exist yet.

- [ ] **Step 3: Capture implementation baseline**

Run:

```powershell
@'
const { chromium } = require('playwright');
(async () => {
  const shot = process.env.TEMP + '\\ai-novel-writer-before-redesign.png';
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:5180', { waitUntil: 'networkidle', timeout: 15000 });
  await page.screenshot({ path: shot, fullPage: false });
  await browser.close();
  console.log(shot);
})();
'@ | node -
```

Expected: screenshot path printed.

- [ ] **Step 4: Commit baseline test**

```powershell
git add "src/components/layout/__tests__/visual-fidelity-contract.test.ts"
git commit -m "test: add writer console visual fidelity contract"
```

## Task 2: Implement 1:1 Writer Console Visual Redesign

**Files:**
- Modify: `src/index.css`
- Modify: `src/tokens/index.ts`
- Modify: `src/components/layout/TitleBar.tsx`
- Modify: `src/components/layout/LeftToolWindowBar.tsx`
- Modify: `src/components/layout/StatusBar.tsx`
- Modify: `src/components/pages/WelcomePage.tsx`
- Modify: `src/components/panels/agent/AgentHeader.tsx`
- Modify: `src/components/panels/agent/AgentConversation.tsx`
- Modify: actual bottom panel component found by inspection
- Test: `src/components/layout/__tests__/visual-fidelity-contract.test.ts`

- [ ] **Step 1: Implement CSS token/class layer**

Add these classes in `src/index.css` under `@layer components`:

```css
.writer-topbar {
  background: linear-gradient(180deg, #2b1708 0%, #1d1007 100%);
  color: #fff8e8;
  border-bottom: 1px solid rgba(107, 74, 38, 0.72);
}

.writer-command-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  color: #fff4df;
  border: 1px solid transparent;
  background: transparent;
  font-size: 12px;
  font-weight: 500;
}

.writer-command-button:hover {
  background: rgba(255, 244, 223, 0.08);
  border-color: rgba(255, 244, 223, 0.18);
}

.writer-primary-button {
  background: linear-gradient(180deg, #8a5b2e 0%, #65401f 100%);
  color: #fff8e8;
  border: 1px solid rgba(67, 40, 17, 0.55);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 1px 2px rgba(54, 31, 12, 0.24);
}

.writer-project-tree {
  background: #f4ead8;
  border-right: 1px solid #d8c4a5;
}

.writer-ai-panel {
  background: #f4ead8;
  border-left: 1px solid #d8c4a5;
}

.writer-task-table {
  background: #f3e7d5;
  border-top: 1px solid #d2ba98;
}
```

- [ ] **Step 2: Refactor TitleBar to match mock**

Use lucide icons only: `Menu`, `CheckCircle2`, `Archive`, `Import`, `Upload`, `FilePlus2`, `FolderOpen`, `Minus`, `Square`, `X`.

Required visible commands in order:

```tsx
<span>{APP_BRAND.zhName}</span>
<span>{APP_BRAND.enName}</span>
<button title="主菜单">...</button>
<span>当前项目：</span>
<button title="切换项目">{currentProject?.name ?? '未打开项目'}</button>
<span>已保存</span>
<button>备份</button>
<button>导入</button>
<button>导出</button>
<button>新建</button>
<button>打开</button>
```

Wire existing handlers where they exist. For commands not yet implemented, use disabled buttons with a tooltip/title rather than static text.

- [ ] **Step 3: Refactor left rail styles**

Keep current navigation IDs. Match mock: 72px rail, walnut background, active brass vertical panel, icon above label where needed or compact icon/text lockup if current layout constraints require.

- [ ] **Step 4: Refactor panel surfaces**

Apply:
- project tree wrapper -> `writer-project-tree`
- right AI panel wrapper -> `writer-ai-panel`
- bottom task wrapper -> `writer-task-table`
- welcome cards -> dark cards with brass/green accents as in mock

- [ ] **Step 5: Run visual contract and capture screenshot**

```powershell
npm exec vitest -- run "src/components/layout/__tests__/visual-fidelity-contract.test.ts"
```

Then capture:

```powershell
@'
const { chromium } = require('playwright');
(async () => {
  const shot = process.env.TEMP + '\\ai-novel-writer-after-redesign.png';
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:5180', { waitUntil: 'networkidle', timeout: 15000 });
  await page.screenshot({ path: shot, fullPage: false });
  await browser.close();
  console.log(shot);
})();
'@ | node -
```

- [ ] **Step 6: Product Design QA report**

Create/update `design-qa.md` with:

```md
source visual truth path: C:\SoftWare\FUN\Local AI\apps\vela\.superpowers\brainstorm\482-1781937336\content\ai-novel-writer-retain-layout-labeled-nav.png
implementation screenshot path: <captured screenshot path>
viewport: 1440x900
state: welcome / project-open state if fixture available
final result: passed|blocked
```

If P0/P1/P2 visual drift remains, fix and repeat capture.

- [ ] **Step 7: Commit**

```powershell
git add "src/index.css" "src/tokens/index.ts" "src/components/layout" "src/components/pages/WelcomePage.tsx" "src/components/panels/agent" "design-qa.md"
git commit -m "feat: match approved writer console design"
```

## Task 3: Remove About/Support Payments And Visible Legacy Branding

**Files:**
- Modify: `src/components/settings/SettingsModal.tsx`
- Modify: `src/components/layout/StatusBar.tsx`
- Modify: `src/components/dialogs/ImportNovelDialog.tsx`
- Modify: `src/services/agent/context-builder.ts`
- Modify: `src/stores/agent-store.ts`
- Modify: `electron/main.ts`
- Test: `src/shared/__tests__/brand.test.ts`

- [ ] **Step 1: Extend brand test**

Add surfaces and forbidden text:

```ts
const visibleBrandSurfaces = [
  'index.html',
  'electron/main.ts',
  'src/components/settings/SettingsModal.tsx',
  'src/components/layout/StatusBar.tsx',
  'src/components/dialogs/ImportNovelDialog.tsx',
  'src/services/agent/context-builder.ts',
  'src/stores/agent-store.ts',
]

const forbiddenVisiblePatterns = [
  /ve\w*a/i,
  /heider/i,
  /赞助|打赏|收款|二维码|支付宝|微信打赏|个人微信/i,
  /\/buyme\//i,
]
```

Assert every file does not match.

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm exec vitest -- run "src/shared/__tests__/brand.test.ts"
```

Expected: FAIL on SettingsModal/AboutSection and ImportNovelDialog.

- [ ] **Step 3: Replace AboutSection**

In `SettingsModal.tsx`, remove imports:

```ts
import wepayImg from '/buyme/wepay.png?url'
import alipayImg from '/buyme/alipay.jpg?url'
import wechatImg from '/buyme/wechat.jpg?url'
```

Replace About section with product-only copy:

```tsx
function AboutSection() {
  return (
    <div className="space-y-5 max-w-[620px] p-2">
      <div className="flex flex-col items-center justify-center py-8 rounded-xl space-y-2"
        style={{ backgroundColor: 'var(--color-sidebar)', border: '1px solid var(--color-border)' }}>
        <h1 className="text-2xl font-bold brand-gradient tracking-wider">{APP_BRAND.zhName}</h1>
        <p className="text-sm opacity-80" style={{ color: 'var(--color-text)' }}>{APP_BRAND.enName} v{__APP_VERSION__}</p>
        <p className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
          本地优先的 AI 长篇小说创作 IDE
        </p>
      </div>
      <div className="space-y-2 text-xs leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
        <p>当前版本聚焦本地模型、故事架构、章节蓝图、角色状态、长篇写作和参考小说拆解。</p>
        <p>不会在关于页展示收款二维码、个人联系方式或原项目作者信息。</p>
      </div>
    </div>
  )
}
```

Import `APP_BRAND`.

- [ ] **Step 4: Remove support link from StatusBar**

Replace “支持作者” action with neutral product/version status or remove it entirely.

- [ ] **Step 5: Replace visible copy**

`ImportNovelDialog`: replace “Vela 将...” with “AI小说作家将...”.

Agent context/help: replace “Vela AI...” with “AI小说作家 AI...”.

Electron title: replace with `AI小说作家 — AI Novel Writer`.

- [ ] **Step 6: Run test and commit**

```powershell
npm exec vitest -- run "src/shared/__tests__/brand.test.ts"
git add "src/shared/__tests__/brand.test.ts" "src/components/settings/SettingsModal.tsx" "src/components/layout/StatusBar.tsx" "src/components/dialogs/ImportNovelDialog.tsx" "src/services/agent/context-builder.ts" "src/stores/agent-store.ts" "electron/main.ts"
git commit -m "chore: remove visible legacy support branding"
```

## Task 4: Add Data Clear Repository, IPC, And UI

**Files:**
- Modify: `electron/repositories/project-core-repository.ts`
- Modify: `electron/repositories/blueprint-repository.ts`
- Modify: `electron/repositories/draft-repository.ts`
- Modify: `electron/controllers/db-controller.ts`
- Modify: `src/shared/ipc-channels.ts`
- Create: `src/services/project-clear-service.ts`
- Create: `src/components/dialogs/ClearProjectDataDialog.tsx`
- Modify: `src/components/editor/NovelConfigEditor.tsx`
- Modify: `src/components/panels/sidebar/ProjectTree.tsx`
- Test: repository/controller tests under existing test dirs.

- [ ] **Step 1: Write repository failing tests**

Create/extend `electron/repositories/__tests__/clear-project-data.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ProjectCoreRepository } from '../project-core-repository'
import { BlueprintRepository } from '../blueprint-repository'
import { DraftRepository } from '../draft-repository'
import { getProjectDb } from '../../database'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))

function mockDb() {
  const calls: string[] = []
  return {
    prepare: (sql: string) => ({
      run: (..._args: unknown[]) => { calls.push(sql); return { changes: 1 } },
      all: () => [],
      get: () => null,
    }),
    transaction: (fn: () => void) => () => fn(),
    calls,
  }
}

describe('clear project generated data repositories', () => {
  beforeEach(() => vi.resetAllMocks())

  it('clears story architecture fields without deleting base project identity', () => {
    const db = mockDb()
    vi.mocked(getProjectDb).mockReturnValue(db as never)

    ProjectCoreRepository.clearArchitecture()

    expect(db.calls.join('\n')).toContain('premise')
    expect(db.calls.join('\n')).toContain('worldbuilding')
    expect(db.calls.join('\n')).toContain('characters_arch')
    expect(db.calls.join('\n')).toContain('synopsis')
  })

  it('clears all blueprints', () => {
    const db = mockDb()
    vi.mocked(getProjectDb).mockReturnValue(db as never)

    BlueprintRepository.clearAll()

    expect(db.calls.join('\n')).toContain('DELETE FROM blueprints')
  })

  it('clears drafts and dependent generated text tables in a transaction', () => {
    const db = mockDb()
    vi.mocked(getProjectDb).mockReturnValue(db as never)

    DraftRepository.clearAll()

    const sql = db.calls.join('\n')
    expect(sql).toContain('DELETE FROM reviews')
    expect(sql).toContain('DELETE FROM revisions')
    expect(sql).toContain('DELETE FROM drafts')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm exec vitest -- run "electron/repositories/__tests__/clear-project-data.test.ts"
```

Expected: FAIL because methods do not exist.

- [ ] **Step 3: Implement repository methods**

Add:

```ts
static clearArchitecture(): void {
  const db = getProjectDb()
  if (!db) throw new Error('项目数据库未打开')
  db.prepare(`
    UPDATE project_core SET
      premise = '',
      worldbuilding = '',
      characters_arch = '',
      synopsis = '',
      character_states = '',
      updated_at = datetime('now')
    WHERE id = 'main'
  `).run()
}
```

Add `BlueprintRepository.clearAll()`:

```ts
static clearAll(): void {
  const db = requireProjectDb()
  db.prepare('DELETE FROM blueprints').run()
}
```

Add `DraftRepository.clearAll()`:

```ts
static clearAll(): void {
  const db = getProjectDb()
  if (!db) throw new Error('[DraftRepository] 数据库未连接')
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM reviews').run()
    db.prepare('DELETE FROM revisions').run()
    db.prepare('DELETE FROM drafts').run()
    db.prepare(`
      DELETE FROM contents
      WHERE id NOT IN (
        SELECT content_id FROM drafts
        UNION SELECT content_id FROM revisions
        UNION SELECT content_id FROM reviews
      )
    `).run()
  })
  tx()
}
```

- [ ] **Step 4: Add IPC channels**

In `db-controller.ts`:

```ts
ipcMain.handle('db:project-clear-architecture', async () => {
  try { ProjectCoreRepository.clearArchitecture(); return { success: true } }
  catch (err) { return { success: false, error: String(err) } }
})

ipcMain.handle('db:blueprint-clear-all', async () => {
  try { BlueprintRepository.clearAll(); return { success: true } }
  catch (err) { return { success: false, error: String(err) } }
})

ipcMain.handle('db:draft-clear-all', async () => {
  try { DraftRepository.clearAll(); return { success: true } }
  catch (err) { return { success: false, error: String(err) } }
})
```

Add typed channels in `ipc-channels.ts`.

- [ ] **Step 5: Add renderer clear service**

Create `src/services/project-clear-service.ts`:

```ts
import { ipc } from './ipc-client'
import { useProjectStore } from '../stores/project-store'
import { useDraftStore } from '../stores/draft-store'
import { useEditorStore } from '../stores/editor-store'

export type ClearProjectDataScope = 'architecture' | 'blueprints' | 'drafts'

export async function clearProjectData(scopes: ClearProjectDataScope[]) {
  const results: string[] = []
  if (scopes.includes('architecture')) {
    const result = await ipc.invoke('db:project-clear-architecture')
    if (!result.success) throw new Error(result.error || '清除故事架构失败')
    results.push('故事架构')
  }
  if (scopes.includes('blueprints')) {
    const result = await ipc.invoke('db:blueprint-clear-all')
    if (!result.success) throw new Error(result.error || '清除章节蓝图失败')
    results.push('章节蓝图')
  }
  if (scopes.includes('drafts')) {
    const result = await ipc.invoke('db:draft-clear-all')
    if (!result.success) throw new Error(result.error || '清除正文草稿失败')
    useEditorStore.getState().clearTabs()
    await useDraftStore.getState().loadAllDrafts()
    results.push('正文草稿')
  }
  await useProjectStore.getState().refreshFileTree()
  return results
}
```

- [ ] **Step 6: Add UI dialog**

`ClearProjectDataDialog.tsx` must show checkboxes:
- 故事架构
- 章节蓝图
- 生成正文/草稿

Require user to type `清除` before enabling the destructive button.

- [ ] **Step 7: Wire entry points**

Add danger-zone buttons:
- in `NovelConfigEditor`: “清除故事架构”
- in `ProjectTree` toolbar/menu: “清除生成数据”
- in blueprint editor/sidebar if present: “清除蓝图”

- [ ] **Step 8: Run tests and commit**

```powershell
npm exec vitest -- run "electron/repositories/__tests__/clear-project-data.test.ts"
npm exec tsc -- --noEmit
git add "electron/repositories" "electron/controllers/db-controller.ts" "src/shared/ipc-channels.ts" "src/services/project-clear-service.ts" "src/components/dialogs/ClearProjectDataDialog.tsx" "src/components/editor/NovelConfigEditor.tsx" "src/components/panels/sidebar/ProjectTree.tsx"
git commit -m "feat: add one click generated data clearing"
```

## Task 5: Reference Novel Decomposition And Imitation Workflow

**Files:**
- Modify: `electron/database.ts`
- Modify: `electron/repositories/project-core-repository.ts`
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/services/prompt-templates.ts`
- Modify: `src/services/prompts/prompt-builder.ts`
- Create: `src/services/workflows/commands/analyze-reference-imitation.command.ts`
- Modify: `src/services/workflows/import-workflow.ts`
- Modify: `src/services/workflows/commands/generate-draft.command.ts`
- Modify: `src/components/dialogs/ImportNovelDialog.tsx`
- Modify: `src/components/editor/NovelConfigEditor.tsx`
- Tests:
  - `src/services/workflows/commands/__tests__/analyze-reference-imitation.command.test.ts`
  - `src/services/prompts/__tests__/prompt-builder-imitation.test.ts`

- [ ] **Step 1: Write failing prompt builder test**

```ts
import { describe, expect, it } from 'vitest'
import { ChapterPromptBuilder } from '../prompt-builder'

describe('ChapterPromptBuilder imitation variables', () => {
  it('injects imitation guide and reference structure', () => {
    const builder = new ChapterPromptBuilder({
      key: 'x',
      name: 'x',
      description: 'x',
      content: 'A {{imitation_guide}} B {{reference_structure}}',
      variables: {},
    })

    const output = builder
      .withImitationGuide('短句密集')
      .withReferenceStructure('三段递进')
      .build()

    expect(output).toContain('短句密集')
    expect(output).toContain('三段递进')
  })
})
```

Expected: FAIL because builder methods do not exist.

- [ ] **Step 2: Add ProjectCore fields with migration**

In `electron/database.ts`, after table creation, add safe migrations:

```ts
function ensureColumn(db: BetterSqlite3.Database, table: string, column: string, definition: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!rows.some(row => row.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run()
  }
}

ensureColumn(db, 'project_core', 'imitation_guide', "TEXT DEFAULT ''")
ensureColumn(db, 'project_core', 'reference_structure', "TEXT DEFAULT ''")
```

Update `ProjectCoreData`, `rowToData`, and field map.

- [ ] **Step 3: Add prompt builder variables**

```ts
withImitationGuide(guide: string) {
  this.variables.imitation_guide = guide
  return this
}

withReferenceStructure(structure: string) {
  this.variables.reference_structure = structure
  return this
}
```

- [ ] **Step 4: Add Qwen-friendly decomposition prompt**

Add `analyze_reference_imitation_profile` to `BUILTIN_PROMPTS`:

```ts
{
  key: 'analyze_reference_imitation_profile',
  name: '参考小说拆解与仿写指南',
  description: '从导入 TXT 小说中提取可复用结构模板、文风指纹和仿写约束',
  systemRole: '你是中文长篇小说结构拆解编辑。你只抽象技法，不复述原文情节，不复制角色名和专有设定。',
  variables: { sample_text: '分块采样正文', chapter_map: '章节标题与字数列表' },
  content: `请基于以下参考小说样本，输出可用于新小说创作的“抽象仿写指南”。本地模型能力有限，请分点、短句、结构化输出。

【章节地图】
{{chapter_map}}

【正文样本】
{{sample_text}}

【任务】
1. 文风指纹：句长、段落长度、对白比例、心理描写密度、环境描写密度、常见过渡方式。
2. 节奏模板：开场钩子、信息释放、冲突升级、场景收束、章末悬念。
3. 章节结构：每章通常包含哪些段落功能，按顺序列出。
4. 人物关系推进：亲密、对抗、误会、利益交换如何递进。
5. 场景仿写规则：如何写动作、对白、心理、气氛，不得照搬原文。
6. 禁止事项：不得复制原角色名、地名、组织名、具体桥段和连续句式。

【输出格式】
# 参考仿写指南
## 文风指纹
...
## 节奏模板
...
## 章节结构模板
...
## 人物与冲突模式
...
## 写作约束
...
## 禁止照搬清单
...`,
}
```

- [ ] **Step 5: Implement AnalyzeReferenceImitationCommand**

Algorithm:
- accept imported chapters
- pick representative chapters: first 2, middle 2, last 2; cap each sample to 1800 chars
- build chapter map: number/title/wordCount
- call LLM once with the new prompt
- save output to:
  - `project_core.imitationGuide`
  - `project_core.referenceStructure` as a compact extracted “章节结构模板” section if parsing succeeds, otherwise same output fallback
  - append short note to `writingStyle` only if empty

- [ ] **Step 6: Insert workflow step**

In `import-workflow.ts`, after “AI 提取导入文风”, add:

```ts
{
  name: '拆解参考小说并生成仿写指南',
  description: '抽取参考小说的文风、节奏、章节结构和仿写约束',
  executor: async (step, context, callbacks) => {
    const { AnalyzeReferenceImitationCommand } = await import('./commands/analyze-reference-imitation.command')
    const cmd = new AnalyzeReferenceImitationCommand({ chapters: params.chapters })
    return cmd.execute({ step, context, callbacks })
  },
}
```

- [ ] **Step 7: Inject into draft generation**

In `GenerateDraftCommand`, read core:

```ts
const core = await ipc.invoke('db:project-core-get')
promptBuilder
  .withImitationGuide(core?.imitationGuide || '')
  .withReferenceStructure(core?.referenceStructure || '')
```

Update `first_chapter_draft` and `next_chapter_draft` templates to include:

```text
【参考小说仿写指南】
{{imitation_guide}}

【参考章节结构模板】
{{reference_structure}}
```

- [ ] **Step 8: Add UI entry**

In `NovelConfigEditor`, add a section:
- title: `参考小说拆解与仿写`
- display saved guide/structure
- button: `从导入小说生成仿写指南`

In `ImportNovelDialog`, update title/description so user sees this feature before importing.

- [ ] **Step 9: Run tests and commit**

```powershell
npm exec vitest -- run "src/services/prompts/__tests__/prompt-builder-imitation.test.ts" "src/services/workflows/commands/__tests__/analyze-reference-imitation.command.test.ts"
npm exec tsc -- --noEmit
git add "electron/database.ts" "electron/repositories/project-core-repository.ts" "src/shared/ipc-channels.ts" "src/services/prompt-templates.ts" "src/services/prompts/prompt-builder.ts" "src/services/workflows" "src/components/dialogs/ImportNovelDialog.tsx" "src/components/editor/NovelConfigEditor.tsx"
git commit -m "feat: add reference novel decomposition workflow"
```

## Task 6: Rewrite Builtin Prompts For Qwen3-14B-Q4 Local Generation

**Files:**
- Modify: `src/services/prompt-templates.ts`
- Modify: `src/services/workflows/commands/generate-field.command.ts`
- Test: `src/services/__tests__/prompt-templates-qwen.test.ts`

- [ ] **Step 1: Write prompt quality contract test**

```ts
import { describe, expect, it } from 'vitest'
import { BUILTIN_PROMPTS } from '../prompt-templates'

const requiredKeys = [
  'generate_global_config',
  'premise',
  'character_dynamics',
  'world_building',
  'synopsis',
  'chapter_blueprint',
  'chapter_blueprint_chunk',
  'first_chapter_draft',
  'next_chapter_draft',
  'refine_chapter',
  'consistency_check',
  'analyze_writing_style',
  'infer_novel_config_with_vectors',
  'infer_single_chapter_blueprint',
  'analyze_reference_imitation_profile',
]

describe('Qwen local prompt templates', () => {
  it('defines concise local-model system roles for all core prompts', () => {
    for (const key of requiredKeys) {
      const prompt = BUILTIN_PROMPTS.find(p => p.key === key)
      expect(prompt, key).toBeTruthy()
      expect(prompt!.systemRole, key).toMatch(/中文|小说|结构|编辑|写作|分析/)
      expect(prompt!.systemRole!.length, key).toBeLessThan(90)
    }
  })

  it('chapter draft prompts contain anti-repeat and continuation rules', () => {
    const joined = requiredKeys
      .map(key => BUILTIN_PROMPTS.find(p => p.key === key)?.content ?? '')
      .join('\n')

    expect(joined).toContain('不要复述设定')
    expect(joined).toContain('不要总结剧情')
    expect(joined).toContain('避免重复句式')
    expect(joined).toContain('动作、对白、心理、环境')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm exec vitest -- run "src/services/__tests__/prompt-templates-qwen.test.ts"
```

- [ ] **Step 3: Rewrite prompts in place**

Rules for every edited prompt:
- systemRole ≤ 90 chars
- prompts use numbered short constraints
- JSON tasks say “只输出 JSON”
- chapter drafting tasks say:
  - continue current scene
  - no summary
  - no meta explanation
  - avoid repeated sentence openings
  - include action/dialogue/psychology/environment
  - target word count from `{{word_number}}`, but do not force impossible length in one response
- reference imitation tasks say:
  - abstract structure only
  - no direct plot copying
  - no original names/places/organizations

- [ ] **Step 4: Replace hardcoded GenerateFieldCommand systemPrompt**

Replace:

```ts
const systemPrompt = '你是一位入行十年的顶尖网文主编与白金大神作家，擅长精准设计小说的各项核心配置。'
```

With:

```ts
const systemPrompt = '你是中文长篇小说策划编辑。输出直接、具体、可落地，避免空话。'
```

- [ ] **Step 5: Run tests and commit**

```powershell
npm exec vitest -- run "src/services/__tests__/prompt-templates-qwen.test.ts"
npm exec tsc -- --noEmit
git add "src/services/prompt-templates.ts" "src/services/workflows/commands/generate-field.command.ts" "src/services/__tests__/prompt-templates-qwen.test.ts"
git commit -m "feat: optimize builtin prompts for qwen local writing"
```

## Task 7: Deep Legacy Name Compatibility Cleanup

**Files:**
- Modify: `electron/utils/config-utils.ts`
- Modify: `electron/ipc-handlers.ts`
- Modify: `src/shared/project-paths.ts`
- Modify: `src/services/vela-protocol.ts` or create alias module while keeping compatibility exports
- Modify: `src/services/ipc-client.ts`
- Modify: `electron/preload.ts`
- Modify: comments/log labels in `electron/*` and `src/*`
- Tests: `src/shared/__tests__/brand.test.ts` plus new compatibility tests.

- [ ] **Step 1: Write compatibility test**

Create `src/shared/__tests__/legacy-compatibility.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isVelaProtocol } from '../../services/vela-protocol'

describe('legacy project compatibility', () => {
  it('keeps old protocol readable while new branding is introduced', () => {
    expect(isVelaProtocol('vela://draft/1')).toBe(true)
  })
})
```

This intentionally keeps old protocol compatibility while visible code is rebranded.

- [ ] **Step 2: Introduce new config constants without deleting old data**

In `electron/utils/config-utils.ts`:

```ts
export const AI_NOVEL_WRITER_HOME = path.join(os.homedir(), '.ai-novel-writer')
export const LEGACY_VELA_HOME = path.join(os.homedir(), '.vela')
export const APP_HOME = fs.existsSync(LEGACY_VELA_HOME) ? LEGACY_VELA_HOME : AI_NOVEL_WRITER_HOME
```

Keep old exported names as deprecated aliases only if required by imports:

```ts
/** @deprecated use APP_HOME */
export const VELA_HOME = APP_HOME
```

- [ ] **Step 3: Rename visible logs and comments**

Change log labels from `[Vela ...]` to `[AI Novel Writer ...]`.

- [ ] **Step 4: Keep protocol as compatibility layer**

Do not break `vela://` immediately. Add new helper names and keep old export:

```ts
export function isAppProtocol(path: string): boolean {
  return path.startsWith('ainovel://') || path.startsWith('vela://')
}

/** @deprecated use isAppProtocol */
export const isVelaProtocol = isAppProtocol
```

- [ ] **Step 5: Run targeted residue scan**

Allowed remaining patterns:
- compatibility alias lines with `@deprecated`
- tests that explicitly assert legacy compatibility

Everything else should be removed or renamed.

```powershell
rg -ni "Vela|\\.vela|vela://" "src" "electron" "index.html"
```

- [ ] **Step 6: Commit**

```powershell
npm exec vitest -- run "src/shared/__tests__/brand.test.ts" "src/shared/__tests__/legacy-compatibility.test.ts"
npm exec tsc -- --noEmit
git add "electron" "src"
git commit -m "chore: rebrand internals with legacy compatibility"
```

## Task 8: Final Verification And Product Design QA Gate

**Files:**
- Modify: `design-qa.md`

- [ ] **Step 1: Run full targeted tests**

```powershell
npm exec vitest -- run `
  "src/shared/__tests__/brand.test.ts" `
  "src/components/layout/__tests__/visual-fidelity-contract.test.ts" `
  "electron/repositories/__tests__/clear-project-data.test.ts" `
  "src/services/prompts/__tests__/prompt-builder-imitation.test.ts" `
  "src/services/workflows/commands/__tests__/analyze-reference-imitation.command.test.ts" `
  "src/services/__tests__/prompt-templates-qwen.test.ts" `
  "src/shared/__tests__/legacy-compatibility.test.ts"
```

Expected: all pass.

- [ ] **Step 2: Typecheck**

```powershell
npm exec tsc -- --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Vite build**

```powershell
npm exec vite -- build
```

Expected: exit 0. Full `npm run build` may still fail at `electron-builder` winCodeSign symlink extraction unless Windows Developer Mode/admin symlink privilege is enabled.

- [ ] **Step 4: Runtime screenshot**

```powershell
@'
const { chromium } = require('playwright');
(async () => {
  const shot = process.env.TEMP + '\\ai-novel-writer-final.png';
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:5180', { waitUntil: 'networkidle', timeout: 15000 });
  const result = await page.evaluate(() => ({ title: document.title, classes: document.documentElement.className }));
  await page.screenshot({ path: shot, fullPage: false });
  await browser.close();
  console.log(JSON.stringify({ ...result, shot }));
})();
'@ | node -
```

- [ ] **Step 5: Product Design QA**

Compare:
- Source: `C:\SoftWare\FUN\Local AI\apps\vela\.superpowers\brainstorm\482-1781937336\content\ai-novel-writer-retain-layout-labeled-nav.png`
- Implementation: final screenshot path.

Update `design-qa.md`:

```md
final result: passed
```

Only mark passed if there are no actionable P0/P1/P2 findings.

- [ ] **Step 6: Final git status**

```powershell
git status --short
```

Report only files changed by this plan. Do not revert unrelated existing dirty files.

---

## Risk Notes

- Rebranding `.vela` and `vela://` is data-sensitive. The plan uses compatibility aliases first. Direct deletion/rename of existing `.vela` project directories is forbidden.
- Full `npm run build` can fail on Windows without symlink privilege during `electron-builder` winCodeSign extraction. Verification must include `npm exec vite -- build`; full packaging requires enabling Developer Mode or running with admin/symlink privilege.
- Local Qwen3 14B Q4 can fail long JSON tasks if prompts are too broad. The prompt rewrite and imitation command must prefer short chunks and structured summaries over one huge analysis call.
- Visual 1:1 cannot be claimed without `design-qa.md` comparing source image and implementation screenshot.

