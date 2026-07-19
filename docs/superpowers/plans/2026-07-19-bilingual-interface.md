# Bilingual Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent Simplified Chinese and English switching for application UI, system prompts, and errors without translating creative prompts or generated content.

**Architecture:** A framework-free typed translation core is shared by Electron and React. A Zustand locale store owns renderer state and persistence, while main-process helpers read the same locale code from global config and return stable error codes plus localized messages.

**Tech Stack:** React 19, Zustand 5, Electron IPC, TypeScript, Vitest, Lucide React.

## Global Constraints

- Supported locales are exactly `zh-CN` and `en-US`.
- First launch follows the OS locale; a manual choice persists in `~/.vela/config.json`.
- Translate only application UI, system hints, and errors.
- Do not translate creative Prompt bodies, style presets, project templates, user data, or generated novel content.
- Use the existing Lucide `Languages` icon; no Emoji, Unicode pseudo-icons, or handwritten SVG paths.
- Missing keys fall back to English and then the key without crashing.

---

### Task 1: Build the shared typed translation core

**Files:**
- Create: `src/i18n/types.ts`
- Create: `src/i18n/messages/en-US.ts`
- Create: `src/i18n/messages/zh-CN.ts`
- Create: `src/i18n/core.ts`
- Create: `src/i18n/__tests__/core.test.ts`
- Modify: `src/shared/ipc-channels.ts`

**Interfaces:**
- Produces: `Locale = 'zh-CN' | 'en-US'`, `resolveLocale(input)`, `translate(locale, key, params?)`, and `MessageKey`.
- Extends: `GlobalConfig.locale?: Locale`.
- Extends: knowledge-base failures with `errorCode?: AppErrorCode`.

- [ ] **Step 1: Write failing locale and fallback tests**

```ts
import { describe, expect, it } from 'vitest'
import { createTranslator, resolveLocale, translate } from '../core'

describe('i18n core', () => {
  it.each([
    ['zh-CN', 'zh-CN'], ['zh-TW', 'zh-CN'], ['en-US', 'en-US'], ['fr-FR', 'en-US'],
  ])('resolves %s to %s', (input, expected) => {
    expect(resolveLocale(input)).toBe(expected)
  })

  it('translates and interpolates without injecting HTML', () => {
    expect(translate('en-US', 'project.current', { name: '<b>Book</b>' }))
      .toBe('Current project: <b>Book</b>')
  })

  it('falls back to English and then the key', () => {
    const t = createTranslator({
      'en-US': { 'common.open': 'Open' },
      'zh-CN': {},
    })
    expect(t('zh-CN', 'common.open')).toBe('Open')
    expect(t('en-US', 'missing.key' as never)).toBe('missing.key')
  })
})
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm exec vitest run src/i18n/__tests__/core.test.ts`

Expected: FAIL because the i18n modules do not exist.

- [ ] **Step 3: Implement locale resolution and translation**

```ts
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = typeof SUPPORTED_LOCALES[number]
export type MessageParams = Record<string, string | number>

export function resolveLocale(input?: string | null): Locale {
  return input?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export function createTranslator(catalogs: Record<Locale, Partial<Record<MessageKey, string>>>) {
  return (locale: Locale, key: MessageKey, params: MessageParams = {}): string => {
    const template = catalogs[locale][key] ?? catalogs['en-US'][key] ?? key
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
  }
}

export const translate = createTranslator(messages)
```

Define English first and derive `MessageKey = keyof typeof enUS`; declare the Chinese dictionary with `satisfies Record<MessageKey, string>` so missing translations fail typecheck.

- [ ] **Step 4: Add shared config and error contracts**

```ts
export type AppErrorCode =
  | 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE'
  | 'PROJECT_NOT_OPEN'
  | 'EMBEDDING_MODEL_NOT_CONFIGURED'

export interface GlobalConfig {
  locale?: Locale
  // existing fields unchanged
}
```

Change knowledge-base channel results to include `errorCode?: AppErrorCode`; search channels return `{ success: boolean; results: SearchResult[]; errorCode?: AppErrorCode; error?: string }`.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm exec vitest run src/i18n/__tests__/core.test.ts`

Run: `pnpm run typecheck`

Expected: PASS.

```powershell
git add src/i18n src/shared/ipc-channels.ts
git commit -m "feat: add typed bilingual message core"
```

### Task 2: Add OS defaulting and persistent renderer state

**Files:**
- Create: `src/stores/locale-store.ts`
- Create: `src/stores/__tests__/locale-store.test.ts`
- Create: `electron/i18n.ts`
- Create: `electron/__tests__/i18n.test.ts`
- Modify: `electron/utils/config-utils.ts`
- Modify: `electron/controllers/config-controller.ts`
- Modify: `electron/main.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces: `useLocaleStore` with `{ locale, initialized, init(), setLocale(), toggleLocale(), t() }`.
- Produces: `getMainLocale(systemLocale?)` and `mainT(key, params?)`.

