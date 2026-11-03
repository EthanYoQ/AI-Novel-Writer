import { afterEach, expect, it, vi } from 'vitest'
import { fenceProjectSession } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { blueprintEffect, blueprintSlot, commitSlot, generateSlot, importGenerationFixture, rootBudget, runBlueprints, runGlobal, runStyle, stop, type ImportGenerationFixture } from './import-generation-fixture'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })

const RUN = '长篇导入'
const hang: GenerationRunServiceDependencies['dispatch'] = (_request, options) => new Promise((_resolve, reject) => {
  options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
})

/** 前 5 章蓝图已提交，第 6–10 章这一批的请求正在发出。 */
async function interruptedAtSecondBatch(f: ImportGenerationFixture, dispatch = hang) {
  await runGlobal(f)
  await runStyle(f)
  await runBlueprints(f, f.chapters.slice(0, 5))
  f.current.dispatch = dispatch
  const execution = ImportRunRepository.startOrResume(RUN, '合成执行器').execution
  const slot = blueprintSlot(RUN, f.chapters.slice(5))
  const { handle, receipt } = generateSlot(f, slot, execution)
  await vi.waitFor(() => expect(f.db.prepare("SELECT COUNT(*) FROM generation_attempts WHERE json_extract(attempt_json,'$.status')='dispatch-marked'").pluck().get()).toBe(1))
  return { execution, slot, handle, receipt }
}

/** 「继续导入」：新执行者接着跑剩下的批次，然后核对结果与请求次数。 */
async function continueAndFinish(f: ImportGenerationFixture, owner = f.owner) {
  f.current.dispatch = stop
  await runBlueprints(f, f.chapters.slice(5), RUN, owner, '继续导入的执行者')
  expect(f.db.prepare('SELECT COUNT(*) FROM blueprints').pluck().get()).toBe(10)
  expect(f.db.prepare('SELECT title FROM blueprints WHERE chapter_number=10').pluck().get()).toBe('推演10')
  // global、style、第一批各一次，第二批中断一次、继续后再一次：已提交的批次不重做。
  expect(f.spy).toHaveBeenCalledTimes(5)
}

it.each(['关窗口', '杀进程'] as const)('导入请求途中%s后重新打开作品，「继续导入」接着跑完，已提交的批次不重做', async how => {
  const f = importGenerationFixture(cleanup, 10)
  const { receipt } = await interruptedAtSecondBatch(f)
  receipt.catch(() => undefined)
  if (how === '关窗口') f.owner.suspendForProjectClose()
  fenceProjectSession(f.db)
  await continueAndFinish(f, f.openOwner('epoch-2'))
}, 60_000)

it('请求途中活动时长用完、根被阻断后，「继续导入」接着跑完', async () => {
  const f = importGenerationFixture(cleanup, 10)
  await runGlobal(f)
  await runStyle(f)
  await runBlueprints(f, f.chapters.slice(0, 5))
  const rootActionId = f.db.prepare('SELECT root_action_id FROM generation_roots').pluck().get() as string
  f.db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?').run(rootBudget(f, rootActionId).maxActiveElapsedMs - 200, rootActionId)
  f.current.dispatch = hang
  const execution = ImportRunRepository.startOrResume(RUN, '合成执行器').execution
  const { receipt } = generateSlot(f, blueprintSlot(RUN, f.chapters.slice(5)), execution)
  expect((await receipt).outcome).toMatchObject({ status: 'incomplete', receipt: { failureCode: 'ROOT_BUDGET_EXHAUSTED' } })
  ImportRunRepository.fail(RUN, 'blueprints', '活动时长用完', execution)
  await continueAndFinish(f)
}, 60_000)

it('两次请求之间活动时长已用完时，「继续导入」接着跑完', async () => {
  const f = importGenerationFixture(cleanup, 10)
  await runGlobal(f)
  await runStyle(f)
  await runBlueprints(f, f.chapters.slice(0, 5))
  const rootActionId = f.db.prepare('SELECT root_action_id FROM generation_roots').pluck().get() as string
  f.db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?').run(rootBudget(f, rootActionId).maxActiveElapsedMs, rootActionId)
  const execution = ImportRunRepository.startOrResume(RUN, '合成执行器').execution
  const { receipt } = generateSlot(f, blueprintSlot(RUN, f.chapters.slice(5)), execution, f.owner, rootActionId)
  await expect(receipt).rejects.toThrow('ROOT_BUDGET_EXHAUSTED')
  ImportRunRepository.fail(RUN, 'blueprints', '活动时长用完', execution)
  f.spy.mockClear()
  f.current.dispatch = stop
  await runBlueprints(f, f.chapters.slice(5), RUN, f.owner, '继续导入的执行者')
  expect(f.db.prepare('SELECT COUNT(*) FROM blueprints').pluck().get()).toBe(10)
  expect(f.spy).toHaveBeenCalledTimes(1)
}, 60_000)

