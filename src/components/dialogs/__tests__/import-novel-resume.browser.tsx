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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

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
    if (channel === 'dialog:select-novel-files') return {
      success: true,
      preparation,
    }
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
  it('starts a fresh source run for each ordinary file selection', async () => {
    await act(async () => page.getByTestId('import-target-current').click())

    await act(async () => page.getByRole('button', { name: '选择' }).click())
    await expect.element(page.getByText('共 1 章')).toBeVisible()
    await act(async () => page.getByRole('button', { name: '选择' }).click())

    const selectionCalls = invoke.mock.calls.filter(([channel]) => channel === 'dialog:select-novel-files')
    expect(selectionCalls).toHaveLength(2)
    expect(selectionCalls[0][1]).toMatchObject({ runId: expect.any(String) })
    expect(selectionCalls[1][1]).toMatchObject({ runId: expect.any(String) })
    expect((selectionCalls[1][1] as { runId: string }).runId)
      .not.toBe((selectionCalls[0][1] as { runId: string }).runId)
  })

  it('shows the title-only error and keeps the persisted run id while retrying the corrected source', async () => {
    const parsing = importRun({
      id: 'title-only-source-run', stage: 'parsing', status: 'failed',
      sourceDisplay: [{ displayName: 'title-only.txt', mediaType: 'text/plain', size: 20 }],
      unfinishedSourceDisplay: [{ displayName: 'title-only.txt', mediaType: 'text/plain', size: 20 }],
      totalChapters: 0, manifestChapterCount: 0,
      completedChapters: 0, progressCompleted: 0, progressTotal: 1,
    })
    let selectionCount = 0
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:import-run-list-resumable') return [parsing]
      if (channel === 'dialog:select-novel-files') {
        selectionCount += 1
        if (selectionCount === 1) return {
          success: false,
          error: '一个或多个所选文件只有章节标题，没有可导入的正文。请补充小说正文后，重新选择未完成的文件。',
        }
        return {
          success: true,
          preparation: {
            classification: 'new',
            run: importRun({ id: parsing.id, rootRunId: parsing.id, stage: 'prepared' }),
            newChapterNumbers: [1], conflictChapterNumbers: [], duplicateChapterNumbers: [],
          },
        }
      }
      if (channel === 'db:project-core-get') return null
      if (channel === 'db:blueprint-get-all') return []
      return { success: true }
    })
    await act(async () => useProjectStore.setState({ currentProject: { ...project } as never }))
    await act(async () => page.getByTestId('import-target-current').click())

    await expect.element(page.getByTestId('import-unfinished-sources'))
      .toHaveTextContent('需要重新选择：title-only.txt')
    await act(async () => page.getByRole('button', { name: '继续导入' }).click())
    await expect.element(page.getByText(
      '一个或多个所选文件只有章节标题，没有可导入的正文。请补充小说正文后，重新选择未完成的文件。',
    )).toBeVisible()
    await act(async () => page.getByRole('button', { name: '继续导入' }).click())
    await expect.element(page.getByText('共 1 章')).toBeVisible()

    const selectionCalls = invoke.mock.calls.filter(([channel]) => channel === 'dialog:select-novel-files')
    expect(selectionCalls).toHaveLength(2)
    expect(selectionCalls[0][1]).toMatchObject({ runId: 'title-only-source-run' })
    expect(selectionCalls[1][1]).toMatchObject({ runId: 'title-only-source-run' })
  })

  it('lists only unfinished source names and resumes with the run-frozen locale after a UI locale switch', async () => {
    const parsing = importRun({
      id: 'partial-locale-run',
      locale: 'en-US',
      stage: 'parsing',
      status: 'failed',
      sourceDisplay: [
        { displayName: 'a-completed.txt', mediaType: 'text/plain', size: 20 },
        { displayName: 'b-needs-retry.txt', mediaType: 'text/plain', size: 30 },
      ],
      unfinishedSourceDisplay: [
        { displayName: 'b-needs-retry.txt', mediaType: 'text/plain', size: 30 },
      ],
      completedSources: 1,
      totalSources: 2,
      progressCompleted: 1,
      progressTotal: 2,
    })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:import-run-list-resumable') return [parsing]
      if (channel === 'dialog:select-novel-files') return { success: false, error: 'retry interrupted' }
      if (channel === 'db:project-core-get') return null
      if (channel === 'db:blueprint-get-all') return []
      return { success: true }
    })
    await act(async () => {
      useLocaleStore.setState({ locale: 'zh-CN' })
      useProjectStore.setState({ currentProject: { ...project } as never })
    })
    await act(async () => page.getByTestId('import-target-current').click())

    await expect.element(page.getByTestId('import-unfinished-sources'))
      .toHaveTextContent('需要重新选择：b-needs-retry.txt')
    await act(async () => page.getByRole('button', { name: '继续导入' }).click())

    const selectionCall = invoke.mock.calls.find(([channel]) => channel === 'dialog:select-novel-files')
    expect(selectionCall?.[1]).toMatchObject({
      runId: parsing.id,
      purpose: 'reference',
      locale: 'en-US',
      expectedProjectPath: project.path,
    })
  })

  it('does not reuse an ordinary selection run after the dialog closes and reopens', async () => {
    await act(async () => page.getByTestId('import-target-current').click())
    await act(async () => page.getByRole('button', { name: '选择' }).click())
    const firstSelection = invoke.mock.calls.find(([channel]) => channel === 'dialog:select-novel-files')

    await act(async () => root.render(
      <div>
        <ProjectTree />
        <div style={{ height: 360 }}><BottomPanel /></div>
        <ImportNovelDialog open={false} onClose={vi.fn()} />
      </div>,
    ))
    await act(async () => root.render(
      <div>
        <ProjectTree />
        <div style={{ height: 360 }}><BottomPanel /></div>
        <ImportNovelDialog open onClose={vi.fn()} />
      </div>,
    ))
    await act(async () => page.getByRole('button', { name: '选择' }).click())

    const selectionCalls = invoke.mock.calls.filter(([channel]) => channel === 'dialog:select-novel-files')
    expect(selectionCalls).toHaveLength(2)
    expect((selectionCalls[1][1] as { runId: string }).runId)
      .not.toBe((firstSelection?.[1] as { runId: string }).runId)
  })

  it('does not commit a file selection response after the project session changes', async () => {
    const selection = deferred<{ success: boolean; preparation: ImportRunPreparationResult }>()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:import-run-list-resumable') return []
      if (channel === 'dialog:select-novel-files') return selection.promise
      if (channel === 'db:project-core-get') return null
      if (channel === 'db:blueprint-get-all') return []
      return { success: true }
    })
    await act(async () => page.getByTestId('import-target-current').click())
    await act(async () => page.getByRole('button', { name: '选择' }).click())
    await vi.waitFor(() => expect(
      invoke.mock.calls.some(([channel]) => channel === 'dialog:select-novel-files'),
    ).toBe(true))

    await act(async () => useProjectStore.setState({
      currentProject: {
        ...project,
        id: 'replacement-project', sessionLease: 'lease-replacement', path: 'C:\\novels\\replacement',
      } as never,
    }))
    selection.resolve({ success: true, preparation })
    await act(async () => { await Promise.resolve() })

    expect(page.getByText('共 1 章').query()).toBeNull()
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('starts the persisted run from real clicks while keeping the current project tree and task logs visible', async () => {
    await chooseCurrentSource()
    await act(async () => page.getByRole('button', { name: /导入当前项目（1 章）/ }).click())

    expect(startWorkflow).toHaveBeenCalledOnce()
    expect(startWorkflow.mock.calls[0][0]).toMatchObject({ runId: 'persisted-import', uiLocale: 'zh-CN' })
    expect(invoke.mock.calls.some(([channel]) => channel === 'project:create')).toBe(false)
    expect(invoke.mock.calls.some(([channel]) => channel === 'import:inspect-source')).toBe(false)
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:import-run-prepare-inspection')).toBe(false)
    const selectionCall = invoke.mock.calls.find(([channel]) => channel === 'dialog:select-novel-files')
    expect(selectionCall?.[1]).toMatchObject({
      runId: expect.any(String), purpose: 'reference', locale: 'zh-CN', expectedProjectPath: project.path,
    })
    expect(selectionCall?.[2]).toMatchObject({
      projectId: project.id, leaseId: project.sessionLease, projectPath: project.path,
    })
    await expect.element(page.getByText('Current Project', { exact: true })).toBeVisible()
    await expect.element(page.getByText('导入参照文本与构建知识库', { exact: true })).toBeVisible()
    await expect.element(page.getByText('参照章节 1 正在写入知识库', { exact: true })).toBeVisible()
  })

  it('shows the merged new-import inspection in English without a renderer grant step', async () => {
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
    await act(async () => page.getByTestId('import-target-current').click())
    await act(async () => page.getByRole('button', { name: 'Choose' }).first().click())

    await expect.element(page.getByText('1 files selected', { exact: true })).toBeVisible()
    await expect.element(page.getByText('1 chapters', { exact: true })).toBeVisible()
    expect(invoke.mock.calls.some(([channel]) => channel === 'import:inspect-source')).toBe(false)
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
    await act(async () => {
      useWorkflowStore.setState({
        activeRuns: [{
          id: resumable.id,
          projectPath: project.path,
          projectSession: { projectId: project.id, leaseId: project.sessionLease, projectPath: project.path },
          writingLanguage: 'zh-CN', uiLocale: 'zh-CN', type: 'novel_import', title: 'Active import',
          status: 'running', currentStepIndex: 0, createdAt: '2026-01-01', steps: [],
        }],
      })
    })
    await expect.element(page.getByRole('button', { name: '继续导入' })).toBeDisabled()
    await expect.element(page.getByRole('button', { name: '重新开始' })).toBeDisabled()

    await act(async () => useWorkflowStore.setState({ activeRuns: [] }))
    await act(async () => page.getByRole('button', { name: '继续导入' }).click())

    expect(startWorkflow).toHaveBeenCalledOnce()
    expect(startWorkflow.mock.calls[0][0]).toMatchObject({ runId: 'persisted-import' })
  })

  it('continues a prepared snapshot without asking for the moved source file again', async () => {
    const prepared = importRun({
      id: 'prepared-after-move',
      status: 'ready',
      stage: 'prepared',
      sourceDisplay: [{ displayName: 'moved-away.txt', mediaType: 'text/plain', size: 20 }],
      progressCompleted: 1,
      progressTotal: 1,
    })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:import-run-list-resumable') return [prepared]
      if (channel === 'dialog:select-novel-files') throw new Error('source file no longer exists')
      if (channel === 'db:project-core-get') return null
      if (channel === 'db:blueprint-get-all') return []
      return { success: true }
    })
    await act(async () => useProjectStore.setState({ currentProject: { ...project } as never }))
    await act(async () => page.getByTestId('import-target-current').click())

    expect(page.getByRole('button', { name: '重新开始' }).query()).toBeNull()
    await act(async () => page.getByRole('button', { name: '继续导入' }).click())

    expect(startWorkflow).toHaveBeenCalledOnce()
    expect(startWorkflow.mock.calls[0][0]).toMatchObject({ runId: 'prepared-after-move' })
    expect(invoke.mock.calls.some(([channel]) => channel === 'dialog:select-novel-files')).toBe(false)
  })

  it('finalizes a fully parsed run after reopen without rereading sources and can retry a conflict', async () => {
    const parsing = importRun({
      id: 'parsed-before-crash',
      stage: 'parsing',
      status: 'ready',
      sourceDisplay: [
        { displayName: 'already-read-a.txt', mediaType: 'text/plain', size: 20 },
        { displayName: 'already-read-b.txt', mediaType: 'text/plain', size: 20 },
      ],
      totalChapters: 2,
      completedChapters: 2,
      completedSources: 2,
      totalSources: 2,
      progressCompleted: 2,
      progressTotal: 2,
    })
    const prepared = importRun({
      id: parsing.id,
      stage: 'prepared',
      status: 'ready',
      sourceDisplay: parsing.sourceDisplay,
      totalChapters: 2,
      manifestChapterCount: 2,
      progressCompleted: 0,
      progressTotal: 2,
    })
    let finalizeAttempts = 0
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-list-resumable') return [parsing]
      if (channel === 'db:import-run-finalize-parsing') {
        finalizeAttempts += 1
        expect(args[0]).toBe(parsing.id)
        if (finalizeAttempts === 1) {
          return {
            success: false,
            error: '另一个可恢复导入已包含相同来源，请先完成或取消该导入后重试',
          }
        }
        return {
          success: true,
          preparation: {
            classification: 'new',
            run: prepared,
            newChapterNumbers: [1, 2],
            conflictChapterNumbers: [],
            duplicateChapterNumbers: [],
          },
        }
      }
      if (channel === 'dialog:select-novel-files') {
        throw new Error('already parsed sources must not be read again')
      }
      if (channel === 'db:project-core-get') return null
      if (channel === 'db:blueprint-get-all') return []
      return { success: true }
    })
    await act(async () => useProjectStore.setState({ currentProject: { ...project } as never }))
    await act(async () => page.getByTestId('import-target-current').click())
    const recoveryCallOffset = invoke.mock.calls.length

    await act(async () => page.getByRole('button', { name: '继续导入' }).click())
    await expect.element(page.getByText('另一个可恢复导入已包含相同来源，请先完成或取消该导入后重试')).toBeVisible()
    expect(startWorkflow).not.toHaveBeenCalled()

    await act(async () => page.getByRole('button', { name: '继续导入' }).click())

    expect(startWorkflow).toHaveBeenCalledOnce()
    expect(startWorkflow.mock.calls[0][0]).toMatchObject({ runId: parsing.id })
    expect(invoke.mock.calls.some(([channel]) => channel === 'dialog:select-novel-files')).toBe(false)
    expect(invoke.mock.calls.slice(recoveryCallOffset)
      .filter(([channel]) => channel === 'dialog:select-novel-files' || String(channel).startsWith('db:import-run-'))
      .map(([channel]) => channel)).toEqual([
        'db:import-run-finalize-parsing',
        'db:import-run-finalize-parsing',
      ])
  })

  it('reauthorizes a restarted parsing run with its frozen English locale after the UI switches to Chinese', async () => {
    const failedParsing = importRun({
      id: 'failed-parsing', locale: 'en-US', stage: 'parsing', status: 'failed',
      sourceDisplay: [{ displayName: 'retry.txt', mediaType: 'text/plain', size: 20 }],
      completedChapters: 0, totalChapters: 0, progressCompleted: 0, progressTotal: 1,
    })
    const restartedParsing = importRun({
      id: 'restarted-parsing', locale: 'en-US', stage: 'parsing', status: 'ready',
      sourceDisplay: failedParsing.sourceDisplay, completedChapters: 0, totalChapters: 0,
      progressCompleted: 0, progressTotal: 1,
    })
    const preparedRestart = importRun({
      id: 'restarted-parsing', locale: 'en-US', stage: 'prepared', status: 'ready',
      sourceDisplay: failedParsing.sourceDisplay, totalChapters: 2, manifestChapterCount: 2,
      completedChapters: 0, progressCompleted: 1, progressTotal: 1,
    })
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-list-resumable') return [failedParsing]
      if (channel === 'db:import-run-restart') {
        expect(args[0]).toBe('failed-parsing')
        return { success: true, run: restartedParsing }
      }
      if (channel === 'dialog:select-novel-files') return {
        success: true,
        preparation: {
          classification: 'new', run: preparedRestart, newChapterNumbers: [1, 2],
          conflictChapterNumbers: [], duplicateChapterNumbers: [],
        },
      }
      if (channel === 'db:project-core-get') return null
      if (channel === 'db:blueprint-get-all') return []
      return { success: true }
    })
    await act(async () => {
      useLocaleStore.setState({ locale: 'zh-CN' })
      useProjectStore.setState({ currentProject: { ...project } as never })
    })
    await act(async () => page.getByTestId('import-target-current').click())

    await act(async () => page.getByRole('button', { name: '重新开始' }).click())

    await expect.element(page.getByText('共 2 章', { exact: true })).toBeVisible()
    const selectionCall = invoke.mock.calls.find(([channel]) => channel === 'dialog:select-novel-files')
    expect(selectionCall?.[1]).toMatchObject({
      runId: 'restarted-parsing', purpose: 'reference', locale: 'en-US',
    })
    expect(startWorkflow).not.toHaveBeenCalled()

    await act(async () => page.getByRole('button', { name: /导入当前项目（2 章）/ }).click())
    expect(startWorkflow).toHaveBeenCalledOnce()
    expect(startWorkflow.mock.calls[0][0]).toMatchObject({ runId: 'restarted-parsing', uiLocale: 'en-US' })
  })

  it('ignores a parsing restart response after the current project session changes', async () => {
    const failedParsing = importRun({ id: 'stale-parsing', stage: 'parsing', status: 'failed' })
    const restart = deferred<{ success: boolean; run: ImportRunSnapshot }>()
    let listCalls = 0
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:import-run-list-resumable') return listCalls++ === 0 ? [failedParsing] : []
      if (channel === 'db:import-run-restart') return restart.promise
      if (channel === 'db:project-core-get') return null
      if (channel === 'db:blueprint-get-all') return []
      return { success: true }
    })
    await act(async () => useProjectStore.setState({ currentProject: { ...project } as never }))
    await act(async () => page.getByTestId('import-target-current').click())

    await act(async () => page.getByRole('button', { name: '重新开始' }).click())
    await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'db:import-run-restart')).toBe(true))
    await act(async () => useProjectStore.setState({
      currentProject: {
        ...project,
        id: 'replacement-project', sessionLease: 'lease-replacement', path: 'C:\\novels\\replacement',
      } as never,
    }))
    restart.resolve({
      success: true,
      run: importRun({ id: 'stale-restarted', stage: 'parsing', status: 'ready' }),
    })
    await act(async () => { await Promise.resolve() })

    expect(invoke.mock.calls.some(([channel]) => channel === 'dialog:select-novel-files')).toBe(false)
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('shows parsing, global, and style recovery progress from each persisted stage unit', async () => {
    const parsing = importRun({
      id: 'parsing-progress', stage: 'parsing', status: 'failed',
      sourceDisplay: [{ displayName: 'parsing.txt', mediaType: 'text/plain', size: 20 }],
      completedChapters: 0, totalChapters: 8, progressCompleted: 2, progressTotal: 4,
    })
    const global = importRun({
      id: 'global-progress', stage: 'global', status: 'failed',
      sourceDisplay: [{ displayName: 'global.txt', mediaType: 'text/plain', size: 20 }],
      completedChapters: 8, totalChapters: 8, progressCompleted: 0, progressTotal: 1,
    })
    const style = importRun({
      id: 'style-progress', stage: 'style', status: 'failed',
      sourceDisplay: [{ displayName: 'style.txt', mediaType: 'text/plain', size: 20 }],
      completedChapters: 3, totalChapters: 8, progressCompleted: 1, progressTotal: 1,
    })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:import-run-list-resumable') return [parsing, global, style]
      if (channel === 'db:project-core-get') return null
      if (channel === 'db:blueprint-get-all') return []
      return { success: true }
    })
    await act(async () => useProjectStore.setState({ currentProject: { ...project } as never }))
    await act(async () => page.getByTestId('import-target-current').click())

    await expect.element(page.getByTestId('import-resumable-choice-parsing-progress')).toHaveTextContent('2/4')
    await expect.element(page.getByTestId('import-resumable-run')).toHaveTextContent('进度：2/4')
    await act(async () => page.getByTestId('import-resumable-choice-global-progress').click())
    await expect.element(page.getByTestId('import-resumable-run')).toHaveTextContent('进度：0/1')
    await act(async () => page.getByTestId('import-resumable-choice-style-progress').click())
    await expect.element(page.getByTestId('import-resumable-run')).toHaveTextContent('进度：1/1')
  })

  it('lists two unfinished runs and reauthorizes the parsing run the user selects', async () => {
    const first = importRun({
      id: 'first-run',
      sourceDisplay: [{ displayName: '星河.txt', mediaType: 'text/plain', size: 20 }],
      status: 'failed',
      stage: 'style',
    })
    const second = importRun({
      id: 'second-run',
      sourceDisplay: [{ displayName: '雨城.txt', mediaType: 'text/plain', size: 40 }],
      status: 'failed',
      stage: 'parsing',
      lastError: 'source read interrupted',
      completedChapters: 3,
      totalChapters: 8,
    })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:import-run-list-resumable') return [first, second]
      if (channel === 'dialog:select-novel-files') return {
        success: true,
        preparation: {
          classification: 'new', run: { ...second, status: 'ready', stage: 'knowledge' },
          newChapterNumbers: [1], conflictChapterNumbers: [], duplicateChapterNumbers: [],
        },
      }
      if (channel === 'db:project-core-get') return null
      if (channel === 'db:blueprint-get-all') return []
      return { success: true }
    })
    await act(async () => useProjectStore.setState({ currentProject: { ...project } as never }))
    await act(async () => page.getByTestId('import-target-current').click())

    await expect.element(page.getByTestId('import-resumable-runs')).toBeVisible()
    await expect.element(page.getByText('星河.txt', { exact: true })).toBeVisible()
    await expect.element(page.getByText('雨城.txt', { exact: true })).toBeVisible()
    await act(async () => page.getByTestId('import-resumable-choice-second-run').click())
    await act(async () => page.getByRole('button', { name: '继续导入' }).click())

    const selectionCall = invoke.mock.calls.find(([channel]) => channel === 'dialog:select-novel-files')
    expect(selectionCall?.[1]).toMatchObject({ runId: 'second-run', purpose: 'reference' })
    expect(startWorkflow).not.toHaveBeenCalled()
    await expect.element(page.getByText('共 8 章')).toBeVisible()
  })

  it('lists two unfinished runs in English and restarts the run the user selects', async () => {
    const first = importRun({
      id: 'first-run',
      locale: 'en-US',
      sourceDisplay: [{ displayName: 'stars.txt', mediaType: 'text/plain', size: 20 }],
      status: 'failed',
      stage: 'global',
    })
    const second = importRun({
      id: 'second-run',
      locale: 'en-US',
      sourceDisplay: [{ displayName: 'rain.txt', mediaType: 'text/plain', size: 40 }],
      status: 'cancelled',
      stage: 'blueprints',
    })
    const restarted = importRun({ id: 'restarted-second', locale: 'en-US', status: 'ready' })
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-list-resumable') return [first, second]
      if (channel === 'db:import-run-restart') {
        expect(args[0]).toBe('second-run')
        return { success: true, run: restarted }
      }
      if (channel === 'db:project-core-get') return null
      if (channel === 'db:blueprint-get-all') return []
      return { success: true }
    })
    await act(async () => {
      useLocaleStore.setState({ locale: 'en-US' })
      useProjectStore.setState({ currentProject: { ...project } as never })
    })
    await act(async () => page.getByTestId('import-target-current').click())

    await expect.element(page.getByText('Resumable imports', { exact: true })).toBeVisible()
    await expect.element(page.getByText('stars.txt', { exact: true })).toBeVisible()
    await expect.element(page.getByText('rain.txt', { exact: true })).toBeVisible()
    await act(async () => page.getByTestId('import-resumable-choice-second-run').click())
    await act(async () => page.getByRole('button', { name: 'Start over' }).click())

    expect(startWorkflow).toHaveBeenCalledOnce()
    expect(startWorkflow.mock.calls[0][0]).toMatchObject({ runId: 'restarted-second', uiLocale: 'en-US' })
  })
})
