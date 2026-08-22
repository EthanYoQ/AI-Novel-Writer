import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ModelProfile, ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import BatchChapterCreationDialog from '../BatchChapterCreationDialog'
import ChapterCreationDialog from '../ChapterCreationDialog'

const PROJECT_PATH = 'C:\\novels\\writing-model-selector'
const originalLayoutState = useLayoutStore.getState()
const originalLLMState = useLLMStore.getState()
const originalProjectState = useProjectStore.getState()
const originalWorkflowState = useWorkflowStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let startWorkflow: ReturnType<typeof vi.fn>
let setDefaultModel: ReturnType<typeof vi.fn>

function project(): ProjectData {
  return {
    id: 'writing-model-selector',
    sessionLease: 'writing-model-selector-lease',
    name: '创作模型选择测试项目',
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

function model(overrides: Partial<ModelProfile>): ModelProfile {
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
    ...overrides,
  }
}

function installIpc() {
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 1 }]
        if (channel === 'db:character-get-all') return [{ id: 1 }]
        if (channel === 'db:blueprint-get') {
          return {
            chapterNumber: 1,
            title: '雨夜启程',
            role: '开篇',
            purpose: '开始旅程',
            characters: ['沈砺'],
            keyEvents: '收到匿名信',
            suspenseHook: '信封背面出现陌生署名。',
            userGuidance: '',
          }
        }
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

function selectedModel(id: string): HTMLSelectElement {
  const select = document.getElementById(id)
  if (!(select instanceof HTMLSelectElement)) throw new Error(`Missing model selector: ${id}`)
  return select
}

async function chooseModel(id: string, modelId: string) {
  const select = selectedModel(id)
  await act(async () => {
    select.value = modelId
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(() => {
  startWorkflow = vi.fn(async () => 'writing-model-selector-run')
  setDefaultModel = vi.fn(async () => true)
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project() })
  setActiveProjectSessionContext({
    projectId: 'writing-model-selector',
    leaseId: 'writing-model-selector-lease',
    projectPath: PROJECT_PATH,
  })
  useLLMStore.setState({
    models: [
      model({ id: 'glm', name: 'GLM', modelName: 'GLM-4-Flash' }),
      model({ id: 'grok', name: 'Grok', modelName: 'grok-4' }),
      model({ id: 'embedding', name: 'Embedding only', purposes: ['embedding'] }),
    ],
    defaultModelId: 'glm',
    defaultEmbeddingModelId: 'embedding',
    activeRequests: new Map(),
    loaded: true,
    setDefaultModel: setDefaultModel as never,
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
  useLayoutStore.setState(originalLayoutState)
  useLLMStore.setState(originalLLMState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
})

describe('chapter writing model selectors', () => {
  it('defaults the direct chapter dialog to the global model, freezes an explicitly selected Grok run, and preserves that default', async () => {
    await act(async () => {
      root?.render(
        <ChapterCreationDialog
          isOpen
          onClose={vi.fn()}
          prefill={{ chapterNumber: 1, title: '雨夜启程', role: '开篇' }}
        />,
      )
    })

    await vi.waitFor(() => expect(selectedModel('chapter-writing-model').value).toBe('glm'))
    expect(selectedModel('chapter-writing-model').options).toHaveLength(3)
    expect(Array.from(selectedModel('chapter-writing-model').options).map(option => option.value))
      .toEqual(['', 'glm', 'grok'])

    await chooseModel('chapter-writing-model', 'grok')
    await act(async () => page.getByRole('button', { name: '开始创作' }).click())

    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({ generationModelId: 'grok' })
    expect(useLLMStore.getState().defaultModelId).toBe('glm')
    expect(setDefaultModel).not.toHaveBeenCalled()
  })

  it('defaults the batch dialog to the global model, freezes an explicitly selected Grok run, and preserves that default', async () => {
    await act(async () => {
      root?.render(
        <BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />,
      )
    })

    await vi.waitFor(() => expect(selectedModel('batch-writing-model').value).toBe('glm'))
    expect(Array.from(selectedModel('batch-writing-model').options).map(option => option.value))
      .toEqual(['', 'glm', 'grok'])

    await chooseModel('batch-writing-model', 'grok')
    await act(async () => page.getByRole('button', { name: '启动批量创作' }).click())

    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({ generationModelId: 'grok' })
    expect(useLLMStore.getState().defaultModelId).toBe('glm')
    expect(setDefaultModel).not.toHaveBeenCalled()
  })

  it('blocks a direct chapter run when the selected model is deleted while the dialog remains open', async () => {
    await act(async () => {
      root?.render(
        <ChapterCreationDialog
          isOpen
          onClose={vi.fn()}
          prefill={{ chapterNumber: 1, title: '雨夜启程', role: '开篇' }}
        />,
      )
    })

    await vi.waitFor(() => expect(selectedModel('chapter-writing-model').value).toBe('glm'))
    await chooseModel('chapter-writing-model', 'grok')

    useLLMStore.setState({ models: [
      model({ id: 'glm', name: 'GLM', modelName: 'GLM-4-Flash' }),
      model({ id: 'embedding', name: 'Embedding only', purposes: ['embedding'] }),
    ] })

    await expect.element(page.getByText('所选创作模型已不可用。请选择一项可用于文本生成的模型后再试。')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '开始创作' })).toBeDisabled()
    expect(startWorkflow).not.toHaveBeenCalled()
  })
})
