import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import type { ProjectData } from '../../../../shared/ipc-channels'
import type { NarrativeThreadView } from '../../../../shared/narrative-thread'
import type { PlotTreeSnapshot } from '../../../../shared/plot-tree'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import StagePlot from '../StagePlot'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/night-train', leaseId: '本次打开' }
const REVISION = 'a'.repeat(64)

function snapshotStore<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useLocaleStore, useLLMStore].map(store => snapshotStore(store as StoreApi<unknown>))

const tree: PlotTreeSnapshot = {
  version: 1, generatedAt: '2026-10-12T11:40:00.000Z', writingLanguage: 'zh-CN', sourceRevision: REVISION,
  tracks: [
    { id: 'main', title: '末班车之谜', role: 'main', startChapter: 1, endChapter: 3, summary: '', events: [
      { status: 'occurred', chapterNumber: 1, summary: '林舟收到一封没有署名的灰色信', sources: [{ type: 'finalized-chapter', draftId: 7, chapterNumber: 1 }] },
      { status: 'planned', chapterNumber: 3, summary: '雨夜登上本该停运的末班车', sources: [{ type: 'blueprint', chapterNumber: 3 }] },
    ] },
    { id: 'side', title: '母亲的过去', role: 'subplot', parentTrackId: 'main', startChapter: 2, endChapter: 3, summary: '', events: [
      { status: 'occurred', chapterNumber: 2, summary: '母亲出走前拍下的最后一张照片', sources: [{ type: 'finalized-chapter', draftId: 8, chapterNumber: 2 }] },
    ] },
  ],
}

let plotSnapshot: PlotTreeSnapshot | null
let threads: NarrativeThreadView[]
let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

function thread(): NarrativeThreadView {
  return { id: 5, title: '灰色的信是谁寄的', type: '主线', targetStartChapter: 1, targetEndChapter: 9, authorIntent: '寄信人是母亲',
    status: 'planned', dormantChapters: 0, overdue: false, events: [], createdAt: '', updatedAt: '' }
}

beforeEach(() => {
  plotSnapshot = tree
  threads = [thread()]
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'generation:list') return []
    if (channel === 'db:plot-tree-read') return {
      writingLanguage: 'zh-CN', synopsis: { content: '' },
      blueprints: [1, 2, 3].map(chapterNumber => ({ chapterNumber, title: ['灰色的信', '母亲的旧照片', '雨夜车站'][chapterNumber - 1], purpose: '', keyEvents: '' })),
      finalizedChapters: [{ draftId: 7, chapterNumber: 1, title: '灰色的信', summary: '' }, { draftId: 8, chapterNumber: 2, title: '母亲的旧照片', summary: '' }],
      narrativeThreads: [], sourceRevision: REVISION, snapshot: plotSnapshot,
    }
    if (channel === 'db:plot-tree-clear') { plotSnapshot = null; return { success: true } }
    if (channel === 'db:narrative-thread-list') return threads
    if (channel === 'db:draft-list-all') return [{ id: 7, chapterNumber: 1, version: 1, status: 'finalized' }, { id: 8, chapterNumber: 2, version: 1, status: 'finalized' }]
    if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 1, title: '灰色的信' }]
    if (channel === 'db:narrative-thread-plan-delete') { threads = threads.filter(item => item.id !== args[0]); return { success: true } }
    if (channel === 'db:narrative-thread-event-confirm') {
      const input = args[0] as { planId: number; draftId: number; type: 'planted'; evidence: string; reason: string }
      if (input.evidence === '定稿里没有这句') {
        // 可写的 db 通道由主进程包装层把异常折成 { success: false, error: String(error) }。
        return { success: false, error: 'Error: NARRATIVE_THREAD_EVIDENCE_NOT_IN_SOURCE' }
      }
      threads = threads.map(item => item.id === input.planId
        ? { ...item, status: 'planted', events: [...item.events, { id: 1, planId: input.planId, draftId: input.draftId, type: input.type, evidence: input.evidence, reason: input.reason, chapterNumber: 1, chapterTitle: '灰色的信', createdAt: '' }] }
        : item)
      return { success: true }
    }
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车', novelConfig: { totalChapters: 24 } } as unknown as ProjectData })
  useLLMStore.setState({ loaded: true, models: [{ id: 'm1', name: '夹具模型', modelName: 'fixture', purposes: ['generation'] }] as never, defaultModelId: 'm1' })
  setActiveProjectSessionContext(session)
  useLocaleStore.setState({ locale: 'zh-CN' })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 800px; display: flex'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

