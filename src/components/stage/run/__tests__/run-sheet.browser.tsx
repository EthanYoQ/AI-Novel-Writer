/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page, userEvent } from 'vitest/browser'
import type { StoreApi } from 'zustand'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import type { Locale } from '../../../../i18n/types'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import type { RecoveryCandidate } from '../../../../shared/recovery-candidate'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore, type StageSheet } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore, type WorkflowRun } from '../../../../stores/workflow-store'
import RunSheet from '../RunSheet'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }
const CHAT_WORDS = /Agent|助手|聊天|对话|assistant|chat/i

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useWorkflowStore, useStageStore, useLocaleStore, useLayoutStore, useEditorStore].map(store => snapshot(store as StoreApi<unknown>))

let root: Root | undefined
let host: HTMLDivElement | undefined
let candidates: RecoveryCandidate[]
let batches: unknown[]
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

function run(id: string, status: WorkflowRun['status'], extra: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id, projectPath: session.projectPath, projectSession: session, status, title: `第 ${id} 章 · 写稿`, currentStepIndex: 0,
    uiLocale: 'zh-CN', writingLanguage: 'zh-CN', type: 'chapter_creation', createdAt: '2026-10-12T08:10:00.000Z',
    steps: [{ id: `${id}-write`, name: '写稿', description: '', status: status === 'completed' ? 'completed' : 'running', progress: 40, logs: [],
      result: '林岚沿着旧港的石阶往下走。' }],
    ...extra,
  } as WorkflowRun
}

function candidate(): RecoveryCandidate {
  return { candidateId: '候选甲', runId: '旧运行', stepId: '写稿', projectId: session.projectId, chapterNumber: 3, chapterTitle: '雾钟',
    sourceHash: 'h', visibleText: '潮水退去，钟声早了一刻。', contentHash: 'c', failureCode: 'timeout', failureReason: '超时',
    status: 'pending', replacesCandidateId: null, sourceCurrent: true, createdAt: '2026-10-12T07:00:00.000Z', resolvedAt: null } as RecoveryCandidate
}

async function render(sheet: StageSheet = { kind: 'run', tab: 'active' }) {
  await act(async () => useStageStore.setState({ sheet }))
  await act(async () => root!.render(<Sheet />))
}

function Sheet() {
  const sheet = useStageStore(s => s.sheet)
  return sheet?.kind === 'run' ? <RunSheet sheet={sheet} /> : null
}

const button = (name: string | RegExp) => [...host!.querySelectorAll('button')]
  .find(candidate => typeof name === 'string' ? candidate.textContent === name || candidate.getAttribute('aria-label') === name : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = button(name)
  expect(target, String(name)).toBeTruthy()
  await act(async () => target!.click())
}
const selectedTab = () => host!.querySelector('[role="tab"][aria-selected="true"]')?.textContent

beforeEach(() => {
  candidates = []
  batches = []
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:recovery-candidate-list') return candidates
    if (channel === 'generation:list-batches') return batches
    if (channel === 'generation:list' || channel === 'skills:list-user') return []
    if (channel === 'fs:check-exists') return false
    if (channel === 'db:recovery-candidate-resolve') return { success: true }
    if (channel === 'db:get-llm-stats') return { totalCalls: 3, successfulCalls: 2, failedCalls: 1, knownUsageCalls: 3, totalTokens: 21400, totalPromptTokens: 15200, totalCompletionTokens: 6200 }
    if (channel === 'db:get-llm-history') return [{ id: 1, modelName: '夹具模型', purpose: 'chapter-draft', promptTokens: 8420, completionTokens: 1236, totalTokens: 9656,
      durationMs: 41000, success: true, createdAt: '2026-10-12T08:31:00.000Z' }]
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '灯塔', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, globalLogs: [] })
  useLocaleStore.setState({ locale: 'zh-CN' })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 640px; height: 800px; display: flex'
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

