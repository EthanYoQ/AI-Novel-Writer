import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import '../../../styles/paper-ink/index.css'
import '../stage.css'
import type { TrashedChapter } from '../../../shared/chapter-deletion'
import type { ProjectData, ProjectSessionContext } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useDraftStore } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'
import StageShell from '../StageShell'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useDraftStore, useEditorStore, useLayoutStore, useLLMStore, useLocaleStore, useStageStore, useProjectStore]
  .map(store => snapshot(store as StoreApi<unknown>))

const LIGHTHOUSE: ProjectSessionContext = { projectId: 'lighthouse', leaseId: 'lighthouse-lease', projectPath: 'C:\\novels\\lighthouse' }
const HARBOR: ProjectSessionContext = { projectId: 'harbor', leaseId: 'harbor-lease', projectPath: 'C:\\novels\\harbor' }
const TRASHED: TrashedChapter = {
  deletionId: 'del-3', draftId: 30, chapterNumber: 3, chapterTitle: '灯塔', deletedAt: '2026-11-05T06:00:00.000Z',
  wordCount: 3120, versionCount: 2, cleanup: 'completed', restoreMode: 'into-gap',
}

let root: Root | undefined
let host: HTMLDivElement | undefined

/** 像 openProject 一样换上这次打开：主进程签发的会话、新的项目对象，正文阶段的标签。 */
async function open(context: ProjectSessionContext, name: string) {
  await act(async () => {
    setActiveProjectSessionContext(context)
    const tab = { id: `manuscript:${context.projectId}`, name: '正文', type: 'chapter' as const, projectKey: context.projectPath }
    useEditorStore.setState({ tabs: [tab], activeTabId: tab.id })
    useProjectStore.setState({ currentProject: { id: context.projectId, sessionLease: context.leaseId, name, path: context.projectPath, novelConfig: {} } as unknown as ProjectData })
  })
}

beforeEach(async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'chapter:trash-list') return { success: true, entries: [TRASHED], damaged: [] }
    if (channel === 'project:overview-current') return { state: 'unavailable' }
    if (channel === 'update:get-state') return { status: 'idle', currentVersion: '1.4.0', isReminderDeferred: false }
    return channel.endsWith('-list') || channel.endsWith('get-all') ? [] : undefined
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => undefined } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLLMStore.setState({ loaded: true, models: [], defaultModelId: null })
  useStageStore.setState({ sheet: null, focus: false, palette: null, work: null })
  useLayoutStore.setState({ sidebarView: 'project', settingsOpen: false })
  await open(LIGHTHOUSE, '灯塔')
  host = document.createElement('div')
  host.style.cssText = 'width: 1280px; height: 800px; display: flex;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageShell theme="light" />))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

describe('外壳里的对话框属于打开它时的作品（#592）', () => {
  it('回收站和彻底删除确认开着时换了作品，两层都关掉；在新作品里再打开回收站，旧的确认框不会跟着出来', async () => {
    await act(async () => page.getByRole('button', { name: '回收站（1）' }).click())
    const trash = page.getByRole('dialog', { name: '回收站（1）' })
    await expect.element(trash).toBeVisible()
    await act(async () => trash.getByRole('button', { name: '彻底删除…' }).click())
    await expect.element(page.getByRole('dialog', { name: '彻底删除第 3 章「灯塔」？' })).toBeVisible()

    await open(HARBOR, '雾港')
    await expect.element(page.getByRole('dialog', { name: /^彻底删除/ })).not.toBeInTheDocument()
    await vi.waitFor(() => expect(document.querySelector('.stage-trash-list')).toBeNull())

    await act(async () => page.getByRole('button', { name: '回收站（1）' }).click())
    await expect.element(page.getByRole('dialog', { name: '回收站（1）' })).toBeVisible()
    await expect.element(page.getByRole('dialog', { name: /^彻底删除/ })).not.toBeInTheDocument()
  })

  it('回收站和彻底删除确认开着时去了书房，回到同一部作品不会自己再弹出来（#592）', async () => {
    await act(async () => page.getByRole('button', { name: '回收站（1）' }).click())
    await act(async () => page.getByRole('dialog', { name: '回收站（1）' }).getByRole('button', { name: '彻底删除…' }).click())
    await expect.element(page.getByRole('dialog', { name: '彻底删除第 3 章「灯塔」？' })).toBeVisible()

    await act(async () => useLayoutStore.setState({ sidebarView: 'home' }))
    await act(async () => useLayoutStore.setState({ sidebarView: 'project' }))
    expect(document.querySelector('.stage-trash-list')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await expect.element(page.getByRole('button', { name: '回收站（1）' })).toBeVisible()
  })

  it('没有蓝图、最后一章也删了：点「正文」落到蓝图页，回收站入口仍在，能打开回收站（#592）', async () => {
    await act(async () => {
      useStageStore.setState({ work: { session: LIGHTHOUSE, architecture: {}, blueprints: [] }, spineFacts: LIGHTHOUSE })
      useDraftStore.setState({ draftsByChapter: {}, dataProjectSession: LIGHTHOUSE, loading: false })
    })
    await act(async () => page.getByRole('button', { name: /^正文/ }).click())
    await vi.waitFor(() => expect(useEditorStore.getState().activeTabId).not.toBe('manuscript:lighthouse'))
    await act(async () => page.getByRole('button', { name: '回收站（1）' }).click())
    await expect.element(page.getByRole('dialog', { name: '回收站（1）' })).toBeVisible()
  })

  it('清除生成内容开着时换了作品就关掉', async () => {
    await act(async () => page.getByRole('button', { name: '《灯塔》作品菜单' }).click())
    await act(async () => page.getByRole('menuitem', { name: '清除生成内容…' }).click())
    await expect.element(page.getByRole('dialog', { name: /清除/ })).toBeVisible()

    await open(HARBOR, '雾港')
    await expect.element(page.getByRole('dialog', { name: /清除/ })).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: '《雾港》作品菜单' })).toBeVisible()
  })
})
