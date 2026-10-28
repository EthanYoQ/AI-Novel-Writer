import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { projectAccess } from '../project-access'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { getProjectDb, getCurrentProjectPath } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import { createImportRunChapterBatchCheckpointId, type ImportRunChapterSnapshot } from '../../../src/shared/import-run'
import { planBlueprintGenerationCost } from '../../../src/services/workflows/blueprint-batch-policy'
import type { ImportGenerationSlot } from '../../../src/shared/import-generation'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
const stop: GenerationRunServiceDependencies['dispatch'] = async (_request, options) => { options.onVisible({ kind: 'delta', text: '{"合成":"结果"}' }); return { finishReason: 'stop', usage: null } }

function chapter(number: number): ImportRunChapterSnapshot {
  const content = `第${number}章 海港\r\n林岚在港口找到了第${number}封信。`
  return { number, title: `海港${number}`, content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }
}

/** 默认根：32 次物理请求、1 小时活动时长。导入根应按整个导入运行的工作量放大。 */
function expectedImportRootBudget(chapterCount: number) {
  const requests = 2 * 32 + planBlueprintGenerationCost(chapterCount).recoveryCallBound
  return { maxPhysicalRequests: requests, maxActiveElapsedMs: 3_600_000 / 32 * requests }
}

function fixture(chapterCount: number, dispatch: GenerationRunServiceDependencies['dispatch'] = stop) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/import-budget-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  prepareCanonicalStorageFixture(root)
  const project = projectAccess.probeExistingProject(root)
  if (project.kind !== 'manifest') throw new Error('fixture project identity missing')
  vi.mocked(getCurrentProjectPath).mockReturnValue(root)
  const db = new Database(path.join(root, '.ai-novel', 'project.db'))
  vi.mocked(getProjectDb).mockReturnValue(db)
  db.exec("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','长篇导入',100)")
  const spy = vi.fn(dispatch)
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: (key: string) => JSON.stringify({ key, content: '冻结的合成提示词', systemRole: '写作助手' }) }
  const epoch = 'epoch-1'
  const owner = createMainGenerationOwner({ database: db, projectId: project.projectId, epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: spy,
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: project.projectId, epoch, modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const chapters = Array.from({ length: chapterCount }, (_, index) => chapter(index + 1))
  ImportRunRepository.prepare({ runId: '长篇导入', purpose: 'reference', sourceFingerprint: 'a'.repeat(64), locale: 'zh-CN', sourceDisplay: [{ displayName: '参考小说.txt', mediaType: 'text/plain', size: 1 }], chapters })
  db.prepare("UPDATE import_runs SET stage='global' WHERE id='长篇导入'").run()
  return { db, owner, spy, chapters }
}
type Fixture = ReturnType<typeof fixture>

const stageSelection: Record<ImportGenerationSlot['stage'], Pick<BeginGenerationRequest, 'operation' | 'promptKeys' | 'skillStages'> & { output: 'structured-data' | 'visible-text' }> = {
  global: { operation: 'import-global-facts', promptKeys: ['infer_novel_config_with_vectors', 'infer_novel_config'], skillStages: ['planning'], output: 'structured-data' },
  style: { operation: 'analyze-writing-style', promptKeys: ['analyze_writing_style'], skillStages: [], output: 'visible-text' },
  blueprints: { operation: 'import-blueprints', promptKeys: ['infer_single_chapter_blueprint'], skillStages: ['planning'], output: 'structured-data' },
}

async function runSlot(f: Fixture, runId: string, slot: ImportGenerationSlot, payload: (handle: unknown) => { effectKey: string; kind: 'project-global-facts' | 'project-writing-style' | 'chapter-blueprint-range'; payload: Record<string, unknown> }) {
  const execution = ImportRunRepository.startOrResume(runId, '合成执行器').execution
  const selection = { ...stageSelection[slot.stage], uiActionNonce: `${slot.stage}:${slot.batchId}`, modelId: model.id, selectedDraftIds: [], selectedFinalizedDraftIds: [],
    importSlot: slot, importExecution: { owner: execution.owner, epoch: execution.epoch } } as BeginGenerationRequest
  const { handle } = f.owner.begin(selection)
  const receipt = await f.owner.executeImportGeneration({ execution, handle, ordinal: 0, task: { purpose: `import-${slot.stage}`, output: stageSelection[slot.stage].output, messages: [{ role: 'user', content: '推演参考小说' }] } })
  expect(receipt.outcome.status).toBe('completed')
  const effect = payload(handle)
  ImportRunRepository.prepareEffectReceipt({ runId, stage: slot.stage, batchId: slot.batchId, ...effect }, execution)
  expect(ImportRunRepository.commitEffectReceipt(runId, slot.stage, slot.batchId, execution, Date.now(), f.owner.assertImportGenerationSources).receipt.state).toBe('committed')
  return { handle, execution }
}

async function runGlobal(f: Fixture, runId = '长篇导入') {
  const core = { genre: '现实', subGenre: '冒险', targetAudience: '通用', totalChapters: f.chapters.length, wordsPerChapter: 900, plotStructure: 'three_act', narrativePov: 'third_limited', goldenFinger: '无', globalGuidance: '克制', premise: '海港来信', coreOutline: '寻找来信者', worldSetting: '海港', protagonistProfile: '林岚', worldbuilding: '海港街巷', synopsis: '找到信件' }
  const card = { name: '林岚', role: 'protagonist', gender: '未知', age: '18', appearance: '朴素', personality: '谨慎', background: '港口居民', abilities: '观察', motivation: '寻信', relationships: [], arc: '成长', notes: '待确认' }
  const { handle, execution } = await runSlot(f, runId, { runId, stage: 'global', batchId: 'done' }, generationRunHandle => ({ effectKey: 'global-facts', kind: 'project-global-facts',
    payload: { operationId: `novel-import-global-${runId}`, expectedRosterRevision: 0, core, characterEntries: [card], generationRunHandle } }))
  ImportRunRepository.advanceStage(runId, 'global', 'style', execution)
  return handle
}

async function runStyle(f: Fixture, runId = '长篇导入') {
  const { handle, execution } = await runSlot(f, runId, { runId, stage: 'style', batchId: 'done' }, generationRunHandle => ({ effectKey: 'writing-style', kind: 'project-writing-style', payload: { writingStyle: '克制', generationRunHandle } }))
  ImportRunRepository.advanceStage(runId, 'style', 'blueprints', execution)
  return handle
}

async function runBlueprints(f: Fixture, chapters: readonly ImportRunChapterSnapshot[], runId = '长篇导入') {
  const handles = []
  for (let offset = 0; offset < chapters.length; offset += 5) {
    const batch = chapters.slice(offset, offset + 5)
    const start = batch[0]!.number, end = batch.at(-1)!.number, batchId = createImportRunChapterBatchCheckpointId(batch)
    const { handle } = await runSlot(f, runId, { runId, stage: 'blueprints', batchId }, generationRunHandle => ({ effectKey: `blueprints:${batchId}`, kind: 'chapter-blueprint-range',
      payload: { mode: 'replace-range', operationId: `import-blueprints-${runId}-${start}-${end}`, startChapter: start, endChapter: end, generationRunHandle,
        blueprints: batch.map(item => ({ chapterNumber: item.number, title: `推演${item.number}`, role: 'setup', purpose: `推进第${item.number}章`, keyEvents: `事件${item.number}`, characters: [], suspenseHook: `悬念${item.number}`, userGuidance: '', notes: '', notesUpdatedAt: '' })) } }))
    handles.push(handle)
  }
  return handles
}

const rootBudget = (f: Fixture, rootActionId: string) => JSON.parse(f.db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(rootActionId) as string) as Record<string, number>

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
