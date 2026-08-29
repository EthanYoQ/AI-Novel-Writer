import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { FileNode, ModelExecutionLeaseReceipt, ModelProfile, ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { clearProjectCustomPrompts } from '../../../services/prompt-templates'
import { disposeProjectService, initProjectService } from '../../../services/project-service'
import { useDraftStore } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import DraftEditor from '../../editor/DraftEditor'
import BottomPanel from '../../panels/BottomPanel'
import ProjectTree from '../../panels/sidebar/ProjectTree'
import BatchChapterCreationDialog from '../BatchChapterCreationDialog'

const PROJECT_PATH = 'C:\\novels\\batch-completion-mode'
const PROJECT_SESSION = {
  projectId: 'batch-completion-mode',
  leaseId: 'batch-completion-mode-lease',
  projectPath: PROJECT_PATH,
}
const DRAFT_TEXT = `${'雨'.repeat(98)}。终。`
const FIRST_DRAFT_TAIL = '第一章尾部唯一线索：银色怀表在午夜停摆。'
const FIRST_DRAFT_TEXT = `${'雨'.repeat(70)}。${FIRST_DRAFT_TAIL}`
const originalDraftState = useDraftStore.getState()
const originalEditorState = useEditorStore.getState()
const originalLayoutState = useLayoutStore.getState()
const originalLLMState = useLLMStore.getState()
const originalProjectState = useProjectStore.getState()
const originalWorkflowState = useWorkflowStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn>
let draftRecord: {
  id: number
  chapterNumber: number
  version: number
  status: 'draft' | 'finalized'
  wordCount: number
  createdAt: string
  source: 'write'
  content: string
} | null
let postProcessRunCreated: boolean
let draftCompletionIndex: number
let draftCompletions: string[]
let deferDraftCompletion: boolean
let pendingDraftCompletions: Array<() => void>
let changeDefaultAfterFirstDraft: boolean
let postProcessSteps: Array<{
  stepKey: string
  label: string
  critical: boolean
  ok: boolean
  completedAt: string | null
  errorMsg: string | null
  lastAttemptAt: string
  attemptCount: number
}>

function project(): ProjectData {
  return {
    id: PROJECT_SESSION.projectId,
    sessionLease: PROJECT_SESSION.leaseId,
    name: '批量完成模式浏览器测试',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '悬疑',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 3,
      wordsPerChapter: 100,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '雨夜来信开启调查。',
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

function generationModel(): ModelProfile {
  return {
    id: 'grok-browser',
    name: 'Grok Browser',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'grok-browser',
    apiKey: 'test-only-key',
    baseUrl: 'https://models.example/v1',
    temperature: 0.7,
    maxTokens: 4096,
    purposes: ['generation'],
  }
}

// eslint-disable-next-line react-refresh/only-export-components -- browser-only integration shell
function VisibleBatchShell() {
  const [dialogOpen, setDialogOpen] = useState(true)
  const activeChapterTab = useEditorStore(state => {
    const activeTab = state.tabs.find(tab => tab.id === state.activeTabId)
    return activeTab?.type === 'chapter' ? activeTab : undefined
  })

  return (
    <div>
      <BatchChapterCreationDialog
        isOpen={dialogOpen}
        startChapterNumber={1}
        onClose={() => setDialogOpen(false)}
      />
      <div data-testid="project-tree"><ProjectTree /></div>
      <div data-testid="chapter-editor">
        {activeChapterTab?.filePath && activeChapterTab.projectKey && (
          <DraftEditor
            tabId={activeChapterTab.id}
            filePath={activeChapterTab.filePath}
            content={activeChapterTab.content ?? ''}
            projectKey={activeChapterTab.projectKey}
          />
        )}
      </div>
      <div data-testid="task-panel"><BottomPanel /></div>
    </div>
  )
}

function blueprint(chapterNumber = 1) {
  return {
    chapterNumber,
    title: '雨夜来信',
    role: '开篇',
    purpose: '建立调查目标。',
    characters: ['沈砺'],
    keyEvents: '收到匿名信。',
    suspenseHook: '信封背面出现陌生署名。',
    userGuidance: '',
    notes: '',
  }
}

const MODEL_LEASE: ModelExecutionLeaseReceipt = {
  leaseId: 'batch-browser-model-lease',
  modelId: 'grok-browser',
  provider: 'custom',
  protocol: 'openai',
  modelName: 'grok-browser',
  modelRevision: 'a'.repeat(64),
  endpointFingerprint: 'b'.repeat(64),
  capabilityEvidence: {
    source: {
      contextWindowTokens: 'unknown',
      maxOutputTokens: 'legacy-profile',
      featureFlags: 'unknown',
    },
    subjectFingerprint: 'c'.repeat(64),
    contextWindowTokens: null,
    maxOutputTokens: 4096,
    reasoning: null,
    structuredOutput: true,
    usage: null,
  },
  createdAt: 1_000,
  expiresAt: 61_000,
}

function fileTree(): FileNode[] {
  if (draftRecord?.status === 'finalized') {
    return [{
      name: 'manuscript',
      path: `${PROJECT_PATH}\\manuscript`,
      isDir: true,
      children: [{
        name: '第1章 雨夜来信.txt',
        path: `${PROJECT_PATH}\\manuscript\\chapter_1.txt`,
        isDir: false,
      }],
    }]
  }
  return [{
    name: 'drafts',
    path: `${PROJECT_PATH}\\drafts`,
    isDir: true,
    children: draftRecord
      ? [{ name: '第1章 雨夜来信 v1', path: `vela://draft/${draftRecord.id}`, isDir: false }]
      : [],
  }]
}

function installIpc() {
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const emit = (channel: string, data: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener(data)
  }
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'db:draft-authority-sequence') {
      return {
        status: 'empty',
        lastChapterNumber: 0,
        nextChapterNumber: 1,
        duplicateChapterNumbers: [],
        authorityFingerprint: 'a'.repeat(64),
      }
    }
    if (channel === 'llm:begin-execution-lease') return { success: true, lease: MODEL_LEASE }
    if (channel === 'llm:close-execution-lease') return { success: true }
    if (channel === 'llm:generate-stream') {
      const requestId = String(args[0])
      const request = args[1] as { purpose?: string; responseFormat?: { type?: string } }
      const completion = request.purpose === 'post-process'
        ? request.responseFormat?.type === 'json_object'
          ? '{"updates":[],"newCharacters":[]}'
          : '本章收到匿名信并开始调查。'
        : draftCompletions[draftCompletionIndex++] ?? DRAFT_TEXT
      if (changeDefaultAfterFirstDraft && request.purpose === 'chapter-draft' && draftCompletionIndex === 1) {
        useLLMStore.setState({ defaultModelId: 'changed-default-model' })
      }
      const complete = () => {
        emit('llm:stream-chunk', { requestId, chunk: completion })
        emit('llm:stream-done', { requestId, fullText: completion, finishReason: 'stop' })
      }
      if (deferDraftCompletion && request.purpose === 'chapter-draft') {
        pendingDraftCompletions.push(complete)
      } else {
        queueMicrotask(complete)
      }
      return { requestId, started: true }
    }
    if (channel === 'fs:check-exists') return false
    if (channel === 'fs:list-dir') return args[0] === PROJECT_PATH ? fileTree() : []
    if (channel === 'db:blueprint-get-all') return [blueprint(), blueprint(2)]
    if (channel === 'db:blueprint-get') return blueprint(Number(args[0]))
    if (channel === 'db:character-get-all') {
      return [{ id: 1, name: '沈砺', role: 'protagonist', currentState: null }]
    }
    if (channel === 'db:project-core-get') {
      return { premise: '雨夜来信开启调查。', charactersArch: '', worldbuilding: '', synopsis: '' }
    }
    if (channel === 'db:draft-get-latest') {
      return draftRecord?.chapterNumber === Number(args[0]) ? draftRecord : null
    }
    if (channel === 'db:draft-get-finalized') return null
    if (channel === 'db:draft-get-full') return draftRecord
    if (channel === 'db:draft-next-version') return 1
    if (channel === 'db:draft-create') {
      const input = args[0] as { chapterNumber: number; version: number; content: string; wordCount: number }
      draftRecord = {
        id: 101,
        chapterNumber: input.chapterNumber,
        version: input.version,
        status: 'draft',
        wordCount: input.wordCount,
        createdAt: '2026-08-28T00:00:00.000Z',
        source: 'write',
        content: input.content,
      }
      return { success: true, id: draftRecord.id }
    }
    if (channel === 'db:draft-list') return draftRecord ? [draftRecord] : []
    if (channel === 'db:draft-get-meta') return draftRecord
    if (channel === 'db:revision-get-pending' || channel === 'db:review-list') return []
    if (channel === 'chapter:list-incomplete-deletions') {
      return { success: true, operations: [] }
    }
    if (channel === 'finalization:commit') {
      if (!draftRecord) throw new Error('Missing generated draft before finalization')
      draftRecord = { ...draftRecord, status: 'finalized' }
      return {
        success: true,
        committed: true,
        finalizationId: 'finalization-browser-1',
        contentHash: 'd'.repeat(64),
        contentRevision: 0,
        draftId: draftRecord.id,
        publicationStatus: 'published',
      }
    }
    if (channel === 'kb:import-text') {
      return { success: true, chunkCount: 1, docId: 'knowledge-browser-1' }
    }
    if (channel === 'db:finalization-link-knowledge-document') return { success: true }
    if (channel === 'db:continuity-save-finalized') return { success: true }
    if (channel === 'db:blueprint-update-notes') return { success: true, updated: true }
    if (channel === 'db:character-roster-read') {
      return { status: 'empty', revision: 0, entries: [] }
    }
    if (channel === 'db:post-process-get-latest-run') {
      return postProcessRunCreated
        ? {
          id: 701,
          sourceLabel: '第1章定稿',
          allCriticalPassed: postProcessSteps.filter(step => step.critical).every(step => step.ok),
          createdAt: '2026-08-28T00:00:00.000Z',
          updatedAt: '2026-08-28T00:00:00.000Z',
        }
        : null
    }
    if (channel === 'db:post-process-create-run') {
      const input = args[0] as { steps: Array<{ key: string; label: string; critical: boolean }> }
      postProcessRunCreated = true
      postProcessSteps = input.steps.map(step => ({
        stepKey: step.key,
        label: step.label,
        critical: step.critical,
        ok: false,
        completedAt: null,
        errorMsg: null,
        lastAttemptAt: '',
        attemptCount: 0,
      }))
      return { success: true, id: 701 }
    }
    if (channel === 'db:post-process-get-steps') return postProcessSteps
    if (channel === 'db:post-process-mark-step-ok') {
      const stepKey = String(args[1])
      postProcessSteps = postProcessSteps.map(step => step.stepKey === stepKey
        ? {
          ...step,
          ok: true,
          completedAt: '2026-08-28T00:00:01.000Z',
          lastAttemptAt: '2026-08-28T00:00:01.000Z',
          attemptCount: 1,
        }
        : step)
      return { success: true }
    }
    if (channel === 'db:post-process-mark-step-failed') {
      const stepKey = String(args[1])
      const errorMsg = String(args[2])
      postProcessSteps = postProcessSteps.map(step => step.stepKey === stepKey
        ? {
          ...step,
          ok: false,
          errorMsg,
          lastAttemptAt: '2026-08-28T00:00:01.000Z',
          attemptCount: 3,
        }
        : step)
      return { success: true }
    }
    throw new Error(`Unexpected IPC channel in batch completion browser test: ${channel}`)
  })

  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn((channel: string, callback: (data: unknown) => void) => {
        const channelListeners = listeners.get(channel) ?? new Set<(data: unknown) => void>()
        channelListeners.add(callback)
        listeners.set(channel, channelListeners)
        return () => channelListeners.delete(callback)
      }),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
}

