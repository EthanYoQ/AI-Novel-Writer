import { beforeEach, describe, expect, it } from 'vitest'

import { useEditorStore } from '../editor-store'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

beforeEach(() => {
  useEditorStore.setState({
    tabs: [{
      id: 'draft-a',
      name: '第一章 v1',
      type: 'chapter',
      filePath: 'vela://draft/1',
      projectKey: 'C:\\novels\\A',
      content: '保存开始时的正文',
      savedContent: '更早的正文',
      contentRevision: 3,
      dirty: true,
    }],
    activeTabId: 'draft-a',
    draftLedgers: {},
  })
})

describe('editor tab save settlement', () => {
  it('preserves new input and dirty state when an older save response arrives', async () => {
    const saveResponse = deferred<void>()
    const tabAtSaveStart = useEditorStore.getState().tabs[0]
    const snapshot = {
      content: tabAtSaveStart.content ?? '',
      contentRevision: tabAtSaveStart.contentRevision ?? 0,
    }
    const save = (async () => {
      await saveResponse.promise
      useEditorStore.getState().settleTabSave('draft-a', snapshot)
    })()

    useEditorStore.getState().updateTabContent('draft-a', '保存期间继续输入')
    saveResponse.resolve()
    await save

    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      content: '保存期间继续输入',
      savedContent: '保存开始时的正文',
      contentRevision: 4,
      dirty: true,
    })
  })

  it('marks the tab saved only when content and revision still match the snapshot', () => {
    const tabAtSaveStart = useEditorStore.getState().tabs[0]
    useEditorStore.getState().settleTabSave('draft-a', {
      content: tabAtSaveStart.content ?? '',
      contentRevision: tabAtSaveStart.contentRevision ?? 0,
    })

    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      content: '保存开始时的正文',
      savedContent: '保存开始时的正文',
      contentRevision: 3,
      dirty: false,
    })
  })

  it('refreshes database draft identity metadata when an existing tab is reopened', () => {
    useEditorStore.getState().openFile({
      id: 'draft-a',
      name: '第一章 v1',
      type: 'chapter',
      filePath: 'vela://draft/1',
      projectKey: 'C:\\novels\\A',
      draftId: 1,
      chapterNumber: 1,
      draftStatus: 'finalized',
    })

    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      content: '保存开始时的正文',
      dirty: true,
      draftId: 1,
      chapterNumber: 1,
      draftStatus: 'finalized',
    })
  })
})
