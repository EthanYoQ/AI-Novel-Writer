import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 真实样式：行高与行距都来自 .tree-item，球与虚线的定位断言必须建立在它之上。
import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useUiVersionStore } from '../../../../stores/ui-version-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import ProjectTree from '../ProjectTree'

/**
 * 「小说之旅」三色小球：小说配置 → 故事架构 → 章节蓝图。
 *   绿 done     —— 这一阶段的内容已经齐了
 *   橙 active   —— 进行中（有进展，或对应工作流正在跑）
 *   红 pending  —— 还没开始
 */
const PROJECT_PATH = 'C:\\novels\\journey-dots'
const PROJECT_SESSION = {
  projectId: 'journey-dots',
  leaseId: 'journey-dots-lease',
  projectPath: PROJECT_PATH,
}

const novelConfig = {
  genre: '', subGenre: '', targetAudience: '', totalChapters: 4, wordsPerChapter: 2500,
  plotStructure: 'three_act' as const, narrativePOV: 'third_limited' as const,
  coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
}

const originalDraftState = useDraftStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalWorkflowState = useWorkflowStore.getState()
const originalUiVersionState = useUiVersionStore.getState()

let container: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>
let archTexts: { premise: string; charactersArch: string; worldbuilding: string; synopsis: string }
let blueprintCount = 0

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function project(): ProjectData {
  return {
    id: PROJECT_SESSION.projectId,
    sessionLease: PROJECT_SESSION.leaseId,
    name: 'Journey dots',
    path: PROJECT_PATH,
    novelConfig: { ...novelConfig },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

/** 按渲染顺序读出三个小球的状态。 */
function journeyStates(): string[] {
  return Array.from(container.querySelectorAll('[data-journey-state]'))
    .map(node => node.getAttribute('data-journey-state') ?? '')
}

/** 改小说配置并让 store 里的项目快照跟着换新（否则渲染读到的还是旧对象）。 */
function configureProject(patch: Partial<typeof novelConfig>): void {
  Object.assign(novelConfig, patch)
  useProjectStore.setState({ currentProject: project() })
}

beforeEach(() => {
  blueprintCount = 0
  archTexts = { premise: '', charactersArch: '', worldbuilding: '', synopsis: '' }
  Object.assign(novelConfig, {
    coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
  })
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
  useUiVersionStore.setState({ ...originalUiVersionState, uiVersion: 'v2' })
  useProjectStore.setState({
    currentProject: project(),
    projectSessionEpoch: 1,
    fileTree: [],
    loading: false,
  })
  useWorkflowStore.setState({ activeRuns: [], history: [] })
  useDraftStore.setState({
    draftsByChapter: {},
    loading: false,
    dataProjectKey: null,
    dataProjectSession: null,
    loadingProjectKey: null,
    loadingProjectSession: null,
  })
  setActiveProjectSessionContext(PROJECT_SESSION)

  invoke = vi.fn(async (channel: string) => {
    if (channel === 'fs:list-dir' || channel === 'db:draft-list-all') return []
    if (channel === 'db:blueprint-get-all') {
      return Array.from({ length: blueprintCount }, (_, index) => ({ chapterNumber: index + 1 }))
    }
    if (channel === 'db:project-core-get') return { ...archTexts }
    if (channel === 'db:character-roster-read') {
      return { status: 'ready', revision: 1, entries: [], renderedMarkdown: 'Character roster' }
    }
    if (channel === 'chapter:list-incomplete-deletions') return { success: true, operations: [] }
    throw new Error(`Unexpected IPC channel in ProjectTree journey test: ${channel}`)
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
    },
  })

  document.documentElement.setAttribute('data-ui', 'v2')

  container = document.createElement('div')
  container.style.width = '280px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.documentElement.removeAttribute('data-ui')
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useDraftStore.setState(originalDraftState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
  useUiVersionStore.setState(originalUiVersionState)
  vi.restoreAllMocks()
})

describe('novel journey dots', () => {
  it('shows three unfinished dots on a brand-new project', async () => {
    await act(async () => root.render(<ProjectTree />))

    await act(async () => {
      await vi.waitFor(() => expect(journeyStates()).toHaveLength(3))
    })
    expect(journeyStates()).toEqual(['pending', 'pending', 'pending'])
    // 三个小球由两条虚线连成一条自上而下的轨道；末球不再向下延伸。
    const links = Array.from(container.querySelectorAll<HTMLElement>('[data-journey-link]'))
    expect(links).toHaveLength(2)
    for (const link of links) {
      // 虚线必须真的画出一段可见长度（高度为 0 就等于没有连线）。
      expect(link.offsetHeight).toBeGreaterThan(10)
      expect(getComputedStyle(link).backgroundImage).toContain('repeating-linear-gradient')
    }
    const dots = Array.from(container.querySelectorAll<HTMLElement>('[data-journey-state]'))
    expect(dots.map(dot => dot.style.background)).toEqual([
      'var(--color-error)',
      'var(--color-error)',
      'var(--color-error)',
    ])
    // 小球紧贴标题行：落在行的 7px 外边距之内侧左内边距上，且整行布局不被推动。
    expect(dots.map(dot => dot.style.left)).toEqual(['9px', '9px', '9px'])
    expect(dots.map(dot => dot.style.top)).toEqual(['12px', '12px', '12px'])
    expect(dots.every(dot => getComputedStyle(dot).position === 'absolute')).toBe(true)
  })

  it('keeps the dots on the classic shell row metrics as well', async () => {
    useUiVersionStore.setState({ ...originalUiVersionState, uiVersion: 'v1' })

    await act(async () => root.render(<ProjectTree />))
    await act(async () => {
      await vi.waitFor(() => expect(journeyStates()).toHaveLength(3))
    })
    const dots = Array.from(container.querySelectorAll<HTMLElement>('[data-journey-state]'))
    // 经典界面行高 28px、左右外边距 8px：球随行高重新居中，仍然贴着标题行。
    expect(dots.map(dot => dot.style.left)).toEqual(['10px', '10px', '10px'])
    expect(dots.map(dot => dot.style.top)).toEqual(['11px', '11px', '11px'])
  })

  it('uses the green / orange / red tokens for done / active / pending', async () => {
    configureProject({ coreOutline: '已经写好的核心大纲' })
    archTexts = {
      premise: 'P'.repeat(60),
      charactersArch: 'C'.repeat(60),
      worldbuilding: 'W'.repeat(60),
      synopsis: '',
    }

    await act(async () => root.render(<ProjectTree />))
    await act(async () => {
      await vi.waitFor(() => expect(journeyStates()).toEqual(['done', 'active', 'pending']))
    })
    const dots = Array.from(container.querySelectorAll<HTMLElement>('[data-journey-state]'))
    expect(dots.map(dot => dot.style.background)).toEqual([
      'var(--color-success)',
      'var(--color-warning)',
      'var(--color-error)',
    ])
  })

  it('turns all three dots green once configuration, architecture and every blueprint are done', async () => {
    configureProject({ coreOutline: '已经写好的核心大纲' })
    blueprintCount = novelConfig.totalChapters
    archTexts = {
      premise: 'P'.repeat(60),
      charactersArch: 'C'.repeat(60),
      worldbuilding: 'W'.repeat(60),
      synopsis: 'S'.repeat(60),
    }

    await act(async () => root.render(<ProjectTree />))
    await act(async () => {
      await vi.waitFor(() => expect(journeyStates()).toEqual(['done', 'done', 'done']))
    })
  })

  it('marks a stage orange while its workflow is still running', async () => {
    // 配置还是一片空白，但智能配置生成正在跑 —— 这一格应该是「进行中」。
    useWorkflowStore.setState({
      activeRuns: [{ id: 'run-config', type: 'config_generation', status: 'running', steps: [] }] as never,
    })

    await act(async () => root.render(<ProjectTree />))
    await act(async () => {
      await vi.waitFor(() => expect(journeyStates()[0]).toBe('active'))
    })
    expect(journeyStates()).toEqual(['active', 'pending', 'pending'])
  })

  it('keeps a finished stage green even while the next one is being generated', async () => {
    configureProject({ coreOutline: '已经写好的核心大纲' })
    useWorkflowStore.setState({
      activeRuns: [{ id: 'run-arch', type: 'architecture_generation', status: 'running', steps: [] }] as never,
    })

    await act(async () => root.render(<ProjectTree />))
    await act(async () => {
      await vi.waitFor(() => expect(journeyStates()).toEqual(['done', 'active', 'pending']))
    })
  })
})