describe('运行侧页', () => {
  it('三个分页：进行中看运行，历史列出结束的运行并展开看步骤，诊断是宽版', async () => {
    useWorkflowStore.setState({ activeRuns: [run('4', 'running')], history: [run('3', 'completed', { completedAt: '2026-10-12T08:00:00.000Z' })] })
    await render()
    expect(selectedTab()).toBe('进行中')
    expect(host!.querySelector('article')?.textContent).toContain('第 4 章 · 写稿')
    expect(host!.querySelector('.run-output')?.textContent).toContain('林岚沿着旧港的石阶往下走。')

    await click('历史')
    expect(selectedTab()).toBe('历史')
    const row = button(/第 3 章 · 写稿/)!
    expect(row.getAttribute('aria-expanded')).toBe('false')
    await act(async () => row.click())
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(host!.querySelector('[aria-label="步骤"]')?.textContent).toContain('写稿')

    await click('诊断')
    expect(selectedTab()).toBe('诊断')
    expect(host!.querySelector('aside')!.classList.contains('pi-sheet--wide')).toBe(true)
    expect(host!.textContent).toContain('AI 调用记录')
    await vi.waitFor(() => expect(host!.querySelector('table')?.textContent).toContain('夹具模型'))
    expect(host!.querySelector('[aria-label="调用统计"]')?.textContent).toContain('1.5万')
    expect(button('复制安全诊断')).toBeTruthy()
    expect(host!.textContent).not.toMatch(/token/i)
  })

  it('要看的运行已结束时直接在历史里展开它', async () => {
    useWorkflowStore.setState({ history: [run('3', 'completed'), run('2', 'completed')] })
    await render({ kind: 'run', tab: 'active', runId: '3' })
    expect(selectedTab()).toBe('历史')
    expect(button(/第 3 章 · 写稿/)!.getAttribute('aria-expanded')).toBe('true')
    expect(button(/第 2 章 · 写稿/)!.getAttribute('aria-expanded')).toBe('false')
  })

  it('取消调用工作流的取消；正在取消时不再给取消按钮', async () => {
    const cancelWorkflow = vi.fn()
    useWorkflowStore.setState({ activeRuns: [run('4', 'running')], cancelWorkflow })
    await render()
    await click('取消「第 4 章 · 写稿」')
    expect(cancelWorkflow).toHaveBeenCalledWith('4')
    await act(async () => useWorkflowStore.setState({ activeRuns: [run('4', 'cancelling')] }))
    expect(button('取消「第 4 章 · 写稿」')).toBeUndefined()
    expect(host!.textContent).toContain('正在取消，等当前操作退出')
  })

  it('批量创作：运行中可暂停，请求暂停后说明本章写完后暂停，暂停后可继续', async () => {
    const pauseWorkflow = vi.fn()
    const resumeWorkflow = vi.fn()
    const batch = (status: WorkflowRun['status'], pauseRequested = false) => run('5', status, { type: 'batch_generate', title: '批量草稿待审 · 第 5 至 6 章', pauseRequested })
    useWorkflowStore.setState({ activeRuns: [batch('running')], pauseWorkflow, resumeWorkflow })
    await render()
    await click('暂停批量创作')
    expect(pauseWorkflow).toHaveBeenCalledWith('5')
    await act(async () => useWorkflowStore.setState({ activeRuns: [batch('running', true)] }))
    expect(button('暂停批量创作')).toBeUndefined()
    expect(host!.textContent).toContain('本章写完后暂停')
    await act(async () => useWorkflowStore.setState({ activeRuns: [batch('paused')] }))
    await click('继续批量创作')
    expect(resumeWorkflow).toHaveBeenCalledWith('5')
  })

  it('批量暂停时这一批只在进行中的运行卡片里出现，运行结束后才列为可恢复', async () => {
    batches = [{ batchId: '批次', range: { startChapter: 3, endChapter: 5 }, completedChapters: [{ chapterNumber: 3 }], nextChapterNumber: 4,
      sourceCurrent: true, rootHandle: { projectId: session.projectId, epoch: session.leaseId, rootActionId: '根', runId: '批量' } }]
    const paused = run('5', 'paused', { type: 'batch_generate', resourceKeys: ['chapter:3', 'chapter:4', 'chapter:5'] })
    useWorkflowStore.setState({ activeRuns: [paused] })
    await render()
    await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'generation:list-batches')).toBe(true))
    await act(async () => {})
    expect(button('继续批量创作')).toBeTruthy()
    expect(button('继续此批次')).toBeUndefined()
    expect(host!.querySelectorAll('article')).toHaveLength(1)

    await act(async () => useWorkflowStore.setState({ activeRuns: [], history: [{ ...paused, status: 'failed' }] }))
    await vi.waitFor(() => expect(button('继续此批次')).toBeTruthy())
    expect(host!.textContent).toContain('批量正文：已保存 1 章，下一章 4')
  })

  it('等你确认：显示下一步，确认后工作流继续到完成', async () => {
    const second = vi.fn(async () => '已写入')
    const pending = useWorkflowStore.getState().startWorkflow({ type: 'post_process', title: '提取角色', projectPath: session.projectPath, projectSession: session, steps: [
      { name: '读取正文', description: '', executor: async () => '候选' },
      { name: '写入角色卡', description: '', requiresConfirmation: true, executor: second },
    ] })
    await render()
    await vi.waitFor(() => expect(button('确认继续')).toBeTruthy())
    expect(host!.querySelector('article')?.textContent).toContain('等你确认')
    expect(host!.textContent).toContain('下一步：写入角色卡')
    expect(second).not.toHaveBeenCalled()
    await click('确认继续')
    await act(async () => { await pending })
    expect(second).toHaveBeenCalledOnce()
    expect(useWorkflowStore.getState().history[0]?.status).toBe('completed')
  })

  it('两次运行都等你确认时，侧页只有排在最前的那张卡给主按钮，它确认后主按钮交给下一张', async () => {
    const start = (title: string) => useWorkflowStore.getState().startWorkflow({ type: 'post_process', title, projectPath: session.projectPath, projectSession: session, steps: [
      { name: '读取正文', description: '', executor: async () => '候选' },
      { name: '写入角色卡', description: '', requiresConfirmation: true, executor: async () => '已写入' },
    ] })
    const first = start('提取角色甲')
    const second = start('提取角色乙')
    await render()
    await vi.waitFor(() => expect(host!.querySelectorAll('.run-confirm-button')).toHaveLength(2))
    const primaries = () => [...host!.querySelectorAll('.pi-btn--primary')].map(node => node.closest('article')?.querySelector('h3')?.textContent)
    expect(primaries()).toEqual(['提取角色甲'])
    await act(async () => (host!.querySelector('.pi-btn--primary') as HTMLButtonElement).click())
    await act(async () => { await first })
    await vi.waitFor(() => expect(primaries()).toEqual(['提取角色乙']))
    await act(async () => (host!.querySelector('.pi-btn--primary') as HTMLButtonElement).click())
    await act(async () => { await second })
  })

  it('恢复候选：复制；放弃要就地确认，保留不动磁盘，确认后候选消失', async () => {
    candidates = [candidate()]
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await render()
    await vi.waitFor(() => expect(host!.textContent).toContain('原始候选 · 第3章 雾钟'))
    await click('复制')
    expect(writeText).toHaveBeenCalledWith('潮水退去，钟声早了一刻。')

    await click('放弃…')
    const confirm = host!.querySelector('[role="group"]')!
    expect(confirm.textContent).toContain('放弃后这 10 字无法找回。')
    expect(document.activeElement?.textContent).toBe('保留')
    await click('保留')
    expect(host!.querySelector('[role="group"]')).toBeNull()
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:recovery-candidate-resolve')).toBe(false)

    await click('放弃…')
    await click('放弃')
    await vi.waitFor(() => expect(host!.textContent).not.toContain('原始候选 · 第3章 雾钟'))
    expect(invoke.mock.calls.find(([channel]) => channel === 'db:recovery-candidate-resolve')).toEqual(
      expect.arrayContaining(['db:recovery-candidate-resolve', '候选甲', 'discarded']))
  })

  it('恢复运行进行中：复制尾段仍可用且不清掉部分任务读取失败的提醒，恢复按钮不被锁住', async () => {
    const draft = { projectId: session.projectId, epoch: '旧会话', rootActionId: '单章根', runId: '单章' }
    const review = { ...draft, rootActionId: '审稿根', runId: '审稿' }
    batches = [{ batchId: '批次', range: { startChapter: 3, endChapter: 5 }, completedChapters: [{ chapterNumber: 3 }], nextChapterNumber: 4,
      sourceCurrent: true, rootHandle: { projectId: session.projectId, epoch: '旧会话', rootActionId: '批量根', runId: '批量' } }]
    const fallback = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      const handle = (args[0] as { handle?: { runId: string } } | undefined)?.handle
      if (channel === 'generation:list') return [
        { handle: draft, status: 'failed', artifacts: [], unsavedTails: [{ attemptId: '尾请求', artifactId: '尾片', durableRevision: 0, text: '尚未保存的潮声', failureCode: 'STORAGE_FAILED' }] },
        { handle: review, status: 'failed', artifacts: [] },
      ]
      if (channel === 'generation:read-context') return handle?.runId === review.runId
        ? { draftSave: { kind: 'absent' }, handle: review, operation: 'review-chapter' }
        : { draftSave: { kind: 'absent' }, handle: draft, operation: 'chapter-draft', chapterNumber: 1, modelId: '原模型', authorInputs: [], attemptedPurposes: ['chapter-draft'] }
      if (channel === 'review-revision:read-recovery') throw new Error('审稿记录读取失败')
      if (channel === 'generation:read-batch') return { batchId: '批次', nextChapterNumber: 4, modelId: '原模型', mode: 'review', targetUnits: 900, range: { startChapter: 3, endChapter: 5 } }
      return fallback(channel, ...args)
    })
    const startWorkflow = vi.fn(() => new Promise<string>(() => {}))
    useWorkflowStore.setState({ startWorkflow })
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await render()
    await vi.waitFor(() => expect(button('继续此批次')).toBeTruthy())
    await vi.waitFor(() => expect(host!.textContent).toContain('部分任务暂时无法读取'))

    await click('复制')
    expect(writeText).toHaveBeenCalledWith('尚未保存的潮声')
    await act(async () => {})
    expect(host!.textContent).toContain('部分任务暂时无法读取')

    await click('继续此批次')
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    await click('复制')
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(button('继续此批次')?.disabled).toBe(false)
  })

  it('审稿候选：卡片显示审稿结论与要点而不是原始 JSON，复制拿到原文', async () => {
    const reviewRun = { projectId: session.projectId, epoch: '旧会话', rootActionId: '审稿根', runId: '审稿' }
    const report = JSON.stringify({ summary: '时间线需要核对。', items: [
      { category: '连续性', severity: 'warning', description: '核对钟声提前一刻与潮位的关系。', quote: '昨夜的钟声比往常早了一刻' },
    ], goalReviews: [] })
    const fallback = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'generation:list') return [{ handle: reviewRun, status: 'completed', artifacts: [{ ...reviewRun, artifactId: '报告', attemptId: '报告-请求', text: report, status: 'completed' }] }]
      if (channel === 'generation:read-context') return { handle: reviewRun, operation: 'review-chapter' }
      if (channel === 'review-revision:read-recovery') return { handle: reviewRun, modelId: '原模型', sourceStatus: 'current', canResume: true,
        saved: { success: true, kind: 'review', id: 1 }, attemptedPurposes: ['review-chapter'], context: { operation: 'review-chapter', source: { chapterNumber: 3 } } }
      return fallback(channel, ...args)
    })
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await render()
    const card = await vi.waitFor(() => {
      const found = [...host!.querySelectorAll('article')].find(article => article.textContent?.includes('第3章审稿候选'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(card.textContent).toContain('时间线需要核对。')
    expect(card.textContent).toContain('核对钟声提前一刻与潮位的关系。')
    expect(card.textContent).not.toContain('"summary"')

    await click('复制')
    expect(writeText).toHaveBeenCalledWith(report)
  })

  it('来源变了以后，已原样写进正式大纲的一批不列为可恢复，只列没保存的那批', async () => {
    const outlineRun = (runId: string, from: number, to: number, inFormalOutline: boolean) => {
      const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: `${runId}根`, runId }
      return { handle, operation: 'architecture', draftSave: { kind: 'absent' },
        plotOutline: { range: { from, to }, cursor: { kind: 'complete' } },
        plotOutlineRecovery: { writeState: { kind: 'blocked', reason: 'source-changed' }, inFormalOutline, completeChapters: [], saved: null },
        planningContinuation: { state: 'source-changed' } }
    }
    const saved = outlineRun('第一批', 1, 5, true)
    const unsaved = outlineRun('第二批', 6, 6, false)
    const fallback = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'generation:list') return [saved, unsaved].map(item => ({ handle: item.handle, status: 'failed', artifacts: [] }))
      if (channel === 'generation:read-context') return (args[0] as { handle: { runId: string } }).handle.runId === '第一批' ? saved : unsaved
      return fallback(channel, ...args)
    })
    await render()
    await vi.waitFor(() => expect(host!.textContent).toContain('大纲恢复稿 · 第 6 章'))
    expect([...host!.querySelectorAll('article h3')].map(title => title.textContent)).toEqual(['大纲恢复稿 · 第 6 章'])
  })

  it('恢复候选：继续编辑或放弃的调用失败时显示错误', async () => {
    candidates = [candidate()]
    const fallback = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:recovery-candidate-update') throw new Error('候选写入失败')
      if (channel === 'db:recovery-candidate-resolve') throw new Error('候选放弃失败')
      return fallback(channel, ...args)
    })
    await render()
    await vi.waitFor(() => expect(host!.textContent).toContain('原始候选 · 第3章 雾钟'))
    await click('继续编辑')
    await vi.waitFor(() => expect(host!.querySelector('[role="alert"]')?.textContent).toBe('候选写入失败'))
    await click('放弃…')
    await click('放弃')
    await vi.waitFor(() => expect(host!.querySelector('[role="alert"]')?.textContent).toBe('候选放弃失败'))
    expect(host!.textContent).toContain('原始候选 · 第3章 雾钟')
  })

  it('恢复候选：继续编辑的结果回来前换了作品，不在新作品里打开旧候选', async () => {
    candidates = [candidate()]
    let finish!: (value: unknown) => void
    const fallback = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'db:recovery-candidate-update'
      ? new Promise(resolve => { finish = resolve })
      : fallback(channel, ...args))
    const openFile = vi.fn()
    useEditorStore.setState({ openFile })
    await render()
    await vi.waitFor(() => expect(host!.textContent).toContain('原始候选 · 第3章 雾钟'))
    await click('继续编辑')
    const other = { projectId: '另一部', projectPath: 'C:/novels/other', leaseId: '另一次打开' }
    await act(async () => {
      useProjectStore.setState({ currentProject: { id: other.projectId, path: other.projectPath, sessionLease: other.leaseId, name: '另一部', novelConfig: {} } as unknown as ProjectData })
      setActiveProjectSessionContext(other)
    })
    await act(async () => finish({ success: true, candidate: candidate() }))
    expect(openFile).not.toHaveBeenCalled()
  })

  it('诊断：一条调用记录的时间无法解析时显示短横，其余记录照常显示', async () => {
    const fallback = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'db:get-llm-history'
      ? [{ id: 1, modelName: '夹具模型', purpose: 'chapter-draft', promptTokens: 8420, completionTokens: 1236, totalTokens: 9656, durationMs: 41000, success: true, createdAt: '2026-10-12T08:31:00.000Z' },
        { id: 2, modelName: '坏时间模型', purpose: 'chapter-draft', promptTokens: 10, completionTokens: 5, totalTokens: 15, durationMs: 1000, success: false, createdAt: '不是时间' }]
      : fallback(channel, ...args))
    await render({ kind: 'run', tab: 'diagnostics' })
    await vi.waitFor(() => expect(host!.querySelectorAll('tbody tr')).toHaveLength(2))
    const [good, bad] = [...host!.querySelectorAll('tbody tr')].map(row => row.querySelector('td')!.textContent)
    expect(good).toMatch(/^\d{2}:\d{2}$/)
    expect(bad).toBe('—')
    expect(host!.querySelector('table')!.textContent).toContain('坏时间模型')
  })

  it('日志满 500 行之后新来的一行仍然自动滚到底', async () => {
    useWorkflowStore.setState({ globalLogs: Array.from({ length: 500 }, (_, index) => ({ time: '08:10:00', level: 'info' as const, message: `第 ${index + 1} 行` })) })
    await render({ kind: 'run', tab: 'diagnostics' })
    const log = host!.querySelector<HTMLOListElement>('.run-log')!
    await vi.waitFor(() => expect(log.scrollTop + log.clientHeight).toBeGreaterThanOrEqual(log.scrollHeight - 1))
    log.scrollTop = 0
    await act(async () => useWorkflowStore.getState().addLog('info', '第 501 行'))
    expect(useWorkflowStore.getState().globalLogs).toHaveLength(500)
    expect(log.scrollTop + log.clientHeight).toBeGreaterThanOrEqual(log.scrollHeight - 1)
  })

  it('清空日志要就地确认，写明行数', async () => {
    useWorkflowStore.setState({ globalLogs: [
      { time: '08:10:00', level: 'info', message: '开始' },
      { time: '08:10:05', level: 'error', message: '超时' },
    ] })
    await render({ kind: 'run', tab: 'diagnostics' })
    await click('清空日志…')
    expect(host!.querySelector('[role="group"]')?.textContent).toContain('清空后这 2 行日志无法找回。')
    await click('清空')
    expect(useWorkflowStore.getState().globalLogs).toEqual([])
  })

  it('清空日志选「保留」或按 Esc 后，焦点回到「清空日志…」按钮', async () => {
    useWorkflowStore.setState({ globalLogs: [{ time: '08:10:00', level: 'info', message: '开始' }] })
    await render({ kind: 'run', tab: 'diagnostics' })
    const trigger = page.getByRole('button', { name: '清空日志…' })
    const open = async () => {
      trigger.element().focus()
      await userEvent.keyboard('{Enter}')
      await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('保留'))
    }
    await open()
    await userEvent.keyboard('{Escape}')
    expect(document.activeElement).toBe(trigger.element())
    await open()
    await userEvent.click(page.getByRole('button', { name: '保留' }))
    expect(document.activeElement).toBe(trigger.element())
  })

  it('恢复候选「放弃…」的确认条选「保留」或按 Esc 后，焦点回到重新出现的「放弃…」按钮', async () => {
    candidates = [candidate()]
    await render()
    const discard = page.getByRole('button', { name: '放弃…' })
    await expect.element(discard).toBeVisible()
    await userEvent.click(discard)
    await userEvent.click(page.getByRole('button', { name: '保留' }))
    expect(document.activeElement?.textContent).toBe('放弃…')
    await userEvent.click(discard)
    await userEvent.keyboard('{Escape}')
    expect(document.activeElement?.textContent).toBe('放弃…')
  })
})

