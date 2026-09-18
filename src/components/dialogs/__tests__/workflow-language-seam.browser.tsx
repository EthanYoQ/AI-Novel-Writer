import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import {
  isUsableSynopsisCheckpoint,
  synopsisFactsFingerprint,
} from '../../../services/workflows/commands/architecture.command'
import WorldBuildingEditor from '../../editor/WorldBuildingEditor'

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
    await act(async () => root?.render(<WorldBuildingEditor projectKey={currentProject.path} />))

    await expect.element(page.getByText('不完整 · 检查点不可恢复', { exact: true })).toBeVisible()
    await expect.element(page.getByText('3/4 已生成', { exact: true })).toBeVisible()
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
    await act(async () => page.getByRole('button', { name: '刷新状态' }).click())
    await expect.element(page.getByText('已覆盖至第 20 章 · 待续批', { exact: true })).toBeVisible()
    await act(async () => page.getByRole('button', { name: '续批（第 21 章起）' }).click())

    await expect.element(page.getByRole('spinbutton', { name: '本次生成范围的起始章' })).toHaveValue(21)
    await expect.element(page.getByRole('spinbutton', { name: '本次生成范围的结束章' })).toHaveValue(40)
  })

  it.each([
    { uiLocale: 'zh-CN', writingLanguage: 'zh-CN', heading: '故事架构', status: '3/4 已生成', refresh: '刷新状态', generate: 'AI 生成架构', generateTitle: 'AI 生成故事架构（选择要生成的步骤）', title: 'AI 生成故事架构', button: /确认生成/, expectedLog: '生成故事前提...', expectedPrompt: '你是一位经验丰富的故事架构师', unexpectedPrompt: 'Build a compact story premise' },
    { uiLocale: 'zh-CN', writingLanguage: 'en-US', heading: '故事架构', status: '3/4 已生成', refresh: '刷新状态', generate: 'AI 生成架构', generateTitle: 'AI 生成故事架构（选择要生成的步骤）', title: 'AI 生成故事架构', button: /确认生成/, expectedLog: '生成故事前提...', expectedPrompt: 'Build a compact story premise', unexpectedPrompt: '你是一位经验丰富的故事架构师' },
    { uiLocale: 'en-US', writingLanguage: 'zh-CN', heading: 'Story architecture', status: '3/4 generated', refresh: 'Refresh status', generate: 'Generate story architecture', generateTitle: 'Generate story architecture (choose steps to generate)', title: 'Generate story architecture with AI', button: /Generate \(/, expectedLog: 'Generating story premise...', expectedPrompt: '你是一位经验丰富的故事架构师', unexpectedPrompt: 'Build a compact story premise' },
    { uiLocale: 'en-US', writingLanguage: 'en-US', heading: 'Story architecture', status: '3/4 generated', refresh: 'Refresh status', generate: 'Generate story architecture', generateTitle: 'Generate story architecture (choose steps to generate)', title: 'Generate story architecture with AI', button: /Generate \(/, expectedLog: 'Generating story premise...', expectedPrompt: 'Build a compact story premise', unexpectedPrompt: '你是一位经验丰富的故事架构师' },
  ] as const)(
    'launches the production architecture workflow with UI $uiLocale and writing $writingLanguage independent',
    async ({ uiLocale, writingLanguage, heading, status, refresh, generate, generateTitle, title, button, expectedLog, expectedPrompt, unexpectedPrompt }) => {
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
      const generateStream = vi.fn<ReturnType<typeof useLLMStore.getState>['generateStream']>(
        async (messages, callbacks) => {
          observedRequest = messages.map(message => message.content).join('\n')
          callbacks.onDone?.(generatedPremise, undefined, 'stop')
          return 'browser-provider-request'
        },
      )

      useLocaleStore.setState({ locale: uiLocale, initialized: true })
      useProjectStore.setState({ currentProject })
      useLLMStore.setState({ defaultModelId: modelId, generateStream })
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
              case 'db:project-core-update':
                persistedPremise = String((args[0] as { premise?: string }).premise ?? '')
                return { success: true }
              case 'fs:read-json':
                return { success: false, error: 'not found' }
              case 'fs:write-json':
                return { success: true }
              case 'llm:begin-execution-lease':
                return {
                  success: true,
                  lease: {
                    leaseId: 'browser-language-lease',
                    modelId,
                    provider: 'custom',
                    protocol: 'openai',
                    modelName: modelId,
                    modelRevision: 'a'.repeat(64),
                    endpointFingerprint: 'b'.repeat(64),
                    capabilityEvidence: {
                      source: {
                        contextWindowTokens: 'unknown',
                        maxOutputTokens: 'user-operational-cap',
                        featureFlags: 'unknown',
                      },
                      subjectFingerprint: 'c'.repeat(64),
                      contextWindowTokens: null,
                      maxOutputTokens: 8192,
                      reasoning: null,
                      structuredOutput: true,
                      usage: null,
                    },
                    createdAt: 1000,
                    expiresAt: 61_000,
                  },
                }
              case 'llm:close-execution-lease':
                return { success: true }
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
      document.body.append(container)
      root = createRoot(container)
      await act(async () => root?.render(<WorldBuildingEditor projectKey={currentProject.path} />))

      await expect.element(page.getByText(heading, { exact: true })).toBeVisible()
      await expect.element(page.getByText(status, { exact: true })).toBeVisible()
      await expect.element(page.getByRole('button', { name: refresh })).toHaveAttribute('title', refresh)
      const generateButton = page.getByRole('button', { name: generate })
      await expect.element(generateButton).toHaveAttribute('title', generateTitle)
      if (uiLocale === 'en-US') {
        expect(container?.textContent).not.toMatch(/[\u3400-\u9fff]/u)
      }
      await act(async () => generateButton.click())
      await expect.element(page.getByText(title, { exact: true })).toBeVisible()
      const dialog = document.querySelector('[role="dialog"]')
      if (!(dialog instanceof HTMLElement)) throw new Error('Architecture dialog did not mount')
      await expect.element(page.getByText(textForLocale(uiLocale, '科幻 · time-loop mystery', 'Science fiction · time-loop mystery'), { exact: true })).toBeVisible()
      await expect.element(page.getByText(textForLocale(uiLocale, '全龄', 'All ages'), { exact: true })).toBeVisible()
      const stepLabels = Array.from(dialog.querySelectorAll('label'))
      expect(stepLabels).toHaveLength(4)
      await act(async () => page.getByRole('button', { name: button }).click())
      await act(async () => {
        await vi.waitFor(() => expect(useWorkflowStore.getState().history).toHaveLength(1))
      })

      const completedRun = useWorkflowStore.getState().history[0]
      expect(completedRun).toMatchObject({
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
      expect(generateStream).toHaveBeenCalledOnce()
      expect(observedRequest).toContain(expectedPrompt)
      expect(observedRequest).not.toContain(unexpectedPrompt)
      expect(observedRequest).toContain('“夜航 Café”')
      expect(persistedPremise).toContain(generatedPremise)
    },
  )
})

function textForLocale(locale: 'zh-CN' | 'en-US', zh: string, en: string): string {
  return locale === 'zh-CN' ? zh : en
}
