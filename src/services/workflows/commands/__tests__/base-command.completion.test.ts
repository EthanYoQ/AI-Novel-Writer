import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModelExecutionLeaseReceipt } from '../../../../shared/ipc-channels'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import {
  createGenerationRuntime,
  type CreateGenerationRuntimeOptions,
  type GenerationRuntime,
  type GenerationRuntimeEnvironment,
} from '../../../generation/generation-runtime'
import {
  BaseWorkflowCommand,
  WORKFLOW_GENERATION_BUDGETS,
  type CommandExecuteParams,
  type WorkflowGenerationIntent,
  type WorkflowGenerationRuntimeDependencies,
} from '../base-command'

type ProbeStep =
  | { kind: 'single' }
  | { kind: 'bounded'; contaminateOptions?: boolean }
  | { kind: 'exhaust'; commit: () => void }

class CompletionProbeCommand extends BaseWorkflowCommand<string> {
  constructor(
    dependencies: WorkflowGenerationRuntimeDependencies,
    private readonly intent: WorkflowGenerationIntent = 'structured',
  ) {
    super(dependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    const step = params.step as ProbeStep
    return this.executeWithGenerationRuntime(this.intent, params, async () => {
      if (step.kind === 'single') {
        return this.callLLM(
          '普通 JSON 工作流',
          'system',
          params.callbacks,
          { responseFormat: { type: 'json_object' } },
          params.context,
        )
      }
      if (step.kind === 'bounded') {
        const options = step.contaminateOptions
          ? ({
              responseFormat: { type: 'json_object' },
              temperature: 0.01,
              maxTokens: 999_999,
            } as unknown as { responseFormat: { type: string } })
          : { responseFormat: { type: 'json_object' } }
        return this.callLLMWithBoundedCompletion(
          '返回目录 JSON',
          'system',
          params.callbacks,
          { mode: 'replace-structured-output', maxContinuations: 2 },
          options,
          params.context,
        )
      }

      for (let index = 0; index <= WORKFLOW_GENERATION_BUDGETS.structured.maxAttempts; index += 1) {
        await this.callLLM(
          `structured request ${index}`,
          'system',
          params.callbacks,
          { responseFormat: { type: 'json_object' } },
          params.context,
        )
      }
      step.commit()
      return 'committed'
    })
  }
}

const context: WorkflowContext = {
  runId: 'completion-probe',
  projectPath: 'C:\\novels\\probe',
  projectSession: { projectId: 'probe', leaseId: 'lease-probe', projectPath: 'C:\\novels\\probe' },
  writingLanguage: 'zh-CN',
  uiLocale: 'zh-CN',
  data: {},
  cancelled: false,
}

const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}

function leaseReceipt(overrides: Partial<ModelExecutionLeaseReceipt> = {}): ModelExecutionLeaseReceipt {
  return {
    leaseId: 'workflow-lease-a',
    modelId: 'model-a',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'unknown-model',
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
      maxOutputTokens: 2048,
      reasoning: null,
      structuredOutput: true,
      usage: null,
    },
    createdAt: 1000,
    expiresAt: 61_000,
    ...overrides,
  }
}

function dependenciesFor(environment: GenerationRuntimeEnvironment): WorkflowGenerationRuntimeDependencies {
  return {
    createRuntime: (options: CreateGenerationRuntimeOptions): Promise<GenerationRuntime> => (
      createGenerationRuntime(options, environment)
    ),
  }
}

