import { describe, expect, it } from 'vitest'

import type { EditorTab } from '../editor-store'
import { countUnsavedEditorItems, listUnsavedEditorItems } from '../editor-unsaved'

const PROJECT_A = 'C:\\novels\\A'
const PROJECT_B = 'C:\\novels\\B'

function ledger(projectKeys: string[]): string {
  return JSON.stringify({
    version: 1,
    projects: projectKeys.map(projectKey => ({
      projectKey,
      baseValue: {},
      draftValue: { genre: '未保存' },
    })),
  })
}

describe('listUnsavedEditorItems', () => {
  it('keeps the visible tab and its background ledger as one item', () => {
    const tabs: EditorTab[] = [
      { id: 'config', name: '小说配置', type: 'config', projectKey: PROJECT_A, dirty: true },
    ]

    const items = listUnsavedEditorItems(tabs, { config: ledger([PROJECT_A]) })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: `config:${PROJECT_A}`, type: 'config', tabId: 'config' })
    expect(countUnsavedEditorItems(tabs, { config: ledger([PROJECT_A]) })).toBe(1)
  })

  it('reports which work each cross-project draft belongs to', () => {
    const items = listUnsavedEditorItems([], {
      config: ledger([PROJECT_A]),
      'character-editor-drafts': ledger([PROJECT_B]),
    })

    expect(items.map(item => [item.type, item.projectKey])).toEqual([
      ['config', PROJECT_A],
      ['character', PROJECT_B],
    ])
  })

  it('keeps an unreadable ledger as a blocking item without a project', () => {
    const items = listUnsavedEditorItems([], { config: '{ not json' })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: 'ledger:config', unreadableLedgerKey: 'config' })
    expect(items[0]?.projectKey).toBeUndefined()
  })

  it('names a plain tab by its id so the dialog can activate it', () => {
    const tabs: EditorTab[] = [
      { id: 'chapter-7', name: '第七章', type: 'chapter', projectKey: PROJECT_A, dirty: true },
      { id: 'chapter-8', name: '第八章', type: 'chapter', projectKey: PROJECT_A, dirty: false },
    ]

    const items = listUnsavedEditorItems(tabs, {})

    expect(items).toEqual([expect.objectContaining({ key: 'tab:chapter-7', tabId: 'chapter-7', name: '第七章' })])
  })
})