- [ ] **Step 1: Write failing store tests**

Mock `ipc.invoke` and assert saved config wins, missing config uses `navigator.language`, and `setLocale('en-US')` invokes `config:set` with `{ locale: 'en-US' }`.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm exec vitest run src/stores/__tests__/locale-store.test.ts electron/__tests__/i18n.test.ts`

Expected: FAIL because store and main helper are absent.

- [ ] **Step 3: Implement store initialization and persistence**

```ts
interface LocaleState {
  locale: Locale
  initialized: boolean
  init: () => Promise<void>
  setLocale: (locale: Locale) => Promise<void>
  toggleLocale: () => Promise<void>
  t: (key: MessageKey, params?: MessageParams) => string
}

export const useLocaleStore = create<LocaleState>((set, get) => ({
  locale: resolveLocale(navigator.language),
  initialized: false,
  async init() {
    const config = await ipc.invoke('config:get')
    set({ locale: config.locale ?? resolveLocale(navigator.language), initialized: true })
  },
  async setLocale(locale) {
    set({ locale })
    document.documentElement.lang = locale
    await ipc.invoke('config:set', { locale })
  },
  async toggleLocale() {
    await get().setLocale(get().locale === 'zh-CN' ? 'en-US' : 'zh-CN')
  },
  t: (key, params) => translate(get().locale, key, params),
}))
```

Initialize locale before other app services in `App.tsx`. Do not persist the OS-derived value until the user explicitly changes it.

- [ ] **Step 4: Implement main-process locale lookup**

`getMainLocale()` reads config; if no saved locale, resolve `app.getLocale()`. `mainT()` delegates to the shared translation core. Set the BrowserWindow title through a message key.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm exec vitest run src/stores/__tests__/locale-store.test.ts electron/__tests__/i18n.test.ts`

Expected: PASS.

```powershell
git add src/stores/locale-store.ts src/stores/__tests__/locale-store.test.ts electron/i18n.ts electron/__tests__/i18n.test.ts electron/utils/config-utils.ts electron/controllers/config-controller.ts electron/main.ts src/App.tsx
git commit -m "feat: persist application language preference"
```

### Task 3: Add the two language controls

**Files:**
- Modify: `src/components/layout/TitleBar.tsx`
- Modify: `src/components/settings/SettingsModal.tsx`
- Create: `src/components/layout/__tests__/language-controls.test.tsx`

**Interfaces:**
- Consumes: `useLocaleStore()` from Task 2.
- Produces: one quick toggle and one explicit two-option setting.

- [ ] **Step 1: Write the failing control contract**

Render the title bar with a mocked locale store and assert the `Languages` icon button has translated title, shows `EN` when Chinese is active, and calls `toggleLocale`. Render settings and assert both locale options call `setLocale`.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm exec vitest run src/components/layout/__tests__/language-controls.test.tsx`

Expected: FAIL because neither control exists.

- [ ] **Step 3: Implement the title-bar control**

```tsx
import { Languages } from 'lucide-react'
const { locale, toggleLocale, t } = useLocaleStore()

<button onClick={() => void toggleLocale()} title={t('language.switch')} className="writer-command-button">
  <Languages size={13} strokeWidth={1.5} />
  <span>{locale === 'zh-CN' ? 'EN' : '中文'}</span>
