import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import { useLLMStore } from '../../../stores/llm-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import {
  useWorkflowStore,
  type WorkflowContext,
  type WorkflowDefinition,
} from '../../../stores/workflow-store'
import KnowledgeOverview from '../KnowledgeOverview'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const projectSession = {
  projectId: 'planning-project',
  leaseId: 'planning-lease',
  projectPath: 'C:/novels/planning-project',
}
const model = {
  id: 'generation-model',
  name: 'DeepSeek V3',
  provider: 'deepseek',
  protocol: 'openai',
  modelName: 'deepseek-v3',
  apiKey: 'fixture',
  baseUrl: 'https://models.example/v1',
  temperature: 0.7,
  maxTokens: 4096,
  purposes: ['generation'],
} as const

const originalProjectState = useProjectStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalLLMState = useLLMStore.getState()
const originalLayoutState = useLayoutStore.getState()
const originalWorkflowState = useWorkflowStore.getState()
const originalVelaAPI = Object.getOwnPropertyDescriptor(window, 'velaAPI')

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let startWorkflow: ReturnType<typeof vi.fn>
let generateStream: ReturnType<typeof vi.fn>

function workflowContext(definition: WorkflowDefinition, runId: string): WorkflowContext {
  return {
    runId,
    projectPath: projectSession.projectPath,
    projectSession,
    generationModelId: definition.generationModelId,
    writingLanguage: 'en-US',
    uiLocale: 'en-US',
    data: {},
    cancelled: false,
  }
}

beforeEach(async () => {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'kb:list-documents') return []
    if (channel === 'kb:stats') return { documentCount: 0, totalChunks: 0, vectorDimension: 0 }
    if (channel === 'kb:get-vector-rebuild-status') {
      return {
        embeddingConfigured: true,
        canRebuild: false,
        totalChunks: 0,
        vectorlessCount: 0,
        activeVectorDimension: 0,
      }
    }
    if (channel === 'dialog:select-knowledge-files') {
      return [{ grantId: 'planning-grant', displayName: 'characters.md' }]
    }
    if (channel === 'fs:grant-read-file') {
      return { success: true, content: 'Lin Xiao is the protagonist.' }
    }
    if (channel === 'kb:import-planning-text') {
      return { success: true, docId: 'planning-document', chunkCount: 1 }
    }
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: { invoke, on: () => () => {}, once: () => {}, send: () => {} },
  })
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
  useLayoutStore.setState({ bottomPanelOpen: false, bottomTab: 'log' })
  useProjectStore.setState({
    currentProject: {
      id: projectSession.projectId,
      name: 'Planning project',
      path: projectSession.projectPath,
      sessionLease: projectSession.leaseId,
      novelConfig: { writingLanguage: 'en-US' },
    } as never,
  })
  generateStream = vi.fn()
  useLLMStore.setState({
    models: [model] as never,
    defaultModelId: model.id,
    generateStream: generateStream as never,
  })
  startWorkflow = vi.fn(async (definition: WorkflowDefinition) => {
    const runId = `planning-run-${startWorkflow.mock.calls.length}`
    if (startWorkflow.mock.calls.length === 1) {
      const callbacks = {
        log: vi.fn(),
        setProgress: vi.fn(),
        appendText: vi.fn(),
      }
      for (const [index, step] of definition.steps.entries()) {
        await step.executor({ id: `step-${index}` } as never, workflowContext(definition, runId), callbacks)
      }
      useWorkflowStore.setState(state => ({
        history: [{ id: runId, status: 'completed' } as never, ...state.history],
      }))
    }
    return runId
  })
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    startWorkflow: startWorkflow as never,
    getResourceConflict: () => null,
  })

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<KnowledgeOverview />))
  await vi.waitFor(() => expect(page.getByRole('button', { name: 'Import planning material' }).query()).not.toBeNull())
})

afterEach(async () => {
  const cancel = page.getByRole('button', { name: 'Cancel' }).query()
  if (cancel instanceof HTMLElement) {
    await act(async () => {
      cancel.click()
      await vi.waitFor(() => expect(page.getByRole('dialog').query()).toBeNull())
    })
  }
  await act(async () => root.unmount())
  container.remove()
  useProjectStore.setState(originalProjectState)
  useLocaleStore.setState(originalLocaleState)
  useLLMStore.setState(originalLLMState)
  useLayoutStore.setState(originalLayoutState)
  useWorkflowStore.setState(originalWorkflowState)
  if (originalVelaAPI) Object.defineProperty(window, 'velaAPI', originalVelaAPI)
  else Reflect.deleteProperty(window, 'velaAPI')
})

async function importAndWaitForDisclosure() {
  await act(async () => {
    await page.getByRole('button', { name: 'Import planning material' }).click()
    await vi.waitFor(() => expect(page.getByRole('dialog').query()).not.toBeNull())
  })
}

describe('planning material import disclosure', () => {
  it('imports locally first and makes no model call when extraction is cancelled', async () => {
    await importAndWaitForDisclosure()

    const disclosure = page.getByRole('dialog').query()?.textContent ?? ''
    expect(disclosure).toContain('selected text')
    expect(disclosure).toContain('DeepSeek V3')
    expect(disclosure).toContain('https://models.example/v1')
    expect(invoke).toHaveBeenCalledWith(
      'kb:import-planning-text',
      'Lin Xiao is the protagonist.',
      'characters.md',
      projectSession.projectPath,
      projectSession,
    )

    await act(async () => {
      await page.getByRole('button', { name: 'Cancel' }).click()
      await vi.waitFor(() => expect(page.getByRole('dialog').query()).toBeNull())
    })

    expect(startWorkflow).toHaveBeenCalledOnce()
    expect(generateStream).not.toHaveBeenCalled()
  })

  it('freezes the disclosed model for the confirmed extraction workflow', async () => {
    await importAndWaitForDisclosure()
    await act(async () => useLLMStore.setState({ defaultModelId: 'different-model' }))

    await act(async () => {
      await page.getByRole('button', { name: 'Send and extract' }).click()
      await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledTimes(2))
    })

    expect(startWorkflow.mock.calls[1]?.[0]).toMatchObject({
      generationModelId: model.id,
      resourceKeys: ['character-roster'],
    })
    expect(startWorkflow.mock.calls[1]?.[0].steps).toHaveLength(2)
    expect(startWorkflow.mock.calls[1]?.[1]).toBe(true)
    expect(useLayoutStore.getState()).toMatchObject({ bottomPanelOpen: true, bottomTab: 'tasks' })
  })
})
