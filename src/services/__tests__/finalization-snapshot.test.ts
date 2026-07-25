import { describe, expect, it } from 'vitest'

import type { EditorTab } from '../../stores/editor-store'
import {
  captureFinalizationSnapshot,
  reconcileFinalizationCompletion,
} from '../finalization-snapshot'

const PROJECT_PATH = 'C:\\novels\\A'
const SESSION = {
  projectId: 'project-a',
  leaseId: 'lease-a',
  projectPath: PROJECT_PATH,
}

function draftTab(overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    id: 'draft-1',
    name: '第一章 v1',
    type: 'chapter',
    filePath: 'vela://draft/17',
    projectKey: PROJECT_PATH,
    projectSessionLease: SESSION.leaseId,
    draftId: 17,
    chapterNumber: 1,
    content: '编辑器里尚未保存的正文',
    savedContent: '数据库中的旧正文',
    contentRevision: 8,
    dirty: true,
    draftStatus: 'draft',
    ...overrides,
  }
}

describe('finalization editor snapshot seam', () => {
  it('freezes the visible unsaved tab body instead of any persisted database body', () => {
    const snapshot = captureFinalizationSnapshot({
      tab: draftTab(),
      projectSession: SESSION,
      chapterTitle: 'CON<>: 夜航. ',
    })

    expect(snapshot).toMatchObject({
      tabId: 'draft-1',
      draftId: 17,
      chapterNumber: 1,
      content: '编辑器里尚未保存的正文',
      contentRevision: 8,
      projectSession: SESSION,
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.projectSession)).toBe(true)
  })

  it('does not let an old completion overwrite later editing or clear dirty', () => {
    const snapshot = captureFinalizationSnapshot({
      tab: draftTab(),
      projectSession: SESSION,
      chapterTitle: '第一章',
    })

    const reconciled = reconcileFinalizationCompletion(
      draftTab({
        content: '定稿期间继续编辑的新正文',
        contentRevision: 9,
        dirty: true,
      }),
      snapshot,
      {
        finalizationId: 'finalization-1',
        contentHash: 'hash-of-snapshot',
        contentRevision: 8,
        draftId: 17,
        projectPath: PROJECT_PATH,
        projectSession: SESSION,
        publicationStatus: 'published',
      },
    )

    expect(reconciled).toMatchObject({
      content: '定稿期间继续编辑的新正文',
      contentRevision: 9,
      dirty: true,
      draftStatus: 'draft',
      finalizationConflict: {
        finalizationId: 'finalization-1',
        publicationStatus: 'published',
      },
    })
  })
})
