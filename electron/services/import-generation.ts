import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { BeginGenerationRequest } from '../../src/shared/generation-owner-contract'
import type { ImportGenerationContext, ImportGenerationSlot } from '../../src/shared/import-generation'
import { GenerationRunRepository, textHash, type DurableGenerationRun, type GenerationBudgetReceipt } from '../repositories/generation-run-repository'
import { ImportRunRepository } from '../repositories/import-run-repository'
import type { ImportRunExecutionAuthority } from '../../src/shared/import-run'
import { captureImportGenerationContext, importGenerationSlotKey } from './import-generation-source'
import { rootBudgetExhausted } from '../../src/shared/generation-contract'

/** 一个 slot 的第一个运行用 import:<key>；之后每次重来都指明接替的是哪个运行，同一个运行只能被接替一次。 */
export function importSlotNonce(slotKey: string, retryOf?: DurableGenerationRun): string {
  return `import:${slotKey}${retryOf ? `:retry:${retryOf.runId}` : ''}`
}

/** Existing import checkpoints own effects; this class only joins their generation runs. */
export class ImportGeneration {
  constructor(private readonly db: Database.Database, private readonly runs: GenerationRunRepository, private readonly projectId: string) {}
  /** slot 的当前运行：按接替链取最后一个。 */
  find(slot: ImportGenerationSlot): DurableGenerationRun | undefined {
    const key = importGenerationSlotKey(slot)
    const rows = this.db.prepare("SELECT run_id,json_extract(json_extract(open_key,'$[0]'),'$[2]') AS ui_action_nonce FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.importSlotKey')=? ORDER BY rowid").all(key) as { run_id: string; ui_action_nonce: string }[]
    let previous: DurableGenerationRun | undefined
    for (const row of rows) {
      const run = this.runs.get(row.run_id)
      if (run.binding.projectId !== this.projectId) continue
      if (previous && row.ui_action_nonce !== importSlotNonce(key, previous)) throw new Error('GENERATION_IMPORT_SLOT_AMBIGUOUS')
      previous = run
    }
    return previous
  }
  /** 根还能再发请求：没有取消、没有被阻断，请求次数与活动时长都还有余量，请求记录都读得出。 */
  private rootCanDispatch(rootActionId: string): boolean {
    const budget = this.runs.budget(rootActionId)
    return ['active', 'paused'].includes(budget.root.status) && !budget.blockedCode
      && !rootBudgetExhausted(budget.policy, budget.attempts, budget.activeElapsedMs)
      && budget.attempts.every(attempt => this.readable(attempt.attemptId, budget))
  }
  private readable(attemptId: string, budget: GenerationBudgetReceipt): boolean {
    try { this.runs.receipt(attemptId, budget); return true } catch { return false }
  }
  private attemptIds(run: DurableGenerationRun): string[] {
    return this.db.prepare('SELECT attempt_id FROM generation_attempts WHERE run_id=?').pluck().all(run.runId) as string[]
  }
  /**
   * 这个运行有请求的结果永远提交不了：没有正常结束（中断、取消、超时、进程退出后的 unknown），
   * 没留下非空结果，结果被丢弃了（渲染端校验没通过，或者还要再发请求而根已停），或者请求记录读不出。
   * 提交前的核对用的是同一条规则。
   */
  rejected(run: DurableGenerationRun): boolean {
    const budget = this.runs.budget(run.rootActionId)
    return this.attemptIds(run).some(attemptId => {
      let receipt
      try { receipt = this.runs.receipt(attemptId, budget) } catch { return true }
      const artifact = receipt.artifact
      return receipt.result?.finishReason !== 'stop' || !artifact || !artifact.text.trim() || textHash(artifact.text) !== artifact.textHash
        || this.db.prepare("SELECT 1 FROM generation_artifacts WHERE artifact_id=? AND status<>'discarded'").pluck().get(artifact.artifactId) !== 1
    })
  }
  hasAttempts(run: DurableGenerationRun): boolean {
    return this.runs.attemptCount(run.runId) > 0
  }
  /**
   * 这个运行再也交不出可提交的结果，slot 要换一个新运行重来。前提是还没有收据、根上没有请求在途，然后：
   * 结果提交不了就重来；已有合法结果就复用（根额度用完也照样重放提交，不再花钱），除非根被取消；
   * 还没发过请求的运行，只有根已经发不出请求时才重来。
   */
  retryable(run: DurableGenerationRun): boolean {
    const slot = this.context(run).slot
    if (ImportRunRepository.getEffectReceipt(slot.runId, slot.stage, slot.batchId)) return false
    const budget = this.runs.budget(run.rootActionId)
    if (budget.attempts.some(attempt => ['reserved', 'dispatch-marked'].includes(attempt.status))) return false
    if (this.rejected(run)) return true
    return this.hasAttempts(run) ? budget.root.status === 'cancelled' : !this.rootCanDispatch(run.rootActionId)
  }
  /** 这个运行还要再发请求，根却已经发不出：它做不完这一批了，丢弃它的结果，「继续导入」就会为这一批重开。 */
  abandonIfRootStopped(run: DurableGenerationRun): void {
    if (this.rootCanDispatch(run.rootActionId)) return
    const artifactIds = this.db.prepare("SELECT artifact_id FROM generation_artifacts WHERE run_id=? AND status<>'discarded'").pluck().all(run.runId) as string[]
    for (const artifactId of artifactIds) this.runs.discardCandidate(artifactId)
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
  admit(selection: BeginGenerationRequest): { existing?: DurableGenerationRun; retryOf?: DurableGenerationRun; parentRootActionId?: string; modelId?: string; chapterCount?: number } | undefined {
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
    const modelOf = (run: DurableGenerationRun) => (run.binding.sourceManifest.modelReceipt as { modelId: string }).modelId
    if (existing && !this.retryable(existing)) {
      if (selection.modelId !== modelOf(existing)) throw new Error('GENERATION_IMPORT_MODEL_CHANGED')
      return { existing }
    }
    const state = this.db.prepare('SELECT stage,status,cancel_requested FROM import_runs WHERE id=?').get(slot.runId) as { stage: string; status: string; cancel_requested: number } | undefined
    if (!state || state.stage !== slot.stage || state.status !== 'running' || state.cancel_requested) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
    const { totalChapters } = captureImportGenerationContext(this.db, slot)
    const key = importGenerationSlotKey(slot)
    const records = (this.db.prepare("SELECT run_id FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.importSlot.runId')=? ORDER BY rowid").all(slot.runId) as { run_id: string }[])
      .map(row => this.runs.get(row.run_id)).filter(run => run.binding.projectId === this.projectId)
    for (const run of records) {
      const prior = this.context(run).slot
      if (importGenerationSlotKey(prior) === key) continue
      const receipt = ImportRunRepository.getEffectReceipt(prior.runId, prior.stage, prior.batchId)
      if (receipt?.state !== 'committed') throw new Error('GENERATION_IMPORT_PREVIOUS_EFFECT_REQUIRED')
    }
    // 一次导入运行的生成共用一个根。这个根停下后（被阻断、取消或用完），「继续导入」开一个新根接着跑，
    // 它按导入运行的章数重新定额；同一个工作流内带着旧根来的请求仍按旧根处理，停下的原因照旧报出。
    const latest = records.at(-1)
    if (selection.parentRootActionId && selection.parentRootActionId !== latest?.rootActionId) throw new Error('GENERATION_IMPORT_ROOT_CHANGED')
    const parentRootActionId = selection.parentRootActionId
      ?? (latest && this.rootCanDispatch(latest.rootActionId) ? latest.rootActionId : undefined)
    return { retryOf: existing, parentRootActionId, modelId: latest && modelOf(latest),
      chapterCount: parentRootActionId ? undefined : totalChapters }
  }
}
