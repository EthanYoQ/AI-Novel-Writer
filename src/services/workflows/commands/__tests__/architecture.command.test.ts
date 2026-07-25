import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { GenerateConfigCommand } from '../architecture.command'

const projectAPath = 'C:\\novels\\A'
const projectBPath = 'C:\\novels\\B'
const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}
const context: WorkflowContext = {
  runId: 'architecture-config-run',
  projectPath: projectAPath,
  projectSession: { projectId: 'main', leaseId: 'lease-main', projectPath: projectAPath },
  data: {},
  cancelled: false,
}

function project(path: string) {
  return {
    id: 'main',
    name: path,
    path,
    sessionLease: `lease-${path === projectAPath ? 'main' : 'other'}`,
    novelConfig: {},
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

describe('GenerateConfigCommand error boundaries', () => {
  it('preserves the project-switch error instead of reporting it as invalid JSON', async () => {
    let resolveLlm: ((value: string) => void) | undefined
    const command = new GenerateConfigCommand('idea', 100, 3000, vi.fn())
    vi.spyOn(
      command as unknown as { callLLMWithBuilder: () => Promise<string> },
      'callLLMWithBuilder',
    ).mockImplementation(() => new Promise<string>((resolve) => { resolveLlm = resolve }))

    const execution = command.execute({ step: {}, context, callbacks })
    await vi.waitFor(() => expect(resolveLlm).toBeTypeOf('function'))
    useProjectStore.setState({ currentProject: project(projectBPath) as never })
    resolveLlm!('{"genre":"玄幻"}')

    await expect(execution).rejects.toThrow('当前项目已切换，智能配置结果未应用')
  })

  it('preserves save errors after valid JSON parsing', async () => {
    const command = new GenerateConfigCommand('idea', 100, 3000, vi.fn())
    vi.spyOn(
      command as unknown as { callLLMWithBuilder: () => Promise<string> },
      'callLLMWithBuilder',
    ).mockResolvedValue('{"genre":"玄幻"}')
    useProjectStore.setState({
      saveProject: vi.fn().mockRejectedValue(new Error('磁盘写入失败')),
    })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('磁盘写入失败')
  })
})
