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
      genre: 'speculative thriller',
      subGenre: 'time-loop mystery',
      targetAudience: 'general',
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
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useLayoutStore.setState(originalLayoutState)
  useLLMStore.setState(originalLLMState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
})

describe('workflow launch language seams', () => {
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
      Object.defineProperty(window, 'velaAPI', {
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
      const stepLabels = Array.from(dialog.querySelectorAll('label'))
      expect(stepLabels).toHaveLength(4)
      await act(async () => {
        for (const label of stepLabels.slice(1)) label.click()
      })
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
