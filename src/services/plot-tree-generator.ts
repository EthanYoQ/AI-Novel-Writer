import {
  assertPlotTreeSnapshot,
  type PlotTreeSnapshot,
  type PlotTreeSourceBundle,
} from '../shared/plot-tree'
import type { LLMFinishReason, ProjectSessionContext } from '../shared/ipc-channels'
import type { WritingLanguage } from '../shared/writing-language'
import { promptLanguageText } from './prompt-language'
import { GenerationHarnessError } from './generation/generation-harness'
import {
  createGenerationRuntime,
  type CreateGenerationRuntimeOptions,
  type GenerationRuntime,
} from './generation/generation-runtime'

export const PLOT_TREE_GENERATION_BUDGET = Object.freeze({
  maxAttempts: 2,
  maxRequestedOutputTokens: 16_384,
  maxRequestedOutputTokensPerAttempt: 8192,
  deadlineMs: 10 * 60_000,
})

const PLOT_TREE_SOURCE_LIMITS = Object.freeze({
  synopsisCharacters: 6_000,
  labelCharacters: 160,
  detailCharacters: 320,
  blueprints: 120,
  finalizedChapters: 120,
  narrativeThreads: 40,
  eventsPerThread: 12,
})

export interface GeneratePlotTreeInput {
  modelId: string
  projectSession: ProjectSessionContext
  sources: PlotTreeSourceBundle
  signal: AbortSignal
}

export interface PlotTreeGeneratorDependencies {
  createRuntime(options: CreateGenerationRuntimeOptions): Promise<GenerationRuntime>
  now(): string
}

export type PlotTreeResponseErrorCode = 'invalid_json' | 'invalid_contract'
export type PlotTreeGenerationErrorCode = 'DEADLINE_EXHAUSTED' | 'PROVIDER_REQUEST_FAILED'

