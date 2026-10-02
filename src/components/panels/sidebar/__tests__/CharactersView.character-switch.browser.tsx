import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ProjectData } from '../../../../shared/ipc-channels'
import { useCharacterStore, type CharacterCard } from '../../../../stores/character-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useUiVersionStore } from '../../../../stores/ui-version-store'
import CharactersView from '../CharactersView'

/**
 * 切换角色的落点规则：
 *   · 正文栏停在关系图谱 —— 只换选中角色，图谱自己换视角（center = selectedName）；
 *   · 正文栏停在人物档案 —— 只换选中角色，档案自己重绘；
 *   · 正文栏停在其它页面 —— 保持不动，不再被拽到人物档案；
 *   · 正文栏没有可停留的页面（书架这类栏目首页）—— 才落到人物档案。
 */
const PROJECT_PATH = 'C:\\novels\\character-switch'
const originalCharacterState = useCharacterStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalEditorState = useEditorStore.getState()
const originalUiVersionState = useUiVersionStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

function project(): ProjectData {
  return {
    id: 'character-switch',
    sessionLease: 'character-switch-lease',
    name: 'Character Switch',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '玄幻', subGenre: '', targetAudience: '全龄', totalChapters: 10,
      wordsPerChapter: 2500, plotStructure: 'three_act', narrativePOV: 'third_limited',
      coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    },
    characterStates: '', createdAt: '', updatedAt: '',
  }
}

function card(name: string): CharacterCard {
  return {
    name, role: 'supporting', gender: '', age: '', appearance: '', personality: '',
    background: '', abilities: '', motivation: '', relationships: '', arc: '', notes: '',
  }
}

beforeEach(async () => {
  useCharacterStore.setState(originalCharacterState)
  useLocaleStore.setState({ ...originalLocaleState, locale: 'zh-CN', initialized: true })
  useProjectStore.setState({ ...originalProjectState, currentProject: project() })
  useEditorStore.setState({ ...originalEditorState, tabs: [], activeTabId: null })
  useUiVersionStore.setState({ ...originalUiVersionState, uiVersion: 'v2' })
  useCharacterStore.setState({
    characters: [card('沈砺'), card('陆云飞')],
    selectedName: '沈砺',
    dataProjectKey: PROJECT_PATH,
    // setSelectedName 会校验当前项目会话，缺了它切换角色会被静默拒绝。
    dataProjectSession: {
      projectId: 'character-switch',
      leaseId: 'character-switch-lease',
      projectPath: PROJECT_PATH,
    },
    loadingProjectKey: null,
    loadingProjectSession: null,
    lastError: null,
    identityBusy: false,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<CharactersView />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useCharacterStore.setState(originalCharacterState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useEditorStore.setState(originalEditorState)
  useUiVersionStore.setState(originalUiVersionState)
})

/** 正文栏正停在关系图谱上。 */
function openRelationshipGraphTab(): void {
  useEditorStore.setState({
    tabs: [{
      id: 'relationship-graph',
      name: '人物关系图谱',
      type: 'relationship-graph',
      projectKey: PROJECT_PATH,
    }],
    activeTabId: 'relationship-graph',
  })
}

/** 正文栏正停在人物档案上。 */
function openCharacterProfileTab(): void {
  useEditorStore.setState({
    tabs: [{
      id: 'character-editor',
      name: '人物档案',
      type: 'character',
      projectKey: PROJECT_PATH,
    }],
    activeTabId: 'character-editor',
  })
}

describe('character switch keeps the page the author is already on', () => {
  it('switches the relationship-graph viewpoint instead of jumping to the profile', async () => {
    openRelationshipGraphTab()

    await act(async () => { await page.getByText('陆云飞').click() })

    expect(useCharacterStore.getState().selectedName).toBe('陆云飞')
    // 正文栏原地不动：没有多出人物档案标签，激活的仍是关系图谱。
    expect(useEditorStore.getState().activeTabId).toBe('relationship-graph')
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useEditorStore.getState().tabs.some(tab => tab.type === 'character')).toBe(false)
  })

  it('keeps the character profile tab active instead of reopening it', async () => {
    openCharacterProfileTab()

    await act(async () => { await page.getByText('陆云飞').click() })

    expect(useCharacterStore.getState().selectedName).toBe('陆云飞')
    expect(useEditorStore.getState().activeTabId).toBe('character-editor')
    expect(useEditorStore.getState().tabs).toHaveLength(1)
  })

  it('leaves an unrelated page (chapter, blueprint…) untouched', async () => {
    useEditorStore.setState({
      tabs: [{
        id: 'chapter-1',
        name: '第一章',
        type: 'chapter',
        projectKey: PROJECT_PATH,
        content: '正文',
      }],
      activeTabId: 'chapter-1',
    })

    await act(async () => { await page.getByText('陆云飞').click() })

    expect(useCharacterStore.getState().selectedName).toBe('陆云飞')
    expect(useEditorStore.getState().activeTabId).toBe('chapter-1')
    expect(useEditorStore.getState().tabs).toHaveLength(1)
  })

  it('still opens the profile as a landing page when the editor shows no page at all', async () => {
    // 书架这类「栏目首页」不占标签：此时若什么都不做，点了名字界面毫无反应。
    useEditorStore.setState({ tabs: [], activeTabId: null })

    await act(async () => { await page.getByText('陆云飞').click() })

    expect(useCharacterStore.getState().selectedName).toBe('陆云飞')
    const tabs = useEditorStore.getState().tabs
    expect(tabs.some(tab => tab.type === 'character')).toBe(true)
    expect(useEditorStore.getState().activeTabId).toBe(
      tabs.find(tab => tab.type === 'character')?.id,
    )
  })
})