describe('运行侧页的说明文字', () => {
  it.each(['light', 'dark'] as const)('%s 主题步骤用时、待执行与跳过的步骤、日志时间都用 --ink-3，不用 --ink-4', async (theme) => {
    host!.dataset.theme = theme
    const ink = (name: string) => {
      const probe = document.createElement('span')
      probe.style.color = `var(${name})`
      host!.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }
    useWorkflowStore.setState({
      activeRuns: [run('4', 'running', { steps: [
        { id: 'a', name: '读设定', description: '', status: 'completed', progress: 100, logs: [], startedAt: '2026-10-12T08:10:00.000Z', completedAt: '2026-10-12T08:10:41.000Z' },
        { id: 'b', name: '写稿', description: '', status: 'running', progress: 40, logs: [] },
        { id: 'c', name: '审稿', description: '', status: 'pending', progress: 0, logs: [] },
        { id: 'd', name: '修稿', description: '', status: 'skipped', progress: 0, logs: [] },
      ] } as Partial<WorkflowRun>)],
      globalLogs: [{ time: '08:10:00', level: 'info', message: '开始' }],
    })
    await render()
    const step = (status: string) => host!.querySelector<HTMLElement>(`.run-step[data-status="${status}"]`)!
    const color = (element: Element) => getComputedStyle(element).color
    expect(ink('--ink-3')).not.toBe(ink('--ink-4'))
    expect(color(step('completed').querySelector('.run-step-meta')!)).toBe(ink('--ink-3'))
    for (const status of ['pending', 'skipped']) {
      expect(color(step(status).querySelector('.run-step-row')!)).toBe(ink('--ink-3'))
      expect(color(step(status).querySelector('.run-step-meta')!)).toBe(ink('--ink-3'))
    }
    expect(color(step('pending').querySelector('.run-step-icon')!)).toBe(ink('--ink-3'))
    await click('诊断')
    expect(color(host!.querySelector('.run-log-time')!)).toBe(ink('--ink-3'))
  })
})

describe('聊天入口不可见', () => {
  it.each<Locale>(['zh-CN', 'en-US'])('%s：运行侧页三个分页都没有聊天', async locale => {
    useLocaleStore.setState({ locale })
    useWorkflowStore.setState({ activeRuns: [run('4', 'running')], history: [run('3', 'completed')] })

    for (const tab of ['active', 'history', 'diagnostics'] as const) {
      await render({ kind: 'run', tab })
      expect(host!.textContent).not.toMatch(CHAT_WORDS)
      expect([...host!.querySelectorAll('[aria-label],[title]')].map(node => `${node.getAttribute('aria-label')} ${node.getAttribute('title')}`).join(' ')).not.toMatch(CHAT_WORDS)
    }
    expect(selectedTab()).toBe(locale === 'en-US' ? 'Diagnostics' : '诊断')
  })
})
