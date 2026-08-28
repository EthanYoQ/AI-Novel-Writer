import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, type WorkflowContext } from '../../../stores/workflow-store'
import ArchitectureConfirmDialog from '../ArchitectureConfirmDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
})

describe('workflow launch language seams', () => {
  it.each([
    { uiLocale: 'zh-CN', writingLanguage: 'zh-CN', title: 'AI 生成故事架构', button: /确认生成/ },
    { uiLocale: 'zh-CN', writingLanguage: 'en-US', title: 'AI 生成故事架构', button: /确认生成/ },
    { uiLocale: 'en-US', writingLanguage: 'zh-CN', title: 'Generate story architecture with AI', button: /Generate \(/ },
    { uiLocale: 'en-US', writingLanguage: 'en-US', title: 'Generate story architecture with AI', button: /Generate \(/ },
  ] as const)(
    'launches a real workflow with UI $uiLocale and writing $writingLanguage kept independent',
    async ({ uiLocale, writingLanguage, title, button }) => {
      const currentProject = project(writingLanguage)
      const projectSession = {
        projectId: currentProject.id,
        leaseId: currentProject.sessionLease!,
        projectPath: currentProject.path,
      }
      const observed: Array<Pick<WorkflowContext, 'writingLanguage' | 'uiLocale'>> = []
      const onClose = vi.fn()
      useLocaleStore.setState({ locale: uiLocale, initialized: true })
      useProjectStore.setState({ currentProject })
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
          invoke: vi.fn(async () => ({ success: true })),
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
      await act(async () => root?.render(
        <ArchitectureConfirmDialog
          isOpen
          onClose={onClose}
          archStatus={{ premise: false, characters: false, worldbuilding: false, synopsis: false }}
          initialSelectedSteps={['premise']}
          onConfirm={async () => {
            await useWorkflowStore.getState().startWorkflow({
              type: 'architecture_generation',
              title: 'Browser language seam',
              projectPath: currentProject.path,
              projectSession,
              steps: [{
                name: 'capture frozen context',
                description: 'capture frozen workflow languages',
                executor: async (_step, context) => {
                  observed.push({
                    writingLanguage: context.writingLanguage,
                    uiLocale: context.uiLocale,
                  })
                },
              }],
            })
          }}
        />,
      ))

      await expect.element(page.getByText(title, { exact: true })).toBeVisible()
      await act(async () => page.getByRole('button', { name: button }).click())
      await vi.waitFor(() => expect(useWorkflowStore.getState().history).toHaveLength(1))

      expect(observed).toEqual([{ writingLanguage, uiLocale }])
      expect(useWorkflowStore.getState().history[0]).toMatchObject({
        writingLanguage,
        uiLocale,
        status: 'completed',
      })
      expect(onClose).toHaveBeenCalledOnce()
    },
  )
})
