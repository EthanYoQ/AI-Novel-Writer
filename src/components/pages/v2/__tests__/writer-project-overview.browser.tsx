import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useAppearanceStore } from '../../../../stores/appearance-bootstrap'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useProjectStore } from '../../../../stores/project-store'
import EditorArea from '../../../panels/EditorArea'
import { WriterWelcomePage } from '../use-project-overview'

const originalAppearance = useAppearanceStore.getState()
const originalEditor = useEditorStore.getState()
const originalLayout = useLayoutStore.getState()
const originalProject = useProjectStore.getState()
const originalBridge = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')

let container: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ready = (name: string, excerpt?: string) => ({
  state: 'ready' as const,
  projectId: name,
  revision: `${name}-revision`,
  name,
  totalWords: 1200,
  characters: 3,
  finalizedChapters: 1,
  excerpt,
  stages: [
    { id: 'configuration' as const, status: 'completed' as const, count: 1 },
    { id: 'architecture' as const, status: 'completed' as const, count: 4 },
    { id: 'blueprint' as const, status: 'in-progress' as const, count: 2 },
    { id: 'drafting' as const, status: 'in-progress' as const, count: 1 },
    { id: 'review' as const, status: 'unknown' as const, count: 0 },
    { id: 'finalization' as const, status: 'not-started' as const, count: 0 },
  ],
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  localStorage.clear()
  invoke = vi.fn(async (channel: string) => channel === 'update:get-state'
    ? { status: 'disabled', currentVersion: '', isReminderDeferred: false }
    : { success: true })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}) },
  })
  useAppearanceStore.setState({ resolvedShell: 'writer' })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useLayoutStore.setState({ sidebarView: 'project', activeRailItem: 'project' })
  useProjectStore.setState({ currentProject: null, recentProjects: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  localStorage.clear()
  useAppearanceStore.setState(originalAppearance, true)
  useEditorStore.setState(originalEditor, true)
  useLayoutStore.setState(originalLayout, true)
  useProjectStore.setState(originalProject, true)
  if (originalBridge) Object.defineProperty(window, 'aiNovelAPI', originalBridge)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
})

it('production routes Writer to V2 while Classic keeps the existing welcome', async () => {
  await render(<EditorArea onNewProject={vi.fn()} />)
  expect(container.textContent).toContain('写作书房')

  await act(async () => useAppearanceStore.setState({ resolvedShell: 'classic' }))
  expect(container.textContent).toContain('欢迎使用')
  expect(container.textContent).not.toContain('写作书房')
})

it('exposes deletion of only the verified current project on the V3 home shelf', async () => {
  const deleteProject = vi.fn(async () => true)
  useProjectStore.setState({
    currentProject: { id: 'current', name: '当前作品', path: 'C:\\novels\\current', sessionLease: 'lease-current', novelConfig: {} } as never,
    recentProjects: [{ name: '另一本书', path: 'C:\\novels\\other', updatedAt: '' }],
    deleteProject,
  })
  await render(<WriterWelcomePage onNewProject={vi.fn()} />)

  const deleteButton = container.querySelector<HTMLButtonElement>('.writer-overview [title="删除项目"]')
  expect(deleteButton).not.toBeNull()
  expect(container.querySelector('.writer-shelf [title="删除项目"]')).toBeNull()
  await act(async () => deleteButton!.click())
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('当前作品'))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('所有项目数据')
  expect(deleteProject).not.toHaveBeenCalled()

  await act(async () => {
    (document.querySelector('[role="dialog"] button') as HTMLButtonElement).click()
    await new Promise(resolve => setTimeout(resolve, 250))
  })
  expect(deleteProject).not.toHaveBeenCalled()
  await act(async () => deleteButton!.click())
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  await act(async () => {
    (document.querySelector('[role="dialog"] button:last-child') as HTMLButtonElement).click()
    await new Promise(resolve => setTimeout(resolve, 250))
  })
  expect(deleteProject).toHaveBeenCalledExactlyOnceWith('C:\\novels\\current')

  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="预览《另一本书》"]')!.click())
  expect(container.querySelector('.writer-overview [title="删除项目"]')).toBeNull()
})

it('previews by capability only, opens on the second cover click, and direct entry uses the store gate', async () => {
  const openProject = vi.fn(async () => true)
  useProjectStore.setState({
    openProject,
    recentProjects: [{ name: '雨夜来信', path: 'C:\\novels\\rain', updatedAt: '', projectId: 'rain', previewCapabilityId: 'cap-rain' }],
  })
  invoke.mockImplementation(async (channel: string) => channel === 'project:peek-overview'
    ? ready('雨夜来信')
    : channel === 'update:get-state'
      ? { status: 'disabled', currentVersion: '', isReminderDeferred: false }
      : { success: true })
  await render(<WriterWelcomePage onNewProject={vi.fn()} />)

  const cover = container.querySelector<HTMLButtonElement>('[aria-label="预览《雨夜来信》"]')!
  await act(async () => cover.click())
  expect(invoke).toHaveBeenCalledWith('project:peek-overview', 'cap-rain')
  expect(invoke.mock.calls.find(call => call[0] === 'project:peek-overview')).not.toContain('C:\\novels\\rain')
  expect(openProject).not.toHaveBeenCalled()

  await act(async () => cover.click())
  expect(openProject).toHaveBeenCalledExactlyOnceWith('C:\\novels\\rain')

  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开《雨夜来信》"]')!.click())
  expect(openProject).toHaveBeenCalledTimes(2)
})

