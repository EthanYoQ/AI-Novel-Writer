import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../../shared/ipc-channels'
import type { ProjectOverview } from '../../../../shared/project-overview'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import NewWorkDialog from '../NewWorkDialog'
import StageLibrary from '../StageLibrary'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Api = { invoke: (channel: string, ...args: unknown[]) => Promise<unknown>; on: () => () => void }
const win = window as unknown as { aiNovelAPI?: Api }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [snapshot(useLayoutStore), snapshot(useProjectStore), snapshot(useLLMStore), snapshot(useStageStore), snapshot(useDraftStore), snapshot(useEditorStore)]

const LIGHTHOUSE = { name: '灯塔', path: 'C:\\novels\\lighthouse', updatedAt: '2026-10-11T21:14:00.000Z', previewCapabilityId: 'cap-lighthouse' }
const ISLAND = { name: '雾岛', path: 'C:\\novels\\island', updatedAt: '2026-10-02T09:00:00.000Z', previewCapabilityId: 'cap-island' }
const READY: ProjectOverview = {
  state: 'ready', projectId: 'island', revision: 'r1', name: '雾岛', totalWords: 6214, characters: 3, finalizedChapters: 2,
  setupReady: false, plannedChapters: 24,
  stages: [
    { id: 'configuration', status: 'in-progress', count: 5 }, { id: 'architecture', status: 'completed', count: 4 },
    { id: 'blueprint', status: 'in-progress', count: 12 }, { id: 'drafting', status: 'in-progress', count: 3 },
    { id: 'review', status: 'not-started', count: 0 }, { id: 'finalization', status: 'in-progress', count: 2 },
  ],
}

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

async function mount(width = 1440, height = 900) {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = `width: ${width}px; height: ${height}px;`
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<div className="stage-library"><StageLibrary /></div>))
}

function openCurrent() {
  const project = { id: 'lighthouse', sessionLease: 'lease-1', name: '灯塔', path: LIGHTHOUSE.path,
    novelConfig: { genre: '悬疑', totalChapters: 12, wordsPerChapter: 3000, coreOutline: '雾钟提前一刻响起。', targetAudience: '成年读者' } } as unknown as ProjectData
  setActiveProjectSessionContext({ projectId: 'lighthouse', leaseId: 'lease-1', projectPath: LIGHTHOUSE.path })
  useProjectStore.setState({ currentProject: project })
}

const button = (name: string) => [...host!.ownerDocument.querySelectorAll<HTMLButtonElement>('button')]
  .find(candidate => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === name)
const dialog = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
  .find(candidate => candidate.querySelector('h2')?.textContent === name)

async function click(element: HTMLElement | undefined) {
  expect(element, '要点击的元素存在').toBeTruthy()
  await act(async () => element!.click())
}

async function chooseFromBookMenu(book: string, item: string) {
  await click(button(`《${book}》更多操作`))
  const menuItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(candidate => candidate.textContent === item)
  return menuItem
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  // 书房按桌面宽度排版。默认 414 宽的视口放不下，对话框关闭后焦点回到菜单按钮会横向滚动页面，晚到的滚动把刚打开的菜单关掉。
  await page.viewport(1440, 900)
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'project:peek-overview') return READY
    if (channel === 'project:overview-current') return { ...READY, projectId: 'lighthouse', name: '灯塔', excerpt: '守塔人把灯又擦了一遍。' }
    if (channel === 'update:get-state') return { status: 'disabled', currentVersion: '1.2.2', isReminderDeferred: false }
    return undefined
  })
  win.aiNovelAPI = { invoke, on: () => () => undefined }
  useLayoutStore.setState({ sidebarView: 'home' })
  useStageStore.setState({ work: null, spineFacts: null })
  useLLMStore.setState({ loaded: true, defaultModelId: 'model' })
  useProjectStore.setState({
    currentProject: null,
    recentProjects: [],
    recentProjectsLoaded: true,
    legacyImportBusy: false,
    legacyImportNotice: '',
    openProject: vi.fn(async () => true),
    removeRecentProject: vi.fn(async () => true),
    deleteProject: vi.fn(async () => true),
  } as never)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  delete win.aiNovelAPI
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
})

