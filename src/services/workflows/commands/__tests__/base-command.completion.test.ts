import { afterEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../../stores/llm-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { BaseWorkflowCommand, type CommandExecuteParams } from '../base-command'

class CompletionProbeCommand extends BaseWorkflowCommand {
  async execute(params: CommandExecuteParams): Promise<string> {
    void params
    return ''
  }

  run(callbacks: StepCallbacks, context: WorkflowContext): Promise<string> {
    return this.callLLM('prompt', 'system', callbacks, undefined, context)
  }
}

const context: WorkflowContext = {
  runId: 'completion-probe',
  projectPath: 'C:\\novels\\probe',
  projectSession: { projectId: 'probe', leaseId: 'lease-probe', projectPath: 'C:\\novels\\probe' },
  data: {},
  cancelled: false,
}

const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}

describe('BaseWorkflowCommand completion boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useLLMStore.setState({ defaultModelId: null })
  })

  it('rejects an explicitly length-truncated stream before a workflow can persist it', async () => {
    useLLMStore.setState({
      defaultModelId: 'model',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.('半截结果', undefined, 'length')
        return 'request-1'
      }),
    })

    await expect(new CompletionProbeCommand().run(callbacks, context))
      .rejects.toThrow('输出达到模型最大长度')
  })
})
