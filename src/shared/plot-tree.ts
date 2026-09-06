import type { NarrativeThreadEventType, NarrativeThreadStatus } from './narrative-thread'
import { WRITING_LANGUAGES, type WritingLanguage } from './writing-language'

export type PlotTreeTrackRole = 'main' | 'subplot'
export type PlotTreeEventStatus = 'planned' | 'occurred'
/** Immutable snapshot safety ceiling, independent of the project's current source range. */
export const MAX_PLOT_TREE_CHAPTER_NUMBER = 4_294_967_295

export type PlotTreeSourceReference =
  | { type: 'blueprint'; chapterNumber: number }
  | { type: 'finalized-chapter'; draftId: number; chapterNumber: number }
  | {
      type: 'narrative-thread'
      planId: number
      eventId?: number
      chapterNumber?: number
    }

export interface PlotTreeEvent {
  status: PlotTreeEventStatus
  chapterNumber: number
  summary: string
  sources: PlotTreeSourceReference[]
}

export interface PlotTreeTrack {
  id: string
  title: string
  role: PlotTreeTrackRole
  parentTrackId?: string
  startChapter: number
  endChapter: number
  summary: string
  events: PlotTreeEvent[]
}

export interface PlotTreeSnapshot {
  version: 1
  generatedAt: string
  writingLanguage: WritingLanguage
  sourceRevision?: string
  tracks: PlotTreeTrack[]
}

export interface PlotTreeNarrativeThreadSource {
  id: number
  title: string
  type: string
  targetStartChapter: number
  targetEndChapter: number
  authorIntent: string
  status: NarrativeThreadStatus
  events: Array<{
    id: number
    chapterNumber: number
    type: NarrativeThreadEventType
    evidence: string
    reason: string
  }>
}

export interface PlotTreeSourceBundle {
  writingLanguage: WritingLanguage
  synopsis: {
    content: string
  }
  blueprints: Array<{
    chapterNumber: number
    title: string
    purpose: string
    keyEvents: string
  }>
  finalizedChapters: Array<{
    draftId: number
    chapterNumber: number
    title: string
    summary: string
  }>
  narrativeThreads: PlotTreeNarrativeThreadSource[]
  sourceRevision: string
  snapshot: PlotTreeSnapshot | null
  /** A corrupt or structurally unsafe stored snapshot was isolated without deleting it. */
  storedSnapshotInvalid?: true
}

export function isPlotTreeSourceRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`剧情树${label}无效`)
  return value.trim()
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`剧情树${label}无效`)
  return value as number
}

function validChapterNumber(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 1
    && (value as number) <= MAX_PLOT_TREE_CHAPTER_NUMBER
}

function chapterInteger(value: unknown, label: string): number {
  if (!validChapterNumber(value)) throw new Error(`剧情树${label}无效`)
  return value
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && Boolean(value.trim())
}

function validChapterRange(start: unknown, end: unknown): start is number {
  return validChapterNumber(start)
    && validChapterNumber(end)
    && (end as number) >= (start as number)
}

function plotTreeSourceChapterBounds(
  sources: PlotTreeSourceBundle,
): { startChapter: number; endChapter: number } | null {
  const ranges: Array<readonly [number, number]> = []
  for (const blueprint of Array.isArray(sources.blueprints) ? sources.blueprints : []) {
    if (validChapterNumber(blueprint?.chapterNumber)
      && [blueprint.title, blueprint.purpose, blueprint.keyEvents].some(nonEmptyString)) {
      ranges.push([blueprint.chapterNumber, blueprint.chapterNumber])
    }
  }
  for (const chapter of Array.isArray(sources.finalizedChapters) ? sources.finalizedChapters : []) {
    if (Number.isSafeInteger(chapter?.draftId)
      && chapter.draftId >= 1
      && validChapterNumber(chapter.chapterNumber)
      && [chapter.title, chapter.summary].some(nonEmptyString)) {
      ranges.push([chapter.chapterNumber, chapter.chapterNumber])
    }
  }
  for (const thread of Array.isArray(sources.narrativeThreads) ? sources.narrativeThreads : []) {
    if (Number.isSafeInteger(thread?.id)
      && thread.id >= 1
      && validChapterRange(thread.targetStartChapter, thread.targetEndChapter)
      && [thread.title, thread.type, thread.authorIntent].every(nonEmptyString)) {
      ranges.push([thread.targetStartChapter, thread.targetEndChapter])
      for (const event of Array.isArray(thread.events) ? thread.events : []) {
        if (Number.isSafeInteger(event?.id)
          && event.id >= 1
          && validChapterNumber(event.chapterNumber)
          && ['planted', 'progressing', 'resolved', 'abandoned'].includes(event.type)
          && [event.evidence, event.reason].every(nonEmptyString)) {
          ranges.push([event.chapterNumber, event.chapterNumber])
        }
      }
    }
  }
  if (ranges.length === 0) return null
  return {
    startChapter: Math.min(...ranges.map(([start]) => start)),
    endChapter: Math.max(...ranges.map(([, end]) => end)),
  }
}

