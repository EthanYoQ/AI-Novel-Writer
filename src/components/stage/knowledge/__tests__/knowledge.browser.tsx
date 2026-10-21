import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import type { Locale } from '../../../../i18n/types'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { saveDirtyEditorChangesForExit, useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { toast } from '../../../ui/Toast'
import StageWorkspace from '../../StageWorkspace'
import { requestCloseTab } from '../../tab-close'
import { useStageShortcuts } from '../../use-stage-shortcuts'
import KnowledgeIndexSection from '../KnowledgeIndexSection'
import StageKnowledge from '../StageKnowledge'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/night-train', leaseId: '本次打开' }
const KB_TAB = `knowledge-base:${encodeURIComponent(session.projectPath)}`
const project = (extra: Record<string, unknown> = {}) => ({ id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车', novelConfig: {}, ...extra }) as unknown as ProjectData
const IMPLEMENTATION_TERMS = /LanceDB|FTS|BM25|Embedding|向量|vector|chunk|query|MCP|token/i

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useLocaleStore, useLayoutStore, useEditorStore, useStageStore, useLLMStore, useWorkflowStore].map(store => snapshot(store as StoreApi<unknown>))

const copies: Record<string, string> = {
  station: '本报讯 三月十二日深夜，北郊车站三号站台发生一起列车事故。',
  people: '林舟，二十九岁，铁路调度员。',
  ch2: '林舟在抽屉底下翻出一张旧照片。',
}

// 应用切换界面语言时会改 <html lang>，按钮的字距跟着 :lang() 变；量宽度的用例要照样设，结束后还原。
const PAGE_LANG = document.documentElement.lang
let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

beforeEach(() => {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'kb:list-documents') return [
      { id: 'station', fileName: '车站档案.md', importedAt: '', chunkCount: 3, filePath: 'knowledge-copy:station' },
      { id: 'people', fileName: '林舟人物小传.txt', importedAt: '', chunkCount: 2, filePath: 'knowledge-copy:people' },
      // 定稿经 kb:import-text 收入，和导入资料一样有项目副本；只有定稿登记里的章号能把它认出来。
      { id: 'ch2', fileName: '第2章 母亲的旧照片.txt', importedAt: '', chunkCount: 4, filePath: 'knowledge-copy:ch2', finalizedChapter: 2 },
      // 旧版导入、没有项目副本的资料。
      { id: 'legacy', fileName: '旧版地名表.txt', importedAt: '', chunkCount: 1, filePath: '' },
    ]
    if (channel === 'kb:stats') return { documentCount: 4, totalChunks: 9, vectorDimension: 0 }
    if (channel === 'kb:get-vector-rebuild-status') return { embeddingConfigured: true, canRebuild: true, totalChunks: 9, vectorlessCount: 4, activeVectorDimension: 0 }
    if (channel === 'kb:read-document-copy') {
      const content = copies[args[0] as string]
      return content ? { available: true, content, contentHash: `h-${args[0]}`, edited: false, indexStatus: 'current' } : { available: false, indexStatus: 'unavailable' }
    }
    if (channel === 'kb:search') return [
      { text: '……最后一次被人看见，是在三号站台的候车长椅上，此后失踪。', score: 0.5, fileName: '失踪者名单.md' },
      { text: '……北郊车站三号站台发生一起列车事故……', score: 0.5, fileName: '车站档案.md' },
    ]
    if (channel === 'kb:clear-all') return { success: true }
    if (channel === 'kb:save-document-copy') return { success: true }
    if (channel === 'kb:backfill-vectors') return { success: true, processed: 4, failed: 0 }
    if (channel === 'db:blueprint-get-all') return []
    if (channel === 'dialog:select-knowledge-files') return [{ grantId: 'grant-1', displayName: '守塔人小传.txt' }]
    if (channel === 'fs:grant-read-file') return { success: true, content: '守塔人姓周，在灯塔守了三十年。' }
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: project() })
  useEditorStore.setState({
    tabs: [
      { id: KB_TAB, name: '知识库', type: 'knowledge', projectKey: session.projectPath },
      { id: `version-history:${encodeURIComponent(session.projectPath)}`, name: '版本历史', type: 'version-history', projectKey: session.projectPath },
    ],
    activeTabId: KB_TAB,
  })
  setActiveProjectSessionContext(session)
  useLocaleStore.setState({ locale: 'zh-CN' })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1280px; height: 800px; display: flex'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  document.documentElement.lang = PAGE_LANG
  vi.restoreAllMocks()
})

