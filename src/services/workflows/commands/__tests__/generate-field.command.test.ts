import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { useLLMStore } from '../../../../stores/llm-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { GenerateFieldCommand as RuntimeGenerateFieldCommand } from '../generate-field.command'
import { workflowRuntimeDependencies } from './workflow-generation-runtime.fixture'

class GenerateFieldCommand extends RuntimeGenerateFieldCommand {
  constructor(...args: ConstructorParameters<typeof RuntimeGenerateFieldCommand>) {
    super(args[0], workflowRuntimeDependencies)
  }
}

const projectAPath = 'C:\\novels\\A'
const projectBPath = 'C:\\novels\\B'
const originalGenerateStream = useLLMStore.getState().generateStream
const originalDefaultModelId = useLLMStore.getState().defaultModelId
const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}
const context: WorkflowContext = {
  runId: 'field-run',
  projectPath: projectAPath,
  projectSession: { projectId: projectAPath, leaseId: 'lease-A', projectPath: projectAPath },
  writingLanguage: 'zh-CN',
  uiLocale: 'zh-CN',
  data: {},
  cancelled: false,
}

function project(path: string, writingStyle = '') {
  return {
    id: path,
    name: path,
    path,
    sessionLease: path === projectAPath ? 'lease-A' : 'lease-B',
    novelConfig: {
      genre: '玄幻',
      writingStyle,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    velaAPI: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
        if (channel === 'fs:check-exists') return false
        return { success: true }
      }),
    },
  })
  useProjectStore.setState({
    currentProject: project(projectAPath) as never,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({ generateStream: originalGenerateStream, defaultModelId: originalDefaultModelId })
})

