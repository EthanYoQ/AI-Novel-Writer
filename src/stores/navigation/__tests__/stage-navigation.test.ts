import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectData } from '../../../shared/ipc-channels'
import type { DraftMeta } from '../../../services/draft-index'
import { useDraftStore } from '../../draft-store'
import { useEditorStore } from '../../editor-store'
import { useLayoutStore } from '../../layout-store'
import { useProjectStore } from '../../project-store'
import { navigate, type NavigationIntent } from '../navigation-intents'
import { useStageStore } from '../stage-store'

const PROJECT_PATH = 'C:\\novels\\stage'
const SESSION = { projectId: 'stage', leaseId: 'lease-1', projectPath: PROJECT_PATH }
const WRITE = { title: '夜雨', role: '发展', purpose: '交代来信', keyEvents: '收到密信', characters: '林岚', userGuidance: '' }

const originalLayout = useLayoutStore.getState()
const originalDrafts = useDraftStore.getState()
const originalEditor = useEditorStore.getState()
const originalProject = useProjectStore.getState()
const originalStage = useStageStore.getState()

beforeEach(() => {
  useLayoutStore.setState({ sidebarView: 'home', settingsOpen: false })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useDraftStore.setState({ draftsByChapter: {}, loading: false, dataProjectSession: SESSION })
  useProjectStore.setState({ currentProject: { id: 'stage', sessionLease: 'lease-1', name: '灯塔', path: PROJECT_PATH } as ProjectData })
  useStageStore.setState({ sheet: { kind: 'run', tab: 'diagnostics' }, focus: true, palette: 'commands', work: null, closingTabId: null })
})

afterEach(() => {
  useLayoutStore.setState(originalLayout, true)
  useEditorStore.setState(originalEditor, true)
  useDraftStore.setState(originalDrafts, true)
  useProjectStore.setState(originalProject, true)
  useStageStore.setState(originalStage, true)
})

const tabTypes = () => useEditorStore.getState().tabs.map(tab => tab.type)
const activeTab = () => useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)

