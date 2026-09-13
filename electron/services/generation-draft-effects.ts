import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { GenerationBatchIntent, GenerationBatchProgress, GenerationDraftCommitReceipt, GenerationDraftCommitRequest } from '../../src/shared/generation-owner-contract'
import type { DraftSourceDependency } from '../../src/shared/draft-source-dependency'
import { countDraftUnits } from '../../src/shared/draft-units'
import { GenerationRunRepository, textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'
import { DraftRepository } from '../repositories/draft-repository'

interface StoredDraftCommit extends GenerationDraftCommitReceipt {
  chapterNumber: number
  handle: MainGenerationRunHandle
  batchId?: string
}
interface AttemptRow { attempt_id: string; run_id: string; usage_receipt_json: string }
const handleOf = (run: DurableGenerationRun): MainGenerationRunHandle => ({ projectId: run.binding.projectId,
  epoch: run.binding.epoch, rootActionId: run.rootActionId, runId: run.runId })
export function assertGenerationBatchIntent(intent: GenerationBatchIntent): void {
  if (!intent || !['draft_review', 'auto_finalize'].includes(intent.mode) || !intent.range
    || !Number.isSafeInteger(intent.range.startChapter) || !Number.isSafeInteger(intent.range.endChapter)
    || intent.range.startChapter < 1 || intent.range.endChapter < intent.range.startChapter
    || intent.range.endChapter - intent.range.startChapter >= 10000
    || !Number.isSafeInteger(intent.targetUnits) || intent.targetUnits < 1 || intent.targetUnits > 1_000_000)
    throw new Error('GENERATION_BATCH_INTENT_INVALID')
}

/** Existing generation attempt receipts are the only draft/batch ledger. */
export class GenerationDraftEffects {
  constructor(private readonly db: Database.Database, private readonly runs: GenerationRunRepository) {}
  private attempts(runId?: string): AttemptRow[] {
    return (runId ? this.db.prepare('SELECT attempt_id,run_id,usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid').all(runId)
      : this.db.prepare('SELECT attempt_id,run_id,usage_receipt_json FROM generation_attempts ORDER BY rowid').all()) as AttemptRow[]
  }
  private verifiedCommit(row: AttemptRow): StoredDraftCommit | null {
    const usage = JSON.parse(row.usage_receipt_json), stored = usage.draftCommit as StoredDraftCommit | undefined
    if (!stored) return null
    const run = this.runs.get(row.run_id), composition = this.runs.readVisibleComposition(run.runId)
    const draft = this.db.prepare('SELECT d.id,d.version,d.chapter_number,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(stored.id) as { id: number; version: number; chapter_number: number; body: string } | undefined
    if (!draft || !composition || composition.algorithm !== 'draft-visible-v1' || stored.success !== true
      || stored.chapterNumber !== run.binding.sourceManifest.chapterNumber || stored.chapterNumber !== draft.chapter_number
      || stored.version !== draft.version || stored.contentHash !== textHash(stored.content) || stored.contentHash !== composition.textHash
      || stored.content !== composition.text || stored.content !== draft.body || stored.batchId !== run.binding.sourceManifest.batchId
      || !isDeepStrictEqual(stored.handle, { ...handleOf(run), epoch: usage.artifactIdentity?.epoch }))
      throw new Error('GENERATION_DRAFT_RECEIPT_INVALID')
    return stored
  }
  readCommit(runId: string): StoredDraftCommit | null {
    const commits = this.attempts(runId).map(row => this.verifiedCommit(row)).filter(item => item !== null)
    if (commits.length > 1) throw new Error('GENERATION_DRAFT_RECEIPT_INVALID')
    return commits[0] ?? null
  }
  readBatch(batchId: string, projectId: string): GenerationBatchProgress {
    const root = this.runs.get(batchId), intent = root.binding.sourceManifest.batchIntent as GenerationBatchIntent
    assertGenerationBatchIntent(intent)
    if (root.binding.projectId !== projectId || root.binding.sourceManifest.operation !== 'batch-chapters') throw new Error('GENERATION_BATCH_IDENTITY_INVALID')
    const completedChapters: GenerationBatchProgress['completedChapters'] = []
    for (const row of this.attempts()) {
      if (JSON.parse(row.usage_receipt_json).draftCommit?.batchId !== batchId) continue
      const committed = this.verifiedCommit(row)!
      if (committed.handle.rootActionId !== root.rootActionId) throw new Error('GENERATION_BATCH_LINEAGE_INVALID')
      const latest = this.db.prepare('SELECT id FROM drafts WHERE chapter_number=? ORDER BY version DESC,id DESC LIMIT 1').pluck().get(committed.chapterNumber)
      if (latest !== committed.id) throw new Error('GENERATION_BATCH_DRAFT_REPLACED')
      const outbox = this.db.prepare('SELECT finalization_id,content_hash,content_snapshot,chapter_number,publication_status FROM finalization_outbox WHERE draft_id=?').get(committed.id) as {
        finalization_id: string; content_hash: string; content_snapshot: string; chapter_number: number; publication_status: string
      } | undefined
      if (outbox && (outbox.content_hash !== committed.contentHash || outbox.content_snapshot !== committed.content || outbox.chapter_number !== committed.chapterNumber))
        throw new Error('GENERATION_BATCH_FINALIZATION_CONFLICT')
      const postProcess = outbox ? this.db.prepare("SELECT id,all_critical_passed FROM post_process_runs WHERE trigger_source_type='chapter_finalize' AND trigger_source_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(`finalization:${outbox.finalization_id}`) as { id: string; all_critical_passed: number } | undefined : undefined
      const steps = postProcess ? this.db.prepare('SELECT step_key,critical,ok FROM post_process_steps WHERE run_id=?').all(postProcess.id) as { step_key: string; critical: number; ok: number }[] : []
      const postProcessComplete = postProcess?.all_critical_passed === 1 && ['kb_import', 'chapter_notes'].every(key => steps.some(step => step.step_key === key && step.critical === 1 && step.ok === 1))
        && steps.filter(step => step.critical === 1).every(step => step.ok === 1)
      completedChapters.push({ chapterNumber: committed.chapterNumber, draftId: committed.id, version: committed.version,
        contentHash: committed.contentHash, sourceRunHandle: handleOf(this.runs.get(row.run_id)), postProcessComplete,
        ...(outbox?.publication_status === 'published' ? { finalizationId: outbox.finalization_id } : outbox ? { pendingFinalizationId: outbox.finalization_id } : {}) })
    }
    completedChapters.sort((a, b) => a.chapterNumber - b.chapterNumber)
    let nextChapterNumber: number | null = intent.range.startChapter
    for (const [index, chapter] of completedChapters.entries()) {
      if (chapter.chapterNumber !== intent.range.startChapter + index || chapter.chapterNumber > intent.range.endChapter
        || nextChapterNumber !== chapter.chapterNumber) throw new Error('GENERATION_BATCH_PROGRESS_INVALID')
      if (intent.mode === 'auto_finalize' && (!chapter.finalizationId || !chapter.postProcessComplete)) break
      nextChapterNumber = chapter.chapterNumber === intent.range.endChapter ? null : chapter.chapterNumber + 1
    }
    const pending = (this.db.prepare('SELECT run_id FROM generation_runs WHERE root_action_id=?').all(root.rootActionId) as { run_id: string }[])
      .map(row => this.runs.get(row.run_id)).filter(run => run.binding.sourceManifest.batchId === batchId
        && run.binding.sourceManifest.chapterNumber === nextChapterNumber && !this.readCommit(run.runId))
    if (pending.length > 1) throw new Error('GENERATION_BATCH_PROGRESS_INVALID')
    return { ...structuredClone(intent), modelId: (root.binding.sourceManifest.modelReceipt as { modelId: string }).modelId, batchId, rootHandle: handleOf(root), completedChapters, nextChapterNumber,
      ...(pending[0] ? { currentChapterRunHandle: handleOf(pending[0]) } : {}),
      authorInputs: structuredClone(root.binding.sourceManifest.authorInputs as GenerationBatchProgress['authorInputs'] ?? []) }
  }
  commit(request: GenerationDraftCommitRequest, assertSources: () => void): GenerationDraftCommitReceipt {
    return this.db.transaction(() => {
      const run = this.runs.get(request.handle.runId), previous = this.readCommit(run.runId)
      if (request.source !== 'write' || request.chapterNumber !== run.binding.sourceManifest.chapterNumber
        || run.binding.sourceManifest.operation !== 'chapter-draft' || request.batchId !== run.binding.sourceManifest.batchId)
        throw new Error('GENERATION_DRAFT_TARGET_INVALID')
      if (previous) {
        if (previous.contentHash !== request.expectedCompositionHash) throw new Error('GENERATION_DRAFT_COMMIT_CONFLICT')
        return { success: true as const, id: previous.id, version: previous.version, content: previous.content, contentHash: previous.contentHash }
      }
      assertSources()
      const composition = this.runs.readVisibleComposition(run.runId)
      if (!composition || composition.algorithm !== 'draft-visible-v1' || composition.textHash !== request.expectedCompositionHash)
        throw new Error('GENERATION_DRAFT_COMPOSITION_REQUIRED')
      const target = Number((run.binding.sourceManifest.authorInputs as { id: string; text: string }[] | undefined)?.find(item => item.id === 'draft:target-units')?.text)
      if (!Number.isSafeInteger(target) || target < 1 || countDraftUnits(composition.text) < Math.floor(target * 0.8)) throw new Error('GENERATION_DRAFT_INCOMPLETE')
      if (request.batchId) {
        const progress = this.readBatch(request.batchId, request.handle.projectId)
        if (progress.rootHandle.rootActionId !== run.rootActionId || progress.nextChapterNumber !== request.chapterNumber
          || progress.targetUnits !== target
          || progress.completedChapters.some(item => item.chapterNumber === request.chapterNumber)) throw new Error('GENERATION_BATCH_PROGRESS_CONFLICT')
      }
      const dependencies: DraftSourceDependency[] = run.binding.sourceRefs.flatMap(ref => {
        const candidate = /^draft:(\d+)$/.exec(ref.sourceId)
        if (candidate) return [{ kind: 'candidate' as const, draftId: Number(candidate[1]), contentHash: ref.contentHash }]
        return []
      })
      for (const ref of run.binding.sourceRefs) {
        const finalized = /^finalized:(\d+):(.+)$/.exec(ref.sourceId)
        if (!finalized) continue
        const chapterNumber = this.db.prepare('SELECT chapter_number FROM drafts WHERE id=?').pluck().get(Number(finalized[1])) as number
        dependencies.push({ kind: 'finalized', draftId: Number(finalized[1]), finalizationId: finalized[2]!, chapterNumber, contentHash: ref.contentHash })
      }
      const id = DraftRepository.create({ chapterNumber: request.chapterNumber, source: 'write', content: composition.text,
        wordCount: countDraftUnits(composition.text), sourceDependencies: dependencies }, this.db)
      const version = this.db.prepare('SELECT version FROM drafts WHERE id=?').pluck().get(id) as number
      const receipt: GenerationDraftCommitReceipt = { success: true, id, version, contentHash: composition.textHash, content: composition.text }
      const artifact = this.db.prepare('SELECT attempt_id FROM generation_artifacts WHERE artifact_id=?').pluck().get(composition.artifactIds.at(-1)) as string
      const row = this.attempts(run.runId).find(item => item.attempt_id === artifact)!
      const usage = JSON.parse(row.usage_receipt_json)
      const stored: StoredDraftCommit = { ...receipt, chapterNumber: request.chapterNumber,
        handle: { ...request.handle, epoch: usage.artifactIdentity.epoch }, ...(request.batchId ? { batchId: request.batchId } : {}) }
      this.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify({ ...usage, draftCommit: stored }), artifact)
      if (request.batchId) this.readBatch(request.batchId, request.handle.projectId)
      return receipt
    }).immediate()
  }
}
