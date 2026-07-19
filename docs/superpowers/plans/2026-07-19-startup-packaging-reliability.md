# Startup and Packaging Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows application start reliably by packaging the LanceDB native binding and isolating knowledge-base initialization from Electron startup.

**Architecture:** pnpm becomes the single reproducible package manager. A cached dynamic loader moves LanceDB behind the knowledge-base IPC boundary, while package verification checks the final unpacked app and real executable before ZIP creation.

**Tech Stack:** Electron 41, TypeScript 6, Vitest 4, pnpm 11, electron-builder 26, PowerShell 7.

## Global Constraints

- Target release is `v0.2.0`; Windows x64 is the release verification platform.
- The app must open even when the knowledge-base native module is unavailable.
- The release package must still contain and load `@lancedb/lancedb-win32-x64-msvc`; graceful degradation is not a substitute for correct packaging.
- Do not change knowledge-base data paths or storage formats.
- Frozen `pnpm-lock.yaml` installation is the only release dependency path.
- Clean scripts may remove only resolved `dist`, `dist-electron`, and version-specific `release` paths inside the repository.

---

### Task 1: Make the knowledge-base module lazily loadable

**Files:**
- Create: `electron/services/knowledge-base-loader.ts`
- Create: `electron/services/__tests__/knowledge-base-loader.test.ts`
- Modify: `electron/controllers/kb-controller.ts`

**Interfaces:**
- Produces: `createKnowledgeBaseLoader(importer?)` with `load(): Promise<KnowledgeBaseModule>` and `resetForTests(): void`.
- Produces: `KnowledgeBaseUnavailableError` with code `KNOWLEDGE_BASE_NATIVE_UNAVAILABLE`.
- Consumes: the existing exports of `electron/knowledge-base.ts` without changing their signatures.

- [ ] **Step 1: Write the failing loader tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createKnowledgeBaseLoader, KnowledgeBaseUnavailableError } from '../knowledge-base-loader'

