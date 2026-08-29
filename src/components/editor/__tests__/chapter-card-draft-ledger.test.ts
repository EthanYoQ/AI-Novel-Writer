import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { normalizeSourceEol } from '../../../../test/source-contract'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import {
  CHAPTER_CARD_TAB_ID,
  captureBlueprintSnapshots,
  createEmptyChapterCardDraftLedger,
  getChapterCardProjectDraft,
  mergeChapterCardDraftWithRemote,
  parseChapterCardDraftLedger,
  persistChapterCardDraftLedger,
  refreshChapterCardDraftFromRemote,
  reconcileClearedBlueprintSnapshots,
  reconcileDeletedBlueprintSnapshots,
  reconcileSavedBlueprintSnapshots,
  updateEditableChapterBlueprintField,
  updateChapterCardProjectDraft,
} from '../chapter-card-draft-ledger'

function blueprint(chapterNumber: number, title: string): ChapterBlueprint {
  return {
    chapterNumber,
    title,
    role: '发展',
    purpose: '',
    keyEvents: '',
    characters: [],
    suspenseHook: '',
    userGuidance: '',
    notes: '',
    notesUpdatedAt: '',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

describe('chapter-card draft ledger', () => {
  it('always writes the fixed chapter-card tab and remains dirty until every project is saved', () => {
    const projectA = [blueprint(1, 'A 未保存')]
    const projectB = [blueprint(2, 'B 未保存')]
    let ledger = updateChapterCardProjectDraft(
      createEmptyChapterCardDraftLedger(),
      'C:\\novels\\a',
      projectA,
      new Set([1]),
    )
    ledger = updateChapterCardProjectDraft(ledger, 'C:\\novels\\b', projectB, new Set([2]))
    const writer = {
      tabs: [
        { type: 'chapter-card', projectKey: 'C:\\novels\\a' },
        { type: 'chapter-card', projectKey: 'C:\\novels\\b' },
      ],
      draftLedgers: {},
      setDraftLedger: vi.fn(),
      setProjectEditorDirty: vi.fn(),
    }

    persistChapterCardDraftLedger(writer, ledger)

    expect(writer.setDraftLedger).toHaveBeenCalledWith(
      CHAPTER_CARD_TAB_ID,
      expect.any(String),
    )
    expect(writer.setProjectEditorDirty).toHaveBeenCalledWith(
      'chapter-card',
      'C:\\novels\\a',
      true,
    )

    ledger = updateChapterCardProjectDraft(ledger, 'C:\\novels\\a', projectA, new Set())
    expect(getChapterCardProjectDraft(ledger, 'C:\\novels\\b')?.dirtyChapterNumbers).toEqual([2])
    ledger = updateChapterCardProjectDraft(ledger, 'C:\\novels\\b', projectB, new Set())
    persistChapterCardDraftLedger(writer, ledger)
    expect(writer.setProjectEditorDirty).toHaveBeenCalledWith(
      'chapter-card',
      'C:\\novels\\b',
      false,
    )
  })

  it('serializes projects separately and restores only the requested project', () => {
    const projectA = [blueprint(1, 'A 草稿')]
    const projectB = [blueprint(1, 'B 草稿')]
    let ledger = updateChapterCardProjectDraft(
      createEmptyChapterCardDraftLedger(),
      'project-a',
      projectA,
      new Set([1]),
    )
    ledger = updateChapterCardProjectDraft(ledger, 'project-b', projectB, new Set([1]))

    const restored = parseChapterCardDraftLedger(JSON.stringify(ledger))

    expect(getChapterCardProjectDraft(restored, 'project-a')?.blueprints).toEqual(projectA)
    expect(getChapterCardProjectDraft(restored, 'project-b')?.blueprints).toEqual(projectB)
  })

  it('saving one chapter clears only that unchanged snapshot', () => {
    const chapters = [blueprint(1, '第一章'), blueprint(2, '第二章')]
    const remaining = reconcileSavedBlueprintSnapshots(
      chapters,
      new Set([1, 2]),
      captureBlueprintSnapshots([chapters[0]]),
    )

    expect([...remaining]).toEqual([2])
  })

  it('keeps a chapter dirty when it changes while its asynchronous save is pending', () => {
    const saveInput = blueprint(1, '保存开始时')
    const editedWhileSaving = blueprint(1, '保存期间继续编辑')

    const remaining = reconcileSavedBlueprintSnapshots(
      [editedWhileSaving],
      new Set([1]),
      captureBlueprintSnapshots([saveInput]),
    )

    expect([...remaining]).toEqual([1])
  })

  it('save-all clears matching chapters but preserves edits made after its snapshot', () => {
    const saveInput = [blueprint(1, '第一章'), blueprint(2, '第二章')]
    const current = [saveInput[0], blueprint(2, '第二章继续修改')]

    const remaining = reconcileSavedBlueprintSnapshots(
      current,
      new Set([1, 2]),
      captureBlueprintSnapshots(saveInput),
    )

    expect([...remaining]).toEqual([2])
  })

  it('delete and clear remove only persisted snapshots and retain concurrent edits as dirty', () => {
    const deletedInput = blueprint(1, '删除开始时')
    const changedDuringDelete = blueprint(1, '删除期间继续编辑')
    const deleteResult = reconcileDeletedBlueprintSnapshots(
      [changedDuringDelete, blueprint(2, '另一章')],
      new Set([2]),
      captureBlueprintSnapshots([deletedInput]),
    )
    expect(deleteResult.blueprints.map(item => item.title)).toEqual(['删除期间继续编辑', '另一章'])
    expect([...deleteResult.dirtyChapterNumbers].sort()).toEqual([1, 2])

    const clearInput = [blueprint(1, '保持不变'), blueprint(2, '清空开始时')]
    const clearResult = reconcileClearedBlueprintSnapshots(
      [clearInput[0], blueprint(2, '清空期间继续编辑'), blueprint(3, '新章节')],
      captureBlueprintSnapshots(clearInput),
    )
    expect(clearResult.blueprints.map(item => item.chapterNumber)).toEqual([2, 3])
    expect([...clearResult.dirtyChapterNumbers].sort()).toEqual([2, 3])
  })

  it('merges dirty local chapters with clean remote changes and additions', () => {
    const draft = {
      projectKey: 'project-a',
      blueprints: [
        blueprint(1, '本地第一章'),
        blueprint(2, '旧第二章'),
        blueprint(4, '本地新增第四章'),
      ],
      dirtyChapterNumbers: [1, 4, 5],
    }
    const remote = [
      blueprint(1, '旧第一章'),
      blueprint(2, '远端第二章'),
      blueprint(3, '远端新增第三章'),
      blueprint(5, '本地已删第五章'),
    ]

    const merged = mergeChapterCardDraftWithRemote(draft, remote)

    expect(merged.blueprints.map(item => [item.chapterNumber, item.title])).toEqual([
      [1, '本地第一章'],
      [2, '远端第二章'],
      [3, '远端新增第三章'],
      [4, '本地新增第四章'],
    ])
    expect([...merged.dirtyChapterNumbers].sort()).toEqual([1, 4, 5])
  })

  it('reads the latest local ledger after a deferred remote load before committing', async () => {
    const remote = deferred<ChapterBlueprint[]>()
    let ledger = createEmptyChapterCardDraftLedger()
    let committed: ReturnType<typeof mergeChapterCardDraftWithRemote> | undefined
    const refresh = refreshChapterCardDraftFromRemote({
      projectKey: 'project-a',
      loadRemote: () => remote.promise,
      readLedger: () => ledger,
      isProjectCurrent: () => true,
      commit: state => { committed = state },
    })

    // 远端尚未返回时，用户继续修改第一章。
    ledger = updateChapterCardProjectDraft(
      ledger,
      'project-a',
      [blueprint(1, '本地第一章'), blueprint(2, '旧第二章')],
      new Set([1]),
    )
    remote.resolve([blueprint(1, '旧第一章'), blueprint(2, '远端第二章')])
    await refresh

    expect(committed?.blueprints.map(item => [item.chapterNumber, item.title])).toEqual([
      [1, '本地第一章'],
      [2, '远端第二章'],
    ])
    expect([...committed!.dirtyChapterNumbers]).toEqual([1])
  })

  it('does not read or commit a deferred load after the project identity changes', async () => {
    const remote = deferred<ChapterBlueprint[]>()
    let currentProject = 'project-a'
    const readLedger = vi.fn(() => createEmptyChapterCardDraftLedger())
    const commit = vi.fn()
    const refresh = refreshChapterCardDraftFromRemote({
      projectKey: 'project-a',
      loadRemote: () => remote.promise,
      readLedger,
      isProjectCurrent: () => currentProject === 'project-a',
      commit,
    })

    currentProject = 'project-b'
    remote.resolve([blueprint(1, '项目 A')])

    await expect(refresh).resolves.toBeUndefined()
    expect(readLedger).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('keeps chapter numbers immutable while ordinary fields use the original number as dirty identity', () => {
    const original = blueprint(7, '旧标题')
    const updated = updateEditableChapterBlueprintField(original, 'title', '新标题')
    const unsafeUpdate = updateEditableChapterBlueprintField as (
      input: ChapterBlueprint,
      key: keyof ChapterBlueprint,
      value: unknown,
    ) => ChapterBlueprint

    expect(updated).toMatchObject({ chapterNumber: 7, title: '新标题' })
    expect(unsafeUpdate(original, 'chapterNumber', 99).chapterNumber).toBe(7)

    const ledger = updateChapterCardProjectDraft(
      createEmptyChapterCardDraftLedger(),
      'project-a',
      [updated],
      new Set([original.chapterNumber]),
    )
    expect(getChapterCardProjectDraft(ledger, 'project-a')?.dirtyChapterNumbers).toEqual([7])
  })

  it('renders the chapter number as a readonly field with no ordinary renumber action', () => {
    const source = normalizeSourceEol(
      readFileSync('src/components/editor/ChapterCardEditor.tsx', 'utf8'),
    )
    const chapterNumberInput = source.match(
      /<Input\s+type="number"\s+value=\{selected\.chapterNumber\}[\s\S]*?\/>/,
    )?.[0]

    expect(source).toContain('K extends EditableChapterBlueprintField')
    expect(chapterNumberInput).toContain('readOnly')
    expect(chapterNumberInput).not.toContain('onChange')
    expect(chapterNumberInput).not.toContain('onBlur')
    expect(source).not.toContain("updateField('chapterNumber'")
  })

  it('binds chapter-card IPC reads and writes to the loaded project identity', () => {
    const componentSource = normalizeSourceEol(
      readFileSync('src/components/editor/ChapterCardEditor.tsx', 'utf8'),
    )
    const workflowSource = normalizeSourceEol(
      readFileSync('src/services/workflows/directory-workflow.ts', 'utf8'),
    )

    // A path is only a location.  The editor must bind reads/writes to the
    // frozen project ID + lease as well, so a same-path reopen cannot apply
    // stale work to the new session.
    expect(componentSource).toContain(
      'function currentProjectSessionForPath(projectKey: string): ProjectSessionContext | null',
    )
    expect(componentSource).toContain(
      'sameProjectSessionContext(dataProjectSessionRef.current, projectSession)',
    )
    expect(componentSource).toContain('loadRemote: () => loadDirectoryBlueprints(projectKey, projectSession)')
    expect(componentSource).toContain('await saveChapterBlueprint(selected, projectKey, projectSession)')
    expect(componentSource).toContain('await saveAllBlueprints(saveInput, projectKey, projectSession)')
    expect(componentSource).toContain(
      "'db:blueprint-delete',\n      selected.chapterNumber,\n      projectKey,",
    )
    expect(componentSource).toContain(
      "'db:blueprint-clear-all',\n      projectKey,",
    )
    expect(componentSource).toContain('ipc.invokeWithProjectSession(\n      projectSession,')
    expect(workflowSource).toContain(
      "ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', expectedProjectPath)",
    )
    expect(workflowSource).toContain(
      "ipc.invokeWithProjectSession(projectSession, 'db:blueprint-upsert', blueprint, expectedProjectPath)",
    )
    expect(workflowSource).toContain(
      "ipc.invokeWithProjectSession(projectSession, 'db:blueprint-upsert-many', blueprints, expectedProjectPath)",
    )
  })

  it('only exposes writing actions for an actual next blueprint instead of rendering a no-op button', () => {
    const source = normalizeSourceEol(
      readFileSync('src/components/editor/ChapterCardEditor.tsx', 'utf8'),
    )

    expect(source).toContain(
      'const nextWritableBlueprint = nextWriteChapter === null\n    ? null\n    : visibleBlueprints.find(blueprint => blueprint.chapterNumber === nextWriteChapter)',
    )
    expect(source).toContain('{projectDataReady && nextWritableBlueprint && (')
    expect(source).toContain('onClick={() => handleWriteChapter(nextWritableBlueprint)}')
    expect(source).not.toContain(
      "const bp = visibleBlueprints.find(b => b.chapterNumber === nextWriteChapter)\n                if (bp) handleWriteChapter(bp)",
    )
  })

  it('offers a confirmed recovery path when legacy imported text creates a writing gap', () => {
    const source = normalizeSourceEol(
      readFileSync('src/components/editor/ChapterCardEditor.tsx', 'utf8'),
    )
    const handlerStart = source.indexOf('const handleClearLegacyImportedText = async () => {')
    const handlerEnd = source.indexOf('\n  if (loading)', handlerStart)
    const recoveryHandler = source.slice(handlerStart, handlerEnd)

    expect(source).toContain(
      'const canRecoverLegacyImportedText = projectDataReady\n    && legacyImportedTextRecoveryChapter !== null',
    )
    expect(source).toContain(
      'const recoveryChapter = error instanceof AuthoritativeChapterSequenceError',
    )
    expect(source).toContain('error.sequence.firstGapChapterNumber')
    expect(source).toContain('setLegacyImportedTextRecoveryChapter(recoveryChapter)')
    expect(source).toContain('setNextWriteChapter(null)')
    expect(source).toContain('{canRecoverLegacyImportedText && (')
    expect(source).toContain('onClick={handleClearLegacyImportedText}')
    expect(recoveryHandler).toContain("confirmText: text('清除误导入正文', 'Clear incorrectly imported text')")
    expect(recoveryHandler).toContain('danger: true')
    expect(recoveryHandler).toContain('if (!ok || !isCurrentProjectSession(projectSession)) return')
    expect(recoveryHandler).toContain('await clearProjectData({ generatedText: true }, projectSession)')
    expect(recoveryHandler).not.toContain('blueprints: true')
    expect(recoveryHandler).not.toContain('creativeFields: true')
    expect(recoveryHandler).toContain('await loadBlueprints()')
  })
})