const button = (name: string | RegExp) => [...document.querySelectorAll('button')]
  .find(candidate => typeof name === 'string'
    ? candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name
    : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = await vi.waitFor(() => {
    const found = button(name)
    expect(found, String(name)).toBeTruthy()
    return found!
  })
  await act(async () => target.click())
}
const called = (channel: string) => invoke.mock.calls.filter(([name]) => name === channel)

async function render(initialView: 'plot-tree' | 'plans') {
  await act(async () => root!.render(<StagePlot projectKey={session.projectPath} initialView={initialView} />))
}

describe('剧情与伏笔', () => {
  it('剧情树分主线与支线两轨，写明它是只读快照、不参与写作', async () => {
    await render('plot-tree')
    await vi.waitFor(() => expect(document.querySelector('table[aria-label="剧情树"]')).toBeTruthy())
    const lanes = [...document.querySelectorAll('tbody th')].map(node => node.textContent)
    expect(lanes).toEqual(['主线末班车之谜', '支线母亲的过去'])
    expect(document.body.textContent).toContain('不参与写作')
    await click(/母亲出走前拍下的最后一张照片/)
    expect(document.querySelector('[aria-label="事件详情"]')?.textContent).toContain('支线 · 第 2 章 · 已定稿发生')
    expect(button(/打开来源：第 2 章定稿/)).toBeTruthy()
  })

  it('内容区窄于 1040px 时页边距收窄，宽时照常；整理记录的收起按钮靠在标题行右端', async () => {
    host!.style.width = '960px'
    await render('plot-tree')
    await vi.waitFor(() => expect(document.querySelector('table[aria-label="剧情树"]')).toBeTruthy())
    const page = () => getComputedStyle(document.querySelector('.stage-plot')!)
    expect([page().paddingLeft, page().paddingRight]).toEqual(['24px', '24px'])
    await act(async () => { host!.style.width = '1200px' })
    expect([page().paddingLeft, page().paddingRight]).toEqual(['48px', '48px'])

    await click('剧情树的更多操作')
    await click('查看整理记录')
    const head = document.querySelector('.stage-plot-records-head')!.getBoundingClientRect()
    const hide = button('收起整理记录')!.getBoundingClientRect()
    expect(Math.abs(hide.right - head.right)).toBeLessThanOrEqual(1)
  })

  it('清除剧情树先危险确认：取消不清，确认才清', async () => {
    await render('plot-tree')
    await vi.waitFor(() => expect(document.querySelector('table[aria-label="剧情树"]')).toBeTruthy())
    await click('剧情树的更多操作')
    await click('清除剧情树…')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('清除剧情树？')
    expect(dialog.textContent).toContain('蓝图、定稿和伏笔线索都不受影响')
    expect(called('db:plot-tree-clear')).toHaveLength(0)

    await click('取消')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(called('db:plot-tree-clear')).toHaveLength(0)
    expect(document.querySelector('table[aria-label="剧情树"]')).toBeTruthy()

    await click('剧情树的更多操作')
    await click('清除剧情树…')
    await click('清除剧情树')
    await vi.waitFor(() => expect(called('db:plot-tree-clear')).toHaveLength(1))
    await vi.waitFor(() => expect(document.querySelector('table[aria-label="剧情树"]')).toBeNull())
    expect(document.body.textContent).toContain('还没有剧情树')
  })

  it('英文界面里线索沉寂一章写 Quiet for 1 chapter', async () => {
    threads = [{ ...thread(), dormantChapters: 1 }]
    const current = useProjectStore.getState().currentProject!
    useProjectStore.setState({ currentProject: { ...current, novelConfig: { ...current.novelConfig, narrativeThreadDormantChapterThreshold: 1 } } })
    useLocaleStore.setState({ locale: 'en-US' })
    await render('plans')
    await vi.waitFor(() => expect(document.querySelector('.stage-thread-sub[data-tone="warn"]')?.textContent).toBe('Quiet for 1 chapter'))
  })

  it('删除线索计划先危险确认：取消不删，确认才删', async () => {
    await render('plans')
    await vi.waitFor(() => expect(document.body.textContent).toContain('灰色的信是谁寄的'))
    await click('「灰色的信是谁寄的」的更多操作')
    await click('删除线索…')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('删除这条线索？')
    expect(dialog.textContent).toContain('会删除线索「灰色的信是谁寄的」')
    expect(called('db:narrative-thread-plan-delete')).toHaveLength(0)

    await click('取消')
    expect(called('db:narrative-thread-plan-delete')).toHaveLength(0)

    await click('「灰色的信是谁寄的」的更多操作')
    await click('删除线索…')
    await click('删除线索')
    await vi.waitFor(() => expect(called('db:narrative-thread-plan-delete').map(([, id]) => id)).toEqual([5]))
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('灰色的信是谁寄的'))
  })

  it('新建线索：填齐名称、类型与打算才能保存，保存后对话框关闭', async () => {
    const plain = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'db:narrative-thread-plan-create'
      ? { success: true, id: 6 }
      : plain(channel, ...args))
    await render('plans')
    await vi.waitFor(() => expect(document.body.textContent).toContain('灰色的信是谁寄的'))
    await click('新建线索')
    const dialog = () => document.querySelector('[role="dialog"]')
    expect(dialog()?.textContent).toContain('新建线索')
    const save = () => [...dialog()!.querySelectorAll('button')].find(node => node.textContent === '保存线索')!
    expect(save().disabled).toBe(true)
    const fill = async (label: string, value: string) => {
      const field = [...dialog()!.querySelectorAll('label')].find(node => node.textContent?.startsWith(label))!.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
      await act(async () => { setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    await fill('名称', '末班车为何停运')
    await fill('类型', '主线')
    await fill('你的打算', '停运公告是伪造的')
    expect(save().disabled).toBe(false)
    await act(async () => save().click())
    await vi.waitFor(() => expect(called('db:narrative-thread-plan-create')).toHaveLength(1))
    expect(called('db:narrative-thread-plan-create')[0][1]).toMatchObject({ title: '末班车为何停运', type: '主线', authorIntent: '停运公告是伪造的' })
    await vi.waitFor(() => expect(dialog()).toBeNull())
  })

  it('让 AI 识别定稿事件时沿用作者选的模型，不退回默认模型', async () => {
    useLLMStore.setState({ models: [
      { id: 'm1', name: '夹具模型', modelName: 'fixture', purposes: ['generation'] },
      { id: 'm2', name: '长文模型', modelName: 'fixture-long', purposes: ['generation'] },
    ] as never })
    await render('plans')
    await vi.waitFor(() => expect(document.body.textContent).toContain('灰色的信是谁寄的'))
    const modelSelect = () => document.querySelector<HTMLSelectElement>('select[aria-label="本次识别用的模型"]')!
    await act(async () => {
      modelSelect().value = 'm2'
      modelSelect().dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click('「灰色的信是谁寄的」的更多操作')
    await click('记录定稿里的变化')
    await click('让 AI 识别')
    await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'graph-generation:begin')).toBe(true))
    const generationCalls = invoke.mock.calls.filter(([channel]) => channel === 'graph-generation:begin')
    expect(JSON.stringify(generationCalls)).toContain('"m2"')
    expect(modelSelect().value).toBe('m2')
  })

  describe('「规划」环节的模型', () => {
    const TWO_MODELS = [
      { id: 'm1', name: '夹具模型', modelName: 'fixture', purposes: ['generation'] },
      { id: 'm2', name: '长文模型', modelName: 'fixture-long', purposes: ['generation'] },
    ]
    const select = (label: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
    const begunWith = () => invoke.mock.calls
      .filter(([channel]) => channel === 'graph-generation:begin')
      .map(([, request]) => (request as { modelId: string }).modelId)

    async function preselected(view: 'plot-tree' | 'plans', label: string) {
      await render(view)
      return vi.waitFor(() => {
        const found = select(label)
        expect(found?.value).toBeTruthy()
        return found!.value
      })
    }

    it('另有指定时，剧情树预选它并按它整理', async () => {
      useLLMStore.setState({ models: TWO_MODELS as never, stageModelIds: { planning: 'm2' } })
      expect(await preselected('plot-tree', '本次整理用的模型')).toBe('m2')
      await click('刷新剧情树')
      await vi.waitFor(() => expect(begunWith()).toEqual(['m2']))
    })

    it('另有指定时，让 AI 识别定稿事件预选它并按它识别', async () => {
      useLLMStore.setState({ models: TWO_MODELS as never, stageModelIds: { planning: 'm2' } })
      expect(await preselected('plans', '本次识别用的模型')).toBe('m2')
      await click('「灰色的信是谁寄的」的更多操作')
      await click('记录定稿里的变化')
      await click('让 AI 识别')
      await vi.waitFor(() => expect(begunWith()).toEqual(['m2']))
    })

    it.each([
      ['用默认模型', 'm1', 'm1'],
      ['默认模型不可用时用第一个生成模型', null, 'm1'],
      ['默认模型是第二个时用它', 'm2', 'm2'],
    ])('没有另外指定时，剧情树与伏笔识别照旧%s', async (_label, defaultModelId, expected) => {
      useLLMStore.setState({ models: TWO_MODELS as never, defaultModelId })
      expect(await preselected('plot-tree', '本次整理用的模型')).toBe(expected)
      await act(async () => root!.unmount())
      root = createRoot(host!)
      expect(await preselected('plans', '本次识别用的模型')).toBe(expected)
    })
  })

  it('作品重新打开后，上一次打开时迟到的线索列表不会显示出来', async () => {
    let releaseOld: () => void = () => {}
    const plain = invoke.getMockImplementation()!
    let listCalls = 0
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:narrative-thread-list') {
        listCalls++
        if (listCalls === 1) {
          const stale = threads
          await new Promise<void>(resolve => { releaseOld = resolve })
          return stale
        }
        return []
      }
      return plain(channel, ...args)
    })
    await render('plans')
    await vi.waitFor(() => expect(listCalls).toBe(1))
    const reopened = { ...session, leaseId: '再次打开' }
    await act(async () => {
      useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: reopened.leaseId, name: '雨夜列车', novelConfig: { totalChapters: 24 } } as unknown as ProjectData })
      setActiveProjectSessionContext(reopened)
    })
    await vi.waitFor(() => expect(listCalls).toBe(2))
    await act(async () => { releaseOld(); await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(document.body.textContent).not.toContain('灰色的信是谁寄的')
  })

  it('确认定稿事件后线索路线推进：埋设一站变成已发生', async () => {
    await render('plans')
    await vi.waitFor(() => expect(document.body.textContent).toContain('灰色的信是谁寄的'))
    const route = () => [...document.querySelectorAll('[aria-label="线索路线"] li')].map(node => node.getAttribute('data-state'))
    expect(route()).toEqual(['todo', 'none', 'todo'])

    await click('「灰色的信是谁寄的」的更多操作')
    await click('记录定稿里的变化')
    const setValue = async (label: string, value: string) => {
      const input = [...document.querySelectorAll('label')].find(node => node.textContent?.startsWith(label))!.querySelector('input')!
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    await setValue('定稿里的原文', '信封上没有邮戳')
    await setValue('理由', '寄信人就在附近')
    await click('记入线索')
    await vi.waitFor(() => expect(route()).toEqual(['done', 'none', 'todo']))
    expect(called('db:narrative-thread-event-confirm')[0][1]).toMatchObject({ planId: 5, draftId: 7, type: 'planted', evidence: '信封上没有邮戳' })
  })

  it.each([
    ['zh-CN', '「灰色的信是谁寄的」的更多操作', '记录定稿里的变化', '定稿里的原文', '理由', '记入线索', '请粘贴所选定稿章节中实际出现的短原文。'],
    ['en-US', 'More actions for “灰色的信是谁寄的”', 'Record a change from a final', 'Quote from the final', 'Why', 'Record', 'Paste a short excerpt that appears in the selected finalized chapter.'],
  ] as const)('%s：主进程拒绝不在定稿正文里的短证据时，在表单里按界面语言说明', async (locale, more, open, quoteLabel, reasonLabel, record, hint) => {
    useLocaleStore.setState({ locale })
    await render('plans')
    await vi.waitFor(() => expect(document.body.textContent).toContain('灰色的信是谁寄的'))
    await click(more)
    await click(open)
    const setValue = async (label: string, value: string) => {
      const input = [...document.querySelectorAll('label')].find(node => node.textContent?.startsWith(label))!.querySelector('input')!
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    await setValue(quoteLabel, '定稿里没有这句')
    await setValue(reasonLabel, '寄信人就在附近')
    await click(record)
    await vi.waitFor(() => expect(document.querySelector('.stage-plot-error[role="alert"]')?.textContent).toBe(hint))
    expect(document.body.textContent).not.toContain('NARRATIVE_THREAD_EVIDENCE_NOT_IN_SOURCE')
    const quote = [...document.querySelectorAll('label')].find(node => node.textContent?.startsWith(quoteLabel))!.querySelector('input')!
    expect(quote.value).toBe('定稿里没有这句')
  })
})
