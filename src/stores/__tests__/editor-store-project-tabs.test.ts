import { beforeEach, describe, expect, it } from 'vitest'

import { createProjectArchTabId } from '../../components/editor/arch-file-refresh-policy'
import { createProjectScopedEditorTabId, useEditorStore } from '../editor-store'

const projectA = 'C:\\novels\\A'
const projectB = 'C:\\novels\\B'

describe('editor store project-scoped tabs', () => {
  it('activates project B default config without closing project A tabs', () => {
    const store = useEditorStore.getState()
    store.openFile({
      id: 'config',
      name: '小说配置 A',
      type: 'config',
      projectKey: projectA,
    })
    store.openFile({
      id: 'chapter-a',
      name: 'A 草稿',
      type: 'chapter',
      projectKey: projectA,
      content: 'A 未保存正文',
    })
    store.updateTabContent(
      createProjectScopedEditorTabId('chapter-a', 'chapter', projectA),
      'A 已修改但未保存正文',
    )

    store.openFile({
      id: 'config',
      name: '小说配置 B',
      type: 'config',
      projectKey: projectB,
    })

    expect(useEditorStore.getState().activeTabId)
      .toBe(createProjectScopedEditorTabId('config', 'config', projectB))
    expect(useEditorStore.getState().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectKey: projectA, type: 'config' }),
      expect.objectContaining({
        projectKey: projectA,
        type: 'chapter',
        content: 'A 已修改但未保存正文',
        dirty: true,
      }),
      expect.objectContaining({ projectKey: projectB, type: 'config' }),
    ]))
  })

  it.each(['config', 'character', 'chapter-card', 'world-building', 'chapter', 'review-report', 'version-history', 'diff'] as const)(
    'keeps project A and B %s built-in tabs as distinct identities',
    (type) => {
      useEditorStore.getState().openFile({
        id: `${type}-editor`,
        name: `${type} A`,
        type,
        projectKey: projectA,
      })
      useEditorStore.getState().updateTabContent(
        createProjectScopedEditorTabId(`${type}-editor`, type, projectA),
        'A dirty',
      )
      useEditorStore.getState().openFile({
        id: `${type}-editor`,
        name: `${type} B`,
        type,
        projectKey: projectB,
      })

      expect(useEditorStore.getState().tabs).toEqual([
        expect.objectContaining({
          id: createProjectScopedEditorTabId(`${type}-editor`, type, projectA),
          projectKey: projectA,
          dirty: true,
        }),
        expect.objectContaining({
          id: createProjectScopedEditorTabId(`${type}-editor`, type, projectB),
          projectKey: projectB,
        }),
      ])
      expect(useEditorStore.getState().tabs[1]?.dirty).not.toBe(true)
      expect(useEditorStore.getState().activeTabId)
        .toBe(createProjectScopedEditorTabId(`${type}-editor`, type, projectB))
    },
  )

  it('keeps the same numeric draft id in projects A and B as separate tabs', () => {
    const filePath = 'vela://draft/1'
    useEditorStore.getState().openFile({
      id: filePath,
      name: 'A draft',
      type: 'chapter',
      filePath,
      projectKey: projectA,
      content: 'A content',
    })
    useEditorStore.getState().updateTabContent(
      createProjectScopedEditorTabId(filePath, 'chapter', projectA),
      'A dirty content',
    )
    useEditorStore.getState().openFile({
      id: filePath,
      name: 'B draft',
      type: 'chapter',
      filePath,
      projectKey: projectB,
      content: 'B content',
    })

    expect(useEditorStore.getState().tabs).toEqual([
      expect.objectContaining({ projectKey: projectA, content: 'A dirty content', dirty: true }),
      expect.objectContaining({ projectKey: projectB, content: 'B content' }),
    ])
  })

  beforeEach(() => {
    useEditorStore.setState({ tabs: [], activeTabId: null })
  })

  it('keeps dirty architecture drafts isolated when two projects use the same Vela path', () => {
    const filePath = 'vela://core/premise'
    const projectATabId = createProjectArchTabId(projectA, filePath)
    const projectBTabId = createProjectArchTabId(projectB, filePath)
    const store = useEditorStore.getState()

    store.openFile({
      id: projectATabId,
      name: '故事前提',
      type: 'arch-file',
      filePath,
      projectKey: projectA,
      content: 'A 已保存内容',
      savedContent: 'A 已保存内容',
    })
    store.updateTabContent(projectATabId, 'A 未保存内容')
    store.openFile({
      id: projectBTabId,
      name: '故事前提',
      type: 'arch-file',
      filePath,
      projectKey: projectB,
      content: 'B 远端内容',
      savedContent: 'B 远端内容',
    })

    expect(useEditorStore.getState().tabs).toEqual([
      expect.objectContaining({
        id: projectATabId,
        projectKey: projectA,
        content: 'A 未保存内容',
        savedContent: 'A 已保存内容',
        dirty: true,
      }),
      expect.objectContaining({
        id: projectBTabId,
        projectKey: projectB,
        content: 'B 远端内容',
      }),
    ])

    useEditorStore.getState().setActiveTab(projectATabId)
    expect(useEditorStore.getState().activeTabId).toBe(projectATabId)
    expect(useEditorStore.getState().tabs[0]?.content).toBe('A 未保存内容')
    expect(useEditorStore.getState().tabs[0]?.savedContent).toBe('A 已保存内容')
  })
})
