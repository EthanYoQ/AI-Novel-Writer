import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../styles/redesign/v2-index.css'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useCharacterStore, type CharacterCard } from '../../../stores/character-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useUiVersionStore } from '../../../stores/ui-version-store'
import RelationsEditor from '../RelationsEditor'

const PROJECT_PATH = 'C:\\novels\\relationship-editor'
const originalCharacterState = useCharacterStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalUiVersionState = useUiVersionStore.getState()
const originalEditorState = useEditorStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

function project(): ProjectData {
  return {
    id: 'relationship-editor',
    sessionLease: 'relationship-editor-lease',
    name: '关系网测试项目',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '玄幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 10,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function character(name: string, relationships = '', role: CharacterCard['role'] = 'supporting'): CharacterCard {
  return {
    name,
    role,
    gender: '',
    age: '',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    motivation: '',
    relationships,
    arc: '',
    notes: '',
  }
}

function zoomLabel(): string {
  return container?.querySelector('.relation-zoom button:nth-child(2)')?.textContent ?? ''
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  useCharacterStore.setState(originalCharacterState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useUiVersionStore.setState(originalUiVersionState)
  useEditorStore.setState({ ...originalEditorState, tabs: [], activeTabId: null })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useUiVersionStore.setState({ uiVersion: 'v2' })
  document.documentElement.setAttribute('data-ui', 'v2')
  useProjectStore.setState({ currentProject: project(), fileTree: [], loading: false })
  useCharacterStore.setState({
    characters: [
      character('沈砺', JSON.stringify([{ target: '陆云飞', relation: '宿敌' }]), 'protagonist'),
      character('陆云飞'),
    ],
    selectedName: '沈砺',
    dataProjectKey: PROJECT_PATH,
    loadingProjectKey: null,
    lastError: null,
    saving: false,
    identityBusy: false,
    rosterRevision: 1,
    dataProjectSession: {
      projectId: 'relationship-editor',
      leaseId: 'relationship-editor-lease',
      projectPath: PROJECT_PATH,
    },
  })
  ;(window as unknown as { velaAPI: unknown }).velaAPI = {
    invoke: vi.fn(async () => ({ success: true, avatar: null })),
    on: () => () => {},
    once: () => {},
    send: () => {},
    setZoomLevel: () => {},
    setZoomFactor: () => {},
    getZoomLevel: () => 0,
  }
  container = document.createElement('div')
  // 图谱是「画布 + 318px 右侧人物简介」的两栏版式，给一个真实窗口尺寸。
  container.style.width = '1400px'
  container.style.height = '700px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useCharacterStore.setState(originalCharacterState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useUiVersionStore.setState(originalUiVersionState)
  useEditorStore.setState({ ...originalEditorState, tabs: [], activeTabId: null })
  document.documentElement.removeAttribute('data-ui')
  delete (window as unknown as { velaAPI?: unknown }).velaAPI
  vi.restoreAllMocks()
})

describe('RelationsEditor（关系图谱标签页）', () => {
  it('v2 下渲染移植自 demo 的图谱：画布 + 右侧人物简介 + 同源页头', async () => {
    await act(async () => {
      root?.render(<RelationsEditor projectKey={PROJECT_PATH} />)
    })

    expect(container?.querySelector('.relation-canvas')).not.toBeNull()
    expect(container?.querySelector('.relation-side')?.textContent).toContain('沈砺')
    const strip = container?.querySelector('.pagehead-strip')
    expect(strip?.querySelector('.ph-k')?.textContent).toBe('CAST · 人物关系图谱')
    expect(strip?.querySelector('h1')?.textContent).toBe('人物关系图谱')
    // 当前视角人物就是 store 里选中的那位。
    expect(container?.querySelector('.relation-node.main')?.getAttribute('data-node')).toBe('沈砺')
  })

  it('用工具按钮与滚轮缩放，并能一键适应', async () => {
    await act(async () => {
      root?.render(<RelationsEditor projectKey={PROJECT_PATH} />)
    })

    expect(zoomLabel()).toBe('100%')

    const zoomIn = container?.querySelector<HTMLElement>('[aria-label="放大关系图谱"]')
    expect(zoomIn).toBeTruthy()
    await act(async () => {
      zoomIn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(zoomLabel()).toBe('110%')

    const graphCanvas = container?.querySelector<HTMLElement>('.relation-canvas')
    await act(async () => {
      graphCanvas?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    })
    expect(zoomLabel()).toBe('120%')

    const fit = Array.from(container?.querySelectorAll<HTMLElement>('.relation-tool') ?? [])
      .find(button => button.textContent?.includes('适应'))
    expect(fit).toBeTruthy()
    await act(async () => {
      fit?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(zoomLabel()).toBe('100%')
  })

  it('「查看详细档案」把视角人物交回人物档案标签（同一页面只留一个标签）', async () => {
    await act(async () => {
      root?.render(<RelationsEditor projectKey={PROJECT_PATH} />)
    })

    const detail = container?.querySelector<HTMLElement>('.relation-detail-btn')
    expect(detail).toBeTruthy()
    await act(async () => {
      detail?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const state = useEditorStore.getState()
    const profileTab = state.tabs.find(tab => tab.type === 'character')
    expect(profileTab).toBeTruthy()
    expect(state.activeTabId).toBe(profileTab?.id)
    expect(useCharacterStore.getState().selectedName).toBe('沈砺')
  })

  it('「删除全部角色与关系」照旧要先确认，取消则什么也不做', async () => {
    const clearAllCharacters = vi.fn().mockResolvedValue(true)
    useCharacterStore.setState({ clearAllCharacters })

    await act(async () => {
      root?.render(<RelationsEditor projectKey={PROJECT_PATH} />)
    })

    await act(async () => page.getByRole('button', { name: '删除全部角色与关系' }).click())
    await expect.element(page.getByRole('dialog')).toBeVisible()
    expect(clearAllCharacters).not.toHaveBeenCalled()

    await act(async () => {
      await page.getByRole('button', { name: '取消' }).click()
      await new Promise(resolve => setTimeout(resolve, 220))
    })
    expect(clearAllCharacters).not.toHaveBeenCalled()

    await act(async () => page.getByRole('button', { name: '删除全部角色与关系' }).click())
    await act(async () => {
      await page.getByRole('button', { name: '确认删除全部' }).click()
      await new Promise(resolve => setTimeout(resolve, 220))
    })
    expect(clearAllCharacters).toHaveBeenCalledWith(
      PROJECT_PATH,
      expect.objectContaining({
        projectId: 'relationship-editor',
        leaseId: 'relationship-editor-lease',
      }),
    )
  })

  it('v1 经典界面仍是原样的 Canvas 图谱与那条工具栏', async () => {
    useUiVersionStore.setState({ uiVersion: 'v1' })
    document.documentElement.removeAttribute('data-ui')

    await act(async () => {
      root?.render(<RelationsEditor projectKey={PROJECT_PATH} />)
    })

    // 先生：v1 经典界面保持原样 —— 换皮只换 v2。
    expect(container?.querySelector('canvas')).not.toBeNull()
    expect(container?.querySelector('.relation-canvas')).toBeNull()
    expect(container?.textContent).toContain('角色图谱')
    expect(container?.textContent).toContain('删除全部角色与关系')

    // 原来的「编辑模式」改成「人物档案」：档案现在是自己的标签，点一下就切回去。
    const backToProfile = Array.from(container?.querySelectorAll<HTMLElement>('button') ?? [])
      .find(button => button.textContent?.includes('人物档案'))
    expect(backToProfile).toBeTruthy()
    await act(async () => {
      backToProfile?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useEditorStore.getState().tabs.some(tab => tab.type === 'character')).toBe(true)
  })

  it('没有角色卡时给空态而不是空白画布', async () => {
    useCharacterStore.setState({ characters: [], selectedName: null })

    await act(async () => {
      root?.render(<RelationsEditor projectKey={PROJECT_PATH} />)
    })

    expect(container?.querySelector('.relation-canvas')).toBeNull()
    expect(container?.textContent).toContain('还没有角色卡')
  })
})
