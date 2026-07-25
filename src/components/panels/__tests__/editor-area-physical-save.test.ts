import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { savePhysicalChapterForSession } from '../editor-area-physical-save'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useEditorStore } from '../../../stores/editor-store'

const projectPath = 'C:\\novels\\same-project'
const filePath = `${projectPath}\\manuscript\\chapter_1.md`
const sessionA = {
  projectId: 'same-project-id',
  leaseId: 'lease-A',
  projectPath,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  useEditorStore.getState().clearTabs()
  useEditorStore.getState().openFile({
    id: 'chapter-1',
    name: '第1章',
    type: 'chapter',
    filePath,
    projectKey: projectPath,
    content: 'edited',
    savedContent: 'original',
    dirty: true,
  })
  setActiveProjectSessionContext(sessionA)
})

afterEach(() => {
  vi.unstubAllGlobals()
  useEditorStore.getState().clearTabs()
  setActiveProjectSessionContext(null)
})

describe('physical chapter save session settlement', () => {
  it('does not mark a chapter saved when a delayed write returns after a same-path reopen', async () => {
    const delayedWrite = deferred<{ success: boolean }>()
    const invoke = vi.fn(async () => delayedWrite.promise)
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const saving = savePhysicalChapterForSession({
      tabId: useEditorStore.getState().tabs[0].id,
      filePath,
      content: 'edited',
      projectSession: sessionA,
    })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())

    setActiveProjectSessionContext({ ...sessionA, leaseId: 'lease-B' })
    delayedWrite.resolve({ success: true })

    await expect(saving).resolves.toBe(false)
    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      dirty: true,
      savedContent: 'original',
    })
  })
})
