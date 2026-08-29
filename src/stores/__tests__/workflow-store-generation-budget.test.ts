import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LLMFinishReason, ModelExecutionLeaseReceipt } from '../../shared/ipc-channels'
import {
  createGenerationRuntime,
  type GenerationRuntimeEnvironment,
} from '../../services/generation/generation-runtime'
import {
  BaseWorkflowCommand,
  type CommandExecuteParams,
} from '../../services/workflows/commands/base-command'
import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'
import { useWorkflowStore } from '../workflow-store'

const projectPath = 'C:\\test-project'
const projectSession = {
  projectId: 'test-project',
  leaseId: 'lease-test-project',
  projectPath,
}

function leaseReceipt(): ModelExecutionLeaseReceipt {
  return {
    leaseId: 'model-execution-lease-a',
    modelId: 'model-a',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'model-a-v1',
    modelRevision: 'a'.repeat(64),
    endpointFingerprint: 'b'.repeat(64),
    capabilityEvidence: {
      source: {
        contextWindowTokens: 'unknown',
        maxOutputTokens: 'legacy-profile',
        featureFlags: 'unknown',
      },
      subjectFingerprint: 'c'.repeat(64),
      contextWindowTokens: 16_384,
      maxOutputTokens: 4096,
      reasoning: false,
      structuredOutput: true,
      usage: true,
    },
    createdAt: 1000,
    expiresAt: 61_000,
  }
}

function environment(finishReason: LLMFinishReason): GenerationRuntimeEnvironment {
  return {
    snapshotDefaultModelId: () => 'model-a',
    beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt()),
    completeWithLease: vi.fn().mockResolvedValue({
      content: finishReason === 'stop' ? '{"ok":true}' : '',
      finishReason,
    }),
    closeModelExecution: vi.fn().mockResolvedValue(undefined),
  }
}

class BudgetedGenerationCommand extends BaseWorkflowCommand {
  constructor(
    finishReason: LLMFinishReason,
    private readonly attempts = 1,
  ) {
    const runtimeEnvironment = environment(finishReason)
    super({
      createRuntime: options => createGenerationRuntime(options, runtimeEnvironment),
    })
  }

  execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('structured', params, async () => {
      let content = ''
      for (let attempt = 0; attempt < this.attempts; attempt += 1) {
        content = await this.callLLM(
          'Return one JSON object.',
          'You are a structured fiction planner.',
          params.callbacks,
          {
            purpose: 'workflow-budget-diagnostic',
            reasoningStage: 'planning',
            responseFormat: { type: 'json_object' },
            promptBudget: {
              limitUtf8Bytes: 2048,
              sections: [
                {
                  sectionName: 'system-instructions',
                  messageIndex: 0,
                  finalText: 'You are a structured fiction planner.',
                },
                {
                  sectionName: 'task',
                  messageIndex: 1,
                  finalText: 'Return one JSON object.',
                },
              ],
            },
          },
          params.context,
        )
      }
      return content
    })
  }
}

beforeEach(() => {
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
  useProjectStore.setState({
    currentProject: {
      id: 'test-project',
      name: 'Test',
      path: projectPath,
      sessionLease: projectSession.leaseId,
      novelConfig: {},
    } as never,
  })
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
})

describe('workflow generation prompt budget diagnostics', () => {
  it.each([
    ['successful', 'stop', 'completed'],
    ['content-filtered', 'content_filter', 'failed'],
  ] as const)('retains a real %s attempt receipt on the workflow and step', async (
    _label,
    finishReason,
    expectedStatus,
  ) => {
    const command = new BudgetedGenerationCommand(finishReason)

    await useWorkflowStore.getState().startWorkflow({
      type: 'architecture_generation',
      title: 'Budget diagnostics',
      projectPath,
      projectSession,
      steps: [{
        name: 'Generate structured plan',
        description: 'Generate one protected structured response',
        executor: (step, context, callbacks) => command.execute({ step, context, callbacks }),
      }],
    })

    const run = useWorkflowStore.getState().history[0]
    const expectedReport = expect.objectContaining({
      totalUtf8Bytes: expect.any(Number),
      limitUtf8Bytes: 2048,
      reservedOutputTokens: 4096,
      modelId: 'model-a',
      errorCode: 'OK',
      sections: [
        { sectionName: 'system-instructions', utf8Bytes: 37 },
        { sectionName: 'task', utf8Bytes: 23 },
      ],
    })
    expect(run).toMatchObject({
      status: expectedStatus,
      promptBudgetReport: expectedReport,
      steps: [expect.objectContaining({ promptBudgetReport: expectedReport })],
    })
  })

  it('does not attribute one budget report to multiple attempts in the same step', async () => {
    const command = new BudgetedGenerationCommand('stop', 2)

    await useWorkflowStore.getState().startWorkflow({
      type: 'architecture_generation',
      title: 'Repeated budget diagnostics',
      projectPath,
      projectSession,
      steps: [{
        name: 'Generate and repair structured plan',
        description: 'Run two protected generation attempts',
        executor: (step, context, callbacks) => command.execute({ step, context, callbacks }),
      }],
    })

    const run = useWorkflowStore.getState().history[0]
    expect(run).toMatchObject({ status: 'completed' })
    expect(run?.promptBudgetReport).toBeUndefined()
    expect(run?.steps[0]?.promptBudgetReport).toBeUndefined()
  })
})