describe('GenerateFieldCommand project identity', () => {
  it('expands a populated field without deleting the author text', async () => {
    const authorText = 'The academy bell rings only when a student disappears.'
    const addition = 'Its mechanism is tied to the sealed observatory beneath the library.'
    const observedPrompts: string[] = []
    useProjectStore.setState({
      currentProject: {
        ...project(projectAPath),
        novelConfig: {
          genre: 'Mystery',
          worldSetting: authorText,
          writingLanguage: 'en-US',
        },
      } as never,
      saveProject: vi.fn(async () => true),
    })
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn(async (messages, streamCallbacks) => {
        observedPrompts.push(messages.map((message: { content: string }) => message.content).join('\n'))
        streamCallbacks.onDone?.(addition, undefined, 'stop')
        return 'field-request'
      }),
    })

    await new GenerateFieldCommand('worldSetting').execute({
      step: {},
      context: { ...context, writingLanguage: 'en-US', uiLocale: 'en-US' },
      callbacks,
    })

    expect(observedPrompts.join('\n')).toContain(authorText)
    expect(useProjectStore.getState().currentProject?.novelConfig.worldSetting)
      .toBe(`${authorText}\n\n${addition}`)
  })

  it('sends a complete English configuration without Chinese model instructions', async () => {
    const longOutline = `A detective follows a forged flight manifest. ${'The clue remains authoritative. '.repeat(24)}`
    useProjectStore.setState({
      currentProject: {
        ...project(projectAPath),
        novelConfig: {
          genre: 'Mystery',
          targetAudience: 'Adult readers',
          coreOutline: longOutline,
          writingLanguage: 'en-US',
        },
      } as never,
      saveProject: vi.fn(async () => true),
    })
    const command = new GenerateFieldCommand('writingStyle')
    const callLlm = vi.spyOn(
      command as unknown as { callLLM: (...args: unknown[]) => Promise<string> },
      'callLLM',
    ).mockResolvedValue('Tense, scene-driven prose.')

    await command.execute({
      step: {},
      context: { ...context, writingLanguage: 'en-US', uiLocale: 'en-US' },
      callbacks,
    })

    const [prompt, systemPrompt] = callLlm.mock.calls[0]!
    expect(callLlm.mock.calls[0]?.[3]).toMatchObject({ writingSkillStage: 'planning' })
    expect(`${systemPrompt}\n${prompt}`).not.toMatch(/[\u3400-\u9fff]/u)
    expect(prompt).toContain(longOutline)
    expect(String(prompt)).toContain(longOutline.slice(500))
  })

  it('keeps single-field global guidance compact instead of requesting a chapter outline', async () => {
    useProjectStore.setState({
      currentProject: {
        ...project(projectAPath),
        novelConfig: {
          genre: 'Campus romance',
          totalChapters: 4,
          writingLanguage: 'en-US',
        },
      } as never,
      saveProject: vi.fn(async () => true),
    })
    const command = new GenerateFieldCommand('globalGuidance')
    const callLlm = vi.spyOn(
      command as unknown as { callLLM: (...args: unknown[]) => Promise<string> },
      'callLLM',
    ).mockResolvedValue('Keep each scene grounded in a concrete emotional choice.')

    await command.execute({
      step: {},
      context: { ...context, writingLanguage: 'en-US', uiLocale: 'en-US' },
      callbacks,
    })

    const [prompt] = callLlm.mock.calls[0]!
    expect(String(prompt)).not.toContain('Plan the opening, middle, ending')
    expect(String(prompt)).not.toContain('escalation frequency')
    expect(String(prompt)).toContain('4–8')
    expect(String(prompt)).toContain('must not enumerate chapters')
  })

  it('rejects generated global guidance over 600 characters before saving', async () => {
    const updateNovelConfig = vi.fn()
    const saveProject = vi.fn(async () => true)
    useProjectStore.setState({
      currentProject: {
        ...project(projectAPath),
        novelConfig: { genre: '玄幻', globalGuidance: '作者原有要求。' },
      } as never,
      updateNovelConfig,
      saveProject,
    })
    const command = new GenerateFieldCommand('globalGuidance')
    vi.spyOn(
      command as unknown as { callLLM: (...args: unknown[]) => Promise<string> },
      'callLLM',
    ).mockResolvedValue('规'.repeat(601))

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('600')

    expect(updateNovelConfig).not.toHaveBeenCalled()
    expect(saveProject).not.toHaveBeenCalled()
  })

  it('does not mutate the newly selected project when the LLM returns after a switch', async () => {
    let resolveLlm: ((value: string) => void) | undefined
    const command = new GenerateFieldCommand('writingStyle')
    vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM')
      .mockImplementation(() => new Promise<string>((resolve) => { resolveLlm = resolve }))

    const execution = command.execute({ step: {}, context, callbacks })
    await vi.waitFor(() => expect(resolveLlm).toBeTypeOf('function'))
    useProjectStore.setState({
      currentProject: project(projectBPath, 'B 项目原有文风') as never,
    })
    resolveLlm!('A 项目生成的文风')

    await expect(execution).rejects.toThrow('当前项目已切换')
    expect(useProjectStore.getState().currentProject?.novelConfig.writingStyle)
      .toBe('B 项目原有文风')
  })

  it('requires the current project to match the frozen workflow project before reading config', async () => {
    useProjectStore.setState({
      currentProject: project(projectBPath, 'B 项目原有文风') as never,
    })
    const command = new GenerateFieldCommand('writingStyle')
    const callLlm = vi.spyOn(
      command as unknown as { callLLM: () => Promise<string> },
      'callLLM',
    )

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('当前项目已切换')
    expect(callLlm).not.toHaveBeenCalled()
  })

  it('uses the frozen English UI locale for project and save failures', async () => {
    const englishContext = { ...context, uiLocale: 'en-US' as const }
    useProjectStore.setState({
      currentProject: project(projectBPath, 'Project B style') as never,
    })
    const switchedCommand = new GenerateFieldCommand('writingStyle')
    await expect(switchedCommand.execute({ step: {}, context: englishContext, callbacks }))
      .rejects.toThrow('The current project changed, so field generation stopped.')

    useProjectStore.setState({
      currentProject: project(projectAPath) as never,
      updateNovelConfig: vi.fn(),
      saveProject: vi.fn(async () => false),
    })
    const saveCommand = new GenerateFieldCommand('writingStyle')
    vi.spyOn(
      saveCommand as unknown as { callLLM: (...args: unknown[]) => Promise<string> },
      'callLLM',
    ).mockResolvedValue('Concise prose.')

    await expect(saveCommand.execute({ step: {}, context: englishContext, callbacks }))
      .rejects.toThrow('The generated field could not be saved.')
  })

  it('does not expose a provider failure through the frozen English workflow UI', async () => {
    const command = new GenerateFieldCommand('writingStyle')
    vi.spyOn(
      command as unknown as { callLLM: (...args: unknown[]) => Promise<string> },
      'callLLM',
    ).mockRejectedValue(new Error('provider-secret-field-failure'))

    let failure: unknown
    try {
      await command.execute({
        step: {},
        context: { ...context, uiLocale: 'en-US' },
        callbacks,
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('Field generation failed. Please try again.')
    expect((failure as Error).message).not.toContain('provider-secret-field-failure')
  })
})
