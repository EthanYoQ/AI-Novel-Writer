import { promptLanguageText } from './prompt-language'
import {
  createGenerationRuntime,
  type CreateGenerationRuntimeOptions,
  type GenerationRuntime,
} from './generation/generation-runtime'

import { buildNarrativeThreadPlanTask, buildNarrativeThreadEventTask, parseNarrativeThreadPlanCandidates, parseNarrativeThreadEventCandidates, NARRATIVE_THREAD_CANDIDATE_BUDGET, type GenerateNarrativeThreadPlanCandidateInput, type GenerateNarrativeThreadEventCandidateInput, type NarrativeThreadPlanCandidate, type NarrativeThreadEventCandidate } from '../shared/narrative-thread-generation-pure'
export * from '../shared/narrative-thread-generation-pure'

export interface NarrativeThreadCandidateGenerator {
  generatePlanCandidates(input: GenerateNarrativeThreadPlanCandidateInput): Promise<NarrativeThreadPlanCandidate[]>
  generateEventCandidates(input: GenerateNarrativeThreadEventCandidateInput): Promise<NarrativeThreadEventCandidate[]>
}

export interface NarrativeThreadCandidateGeneratorDependencies {
  createRuntime(options: CreateGenerationRuntimeOptions): Promise<GenerationRuntime>
}

export function createNarrativeThreadCandidateGenerator(
  dependencies: NarrativeThreadCandidateGeneratorDependencies = {
    createRuntime: options => createGenerationRuntime(options),
  },
): NarrativeThreadCandidateGenerator {
  return {
    async generatePlanCandidates(input) {
      const runtime = await dependencies.createRuntime({
        budget: NARRATIVE_THREAD_CANDIDATE_BUDGET,
        modelId: input.modelId,
      })
      try {
        const outcome = await runtime.execute(({ session }) => session.complete(buildNarrativeThreadPlanTask(input), { signal: input.signal }))
        if (outcome.status !== 'completed' || outcome.finishReason !== 'stop') {
          throw new Error(promptLanguageText(
            input.writingLanguage,
            '叙事线索计划候选生成未完整完成',
            'Narrative-thread plan candidate generation did not complete.',
          ))
        }
        const candidates = parseNarrativeThreadPlanCandidates(outcome.content, input.totalChapters)
        if (candidates.length === 0) throw new Error(promptLanguageText(
          input.writingLanguage,
          '模型未返回有效的叙事线索计划候选',
          'The model did not return any valid narrative-thread plan candidates.',
        ))
        return candidates
      } finally {
        await runtime.close().catch(() => {})
      }
    },
    async generateEventCandidates(input) {
      const runtime = await dependencies.createRuntime({
        budget: NARRATIVE_THREAD_CANDIDATE_BUDGET,
        modelId: input.modelId,
      })
      try {
        const outcome = await runtime.execute(({ session }) => session.complete(buildNarrativeThreadEventTask(input), { signal: input.signal }))
        if (outcome.status !== 'completed' || outcome.finishReason !== 'stop') {
          throw new Error(promptLanguageText(
            input.writingLanguage,
            '叙事线索事件候选生成未完整完成',
            'Narrative-thread event candidate generation did not complete.',
          ))
        }
        const candidates = parseNarrativeThreadEventCandidates(outcome.content, input.finalizedContent)
        if (candidates.length === 0) throw new Error(promptLanguageText(
          input.writingLanguage,
          '模型未返回带有效定稿证据的事件候选',
          'The model did not return any event candidates with valid finalized-manuscript evidence.',
        ))
        return candidates
      } finally {
        await runtime.close().catch(() => {})
      }
    },
  }
}

export const narrativeThreadCandidateGenerator = createNarrativeThreadCandidateGenerator()