/** True only when at least one current fact can legally support a plot-tree event. */
export function hasUsablePlotTreeEventSource(sources: PlotTreeSourceBundle): boolean {
  return plotTreeSourceChapterBounds(sources) !== null
}

/** Rejects model-controlled track ranges that exceed the current authoritative source domain. */
export function assertPlotTreeSnapshotChapterBounds(
  snapshot: PlotTreeSnapshot,
  sources: PlotTreeSourceBundle,
): PlotTreeSnapshot {
  const bounds = plotTreeSourceChapterBounds(sources)
  if (!bounds) throw new Error('剧情树缺少有效事件来源')
  if (snapshot.tracks.some(track => (
    track.startChapter < bounds.startChapter || track.endChapter > bounds.endChapter
  ))) throw new Error('剧情树轨道章节范围超出当前剧情来源')
  return snapshot
}

function sourceReference(value: unknown): PlotTreeSourceReference {
  const input = record(value)
  if (!input) throw new Error('剧情树来源引用无效')
  if (input.type === 'blueprint') {
    const chapterNumber = chapterInteger(input.chapterNumber, '来源章节')
    return { type: 'blueprint', chapterNumber }
  }
  if (input.type === 'finalized-chapter') {
    const draftId = positiveInteger(input.draftId, '来源定稿')
    const chapterNumber = chapterInteger(input.chapterNumber, '来源章节')
    return { type: 'finalized-chapter', draftId, chapterNumber }
  }
  if (input.type === 'narrative-thread') {
    const planId = positiveInteger(input.planId, '来源叙事计划')
    const eventId = input.eventId === undefined
      ? undefined
      : positiveInteger(input.eventId, '来源叙事事件')
    const chapterNumber = input.chapterNumber === undefined
      ? undefined
      : chapterInteger(input.chapterNumber, '来源章节')
    if ((eventId === undefined) !== (chapterNumber === undefined)) {
      throw new Error('剧情树叙事来源引用无效')
    }
    return {
      type: 'narrative-thread',
      planId,
      ...(eventId === undefined ? {} : { eventId }),
      ...(chapterNumber === undefined ? {} : { chapterNumber }),
    }
  }
  throw new Error('剧情树来源引用无效')
}

function sourceSupportsEvent(
  source: PlotTreeSourceReference,
  status: PlotTreeEventStatus,
  chapterNumber: number,
  sources?: PlotTreeSourceBundle,
): boolean {
  if (source.type === 'blueprint') {
    return status === 'planned' && source.chapterNumber === chapterNumber
  }
  if (source.type === 'finalized-chapter') {
    return status === 'occurred' && source.chapterNumber === chapterNumber
  }
  if (source.eventId !== undefined) {
    return status === 'occurred' && source.chapterNumber === chapterNumber
  }
  if (status !== 'planned') return false
  if (!sources) return true
  const plan = sources.narrativeThreads.find(thread => thread.id === source.planId)
  return Boolean(plan
    && chapterNumber >= plan.targetStartChapter
    && chapterNumber <= plan.targetEndChapter)
}

function assertSourceExists(
  source: PlotTreeSourceReference,
  sources: PlotTreeSourceBundle,
): void {
  if (source.type === 'blueprint') {
    if (!sources.blueprints.some(blueprint => blueprint.chapterNumber === source.chapterNumber)) {
      throw new Error('剧情树来源引用不存在')
    }
    return
  }
  if (source.type === 'finalized-chapter') {
    if (!sources.finalizedChapters.some(chapter => (
      chapter.draftId === source.draftId && chapter.chapterNumber === source.chapterNumber
    ))) throw new Error('剧情树来源引用不存在')
    return
  }
  const plan = sources.narrativeThreads.find(thread => thread.id === source.planId)
  if (!plan) throw new Error('剧情树来源引用不存在')
  if (source.eventId !== undefined && !plan.events.some(event => (
    event.id === source.eventId && event.chapterNumber === source.chapterNumber
  ))) throw new Error('剧情树来源引用不存在')
}

