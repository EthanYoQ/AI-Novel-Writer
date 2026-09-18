import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { FinalizationGenerationEffect, FinalizationGenerationSlot } from '../../src/shared/finalization-generation'
import type { FinalizedCharacterArtifact } from '../../src/shared/finalized-character-generation'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { GenerationRunRepository, textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'
import { finalizationSlotKey, readFinalizationGenerationContext, finalizationNotesBaseline } from './finalization-generation-source'
import { SummaryRepository } from '../repositories/summary-repository'
import { BlueprintRepository } from '../repositories/blueprint-repository'
import { buildFinalizedContinuityFacts } from '../../src/shared/finalized-continuity-facts'
import { proveFinalizedCharacterGeneration } from './finalized-character-generation-proof'
import type { CharacterProposalService } from './character-proposal-service'

interface SavedEffect { version: 1; artifact: FinalizedCharacterArtifact; contextHash: string; receipt: FinalizationGenerationEffect; receiptHash: string }
export class FinalizationGeneration {
  constructor(private readonly db: Database.Database, private readonly runs: GenerationRunRepository, private readonly projectId: string, private readonly characters: CharacterProposalService) {}
  find(slot: FinalizationGenerationSlot): DurableGenerationRun | undefined {
    const key = finalizationSlotKey(slot)
    const rows = this.db.prepare("SELECT run_id FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.finalizationGenerationSlotKey')=?").all(key) as { run_id: string }[]
    if (rows.length > 1) throw new Error('GENERATION_FINALIZATION_SLOT_CONFLICT')
    if (!rows[0]) return undefined
    const run = this.runs.get(rows[0].run_id)
    if (run.binding.projectId !== this.projectId || !isDeepStrictEqual(readFinalizationGenerationContext(run).slot, slot)) throw new Error('GENERATION_FINALIZATION_SLOT_CONFLICT')
    return run
  }
  require(handle: MainGenerationRunHandle): DurableGenerationRun {
    if (!handle || Object.keys(handle).some(key => !['projectId', 'epoch', 'rootActionId', 'runId'].includes(key))) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    const run = this.runs.get(handle.runId), context = readFinalizationGenerationContext(run)
    if (handle.projectId !== this.projectId || run.binding.projectId !== this.projectId || handle.rootActionId !== run.rootActionId
      || handle.epoch !== run.binding.epoch && handle.epoch !== context.identity.epoch) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    return run
  }
  task(run: DurableGenerationRun): GenerationTask {
    readFinalizationGenerationContext(run)
    const task = run.binding.sourceManifest.finalizationGenerationTask as GenerationTask | undefined
    if (!task || textHash(JSON.stringify(task)) !== run.binding.sourceManifest.finalizationGenerationTaskHash) throw new Error('GENERATION_FINALIZATION_TASK_INVALID')
    return structuredClone(task)
  }
  private artifact(run: DurableGenerationRun, ref: FinalizedCharacterArtifact) {
    if (!ref || Object.keys(ref).some(key => !['artifactId', 'revision', 'textHash'].includes(key))) throw new Error('GENERATION_FINALIZATION_ARTIFACT_INVALID')
    const row = this.db.prepare('SELECT run_id,attempt_id,status FROM generation_artifacts WHERE artifact_id=?').get(ref.artifactId) as { run_id: string; attempt_id: string; status: string } | undefined
    if (!row || row.run_id !== run.runId || row.status === 'discarded') throw new Error('GENERATION_FINALIZATION_ARTIFACT_INVALID')
    const receipt = this.runs.receipt(row.attempt_id), artifact = receipt.artifact
    if (!artifact || artifact.revision !== ref.revision || artifact.textHash !== ref.textHash || textHash(artifact.text) !== ref.textHash || !artifact.text.trim()
      || receipt.failureCode || !['settled', 'unknown'].includes(receipt.attempt.status) || receipt.result?.finishReason !== 'stop') throw new Error('GENERATION_FINALIZATION_ARTIFACT_INVALID')
    return { artifact, attemptId: row.attempt_id }
  }
  readEffect(run: DurableGenerationRun): FinalizationGenerationEffect | undefined {
    const context = readFinalizationGenerationContext(run)
    const rows = this.db.prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid').all(run.runId) as { attempt_id: string; usage_receipt_json: string }[]
    const effects = rows.map(row => ({ attemptId: row.attempt_id, effect: JSON.parse(row.usage_receipt_json).finalizationEffect as SavedEffect | undefined })).filter(item => !!item.effect)
    if (effects.length > 1) throw new Error('GENERATION_FINALIZATION_EFFECT_INVALID')
    const saved = effects[0]?.effect
    if (!saved) return undefined
    if (this.artifact(run, saved.artifact).attemptId !== effects[0].attemptId) throw new Error('GENERATION_FINALIZATION_EFFECT_INVALID')
    if (saved.version !== 1 || saved.contextHash !== textHash(JSON.stringify(context)) || saved.receipt?.stepKey !== context.slot.stepKey || saved.receipt.success !== true
      || textHash(JSON.stringify(saved.receipt)) !== saved.receiptHash) throw new Error('GENERATION_FINALIZATION_EFFECT_INVALID')
    if (saved.receipt.stepKey === 'character_cards') {
      const proof = proveFinalizedCharacterGeneration(this.db, this.runs, this.projectId,
        { projectId: this.projectId, epoch: run.binding.epoch, rootActionId: run.rootActionId, runId: run.runId }, saved.artifact)
      if (saved.receipt.proposalBatchId) {
        const batch = this.characters.read(saved.receipt.proposalBatchId)
        if (!isDeepStrictEqual(batch.source, { kind: 'finalized-generation', handle: proof.sourceHandle, artifact: saved.artifact })) throw new Error('GENERATION_FINALIZATION_EFFECT_INVALID')
      }
    }
    return structuredClone(saved.receipt)
  }
  assertMutable(run: DurableGenerationRun): void {
    if (run.binding.sourceManifest.finalizationGenerationContext && this.readEffect(run)) throw new Error('GENERATION_FINALIZATION_EFFECT_SEALED')
  }
  commit(handle: MainGenerationRunHandle, reference: FinalizedCharacterArtifact, characters: CharacterProposalService, assertSources: (run: DurableGenerationRun) => void): FinalizationGenerationEffect {
    return this.db.transaction(() => {
      const run = this.require(handle), context = readFinalizationGenerationContext(run), proof = this.artifact(run, reference)
      const usage = JSON.parse(this.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(proof.attemptId) as string) as Record<string, unknown>
      const saved = this.readEffect(run)
      if (saved) {
        if (!isDeepStrictEqual((usage.finalizationEffect as SavedEffect | undefined)?.artifact, reference)) throw new Error('GENERATION_FINALIZATION_EFFECT_CONFLICT')
        return saved
      }
      assertSources(run)
      let receipt: FinalizationGenerationEffect
      if (context.slot.stepKey === 'chapter_notes') {
        if (!isDeepStrictEqual(finalizationNotesBaseline(this.db, context.slot), context.notesBaseline)) throw new Error('GENERATION_FINALIZATION_NOTES_CHANGED')
        const chapterNotes = proof.artifact.text.trim(), { source } = context.slot
        const facts = buildFinalizedContinuityFacts(source.chapterNumber, chapterNotes, context.identity.content, context.chapterEntities, context.identity)
        SummaryRepository.saveFinalizedContinuity({ draftId: source.draftId, chapterNumber: source.chapterNumber, source, chapterNotes, facts, projectionGeneration: context.identity.projectionGeneration }, this.db)
        const blueprintUpdated = BlueprintRepository.updateNotes(source.chapterNumber, chapterNotes, this.db)
        receipt = { success: true, stepKey: 'chapter_notes', chapterNotes, factCount: facts.length, blueprintUpdated }
      } else {
        const characterProof = proveFinalizedCharacterGeneration(this.db, this.runs, this.projectId, handle, reference)
        const applied = SummaryRepository.commitFinalizedCharacterStates(characterProof.context, characterProof.response, this.db)
        const batch = characterProof.response.unresolved.some(item => item.displayName.trim())
          ? characters.stage({ kind: 'finalized-generation', handle: characterProof.currentHandle, artifact: reference }) : undefined
        receipt = { success: true, stepKey: 'character_cards', ...applied, unresolved: structuredClone(characterProof.response.unresolved), ...(batch ? { proposalBatchId: batch.proposalBatchId } : {}) }
      }
      const effect: SavedEffect = { version: 1, artifact: structuredClone(reference), contextHash: textHash(JSON.stringify(context)), receipt, receiptHash: textHash(JSON.stringify(receipt)) }
      this.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify({ ...usage, finalizationEffect: effect }), proof.attemptId)
      return structuredClone(receipt)
    }).immediate()
  }
}
