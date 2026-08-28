import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import ImportNovelDialog from '../ImportNovelDialog'
import ProjectTree from '../../panels/sidebar/ProjectTree'
import BottomPanel from '../../panels/BottomPanel'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, type WorkflowDefinition, type WorkflowRun } from '../../../stores/workflow-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useDraftStore } from '../../../stores/draft-store'
import type { ImportRunPreparationResult, ImportRunSnapshot } from '../../../shared/import-run'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let startWorkflow: ReturnType<typeof vi.fn>
let preparation: ImportRunPreparationResult

const project = {
  id: 'current-project', sessionLease: 'lease-current', name: 'Current Project', path: 'C:\\novels\\current',
  novelConfig: {
    genre: '', subGenre: '', targetAudience: '', totalChapters: 10, wordsPerChapter: 3000,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '', worldSetting: '',
    goldenFinger: '', protagonistProfile: '', globalGuidance: '',
  },
  characterStates: '', createdAt: '', updatedAt: '',
}

function importRun(overrides: Partial<ImportRunSnapshot> = {}): ImportRunSnapshot {
  return {
    id: 'persisted-import', purpose: 'reference', rootRunId: 'persisted-import',
    effectNamespace: 'import:reference:persisted-import',
    sourceFingerprint: 'a'.repeat(64), manifestFingerprint: 'b'.repeat(64),
    sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: 20 }],
    locale: 'zh-CN', stage: 'knowledge', status: 'ready', completedBatches: {}, lastError: '',
    resumable: true, cancelRequested: false, totalChapters: 1, totalContentSize: 20,
    manifestChapterCount: 1, manifestContentSize: 20, manifestWordCount: 16,
    completedChapters: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    ...overrides,
  }
}

function activeRun(definition: WorkflowDefinition): WorkflowRun {
  return {
    id: definition.runId!, projectPath: definition.projectPath, projectSession: definition.projectSession,
    writingLanguage: 'zh-CN', uiLocale: definition.uiLocale ?? 'zh-CN', type: definition.type,
    title: definition.title, status: 'running', currentStepIndex: 0, createdAt: '2026-01-01',
    steps: definition.steps.map((step, index) => ({
      id: `${definition.runId}-${index}`, name: step.name, description: step.description,
      status: index === 0 ? 'running' : 'pending', progress: index === 0 ? 10 : 0,
      logs: index === 0 ? ['参照章节 1 正在写入知识库'] : [],
    })),
  }
}

async function chooseCurrentSource() {
  await act(async () => page.getByTestId('import-target-current').click())
  await act(async () => page.getByRole('button', { name: '选择' }).click())
  await expect.element(page.getByText('共 1 章')).toBeVisible()
}

beforeEach(async () => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLayoutStore.setState({ bottomPanelOpen: true, bottomTab: 'tasks' })
  useProjectStore.setState({
    currentProject: project as never,
    refreshFileTree: vi.fn().mockResolvedValue(undefined),
  })
  useDraftStore.setState({ draftsByChapter: {}, loadAllDrafts: vi.fn().mockResolvedValue(undefined) })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {} })
  preparation = {
    classification: 'new', run: importRun(), newChapterNumbers: [1],
    conflictChapterNumbers: [], duplicateChapterNumbers: [],
  }
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:import-run-list-resumable') return []
    if (channel === 'dialog:select-novel-files') return [{ grantId: 'grant-1', displayName: 'reference.txt' }]
    if (channel === 'import:inspect-source') return {
      success: true,
      inspection: {
        inspectionId: 'inspection-1', chapterCount: 1, totalWords: 16, totalBytes: 16,
        preview: [{ number: 1, title: 'Start', wordCount: 16 }],
      },
    }
    if (channel === 'db:import-run-prepare-inspection') return { success: true, preparation }
    if (channel === 'db:project-core-get') return null
    if (channel === 'db:blueprint-get-all') return []
    if (channel === 'db:draft-list') return []
    return { success: true }
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(),
      setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0),
    },
  })
  startWorkflow = vi.fn(async (definition: WorkflowDefinition) => {
    useWorkflowStore.setState({
      activeRuns: [activeRun(definition)],
      globalLogs: [{ time: '00:00', level: 'info', message: '参照导入任务已启动' }],
    })
    return definition.runId!
  })
  useWorkflowStore.setState({ startWorkflow: startWorkflow as never })

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(
    <div>
      <ProjectTree />
      <div style={{ height: 360 }}><BottomPanel /></div>
      <ImportNovelDialog open onClose={vi.fn()} />
    </div>,
  ))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useProjectStore.setState({ currentProject: null })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [] })
  Reflect.deleteProperty(window, 'velaAPI')
})

describe('current-project reference import', () => {
  it('starts the persisted run from real clicks while keeping the current project tree and task logs visible', async () => {
    await chooseCurrentSource()
    await act(async () => page.getByRole('button', { name: /导入当前项目（1 章）/ }).click())

    expect(startWorkflow).toHaveBeenCalledOnce()
    expect(startWorkflow.mock.calls[0][0]).toMatchObject({ runId: 'persisted-import', uiLocale: 'zh-CN' })
    expect(invoke.mock.calls.some(([channel]) => channel === 'project:create')).toBe(false)
    await expect.element(page.getByText('Current Project', { exact: true })).toBeVisible()
    await expect.element(page.getByText('导入参照文本与构建知识库', { exact: true })).toBeVisible()
    await expect.element(page.getByText('参照章节 1 正在写入知识库', { exact: true })).toBeVisible()
  })

  it('reports an exact duplicate as a no-op with no task, KB, or model side effects', async () => {
    preparation = {
      classification: 'exact-duplicate', newChapterNumbers: [], conflictChapterNumbers: [],
      duplicateChapterNumbers: [1],
    }
    await chooseCurrentSource()
    await act(async () => page.getByRole('button', { name: /导入当前项目（1 章）/ }).click())

    await expect.element(page.getByTestId('import-classification-notice')).toHaveTextContent('未创建任务，也未调用模型')
    expect(startWorkflow).not.toHaveBeenCalled()
    expect(invoke.mock.calls.some(([channel]) => String(channel).startsWith('kb:'))).toBe(false)
    expect(invoke.mock.calls.some(([channel]) => String(channel).startsWith('llm:'))).toBe(false)
  })

  it('blocks a same-number conflict and lists the actionable chapter number', async () => {
    preparation = {
      classification: 'conflict', newChapterNumbers: [], conflictChapterNumbers: [1],
      duplicateChapterNumbers: [],
    }
    await chooseCurrentSource()
    await act(async () => page.getByRole('button', { name: /导入当前项目（1 章）/ }).click())

    await expect.element(page.getByText(/以下章节号已有不同参照内容.*1/)).toBeVisible()
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('discovers a failed run after reopen and continues the same persisted run id', async () => {
    const resumable = importRun({ status: 'failed', stage: 'style', lastError: 'provider unavailable' })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:import-run-list-resumable') return [resumable]
      if (channel === 'db:project-core-get') return null
      if (channel === 'db:blueprint-get-all') return []
      return { success: true }
    })
    await act(async () => useProjectStore.setState({ currentProject: { ...project } as never }))
    await act(async () => page.getByTestId('import-target-current').click())
    await expect.element(page.getByTestId('import-resumable-run')).toHaveTextContent('provider unavailable')

    await act(async () => page.getByRole('button', { name: '继续导入' }).click())

    expect(startWorkflow).toHaveBeenCalledOnce()
    expect(startWorkflow.mock.calls[0][0]).toMatchObject({ runId: 'persisted-import' })
  })
})
