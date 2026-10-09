import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { BeginGenerationRequest } from '../../src/shared/generation-owner-contract'
import type { ImportGenerationContext, ImportGenerationSlot } from '../../src/shared/import-generation'
import { GenerationRunRepository, type DurableGenerationRun } from '../repositories/generation-run-repository'
import { ImportRunRepository } from '../repositories/import-run-repository'
import type { ImportRunExecutionAuthority } from '../../src/shared/import-run'
import { captureImportGenerationContext, importGenerationSlotKey } from './import-generation-source'

/** Existing import checkpoints own effects; this class only joins their generation runs. */
export class ImportGeneration {
  constructor(private readonly db: Database.Database, private readonly runs: GenerationRunRepository, private readonly projectId: string) {}
  find(slot: ImportGenerationSlot): DurableGenerationRun | undefined {
    const key = importGenerationSlotKey(slot)
    const rows = this.db.prepare("SELECT run_id FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.importSlotKey')=?").all(key) as { run_id: string }[]
    const records = rows.map(row => this.runs.get(row.run_id)).filter(run => run.binding.projectId === this.projectId)
    if (records.length > 1) throw new Error('GENERATION_IMPORT_SLOT_AMBIGUOUS')
    return records[0]
  }
  context(run: DurableGenerationRun): ImportGenerationContext {
    const context = run.binding.sourceManifest.importContext as ImportGenerationContext | undefined
    if (!context || importGenerationSlotKey(context.slot) !== run.binding.sourceManifest.importSlotKey) throw new Error('GENERATION_IMPORT_CONTEXT_REQUIRED')
    return structuredClone(context)
  }
  assertMutable(run: DurableGenerationRun): void {
    if (!run.binding.sourceManifest.importSlot) return
    const slot = this.context(run).slot
    if (ImportRunRepository.getEffectReceipt(slot.runId, slot.stage, slot.batchId)) throw new Error('GENERATION_IMPORT_EFFECT_SEALED')
  }
  assertExecution(run: DurableGenerationRun, execution?: ImportRunExecutionAuthority): void {
    const slot = this.context(run).slot
    if (!execution) throw new Error('GENERATION_IMPORT_EXECUTION_REQUIRED')
    ImportRunRepository.assertExecutionAuthority(slot.runId, execution)
    const state = this.db.prepare('SELECT stage,status,cancel_requested FROM import_runs WHERE id=?').get(slot.runId) as { stage: string; status: string; cancel_requested: number } | undefined
    if (!state || state.stage !== slot.stage || state.status !== 'running' || state.cancel_requested) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
  }
  admit(selection: BeginGenerationRequest): { existing?: DurableGenerationRun; parentRootActionId?: string; modelId?: string } | undefined {
    const slot = selection.importSlot
    if (!slot) {
      if (selection.importExecution || ['import-global-facts', 'import-blueprints'].includes(selection.operation)) throw new Error('GENERATION_IMPORT_SLOT_REQUIRED')
      return undefined
    }
    const existing = this.find(slot)
    const operation = { global: 'import-global-facts', style: 'analyze-writing-style', blueprints: 'import-blueprints' }[slot.stage]
    const promptKeys = slot.stage === 'global' ? ['infer_novel_config_with_vectors', 'infer_novel_config'] : slot.stage === 'style' ? ['analyze_writing_style'] : ['infer_single_chapter_blueprint']
    if (selection.operation !== operation || !selection.importExecution || selection.batchId || selection.batchIntent
      || selection.agentWorkflowRegistrationId || selection.continueDirectoryOperationId
      || !isDeepStrictEqual(selection.promptKeys, promptKeys) || !isDeepStrictEqual(selection.skillStages, slot.stage === 'style' ? [] : ['planning'])
      || selection.output !== (slot.stage === 'style' ? 'visible-text' : 'structured-data')) throw new Error('GENERATION_IMPORT_STAGE_INVALID')
    ImportRunRepository.assertExecutionAuthority(slot.runId, selection.importExecution)
    if (existing) {
      if (selection.modelId !== (existing.binding.sourceManifest.modelReceipt as { modelId: string }).modelId) throw new Error('GENERATION_IMPORT_MODEL_CHANGED')
      return { existing }
    }
    const state = this.db.prepare('SELECT stage,status,cancel_requested FROM import_runs WHERE id=?').get(slot.runId) as { stage: string; status: string; cancel_requested: number } | undefined
    if (!state || state.stage !== slot.stage || state.status !== 'running' || state.cancel_requested) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
    captureImportGenerationContext(this.db, slot)
    const records = (this.db.prepare("SELECT run_id FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.importSlot.runId')=? ORDER BY rowid").all(slot.runId) as { run_id: string }[])
      .map(row => this.runs.get(row.run_id)).filter(run => run.binding.projectId === this.projectId)
    const roots = new Set(records.map(run => run.rootActionId))
    if (roots.size > 1) throw new Error('GENERATION_IMPORT_ROOT_AMBIGUOUS')
    for (const run of records) {
      const prior = this.context(run).slot
      const receipt = ImportRunRepository.getEffectReceipt(prior.runId, prior.stage, prior.batchId)
      if (receipt?.state !== 'committed') throw new Error('GENERATION_IMPORT_PREVIOUS_EFFECT_REQUIRED')
    }
    const parentRootActionId = records[0]?.rootActionId
    if (selection.parentRootActionId && selection.parentRootActionId !== parentRootActionId) throw new Error('GENERATION_IMPORT_ROOT_CHANGED')
    return { ...(parentRootActionId ? { parentRootActionId, modelId: (records[0]!.binding.sourceManifest.modelReceipt as { modelId: string }).modelId } : {}) }
  }
}