it('treats copied project roots with the same projectId as distinct shelf items', async () => {
  const openProject = vi.fn(async () => true)
  useProjectStore.setState({
    openProject,
    recentProjects: [
      { name: '副本甲', path: 'C:\\novels\\copy-a', updatedAt: '', projectId: 'shared', previewCapabilityId: 'cap-a' },
      { name: '副本乙', path: 'C:\\novels\\copy-b', updatedAt: '', projectId: 'shared', previewCapabilityId: 'cap-b' },
    ],
  })
  invoke.mockImplementation(async (channel: string, capability?: string) => channel === 'project:peek-overview'
    ? ready(capability === 'cap-a' ? '副本甲' : '副本乙')
    : channel === 'update:get-state'
      ? { status: 'disabled', currentVersion: '', isReminderDeferred: false }
      : { success: true })
  await render(<WriterWelcomePage onNewProject={vi.fn()} />)

  const first = container.querySelector<HTMLButtonElement>('[aria-label="预览《副本甲》"]')!
  const second = container.querySelector<HTMLButtonElement>('[aria-label="预览《副本乙》"]')!
  await act(async () => first.click())
  await act(async () => second.click())
  expect(invoke.mock.calls.filter(call => call[0] === 'project:peek-overview')).toEqual([
    ['project:peek-overview', 'cap-a'],
    ['project:peek-overview', 'cap-b'],
  ])
  expect(openProject).not.toHaveBeenCalled()

  await act(async () => second.click())
  expect(openProject).toHaveBeenCalledExactlyOnceWith('C:\\novels\\copy-b')
})

it('loads the frozen current session, drops a stale session response, and marks missing capabilities unavailable', async () => {
  const currentA = deferred<ReturnType<typeof ready>>()
  const currentB = deferred<ReturnType<typeof ready>>()
  useProjectStore.setState({ currentProject: {
    id: 'current', name: '当前作品', path: 'C:\\novels\\current', sessionLease: 'lease-current', novelConfig: {},
  } as never })
  invoke.mockImplementation(async (channel: string, context?: { projectId?: string }) => channel === 'project:overview-current'
    ? context?.projectId === 'current' ? currentA.promise : currentB.promise
    : channel === 'update:get-state'
      ? { status: 'disabled', currentVersion: '', isReminderDeferred: false }
      : { success: true })
  await render(<WriterWelcomePage onNewProject={vi.fn()} />)
  expect(invoke).toHaveBeenCalledWith('project:overview-current', {
    projectId: 'current', leaseId: 'lease-current', projectPath: 'C:\\novels\\current',
  })
  await act(async () => useProjectStore.setState({ currentProject: {
    id: 'next', name: '新会话', path: 'C:\\novels\\next', sessionLease: 'lease-next', novelConfig: {},
  } as never }))
  await act(async () => currentB.resolve(ready('新会话', '新会话正文片段')))
  expect(container.textContent).toContain('新会话正文片段')
  await act(async () => currentA.resolve(ready('当前作品', '过期会话正文片段')))
  expect(container.textContent).toContain('新会话正文片段')
  expect(container.textContent).not.toContain('过期会话正文片段')

  await act(async () => useProjectStore.setState({ currentProject: null, recentProjects: [
    { name: '旧作品', path: 'C:\\novels\\old', updatedAt: '', projectId: 'old' },
  ] }))
  await vi.waitFor(() => expect(container.textContent).toContain('旧作品'))
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="预览《旧作品》"]')!.click())
  expect(container.textContent).toContain('暂时无法读取这部作品')
  expect(invoke.mock.calls.filter(call => call[0] === 'project:peek-overview')).toHaveLength(0)
})

it('drops stale previews and removes only legacy overview keys without writing a replacement cache', async () => {
  const a = deferred<ReturnType<typeof ready>>()
  const b = deferred<ReturnType<typeof ready>>()
  localStorage.setItem('vela:overview:one', 'stale')
  localStorage.setItem('vela:overview-extra', 'keep')
  localStorage.setItem('vela:preferences', 'keep')
  useProjectStore.setState({ recentProjects: [
    { name: '甲书', path: 'C:\\novels\\a', updatedAt: '', previewCapabilityId: 'cap-a' },
    { name: '乙书', path: 'C:\\novels\\b', updatedAt: '', previewCapabilityId: 'cap-b' },
  ] })
  invoke.mockImplementation(async (channel: string, capability?: string) => {
    if (channel === 'project:peek-overview') return capability === 'cap-a' ? a.promise : b.promise
    if (channel === 'update:get-state') return { status: 'disabled', currentVersion: '', isReminderDeferred: false }
    return { success: true }
  })
  await render(<WriterWelcomePage onNewProject={vi.fn()} />)
  expect(localStorage.getItem('vela:overview:one')).toBeNull()
  expect(localStorage.getItem('vela:overview-extra')).toBe('keep')
  expect(localStorage.getItem('vela:preferences')).toBe('keep')

  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="预览《甲书》"]')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="预览《乙书》"]')!.click())
  await act(async () => b.resolve(ready('乙书')))
  expect(container.querySelector('.writer-welcome-heading')?.textContent).toContain('乙书')
  expect(container.textContent).toContain('蓝图')
  expect(container.textContent).toContain('进行中')
  expect(container.textContent).toContain('待读取')
  await act(async () => a.resolve(ready('甲书')))
  expect(container.querySelector('.writer-welcome-heading')?.textContent).toContain('乙书')
  expect(container.querySelector('.writer-welcome-heading')?.textContent).not.toContain('甲书')
  expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index)))
    .not.toContainEqual(expect.stringMatching(/^vela:overview:/))
})
