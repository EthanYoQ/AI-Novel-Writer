import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { GraphGenerationContext, GraphGenerationInput } from '../../src/shared/graph-generation'
import { resolveWritingLanguage } from '../../src/shared/writing-language'
import { buildPlotTreeTask } from '../../src/shared/plot-tree-generation-pure'
import { buildNarrativeThreadEventTask, buildNarrativeThreadPlanTask } from '../../src/shared/narrative-thread-generation-pure'
import { PlotTreeRepository } from '../repositories/plot-tree-repository'
import { NarrativeThreadRepository } from '../repositories/narrative-thread-repository'
import { BlueprintRepository } from '../repositories/blueprint-repository'
import { textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const operations = { plot: 'plot-tree-snapshot', plan: 'narrative-thread-plan-candidate', event: 'narrative-thread-event-candidate' } as const

export function validateGraphGenerationInput(input: GraphGenerationInput): GraphGenerationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(operations, input.kind)) throw new Error('GENERATION_GRAPH_INPUT_INVALID')
  const keys = input.kind === 'plot' ? ['kind'] : input.kind === 'plan' ? ['kind', 'chapterNumber'] : ['kind', 'planId', 'draftId']
  if (Object.keys(input).some(key => !keys.includes(key))
    || input.kind === 'plan' && !positive(input.chapterNumber)
    || input.kind === 'event' && (!positive(input.planId) || !positive(input.draftId))) throw new Error('GENERATION_GRAPH_INPUT_INVALID')
  return structuredClone(input)
}

/** The ignored IDs are supplied only by the main effect owner after validating its ACKs. */
export function captureGraphGenerationContext(db: Database.Database, input: GraphGenerationInput,
  scope: { projectId: string; epoch: string }, key: string, previous?: GraphGenerationContext,
  ignoredOwnEventIds: readonly number[] = []): GraphGenerationContext {
  const valid = validateGraphGenerationInput(input)
  if (!nonempty(scope.projectId) || !nonempty(scope.epoch) || !nonempty(key)
    || ignoredOwnEventIds.some(id => !positive(id)) || new Set(ignoredOwnEventIds).size !== ignoredOwnEventIds.length
    || previous && (previous.projectId !== scope.projectId || previous.key !== key || !nonempty(previous.originEpoch) || !nonempty(previous.createdAt)
      || previous.kind !== valid.kind || !isDeepStrictEqual(previous.input, valid))) throw new Error('GENERATION_GRAPH_CONTEXT_INVALID')
  const core = db.prepare("SELECT writing_language,total_chapters,plot_tree_snapshot FROM project_core WHERE id='main'").get() as {
    writing_language: string; total_chapters: number; plot_tree_snapshot: string
  } | undefined
  if (!core) throw new Error('GENERATION_GRAPH_PROJECT_REQUIRED')
  const base = { projectId: scope.projectId, originEpoch: previous?.originEpoch ?? scope.epoch, key,
    createdAt: previous?.createdAt ?? new Date().toISOString(), input: valid, writingLanguage: resolveWritingLanguage(core.writing_language) }
  if (valid.kind === 'plot') {
    const sources = PlotTreeRepository.read(db)
    sources.snapshot = null
    delete sources.storedSnapshotInvalid
    return { ...base, kind: 'plot', sources, targetBaselineHash: textHash(core.plot_tree_snapshot) }
  }
  if (valid.kind === 'plan') {
    const blueprint = BlueprintRepository.getAll(db).find(row => row.chapterNumber === valid.chapterNumber)
    if (!blueprint || !positive(core.total_chapters) || valid.chapterNumber > core.total_chapters) throw new Error('GENERATION_GRAPH_BLUEPRINT_REQUIRED')
    return { ...base, kind: 'plan', blueprint, totalChapters: core.total_chapters }
  }
  const plan = NarrativeThreadRepository.list(db).find(row => row.id === valid.planId)
  if (!plan) throw new Error('GENERATION_GRAPH_PLAN_REQUIRED')
  const row = db.prepare(`SELECT d.chapter_number AS chapterNumber,d.status,c.body AS content,
    f.finalization_id AS finalizationId,f.content_hash AS contentHash,f.content_snapshot AS snapshot,
    f.chapter_number AS finalizedChapterNumber,f.content_revision AS contentRevision,
    m.generation AS projectionGeneration
    FROM drafts d JOIN contents c ON c.id=d.content_id JOIN finalization_outbox f ON f.draft_id=d.id
    JOIN continuity_projection_meta m ON m.id='main' WHERE d.id=?`).get(valid.draftId) as {
      chapterNumber: number; finalizedChapterNumber: number; contentRevision: number; status: string; content: string; finalizationId: string; contentHash: string; snapshot: string; projectionGeneration: number
    } | undefined
  const latest = row && db.prepare("SELECT id FROM drafts WHERE chapter_number=? AND status='finalized' ORDER BY version DESC,id DESC LIMIT 1").pluck().get(row.chapterNumber)
  if (!row || row.status !== 'finalized' || latest !== valid.draftId || !nonempty(row.finalizationId)
    || row.finalizedChapterNumber !== row.chapterNumber || !Number.isSafeInteger(row.contentRevision) || row.contentRevision < 0
    || row.content !== row.snapshot || textHash(row.snapshot) !== row.contentHash
    || !Number.isSafeInteger(row.projectionGeneration) || row.projectionGeneration < 0) throw new Error('GENERATION_GRAPH_FINALIZED_SOURCE_INVALID')
  if (ignoredOwnEventIds.length) {
    plan.events = plan.events.filter(event => !ignoredOwnEventIds.includes(event.id))
    plan.status = plan.events.at(-1)?.type ?? 'planned'
    const currentChapter = db.prepare("SELECT COALESCE(MAX(chapter_number),0) FROM drafts WHERE status='finalized'").pluck().get() as number
    const terminal = plan.status === 'resolved' || plan.status === 'abandoned'
    plan.dormantChapters = terminal ? 0 : Math.max(0, currentChapter - (plan.events.at(-1)?.chapterNumber ?? plan.targetStartChapter))
    plan.overdue = !terminal && currentChapter > plan.targetEndChapter
  }
  return { ...base, kind: 'event', plan, source: { draftId: valid.draftId, chapterNumber: row.chapterNumber,
    finalizationId: row.finalizationId, contentHash: row.contentHash }, content: row.content, contentRevision: row.contentRevision, projectionGeneration: row.projectionGeneration }
}

