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
import type { WorkflowDefinition } from '../../../stores/workflow-store'

const PROJECT_PATH = 'C:\\novels\\chapter-role-prefill'
const originalLLMState = useLLMStore.getState()
const originalProjectState = useProjectStore.getState()
const originalWorkflowState = useWorkflowStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let startWorkflow: ReturnType<typeof vi.fn>
let writtenCreationLog: { lastUsed?: { role?: string }; history?: { role?: string }[] } | undefined
let restoredRole: string | undefined
let preparedRole: string | undefined

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
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
        if (channel === 'generation:prepare-draft-context') {
          const request = args[0] as { authorInputs: { id: string; text: string }[] }
          preparedRole = JSON.parse(request.authorInputs.find(item => item.id === 'draft:chapter-info')!.text).role
          throw new Error('ROLE_REQUEST_CAPTURED')
        }
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
        if (channel === 'fs:read-json') return restoredRole === undefined
          ? { success: false }
          : { success: true, data: { lastUsed: { chapterNumber: 1, role: restoredRole } } }
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
  restoredRole = undefined
  preparedRole = undefined
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

const roles = ['发展', '开篇', '双线交汇', ' 双线交汇 ', ' 高潮 ', '', '   ']

async function submitAndCheckRole(expected: string) {
  await act(async () => page.getByRole('button', { name: '开始创作' }).click())
  await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
  expect(writtenCreationLog?.lastUsed?.role).toBe(expected)
  expect(writtenCreationLog?.history?.[0]?.role).toBe(expected)
  const workflow = startWorkflow.mock.calls[0][0] as WorkflowDefinition
  // Execute the real draft command up to its main-process request; never dispatch a model.
  await expect(workflow.steps[0].executor!({} as never, {
    projectPath: PROJECT_PATH, projectSession: workflow.projectSession!, runId: 'role-request',
    writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false,
    generationModelId: 'generation-model',
  }, { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() })).rejects.toThrow('ROLE_REQUEST_CAPTURED')
  expect(preparedRole).toBe(expected)
}

describe('chapter role preservation', () => {
  for (const source of ['prefill', 'history'] as const) {
    it.each(roles)(`${source} preserves exact role %j through display, saved parameters and the draft request`, async stored => {
      if (source === 'history') restoredRole = stored
      await act(async () => root?.render(<ChapterCreationDialog isOpen onClose={vi.fn()}
        prefill={source === 'prefill' ? { chapterNumber: 1, role: stored } : undefined} />))
      await vi.waitFor(() => expect(roleSelect().value).toBe(stored.trim() ? stored : ''))
      expect(roleSelect().selectedOptions[0]?.textContent).toBe(stored.trim() ? stored : '未设定')
      await submitAndCheckRole(stored)
    })
  }

  it('uses the new value only after the author changes the role', async () => {
    await act(async () => root?.render(<ChapterCreationDialog isOpen onClose={vi.fn()} prefill={{ role: ' 高潮 ' }} />))
    await vi.waitFor(() => expect(roleSelect().value).toBe(' 高潮 '))
    await act(async () => {
      roleSelect().value = '转折'
      roleSelect().dispatchEvent(new Event('change', { bubbles: true }))
    })
    await submitAndCheckRole('转折')
  })

  it('keeps the new chapter default when no stored role exists', async () => {
    await act(async () => root?.render(<ChapterCreationDialog isOpen onClose={vi.fn()} />))
    await vi.waitFor(() => expect(roleSelect().value).toBe('发展'))
    await submitAndCheckRole('发展')
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useLLMStore.setState(originalLLMState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
})

