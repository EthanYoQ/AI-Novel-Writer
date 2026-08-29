import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useLLMStore } from '../../../stores/llm-store'
import type { NarrativeThreadCandidateGenerator } from '../../../services/narrative-thread-candidate-generator'
import NarrativeThreadEditor from '../NarrativeThreadEditor'

const PROJECT_PATH = 'C:\\novels\\narrative-thread'
let root: Root | undefined
let container: HTMLDivElement | undefined
let plans: Array<Record<string, unknown>> = []
let eventFailure = ''
let invoke: ReturnType<typeof vi.fn>
const originalProjectState = useProjectStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalLLMState = useLLMStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function installIpc() {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:draft-get-max-finalized-chapter') return 3
    if (channel === 'db:draft-list-all') return [{ id: 7, chapterNumber: 1, version: 1, status: 'finalized', source: 'write', contentId: 1, wordCount: 8, createdAt: '', updatedAt: '' }]
    if (channel === 'db:draft-get-full') return { id: 7, content: '门上出现刻痕。林岚没有声张。' }
    if (channel === 'db:blueprint-get-all') return [{
      chapterNumber: 2, title: '刻痕之谜', role: '发展', purpose: '引出幕后对手',
      keyEvents: '林岚再次发现相同刻痕。', characters: ['林岚'], suspenseHook: '',
      userGuidance: '', notes: '', notesUpdatedAt: '',
    }]
    if (channel === 'db:narrative-thread-list') return plans
    if (channel === 'db:narrative-thread-plan-create') {
      const input = args[0] as Record<string, unknown>
      plans = [{ ...input, id: 1, status: 'planned', dormantChapters: 2, overdue: false, events: [], createdAt: '', updatedAt: '' }]
      return { success: true, plan: plans[0] }
    }
    if (channel === 'db:narrative-thread-plan-update') {
      plans = [{ ...plans[0], ...(args[1] as Record<string, unknown>) }]
      return { success: true, plan: plans[0] }
    }
    if (channel === 'db:narrative-thread-plan-delete') {
      plans = []
      return { success: true }
    }
    if (channel === 'db:narrative-thread-event-confirm') {
      if (eventFailure) return { success: false, error: eventFailure }
      plans = [{ ...plans[0], status: 'planted', events: [{ id: 1, planId: 1, draftId: 7, chapterNumber: 1, chapterTitle: '第一章', type: 'planted', evidence: '门上出现刻痕。', reason: '埋设入口。', createdAt: '' }] }]
      return { success: true, event: (plans[0]?.events as unknown[])[0] }
    }
    throw new Error(`unexpected IPC ${channel}`)
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() },
  })
}

beforeEach(() => {
  plans = []
  eventFailure = ''
  useLocaleStore.setState({ locale: 'zh-CN' })
  const project: ProjectData = {
    id: 'thread-project', sessionLease: 'thread-lease', name: '线索测试', path: PROJECT_PATH,
    novelConfig: { genre: '', subGenre: '', targetAudience: '', totalChapters: 10, wordsPerChapter: 2000, plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '' },
    characterStates: '', createdAt: '', updatedAt: '',
  }
  useProjectStore.setState({ currentProject: project, fileTree: [], loading: false })
  useLLMStore.setState({
    models: [
      { id: 'glm', name: 'GLM', provider: 'bigmodel', protocol: 'openai', modelName: 'glm', apiKey: 'fixture', baseUrl: 'https://example.invalid', temperature: 0.7, maxTokens: 4096, purposes: ['generation'] },
      { id: 'grok', name: 'Grok', provider: 'xai', protocol: 'openai', modelName: 'grok', apiKey: 'fixture', baseUrl: 'https://example.invalid', temperature: 0.7, maxTokens: 4096, purposes: ['generation'] },
      { id: 'embed', name: 'Embedding', provider: 'openai', protocol: 'openai', modelName: 'embed', apiKey: 'fixture', baseUrl: 'https://example.invalid', temperature: 0, maxTokens: 4096, purposes: ['embedding'] },
    ],
    defaultModelId: 'glm',
    loaded: true,
  })
  setActiveProjectSessionContext({ projectId: project.id, leaseId: project.sessionLease!, projectPath: PROJECT_PATH })
  installIpc()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useProjectStore.setState(originalProjectState)
  useLocaleStore.setState(originalLocaleState)
  useLLMStore.setState(originalLLMState)
})

