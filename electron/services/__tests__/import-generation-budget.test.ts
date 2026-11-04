import { afterEach, expect, it, vi } from 'vitest'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import type { BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import { planBlueprintGenerationCost } from '../../../src/services/workflows/blueprint-batch-policy'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { importGenerationFixture, model, rootBudget, runBlueprints, runGlobal, runStyle, stageSelection, stop } from './import-generation-fixture'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })

/** 默认根：32 次物理请求、1 小时活动时长。导入根应按整个导入运行的工作量放大。 */
function expectedImportRootBudget(chapterCount: number) {
  const requests = 2 * 32 + planBlueprintGenerationCost(chapterCount).recoveryCallBound
  return { maxPhysicalRequests: requests, maxActiveElapsedMs: 3_600_000 / 32 * requests }
}

const fixture = (chapterCount: number, dispatch: GenerationRunServiceDependencies['dispatch'] = stop) => importGenerationFixture(cleanup, chapterCount, dispatch)

it('160 章参考小说导入：global、style 与全部 32 批蓝图共用的根按整个导入运行的工作量定额，一次跑完', async () => {
  const f = fixture(160)
  const global = await runGlobal(f)
  const style = await runStyle(f)
  const blueprints = await runBlueprints(f, f.chapters)
  expect(new Set([global, style, ...blueprints].map(handle => (handle as { rootActionId: string }).rootActionId)).size).toBe(1)
  expect(f.spy).toHaveBeenCalledTimes(34)
  expect(f.db.prepare('SELECT COUNT(*) FROM blueprints').pluck().get()).toBe(160)
  const budget = rootBudget(f, (global as { rootActionId: string }).rootActionId)
  expect(budget).toMatchObject(expectedImportRootBudget(160))
  const binding = JSON.parse(f.db.prepare('SELECT binding_json FROM generation_runs ORDER BY rowid LIMIT 1').pluck().get() as string)
  expect(readMainGenerationPolicy(binding.sourceManifest.policy).budget).toEqual(budget)
}, 120_000)

it.each(['style', 'blueprints'] as const)('重新开始后第一个 slot 落在 %s 阶段时，新根仍按整个导入运行的工作量定额并能跑完', async stage => {
  const f = fixture(170)
  const oldRoot = (await runGlobal(f) as { rootActionId: string }).rootActionId
  if (stage === 'blueprints') {
    await runStyle(f)
    await runBlueprints(f, f.chapters.slice(0, 150))
    f.db.prepare("UPDATE blueprints SET user_guidance='作者补充：信件来自灯塔', notes='作者批注' WHERE chapter_number=3").run()
  }
  f.db.prepare("UPDATE import_runs SET status='failed' WHERE id='长篇导入'").run()
  const restarted = ImportRunRepository.restart('长篇导入', '重新开始')
  expect(restarted.stage).toBe(stage)
  if (stage === 'style') await runStyle(f, '重新开始')
  const handles = await runBlueprints(f, f.chapters, '重新开始')
  const newRoot = (handles[0] as { rootActionId: string }).rootActionId
  expect(newRoot).not.toBe(oldRoot)
  expect(rootBudget(f, newRoot)).toMatchObject(expectedImportRootBudget(170))
  expect(f.db.prepare('SELECT COUNT(*) FROM blueprints').pluck().get()).toBe(170)
  expect(f.db.prepare('SELECT title FROM blueprints WHERE chapter_number=150').pluck().get()).toBe('推演150')
  if (stage === 'blueprints') expect(f.db.prepare('SELECT user_guidance,notes FROM blueprints WHERE chapter_number=3').get()).toEqual({ user_guidance: '作者补充：信件来自灯塔', notes: '作者批注' })
}, 180_000)

it('请求进行中活动时长用完时，导入回执把 ROOT_BUDGET_EXHAUSTED 交给渲染端', async () => {
  const f = fixture(1, async (_request, options) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 3000)
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
    })
    return { finishReason: 'stop', usage: null }
  })
  const execution = ImportRunRepository.startOrResume('长篇导入', '合成执行器').execution
  const slot = { runId: '长篇导入', stage: 'global' as const, batchId: 'done' }
  const { handle } = f.owner.begin({ ...stageSelection.global, uiActionNonce: '首次导入', modelId: model.id, selectedDraftIds: [], selectedFinalizedDraftIds: [], importSlot: slot, importExecution: { owner: execution.owner, epoch: execution.epoch } } as BeginGenerationRequest)
  f.db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?').run(rootBudget(f, handle.rootActionId).maxActiveElapsedMs - 200, handle.rootActionId)
  const receipt = await f.owner.executeImportGeneration({ execution, handle, ordinal: 0, task: { purpose: 'import-global', output: 'structured-data', messages: [{ role: 'user', content: '推演参考小说' }] } })
  expect(f.db.prepare('SELECT blocked_code FROM generation_roots WHERE root_action_id=?').pluck().get(handle.rootActionId)).toBe('ROOT_BUDGET_EXHAUSTED')
  expect(receipt.outcome).toMatchObject({ status: 'incomplete', finishReason: 'error', receipt: { failureCode: 'ROOT_BUDGET_EXHAUSTED' } })
}, 30_000)
