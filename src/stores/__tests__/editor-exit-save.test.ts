import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  registerEditorExitSaveHandler,
  saveDirtyEditorChangesForExit,
  useEditorStore,
} from '../editor-store'

const PROJECT_A = 'C:\\novels\\exit-a'
const PROJECT_B = 'C:\\novels\\exit-b'

beforeEach(() => {
  useEditorStore.getState().clearTabs()
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
})

describe('editor exit save settlement', () => {
  it('lets a clean workspace exit without a registered save handler', async () => {
    await expect(saveDirtyEditorChangesForExit(PROJECT_A)).resolves.toBeUndefined()
  })

  it('settles every dirty tab through its existing save handler', async () => {
    useEditorStore.setState({
      tabs: [
        { id: 'chapter-a', name: 'A', type: 'chapter', projectKey: PROJECT_A, content: 'A', contentRevision: 1, dirty: true },
        { id: 'arch-a', name: 'B', type: 'arch-file', projectKey: PROJECT_A, content: 'B', contentRevision: 2, dirty: true },
      ],
    })
    const saveChapter = vi.fn(async () => {
      useEditorStore.getState().settleTabSave('chapter-a', { content: 'A', contentRevision: 1 })
    })
    const saveArch = vi.fn(async () => {
      useEditorStore.getState().settleTabSave('arch-a', { content: 'B', contentRevision: 2 })
    })
    registerEditorExitSaveHandler({ tabId: 'chapter-a', type: 'chapter', projectKey: PROJECT_A, save: saveChapter })
    registerEditorExitSaveHandler({ tabId: 'arch-a', type: 'arch-file', projectKey: PROJECT_A, save: saveArch })

    await saveDirtyEditorChangesForExit(PROJECT_A)

    expect(saveChapter).toHaveBeenCalledOnce()
    expect(saveArch).toHaveBeenCalledOnce()
    expect(useEditorStore.getState().tabs.every(tab => !tab.dirty)).toBe(true)
  })

  it('keeps the exit blocked when saving fails', async () => {
    useEditorStore.setState({
      tabs: [{ id: 'chapter-a', name: 'A', type: 'chapter', projectKey: PROJECT_A, content: 'A', contentRevision: 1, dirty: true }],
    })
    registerEditorExitSaveHandler({
      tabId: 'chapter-a',
      type: 'chapter',
      projectKey: PROJECT_A,
      save: async () => { throw new Error('disk full') },
    })

    await expect(saveDirtyEditorChangesForExit(PROJECT_A)).rejects.toThrow('disk full')
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true)
  })

  it('keeps the exit blocked when the author types again while save is pending', async () => {
    useEditorStore.setState({
      tabs: [{ id: 'chapter-a', name: 'A', type: 'chapter', projectKey: PROJECT_A, content: 'A', contentRevision: 1, dirty: true }],
    })
    registerEditorExitSaveHandler({
      tabId: 'chapter-a',
      type: 'chapter',
      projectKey: PROJECT_A,
      save: async () => {
        useEditorStore.getState().updateTabContent('chapter-a', 'AB')
        useEditorStore.getState().settleTabSave('chapter-a', { content: 'A', contentRevision: 1 })
      },
    })

    await expect(saveDirtyEditorChangesForExit(PROJECT_A)).rejects.toThrow('仍有未保存')
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'AB', dirty: true })
  })

  it('never saves another project through the current project identity', async () => {
    useEditorStore.setState({
      tabs: [{ id: 'chapter-b', name: 'B', type: 'chapter', projectKey: PROJECT_B, content: 'B', dirty: true }],
    })
    const save = vi.fn(async () => undefined)
    registerEditorExitSaveHandler({ tabId: 'chapter-b', type: 'chapter', projectKey: PROJECT_B, save })

    await expect(saveDirtyEditorChangesForExit(PROJECT_A)).rejects.toThrow('另一个项目')
    expect(save).not.toHaveBeenCalled()
  })
})
