import {
  assertPlotTreeSnapshot,
  hasUsablePlotTreeEventSource,
  type PlotTreeEvent,
  type PlotTreeEventStatus,
  type PlotTreeSnapshot,
  type PlotTreeSourceReference,
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
  maxAttempts: 1,
  maxRequestedOutputTokens: 8192,
  maxRequestedOutputTokensPerAttempt: 8192,
  deadlineMs: 10 * 60_000,
})

export const PLOT_TREE_INPUT_MAX_CHARACTERS = 220_000

const PLOT_TREE_SOURCE_LIMITS = Object.freeze({
  synopsisCharacters: 6_000,
  labelCharacters: 160,
  detailCharacters: 320,
  largeProjectThreshold: 120,
  largeProjectSynopsisCharacters: 3_000,
  largeProjectLabelCharacters: 48,
  largeProjectDetailCharacters: 64,
  largeProjectEventDetailCharacters: 24,
  blueprints: 200,
  finalizedChapters: 200,
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

export class PlotTreeSourceError extends Error {
  readonly code = 'NO_EVENT_SOURCES'

  constructor() {
    super('NO_EVENT_SOURCES')
    this.name = 'PlotTreeSourceError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class PlotTreeSourceLimitError extends Error {
  readonly code = 'SOURCE_LIMIT_EXCEEDED'

  constructor(readonly maximum: number) {
    super('SOURCE_LIMIT_EXCEEDED')
    this.name = 'PlotTreeSourceLimitError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class PlotTreeInputLimitError extends Error {
  readonly code = 'SOURCE_INPUT_TOO_LARGE'

  constructor(readonly maximumCharacters: number) {
    super('SOURCE_INPUT_TOO_LARGE')
    this.name = 'PlotTreeInputLimitError'
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
  return strictSnapshot(parsePlotTreeJSON(content).tracks, sources, generatedAt)
}

function strictSnapshot(
  tracks: unknown,
  sources: PlotTreeSourceBundle,
  generatedAt: string,
): PlotTreeSnapshot {
  return assertPlotTreeSnapshot({
    version: 1,
    generatedAt,
    writingLanguage: sources.writingLanguage,
    sourceRevision: sources.sourceRevision,
    tracks,
  }, sources)
}

function parsePlotTreeJSON(content: string): Record<string, unknown> {
  const trimmed = content.trim()
  const fenced = /^```json\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
  return JSON.parse(fenced ? fenced[1].trim() : trimmed) as Record<string, unknown>
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactEventSource(
  value: unknown,
  status: PlotTreeEventStatus,
  chapterNumber: number,
  sources: PlotTreeSourceBundle,
  generatedAt: string,
): PlotTreeSourceReference | null {
  try {
    return strictSnapshot([{
      id: 'source-check', title: 'source-check', role: 'main',
      startChapter: chapterNumber, endChapter: chapterNumber, summary: 'source-check',
      events: [{ status, chapterNumber, summary: 'source-check', sources: [value] }],
    }], sources, generatedAt).tracks[0]!.events[0]!.sources[0]!
  } catch {
    return null
  }
}

function normalizePlotTreeSnapshot(
  parsed: Record<string, unknown>,
  sources: PlotTreeSourceBundle,
  generatedAt: string,
): PlotTreeSnapshot {
  const tracks = (Array.isArray(parsed.tracks) ? parsed.tracks : []).flatMap((candidate) => {
    const track = object(candidate)
    if (!track || !Array.isArray(track.events)) return []
    const events = track.events.flatMap((candidateEvent) => {
      const event = object(candidateEvent)
      if (!event || !['planned', 'occurred'].includes(String(event.status))
        || !Number.isSafeInteger(event.chapterNumber) || !Array.isArray(event.sources)) return []
      const status = event.status as PlotTreeEventStatus
      const chapterNumber = event.chapterNumber as number
      const seen = new Set<string>()
      const eventSources = event.sources.flatMap((value) => {
        const source = exactEventSource(value, status, chapterNumber, sources, generatedAt)
        const key = JSON.stringify(source)
        if (!source || seen.has(key)) return []
        seen.add(key)
        return [source]
      })
      return eventSources.length > 0 ? [{ ...event, status, chapterNumber, sources: eventSources }] : []
    })
    if (events.length === 0) return []
    const chapters = events.map(event => event.chapterNumber)
    return [{ ...track, startChapter: Math.min(...chapters), endChapter: Math.max(...chapters), events }]
  })
  return strictSnapshot(tracks, sources, generatedAt)
}

function deterministicPlotTreeSnapshot(
  sources: PlotTreeSourceBundle,
  generatedAt: string,
): PlotTreeSnapshot {
  const finalizedByChapter = new Map<number, typeof sources.finalizedChapters[number]>()
  for (const chapter of sources.finalizedChapters) {
    const current = finalizedByChapter.get(chapter.chapterNumber)
    if ((chapter.summary.trim() || chapter.title.trim())
      && exactEventSource(
        { type: 'finalized-chapter', draftId: chapter.draftId, chapterNumber: chapter.chapterNumber },
        'occurred', chapter.chapterNumber, sources, generatedAt,
      )
      && (!current || chapter.draftId > current.draftId)) {
      finalizedByChapter.set(chapter.chapterNumber, chapter)
    }
  }
  const candidates: PlotTreeEvent[] = [
    ...[...finalizedByChapter.values()].map(chapter => ({
      status: 'occurred', chapterNumber: chapter.chapterNumber,
      summary: chapter.summary.trim() || chapter.title.trim(),
      sources: [{ type: 'finalized-chapter', draftId: chapter.draftId, chapterNumber: chapter.chapterNumber }],
    } as PlotTreeEvent)),
    ...sources.blueprints.filter(blueprint => !finalizedByChapter.has(blueprint.chapterNumber)).map(blueprint => ({
      status: 'planned', chapterNumber: blueprint.chapterNumber,
      summary: blueprint.keyEvents.trim() || blueprint.purpose.trim() || blueprint.title.trim(),
      sources: [{ type: 'blueprint', chapterNumber: blueprint.chapterNumber }],
    } as PlotTreeEvent)),
    ...sources.narrativeThreads.flatMap(thread => [{
      status: 'planned', chapterNumber: thread.targetStartChapter,
      summary: thread.authorIntent.trim() || thread.title.trim(),
      sources: [{ type: 'narrative-thread', planId: thread.id }],
    } as PlotTreeEvent, ...thread.events.filter(event => (
      event.chapterNumber >= thread.targetStartChapter && event.chapterNumber <= thread.targetEndChapter
    )).map(event => ({
      status: 'occurred', chapterNumber: event.chapterNumber,
      summary: event.evidence.trim() || event.reason.trim(),
      sources: [{ type: 'narrative-thread', planId: thread.id, eventId: event.id, chapterNumber: event.chapterNumber }],
    } as PlotTreeEvent)),
    ]),
  ]

  const seen = new Set<string>()
  const sortedEvents = candidates.filter((event) => {
    const source = exactEventSource(event.sources[0], event.status, event.chapterNumber, sources, generatedAt)
    const key = JSON.stringify(source)
    if (!event.summary || !source || seen.has(key)) return false
    event.sources = [source]
    seen.add(key)
    return true
  }).sort((left, right) => (
    left.chapterNumber - right.chapterNumber
    || left.status.localeCompare(right.status)
    || JSON.stringify(left.sources[0]).localeCompare(JSON.stringify(right.sources[0]))
  ))
  if (sortedEvents.length === 0) throw new PlotTreeSourceError()
  return strictSnapshot([{
    id: 'source-backed-progress',
    title: promptLanguageText(sources.writingLanguage, '剧情进展', 'Plot progress'),
    role: 'main',
    startChapter: sortedEvents[0].chapterNumber,
    endChapter: sortedEvents.at(-1)!.chapterNumber,
    summary: promptLanguageText(
      sources.writingLanguage,
      '基于当前章节与叙事线索的只读进展。',
      'Read-only progress from current chapters and narrative threads.',
    ),
    events: sortedEvents,
  }], sources, generatedAt)
}

function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  const head = Math.ceil((maximum - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(-(maximum - head - 1))}`
}

function generationFacts(sources: PlotTreeSourceBundle) {
  const limits = PLOT_TREE_SOURCE_LIMITS
  const largeProject = sources.blueprints.length > limits.largeProjectThreshold
    || sources.finalizedChapters.length > limits.largeProjectThreshold
  const labelCharacters = largeProject ? limits.largeProjectLabelCharacters : limits.labelCharacters
  const detailCharacters = largeProject ? limits.largeProjectDetailCharacters : limits.detailCharacters
  const eventDetailCharacters = largeProject ? limits.largeProjectEventDetailCharacters : limits.detailCharacters
  const synopsisCharacters = largeProject ? limits.largeProjectSynopsisCharacters : limits.synopsisCharacters
  return {
    synopsis: boundedText(sources.synopsis.content, synopsisCharacters),
    blueprints: sources.blueprints.map(blueprint => ({
      chapterNumber: blueprint.chapterNumber,
      title: boundedText(blueprint.title, labelCharacters),
      purpose: boundedText(blueprint.purpose, detailCharacters),
      keyEvents: boundedText(blueprint.keyEvents, detailCharacters),
    })),
    finalizedChapters: sources.finalizedChapters.map(chapter => ({
      draftId: chapter.draftId,
      chapterNumber: chapter.chapterNumber,
      title: boundedText(chapter.title, labelCharacters),
      summary: boundedText(chapter.summary, detailCharacters),
    })),
    narrativeThreads: sources.narrativeThreads.map(thread => ({
      id: thread.id,
      title: boundedText(thread.title, labelCharacters),
      type: boundedText(thread.type, labelCharacters),
      targetStartChapter: thread.targetStartChapter,
      targetEndChapter: thread.targetEndChapter,
      authorIntent: boundedText(thread.authorIntent, detailCharacters),
      status: thread.status,
      events: thread.events.map(event => ({
        id: event.id,
        chapterNumber: event.chapterNumber,
        type: event.type,
        evidence: boundedText(event.evidence, eventDetailCharacters),
        reason: boundedText(event.reason, eventDetailCharacters),
      })),
    })),
  }
}

export async function generatePlotTree(
  input: GeneratePlotTreeInput,
  dependencies: PlotTreeGeneratorDependencies = {
    createRuntime: options => createGenerationRuntime(options),
    now: () => new Date().toISOString(),
  },
): Promise<PlotTreeSnapshot> {
  if (!hasUsablePlotTreeEventSource(input.sources)) throw new PlotTreeSourceError()
  if (input.sources.blueprints.length > PLOT_TREE_SOURCE_LIMITS.blueprints
    || input.sources.finalizedChapters.length > PLOT_TREE_SOURCE_LIMITS.finalizedChapters) {
    throw new PlotTreeSourceLimitError(PLOT_TREE_SOURCE_LIMITS.blueprints)
  }
  const facts = JSON.stringify(generationFacts(input.sources))
  if (facts.length > PLOT_TREE_INPUT_MAX_CHARACTERS) {
    throw new PlotTreeInputLimitError(PLOT_TREE_INPUT_MAX_CHARACTERS)
  }
  const runtime = await dependencies.createRuntime({
    budget: PLOT_TREE_GENERATION_BUDGET,
    modelId: input.modelId,
    projectSession: input.projectSession,
  })
  try {
    return await runtime.execute(async ({ session }) => {
      const task = {
        purpose: 'plot-tree-snapshot',
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
              ].join('\n'),
              [
                'You are a fiction plot-structure editor. Derive a read-only plot tree from the supplied synopsis, chapter blueprints, finalized chapter summaries, and author-confirmed narrative threads.',
                'Separate main tracks from subplot tracks. Every subplot must reference one main track with parentTrackId; main tracks must not have parentTrackId. planned must be supported by a chapter blueprint or human narrative plan; occurred must be supported by a finalized chapter or confirmed narrative event.',
                'The synopsis is context for synthesizing tracks and summaries, not a citable source. Never cite it in event sources and never emit source.type="synopsis". Every event must cite at least one real source for the same chapter using only these forms: {"type":"blueprint","chapterNumber":1}, {"type":"finalized-chapter","draftId":1,"chapterNumber":1}, {"type":"narrative-thread","planId":1}, or {"type":"narrative-thread","planId":1,"eventId":1,"chapterNumber":1}. Never invent an ID or chapter.',
                'Return only one JSON object: {"tracks":[{"id":"stable-id","title":"","role":"main","startChapter":1,"endChapter":1,"summary":"","events":[{"status":"planned|occurred","chapterNumber":1,"summary":"","sources":[]}]}]}. Add parentTrackId only to subplot tracks. Do not return explanations or Markdown.',
              ].join('\n'),
            ),
          },
          { role: 'user' as const, content: facts },
        ],
      }
      const outcome = await session.complete(task, { signal: input.signal })
      if (outcome.status !== 'completed') {
        throw new PlotTreeIncompleteError(input.sources.writingLanguage, outcome.finishReason)
      }
      const generatedAt = dependencies.now()
      let parsed: Record<string, unknown>
      try {
        parsed = parsePlotTreeJSON(outcome.content)
      } catch {
        return deterministicPlotTreeSnapshot(input.sources, generatedAt)
      }
      try {
        return strictSnapshot(parsed.tracks, input.sources, generatedAt)
      } catch {
        try {
          return normalizePlotTreeSnapshot(parsed, input.sources, generatedAt)
        } catch {
          return deterministicPlotTreeSnapshot(input.sources, generatedAt)
        }
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
