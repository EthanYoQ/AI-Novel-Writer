import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
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
})

describe('GenerateFieldCommand project identity', () => {
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
})
