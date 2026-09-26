import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { GraphGenerationArtifact, GraphGenerationContext, GraphGenerationEffect, GraphGenerationResult } from '../../src/shared/graph-generation'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { derivePlotTreeSnapshot } from '../../src/shared/plot-tree-generation-pure'
import { parseNarrativeThreadPlanCandidates, parseNarrativeThreadEventCandidates } from '../../src/shared/narrative-thread-generation-pure'
import { GenerationRunRepository, textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'
import { readGraphGenerationContext } from './graph-generation-source'
import { PlotTreeRepository } from '../repositories/plot-tree-repository'
import { NarrativeThreadRepository } from '../repositories/narrative-thread-repository'

interface StoredGraphEffect { version: 1; artifact: GraphGenerationArtifact; index: number; contextHash: string; receipt: GraphGenerationEffect; receiptHash: string }
export function deriveGraphGenerationResult(context: GraphGenerationContext, text: string): GraphGenerationResult {
  if (context.kind === 'plot') {
    const result = derivePlotTreeSnapshot(text, context.sources, context.createdAt)
    return { kind: 'plot', snapshot: result.snapshot, derivation: result.kind }
  }
  return context.kind === 'plan'
    ? { kind: 'plan', candidates: parseNarrativeThreadPlanCandidates(text, context.totalChapters) }
    : { kind: 'event', candidates: parseNarrativeThreadEventCandidates(text, context.content) }
}
export class GraphGeneration {
  constructor(private readonly db: Database.Database, private readonly runs: GenerationRunRepository, private readonly projectId: string) {}
  require(handle: MainGenerationRunHandle): DurableGenerationRun {
    if (!handle || Object.keys(handle).some(key => !['projectId', 'epoch', 'rootActionId', 'runId'].includes(key))) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    const run = this.runs.get(handle.runId), context = readGraphGenerationContext(run)
    if (handle.projectId !== this.projectId || run.binding.projectId !== this.projectId || run.rootActionId !== handle.rootActionId
      || handle.epoch !== run.binding.epoch && handle.epoch !== context.originEpoch) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    return run
  }
  task(run: DurableGenerationRun): GenerationTask {
    readGraphGenerationContext(run)
    const task = run.binding.sourceManifest.graphGenerationTask as GenerationTask | undefined
    if (!task || textHash(JSON.stringify(task)) !== run.binding.sourceManifest.graphGenerationTaskHash) throw new Error('GENERATION_GRAPH_TASK_INVALID')
    return structuredClone(task)
  }
  private proof(run: DurableGenerationRun, reference: GraphGenerationArtifact) {
    if (!reference || Object.keys(reference).some(key => !['artifactId', 'revision', 'textHash'].includes(key))) throw new Error('GENERATION_GRAPH_ARTIFACT_INVALID')
    const row = this.db.prepare('SELECT run_id,attempt_id,status FROM generation_artifacts WHERE artifact_id=?').get(reference.artifactId) as { run_id: string; attempt_id: string; status: string } | undefined
    if (!row || row.run_id !== run.runId || row.status === 'discarded') throw new Error('GENERATION_GRAPH_ARTIFACT_INVALID')
    const receipt = this.runs.receipt(row.attempt_id), artifact = receipt.artifact
    if (!artifact || artifact.revision !== reference.revision || artifact.textHash !== reference.textHash || textHash(artifact.text) !== reference.textHash || !artifact.text.trim()
      || receipt.failureCode || !['settled', 'unknown'].includes(receipt.attempt.status) || receipt.result?.finishReason !== 'stop') throw new Error('GENERATION_GRAPH_ARTIFACT_INVALID')
    const context = readGraphGenerationContext(run)
    return { attemptId: row.attempt_id, artifact, context, result: deriveGraphGenerationResult(context, artifact.text) }
  }
  private assertEffectPayload(context: GraphGenerationContext, result: GraphGenerationResult, effect: GraphGenerationEffect) {
    if (effect.success !== true || effect.kind !== result.kind || !Number.isSafeInteger(effect.index) || effect.index < 0) throw new Error('GENERATION_GRAPH_EFFECT_INVALID')
    if (effect.kind === 'plot' && result.kind === 'plot') {
      if (effect.index !== 0 || !isDeepStrictEqual({ snapshot: effect.snapshot, derivation: effect.derivation }, { snapshot: result.snapshot, derivation: result.derivation })) throw new Error('GENERATION_GRAPH_EFFECT_INVALID')
    } else if (effect.kind === 'plan' && result.kind === 'plan') {
      const candidate = result.candidates[effect.index], plan = effect.plan
      if (!candidate || !Number.isSafeInteger(plan.id) || plan.id < 1 || typeof plan.createdAt !== 'string' || typeof plan.updatedAt !== 'string'
        || !isDeepStrictEqual(candidate, { title: plan.title, type: plan.type, targetStartChapter: plan.targetStartChapter, targetEndChapter: plan.targetEndChapter, authorIntent: plan.authorIntent })) throw new Error('GENERATION_GRAPH_EFFECT_INVALID')
    } else if (effect.kind === 'event' && result.kind === 'event' && context.kind === 'event') {
      const candidate = result.candidates[effect.index], event = effect.event
      if (!candidate || !Number.isSafeInteger(event.id) || event.id < 1 || typeof event.createdAt !== 'string'
        || event.planId !== context.plan.id || event.draftId !== context.source.draftId || event.chapterNumber !== context.source.chapterNumber
        || !isDeepStrictEqual(candidate, { type: event.type, evidence: event.evidence, reason: event.reason })) throw new Error('GENERATION_GRAPH_EFFECT_INVALID')
    } else throw new Error('GENERATION_GRAPH_EFFECT_INVALID')
  }
  private storedEffects(run: DurableGenerationRun): StoredGraphEffect[] {
    const context = readGraphGenerationContext(run)
    const rows = this.db.prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid').all(run.runId) as { attempt_id: string; usage_receipt_json: string }[]
    const effects: StoredGraphEffect[] = []
    for (const row of rows) {
      const saved = JSON.parse(row.usage_receipt_json).graphEffects as StoredGraphEffect[] | undefined
      if (saved === undefined) continue
      if (!Array.isArray(saved) || saved.length > 8) throw new Error('GENERATION_GRAPH_EFFECT_INVALID')
      for (const effect of saved) {
        const proof = this.proof(run, effect.artifact)
        if (effect.version !== 1 || proof.attemptId !== row.attempt_id || effect.contextHash !== textHash(JSON.stringify(context))
          || effect.index !== effect.receipt?.index || textHash(JSON.stringify(effect.receipt)) !== effect.receiptHash || effects.some(item => item.index === effect.index)) throw new Error('GENERATION_GRAPH_EFFECT_INVALID')
        this.assertEffectPayload(context, proof.result, effect.receipt)
        effects.push(effect)
      }
    }
    return effects
  }
  effects(run: DurableGenerationRun): GraphGenerationEffect[] { return structuredClone(this.storedEffects(run).map(item => item.receipt)) }
  assertMutable(run: DurableGenerationRun): void {
    if (run.binding.sourceManifest.graphGenerationContext && this.effects(run).length) throw new Error('GENERATION_GRAPH_EFFECT_SEALED')
  }
  result(run: DurableGenerationRun, reference: GraphGenerationArtifact): GraphGenerationResult { return this.proof(run, reference).result }
  /** Only existing, unchanged rows proven by this run's original artifact may be excluded from source comparison. */
  ownEventIds(run: DurableGenerationRun): number[] {
    return this.effects(run).flatMap(effect => {
      if (effect.kind !== 'event') return []
      const event = effect.event
      const row = this.db.prepare(`SELECT e.id,e.plan_id AS planId,e.draft_id AS draftId,e.event_type AS type,e.evidence,e.reason,e.created_at AS createdAt,
        d.chapter_number AS chapterNumber,o.chapter_title AS chapterTitle FROM narrative_thread_confirmations e
        JOIN drafts d ON d.id=e.draft_id AND d.status='finalized' JOIN finalization_outbox o ON o.draft_id=d.id WHERE e.id=?`).get(event.id)
      if (!isDeepStrictEqual(row, { id: event.id, planId: event.planId, draftId: event.draftId, type: event.type, evidence: event.evidence, reason: event.reason,
        createdAt: event.createdAt, chapterNumber: event.chapterNumber, chapterTitle: event.chapterTitle })) throw new Error('GENERATION_GRAPH_OWN_EFFECT_CHANGED')
      return [event.id]
    })
  }
  confirm(handle: MainGenerationRunHandle, reference: GraphGenerationArtifact, index: number, assertSources: (run: DurableGenerationRun) => void): GraphGenerationEffect {
    return this.db.transaction(() => {
      const run = this.require(handle), proof = this.proof(run, reference)
      if (!Number.isSafeInteger(index) || index < 0) throw new Error('GENERATION_GRAPH_SELECTION_INVALID')
      const saved = this.storedEffects(run).find(item => item.index === index)
      if (saved) {
        if (!isDeepStrictEqual(saved.artifact, reference)) throw new Error('GENERATION_GRAPH_EFFECT_CONFLICT')
        return structuredClone(saved.receipt)
      }
      assertSources(run)
      let receipt: GraphGenerationEffect
      if (proof.result.kind === 'plot' && proof.context.kind === 'plot') {
        if (index !== 0) throw new Error('GENERATION_GRAPH_SELECTION_INVALID')
        const currentSnapshot = this.db.prepare("SELECT plot_tree_snapshot FROM project_core WHERE id='main'").pluck().get() as string
        if (textHash(currentSnapshot ?? '') !== proof.context.targetBaselineHash) throw new Error('GENERATION_GRAPH_TARGET_CHANGED')
        receipt = { success: true, index, kind: 'plot', derivation: proof.result.derivation,
          snapshot: PlotTreeRepository.save(proof.result.snapshot, proof.context.sources.sourceRevision, this.db) }
      } else if (proof.result.kind === 'plan') {
        const candidate = proof.result.candidates[index]
        if (!candidate) throw new Error('GENERATION_GRAPH_SELECTION_INVALID')
        receipt = { success: true, index, kind: 'plan', plan: NarrativeThreadRepository.createPlan(candidate, this.db) }
      } else if (proof.result.kind === 'event' && proof.context.kind === 'event') {
        const candidate = proof.result.candidates[index]
        if (!candidate) throw new Error('GENERATION_GRAPH_SELECTION_INVALID')
        receipt = { success: true, index, kind: 'event', event: NarrativeThreadRepository.confirmEvent({ ...candidate, planId: proof.context.plan.id, draftId: proof.context.source.draftId }, this.db) }
      } else throw new Error('GENERATION_GRAPH_SELECTION_INVALID')
      this.assertEffectPayload(proof.context, proof.result, receipt)
      const usage = JSON.parse(this.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(proof.attemptId) as string) as Record<string, unknown>
      const effect: StoredGraphEffect = { version: 1, artifact: structuredClone(reference), index, contextHash: textHash(JSON.stringify(proof.context)), receipt, receiptHash: textHash(JSON.stringify(receipt)) }
      this.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify({ ...usage, graphEffects: [...(usage.graphEffects as StoredGraphEffect[] ?? []), effect] }), proof.attemptId)
      return structuredClone(receipt)
    }).immediate()
  }
}

/** Binding rebuilds remove only effects already checked against both their immutable proof and actual current rows. */
export function provenGraphOwnEventIds(db: Database.Database, context: GraphGenerationContext): number[] {
  if (context.kind !== 'event') return []
  const rows = db.prepare("SELECT run_id FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.graphGenerationContext.key')=?").all(context.key) as { run_id: string }[]
  if (rows.length > 1) throw new Error('GENERATION_GRAPH_CONTEXT_AMBIGUOUS')
  if (!rows[0]) return []
  const runs = new GenerationRunRepository(() => db), run = runs.get(rows[0].run_id)
  if (run.binding.projectId !== context.projectId || !isDeepStrictEqual(readGraphGenerationContext(run), context)) throw new Error('GENERATION_GRAPH_CONTEXT_INVALID')
  return new GraphGeneration(db, runs, context.projectId).ownEventIds(run)
}
