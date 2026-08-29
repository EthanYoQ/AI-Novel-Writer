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
let missingBlueprintChapter: number | null
let authoritativeNextChapter: number
let authorityInvalid: { gap?: number; duplicates?: number[] } | null
let creationHistoryChapter: number | null
let continuityProjections: unknown[]
let consistencyExemptions: unknown[]
let continuityProjectionReadError: Error | null

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
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
        if (channel === 'db:draft-authority-sequence') {
          if (authorityInvalid) {
            return {
              status: 'invalid',
              lastChapterNumber: 9,
              firstGapChapterNumber: authorityInvalid.gap,
              duplicateChapterNumbers: authorityInvalid.duplicates ?? [],
              authorityFingerprint: 'f'.repeat(64),
            }
          }
          return {
            status: authoritativeNextChapter === 1 ? 'empty' : 'continuous',
            lastChapterNumber: authoritativeNextChapter - 1,
            nextChapterNumber: authoritativeNextChapter,
            duplicateChapterNumbers: [],
            authorityFingerprint: 'e'.repeat(64),
          }
        }
        if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 1 }]
        if (channel === 'db:continuity-list-before') {
          if (continuityProjectionReadError) throw continuityProjectionReadError
          return continuityProjections
        }
        if (channel === 'db:consistency-exemption-list') return consistencyExemptions
        if (channel === 'db:consistency-exemption-save') {
          consistencyExemptions = [{ stableFactKey: String(args[0]), reason: String(args[1]), revoked: false }]
          return { success: true }
        }
        if (channel === 'db:consistency-exemption-revoke') {
          consistencyExemptions = consistencyExemptions.map(item => ({ ...(item as object), revoked: true }))
          return { success: true }
        }
        if (channel === 'db:character-get-all') return [{ id: 1 }]
        if (channel === 'db:blueprint-get') {
          if (Number(args[0]) === missingBlueprintChapter) return null
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
        if (channel === 'fs:read-json') return creationHistoryChapter === null
          ? { success: false }
          : {
              success: true,
              data: {
                lastUsed: {
                  chapterNumber: creationHistoryChapter,
                  role: '发展',
                  purpose: '历史目的',
                  keyEvents: '历史事件',
                  characters: '',
                },
              },
            }
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
  missingBlueprintChapter = null
  authoritativeNextChapter = 1
  authorityInvalid = null
  creationHistoryChapter = null
  continuityProjections = []
  consistencyExemptions = []
  continuityProjectionReadError = null
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
  it('uses finalized authority rather than creation history for the direct-writing default', async () => {
    authoritativeNextChapter = 10
    creationHistoryChapter = 3
    await act(async () => {
      root?.render(<ChapterCreationDialog isOpen onClose={vi.fn()} />)
    })

    await vi.waitFor(() => {
      const chapterInput = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="number"]')
      expect(chapterInput?.value).toBe('10')
    })
    expect(document.body.textContent).toContain('已自动填入上次参数')
  })

  it('uses finalized authority for the batch start even when its caller provides a stale chapter', async () => {
    authoritativeNextChapter = 10
    await act(async () => {
      root?.render(
        <BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />,
      )
    })

    await expect.element(page.getByText('第10章')).toBeVisible()
  })

  it('blocks direct and batch writing when finalized authority has a gap', async () => {
    authorityInvalid = { gap: 4 }
    await act(async () => {
      root?.render(
        <div>
          <ChapterCreationDialog isOpen onClose={vi.fn()} />
          <BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />
        </div>,
      )
    })

    await vi.waitFor(() => {
      expect(document.body.textContent?.match(/权威定稿缺少第 4 章/g)).toHaveLength(2)
    })
    const startButtons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .filter(button => button.textContent?.includes('开始创作') || button.textContent?.includes('启动批量创作'))
    expect(startButtons).toHaveLength(2)
    expect(startButtons.every(button => button.disabled)).toBe(true)
    expect(startWorkflow).not.toHaveBeenCalled()
  })

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

  it('shows a continuable bilingual finding and ignores it for this run only', async () => {
    continuityProjections = [{
      draftId: 1, chapterNumber: 1, chapterTitle: '终局', chapterNotes: '顾舟死亡',
      facts: [{ category: 'character-state', entities: ['顾舟'], statement: '顾舟已经死亡。', sourceChapter: 1, evidence: '顾舟停止了呼吸。' }],
    }]
    await act(async () => {
      root?.render(<ChapterCreationDialog isOpen onClose={vi.fn()} prefill={{
        chapterNumber: 1, title: '重逢', role: '发展', purpose: '顾舟归来', characters: '顾舟', keyEvents: '顾舟敲门',
      }} />)
    })
    await act(async () => page.getByRole('button', { name: '开始创作' }).click())
    await expect.element(page.getByRole('region', { name: '一致性预检' })).toBeVisible()
    await expect.element(page.getByText(/已定稿事实记录“顾舟”/)).toBeVisible()
    expect(startWorkflow).not.toHaveBeenCalled()

    await act(async () => page.getByRole('button', { name: '修改后重检' }).click())
    await expect.element(page.getByRole('region', { name: '一致性预检' })).toBeVisible()
    expect(startWorkflow).not.toHaveBeenCalled()

    await act(async () => page.getByRole('button', { name: '仅本次忽略并继续' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    expect(consistencyExemptions).toEqual([])
  })

  it('still starts direct writing when consistency evidence cannot be read', async () => {
    continuityProjectionReadError = new Error('projection unavailable')
    await act(async () => {
      root?.render(<ChapterCreationDialog isOpen onClose={vi.fn()} prefill={{
        chapterNumber: 1, title: '雨夜启程', role: '开篇', purpose: '开始旅程', keyEvents: '收到匿名信',
      }} />)
    })

    await act(async () => page.getByRole('button', { name: '开始创作' }).click())

    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
  })

  it('shows the same continuable preflight in English before a batch run', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    continuityProjections = [{
      draftId: 1, chapterNumber: 1, chapterTitle: 'The End', chapterNotes: '沈砺 died',
      facts: [{ category: 'character-state', entities: ['沈砺'], statement: '沈砺 is dead.', sourceChapter: 1, evidence: 'His breathing stopped.' }],
    }]
    await act(async () => {
      root?.render(<BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />)
    })
    await act(async () => page.getByRole('button', { name: 'Start batch writing' }).click())
    await expect.element(page.getByRole('region', { name: 'Consistency preflight' })).toBeVisible()
    await expect.element(page.getByText(/Finalized facts record “沈砺” as dead/)).toBeVisible()
    expect(startWorkflow).not.toHaveBeenCalled()

    await act(async () => page.getByRole('button', { name: 'Fix and rerun' }).click())
    await expect.element(page.getByRole('region', { name: 'Consistency preflight' })).toBeVisible()
    expect(startWorkflow).not.toHaveBeenCalled()

    await act(async () => page.getByRole('button', { name: 'Ignore once and continue' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
  })

  it('still starts batch writing when consistency evidence cannot be read', async () => {
    continuityProjectionReadError = new Error('projection unavailable')
    await act(async () => {
      root?.render(<BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />)
    })

    await act(async () => page.getByRole('button', { name: '启动批量创作' }).click())

    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
  })

  it('reopens saved arrangements and allows revocation without starting writing', async () => {
    consistencyExemptions = [{ stableFactKey: 'character-state:1:顾舟:顾舟已经死亡。', reason: '回忆场景', revoked: false }]
    await act(async () => {
      root?.render(<ChapterCreationDialog isOpen onClose={vi.fn()} />)
    })
    await expect.element(page.getByText('已保存安排（1）')).toBeVisible()
    await act(async () => page.getByText('已保存安排（1）').click())
    await expect.element(page.getByText('回忆场景')).toBeVisible()
    await act(async () => page.getByRole('button', { name: '撤销' }).click())
    await vi.waitFor(() => expect(consistencyExemptions).toEqual([
      expect.objectContaining({ revoked: true }),
    ]))
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('defaults the batch dialog to the global model, freezes an explicitly selected Grok run, and preserves that default', async () => {
    await act(async () => {
      root?.render(
        <BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />,
      )
    })

    await vi.waitFor(() => expect(selectedModel('batch-writing-model').value).toBe('glm'))
    await expect.element(page.getByRole('radio', { name: '生成草稿待审' })).toBeChecked()
    await expect.element(page.getByRole('radio', { name: '自动定稿' })).not.toBeChecked()
    expect(Array.from(selectedModel('batch-writing-model').options).map(option => option.value))
      .toEqual(['', 'glm', 'grok'])

    await chooseModel('batch-writing-model', 'grok')
    await act(async () => page.getByRole('button', { name: '启动批量创作' }).click())

    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({
      generationModelId: 'grok',
      completionMode: 'draft_review',
    })
    expect(useLLMStore.getState().defaultModelId).toBe('glm')
    expect(setDefaultModel).not.toHaveBeenCalled()
  })

  it('requires an explicit consequence confirmation before starting auto-finalize mode', async () => {
    await act(async () => {
      root?.render(
        <BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />,
      )
    })

    await chooseModel('batch-writing-model', 'grok')
    await act(async () => page.getByRole('radio', { name: '自动定稿' }).click())

    await expect.element(page.getByText(/发布实体稿并运行角色与连续性后处理/)).toBeVisible()
    await act(async () => page.getByRole('button', { name: '继续确认自动定稿' }).click())

    expect(startWorkflow).not.toHaveBeenCalled()
    await expect.element(page.getByText('即将自动定稿第1–1章（共1章）。完成后章节只读，不能直接编辑。')).toBeVisible()

    await act(async () => page.getByRole('button', { name: '确认自动定稿并启动' }).click())

    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({
      completionMode: 'auto_finalize',
      generationModelId: 'grok',
      steps: [expect.objectContaining({ name: '第1章：自动定稿与后处理' })],
    })
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

  it('blocks a batch run when its selected generation model becomes unavailable', async () => {
    await act(async () => {
      root?.render(
        <BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />,
      )
    })

    await chooseModel('batch-writing-model', 'grok')
    useLLMStore.setState({ models: [
      model({ id: 'glm', name: 'GLM', modelName: 'GLM-4-Flash' }),
      model({ id: 'embedding', name: 'Embedding only', purposes: ['embedding'] }),
    ] })

    await expect.element(page.getByText('所选创作模型已不可用。请选择一项可用于文本生成的模型后再试。')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '启动批量创作' })).toBeDisabled()
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('reports a missing batch blueprint in English and refuses to start', async () => {
    missingBlueprintChapter = 1
    useLocaleStore.setState({ locale: 'en-US' })
    await act(async () => {
      root?.render(
        <BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />,
      )
    })

    await act(async () => page.getByRole('button', { name: 'Start batch writing' }).click())

    await expect.element(page.getByText(
      'No blueprint was found for chapter 1. Complete the consecutive blueprints first.',
    )).toBeVisible()
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('reports the lack of a generation model in English and disables launch', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    useLLMStore.setState({
      models: [model({ id: 'embedding', name: 'Embedding only', purposes: ['embedding'] })],
      defaultModelId: null,
    })
    await act(async () => {
      root?.render(
        <BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />,
      )
    })

    await expect.element(page.getByText(
      'No configured model can generate text. Add or enable a generation model in Settings.',
    )).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Start batch writing' })).toBeDisabled()
    expect(startWorkflow).not.toHaveBeenCalled()
  })
})