const button = (name: string | RegExp) => [...document.querySelectorAll('button')]
  .find(candidate => typeof name === 'string'
    ? candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name
    : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = button(name)
  expect(target, String(name)).toBeTruthy()
  await act(async () => target!.click())
}
const reads = () => invoke.mock.calls.filter(([channel]) => channel === 'kb:read-document-copy').map(([, id]) => id)

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
  await act(async () => {
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function editorArea() {
  return vi.waitFor(() => {
    const textarea = document.querySelector('textarea')
    expect(textarea).toBeTruthy()
    return textarea!
  })
}

async function renderPage() {
  await act(async () => root!.render(<StageKnowledge tabId={KB_TAB} />))
  await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
}

/** 页面上作者能读到的全部文字：正文、可访问名称、提示与占位。 */
function visibleWords(): string {
  const attributes = [...document.querySelectorAll('[aria-label], [title], [placeholder]')]
    .flatMap(node => ['aria-label', 'title', 'placeholder'].map(name => node.getAttribute(name) ?? ''))
  return [document.body.textContent ?? '', ...attributes].join('\n')
}

/** 作者在页面与提示里读到的全部文字：每一步收一次页面，再加上弹过的提示。 */
function wordCollector() {
  const toasts: string[] = []
  for (const kind of ['success', 'error', 'warning', 'info'] as const) {
    vi.spyOn(toast, kind).mockImplementation(message => { toasts.push(message) })
  }
  const pages: string[] = []
  return { snap: () => { pages.push(visibleWords()) }, all: () => [...pages, ...toasts].join('\n'), toasts }
}

describe('知识库', () => {
  for (const locale of ['zh-CN', 'en-US'] as Locale[]) {
    const say = (zh: string, en: string) => locale === 'zh-CN' ? zh : en

    it(`${locale} 下资料、原文不可用、保存、查找、清空与外发提取确认里都没有实现术语`, async () => {
      useLocaleStore.setState({ locale })
      useLLMStore.setState({ loaded: true, models: [{ id: 'm1', name: '夹具模型', modelName: 'fixture', baseUrl: 'http://127.0.0.1:9', purposes: ['generation'] }] as never, defaultModelId: 'm1' })
      useWorkflowStore.setState({ startWorkflow: async () => 'local-run', history: [{ id: 'local-run', status: 'completed' }] as never })
      const words = wordCollector()
      await renderPage()
      words.snap()
      await click(/旧版地名表/)
      await vi.waitFor(() => expect(document.body.textContent).toContain(say('完整原文不可用', 'The full text is unavailable')))
      words.snap()
      await click(say('定稿章节 1', 'Final chapters 1'))
      await click(/母亲的旧照片/)
      words.snap()
      await click(say('我导入的 3', 'Imported 3'))
      await click(/车站档案/)
      await type(await editorArea(), `${copies.station}站台已封闭。`)
      await click(say('保存副本', 'Save copy'))
      await vi.waitFor(() => expect(words.toasts.length).toBeGreaterThan(0))
      await type(document.querySelector<HTMLInputElement>('form[role="search"] input')!, '三号站台 失踪')
      await act(async () => document.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit())
      await vi.waitFor(() => expect(document.querySelectorAll('mark').length).toBeGreaterThan(0))
      words.snap()
      await click(say('清空知识库…', 'Clear knowledge base…'))
      expect(document.querySelector('[role="dialog"]')).toBeTruthy()
      words.snap()
      await click(say('取消', 'Cancel'))
      await click(say('导入创作资料', 'Import planning material'))
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('http://127.0.0.1:9'))
      words.snap()
      expect(words.all()).not.toMatch(IMPLEMENTATION_TERMS)
    })

    it(`${locale} 下空知识库、可按意思查找与检索检查的提示里都没有实现术语`, async () => {
      useLocaleStore.setState({ locale })
      const plain = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
        if (channel === 'kb:list-documents') return []
        if (channel === 'kb:stats') return { documentCount: 0, totalChunks: 0, vectorDimension: 768 }
        return plain(channel, ...args)
      })
      const words = wordCollector()
      await act(async () => root!.render(<StageKnowledge tabId={KB_TAB} />))
      await vi.waitFor(() => expect(document.body.textContent).toContain(say('知识库里还没有资料', 'No material yet')))
      expect(document.body.textContent).toContain(say('可以按意思和字词查找。', 'Search by meaning and by words.'))
      words.snap()
      await act(async () => root!.render(<KnowledgeIndexSection />))
      await vi.waitFor(() => expect(document.querySelector('section button')).toBeTruthy())
      await act(async () => document.querySelector<HTMLButtonElement>('section button')!.click())
      await vi.waitFor(() => expect(words.toasts.length).toBeGreaterThan(0))
      expect(words.toasts.join('\n')).not.toMatch(IMPLEMENTATION_TERMS)
      expect(words.all()).not.toMatch(IMPLEMENTATION_TERMS)
    })

    // 主进程只交错误码（#474 B3）：更新检索、保存副本与检查重建被拒时，提示按界面语言说明，不露码。
    const expectExplained = (message: string | undefined, zh: string, en: string) => {
      expect(message).toContain(say(zh, en))
      expect(message).not.toMatch(locale === 'en-US' ? /[A-Z]{3,}_|\p{Script=Han}/u : /[A-Z]{3,}_/u)
    }

    it(`${locale} 下更新检索与保存副本被拒时按界面语言说明原因`, async () => {
      useLocaleStore.setState({ locale })
      const plain = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
        if (channel === 'kb:read-document-copy' && args[0] === 'station') return { available: true, content: copies.station, contentHash: 'h-station', edited: false, indexStatus: 'stale' }
        if (channel === 'kb:reindex-document-copy') return { success: false, error: 'KNOWLEDGE_BASE_COPY_EMPTY' }
        if (channel === 'kb:save-document-copy') return { success: false, error: 'KNOWLEDGE_BASE_COPY_CHANGED' }
        return plain(channel, ...args)
      })
      const words = wordCollector()
      await renderPage()
      await click(/车站档案/)
      await vi.waitFor(() => expect((document.querySelector('textarea') as HTMLTextAreaElement | null)?.value).toBe(copies.station))
      await click(say('更新检索', 'Update search'))
      await vi.waitFor(() => expect(words.toasts).toHaveLength(1))
      expectExplained(words.toasts[0], '项目副本是空的', 'The project copy is empty')

      await type(await editorArea(), `${copies.station}站台已封闭。`)
      await click(say('保存副本', 'Save copy'))
      await vi.waitFor(() => expect(words.toasts).toHaveLength(2))
      expectExplained(words.toasts[1], '请重新打开这份资料', 'Reopen the material')
    })

    it.each([
      [{ success: false, processed: 0, failed: 0, error: 'EMBEDDING_SPACE_REGISTRY_INVALID' }, '检索索引记录已损坏', 'search index records of this book are damaged'],
      // 旧向量迁移阻断时主进程按系统语言写 error、码放在 errorCode：以界面语言为准。
      [{ success: false, errorCode: 'LEGACY_VECTOR_MIGRATION_BLOCKED', error: '旧版知识库数据需要先修复后才能继续。请修正项目中的 vectors.json，然后重试。' }, '旧版知识库数据需要先修复', 'Legacy knowledge-base data must be repaired'],
    ])(`${locale} 下检查并重建被拒时按界面语言说明原因 %#`, async (result, zh, en) => {
      useLocaleStore.setState({ locale })
      const plain = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'kb:backfill-vectors' ? result : plain(channel, ...args))
      const words = wordCollector()
      await act(async () => root!.render(<KnowledgeIndexSection />))
      await vi.waitFor(() => expect(document.querySelector('section button')).toBeTruthy())
      await act(async () => document.querySelector<HTMLButtonElement>('section button')!.click())
      await vi.waitFor(() => expect(words.toasts).toHaveLength(1))
      expectExplained(words.toasts[0], zh, en)
    })

    it(`${locale} 下没登记的码接在按界面语言写的说明后面，供反馈定位`, async () => {
      useLocaleStore.setState({ locale })
      const plain = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'kb:backfill-vectors'
        ? { success: false, processed: 0, failed: 1, error: 'EMBEDDING_SPACE_VERIFY_FAILED' }
        : plain(channel, ...args))
      const words = wordCollector()
      await act(async () => root!.render(<KnowledgeIndexSection />))
      await vi.waitFor(() => expect(document.querySelector('section button')).toBeTruthy())
      await act(async () => document.querySelector<HTMLButtonElement>('section button')!.click())
      await vi.waitFor(() => expect(words.toasts).toHaveLength(1))
      expect(words.toasts[0]).toBe(say('重建检索失败：EMBEDDING_SPACE_VERIFY_FAILED', 'Could not rebuild search. EMBEDDING_SPACE_VERIFY_FAILED'))
    })
  }

  it('查找结果里标出查找词，定稿章节分开列出', async () => {
    await renderPage()
    await type(document.querySelector<HTMLInputElement>('form[role="search"] input')!, '三号站台 失踪')
    await act(async () => document.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit())
    await vi.waitFor(() => expect(document.body.textContent).toContain('找到 2 条'))
    expect([...document.querySelectorAll('mark')].map(node => node.textContent)).toEqual(expect.arrayContaining(['三号站台', '失踪']))
    expect(invoke.mock.calls.find(([channel]) => channel === 'kb:search')?.slice(1, 3)).toEqual(['三号站台 失踪', 10])

  })

  it('改「最多显示」按上次查找的词重查，不用输入框里还没提交的字', async () => {
    await renderPage()
    const input = document.querySelector<HTMLInputElement>('form[role="search"] input')!
    await type(input, '三号站台 失踪')
    await act(async () => document.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit())
    await vi.waitFor(() => expect(document.body.textContent).toContain('找到 2 条'))
    await type(input, '还没提交')
    const limit = document.querySelector<HTMLSelectElement>('.stage-kb-topk')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(limit, '5')
      limit.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([channel]) => channel === 'kb:search').map(call => call.slice(1, 3)))
      .toEqual([['三号站台 失踪', 10], ['三号站台 失踪', 5]]))
  })

  it('资料列表读完之前阅读栏与左栏都说正在读取，不说没有资料、不显示 0，读完才列出与计数', async () => {
    let release!: () => void
    const listed = new Promise<void>(resolve => { release = resolve })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'kb:list-documents') await listed
      return base(channel, ...args)
    })
    await act(async () => root!.render(<StageKnowledge tabId={KB_TAB} />))
    await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'kb:list-documents')).toBe(true))
    expect(document.body.textContent).not.toContain('知识库里还没有资料')
    expect(host!.querySelector('[aria-label="资料原文"] [role="status"]')?.textContent).toBe('正在读取资料…')
    const shelves = () => [...host!.querySelectorAll('[aria-label="资料来源"] button')].map(option => option.textContent)
    expect(shelves()).toEqual(['我导入的', '定稿章节'])
    expect(host!.querySelector('.stage-kb-list')?.textContent).toBe('正在读取…')
    await act(async () => release())
    await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
    expect(host!.querySelector('[aria-label="资料原文"] [role="status"]')).toBeNull()
    expect(shelves()).toEqual(['我导入的 3', '定稿章节 1'])
  })

  it('资料列表读取失败：只显示读取失败，不说知识库是空的、不叫作者去左边选资料、不显示 0；点「刷新资料」读到就列出', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'kb:list-documents' ? Promise.reject(new Error('磁盘忙')) : base(channel, ...args))
    await act(async () => root!.render(<StageKnowledge tabId={KB_TAB} />))
    const reader = () => host!.querySelector('[aria-label="资料原文"]')!.textContent
    await vi.waitFor(() => expect(reader()).toContain('读取知识库失败'))
    const page = host!.textContent
    expect(page).not.toContain('知识库里还没有资料')
    expect(page).not.toContain('从左边选一份资料查看原文')
    expect(page).not.toContain('还没有导入资料')
    const shelves = () => [...host!.querySelectorAll('[aria-label="资料来源"] button')].map(option => option.textContent)
    expect(shelves()).toEqual(['我导入的', '定稿章节'])

    invoke.mockImplementation(base)
    await click('刷新资料')
    await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
    expect(reader()).not.toContain('读取知识库失败')
    expect(shelves()).toEqual(['我导入的 3', '定稿章节 1'])
  })

  describe('连续改「最多显示」，两次查找乱序返回', () => {
    const hits = (count: number) => Array.from({ length: count }, (_, index) => ({ text: `……三号站台第 ${index + 1} 段……`, score: 0.5, fileName: '车站档案.md' }))
    let replies: Map<number, (count: number) => void>

    async function searchThenChange(limits: number[]) {
      await renderPage()
      await type(document.querySelector<HTMLInputElement>('form[role="search"] input')!, '三号站台')
      await act(async () => document.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit())
      await vi.waitFor(() => expect(document.body.textContent).toContain('找到 2 条'))
      replies = new Map()
      const base = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel, ...args) => channel === 'kb:search'
        ? new Promise(resolve => replies.set(args[1] as number, count => resolve(hits(count))))
        : base(channel, ...args))
      const limit = document.querySelector<HTMLSelectElement>('.stage-kb-topk')!
      for (const value of limits) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(limit, String(value))
          limit.dispatchEvent(new Event('change', { bubbles: true }))
        })
      }
      await vi.waitFor(() => expect([...replies.keys()]).toEqual(limits))
    }
    const findButton = () => [...document.querySelectorAll('button')].find(button => button.textContent === '查找')!
    const reply = async (limit: number, count: number) => act(async () => replies.get(limit)!(count))

    it('先改的那次晚到，不盖掉后改的结果', async () => {
      await searchThenChange([5, 20])
      await reply(20, 7)
      await vi.waitFor(() => expect(document.body.textContent).toContain('找到 7 条'))
      await reply(5, 5)
      expect(document.body.textContent).toContain('找到 7 条')
      expect(document.querySelector<HTMLSelectElement>('.stage-kb-topk')!.value).toBe('20')
    })

    it('先改的那次先到，后改的还在查：仍在查找中，查找按钮不可点', async () => {
      await searchThenChange([5, 20])
      await reply(5, 5)
      expect(findButton().disabled).toBe(true)
      await reply(20, 7)
      await vi.waitFor(() => expect(document.body.textContent).toContain('找到 7 条'))
      expect(findButton().disabled).toBe(false)
    })
  })

  describe('查找还没返回时又有操作', () => {
    let held: Map<string, (count: number) => void>
    const hitsFor = (query: string, count: number) => Array.from({ length: count }, (_, index) => ({ text: `……${query}第 ${index + 1} 段……`, score: 0.5, fileName: '车站档案.md' }))
    const holdSearches = () => {
      held = new Map()
      const base = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel, ...args) => channel === 'kb:search'
        ? new Promise(resolve => held.set(`${args[0]}|${args[1]}`, count => resolve(hitsFor(args[0] as string, count))))
        : base(channel, ...args))
    }
    const submit = async (query: string) => {
      await type(document.querySelector<HTMLInputElement>('form[role="search"] input')!, query)
      await act(async () => document.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit())
    }
    const results = () => [...document.querySelectorAll('[aria-label="查找结果"] li p')].map(node => node.textContent)

    it('查 A 出结果后提交 B，B 还没回来时改「最多显示」：按 B 重查，最后显示的是 B 的结果', async () => {
      await renderPage()
      await submit('三号站台')
      await vi.waitFor(() => expect(document.body.textContent).toContain('找到 2 条'))
      holdSearches()
      await submit('母亲的照片')
      await vi.waitFor(() => expect([...held.keys()]).toEqual(['母亲的照片|10']))
      const limit = document.querySelector<HTMLSelectElement>('.stage-kb-topk')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(limit, '20')
        limit.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await vi.waitFor(() => expect(held.size).toBe(2))
      for (const [key, resolve] of held) await act(async () => resolve(key.endsWith('|20') ? 3 : 1))
      await vi.waitFor(() => expect(document.body.textContent).toContain('找到 3 条'))
      expect([...held.keys()]).toEqual(['母亲的照片|10', '母亲的照片|20'])
      expect(results()).toEqual(['……母亲的照片第 3 段……', '……母亲的照片第 2 段……', '……母亲的照片第 1 段……'])
    })

    it('查找还没返回时点清除：结果不再冒出来，也不说没有找到', async () => {
      await renderPage()
      holdSearches()
      await submit('三号站台')
      await vi.waitFor(() => expect([...held.keys()]).toEqual(['三号站台|10']))
      await click('清除查找')
      await act(async () => held.get('三号站台|10')!(2))
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
      expect(results()).toEqual([])
      expect(document.body.textContent).not.toContain('找到 2 条')
      expect(document.body.textContent).not.toContain('没有找到相关的资料')
    })
  })

  it('定稿章节按定稿登记分架：有项目副本也不进「我导入的」，旧版无副本的导入资料不算定稿', async () => {
    await renderPage()
    expect(button(/我导入的 3/)).toBeTruthy()
    expect(button(/旧版地名表/)).toBeTruthy()
    expect(button(/母亲的旧照片/)).toBeUndefined()

    await click(/旧版地名表/)
    await vi.waitFor(() => expect(document.body.textContent).toContain('完整原文不可用'))
    expect(document.body.textContent).not.toContain('这一章由定稿自动收入')

    await click(/定稿章节 1/)
    expect(button(/车站档案/)).toBeUndefined()
    await click(/母亲的旧照片/)
    await vi.waitFor(() => expect(document.body.textContent).toContain('这一章由定稿自动收入'))
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('定稿章节只读显示原文；旧外壳改过副本还没更新检索时提示并能更新检索，说明里不说重新定稿会自动更新', async () => {
    const edited = `${copies.ch2}照片背面写着一个日期。`
    const plain = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'kb:read-document-copy' && args[0] === 'ch2') return { available: true, content: edited, contentHash: 'h-ch2-edited', edited: true, indexStatus: 'stale' }
      if (channel === 'kb:reindex-document-copy') return { success: true, docId: 'ch2', chunkCount: 4 }
      return plain(channel, ...args)
    })
    await renderPage()
    await click(/定稿章节 1/)
    await click(/母亲的旧照片/)
    await vi.waitFor(() => expect(document.body.textContent).toContain(edited))
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.body.textContent).toContain('这一章由定稿自动收入')
    expect(document.body.textContent).toContain('改动还没进入检索')
    expect(document.body.textContent).not.toContain('自动更新')
    expect(button('更新检索')?.disabled).toBe(false)

    await click('更新检索')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'kb:reindex-document-copy').map(([, docId]) => docId)).toEqual(['ch2'])
  })

  it('定稿章节没改过、检索却过时（比如上次更新检索没做完）：提示不说改过，照样能更新检索', async () => {
    const plain = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'kb:read-document-copy' && args[0] === 'ch2') return { available: true, content: copies.ch2, contentHash: 'h-ch2', edited: false, indexStatus: 'stale' }
      if (channel === 'kb:reindex-document-copy') return { success: true, docId: 'ch2', chunkCount: 4 }
      return plain(channel, ...args)
    })
    await renderPage()
    await click(/定稿章节 1/)
    await click(/母亲的旧照片/)
    await vi.waitFor(() => expect(document.body.textContent).toContain(copies.ch2))
    const notice = [...document.querySelectorAll('.stage-kb-reader .pi-notice')].map(node => node.textContent).join('\n')
    expect(notice).toContain('还没进入检索')
    expect(notice).not.toMatch(/改过|改动/)
    await click('更新检索')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'kb:reindex-document-copy').map(([, docId]) => docId)).toEqual(['ch2'])
  })

  it('导入的资料没改过、检索却过时：提示不说改过，照样能更新检索', async () => {
    const plain = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'kb:read-document-copy' && args[0] === 'station') return { available: true, content: copies.station, contentHash: 'h-station', edited: false, indexStatus: 'stale' }
      if (channel === 'kb:reindex-document-copy') return { success: true, docId: 'station', chunkCount: 3 }
      return plain(channel, ...args)
    })
    await renderPage()
    await click(/车站档案/)
    await vi.waitFor(() => expect((document.querySelector('textarea') as HTMLTextAreaElement | null)?.value).toBe(copies.station))
    const notice = [...document.querySelectorAll('.stage-kb-reader .pi-notice')].map(node => node.textContent).join('\n')
    expect(notice).toContain('还没进入检索')
    expect(notice).not.toMatch(/改过|改动|旧内容/)
    await click('更新检索')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'kb:reindex-document-copy').map(([, docId]) => docId)).toEqual(['station'])
  })

  it('定稿章节的副本已进入检索时只读显示原文，不提供更新检索', async () => {
    await renderPage()
    await click(/定稿章节 1/)
    await click(/母亲的旧照片/)
    await vi.waitFor(() => expect(document.body.textContent).toContain(copies.ch2))
    expect(document.querySelector('textarea')).toBeNull()
    expect(button('更新检索')).toBeUndefined()
    expect(document.body.textContent).not.toContain('自动更新')
  })

  it('没有项目副本的资料不叫作者重新导入：说明只能用来查找，不能在这里查看或修改', async () => {
    await renderPage()
    await click(/旧版地名表/)
    const reader = () => document.querySelector('[aria-label="资料原文"]')?.textContent ?? ''
    await vi.waitFor(() => expect(reader()).toContain('完整原文不可用'))
    expect(reader()).not.toContain('重新导入')
    expect(reader()).toContain('仍能用来查找')
  })

  it('项目副本有未保存修改时切换资料先确认；继续编辑留住修改，放弃才切换', async () => {
    await renderPage()
    await click(/车站档案/)
    const editor = await vi.waitFor(() => {
      const textarea = document.querySelector('textarea')
      expect(textarea).toBeTruthy()
      return textarea!
    })
    await type(editor, `${copies.station}站台已封闭。`)
    expect(document.body.textContent).toContain('有未保存的修改')

    await click(/林舟人物小传/)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('放弃未保存的修改？')
    expect(dialog.textContent).toContain('「车站档案」的项目副本有未保存的修改')
    expect(reads()).toEqual(['station'])

    await click('继续编辑')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('textarea')!.value).toBe(`${copies.station}站台已封闭。`)
    expect(reads()).toEqual(['station'])

    await click(/林舟人物小传/)
    await click('放弃并切换')
    await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(copies.people))
    expect(reads()).toEqual(['station', 'people'])
  })

  it('外壳快捷键也在时，Ctrl S 保存项目副本', async () => {
    function WithShell() {
      useStageShortcuts({ library: false, focus: false, mac: false })
      return <StageKnowledge tabId={KB_TAB} />
    }
    await act(async () => root!.render(<WithShell />))
    await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
    await click(/车站档案/)
    const editor = await vi.waitFor(() => {
      const textarea = document.querySelector('textarea')
      expect(textarea).toBeTruthy()
      return textarea!
    })
    await type(editor, `${copies.station}站台已封闭。`)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })) })
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([channel]) => channel === 'kb:save-document-copy').map(([, id, content]) => [id, content]))
      .toEqual([['station', `${copies.station}站台已封闭。`]]))
  })

  it('Ctrl S 连按两次只保存一次', async () => {
    let finishSave: (value: unknown) => void = () => {}
    const plain = invoke.getMockImplementation()!
    invoke.mockImplementation((channel: string, ...args: unknown[]) => channel === 'kb:save-document-copy'
      ? new Promise(resolve => { finishSave = resolve })
      : plain(channel, ...args))
    function WithShell() {
      useStageShortcuts({ library: false, focus: false, mac: false })
      return <StageKnowledge tabId={KB_TAB} />
    }
    await act(async () => root!.render(<WithShell />))
    await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
    await click(/车站档案/)
    await type(await editorArea(), `${copies.station}站台已封闭。`)
    const ctrlS = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))
    await act(async () => { ctrlS(); ctrlS() })
    await act(async () => finishSave({ success: true }))
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('有未保存的修改'))
    expect(invoke.mock.calls.filter(([channel]) => channel === 'kb:save-document-copy')).toHaveLength(1)
  })

  describe('新外壳里未保存的项目副本不会悄悄丢掉', () => {
    async function editStation() {
      await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
      await click(/车站档案/)
      await type(await editorArea(), `${copies.station}站台已封闭。`)
    }

    it('切到别的标签再切回来，修改还在，标签带着未保存标记', async () => {
      await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
      await editStation()
      await act(async () => useEditorStore.getState().setActiveTab(`version-history:${encodeURIComponent(session.projectPath)}`))
      expect(document.querySelector('textarea')).toBeNull()
      expect(useEditorStore.getState().tabs.find(tab => tab.id === KB_TAB)?.dirty).toBe(true)
      await act(async () => useEditorStore.getState().setActiveTab(KB_TAB))
      await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(`${copies.station}站台已封闭。`))
      expect(document.body.textContent).toContain('有未保存的修改')
    })

    it('切走标签后退出前保存，仍把改动存进项目副本并清掉未保存标记', async () => {
      await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
      await editStation()
      await act(async () => useEditorStore.getState().setActiveTab(`version-history:${encodeURIComponent(session.projectPath)}`))
      await act(async () => saveDirtyEditorChangesForExit(session.projectPath))
      expect(invoke.mock.calls.filter(([channel]) => channel === 'kb:save-document-copy').map(([, id, content, hash]) => [id, content, hash]))
        .toEqual([['station', `${copies.station}站台已封闭。`, 'h-station']])
      expect(useEditorStore.getState().tabs.find(tab => tab.id === KB_TAB)?.dirty).toBe(false)
    })

    it('关闭标签（含 Ctrl W）先请作者确认', async () => {
      await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
      await editStation()
      await act(async () => requestCloseTab(KB_TAB))
      expect(useStageStore.getState().closingTabId).toBe(KB_TAB)
      expect(useEditorStore.getState().tabs.some(tab => tab.id === KB_TAB)).toBe(true)
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('「知识库」有未保存的修改')
    })

    it('切走前点的资料读得慢，切回后改了另一份资料，迟到的读取不会盖掉这些修改', async () => {
      let releaseFirstRead: () => void = () => {}
      let heldFirstRead = false
      const plain = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
        if (channel === 'kb:read-document-copy' && args[0] === 'station' && !heldFirstRead) {
          heldFirstRead = true
          await new Promise<void>(resolve => { releaseFirstRead = resolve })
        }
        return plain(channel, ...args)
      })
      await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
      await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
      await click(/车站档案/)
      await act(async () => useEditorStore.getState().setActiveTab(`version-history:${encodeURIComponent(session.projectPath)}`))
      await act(async () => useEditorStore.getState().setActiveTab(KB_TAB))
      await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(copies.station))
      await click(/林舟人物小传/)
      await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(copies.people))
      await type(await editorArea(), `${copies.people}左手有旧伤。`)
      await act(async () => { releaseFirstRead(); await new Promise(resolve => setTimeout(resolve, 20)) })
      expect(document.querySelector('textarea')?.value).toBe(`${copies.people}左手有旧伤。`)
      expect(document.querySelector('[aria-current="true"]')?.textContent).toContain('林舟人物小传')
      expect(useEditorStore.getState().tabs.find(tab => tab.id === KB_TAB)?.dirty).toBe(true)
    })

    it('保存还没返回时切走再切回，再按 Ctrl S 不重复保存', async () => {
      let finishSave: (value: unknown) => void = () => {}
      const plain = invoke.getMockImplementation()!
      invoke.mockImplementation((channel: string, ...args: unknown[]) => channel === 'kb:save-document-copy'
        ? new Promise(resolve => { finishSave = resolve })
        : plain(channel, ...args))
      function WithShell() {
        useStageShortcuts({ library: false, focus: false, mac: false })
        return <StageWorkspace library={false} focus={false} />
      }
      await act(async () => root!.render(<WithShell />))
      await editStation()
      const ctrlS = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))
      await act(async () => ctrlS())
      await act(async () => useEditorStore.getState().setActiveTab(`version-history:${encodeURIComponent(session.projectPath)}`))
      await act(async () => useEditorStore.getState().setActiveTab(KB_TAB))
      await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(`${copies.station}站台已封闭。`))
      await act(async () => ctrlS())
      await act(async () => finishSave({ success: true }))
      expect(invoke.mock.calls.filter(([channel]) => channel === 'kb:save-document-copy')).toHaveLength(1)
    })

    it('更新检索还没返回时切走再切回，按钮仍禁用、不重复发起；返回后恢复', async () => {
      let finishReindex: (value: unknown) => void = () => {}
      let indexStatus = 'stale'
      const plain = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
        if (channel === 'kb:reindex-document-copy') return new Promise(resolve => { finishReindex = resolve })
        const result = await plain(channel, ...args)
        return channel === 'kb:read-document-copy' ? { ...(result as object), indexStatus } : result
      })
      const reindexes = () => invoke.mock.calls.filter(([channel]) => channel === 'kb:reindex-document-copy')
      await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
      await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
      await click(/车站档案/)
      await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(copies.station))
      await click('更新检索')
      await act(async () => useEditorStore.getState().setActiveTab(`version-history:${encodeURIComponent(session.projectPath)}`))
      await act(async () => useEditorStore.getState().setActiveTab(KB_TAB))
      await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(copies.station))
      await act(async () => new Promise(resolve => setTimeout(resolve, 50)))
      expect(button('更新检索')?.disabled).toBe(true)
      await act(async () => button('更新检索')!.click())
      expect(reindexes()).toHaveLength(1)
      indexStatus = 'current'
      await act(async () => finishReindex({ success: true, docId: 'station', chunkCount: 3 }))
      await vi.waitFor(() => expect(button('更新检索')).toBeUndefined())
      expect(document.querySelector('textarea')?.disabled).toBe(false)
      expect(document.querySelector('[aria-current="true"]')?.textContent).toContain('车站档案')
      expect(document.querySelector('textarea')?.value).toBe(copies.station)
      expect(reindexes()).toHaveLength(1)
    })

    it('同一次打开里作品数据换成新对象（后台运行写回设定），修改还在', async () => {
      await renderPage()
      await click(/车站档案/)
      await type(await editorArea(), `${copies.station}站台已封闭。`)
      await act(async () => useProjectStore.setState({ currentProject: project({ novelConfig: { topic: '后台写回' } }) }))
      await act(async () => { await Promise.resolve() })
      expect(document.querySelector('textarea')?.value).toBe(`${copies.station}站台已封闭。`)
      expect(reads()).toEqual(['station'])
    })
  })

  it('先点的资料读得慢，后点的资料不会被它盖掉', async () => {
    let releaseStation: () => void = () => {}
    const plain = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'kb:read-document-copy' && args[0] === 'station') await new Promise<void>(resolve => { releaseStation = resolve })
      return plain(channel, ...args)
    })
    await renderPage()
    await click(/车站档案/)
    await click(/林舟人物小传/)
    await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(copies.people))
    await act(async () => { releaseStation(); await Promise.resolve() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(document.querySelector('textarea')?.value).toBe(copies.people)
    expect(document.querySelector('[aria-current="true"]')?.textContent).toContain('林舟人物小传')
  })

  it('没有修改时直接切换，不弹确认', async () => {
    await renderPage()
    await click(/车站档案/)
    await vi.waitFor(() => expect(document.querySelector('textarea')).toBeTruthy())
    await click(/林舟人物小传/)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(copies.people))
  })

  it('清空知识库先危险确认，确认后才清空', async () => {
    await renderPage()
    await click('清空知识库…')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('kb:clear-all')
    await click('清空知识库')
    await vi.waitFor(() => expect(invoke.mock.calls.map(([channel]) => channel)).toContain('kb:clear-all'))
  })

  it.each([
    ['zh-CN', '清空知识库…', '清空知识库', '项目已切换或重新打开', '清空知识库失败'],
    ['en-US', 'Clear knowledge base…', 'Clear knowledge base', 'The project was switched or reopened', 'Could not clear the knowledge base.'],
  ] as const)('%s 界面：清空被主进程拒绝时，登记的码显示说明，未登记的原文保留，没有原因时用兜底', async (locale, open, confirmLabel, stale, fallback) => {
    useLocaleStore.setState({ locale })
    const error = vi.spyOn(toast, 'error').mockImplementation(() => undefined)
    const base = invoke.getMockImplementation()!
    let reason: string | undefined
    invoke.mockImplementation(async (channel, ...args) => channel === 'kb:clear-all' ? { success: false, error: reason } : base(channel, ...args))
    await act(async () => root!.render(<StageKnowledge tabId={KB_TAB} />))
    await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
    for (const [raw, shown] of [
      ['PROJECT_SESSION_STALE', expect.stringContaining(stale)],
      ['SOMETHING_NEW_FROM_MAIN', expect.stringContaining('SOMETHING_NEW_FROM_MAIN')],
      [undefined, fallback],
    ] as const) {
      reason = raw
      error.mockClear()
      await click(open)
      await click(confirmLabel)
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(shown))
    }
  })

  it('查找之后清空知识库，或查找出错：不说「没有找到相关的资料」', async () => {
    vi.spyOn(toast, 'error').mockImplementation(() => undefined)
    await renderPage()
    await type(document.querySelector<HTMLInputElement>('form[role="search"] input')!, '三号站台')
    await act(async () => document.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit())
    await vi.waitFor(() => expect(document.body.textContent).toContain('找到 2 条'))
    await click('清空知识库…')
    await click('清空知识库')
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('找到 2 条'))
    expect(document.body.textContent).not.toContain('没有找到相关的资料。')

    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'kb:search' ? Promise.reject(new Error('检索服务不可用')) : base(channel, ...args))
    await act(async () => document.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit())
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(document.body.textContent).not.toContain('没有找到相关的资料。')
  })

  it('读资料的项目副本失败：提示后不停在正在读取，再点同一份会重读', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => undefined)
    const base = invoke.getMockImplementation()!
    let failing = true
    invoke.mockImplementation(async (channel, ...args) => channel === 'kb:read-document-copy' && failing ? Promise.reject(new Error('磁盘忙')) : base(channel, ...args))
    await renderPage()
    await click(/车站档案/)
    await vi.waitFor(() => expect(error).toHaveBeenCalled())
    expect(document.body.textContent).not.toContain('正在读取…')
    failing = false
    await click(/车站档案/)
    await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="项目副本内容"]')?.value).toBe(copies.station))
  })

  it('设置里保存或删除检索模型后，后台挂着的知识库页随之重新检查索引', async () => {
    await renderPage()
    await vi.waitFor(() => expect(document.body.textContent).toContain('有 4 段资料还不能按意思查找'))
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'kb:get-vector-rebuild-status'
      ? { embeddingConfigured: false, canRebuild: false, totalChunks: 9, vectorlessCount: 9, activeVectorDimension: 0 }
      : base(channel, ...args))
    await act(async () => useLLMStore.setState({ models: [], defaultEmbeddingModelId: null }))
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('还不能按意思查找'))
  })

  it('检索模型连改两次、两次索引检查乱序返回：先改的那次晚到，不把过时的提示写回来', async () => {
    await renderPage()
    await vi.waitFor(() => expect(document.body.textContent).toContain('有 4 段资料还不能按意思查找'))
    const base = invoke.getMockImplementation()!
    const answers = [
      { embeddingConfigured: true, canRebuild: true, totalChunks: 9, vectorlessCount: 2, activeVectorDimension: 0 },
      { embeddingConfigured: false, canRebuild: false, totalChunks: 9, vectorlessCount: 9, activeVectorDimension: 0 },
    ]
    const releases: (() => void)[] = []
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel !== 'kb:get-vector-rebuild-status') return base(channel, ...args)
      const answer = answers[releases.length]
      await new Promise<void>(resolve => releases.push(resolve))
      return answer
    })
    await act(async () => useLLMStore.setState({ models: [] }))
    await act(async () => useLLMStore.setState({ models: [] }))
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    await act(async () => releases[1]())
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('还不能按意思查找'))
    await act(async () => releases[0]())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(document.body.textContent).not.toContain('有 2 段资料还不能按意思查找')
  })

  it('1280 宽窗口开着运行侧页时（内容区约 623px）资料来源分段不折行', async () => {
    host!.style.width = '623px'
    await renderPage()
    const items = [...document.querySelectorAll<HTMLButtonElement>('.stage-kb-docs .pi-seg-item')]
    expect(items.map(item => item.textContent)).toEqual(['我导入的 3', '定稿章节 1'])
    for (const item of items) expect(item.scrollHeight, item.textContent ?? '').toBeLessThanOrEqual(item.clientHeight)
    expect(items[1].getBoundingClientRect().top, '两项排在同一行').toBe(items[0].getBoundingClientRect().top)
  })

  for (const locale of ['zh-CN', 'en-US'] as Locale[]) {
    it(`${locale} 下同样宽度、计数到四位数时资料栏里的按钮与分段都不伸出各自的框，文案与计数不被截断`, async () => {
      useLocaleStore.setState({ locale })
      document.documentElement.lang = locale
      host!.style.width = '623px'
      const plain = invoke.getMockImplementation()!
      const contentBox = (element: HTMLElement) => {
        const box = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          left: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
          right: box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
        }
      }
      for (const [imported, chapters] of [[3, 1], [30, 1200]]) {
        if (imported !== 3) invoke.mockImplementation(async (channel, ...args) => channel === 'kb:list-documents' ? [
          ...Array.from({ length: imported }, (_, index) => ({ id: `doc-${index}`, fileName: `资料${index}.md`, importedAt: '', chunkCount: 1, filePath: `knowledge-copy:doc-${index}` })),
          ...Array.from({ length: chapters }, (_, index) => ({ id: `ch-${index}`, fileName: `第${index + 1}章.txt`, importedAt: '', chunkCount: 1, filePath: `knowledge-copy:ch-${index}`, finalizedChapter: index + 1 })),
        ] : plain(channel, ...args))
        const labels = locale === 'zh-CN' ? [`我导入的 ${imported}`, `定稿章节 ${chapters}`] : [`Imported ${imported}`, `Final chapters ${chapters}`]
        await act(async () => root!.render(<StageKnowledge key={imported} tabId={KB_TAB} />))
        await vi.waitFor(() => expect(button(new RegExp(`^${labels[0]}$`))).toBeTruthy())
        const column = document.querySelector<HTMLElement>('.stage-kb-docs')!
        const items = [...column.querySelectorAll<HTMLButtonElement>('.pi-seg-item')]
        expect(items.map(item => item.textContent)).toEqual(labels)
        for (const item of items) expect(item.scrollHeight, `${item.textContent} 折行`).toBeLessThanOrEqual(item.clientHeight)
        const buttons = [...column.querySelectorAll<HTMLButtonElement>('button')]
        expect(buttons.map(item => item.textContent)).toEqual(expect.arrayContaining([...labels, ...(locale === 'zh-CN' ? ['导入创作资料', '清空知识库…'] : ['Import planning material', 'Clear knowledge base…'])]))
        for (const item of buttons) {
          const name = `${item.textContent || item.getAttribute('aria-label')}（${imported}/${chapters}）`
          expect(item.scrollWidth, `${name} 的文字伸出按钮`).toBeLessThanOrEqual(item.clientWidth)
          const rect = item.getBoundingClientRect()
          const frame = contentBox(item.parentElement!)
          expect(rect.left, `${name} 伸出左边`).toBeGreaterThanOrEqual(frame.left - 0.5)
          expect(rect.right, `${name} 伸出右边`).toBeLessThanOrEqual(frame.right + 0.5)
        }
        expect(column.scrollWidth, `资料栏横向溢出（${imported}/${chapters}）`).toBeLessThanOrEqual(column.clientWidth)
      }
    })
  }

  it('索引状态读取失败后再读成功：失败提示消失', async () => {
    const plain = invoke.getMockImplementation()!
    let statusFails = true
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'kb:get-vector-rebuild-status' && statusFails) throw new Error('索引状态暂时读不出来')
      return plain(channel, ...args)
    })
    await renderPage()
    await vi.waitFor(() => expect(document.body.textContent).toContain('读取知识库失败'))
    statusFails = false
    await click('刷新资料')
    await vi.waitFor(() => expect(document.body.textContent).toContain('有 4 段资料还不能按意思查找'))
    expect(document.body.textContent).not.toContain('读取知识库失败')
  })

  it('打开知识库页只读一次索引状态；点「刷新资料」再读一次', async () => {
    const statusReads = () => invoke.mock.calls.filter(([channel]) => channel === 'kb:get-vector-rebuild-status').length
    await renderPage()
    await vi.waitFor(() => expect(document.body.textContent).toContain('有 4 段资料还不能按意思查找'))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(statusReads()).toBe(1)
    await click('刷新资料')
    await vi.waitFor(() => expect(statusReads()).toBe(2))
  })

  it('知识库页没有重建索引；它在设置的检索模型页里', async () => {
    await renderPage()
    expect(button(/重建/)).toBeUndefined()
    expect(document.body.textContent).toContain('有 4 段资料还不能按意思查找')
    await click('去设置补全')
    expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'embedding' })

    await act(async () => root!.render(<KnowledgeIndexSection />))
    await vi.waitFor(() => expect(button(/检查并重建/)).toBeTruthy())
    await click(/检查并重建/)
    await vi.waitFor(() => expect(invoke.mock.calls.map(([channel]) => channel)).toContain('kb:backfill-vectors'))
  })
})
