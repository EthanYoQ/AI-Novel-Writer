import type { DatabaseChannels } from '../shared/ipc-channels'
import type {
  NarrativeThreadEventType,
  NarrativeThreadPlanInput,
  NarrativeThreadView,
} from '../shared/narrative-thread'
import type { WritingLanguage } from '../shared/writing-language'
import { promptLanguageText } from './prompt-language'
import {
  createGenerationRuntime,
  type CreateGenerationRuntimeOptions,
  type GenerationRuntime,
} from './generation/generation-runtime'

export type NarrativeThreadPlanCandidate = NarrativeThreadPlanInput

export interface NarrativeThreadEventCandidate {
  type: NarrativeThreadEventType
  evidence: string
  reason: string
}

type BlueprintData = DatabaseChannels['db:blueprint-get-all']['return'][number]

export interface GenerateNarrativeThreadPlanCandidateInput {
  modelId: string
  writingLanguage: WritingLanguage
  blueprint: BlueprintData
  signal: AbortSignal
}

export interface GenerateNarrativeThreadEventCandidateInput {
  modelId: string
  writingLanguage: WritingLanguage
  plan: NarrativeThreadView
  draftId: number
  chapterNumber: number
  finalizedContent: string
  signal: AbortSignal
}

export interface NarrativeThreadCandidateGenerator {
  generatePlanCandidates(input: GenerateNarrativeThreadPlanCandidateInput): Promise<NarrativeThreadPlanCandidate[]>
  generateEventCandidates(input: GenerateNarrativeThreadEventCandidateInput): Promise<NarrativeThreadEventCandidate[]>
}

export interface NarrativeThreadCandidateGeneratorDependencies {
  createRuntime(options: CreateGenerationRuntimeOptions): Promise<GenerationRuntime>
}

export const NARRATIVE_THREAD_CANDIDATE_BUDGET = Object.freeze({
  maxAttempts: 1,
  maxRequestedOutputTokens: 4096,
  maxRequestedOutputTokensPerAttempt: 4096,
  deadlineMs: 120_000,
})

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function candidatesFromJson(content: string): unknown[] {
  const parsed = record(JSON.parse(content.trim()))
  return Array.isArray(parsed?.candidates) ? parsed.candidates.slice(0, 5) : []
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= maxLength ? text : null
}

export function parseNarrativeThreadPlanCandidates(content: string): NarrativeThreadPlanCandidate[] {
  return candidatesFromJson(content).flatMap((candidate) => {
    const value = record(candidate)
    if (!value) return []
    const title = boundedText(value.title, 120)
    const type = boundedText(value.type, 60)
    const authorIntent = boundedText(value.authorIntent, 1000)
    const targetStartChapter = value.targetStartChapter
    const targetEndChapter = value.targetEndChapter
    if (!title || !type || !authorIntent
      || !Number.isSafeInteger(targetStartChapter) || (targetStartChapter as number) < 1
      || !Number.isSafeInteger(targetEndChapter) || (targetEndChapter as number) < (targetStartChapter as number)) {
      return []
    }
    return [{
      title,
      type,
      targetStartChapter: targetStartChapter as number,
      targetEndChapter: targetEndChapter as number,
      authorIntent,
    }]
  })
}

export function parseNarrativeThreadEventCandidates(
  content: string,
  finalizedContent: string,
): NarrativeThreadEventCandidate[] {
  const normalizedSource = finalizedContent.replace(/\s+/gu, '')
  return candidatesFromJson(content).flatMap((candidate) => {
    const value = record(candidate)
    if (!value || !['planted', 'progressing', 'resolved', 'abandoned'].includes(String(value.type))) return []
    const evidence = boundedText(value.evidence, 240)
    const reason = boundedText(value.reason, 500)
    if (!evidence || !reason || !normalizedSource.includes(evidence.replace(/\s+/gu, ''))) return []
    return [{ type: value.type as NarrativeThreadEventType, evidence, reason }]
  })
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
        const outcome = await runtime.execute(({ session }) => session.complete({
          purpose: 'narrative-thread-plan-candidate',
          reasoningStage: 'planning',
          output: 'structured-data',
          messages: [
            {
              role: 'system',
              content: promptLanguageText(
                input.writingLanguage,
                '你是小说结构编辑。只从章节蓝图提出可供作者确认的叙事线索计划候选，不得声称正文事件已经发生。只输出 JSON 对象：{"candidates":[{"title":"","type":"","targetStartChapter":1,"targetEndChapter":1,"authorIntent":""}]}。最多 5 项。',
                'You are a fiction structure editor. Propose narrative-thread plan candidates from the chapter blueprint for author confirmation. Never claim that a manuscript event has occurred. Return only one JSON object: {"candidates":[{"title":"","type":"","targetStartChapter":1,"targetEndChapter":1,"authorIntent":""}]}. Maximum 5 items.',
              ),
            },
            {
              role: 'user',
              content: JSON.stringify(input.blueprint),
            },
          ],
        }, { signal: input.signal }))
        if (outcome.status !== 'completed' || outcome.finishReason !== 'stop') {
          throw new Error('叙事线索计划候选生成未完整完成')
        }
        const candidates = parseNarrativeThreadPlanCandidates(outcome.content)
        if (candidates.length === 0) throw new Error('模型未返回有效的叙事线索计划候选')
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
        const outcome = await runtime.execute(({ session }) => session.complete({
          purpose: 'narrative-thread-event-candidate',
          reasoningStage: 'review',
          output: 'structured-data',
          messages: [
            {
              role: 'system',
              content: promptLanguageText(
                input.writingLanguage,
                '你是小说定稿事实审查员。只判断给定已定稿章节是否推进了给定叙事线索。证据必须是正文中逐字出现、最多 240 字的短摘录。只输出 JSON 对象：{"candidates":[{"type":"planted|progressing|resolved|abandoned","evidence":"","reason":""}]}。最多 5 项，不得输出计划 ID、草稿 ID 或章节号。',
                'You review finalized fiction facts. Decide only whether the supplied finalized chapter advances the supplied narrative thread. Evidence must be a verbatim excerpt of at most 240 characters from the manuscript. Return only one JSON object: {"candidates":[{"type":"planted|progressing|resolved|abandoned","evidence":"","reason":""}]}. Maximum 5 items. Do not output plan IDs, draft IDs, or chapter numbers.',
              ),
            },
            {
              role: 'user',
              content: JSON.stringify({
                chapterNumber: input.chapterNumber,
                plan: {
                  title: input.plan.title,
                  type: input.plan.type,
                  targetStartChapter: input.plan.targetStartChapter,
                  targetEndChapter: input.plan.targetEndChapter,
                  authorIntent: input.plan.authorIntent,
                  currentStatus: input.plan.status,
                },
                finalizedContent: input.finalizedContent,
              }),
            },
          ],
        }, { signal: input.signal }))
        if (outcome.status !== 'completed' || outcome.finishReason !== 'stop') {
          throw new Error('叙事线索事件候选生成未完整完成')
        }
        const candidates = parseNarrativeThreadEventCandidates(outcome.content, input.finalizedContent)
        if (candidates.length === 0) throw new Error('模型未返回带有效定稿证据的事件候选')
        return candidates
      } finally {
        await runtime.close().catch(() => {})
      }
    },
  }
}

export const narrativeThreadCandidateGenerator = createNarrativeThreadCandidateGenerator()