describe('knowledge-base loader', () => {
  it('loads once and caches the module', async () => {
    const module = { searchKnowledgeFTS: vi.fn() }
    const importer = vi.fn().mockResolvedValue(module)
    const loader = createKnowledgeBaseLoader(importer)
    expect(await loader.load()).toBe(module)
    expect(await loader.load()).toBe(module)
    expect(importer).toHaveBeenCalledTimes(1)
  })

  it('normalizes and caches native binding failures', async () => {
    const importer = vi.fn().mockRejectedValue(new Error('Cannot find native binding'))
    const loader = createKnowledgeBaseLoader(importer)
    await expect(loader.load()).rejects.toMatchObject({
      code: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE',
    })
    await expect(loader.load()).rejects.toBeInstanceOf(KnowledgeBaseUnavailableError)
    expect(importer).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm exec vitest run electron/services/__tests__/knowledge-base-loader.test.ts`

Expected: FAIL because `knowledge-base-loader.ts` does not exist.

- [ ] **Step 3: Implement the cached dynamic loader**

```ts
export type KnowledgeBaseModule = typeof import('../knowledge-base')
type Importer = () => Promise<KnowledgeBaseModule>
type KBUnavailableResult = {
  success: false
  errorCode: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE'
}

export class KnowledgeBaseUnavailableError extends Error {
  readonly code = 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE' as const
  constructor(readonly cause: unknown) {
    super('Knowledge base native module is unavailable')
    this.name = 'KnowledgeBaseUnavailableError'
  }
}

export function createKnowledgeBaseLoader(
  importer: Importer = () => import('../knowledge-base'),
) {
  let cached: Promise<KnowledgeBaseModule> | null = null
  return {
    load() {
      cached ??= importer().catch((error) => {
        console.error('[KnowledgeBase] native module load failed', error)
        throw new KnowledgeBaseUnavailableError(error)
      })
      return cached
    },
    resetForTests() {
      cached = null
    },
  }
}

export const knowledgeBaseLoader = createKnowledgeBaseLoader()
```

- [ ] **Step 4: Replace the static knowledge-base import in the controller**

Remove the top-level import from `../knowledge-base`. In every `kb:*` handler, obtain the module inside the async callback:

```ts
const kb = await knowledgeBaseLoader.load()
return kb.importDocument(filePath, projectPath, protocol, model)
```

Wrap handlers with one helper so a loader failure returns a structured result without swallowing ordinary operation errors:

```ts
async function withKnowledgeBase<T>(operation: (kb: KnowledgeBaseModule) => Promise<T> | T): Promise<T | KBUnavailableResult> {
  try {
    return await operation(await knowledgeBaseLoader.load())
  } catch (error) {
    if (error instanceof KnowledgeBaseUnavailableError) {
      return { success: false, errorCode: error.code }
    }
    throw error
  }
}
```

Search endpoints must return a typed `{ success, results, errorCode }` envelope rather than an empty array so the renderer can distinguish “no matches” from “feature unavailable”; the matching channel return types are updated in the bilingual-interface plan before any renderer call site is migrated.

- [ ] **Step 5: Run focused and existing tests**

Run: `pnpm exec vitest run electron/services/__tests__/knowledge-base-loader.test.ts electron/__tests__/main-window-contract.test.ts`

Expected: both files PASS and importing `electron/ipc-handlers.ts` no longer statically reaches `electron/knowledge-base.ts`.

- [ ] **Step 6: Commit**

```powershell
git add electron/services/knowledge-base-loader.ts electron/services/__tests__/knowledge-base-loader.test.ts electron/controllers/kb-controller.ts
git commit -m "fix: isolate knowledge base native startup"
```

### Task 2: Establish a reproducible pnpm dependency contract

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `pnpm-workspace.yaml`
- Delete: `package-lock.json`
- Modify: `.npmrc`

**Interfaces:**
- Produces: `pnpm install --frozen-lockfile` as the only supported install command.
- Produces: a direct optional dependency edge to `@lancedb/lancedb-win32-x64-msvc`.

- [ ] **Step 1: Add a failing package contract test**

Create `electron/__tests__/package-contract.test.ts` with:

```ts
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

describe('release dependency contract', () => {
  it('uses one pinned package manager and exposes the Windows LanceDB binding', () => {
    expect(pkg.packageManager).toMatch(/^pnpm@11\./)
    expect(pkg.optionalDependencies?.['@lancedb/lancedb-win32-x64-msvc']).toBe('0.27.2')
    expect(existsSync('package-lock.json')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm exec vitest run electron/__tests__/package-contract.test.ts`

Expected: FAIL for missing `packageManager`, optional dependency, and stale npm lock.

- [ ] **Step 3: Update package metadata and pnpm build permissions**

Add to `package.json`:

```json
"packageManager": "pnpm@11.11.0",
"optionalDependencies": {
  "@lancedb/lancedb-win32-x64-msvc": "0.27.2"
}
```

Move native build allow-listing entirely to `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  better-sqlite3: true
  electron: true
  electron-winstaller: true
  esbuild: true
  '@lancedb/lancedb-win32-x64-msvc': true
```

Remove the deprecated `package.json.pnpm` block and stale `package-lock.json`. Keep `.npmrc` only for active pnpm settings; remove the obsolete Electron mirror entry if it no longer resolves.

- [ ] **Step 4: Regenerate and prove the frozen lock**

Run: `pnpm install`

Run: `pnpm install --frozen-lockfile`

Run: `pnpm why @lancedb/lancedb-win32-x64-msvc`

Expected: all commands exit 0, and the final command shows the optional package on Windows x64.

- [ ] **Step 5: Run the contract test and commit**

Run: `pnpm exec vitest run electron/__tests__/package-contract.test.ts`

Expected: PASS.

```powershell
git add package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc electron/__tests__/package-contract.test.ts
git rm package-lock.json
git commit -m "build: make pnpm release dependencies reproducible"
```

### Task 3: Add clean-build and package-native verification gates

**Files:**
- Create: `scripts/clean-build-output.mjs`
- Create: `scripts/verify-win-package.mjs`
- Create: `scripts/smoke-win-app.ps1`
- Modify: `scripts/package-win-zip.ps1`
- Modify: `package.json`
- Modify: `electron-builder.json5`

**Interfaces:**
- Produces: `pnpm clean:build`, `pnpm verify:win-package`, and `pnpm smoke:win-app`.
- Consumes: `release/<version>/win-unpacked` from electron-builder.

- [ ] **Step 1: Write failing tests for safe path resolution and package inspection**

Create `scripts/__tests__/release-paths.test.ts` and export `resolveBuildTargets(root, version)` from the cleaner. Assert every target begins with `root + path.sep`, rejects empty/root paths, and returns only `dist`, `dist-electron`, and `release/<version>`.

Create `scripts/__tests__/verify-win-package.test.ts` around an exported `findLanceBinding(unpackedDir)` using a temporary fixture. Assert it rejects a fixture without `.node` and accepts:

```text
resources/app.asar.unpacked/node_modules/@lancedb/lancedb-win32-x64-msvc/lancedb.win32-x64-msvc.node
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run scripts/__tests__/release-paths.test.ts scripts/__tests__/verify-win-package.test.ts`

Expected: FAIL because both scripts are absent.

- [ ] **Step 3: Implement safe cleanup and native inspection**

The cleaner must use `realpathSync(root)`, `resolve(root, relative)`, and an `isInsideRoot` guard before `rmSync(target, { recursive: true, force: true })`.

The verifier must fail unless all are present:

```js
const required = [
  'resources/app.asar',
  'AI小说作家.exe',
]
const binding = findLanceBinding(unpackedDir)
if (!binding) throw new Error('Missing LanceDB Windows native binding')
```

- [ ] **Step 4: Tighten electron-builder collection rules**

Keep the existing files list and add the wrapper plus native package to `asarUnpack`:

```json5
"node_modules/@lancedb/lancedb/**/*",
"node_modules/@lancedb/lancedb-win32-x64-msvc/**/*"
```

- [ ] **Step 5: Implement a real executable smoke probe**

`scripts/smoke-win-app.ps1` accepts `-ExePath` and `-ObservationSeconds 12`, starts the exact EXE with a temporary `--user-data-dir`, waits for a top-level window handle, then fails if the process exits or never creates a window. It terminates only the process it started in `finally`.

- [ ] **Step 6: Wire scripts into `package.json` and ZIP packaging**

```json
"clean:build": "node scripts/clean-build-output.mjs",
"typecheck": "tsc --noEmit",
"test": "vitest run",
"build:win-dir": "pnpm clean:build && tsc && vite build && electron-builder --win dir --x64 && pnpm verify:win-package",
"verify:win-package": "node scripts/verify-win-package.mjs",
"smoke:win-app": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-win-app.ps1"
```

Change `scripts/package-win-zip.ps1` from `npm run build:win-dir` to `pnpm run build:win-dir`; run the smoke probe before copying files; name the archive `AI-Novel-Writer-$version-windows-x64.zip`; write `SHA256SUMS.txt` with ZIP and EXE hashes.

- [ ] **Step 7: Run tests, build, structural verification, and smoke**

Run: `pnpm exec vitest run scripts/__tests__/release-paths.test.ts scripts/__tests__/verify-win-package.test.ts`

Run: `pnpm run build:win-dir`

Run: `pnpm run smoke:win-app -- -ExePath "release/0.1.0/win-unpacked/AI小说作家.exe"`

Expected: tests PASS; verifier prints the exact `.node` path; EXE creates a window and remains alive for the observation period.

- [ ] **Step 8: Commit**

```powershell
git add package.json electron-builder.json5 scripts
git commit -m "build: verify native Windows release artifacts"
```

### Task 4: Run the startup reliability gate

**Files:**
- No new files.

**Interfaces:**
- Produces: evidence required by the later release plan.

- [ ] **Step 1: Run the full source gate**

Run: `pnpm install --frozen-lockfile`

Run: `pnpm run typecheck`

Run: `pnpm test`

Expected: all exit 0; test count is at least the baseline 27 files / 94 tests plus the new tests.

- [ ] **Step 2: Build from clean output and run artifact gates**

Run: `pnpm run build:win-dir`

Run: `pnpm run verify:win-package`

Run: `pnpm run smoke:win-app -- -ExePath "release/0.1.0/win-unpacked/AI小说作家.exe"`

Expected: clean build, native binding found, window created, no main-process crash.

- [ ] **Step 3: Confirm no stale product files**

Run: `rg -a -n "Mythpen" release/0.1.0/win-unpacked`

Expected: no matches.

- [ ] **Step 4: Commit any verification-only corrections, otherwise leave the tree unchanged**

Run: `git status --short`

Expected: only the repository-local `.agents/` and `AGENTS.md` remain untracked; no generated release files are staged.