describe('NarrativeThreadEditor', () => {
  it('creates a plan and confirms an event from a finalized chapter', async () => {
    await act(async () => root?.render(<NarrativeThreadEditor projectKey={PROJECT_PATH} />))
    await vi.waitFor(() => expect(container?.textContent).toContain('暂无伏笔或叙事线索'))

    const fields = container!.querySelectorAll<HTMLInputElement>('input')
    await act(async () => {
      setValue(fields[0]!, '门上的刻痕')
      setValue(fields[1]!, '伏笔')
      setValue(container!.querySelector<HTMLTextAreaElement>('textarea')!, '第三章揭示来源。')
    })
    await act(async () => Array.from(container!.querySelectorAll('button')).find(button => button.textContent?.includes('保存计划'))?.click())
    await vi.waitFor(() => expect(container?.textContent).toContain('门上的刻痕'))

    await act(async () => Array.from(container!.querySelectorAll('button')).find(button => button.textContent?.includes('确认定稿事件'))?.click())
    const eventEvidence = container!.querySelector<HTMLInputElement>('input[placeholder="粘贴该定稿章节中的短原文"]')!
    const eventReason = container!.querySelector<HTMLInputElement>('input[placeholder="确认理由"]')!
    await act(async () => {
      setValue(eventEvidence, '门上出现刻痕。')
      setValue(eventReason, '确认第一章已埋设。')
    })
    await act(async () => Array.from(container!.querySelectorAll('button')).find(button => button.textContent?.includes('保存事件'))?.click())
    await vi.waitFor(() => expect(container?.textContent).toContain('门上出现刻痕。'))

    await act(async () => Array.from(container!.querySelectorAll('button')).find(button => button.textContent?.includes('编辑'))?.click())
    const title = container!.querySelectorAll<HTMLInputElement>('input')[0]!
    await act(async () => setValue(title, '门上的三道刻痕'))
    await act(async () => Array.from(container!.querySelectorAll('button')).find(button => button.textContent?.includes('保存计划'))?.click())
    await vi.waitFor(() => expect(container?.textContent).toContain('门上的三道刻痕'))

    await act(async () => Array.from(container!.querySelectorAll('button')).find(button => button.textContent?.includes('删除'))?.click())
    await vi.waitFor(() => expect(container?.textContent).toContain('暂无伏笔或叙事线索'))
  })

  it('renders status history and actions in English after rebuilding the view', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    plans = [{
      id: 2, title: 'The altered logbook', type: 'Promise', targetStartChapter: 1,
      targetEndChapter: 3, authorIntent: 'Reveal the forger.', status: 'progressing',
      dormantChapters: 2, overdue: false, createdAt: '', updatedAt: '',
      events: [{ id: 2, planId: 2, draftId: 7, chapterNumber: 1, chapterTitle: 'Departure', type: 'planted', evidence: 'The seal was broken.', reason: 'Establish the clue.', createdAt: '' }],
    }]

    await act(async () => root?.render(<NarrativeThreadEditor projectKey={PROJECT_PATH} />))

    await vi.waitFor(() => {
      expect(container?.textContent).toContain('Foreshadowing & narrative threads')
      expect(container?.textContent).toContain('Progressing')
      expect(container?.textContent).toContain('Chapter 1')
      expect(container?.textContent).toContain('Confirm finalized event')
    })
  })

  it('explains the evidence boundary and shows only the controlled actionable failure', async () => {
    plans = [{
      id: 3, title: '门上的刻痕', type: '伏笔', targetStartChapter: 1, targetEndChapter: 3,
      authorIntent: '第三章解释来源。', status: 'planned', dormantChapters: 0, overdue: false,
      createdAt: '', updatedAt: '', events: [],
    }]
    eventFailure = 'Error: 短证据必须来自绑定的定稿正文；C:\\private\\novel.txt'
    await act(async () => root?.render(<NarrativeThreadEditor projectKey={PROJECT_PATH} />))
    await vi.waitFor(() => expect(container?.textContent).toContain('门上的刻痕'))
    await act(async () => Array.from(container!.querySelectorAll('button')).find(button => button.textContent?.includes('确认定稿事件'))?.click())

    expect(container!.querySelector<HTMLInputElement>('input[placeholder="粘贴该定稿章节中的短原文"]')).not.toBeNull()
    await act(async () => {
      setValue(container!.querySelector<HTMLInputElement>('input[placeholder="粘贴该定稿章节中的短原文"]')!, '不存在的片段')
      setValue(container!.querySelector<HTMLInputElement>('input[placeholder="确认理由"]')!, '人工确认。')
    })
    await act(async () => Array.from(container!.querySelectorAll('button')).find(button => button.textContent?.includes('保存事件'))?.click())

    await vi.waitFor(() => expect(container?.textContent).toContain('请粘贴所选定稿章节中实际出现的短原文'))
    expect(container?.textContent).not.toContain('private')
    expect(container?.textContent).not.toContain('novel.txt')
  })

  it('keeps blueprint AI output in memory until the author confirms a plan with the frozen model', async () => {
    const candidateGenerator: NarrativeThreadCandidateGenerator = {
      generatePlanCandidates: vi.fn().mockResolvedValue([{
        title: '门框上的刻痕', type: '伏笔', targetStartChapter: 2, targetEndChapter: 8,
        authorIntent: '模型声称已经埋设，但这里只能确认人工计划。',
      }]),
      generateEventCandidates: vi.fn().mockResolvedValue([]),
    }
    await act(async () => root?.render(
      <NarrativeThreadEditor projectKey={PROJECT_PATH} candidateGenerator={candidateGenerator} />,
    ))
    await vi.waitFor(() => expect(container?.textContent).toContain('AI 建议伏笔与线索'))

    await act(async () => Array.from(container!.querySelectorAll('button'))
      .find(button => button.textContent?.includes('AI 建议伏笔与线索'))?.click())
    await vi.waitFor(() => expect(document.body.textContent).toContain('本次识别模型'))
    const modelSelect = document.body.querySelector<HTMLSelectElement>('#narrative-thread-ai-model')!
    expect(Array.from(modelSelect.options).map(option => option.textContent)).toEqual(['请选择可用生成模型', 'GLM', 'Grok'])
    await act(async () => {
      modelSelect.value = 'grok'
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent?.includes('生成候选'))?.click())
    await vi.waitFor(() => expect(document.body.textContent).toContain('门框上的刻痕'))

    expect(candidateGenerator.generatePlanCandidates).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'grok' }))
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:narrative-thread-plan-create')).toBe(false)
    expect(useLLMStore.getState().defaultModelId).toBe('glm')

    await act(async () => Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent?.includes('拒绝候选'))?.click())
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('门框上的刻痕'))
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:narrative-thread-plan-create')).toBe(false)

    await act(async () => Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent?.includes('生成候选'))?.click())
    await vi.waitFor(() => expect(document.body.textContent).toContain('门框上的刻痕'))
    await act(async () => Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent?.includes('确认计划'))?.click())
    await vi.waitFor(() => expect(container?.textContent).toContain('门框上的刻痕'))

    const planCreate = invoke.mock.calls.find(([channel]) => channel === 'db:narrative-thread-plan-create')
    expect(planCreate?.[1]).toEqual({
      title: '门框上的刻痕', type: '伏笔', targetStartChapter: 2, targetEndChapter: 8,
      authorIntent: '模型声称已经埋设，但这里只能确认人工计划。',
    })
    expect(planCreate?.[1]).not.toHaveProperty('eventType')
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:narrative-thread-event-confirm')).toBe(false)
  })

  it('binds finalized-event AI candidates to the selected plan and draft until confirmation', async () => {
    plans = [{
      id: 4, title: '门上的刻痕', type: '伏笔', targetStartChapter: 1, targetEndChapter: 5,
      authorIntent: '第五章揭示来源。', status: 'planned', dormantChapters: 1, overdue: false,
      createdAt: '', updatedAt: '', events: [],
    }]
    const candidateGenerator: NarrativeThreadCandidateGenerator = {
      generatePlanCandidates: vi.fn().mockResolvedValue([]),
      generateEventCandidates: vi.fn().mockResolvedValue([{
        type: 'planted', evidence: '门上出现刻痕。', reason: '定稿正文已出现约定的视觉线索。',
      }]),
    }
    await act(async () => root?.render(
      <NarrativeThreadEditor projectKey={PROJECT_PATH} candidateGenerator={candidateGenerator} />,
    ))
    await vi.waitFor(() => expect(container?.textContent).toContain('门上的刻痕'))

    await act(async () => Array.from(container!.querySelectorAll('button'))
      .find(button => button.textContent?.includes('确认定稿事件'))?.click())
    await act(async () => Array.from(container!.querySelectorAll('button'))
      .find(button => button.textContent?.includes('AI 识别定稿事件'))?.click())
    await vi.waitFor(() => expect(document.body.textContent).toContain('定稿事件候选'))
    const modelSelect = document.body.querySelector<HTMLSelectElement>('#narrative-thread-ai-model')!
    await act(async () => {
      modelSelect.value = 'grok'
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent?.includes('生成候选'))?.click())
    await vi.waitFor(() => expect(document.body.textContent).toContain('定稿正文已出现约定的视觉线索'))

    expect(candidateGenerator.generateEventCandidates).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'grok', draftId: 7, chapterNumber: 1,
      finalizedContent: '门上出现刻痕。林岚没有声张。',
      plan: expect.objectContaining({ id: 4, title: '门上的刻痕' }),
    }))
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:narrative-thread-event-confirm')).toBe(false)
    expect(useLLMStore.getState().defaultModelId).toBe('glm')

    await act(async () => Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent?.includes('拒绝候选'))?.click())
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('定稿正文已出现约定的视觉线索'))
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:narrative-thread-event-confirm')).toBe(false)

    await act(async () => Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent?.includes('生成候选'))?.click())
    await vi.waitFor(() => expect(document.body.textContent).toContain('定稿正文已出现约定的视觉线索'))
    await act(async () => Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent?.includes('确认事件'))?.click())

    const eventConfirm = invoke.mock.calls.find(([channel]) => channel === 'db:narrative-thread-event-confirm')
    expect(eventConfirm?.[1]).toEqual({
      planId: 4, draftId: 7, type: 'planted', evidence: '门上出现刻痕。',
      reason: '定稿正文已出现约定的视觉线索。',
    })
  })

  it('updates the dormant reminder immediately from the current project threshold', async () => {
    const currentProject = useProjectStore.getState().currentProject!
    useProjectStore.setState({
      currentProject: {
        ...currentProject,
        novelConfig: { ...currentProject.novelConfig, narrativeThreadDormantChapterThreshold: 5 },
      },
    })
    plans = [{
      id: 5, title: '沉睡的航线', type: '悬念', targetStartChapter: 1, targetEndChapter: 8,
      authorIntent: '后续重新推进。', status: 'progressing', dormantChapters: 4, overdue: false,
      createdAt: '', updatedAt: '', events: [],
    }]
    await act(async () => root?.render(<NarrativeThreadEditor projectKey={PROJECT_PATH} />))
    await vi.waitFor(() => expect(container?.textContent).toContain('沉睡的航线'))
    expect(container?.textContent).not.toContain('已达到项目沉寂提醒阈值')

    const latestProject = useProjectStore.getState().currentProject!
    await act(async () => useProjectStore.setState({
      currentProject: {
        ...latestProject,
        novelConfig: { ...latestProject.novelConfig, narrativeThreadDormantChapterThreshold: 4 },
      },
    }))
    await vi.waitFor(() => expect(container?.textContent).toContain('已达到项目沉寂提醒阈值'))
  })
})