describe('新外壳下 navigate 的落点，调用方与旧外壳相同', () => {
  it('回到流程脊：离开书房、退出沉浸、收起侧页，不打开页面；作者开着的搜索不动', () => {
    navigate({ kind: 'stage' })
    expect(useStageStore.getState()).toMatchObject({ sheet: null, focus: false, palette: 'commands' })
    expect(useLayoutStore.getState().sidebarView).toBe('project')
    expect(tabTypes()).toEqual([])
  })

  it('阶段与资料页各开一个标签，再次打开时切回同一个标签', () => {
    navigate({ kind: 'stage', stage: 'setup' })
    navigate({ kind: 'stage', stage: 'architecture' })
    navigate({ kind: 'stage', stage: 'blueprint' })
    navigate({ kind: 'resource', page: 'plot' })
    navigate({ kind: 'resource', page: 'knowledge' })
    navigate({ kind: 'resource', page: 'history' })
    navigate({ kind: 'stage', stage: 'setup' })
    expect(tabTypes()).toEqual(['config', 'world-building', 'chapter-card', 'narrative-thread', 'knowledge', 'version-history'])
    expect(useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)?.type).toBe('config')
    expect(useStageStore.getState().focus).toBe(false)
  })

  it('运行意图打开运行侧页：输出与任务落到进行中并带上运行，日志与模型调用落到诊断', () => {
    navigate({ kind: 'run', facet: 'output', runId: 'run-7' })
    expect(useStageStore.getState().sheet).toEqual({ kind: 'run', tab: 'active', runId: 'run-7' })
    navigate({ kind: 'run', facet: 'tasks' })
    expect(useStageStore.getState().sheet).toEqual({ kind: 'run', tab: 'active', runId: undefined })
    navigate({ kind: 'run', facet: 'log' })
    expect(useStageStore.getState().sheet).toEqual({ kind: 'run', tab: 'diagnostics', runId: undefined })
    navigate({ kind: 'run', facet: 'models' })
    expect(useStageStore.getState().sheet).toEqual({ kind: 'run', tab: 'diagnostics', runId: undefined })
  })

  it('设置分组仍打开原来的对话框，不退出沉浸', () => {
    navigate({ kind: 'settings', section: 'backup' })
    expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'backup' })
    expect(useStageStore.getState().focus).toBe(true)
  })

  it('写作此章不再打开旧的创作对话框，也不落到蓝图：打开这一章的单章视图，写作请求留给那里的写作按钮', async () => {
    navigate({ kind: 'chapter', chapterNumber: 3, write: WRITE })
    await vi.waitFor(() => expect(activeTab()).toMatchObject({ type: 'chapter', chapterNumber: 3, filePath: undefined }))
    expect(tabTypes()).toEqual(['chapter'])
    expect(useStageStore.getState()).toMatchObject({ focus: false, writeRequest: { chapterNumber: 3 } })
  })

  it('写作此章落到已经有稿的章：切到这一稿的标签，写作请求清掉，不留到蓝图页再弹', async () => {
    const draft = { id: 31, chapterNumber: 3, version: 1, status: 'draft', createdAt: '2026-10-13T08:00:00.000Z',
      source: 'write', filePath: 'draft:31', fileName: '第3章.md' } satisfies DraftMeta
    useDraftStore.setState({ draftsByChapter: { 3: [draft] } })
    useEditorStore.setState({ tabs: [
      { id: 'draft-tab', name: '第 3 章', type: 'chapter', chapterNumber: 3, filePath: 'draft:31', projectKey: PROJECT_PATH },
      { id: 'plan-tab', name: '蓝图', type: 'chapter-card', projectKey: PROJECT_PATH },
    ], activeTabId: 'plan-tab' })
    navigate({ kind: 'chapter', chapterNumber: 3, write: WRITE })
    await vi.waitFor(() => expect(useEditorStore.getState().activeTabId).toBe('draft-tab'))
    expect(useStageStore.getState().writeRequest).toBeNull()
  })

  it('在书房里收到写作此章（定稿后打开下一章）：回到作品，请求带上这次打开的作品', () => {
    navigate({ kind: 'chapter', chapterNumber: 3, write: WRITE })
    expect(useLayoutStore.getState().sidebarView).toBe('project')
    expect(useStageStore.getState().writeRequest).toEqual({
      session: { projectId: 'stage', leaseId: 'lease-1', projectPath: PROJECT_PATH }, chapterNumber: 3,
    })
  })

  it('写作请求只属于发出时的那次打开：同一作品的其他改动不清，换作品或重新打开就清掉', () => {
    navigate({ kind: 'chapter', chapterNumber: 3, write: WRITE })
    useProjectStore.setState(state => ({ currentProject: { ...state.currentProject!, name: '灯塔（改名）' } }))
    expect(useStageStore.getState().writeRequest).toMatchObject({ chapterNumber: 3 })

    useProjectStore.setState({ currentProject: { id: 'other', sessionLease: 'lease-2', name: '雾岛', path: 'C:\\novels\\other' } as ProjectData })
    expect(useStageStore.getState().writeRequest).toBeNull()

    useProjectStore.setState({ currentProject: { id: 'stage', sessionLease: 'lease-1', name: '灯塔', path: PROJECT_PATH } as ProjectData })
    navigate({ kind: 'chapter', chapterNumber: 3, write: WRITE })
    useProjectStore.setState({ currentProject: { id: 'stage', sessionLease: 'lease-3', name: '灯塔', path: PROJECT_PATH } as ProjectData })
    expect(useStageStore.getState().writeRequest).toBeNull()
  })

  it('写作参数里不能再带一个章号：章号只由意图给出', () => {
    // @ts-expect-error 章号只由意图的 chapterNumber 给出
    const intent: NavigationIntent = { kind: 'chapter', chapterNumber: 3, write: { ...WRITE, chapterNumber: 4 } }
    navigate(intent)
    expect(useStageStore.getState().writeRequest).toMatchObject({ chapterNumber: 3 })
  })
})
