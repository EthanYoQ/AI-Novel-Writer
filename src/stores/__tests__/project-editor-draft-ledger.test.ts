import { describe, expect, it, vi } from 'vitest'

import {
  CHARACTER_DRAFT_TAB,
  CONFIG_DRAFT_TAB,
  createEmptyProjectEditorDraftLedger,
  getProjectEditorDraft,
  mergeNamedRecordDraftWithRemote,
  mergeObjectDraftWithRemote,
  parseProjectEditorDraftLedger,
  persistProjectEditorDraftLedger,
  rebaseProjectEditorDraft,
  recordProjectEditorEdit,
  settleProjectEditorSave,
} from '../project-editor-draft-ledger'

describe('explicit editor draft ledger', () => {
  it('isolates recoverable character-card drafts by project', () => {
    let ledger = recordProjectEditorEdit(
      createEmptyProjectEditorDraftLedger<string[]>(),
      'project-a',
      ['角色A'],
      ['角色A-未保存'],
    )
    ledger = recordProjectEditorEdit(ledger, 'project-b', ['角色B'], ['角色B-未保存'])

    const restored = parseProjectEditorDraftLedger<string[]>(JSON.stringify(ledger))

    expect(getProjectEditorDraft(restored, 'project-a')?.draftValue).toEqual(['角色A-未保存'])
    expect(getProjectEditorDraft(restored, 'project-b')?.draftValue).toEqual(['角色B-未保存'])
  })

  it('keeps edits made while a configuration save is pending', () => {
    const before = { title: '保存前' }
    const saveInput = { title: '开始保存' }
    const editedWhileSaving = { title: '保存期间继续编辑' }
    const ledger = recordProjectEditorEdit(
      createEmptyProjectEditorDraftLedger<typeof before>(),
      'project-a',
      before,
      saveInput,
    )

    const settled = settleProjectEditorSave(
      ledger,
      'project-a',
      saveInput,
      editedWhileSaving,
    )

    expect(getProjectEditorDraft(settled, 'project-a')).toEqual({
      projectKey: 'project-a',
      baseValue: saveInput,
      draftValue: editedWhileSaving,
    })
  })

  it('clears only the saved project while another project remains dirty', () => {
    let ledger = recordProjectEditorEdit(
      createEmptyProjectEditorDraftLedger<string>(),
      'project-a',
      'A',
      'A*',
    )
    ledger = recordProjectEditorEdit(ledger, 'project-b', 'B', 'B*')
    ledger = settleProjectEditorSave(ledger, 'project-a', 'A*', 'A*')

    expect(getProjectEditorDraft(ledger, 'project-a')).toBeUndefined()
    expect(getProjectEditorDraft(ledger, 'project-b')?.draftValue).toBe('B*')
  })

  it('persists recoverable content in background state and marks only matching visible editors dirty', () => {
    const writer = {
      tabs: [
        { id: 'visible-a', name: '角色卡 A', type: 'character' as const, projectKey: 'project-a' },
        { id: 'visible-b', name: '角色卡 B', type: 'character' as const, projectKey: 'project-b' },
      ],
      draftLedgers: {},
      setDraftLedger: vi.fn(),
      setProjectEditorDirty: vi.fn(),
    }
    const characterLedger = recordProjectEditorEdit(
      createEmptyProjectEditorDraftLedger<string[]>(),
      'project-a',
      ['旧角色'],
      ['新角色'],
    )

    persistProjectEditorDraftLedger(writer, CHARACTER_DRAFT_TAB, characterLedger)

    expect(writer.setDraftLedger).toHaveBeenCalledWith(
      CHARACTER_DRAFT_TAB.id,
      expect.any(String),
    )
    expect(writer.setProjectEditorDirty).toHaveBeenCalledWith('character', 'project-a', true)
    expect(writer.setProjectEditorDirty).toHaveBeenCalledWith('character', 'project-b', false)
    expect(CONFIG_DRAFT_TAB.id).toBe('config')
  })

  it('merges local and remote configuration fields and rebases the draft ledger', () => {
    const base = { fieldA: '旧 A', fieldB: '旧 B' }
    const draft = { fieldA: '本地 A', fieldB: '旧 B' }
    const remote = { fieldA: '旧 A', fieldB: '远端 B' }
    const ledger = recordProjectEditorEdit(
      createEmptyProjectEditorDraftLedger<typeof base>(),
      'project-a',
      base,
      draft,
    )

    const restored = rebaseProjectEditorDraft(
      ledger,
      'project-a',
      remote,
      mergeObjectDraftWithRemote,
    )

    expect(restored.value).toEqual({ fieldA: '本地 A', fieldB: '远端 B' })
    expect(getProjectEditorDraft(restored.ledger, 'project-a')).toEqual({
      projectKey: 'project-a',
      baseValue: remote,
      draftValue: { fieldA: '本地 A', fieldB: '远端 B' },
    })
  })

  it('merges character records by name while preserving local add/delete boundaries', () => {
    const base = [
      { name: 'A', notes: '旧 A' },
      { name: 'B', notes: '旧 B' },
      { name: '删除', notes: '旧值' },
    ]
    const draft = [
      { name: 'A', notes: '本地 A' },
      { name: 'B', notes: '旧 B' },
      { name: '本地新增', notes: '本地' },
    ]
    const remote = [
      { name: 'A', notes: '旧 A' },
      { name: 'B', notes: '远端 B' },
      { name: '删除', notes: '远端仍存在' },
      { name: '远端新增', notes: '远端' },
    ]

    expect(mergeNamedRecordDraftWithRemote(base, draft, remote)).toEqual([
      { name: 'A', notes: '本地 A' },
      { name: 'B', notes: '远端 B' },
      { name: '远端新增', notes: '远端' },
      { name: '本地新增', notes: '本地' },
    ])
  })
})
