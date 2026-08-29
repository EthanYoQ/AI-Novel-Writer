import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import NarrativeThreadEditor from '../NarrativeThreadEditor'

const PROJECT_PATH = 'C:\\novels\\narrative-thread'
let root: Root | undefined
let container: HTMLDivElement | undefined
let plans: Array<Record<string, unknown>> = []
let eventFailure = ''
const originalProjectState = useProjectStore.getState()
const originalLocaleState = useLocaleStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function installIpc() {
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:draft-get-max-finalized-chapter') return 3
    if (channel === 'db:draft-list-all') return [{ id: 7, chapterNumber: 1, version: 1, status: 'finalized', source: 'write', contentId: 1, wordCount: 8, createdAt: '', updatedAt: '' }]
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
})

describe('NarrativeThreadEditor', () => {
  it('creates a plan and confirms an event from a finalized chapter', async () => {
    await act(async () => root?.render(<NarrativeThreadEditor projectKey={PROJECT_PATH} />))
    await vi.waitFor(() => expect(container?.textContent).toContain('暂无叙事线索'))

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
    await vi.waitFor(() => expect(container?.textContent).toContain('暂无叙事线索'))
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
      expect(container?.textContent).toContain('Narrative threads')
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
})
