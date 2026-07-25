import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(file: string) {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

const sessionGatedAsyncFiles = [
  'src/components/pages/KnowledgeOverview.tsx',
  'src/components/panels/KnowledgePanel.tsx',
  'src/components/editor/ArchFileViewer.tsx',
  'src/components/dialogs/BatchChapterCreationDialog.tsx',
  'src/components/dialogs/ChapterCreationDialog.tsx',
  'src/components/dialogs/DirectoryConfigDialog.tsx',
  'src/components/editor/CharacterEditor.tsx',
  'src/components/editor/DraftEditor.tsx',
  'src/components/editor/VersionHistory.tsx',
  'src/components/editor/WorldBuildingEditor.tsx',
  'src/components/editor/NovelConfigEditor.tsx',
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
      'src/components/pages/KnowledgeOverview.tsx',
      'src/components/panels/KnowledgePanel.tsx',
      'src/components/editor/ArchFileViewer.tsx',
      'src/components/dialogs/BatchChapterCreationDialog.tsx',
      'src/components/dialogs/ChapterCreationDialog.tsx',
      'src/components/editor/DraftEditor.tsx',
      'src/components/editor/VersionHistory.tsx',
    ]

    for (const file of mutationSurfaces) {
      expect(source(file), file).toContain('ipc.invokeWithProjectSession')
    }
  })

  it('passes the frozen session through DraftEditor helper calls that perform async work', () => {
    const draftEditor = source('src/components/editor/DraftEditor.tsx')

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