/** Validates a persisted snapshot without requiring its historical sources to still exist. */
export function assertStoredPlotTreeSnapshot(
  value: unknown,
): PlotTreeSnapshot {
  const input = record(value)
  if (
    !input
    || input.version !== 1
    || !WRITING_LANGUAGES.includes(input.writingLanguage as WritingLanguage)
  ) {
    throw new Error('剧情树快照版本或写作语言无效')
  }
  const writingLanguage = input.writingLanguage as WritingLanguage
  const generatedAt = text(input.generatedAt, '生成时间')
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error('剧情树生成时间无效')
  const sourceRevision = input.sourceRevision
  if (sourceRevision !== undefined && !isPlotTreeSourceRevision(sourceRevision)) {
    throw new Error('剧情树来源版本无效')
  }
  if (!Array.isArray(input.tracks) || input.tracks.length === 0) {
    throw new Error('剧情树轨道无效')
  }

  const tracks = input.tracks.map((candidate): PlotTreeTrack => {
    const track = record(candidate)
    if (!track || !['main', 'subplot'].includes(String(track.role))) {
      throw new Error('剧情树轨道无效')
    }
    const id = text(track.id, '轨道 ID')
    const title = text(track.title, '轨道标题')
    const summary = text(track.summary, '轨道摘要')
    const startChapter = chapterInteger(track.startChapter, '轨道章节范围')
    const endChapter = chapterInteger(track.endChapter, '轨道章节范围')
    if (endChapter < startChapter) throw new Error('剧情树轨道章节范围无效')
    if (!Array.isArray(track.events) || track.events.length === 0) {
      throw new Error('剧情树轨道事件无效')
    }
    const events = track.events.map((candidateEvent): PlotTreeEvent => {
      const event = record(candidateEvent)
      if (!event || !['planned', 'occurred'].includes(String(event.status))) {
        throw new Error('剧情树事件无效')
      }
      if (!Array.isArray(event.sources) || event.sources.length === 0) {
        throw new Error('剧情树事件缺少来源引用')
      }
      const status = event.status as PlotTreeEventStatus
      const chapterNumber = chapterInteger(event.chapterNumber, '事件章节')
      const eventSources = event.sources.map(sourceReference)
      if (!eventSources.every(source => sourceSupportsEvent(source, status, chapterNumber))) {
        throw new Error('剧情树事件状态与来源不匹配')
      }
      return {
        status,
        chapterNumber,
        summary: text(event.summary, '事件摘要'),
        sources: eventSources,
      }
    })
    if (events.some(event => (
      event.chapterNumber < startChapter || event.chapterNumber > endChapter
    ))) throw new Error('剧情树事件超出轨道章节范围')
    return {
      id,
      title,
      role: track.role as PlotTreeTrackRole,
      ...(track.parentTrackId === undefined ? {} : {
        parentTrackId: text(track.parentTrackId, '父轨道 ID'),
      }),
      startChapter,
      endChapter,
      summary,
      events,
    }
  })

  const byId = new Map<string, PlotTreeTrack>()
  for (const track of tracks) {
    if (byId.has(track.id)) throw new Error('剧情树轨道 ID 重复')
    byId.set(track.id, track)
  }
  for (const track of tracks) {
    if (track.role === 'main' && track.parentTrackId) throw new Error('剧情树主线不能有父轨道')
    if (track.role === 'subplot' && !track.parentTrackId) {
      throw new Error('剧情树支线必须归属一条主线')
    }
    if (track.parentTrackId && byId.get(track.parentTrackId)?.role !== 'main') {
      throw new Error('剧情树支线父轨道必须是现有主线')
    }
  }

  return {
    version: 1,
    generatedAt,
    writingLanguage,
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    tracks,
  }
}

/** Validates a newly generated snapshot against the project's current sources. */
export function assertPlotTreeSnapshot(
  value: unknown,
  sources: PlotTreeSourceBundle,
): PlotTreeSnapshot {
  const snapshot = assertStoredPlotTreeSnapshot(value)
  if (snapshot.writingLanguage !== sources.writingLanguage) {
    throw new Error('剧情树快照写作语言与当前项目不匹配')
  }
  if (snapshot.sourceRevision !== sources.sourceRevision) {
    throw new Error('剧情树来源版本不匹配')
  }
  for (const track of snapshot.tracks) {
    for (const event of track.events) {
      for (const source of event.sources) assertSourceExists(source, sources)
      if (!event.sources.every(source => (
        sourceSupportsEvent(source, event.status, event.chapterNumber, sources)
      ))) throw new Error('剧情树事件状态与来源不匹配')
    }
  }
  return assertPlotTreeSnapshotChapterBounds(snapshot, sources)
}
