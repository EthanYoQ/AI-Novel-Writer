import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ModelProfile, ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import ChapterCreationDialog from '../ChapterCreationDialog'

const PROJECT_PATH = 'C:\\novels\\chapter-role-prefill'
const originalLLMState = useLLMStore.getState()
const originalProjectState = useProjectStore.getState()
const originalWorkflowState = useWorkflowStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let startWorkflow: ReturnType<typeof vi.fn>
let writtenCreationLog: { lastUsed?: { role?: string }; history?: { role?: string }[] } | undefined

function project(): ProjectData {
  return {
    id: 'chapter-role-prefill',
    sessionLease: 'chapter-role-prefill-lease',
    name: '章节定位预填测试项目',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '奇幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 5,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '完整的故事构想',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function model(): ModelProfile {
  return {
    id: 'generation-model',
    name: 'Generation model',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'generation-model',
    apiKey: 'test-only-key',
    baseUrl: 'https://models.example/v1',
    temperature: 0.7,
    maxTokens: 4096,
    purposes: ['generation'],
  }
}

function installIpc() {
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
        if (channel === 'fs:write-json') writtenCreationLog = args[1] as typeof writtenCreationLog
        if (channel === 'db:draft-authority-sequence') {
          return {
            status: 'empty',
            lastChapterNumber: 0,
            nextChapterNumber: 1,
            duplicateChapterNumbers: [],
            authorityFingerprint: 'a'.repeat(64),
          }
        }
        if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 1 }]
        if (channel === 'db:continuity-list-before') return []
        if (channel === 'db:consistency-exemption-list') return []
        if (channel === 'db:character-get-all') return [{ id: 1 }]
        if (channel === 'fs:read-json') return { success: false }
        if (channel === 'fs:write-json') return { success: true }
        throw new Error(`Unexpected IPC channel: ${channel}`)
      }),
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
}

/** The role select is the only one carrying the full canonical vocabulary. */
function roleSelect(): HTMLSelectElement {
  const select = Array.from(document.querySelectorAll('select'))
    .find(candidate => candidate.options.length >= 7)
  if (!(select instanceof HTMLSelectElement)) throw new Error('Missing chapter role select')
  return select
}

beforeEach(() => {
  startWorkflow = vi.fn(async () => 'chapter-role-prefill-run')
  writtenCreationLog = undefined
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project() })
  setActiveProjectSessionContext({
    projectId: 'chapter-role-prefill',
    leaseId: 'chapter-role-prefill-lease',
    projectPath: PROJECT_PATH,
  })
  useLLMStore.setState({
    models: [model()],
    defaultModelId: 'generation-model',
    defaultEmbeddingModelId: null,
    activeRequests: new Map(),
    loaded: true,
  })
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
    startWorkflow: startWorkflow as never,
    addLog: vi.fn() as never,
  })
  installIpc()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useLLMStore.setState(originalLLMState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
})

describe('chapter role prefill display', () => {
  it('keeps a padded custom prefill selected instead of falling back to 建置', async () => {
    const stored = ' 双线交汇 '
    await act(async () => {
      root?.render(<ChapterCreationDialog isOpen onClose={vi.fn()} prefill={{
        chapterNumber: 1, title: '雨夜启程', role: stored, purpose: '开始旅程', keyEvents: '收到匿名信',
      }} />)
    })

    await vi.waitFor(() => expect(roleSelect().value).toBe(stored))
    expect(Array.from(roleSelect().options).at(-1)?.value).toBe(stored)
    expect(roleSelect().selectedIndex).toBe(roleSelect().options.length - 1)

    await act(async () => page.getByRole('button', { name: '开始创作' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    // The saved creation parameters keep the exact stored value; nothing trims it on submit.
    await vi.waitFor(() => expect(writtenCreationLog?.lastUsed?.role).toBe(stored))
    expect(writtenCreationLog?.history?.[0]?.role).toBe(stored)
  })

  it('shows the unset option for a whitespace-only prefill without rewriting it', async () => {
    await act(async () => {
      root?.render(<ChapterCreationDialog isOpen onClose={vi.fn()} prefill={{
        chapterNumber: 1, title: '雨夜启程', role: '   ', purpose: '开始旅程', keyEvents: '收到匿名信',
      }} />)
    })

    await vi.waitFor(() => expect(roleSelect().value).toBe(''))
    expect(roleSelect().selectedIndex).toBe(0)
    expect(roleSelect().options[0]?.textContent).toBe('未设定')

    await act(async () => page.getByRole('button', { name: '开始创作' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    // The blank stored value is untouched on submit.
    await vi.waitFor(() => expect(writtenCreationLog?.lastUsed?.role).toBe('   '))
  })
})