describe('BaseWorkflowCommand completion boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    { leasedCap: 16_384, expectedRequest: 8192 },
    { leasedCap: 8192, expectedRequest: 8192 },
  ])('keeps ordinary structured requests at $expectedRequest for a $leasedCap-capability lease', async ({ leasedCap, expectedRequest }) => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: '{"ok":true}', finishReason: 'stop' })
    const baseLease = leaseReceipt()
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt({
        capabilityEvidence: { ...baseLease.capabilityEvidence, maxOutputTokens: leasedCap },
      })),
      completeWithLease,
      closeModelExecution: vi.fn().mockResolvedValue(undefined),
    }

    await expect(new CompletionProbeCommand(dependenciesFor(environment)).execute({
      step: { kind: 'single' } satisfies ProbeStep,
      context,
      callbacks,
    })).resolves.toBe('{"ok":true}')

    expect(completeWithLease.mock.calls[0]?.[0].plan.maxOutputTokens).toBe(expectedRequest)
    expect(WORKFLOW_GENERATION_BUDGETS.structured.maxRequestedOutputTokens).toBe(131_072)
  })

  it.each([
    { leasedCap: 16_384, expectedRequest: 12_288 },
    { leasedCap: 8192, expectedRequest: 8192 },
  ])('uses the bounded character-architecture policy without exceeding a $leasedCap-capability lease', async ({ leasedCap, expectedRequest }) => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: '{"ok":true}', finishReason: 'stop' })
    const baseLease = leaseReceipt()
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt({
        capabilityEvidence: { ...baseLease.capabilityEvidence, maxOutputTokens: leasedCap },
      })),
      completeWithLease,
      closeModelExecution: vi.fn().mockResolvedValue(undefined),
    }

    await new CompletionProbeCommand(dependenciesFor(environment), 'character-architecture').execute({
      step: { kind: 'single' } satisfies ProbeStep,
      context,
      callbacks,
    })

    expect(completeWithLease.mock.calls[0]?.[0].plan.maxOutputTokens).toBe(expectedRequest)
    expect(WORKFLOW_GENERATION_BUDGETS['character-architecture']).toEqual({
      maxAttempts: 12,
      maxRequestedOutputTokens: 147_456,
      maxRequestedOutputTokensPerAttempt: 12_288,
      deadlineMs: 10 * 60_000,
    })
    expect(12 * WORKFLOW_GENERATION_BUDGETS['character-architecture'].maxRequestedOutputTokensPerAttempt).toBe(147_456)
  })

  it('keeps ordinary generation single-shot and fail-closed while an unknown model uses its leased cap', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: '半截结果', finishReason: 'length' })
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt()),
      completeWithLease,
      closeModelExecution: vi.fn().mockResolvedValue(undefined),
    }

    await expect(new CompletionProbeCommand(dependenciesFor(environment)).execute({
      step: { kind: 'single' } satisfies ProbeStep,
      context,
      callbacks,
    })).rejects.toThrow('AI 输出达到模型最大长度，结果不完整')

    expect(completeWithLease).toHaveBeenCalledOnce()
    expect(completeWithLease.mock.calls[0]?.[0].plan.maxOutputTokens).toBe(2048)
  })

  it('shares one frozen lease and budget across a structured continuation after the default changes', async () => {
    let defaultModelId: string | null = 'model-a'
    const beginModelExecution = vi.fn<GenerationRuntimeEnvironment['beginModelExecution']>()
      .mockResolvedValue(leaseReceipt())
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockImplementation(async () => {
        const call = completeWithLease.mock.calls.length
        defaultModelId = 'model-b'
        return call === 1
          ? { content: '{"blueprints":[', finishReason: 'length' }
          : { content: '{"blueprints":[]}', finishReason: 'stop' }
      })
    const closeModelExecution = vi.fn<GenerationRuntimeEnvironment['closeModelExecution']>()
      .mockResolvedValue(undefined)
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => defaultModelId,
      beginModelExecution,
      completeWithLease,
      closeModelExecution,
    }

    await expect(new CompletionProbeCommand(dependenciesFor(environment)).execute({
      step: { kind: 'bounded' } satisfies ProbeStep,
      context,
      callbacks,
    })).resolves.toBe('{"blueprints":[]}')

    expect(beginModelExecution).toHaveBeenCalledOnce()
    expect(beginModelExecution).toHaveBeenCalledWith('model-a')
    expect(completeWithLease).toHaveBeenCalledTimes(2)
    expect(completeWithLease.mock.calls.map(([request]) => request.leaseId))
      .toEqual(['workflow-lease-a', 'workflow-lease-a'])
    expect(closeModelExecution).toHaveBeenCalledOnce()
  })

  it('ignores forged physical request controls at the semantic command boundary', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: '{"blueprints":[', finishReason: 'length' })
      .mockResolvedValueOnce({ content: '{"blueprints":[]}', finishReason: 'stop' })
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt()),
      completeWithLease,
      closeModelExecution: vi.fn().mockResolvedValue(undefined),
    }

    await new CompletionProbeCommand(dependenciesFor(environment)).execute({
      step: { kind: 'bounded', contaminateOptions: true } satisfies ProbeStep,
      context,
      callbacks,
    })

    for (const [request] of completeWithLease.mock.calls) {
      expect(request.plan.maxOutputTokens).toBe(2048)
      expect(request).not.toHaveProperty('temperature')
      expect(request).not.toHaveProperty('maxTokens')
    }
  })

  it('exhausts the shared command budget before the domain commit callback', async () => {
    const commit = vi.fn()
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: '{"ok":true}', finishReason: 'stop' })
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt()),
      completeWithLease,
      closeModelExecution: vi.fn().mockResolvedValue(undefined),
    }

    await expect(new CompletionProbeCommand(dependenciesFor(environment)).execute({
      step: { kind: 'exhaust', commit } satisfies ProbeStep,
      context,
      callbacks,
    })).rejects.toMatchObject({ code: 'ATTEMPT_BUDGET_EXHAUSTED' })

    expect(completeWithLease).toHaveBeenCalledTimes(WORKFLOW_GENERATION_BUDGETS.structured.maxAttempts)
    expect(commit).not.toHaveBeenCalled()
  })
})
