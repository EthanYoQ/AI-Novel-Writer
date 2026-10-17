import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import type { ProjectData, ProjectSessionContext } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useDraftStore } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { openBuiltinEditor } from '../../../stores/open-builtin-editor'
import { useProjectStore } from '../../../stores/project-store'
import { toast } from '../../ui/Toast'

const PATH = 'C:\\novels\\open-chapter'
const SESSION: ProjectSessionContext = { projectId: 'open-chapter', leaseId: 'lease', projectPath: PATH }
function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [snapshot(useDraftStore), snapshot(useEditorStore), snapshot(useStageStore), snapshot(useProjectStore)]

/** 主进程的草稿接口：每章一份草稿，按章设定返回前的延迟，或直接失败。 */
function installDrafts(behavior: Record<number, { delayMs?: number; error?: string; empty?: boolean }>) {
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:draft-list') {
      const chapterNumber = args[0] as number
      const { delayMs = 0, error, empty } = behavior[chapterNumber] ?? {}
      await new Promise(resolve => setTimeout(resolve, delayMs))
      if (error) throw new Error(error)
      return empty ? [] : [{ id: chapterNumber * 10 + 1, chapterNumber, version: 1, status: 'draft', createdAt: '2026-10-12T00:00:00Z', source: 'write' }]
    }
    if (channel === 'db:draft-get-full') return { content: `第 ${Math.floor((args[0] as number) / 10)} 章的正文` }
    throw new Error(`unexpected IPC ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() },
  })
}

const activeTab = () => useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  setActiveProjectSessionContext(SESSION)
  useProjectStore.setState({ currentProject: { id: SESSION.projectId, sessionLease: SESSION.leaseId, name: '灯塔', path: PATH, novelConfig: {} } as unknown as ProjectData })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useDraftStore.setState({ draftsByChapter: {}, dataProjectSession: null, loading: true })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [4, 5, 6, 7].map(chapterNumber => ({ chapterNumber, title: `第${chapterNumber}章标题` })) } })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

describe('在新外壳里打开一章', () => {
  it('连点两章时只有最后一次生效，先点的慢请求回来也不抢走', async () => {
    installDrafts({ 4: { delayMs: 80 }, 5: { delayMs: 0 } })
    navigate({ kind: 'chapter', chapterNumber: 4 })
    navigate({ kind: 'chapter', chapterNumber: 5 })
    await vi.waitFor(() => expect(activeTab()?.chapterNumber).toBe(5))
    await settle(150)
    expect(useEditorStore.getState().tabs.map(tab => tab.chapterNumber)).toEqual([5])
    expect(activeTab()).toMatchObject({ chapterNumber: 5, content: '第 5 章的正文', name: '第 5 章 · 第5章标题' })
  })

  it.each([
    ['设定', { kind: 'stage', stage: 'setup' } as const, 'config'],
    ['版本历史', { kind: 'resource', page: 'history' } as const, 'version-history'],
  ])('点了一章、正文还没读完就去%s：读完的那一章不抢回标签', async (_name, intent, type) => {
    installDrafts({ 4: { delayMs: 80 } })
    navigate({ kind: 'chapter', chapterNumber: 4 })
    navigate(intent)
    await vi.waitFor(() => expect(activeTab()?.type).toBe(type))
    await settle(150)
    expect(activeTab()?.type).toBe(type)
    expect(useEditorStore.getState().tabs.map(tab => tab.type)).toEqual([type])
  })

  it('点「正文」时几章都在写：打开最后一章在写的，只有空稿的章不算', async () => {
    installDrafts({})
    const draft = (chapterNumber: number, wordCount: number) => [{ id: chapterNumber * 10 + 1, chapterNumber, version: 1, status: 'draft', wordCount,
      createdAt: '2026-10-12 00:00:00', source: 'write', filePath: `ai-novel://draft/${chapterNumber * 10 + 1}`, fileName: 'draft_v1.md' }]
    useDraftStore.setState({ draftsByChapter: { 4: draft(4, 1800), 5: draft(5, 2400), 6: draft(6, 0) } as never, dataProjectSession: SESSION, loading: false })
    navigate({ kind: 'stage', stage: 'manuscript' })
    await vi.waitFor(() => expect(activeTab()?.chapterNumber).toBe(5))
    expect(activeTab()).toMatchObject({ chapterNumber: 5, content: '第 5 章的正文' })
  })

  it('读取失败时提示作者，而不是点了没反应', async () => {
    installDrafts({ 6: { error: '磁盘读取失败' } })
    const error = vi.spyOn(toast, 'error').mockImplementation(() => undefined)
    navigate({ kind: 'chapter', chapterNumber: 6 })
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('打开第 6 章失败：磁盘读取失败'))
    expect(useEditorStore.getState().tabs).toEqual([])
  })

  it('待写的章打开它的单章视图（RD-8）：再点一次同一章只切过去，不再开第二个标签', async () => {
    installDrafts({ 7: { empty: true } })
    navigate({ kind: 'chapter', chapterNumber: 7 })
    await vi.waitFor(() => expect(activeTab()).toMatchObject({ type: 'chapter', chapterNumber: 7, name: '第 7 章 · 第7章标题' }))
    expect(activeTab()?.filePath).toBeUndefined()
    openBuiltinEditor('chapter-card-editor', '章节蓝图', 'chapter-card')
    navigate({ kind: 'chapter', chapterNumber: 7 })
    await vi.waitFor(() => expect(activeTab()?.type).toBe('chapter'))
    expect(useEditorStore.getState().tabs.map(tab => tab.type)).toEqual(['chapter', 'chapter-card'])
  })

  it('草稿已按这次会话载入完时直接用 store 里的草稿，不再单独读', async () => {
    installDrafts({})
    useDraftStore.setState({ dataProjectSession: SESSION, loading: false, draftsByChapter: { 4: [{ id: 41, chapterNumber: 4, version: 1, status: 'draft',
      createdAt: '2026-10-12T00:00:00Z', source: 'write', fileName: 'draft_v1.md', filePath: 'ai-novel://draft/41' }] } })
    navigate({ kind: 'chapter', chapterNumber: 4 })
    await vi.waitFor(() => expect(activeTab()?.chapterNumber).toBe(4))
    const invoke = (window as unknown as { aiNovelAPI: { invoke: ReturnType<typeof vi.fn> } }).aiNovelAPI.invoke
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['db:draft-get-full'])
  })
})