it('导入中点取消后，「继续导入」接着跑完', async () => {
  const f = importGenerationFixture(cleanup, 10)
  const { execution, handle, receipt } = await interruptedAtSecondBatch(f)
  ImportRunRepository.requestCancel(RUN, execution)
  f.owner.cancel(handle)
  expect((await receipt).outcome.status).not.toBe('completed')
  ImportRunRepository.cancelAtBoundary(RUN, execution)
  await continueAndFinish(f)
}, 60_000)

it('请求确实还在发出时再点「继续导入」：拒绝，原请求结束后照常提交', async () => {
  const f = importGenerationFixture(cleanup, 10)
  let release!: () => void
  const { execution, slot, handle, receipt } = await interruptedAtSecondBatch(f, (_request, options) => new Promise(resolve => {
    release = () => { options.onVisible({ kind: 'delta', text: '{"合成":"结果"}' }); resolve({ finishReason: 'stop', usage: null }) }
  }))
  expect(() => ImportRunRepository.startOrResume(RUN, '另一个执行者')).toThrow('IMPORT_RUN_EXECUTOR_BUSY')
  release()
  expect((await receipt).outcome.status).toBe('completed')
  commitSlot(f, slot, execution, blueprintEffect(RUN, f.chapters.slice(5))(handle))
  expect(f.db.prepare('SELECT COUNT(*) FROM blueprints').pluck().get()).toBe(10)
}, 60_000)

it('中断那一批的生成记录读不出时只重做这一批，「继续导入」照样跑完', async () => {
  const f = importGenerationFixture(cleanup, 10)
  const { receipt } = await interruptedAtSecondBatch(f)
  receipt.catch(() => undefined)
  fenceProjectSession(f.db)
  const owner = f.openOwner('epoch-2')
  f.db.prepare("UPDATE generation_attempts SET usage_receipt_json='{}' WHERE json_extract(attempt_json,'$.status')='unknown'").run()
  await continueAndFinish(f, owner)
}, 60_000)

/** 第 6–10 章这一批模型正常结束（stop），但结果还没提交。 */
async function completedSecondBatch(f: ImportGenerationFixture) {
  await runGlobal(f)
  await runStyle(f)
  await runBlueprints(f, f.chapters.slice(0, 5))
  const execution = ImportRunRepository.startOrResume(RUN, '合成执行器').execution
  const { handle, receipt } = generateSlot(f, blueprintSlot(RUN, f.chapters.slice(5)), execution)
  const outcome = (await receipt).outcome
  expect(outcome.status).toBe('completed')
  return { execution, handle, artifactId: outcome.receipt.visibleArtifact!.artifactId }
}

it('模型正常结束但输出没通过校验（渲染端丢弃了候选），「继续导入」重新请求这一批并跑完', async () => {
  const f = importGenerationFixture(cleanup, 10)
  const { execution, handle, artifactId } = await completedSecondBatch(f)
  f.owner.discardCandidate(handle, artifactId)
  ImportRunRepository.fail(RUN, 'blueprints', '结构化输出缺少目标项', execution)
  await continueAndFinish(f)
}, 60_000)

it('模型正常结束、还没提交时进程退出：「继续导入」复用这次结果，不再发请求', async () => {
  const f = importGenerationFixture(cleanup, 10)
  await completedSecondBatch(f)
  fenceProjectSession(f.db)
  f.current.dispatch = stop
  await runBlueprints(f, f.chapters.slice(5), RUN, f.openOwner('epoch-2'), '继续导入的执行者')
  expect(f.db.prepare('SELECT COUNT(*) FROM blueprints').pluck().get()).toBe(10)
  expect(f.spy).toHaveBeenCalledTimes(4)
}, 60_000)

it('同一工作流里两次请求之间额度用完：刚开的这一批仍读得到上下文，请求时报额度用完', async () => {
  const f = importGenerationFixture(cleanup, 10)
  await runGlobal(f)
  await runStyle(f)
  await runBlueprints(f, f.chapters.slice(0, 5))
  const rootActionId = f.db.prepare('SELECT root_action_id FROM generation_roots').pluck().get() as string
  f.db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?').run(rootBudget(f, rootActionId).maxActiveElapsedMs, rootActionId)
  const execution = ImportRunRepository.startOrResume(RUN, '合成执行器').execution
  const slot = blueprintSlot(RUN, f.chapters.slice(5))
  const { handle, receipt } = generateSlot(f, slot, execution, f.owner, rootActionId)
  await expect(receipt).rejects.toThrow('ROOT_BUDGET_EXHAUSTED')
  expect(f.owner.readImportGeneration(slot, handle.runId)?.view.handle.runId).toBe(handle.runId)
}, 60_000)