</button>
```

- [ ] **Step 4: Implement the settings control**

At the top of `EditorSection`, add a `NativeSelect` labeled with `t('settings.language')`, values `zh-CN` and `en-US`, and `onChange={(event) => void setLocale(event.target.value as Locale)}`.

- [ ] **Step 5: Run tests, icon hygiene, and commit**

Run: `pnpm exec vitest run src/components/layout/__tests__/language-controls.test.tsx src/components/panels/agent/__tests__/agent-icon-hygiene.test.ts`

Expected: PASS; no Emoji or handwritten SVG paths.

```powershell
git add src/components/layout/TitleBar.tsx src/components/settings/SettingsModal.tsx src/components/layout/__tests__/language-controls.test.tsx
git commit -m "feat: add bilingual interface controls"
```

### Task 4: Migrate all renderer UI copy in bounded groups

**Files:**
- Modify: `src/App.tsx`
- Modify: all files under `src/components/dialogs/`, `src/components/editor/`, `src/components/layout/`, `src/components/pages/`, `src/components/panels/`, `src/components/settings/`, and `src/components/ui/` that contain user-visible literals.
- Modify: UI-facing messages in `src/stores/` and `src/services/`, excluding `prompt-templates.ts`, `project-templates.ts`, `style-presets.ts`, and `src/services/prompts/`.
- Modify: `src/i18n/messages/en-US.ts`
- Modify: `src/i18n/messages/zh-CN.ts`

**Interfaces:**
- Consumes: typed `t()` and stable error codes.
- Produces: no hard-coded user-visible Chinese or English copy in migrated components.

- [ ] **Step 1: Migrate shell and common controls**

Use `const t = useLocaleStore((state) => state.t)` in components and `translate(useLocaleStore.getState().locale, key)` in non-React callbacks. Replace JSX text, `title`, `aria-label`, placeholder, toast, confirm, and fallback strings in `App.tsx`, layout, pages, UI primitives, and `ErrorBoundary.tsx`.

Example transformation:

```tsx
<span>{t('project.current')}</span>
<button title={t('project.open')}>{t('common.open')}</button>
<ErrorBoundary fallbackLabel={t('error.sidebarRender')}>
```

Run: `pnpm run typecheck && pnpm test`

Expected: PASS.

- [ ] **Step 2: Migrate dialogs and settings**

Replace all user-facing text under `src/components/dialogs/` and `src/components/settings/`. Keep creative Prompt textarea contents untouched; translate only the labels and explanations surrounding them.

Run: `pnpm run typecheck && pnpm test`

Expected: PASS.

- [ ] **Step 3: Migrate editors, panels, stores, and UI-facing services**

Replace all user-facing text under editor and panel directories, then error/toast text emitted by stores and services. Preserve domain values stored in project files; translate their display labels at render time rather than changing persisted values.

Run: `pnpm run typecheck && pnpm test`

Expected: PASS.

- [ ] **Step 4: Commit renderer migration**

```powershell
git add src/App.tsx src/components src/stores src/services src/i18n/messages
git commit -m "feat: localize renderer interface copy"
```

### Task 5: Localize main-process dialogs and errors

**Files:**
- Modify: `electron/controllers/config-controller.ts`
- Modify: `electron/controllers/db-controller.ts`
- Modify: `electron/controllers/fs-controller.ts`
- Modify: `electron/controllers/import-controller.ts`
- Modify: `electron/controllers/kb-controller.ts`
- Modify: `electron/controllers/llm-controller.ts`
- Modify: `electron/controllers/project-controller.ts`
- Modify: `electron/controllers/window-controller.ts`
- Modify: `electron/embedding.ts`
- Modify: `electron/knowledge-base.ts`
- Modify: `electron/llm/*.ts`
- Modify: `electron/mcp/*.ts`
- Modify: `src/i18n/messages/en-US.ts`
- Modify: `src/i18n/messages/zh-CN.ts`

**Interfaces:**
- Consumes: `mainT()` and stable `AppErrorCode` values.
- Produces: localized dialog labels and user-visible errors; logs may remain developer-oriented.

- [ ] **Step 1: Replace dialog and IPC response copy**

Use `mainT()` for Electron dialog titles and filters. Return both a stable `errorCode` and localized `error` when the renderer needs a message:

```ts
return {
  success: false,
  errorCode: 'PROJECT_NOT_OPEN',
  error: mainT('error.projectNotOpen'),
}
```

- [ ] **Step 2: Preserve prompt and generation language boundaries**

Do not modify system/user messages sent to LLM providers, knowledge chunk text, or imported project content. Only localize validation, connectivity, file, and runtime errors shown to the user.

- [ ] **Step 3: Run all tests and commit**

Run: `pnpm run typecheck && pnpm test`

Expected: PASS.

```powershell
git add electron src/i18n/messages src/shared/ipc-channels.ts
git commit -m "feat: localize system dialogs and runtime errors"
```

### Task 6: Enforce the localization boundary automatically

**Files:**
- Create: `scripts/check-i18n-coverage.mjs`
- Create: `scripts/i18n-creative-content-allowlist.json`
- Create: `scripts/__tests__/check-i18n-coverage.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `pnpm check:i18n`.

- [ ] **Step 1: Write failing scanner tests**

Use the TypeScript compiler API to scan string literals, template literal text, JSX text, and user-visible JSX attributes. Assert a fixture `<button title="打开">保存</button>` fails, a comment containing Chinese passes, and an allow-listed creative Prompt file passes.

- [ ] **Step 2: Implement the AST scanner**

Scan `src/App.tsx`, `src/components`, and UI-facing Electron controller strings. Allow only:

```json
[
  "src/services/prompt-templates.ts",
  "src/services/project-templates.ts",
  "src/services/style-presets.ts",
  "src/services/prompts/**",
  "src/services/workflows/commands/**"
]
```

The allow-list is path-based, not a blanket phrase exemption. Fail with file, line, and literal.

- [ ] **Step 3: Wire and run the coverage gate**

Add `"check:i18n": "node scripts/check-i18n-coverage.mjs"`.

Run: `pnpm exec vitest run scripts/__tests__/check-i18n-coverage.test.ts`

Run: `pnpm check:i18n`

Run: `pnpm run typecheck && pnpm test`

Expected: all PASS; remaining Han literals are creative content, comments, tests, or developer logs outside the user-visible scope.

- [ ] **Step 4: Commit**

```powershell
git add scripts/check-i18n-coverage.mjs scripts/i18n-creative-content-allowlist.json scripts/__tests__/check-i18n-coverage.test.ts package.json
git commit -m "test: enforce bilingual interface coverage"
```