export function graphGenerationTask(context: GraphGenerationContext) {
  if (context.kind === 'plot') return buildPlotTreeTask(context.sources)
  if (context.kind === 'plan') return buildNarrativeThreadPlanTask({ writingLanguage: context.writingLanguage, blueprint: context.blueprint, totalChapters: context.totalChapters })
  return buildNarrativeThreadEventTask({ writingLanguage: context.writingLanguage, plan: context.plan,
    draftId: context.source.draftId, chapterNumber: context.source.chapterNumber, finalizedContent: context.content })
}

export function readGraphGenerationContext(run: DurableGenerationRun): GraphGenerationContext {
  const manifest = run.binding.sourceManifest, context = manifest.graphGenerationContext as GraphGenerationContext | undefined
  if (!context || !context.input || !Object.hasOwn(operations, context.kind) || context.input.kind !== context.kind
    || manifest.operation !== operations[context.kind] || textHash(JSON.stringify(context)) !== manifest.graphGenerationContextHash
    || context.projectId !== run.binding.projectId || !nonempty(context.originEpoch) || manifest.graphGenerationOriginEpoch !== context.originEpoch
    || !nonempty(context.key) || !nonempty(context.createdAt) || manifest.graphGenerationKey !== context.key
    || !isDeepStrictEqual(manifest.graphGenerationInput, context.input)) throw new Error('GENERATION_GRAPH_CONTEXT_INVALID')
  validateGraphGenerationInput(context.input)
  if (context.kind === 'plan' && (context.input.kind !== 'plan' || context.blueprint?.chapterNumber !== context.input.chapterNumber || !positive(context.totalChapters))
    || context.kind === 'plot' && (!context.sources || context.sources.snapshot !== null || context.sources.writingLanguage !== context.writingLanguage || !/^[a-f0-9]{64}$/.test(context.targetBaselineHash))
    || context.kind === 'event' && (context.input.kind !== 'event' || context.plan?.id !== context.input.planId || context.source?.draftId !== context.input.draftId
      || !positive(context.source.chapterNumber) || !nonempty(context.source.finalizationId) || typeof context.content !== 'string'
      || !Number.isSafeInteger(context.contentRevision) || context.contentRevision < 0
      || textHash(context.content) !== context.source.contentHash || !Number.isSafeInteger(context.projectionGeneration) || context.projectionGeneration < 0)) throw new Error('GENERATION_GRAPH_CONTEXT_INVALID')
  if (!manifest.graphGenerationTask || textHash(JSON.stringify(manifest.graphGenerationTask)) !== manifest.graphGenerationTaskHash
    || !isDeepStrictEqual(manifest.graphGenerationTask, graphGenerationTask(context))) throw new Error('GENERATION_GRAPH_TASK_INVALID')
  return structuredClone(context)
}
