import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(file: string) {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

const sessionGatedAsyncFiles = [
  'src/components/stage/knowledge/use-knowledge-base.ts',
  'src/components/editor/ArchFileViewer.tsx',
  'src/components/dialogs/use-batch-chapter-form.ts',
  'src/components/dialogs/use-directory-config-form.ts',
  'src/components/editor/use-character-profile.ts',
  'src/components/stage/history/use-version-history.ts',
  'src/components/editor/use-architecture-overview.ts',
  'src/components/stage/plot/use-plot-threads.ts',
  'src/components/editor/use-novel-config-form.ts',
  'src/components/dialogs/ExportDialog.tsx',
  'src/components/dialogs/ClearProjectDataDialog.tsx',
]

describe('UI project session gates', () => {
  it('uses the full project id + lease gate in every migrated UI surface', () => {
    for (const file of sessionGatedAsyncFiles) {
      const content = source(file)
      expect(content, file).toContain('captureProjectSession')
      expect(content, file).toContain('isProjectSessionCurrent')
    }
  })

  it('uses frozen-session IPC for UI mutations instead of recapturing by path', () => {
    const mutationSurfaces = [
      'src/components/stage/knowledge/use-knowledge-base.ts',
          'src/components/editor/ArchFileViewer.tsx',
      'src/components/dialogs/use-batch-chapter-form.ts',
          'src/components/editor/use-draft-actions.ts',
      'src/components/stage/history/use-version-history.ts',
    ]

    for (const file of mutationSurfaces) {
      expect(source(file), file).toContain('ipc.invokeWithProjectSession')
    }
  })

  it('passes the frozen session through DraftEditor helper calls that perform async work', () => {
    // 单章视图的草稿异步动作在 use-draft-actions 里。
    const draftEditor = source('src/components/editor/use-draft-actions.ts')

    expect(draftEditor).toContain('parseDraftMeta(filePath, projectKey, projectSession)')
    expect(draftEditor).toContain('readDraftBody(filePath, projectKey, projectSession)')
    expect(draftEditor).toContain('retryFinalizationPublication(finalizationId, projectSession)')
  })

  it('freezes the lease before the export directory picker and clear confirmation await', () => {
    const exportDialog = source('src/components/dialogs/ExportDialog.tsx')
    const clearDialog = source('src/components/dialogs/ClearProjectDataDialog.tsx')

    expect(exportDialog).toContain('const projectSession = captureProjectSession(currentProject)')
    expect(exportDialog).toContain("await ipc.invoke('dialog:select-export-directory')")
    expect(exportDialog).toContain('exportNovel({ format, grantId: destination.grantId, includeOutline }, projectSnapshot, projectSession)')
    expect(clearDialog).toContain('const projectSession = captureProjectSession(currentProject)')
    expect(clearDialog).toContain('clearProjectData(selected, projectSession)')
  })
})