describe('书房', () => {
  it('书架空着时唯一的主按钮是新建作品，没有模型时给出添加模型的入口', async () => {
    useLLMStore.setState({ loaded: true, defaultModelId: null })
    await mount()
    expect(host!.querySelector('h1')?.textContent).toBe('书架还是空的')
    expect([...host!.querySelectorAll('.pi-btn--primary')].map(element => element.textContent)).toEqual(['新建作品'])
    expect(host!.textContent).toContain('还没有连接 AI 模型')

    await click(button('新建作品'))
    expect(useLayoutStore.getState().newProjectOpen).toBe(true)
    await click(button('添加模型'))
    expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'llm' })
  })

  it('最近项目还没读到时不显示空书房，只显示开始；读到空列表才是空书房', async () => {
    useProjectStore.setState({ recentProjectsLoaded: false })
    await mount()
    expect(host!.textContent).not.toContain('书架还是空的')
    expect(button('新建作品')?.classList.contains('stage-start')).toBe(true)
    expect(host!.querySelector('[aria-label="最近的作品"]')).toBeNull()

    await act(async () => useProjectStore.setState({ recentProjectsLoaded: true }))
    expect(host!.querySelector('h1')?.textContent).toBe('书架还是空的')
  })

  it('点封面只预览不打开，概览里的主按钮才打开这部作品', async () => {
    useProjectStore.setState({ recentProjects: [LIGHTHOUSE, ISLAND] })
    await mount()
    await click(button('预览《雾岛》'))
    expect(invoke).toHaveBeenCalledWith('project:peek-overview', 'cap-island')
    expect(useProjectStore.getState().openProject).not.toHaveBeenCalled()
    expect(button('预览《雾岛》')?.getAttribute('aria-pressed')).toBe('true')

    const bars = [...host!.querySelectorAll<HTMLElement>('[data-stage]')].map(row => [row.dataset.stage, row.dataset.state, row.textContent])
    expect(bars).toEqual([
      ['setup', 'active', '设定 未齐'], ['architecture', 'done', '架构'], ['blueprint', 'done', '蓝图 12 章'], ['manuscript', 'active', '正文 2 / 24'],
    ])
    const cover = (name: string) => button(`预览《${name}》`)!
    expect([...cover('雾岛').children].map(part => part.className)).toEqual(['stage-book-title'])
    expect([...host!.querySelectorAll('.pi-btn--primary')].map(element => element.textContent)).toEqual(['打开《雾岛》'])

    await click(button('预览《雾岛》'))
    expect(useProjectStore.getState().openProject).not.toHaveBeenCalled()
    await click(button('打开《雾岛》'))
    expect(useProjectStore.getState().openProject).toHaveBeenCalledWith(ISLAND.path)
  })

  const overviewOf = (name: string) => host!.querySelector<HTMLElement>(`[aria-label="《${name}》概览"]`)

  it('预览别的书后回到当前作品，概览重新显示当前作品，不停在正在读取', async () => {
    openCurrent()
    useProjectStore.setState({ recentProjects: [LIGHTHOUSE, ISLAND] })
    await mount()
    await vi.waitFor(() => expect(overviewOf('灯塔')?.textContent).toContain('守塔人把灯又擦了一遍。'))
    await click(button('预览《雾岛》'))
    await vi.waitFor(() => expect(overviewOf('雾岛')?.getAttribute('aria-busy')).toBe('false'))
    await click(button('回到《灯塔》'))
    await vi.waitFor(() => expect(overviewOf('灯塔')?.textContent).toContain('守塔人把灯又擦了一遍。'))
    expect(overviewOf('灯塔')?.getAttribute('aria-busy')).toBe('false')
  })

  it('正在预览的书被移出最近项目：概览回到当前作品，不把那本书的统计写在当前作品名下', async () => {
    openCurrent()
    useProjectStore.setState({ recentProjects: [LIGHTHOUSE, ISLAND] })
    await mount()
    await click(button('预览《雾岛》'))
    await vi.waitFor(() => expect(overviewOf('雾岛')?.getAttribute('aria-busy')).toBe('false'))
    await act(async () => useProjectStore.setState({ recentProjects: [LIGHTHOUSE] }))
    await vi.waitFor(() => expect(overviewOf('灯塔')?.textContent).toContain('守塔人把灯又擦了一遍。'))
    expect(overviewOf('雾岛')).toBeNull()
  })

  it('设定必填齐了的书，预览里设定是完成，与打开后一致', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'project:peek-overview' ? { ...READY, setupReady: true } : base(channel, ...args))
    useProjectStore.setState({ recentProjects: [ISLAND] })
    await mount()
    await click(button('预览《雾岛》'))
    expect(host!.querySelector<HTMLElement>('[data-stage="setup"]')?.dataset.state).toBe('done')
    expect(host!.querySelector('[data-stage="setup"]')?.textContent).toBe('设定')
  })

  it('定稿章数达到或超过规划章数时，预览里正文是完成，进度条不超出', async () => {
    const base = invoke.getMockImplementation()!
    const finalized = (count: number) => ({ ...READY, stages: READY.stages.map(stage => stage.id === 'finalization' ? { ...stage, count } : stage) })
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'project:peek-overview' ? finalized(30) : base(channel, ...args))
    useProjectStore.setState({ recentProjects: [ISLAND] })
    await mount()
    await click(button('预览《雾岛》'))
    const manuscript = host!.querySelector<HTMLElement>('[data-stage="manuscript"]')!
    expect([manuscript.dataset.state, manuscript.textContent]).toEqual(['done', '正文 30 / 24'])
    expect(manuscript.querySelector<HTMLElement>('[style]')!.style.getPropertyValue('--ratio')).toBe('1')
  })

  it('新建作品没选保存位置时「创建作品」不可用，并写明原因', async () => {
    useLayoutStore.setState({ newProjectOpen: true })
    host = document.createElement('div')
    host.className = 'paper-ink stage-shell'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<NewWorkDialog />))
    await type(document.querySelector<HTMLInputElement>('[role="dialog"] input')!, '雨夜列车')
    const create = button('创建作品')!
    expect(create.disabled).toBe(true)
    const reason = document.getElementById(create.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toBe('先选保存位置，作品会建在那个文件夹里。')
  })

  it('从最近项目移除先确认，取消时不移除，确认后只移除书架记录', async () => {
    useProjectStore.setState({ recentProjects: [LIGHTHOUSE, ISLAND] })
    await mount()
    await click(await chooseFromBookMenu('雾岛', '从最近项目移除…'))
    expect(dialog('从书架移除《雾岛》？')?.textContent).toContain('作品文件夹留在原处')
    await click(button('取消'))
    expect(useProjectStore.getState().removeRecentProject).not.toHaveBeenCalled()

    await click(await chooseFromBookMenu('雾岛', '从最近项目移除…'))
    await click(button('移除记录'))
    expect(useProjectStore.getState().removeRecentProject).toHaveBeenCalledWith(ISLAND.path)
    expect(useProjectStore.getState().deleteProject).not.toHaveBeenCalled()
  })

  it('窗口最窄 1024×640 时书房不横向溢出，书架菜单与确认框照常可用', async () => {
    // 真实应用的最小窗口（electron/main.ts 的 minWidth、minHeight）。
    await page.viewport(1024, 640)
    openCurrent()
    useProjectStore.setState({ recentProjects: [LIGHTHOUSE, ISLAND] })
    await mount(1024, 640)
    await vi.waitFor(() => expect(overviewOf('灯塔')?.textContent).toContain('守塔人把灯又擦了一遍。'))

    expect(host!.scrollWidth, '书房内容不超出窗口宽度').toBeLessThanOrEqual(host!.clientWidth)
    const overflowing = [...host!.querySelectorAll<HTMLElement>('button, h1, h2, [data-stage]')]
      .filter(element => element.getClientRects().length > 0 && element.getBoundingClientRect().right > host!.getBoundingClientRect().right + 0.5)
      .map(element => element.getAttribute('aria-label') ?? element.textContent)
    expect(overflowing).toEqual([])

    await click(await chooseFromBookMenu('雾岛', '从最近项目移除…'))
    await click(button('取消'))
    await click(await chooseFromBookMenu('雾岛', '从最近项目移除…'))
    await click(button('移除记录'))
    expect(useProjectStore.getState().removeRecentProject).toHaveBeenCalledWith(ISLAND.path)
    expect(document.scrollingElement!.scrollLeft, '对话框关闭后焦点回到菜单按钮，不横向滚动页面').toBe(0)
  })

  it('删除作品只对打开的作品可用，要输入完整作品名才能确认', async () => {
    openCurrent()
    useProjectStore.setState({ recentProjects: [LIGHTHOUSE, ISLAND] })
    await mount()

    const otherDelete = await chooseFromBookMenu('雾岛', '删除作品（先打开这部作品）')
    expect(otherDelete?.disabled).toBe(true)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

    await click(await chooseFromBookMenu('灯塔', '删除作品…'))
    const confirm = dialog('删除《灯塔》？')!
    const input = confirm.querySelector('input')!
    const remove = [...confirm.querySelectorAll('button')].find(candidate => candidate.textContent === '删除作品')!
    expect(remove.disabled).toBe(true)
    await type(input, '灯')
    expect(remove.disabled).toBe(true)
    await type(input, '灯塔')
    expect(remove.disabled).toBe(false)
    await click(remove)
    expect(useProjectStore.getState().deleteProject).toHaveBeenCalledWith(LIGHTHOUSE.path)
  })

  it('当前作品的概览与流程脊同源，主按钮写明继续写哪一步；数据没载入完时只写继续写作', async () => {
    openCurrent()
    useProjectStore.setState({ recentProjects: [LIGHTHOUSE] })
    await mount()
    const primary = () => [...host!.querySelectorAll('.pi-btn--primary')].map(element => element.textContent)
    expect(primary()).toEqual(['继续写作'])
    expect(host!.querySelector('[data-stage]')).toBeNull()

    const session = { projectId: 'lighthouse', leaseId: 'lease-1', projectPath: LIGHTHOUSE.path }
    await act(async () => {
      useStageStore.setState({ work: { session, architecture: { premise: true, characters: true }, blueprints: [] }, spineFacts: session })
      useDraftStore.setState({ draftsByChapter: {}, dataProjectSession: session, loading: false })
    })
    expect(primary()).toEqual(['继续写作 · 架构'])
    expect([...host!.querySelectorAll<HTMLElement>('[data-stage]')].map(row => row.textContent)).toEqual(['设定', '架构 2 / 4', '蓝图', '正文 0 / 12'])
    expect(host!.textContent).toContain('悬疑 · 12 章 · 每章约 3,000 字')
    expect(host!.textContent).toContain('守塔人把灯又擦了一遍。')

    await click(button('继续写作 · 架构'))
    expect(useLayoutStore.getState().sidebarView).not.toBe('home')
  })

  it('几章都在写时「继续写作」指向最后一章在写的；只有空稿的章不算开始', async () => {
    openCurrent()
    useProjectStore.setState({ recentProjects: [LIGHTHOUSE] })
    await mount()
    const session = { projectId: 'lighthouse', leaseId: 'lease-1', projectPath: LIGHTHOUSE.path }
    const draft = (chapterNumber: number, wordCount: number) => [{ id: chapterNumber * 10, chapterNumber, version: 1, status: 'draft', wordCount,
      createdAt: '2026-10-13 20:00:00', updatedAt: '2026-10-13 20:00:00', source: 'write', filePath: `ai-novel://draft/${chapterNumber * 10}`, fileName: 'draft_v1.md' }]
    const architecture = { premise: true, characters: true, worldbuilding: true, synopsis: false }
    const primary = () => [...host!.querySelectorAll('.pi-btn--primary')].map(element => element.textContent)

    await act(async () => {
      useStageStore.setState({ work: { session, architecture, blueprints: [1, 2, 3].map(chapterNumber => ({ chapterNumber, title: `第${chapterNumber}章` })) }, spineFacts: session })
      useDraftStore.setState({ draftsByChapter: { 1: draft(1, 1800), 2: draft(2, 2400), 3: draft(3, 0) } as never, dataProjectSession: session, loading: false })
    })
    expect(primary()).toEqual(['继续写作 · 第 2 章 · 待审稿'])

    await act(async () => {
      useStageStore.setState({ work: { session, architecture, blueprints: [] } })
      useDraftStore.setState({ draftsByChapter: { 1: draft(1, 0) } as never })
    })
    expect(primary()).toEqual(['继续写作 · 架构'])
  })
})