beforeEach(() => {
  draftRecord = null
  draftCompletionIndex = 0
  draftCompletions = [DRAFT_TEXT]
  deferDraftCompletion = false
  pendingDraftCompletions = []
  changeDefaultAfterFirstDraft = false
  postProcessRunCreated = false
  postProcessSteps = []
  disposeProjectService()
  clearProjectCustomPrompts()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project(), fileTree: [], loading: false })
  setActiveProjectSessionContext(PROJECT_SESSION)
  useLLMStore.setState({
    models: [generationModel()],
    defaultModelId: 'grok-browser',
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
    startWorkflow: originalWorkflowState.startWorkflow,
    addLog: originalWorkflowState.addLog,
  })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useLayoutStore.setState({ bottomPanelOpen: true, bottomTab: 'tasks' })
  useDraftStore.setState({
    draftsByChapter: {},
    loading: false,
    dataProjectKey: null,
    dataProjectSession: null,
    loadingProjectKey: null,
    loadingProjectSession: null,
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
  disposeProjectService()
  setActiveProjectSessionContext(null)
  clearProjectCustomPrompts()
  useDraftStore.setState(originalDraftState)
  useEditorStore.setState(originalEditorState)
  useLayoutStore.setState(originalLayoutState)
  useLLMStore.setState(originalLLMState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
})

describe('batch chapter completion mode browser flow', () => {
  it.each([
    {
      locale: 'zh-CN',
      mode: 'draft_review',
      modeLabel: '生成草稿待审',
      startLabel: '启动批量创作',
      taskLog: '开始第1章：生成草稿待审。',
      treeSection: '草稿箱',
      chapterLabel: '第1章 雨夜来信',
      editorState: '草稿',
      reviewLabel: 'AI 审稿',
    },
    {
      locale: 'en-US',
      mode: 'draft_review',
      modeLabel: 'Generate review drafts',
      startLabel: 'Start batch writing',
      taskLog: 'Starting Chapter 1: generate a review draft.',
      treeSection: 'Draft box',
      chapterLabel: 'Chapter 1 雨夜来信',
      editorState: 'Draft',
      reviewLabel: 'AI review',
    },
    {
      locale: 'zh-CN',
      mode: 'auto_finalize',
      modeLabel: '自动定稿',
      startLabel: '确认自动定稿并启动',
      taskLog: '开始第1章：生成草稿、自动定稿并完成后处理。',
      treeSection: '正文章节',
      chapterLabel: '第1章 雨夜来信',
      editorState: '已定稿（只读）',
      reviewLabel: 'AI 审稿',
    },
    {
      locale: 'en-US',
      mode: 'auto_finalize',
      modeLabel: 'Auto-finalize',
      startLabel: 'Confirm auto-finalize and start',
      taskLog: 'Starting Chapter 1: generate, auto-finalize, and post-process.',
      treeSection: 'Manuscript chapters',
      chapterLabel: 'Chapter 1 雨夜来信',
      editorState: 'Finalized (read-only)',
      reviewLabel: 'AI review',
    },
  ] as const)(
    'renders visible $locale $mode tree, editor, review, and task-log state',
    async ({ locale, mode, modeLabel, startLabel, taskLog, treeSection, chapterLabel, editorState, reviewLabel }) => {
      useLocaleStore.setState({ locale })
      deferDraftCompletion = true
      initProjectService()
      await act(async () => root?.render(<VisibleBatchShell />))

      await act(async () => page.getByRole('radio', { name: modeLabel }).click())
      if (mode === 'auto_finalize') {
        await act(async () => page.getByRole('button', {
          name: locale === 'en-US' ? 'Review auto-finalize' : '继续确认自动定稿',
        }).click())
      }
      await act(async () => page.getByRole('button', { name: startLabel }).click())

      await vi.waitFor(() => expect(pendingDraftCompletions).toHaveLength(1))
      await vi.waitFor(() => {
        expect(container?.querySelector('[data-testid="task-panel"]')?.textContent).toContain(taskLog)
      })

      await act(async () => pendingDraftCompletions.shift()?.())
      await vi.waitFor(() => {
        expect(useWorkflowStore.getState().history[0]?.status).toBe('completed')
      })
      await vi.waitFor(() => {
        const treeText = container?.querySelector('[data-testid="project-tree"]')?.textContent ?? ''
        const editor = container?.querySelector('[data-testid="chapter-editor"]')
        expect(treeText).toContain(treeSection)
        expect(treeText).toContain(chapterLabel)
        expect(editor?.textContent).toContain(editorState)
        if (mode === 'draft_review') {
          expect(editor?.textContent).toContain(reviewLabel)
        } else {
          expect(editor?.textContent).not.toContain(reviewLabel)
        }
      })

      const prose = page.getByTestId('chapter-editor').getByRole('textbox')
      if (mode === 'draft_review') {
        const editedText = locale === 'en-US'
          ? 'Author-editable batch draft prose.'
          : '作者可编辑的批量草稿正文。'
        await act(async () => prose.fill(editedText))
        await expect.element(prose).toHaveTextContent(editedText)
      } else {
        await expect.element(prose).toHaveTextContent(DRAFT_TEXT)
      }
    },
  )

  it('feeds the frozen first review draft tail into the second provider prompt without finalized or post-process work', async () => {
    draftCompletions = [FIRST_DRAFT_TEXT, DRAFT_TEXT]
    changeDefaultAfterFirstDraft = true
    await act(async () => {
      root?.render(<BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />)
    })

    await act(async () => page.getByRole('spinbutton', { name: '本次章节数' }).fill('2'))
    await act(async () => page.getByRole('button', { name: '启动批量创作' }).click())

    await vi.waitFor(() => {
      expect(useWorkflowStore.getState().history[0]?.status).toBe('completed')
    })

    const draftRequests = invoke.mock.calls
      .filter(([channel, , request]) => (
        channel === 'llm:generate-stream'
        && (request as { purpose?: string } | undefined)?.purpose === 'chapter-draft'
      ))
      .map(([, , request]) => request as { messages: Array<{ content: string }> })
    expect(draftRequests).toHaveLength(2)
    expect(draftRequests[1].messages.map(message => message.content).join('\n')).toContain(FIRST_DRAFT_TAIL)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'llm:begin-execution-lease'))
      .toEqual([
        ['llm:begin-execution-lease', 'grok-browser'],
        ['llm:begin-execution-lease', 'grok-browser'],
      ])
    expect(invoke.mock.calls.some(([channel]) => (
      channel === 'db:draft-get-finalized'
      || channel === 'finalization:commit'
      || channel === 'kb:import-text'
      || channel === 'db:blueprint-update-notes'
      || String(channel).startsWith('db:character-roster-')
      || String(channel).startsWith('db:post-process-')
    ))).toBe(false)
  })

  it('creates an editable draft in the project tree without finalization side effects', async () => {
    await act(async () => {
      root?.render(<BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />)
    })

    await expect.element(page.getByRole('radio', { name: '生成草稿待审' })).toBeChecked()
    await act(async () => page.getByRole('button', { name: '启动批量创作' }).click())

    await vi.waitFor(() => {
      expect(useWorkflowStore.getState().history[0]?.status).toBe('completed')
    })

    expect(useProjectStore.getState().fileTree).toEqual(fileTree())
    expect(useDraftStore.getState().draftsByChapter[1]?.[0]).toMatchObject({
      id: 101,
      status: 'draft',
    })
    expect(useEditorStore.getState().tabs).toEqual([
      expect.objectContaining({
        filePath: 'vela://draft/101',
        type: 'chapter',
        content: DRAFT_TEXT,
        savedContent: DRAFT_TEXT,
      }),
    ])
    expect(useEditorStore.getState().tabs[0]?.dirty).not.toBe(true)
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      title: '批量草稿待审 — 第1–1章',
      steps: [expect.objectContaining({
        name: '第1章：生成草稿待审',
        result: '第1章草稿已生成并保存，等待审稿。',
      })],
    })
    expect(useWorkflowStore.getState().history[0]?.steps[0]?.logs.some(log => (
      log.includes('开始第1章：生成草稿待审。')
    ))).toBe(true)
    expect(invoke).toHaveBeenCalledWith('llm:begin-execution-lease', 'grok-browser')
    expect(invoke.mock.calls.some(([channel]) => (
      channel === 'finalization:commit'
      || channel === 'kb:import-text'
      || String(channel).startsWith('db:post-process-')
    ))).toBe(false)
  })

  it('confirms and completes auto-finalize with a read-only project result and post-processing log', async () => {
    initProjectService()
    await act(async () => {
      root?.render(<BatchChapterCreationDialog isOpen startChapterNumber={1} onClose={vi.fn()} />)
    })

    await act(async () => page.getByRole('radio', { name: '自动定稿' }).click())
    await expect.element(page.getByText(/发布实体稿并运行角色与连续性后处理/)).toBeVisible()
    await act(async () => page.getByRole('button', { name: '继续确认自动定稿' }).click())
    expect(invoke.mock.calls.some(([channel]) => channel === 'finalization:commit')).toBe(false)

    await expect.element(page.getByText('即将自动定稿第1–1章（共1章）。完成后章节只读，不能直接编辑。')).toBeVisible()
    await act(async () => page.getByRole('button', { name: '确认自动定稿并启动' }).click())

    await vi.waitFor(() => {
      const completedRun = useWorkflowStore.getState().history[0]
      expect({ status: completedRun?.status, error: completedRun?.error }).toEqual({
        status: 'completed',
        error: undefined,
      })
      expect(useDraftStore.getState().draftsByChapter[1]?.[0]?.status).toBe('finalized')
    })

    expect(useProjectStore.getState().fileTree).toEqual(fileTree())
    expect(useEditorStore.getState().tabs.some(tab => (
      tab.filePath === 'vela://draft/101' && tab.draftStatus !== 'finalized'
    ))).toBe(false)
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      title: '批量自动定稿 — 第1–1章',
      steps: [expect.objectContaining({
        name: '第1章：自动定稿与后处理',
        result: '第1章已定稿，后处理全部通过。',
      })],
    })
    expect(useWorkflowStore.getState().history[0]?.steps[0]?.logs.some(log => (
      log.includes('开始第1章：生成草稿、自动定稿并完成后处理。')
      && !log.includes('生成草稿待审')
    ))).toBe(true)
    expect(invoke.mock.calls.some(([channel]) => channel === 'finalization:commit')).toBe(true)
    expect(invoke.mock.calls.some(([channel]) => channel === 'kb:import-text')).toBe(true)
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:post-process-mark-step-ok')).toBe(true)
  })
})