export class PlotTreeGenerationError extends Error {
  constructor(readonly code: PlotTreeGenerationErrorCode) {
    super(code)
    this.name = 'PlotTreeGenerationError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class PlotTreeResponseError extends Error {
  constructor(readonly code: PlotTreeResponseErrorCode, message: string) {
    super(message)
    this.name = 'PlotTreeResponseError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class PlotTreeIncompleteError extends Error {
  readonly finishReason: Exclude<LLMFinishReason, 'stop'>

  constructor(writingLanguage: WritingLanguage, finishReason: Exclude<LLMFinishReason, 'stop'>) {
    const message = finishReason === 'length'
      ? promptLanguageText(
          writingLanguage,
          '剧情树输出达到模型最大长度，结果未保存，请提高最大输出 Tokens 或缩短项目资料。',
          'Plot-tree output reached the model maximum output length and was not saved. Increase maximum output tokens or shorten the project sources.',
        )
      : finishReason === 'content_filter'
        ? promptLanguageText(
            writingLanguage,
            '剧情树输出因内容限制未完成，结果未保存。',
            'Plot-tree output was stopped by the content policy and was not saved.',
          )
        : finishReason === 'cancelled'
          ? promptLanguageText(
              writingLanguage,
              '剧情树生成已取消，结果未保存。',
              'Plot-tree generation was cancelled and the result was not saved.',
            )
          : promptLanguageText(
              writingLanguage,
              '剧情树生成未正常完成，结果未保存。',
              'Plot-tree generation did not complete normally and the result was not saved.',
            )
    super(message)
    this.name = 'PlotTreeIncompleteError'
    this.finishReason = finishReason
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export function parsePlotTreeSnapshot(
  content: string,
  sources: PlotTreeSourceBundle,
  generatedAt = new Date().toISOString(),
): PlotTreeSnapshot {
  const trimmed = content.trim()
  const fenced = /^```json\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
  const parsed = JSON.parse(fenced ? fenced[1].trim() : trimmed) as Record<string, unknown>
  return assertPlotTreeSnapshot({
    version: 1,
    generatedAt,
    writingLanguage: sources.writingLanguage,
    sourceRevision: sources.sourceRevision,
    tracks: parsed.tracks,
  }, sources)
}

function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  const head = Math.ceil((maximum - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(-(maximum - head - 1))}`
}

function boundedItems<T>(values: readonly T[], maximum: number): T[] {
  if (values.length <= maximum) return [...values]
  const lastIndex = values.length - 1
  return Array.from({ length: maximum }, (_, index) => (
    values[Math.round((index * lastIndex) / (maximum - 1))]!
  ))
}

function generationFacts(sources: PlotTreeSourceBundle) {
  const limits = PLOT_TREE_SOURCE_LIMITS
  return {
    synopsis: boundedText(sources.synopsis.content, limits.synopsisCharacters),
    blueprints: boundedItems(sources.blueprints, limits.blueprints).map(blueprint => ({
      chapterNumber: blueprint.chapterNumber,
      title: boundedText(blueprint.title, limits.labelCharacters),
      purpose: boundedText(blueprint.purpose, limits.detailCharacters),
      keyEvents: boundedText(blueprint.keyEvents, limits.detailCharacters),
    })),
    finalizedChapters: boundedItems(sources.finalizedChapters, limits.finalizedChapters).map(chapter => ({
      draftId: chapter.draftId,
      chapterNumber: chapter.chapterNumber,
      title: boundedText(chapter.title, limits.labelCharacters),
      summary: boundedText(chapter.summary, limits.detailCharacters),
    })),
    narrativeThreads: boundedItems(sources.narrativeThreads, limits.narrativeThreads).map(thread => ({
      id: thread.id,
      title: boundedText(thread.title, limits.labelCharacters),
      type: boundedText(thread.type, limits.labelCharacters),
      targetStartChapter: thread.targetStartChapter,
      targetEndChapter: thread.targetEndChapter,
      authorIntent: boundedText(thread.authorIntent, limits.detailCharacters),
      status: thread.status,
      events: boundedItems(thread.events, limits.eventsPerThread).map(event => ({
        id: event.id,
        chapterNumber: event.chapterNumber,
        type: event.type,
        evidence: boundedText(event.evidence, limits.detailCharacters),
        reason: boundedText(event.reason, limits.detailCharacters),
      })),
    })),
  }
}

function responseError(
  error: unknown,
  writingLanguage: WritingLanguage,
): PlotTreeResponseError {
  const invalidJson = error instanceof SyntaxError
  const message = promptLanguageText(
    writingLanguage,
    invalidJson
      ? '模型未返回可解析的剧情树 JSON，旧快照保持不变。'
      : '模型返回的剧情树结构或来源引用无效，旧快照保持不变。',
    invalidJson
      ? 'The model did not return parseable plot-tree JSON; the previous snapshot remains unchanged.'
      : 'The model returned an invalid plot-tree structure or source reference; the previous snapshot remains unchanged.',
  )
  return new PlotTreeResponseError(invalidJson ? 'invalid_json' : 'invalid_contract', message)
}

function shouldRequestReplacement(error: unknown): boolean {
  return error instanceof PlotTreeResponseError
    || (error instanceof PlotTreeIncompleteError && error.finishReason === 'length')
}

export async function generatePlotTree(
  input: GeneratePlotTreeInput,
  dependencies: PlotTreeGeneratorDependencies = {
    createRuntime: options => createGenerationRuntime(options),
    now: () => new Date().toISOString(),
  },
): Promise<PlotTreeSnapshot> {
  const runtime = await dependencies.createRuntime({
    budget: PLOT_TREE_GENERATION_BUDGET,
    modelId: input.modelId,
    projectSession: input.projectSession,
  })
  try {
    return await runtime.execute(async ({ session }) => {
      const facts = JSON.stringify(generationFacts(input.sources))
      const task = (replacement: boolean) => ({
        purpose: replacement ? 'plot-tree-snapshot-replacement' : 'plot-tree-snapshot',
        reasoningStage: 'planning' as const,
        output: 'structured-data' as const,
        messages: [
          {
            role: 'system' as const,
            content: promptLanguageText(
              input.sources.writingLanguage,
              [
                '你是小说剧情结构编辑。把给定的情节总大纲、章节蓝图、已定稿章节摘要和作者确认的叙事线索归纳为只读剧情树。',
                '区分 main 主线与 subplot 支线；每条支线必须用 parentTrackId 关联一条主线，主线不能有 parentTrackId。planned 只能来自章节蓝图或人工叙事计划，occurred 只能来自已定稿章节或已确认叙事事件。',
                '情节总大纲只用于归纳轨道和摘要，不是可引用来源；绝不能在事件 sources 中引用它，也绝不能输出 source.type="synopsis"。每个事件必须至少引用一个同章节的真实来源，且只能使用以下格式：{"type":"blueprint","chapterNumber":1}、{"type":"finalized-chapter","draftId":1,"chapterNumber":1}、{"type":"narrative-thread","planId":1}、{"type":"narrative-thread","planId":1,"eventId":1,"chapterNumber":1}。不得编造 ID 或章节。',
                '只输出 JSON 对象：{"tracks":[{"id":"stable-id","title":"","role":"main","startChapter":1,"endChapter":1,"summary":"","events":[{"status":"planned|occurred","chapterNumber":1,"summary":"","sources":[]}]}]}。仅 subplot 轨道增加 parentTrackId。不要输出解释或 Markdown。',
                ...(replacement ? ['上一轮结果已完全丢弃。请从给定资料重新生成一个完整替代 JSON，不得续写或引用上一轮结果。'] : []),
              ].join('\n'),
              [
                'You are a fiction plot-structure editor. Derive a read-only plot tree from the supplied synopsis, chapter blueprints, finalized chapter summaries, and author-confirmed narrative threads.',
                'Separate main tracks from subplot tracks. Every subplot must reference one main track with parentTrackId; main tracks must not have parentTrackId. planned must be supported by a chapter blueprint or human narrative plan; occurred must be supported by a finalized chapter or confirmed narrative event.',
                'The synopsis is context for synthesizing tracks and summaries, not a citable source. Never cite it in event sources and never emit source.type="synopsis". Every event must cite at least one real source for the same chapter using only these forms: {"type":"blueprint","chapterNumber":1}, {"type":"finalized-chapter","draftId":1,"chapterNumber":1}, {"type":"narrative-thread","planId":1}, or {"type":"narrative-thread","planId":1,"eventId":1,"chapterNumber":1}. Never invent an ID or chapter.',
                'Return only one JSON object: {"tracks":[{"id":"stable-id","title":"","role":"main","startChapter":1,"endChapter":1,"summary":"","events":[{"status":"planned|occurred","chapterNumber":1,"summary":"","sources":[]}]}]}. Add parentTrackId only to subplot tracks. Do not return explanations or Markdown.',
                ...(replacement ? ['The previous result was discarded in full. Generate one complete replacement JSON from the supplied facts; do not continue or quote the previous result.'] : []),
              ].join('\n'),
            ),
          },
          { role: 'user' as const, content: facts },
        ],
      })
      const complete = async (replacement: boolean): Promise<PlotTreeSnapshot> => {
        const outcome = await session.complete(task(replacement), { signal: input.signal })
        if (outcome.status !== 'completed') {
          throw new PlotTreeIncompleteError(input.sources.writingLanguage, outcome.finishReason)
        }
        try {
          return parsePlotTreeSnapshot(outcome.content, input.sources, dependencies.now())
        } catch (error) {
          throw responseError(error, input.sources.writingLanguage)
        }
      }

      try {
        return await complete(false)
      } catch (error) {
        if (!shouldRequestReplacement(error)) throw error
        return complete(true)
      }
    })
  } catch (error) {
    if (error instanceof GenerationHarnessError
      && (error.code === 'DEADLINE_EXHAUSTED' || error.code === 'PROVIDER_REQUEST_FAILED')) {
      throw new PlotTreeGenerationError(error.code)
    }
    throw error
  } finally {
    await runtime.close().catch(() => {})
  }
}
