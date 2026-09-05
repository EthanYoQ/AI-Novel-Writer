import { useLLMStore } from '../../../../stores/llm-store'
import type { ModelExecutionLeaseReceipt } from '../../../../shared/ipc-channels'
import {
  createGenerationRuntime,
  type GenerationRuntimeEnvironment,
} from '../../../generation/generation-runtime'
import type { WorkflowGenerationRuntimeDependencies } from '../base-command'

const DEFAULT_CAPABILITY_EVIDENCE: ModelExecutionLeaseReceipt['capabilityEvidence'] = {
  source: {
    contextWindowTokens: 'unknown',
    maxOutputTokens: 'user-operational-cap',
    featureFlags: 'unknown',
  },
  subjectFingerprint: 'c'.repeat(64),
  contextWindowTokens: null,
  maxOutputTokens: 8192,
  reasoning: null,
  structuredOutput: true,
  usage: null,
}

function leaseReceipt(
  modelId: string,
  capabilityEvidence: ModelExecutionLeaseReceipt['capabilityEvidence'],
): ModelExecutionLeaseReceipt {
  return {
    leaseId: `test-workflow-lease-${modelId}`,
    modelId,
    provider: 'custom',
    protocol: 'openai',
    modelName: modelId,
    modelRevision: 'a'.repeat(64),
    endpointFingerprint: 'b'.repeat(64),
    capabilityEvidence,
    createdAt: 1000,
    expiresAt: 61_000,
  }
}

/** Creates a test adapter that preserves old stream doubles behind the public runtime seam. */
export function createWorkflowRuntimeDependencies(
  capabilityEvidence: ModelExecutionLeaseReceipt['capabilityEvidence'] = DEFAULT_CAPABILITY_EVIDENCE,
): WorkflowGenerationRuntimeDependencies {
  return {
    createRuntime(options) {
      const frozenModelId = useLLMStore.getState().defaultModelId ?? 'test-model'
      const environment: GenerationRuntimeEnvironment = {
        snapshotDefaultModelId: () => frozenModelId,
        beginModelExecution: async () => leaseReceipt(frozenModelId, capabilityEvidence),
        completeWithLease: request => new Promise((resolve, reject) => {
          const store = useLLMStore.getState()
          store.generateStream(
            [...request.messages],
            {
              onDone: (content, usage, finishReason) => resolve({ content, usage, finishReason }),
              onError: error => reject(new Error(error)),
            },
            frozenModelId,
            {
              modelExecutionLeaseId: request.leaseId,
              purpose: request.purpose,
              creativeStrategy: request.creativeStrategy,
              reasoningStage: request.reasoningStage,
              maxTokens: request.plan.maxOutputTokens,
              responseFormat: request.plan.responseFormat,
            },
          ).catch(reject)
        }),
        closeModelExecution: async () => {},
      }
      return createGenerationRuntime(options, environment)
    },
  }
}

/** Default test adapter for ordinary workflow-command fixtures. */
export const workflowRuntimeDependencies = createWorkflowRuntimeDependencies()
