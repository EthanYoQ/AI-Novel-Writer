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
  useProjectStore.setState({
    currentProject: project(projectAPath) as never,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  useProjectStore.setState({ currentProject: null })
})

describe('GenerateFieldCommand project identity', () => {
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
