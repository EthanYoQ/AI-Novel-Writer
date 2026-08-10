import { afterEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../../stores/llm-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { BaseWorkflowCommand, type CommandExecuteParams } from '../base-command'

type GenerateStreamArguments = Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>

class CompletionProbeCommand extends BaseWorkflowCommand {
  async execute(params: CommandExecuteParams): Promise<string> {
    void params
    return ''
  }

  run(callbacks: StepCallbacks, context: WorkflowContext): Promise<string> {
    return this.callLLM(
      '普通 JSON 工作流',
      'system',
      callbacks,
      { responseFormat: { type: 'json_object' } },
      context,
    )
  }

  runStructuredBatch(callbacks: StepCallbacks, context: WorkflowContext): Promise<string> {
    return this.callLLMWithBoundedCompletion(
      '返回目录 JSON',
      'system',
      callbacks,
      { mode: 'replace-structured-output', maxContinuations: 2 },
      { responseFormat: { type: 'json_object' } },
      context,
    )
  }

  runStructuredBatchWithForgedRequestTemperature(callbacks: StepCallbacks, context: WorkflowContext): Promise<string> {
    const contaminatedOptions = {
      responseFormat: { type: 'json_object' },
      temperature: 0.01,
    } as unknown as { responseFormat: { type: string }; thinking?: boolean; maxTokens?: number; purpose?: string }
    return this.callLLMWithBoundedCompletion(
      '返回目录 JSON',
      'system',
      callbacks,
      { mode: 'replace-structured-output', maxContinuations: 2 },
      contaminatedOptions,
      context,
    )
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
    useLLMStore.setState({ defaultModelId: null, models: [] })
  })

  it('keeps ordinary callLLM fail-closed after a single length completion even with JSON responseFormat', async () => {
    const generateStream = vi.fn(async (_messages, streamCallbacks) => {
      streamCallbacks.onDone?.('半截结果', undefined, 'length')
      return `request-${generateStream.mock.calls.length}`
    })
    useLLMStore.setState({
      defaultModelId: 'model',
      generateStream,
    })

    await expect(new CompletionProbeCommand().run(callbacks, context))
      .rejects.toThrow('AI 输出达到模型最大长度，结果不完整')
    expect(generateStream).toHaveBeenCalledTimes(1)
  })

  it('requires the explicit bounded-completion seam before retrying a structured batch', async () => {
    const generateStream = vi.fn(async (_messages, streamCallbacks) => {
      const callNumber = generateStream.mock.calls.length
      streamCallbacks.onDone?.(
        callNumber === 1 ? '{"blueprints":[' : '{"blueprints":[]}',
        undefined,
        callNumber === 1 ? 'length' : 'stop',
      )
      return `request-${callNumber}`
    })
    useLLMStore.setState({
      defaultModelId: 'model',
      generateStream,
      models: [{
        id: 'model',
        name: 'Probe',
        provider: 'custom',
        protocol: 'openai',
        modelName: 'probe',
        apiKey: '',
        baseUrl: 'https://example.invalid',
        temperature: 0.7,
        maxTokens: 4096,
        purposes: ['generation'],
        capabilities: {
          contextWindowTokens: 8192,
          maxOutputTokens: 4096,
          reasoning: false,
          structuredOutput: true,
          usage: false,
        },
      }],
    })

    await expect(new CompletionProbeCommand().runStructuredBatch(callbacks, context))
      .resolves.toBe('{"blueprints":[]}')
    expect(generateStream).toHaveBeenCalledTimes(2)
  })

  it('does not forward a forged request-level temperature through either bounded completion attempt', async () => {
    const generateStream = vi.fn(async (
      _messages: GenerateStreamArguments[0],
      streamCallbacks: GenerateStreamArguments[1],
      _modelId?: GenerateStreamArguments[2],
      _options?: GenerateStreamArguments[3],
    ) => {
      void _modelId
      void _options
      const callNumber = generateStream.mock.calls.length
      streamCallbacks.onDone?.(
        callNumber === 1 ? '{"blueprints":[' : '{"blueprints":[]}',
        undefined,
        callNumber === 1 ? 'length' : 'stop',
      )
      return `request-${callNumber}`
    })
    useLLMStore.setState({
      defaultModelId: 'model',
      generateStream,
    })

    await expect(new CompletionProbeCommand().runStructuredBatchWithForgedRequestTemperature(callbacks, context))
      .resolves.toBe('{"blueprints":[]}')

    expect(generateStream).toHaveBeenCalledTimes(2)
    for (const call of generateStream.mock.calls) {
      expect(call[3]).not.toHaveProperty('temperature')
    }
  })
})
