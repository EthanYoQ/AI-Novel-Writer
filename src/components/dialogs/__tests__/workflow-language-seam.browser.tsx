import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { hashAuthorText } from '../../../shared/source-ref'
import type { ProjectData } from '../../../shared/ipc-channels'
import type { MainGenerationRunView } from '../../../services/generation/generation-runtime'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import {
  isUsableSynopsisCheckpoint,
  synopsisFactsFingerprint,
} from '../../../shared/plot-outline-checkpoint'
import { renderPlotOutlineSynopsis } from '../../../shared/plot-outline-contract'
import StageArchitecture from '../../stage/architecture/StageArchitecture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalLayoutState = useLayoutStore.getState()
const originalLLMState = useLLMStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalWorkflowState = useWorkflowStore.getState()

let root: Root | undefined
let container: HTMLDivElement | undefined

function project(writingLanguage: 'zh-CN' | 'en-US'): ProjectData {
  return {
    id: `workflow-language-${writingLanguage}`,
    sessionLease: `lease-${writingLanguage}`,
    name: `Workflow ${writingLanguage}`,
    path: `C:\\novels\\workflow-language-${writingLanguage}`,
    novelConfig: {
      writingLanguage,
      genre: '科幻',
      subGenre: 'time-loop mystery',
      targetAudience: '全龄',
      totalChapters: 12,
      wordsPerChapter: 2500,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: 'A story at “夜航 Café”.',
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

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useLayoutStore.setState(originalLayoutState)
  useLLMStore.setState(originalLLMState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
})

describe('workflow launch language seams', () => {
  it('shows a DB-partial synopsis with a missing checkpoint as unavailable, not completed or resumable', async () => {
    const currentProject = project('zh-CN')
    const projectSession = {
      projectId: currentProject.id,
      leaseId: currentProject.sessionLease!,
      projectPath: currentProject.path,
    }
    let dbSynopsis = [
      '# Plot Outline',
      '',
      'Chapters 1-3: the crew traces the signal but has not completed this batch.',
      '',
      '> ⚠ **This outline is incomplete**: generation stopped at the output length limit; the completed part above was saved automatically.',
      '> Click “Continue plot outline” in the AI output notice to resume this batch.',
    ].join('\n')
    const checkpointState: { current?: Record<string, unknown> } = {}
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    useProjectStore.setState({ currentProject })
    useWorkflowStore.setState({
      activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null,
      waitingForConfirm: false, waitingAfterStepIndex: -1,
    })
    setActiveProjectSessionContext(projectSession)
    Object.defineProperty(window, 'aiNovelAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'db:project-core-get') {
            return {
              premise: 'Existing premise. '.repeat(5),
              worldbuilding: 'Existing worldbuilding. '.repeat(5),
              synopsis: dbSynopsis,
              totalChapters: 100,
              writingLanguage: 'en-US',
            }
          }
          if (channel === 'db:character-roster-read') {
            return {
              schemaVersion: 1,
              revision: 1,
              migrationState: 'ready',
              status: 'ready',
              entries: [],
              renderedMarkdown: '# Characters\n\nExisting roster',
              projectionHash: 'projection',
              factHash: 'facts',
            }
          }
          if (channel === 'fs:read-json') {
            return checkpointState.current
              ? { success: true, data: checkpointState.current }
              : { success: false, error: 'not found' }
          }
          throw new Error(`Unexpected IPC channel: ${channel}`)
        }),
        on: vi.fn(() => () => {}),
        once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(),
      },
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<StageArchitecture projectKey={currentProject.path} />))

    const outlineBadge = () => container?.querySelector('[data-section="synopsis"] .arch-badge')?.textContent
    await vi.waitFor(() => expect(outlineBadge()).toBe('不完整'))
    expect(container.querySelector('.arch-progress')?.textContent).toBe(' · 3 / 4 已确认')
    expect(container.textContent).not.toContain('断点续写大纲')

    const confirmedBody = `Chapters 1-20: ${'The crew follows each clue and preserves cause and effect. '.repeat(4)}`.trim()
    dbSynopsis = `# Plot Outline\n\n${confirmedBody}\n\n> This outline covers chapters 1-20 of 100; the remaining chapters will be generated in later batches.`
    checkpointState.current = {
      synopsis_result: confirmedBody,
      synopsis_incomplete: false,
      synopsis_covered_to: 20,
      synopsis_range: { from: 1, to: 20 },
      synopsis_facts_fingerprint: 'stored-inputs',
      synopsis_db_hash: synopsisFactsFingerprint([dbSynopsis]),
    }
    expect(isUsableSynopsisCheckpoint(checkpointState.current, dbSynopsis, 'en-US', 100)).toBe(true)
    await act(async () => page.getByRole('button', { name: '架构的更多操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '刷新状态' }).click())
    await vi.waitFor(() => expect(outlineBadge()).toBe('部分完成 · 20 / 100 章'))
    await act(async () => page.getByRole('button', { name: '续写第 21 章起' }).click())

    await expect.element(page.getByRole('spinbutton', { name: '本次生成范围的起始章' })).toHaveValue(21)
    await expect.element(page.getByRole('spinbutton', { name: '本次生成范围的结束章' })).toHaveValue(25)
  })

  it.each([
    { read: '返回读取失败', checkpoint: async () => ({ success: false, error: 'not found' }) },
    { read: '读取时抛出异常', checkpoint: async () => { throw new Error('磁盘忙') } },
  ])('大纲停在第 16 章、分批检查点$read：都按数据库正文判为部分完成，可从第 17 章续写', async ({ checkpoint }) => {
    const currentProject = project('zh-CN')
    const projectSession = { projectId: currentProject.id, leaseId: currentProject.sessionLease!, projectPath: currentProject.path }
    const body = Array.from({ length: 16 }, (_, index) => `## 第${index + 1}章：第${index + 1}盏灯\n林舟在第${index + 1}站认出一位失踪者的座位。`).join('\n\n')
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    useProjectStore.setState({ currentProject })
    useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null, waitingForConfirm: false, waitingAfterStepIndex: -1 })
    setActiveProjectSessionContext(projectSession)
    Object.defineProperty(window, 'aiNovelAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'db:project-core-get') return {
            premise: '旧前提。'.repeat(20), worldbuilding: '旧世界观。'.repeat(20),
            synopsis: renderPlotOutlineSynopsis(body, 16, { totalChapters: 24, writingLanguage: 'zh-CN' }), totalChapters: 24, writingLanguage: 'zh-CN',
          }
          if (channel === 'db:character-roster-read') return { schemaVersion: 1, revision: 1, migrationState: 'ready', status: 'ready', entries: [], renderedMarkdown: '# 角色\n\n林舟', projectionHash: 'p', factHash: 'f' }
          if (channel === 'fs:read-json') return checkpoint()
          throw new Error(`Unexpected IPC channel: ${channel}`)
        }),
        on: vi.fn(() => () => {}),
        once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(),
      },
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<StageArchitecture projectKey={currentProject.path} />))

    await vi.waitFor(() => expect(container?.querySelector('[data-section="synopsis"] .arch-badge')?.textContent).toBe('部分完成 · 16 / 24 章'))
    await expect.element(page.getByRole('button', { name: '续写第 17 章起' })).toBeVisible()
    expect(container.textContent).not.toContain('大纲末尾还留着分批生成的说明')
  })

  it.each([
    { uiLocale: 'zh-CN', writingLanguage: 'zh-CN', heading: '故事的骨架', generate: /生成架构/, title: '生成架构', button: /开始生成/, expectedLog: '生成故事前提...', expectedPrompt: '你是一位经验丰富的故事架构师', unexpectedPrompt: 'Build a compact story premise' },
    { uiLocale: 'zh-CN', writingLanguage: 'en-US', heading: '故事的骨架', generate: /生成架构/, title: '生成架构', button: /开始生成/, expectedLog: '生成故事前提...', expectedPrompt: 'Build a compact story premise', unexpectedPrompt: '你是一位经验丰富的故事架构师' },
    { uiLocale: 'en-US', writingLanguage: 'zh-CN', heading: 'The bones of the story', generate: /(Generate|Continue) architecture/, title: 'Generate architecture', button: /^Generate \d/, expectedLog: 'Generating story premise...', expectedPrompt: '你是一位经验丰富的故事架构师', unexpectedPrompt: 'Build a compact story premise' },
    { uiLocale: 'en-US', writingLanguage: 'en-US', heading: 'The bones of the story', generate: /(Generate|Continue) architecture/, title: 'Generate architecture', button: /^Generate \d/, expectedLog: 'Generating story premise...', expectedPrompt: 'Build a compact story premise', unexpectedPrompt: '你是一位经验丰富的故事架构师' },
  ] as const)(
    'launches the production architecture workflow with UI $uiLocale and writing $writingLanguage independent',
    async ({ uiLocale, writingLanguage, heading, generate, title, button, expectedLog, expectedPrompt, unexpectedPrompt }) => {
      const currentProject = project(writingLanguage)
      const projectSession = {
        projectId: currentProject.id,
        leaseId: currentProject.sessionLease!,
        projectPath: currentProject.path,
      }
      const modelId = 'browser-language-model'
      const generatedPremise = 'A production workflow preserves “夜航 Café” exactly.'
      let persistedPremise = ''
      let observedRequest = ''
      let view: MainGenerationRunView | undefined
      let generationExecutions = 0

      useLocaleStore.setState({ locale: uiLocale, initialized: true })
      useProjectStore.setState({ currentProject })
      useLLMStore.setState({ models: [{ id: modelId, purposes: ['generation'] }] as never, defaultModelId: modelId })
      useWorkflowStore.setState({
        activeRuns: [],
        history: [],
        globalLogs: [],
        waitingRuns: {},
        currentRun: null,
        waitingForConfirm: false,
        waitingAfterStepIndex: -1,
      })
      setActiveProjectSessionContext(projectSession)
      Object.defineProperty(window, 'aiNovelAPI', {
        configurable: true,
        value: {
          invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
            switch (channel) {
              case 'db:project-core-get':
                return {
                  premise: persistedPremise,
                  worldbuilding: 'Existing English worldbuilding. '.repeat(3),
                  synopsis: 'Existing English plot outline. '.repeat(3),
                }
              case 'db:character-roster-read':
                return {
                  schemaVersion: 1,
                  revision: 1,
                  migrationState: 'ready',
                  status: 'ready',
                  entries: [],
                  renderedMarkdown: '# Characters\n\nExisting roster',
                  projectionHash: 'projection',
                  factHash: 'facts',
                }
              case 'prompt:load-global':
                return { templates: [], diagnostics: [] }
              case 'fs:check-exists':
                return false
              case 'fs:list-dir':
                if (args[0] === `${currentProject.path}/.ai-novel/skills`) return []
                throw new Error(`Unexpected IPC channel: ${channel}`)
              case 'db:project-core-commit-generated':
                expect((args[0] as { generationRunHandle: unknown }).generationRunHandle).toEqual(view?.handle)
                persistedPremise = String((args[0] as { data: { premise?: string } }).data.premise ?? '')
                return { success: true }
              case 'fs:read-json':
                return { success: false, error: 'not found' }
              case 'fs:write-json':
                return { success: true }
              case 'generation:begin': {
                const selection = args[0] as { modelId: string }
                expect(selection.modelId).toBe(modelId)
                view = {
                  handle: { projectId: projectSession.projectId, epoch: projectSession.leaseId, rootActionId: 'language-root', runId: 'language-run' },
                  status: 'running', nonReplayable: false, artifacts: [],
                  budget: { maxAttempts: 4, maxRequestedOutputTokens: 32768, maxRequestedOutputTokensPerAttempt: 8192, deadlineAt: Date.now() + 60_000 },
                }
                return structuredClone(view)
              }
              case 'generation:read':
                return structuredClone(view)
              case 'generation:execute': {
                const request = args[0] as { task: { messages: Array<{ content: string }> } }
                observedRequest = request.task.messages.map(message => message.content).join('\n')
                generationExecutions += 1
                const artifact = {
                  ...view!.handle, artifactId: 'language-artifact', attemptId: 'language-attempt',
                  revision: 1, durableRevision: 1, text: generatedPremise,
                  textHash: await hashAuthorText(generatedPremise), status: 'completed' as const,
                }
                view = { ...view!, artifacts: [artifact], status: 'completed' }
                return {
                  run: structuredClone(view),
                  outcome: {
                    status: 'completed', content: generatedPremise, finishReason: 'stop',
                    receipt: {
                      model: { id: modelId, configurationRevision: 'a'.repeat(64), endpointFingerprint: 'b'.repeat(64) },
                      capabilities: {
                        contextWindowTokens: null, maxOutputTokens: 8192, reasoning: false, structuredOutput: true, usage: false,
                        source: { contextWindowTokens: 'unknown', maxOutputTokens: 'user-operational-cap', featureFlags: 'unknown' },
                      },
                      budget: {
                        attempt: 1, maxAttempts: view!.budget.maxAttempts, requestedOutputTokens: 8192,
                        cumulativeRequestedOutputTokens: 8192, maxRequestedOutputTokens: view!.budget.maxRequestedOutputTokens,
                        maxRequestedOutputTokensPerAttempt: view!.budget.maxRequestedOutputTokensPerAttempt, deadlineAt: view!.budget.deadlineAt,
                      },
                      finishReason: 'stop',
                      visibleArtifact: { artifactId: artifact.artifactId, attemptId: artifact.attemptId, revision: artifact.revision, textHash: artifact.textHash },
                    },
                  },
                }
              }
              default:
                throw new Error(`Unexpected IPC channel: ${channel}`)
            }
          }),
          on: vi.fn(() => () => {}),
          once: vi.fn(),
          send: vi.fn(),
          setZoomLevel: vi.fn(),
          setZoomFactor: vi.fn(),
          getZoomLevel: vi.fn(() => 0),
        },
      })
      container = document.createElement('div')
      container.className = 'paper-ink'
      container.style.cssText = 'width: 1280px; height: 900px'
      document.body.append(container)
      root = createRoot(container)
      await act(async () => root?.render(<StageArchitecture projectKey={currentProject.path} />))

      await expect.element(page.getByText(heading, { exact: true })).toBeVisible()
      await act(async () => page.getByRole('button', { name: generate }).click())
      await expect.element(page.getByRole('dialog', { name: title })).toBeVisible()
      const dialog = document.querySelector('[role="dialog"]')
      if (!(dialog instanceof HTMLElement)) throw new Error('Architecture dialog did not mount')
      if (uiLocale === 'en-US') expect(dialog.textContent).not.toMatch(/[\u3400-\u9fff]/u)
      await act(async () => page.getByRole('button', { name: button }).click())
      await act(async () => {
        await vi.waitFor(() => expect(useWorkflowStore.getState().history).toHaveLength(1))
      })

      const completedRun = useWorkflowStore.getState().history[0]
      expect(completedRun, completedRun.error).toMatchObject({
        type: 'architecture_generation',
        writingLanguage,
        uiLocale,
        status: 'completed',
      })
      const stepLogs = completedRun.steps.flatMap(step => step.logs).join('\n')
      expect(stepLogs).toContain(expectedLog)
      if (uiLocale === 'en-US') {
        const visibleLogs = [
          stepLogs,
          ...useWorkflowStore.getState().globalLogs.map(log => log.message),
        ].join('\n')
        expect(visibleLogs).not.toMatch(/[\u3400-\u9fff]/u)
      }
      expect(generationExecutions).toBe(1)
      expect(observedRequest).toContain(expectedPrompt)
      expect(observedRequest).not.toContain(unexpectedPrompt)
      expect(observedRequest).toContain('“夜航 Café”')
      expect(persistedPremise).toContain(generatedPremise)
    },
  )
})
