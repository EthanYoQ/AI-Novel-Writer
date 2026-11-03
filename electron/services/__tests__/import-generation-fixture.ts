import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { expect, vi } from 'vitest'
import { projectAccess } from '../project-access'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { getProjectDb, getCurrentProjectPath } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import { createImportRunChapterBatchCheckpointId, type ImportRunChapterSnapshot, type ImportRunExecutionLease } from '../../../src/shared/import-run'
import type { ImportGenerationSlot } from '../../../src/shared/import-generation'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
type Owner = ReturnType<typeof createMainGenerationOwner>
type Dispatch = GenerationRunServiceDependencies['dispatch']

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
export const stop: Dispatch = async (_request, options) => { options.onVisible({ kind: 'delta', text: '{"合成":"结果"}' }); return { finishReason: 'stop', usage: null } }

function chapter(number: number): ImportRunChapterSnapshot {
  const content = `第${number}章 海港\r\n林岚在港口找到了第${number}封信。`
  return { number, title: `海港${number}`, content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }
}

/** 一个真实 owner 与 repository 的导入项目；dispatch 可在测试中途替换，openOwner 模拟关窗口或进程退出后重新打开作品。 */
export function importGenerationFixture(cleanup: (() => void)[], chapterCount: number, dispatch: Dispatch = stop) {
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
  const current = { dispatch }
  const spy = vi.fn<Dispatch>((request, options) => current.dispatch(request, options))
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: (key: string) => JSON.stringify({ key, content: '冻结的合成提示词', systemRole: '写作助手' }) }
  const owners: Owner[] = []
  const openOwner = (epoch: string) => {
    const owner = createMainGenerationOwner({ database: db, projectId: project.projectId, epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: spy,
      buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: project.projectId, epoch, modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
      rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
    owners.push(owner)
    return owner
  }
  const f = { db, spy, current, openOwner, owner: openOwner('epoch-1'), chapters: Array.from({ length: chapterCount }, (_, index) => chapter(index + 1)) }
  cleanup.push(() => { for (const owner of owners) { try { owner.suspendForProjectClose() } catch { /* 已模拟崩溃的 owner 不再收尾 */ } } db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  ImportRunRepository.prepare({ runId: '长篇导入', purpose: 'reference', sourceFingerprint: 'a'.repeat(64), locale: 'zh-CN', sourceDisplay: [{ displayName: '参考小说.txt', mediaType: 'text/plain', size: 1 }], chapters: f.chapters })
  db.prepare("UPDATE import_runs SET stage='global' WHERE id='长篇导入'").run()
  return f
}
export type ImportGenerationFixture = ReturnType<typeof importGenerationFixture>

export const stageSelection: Record<ImportGenerationSlot['stage'], Pick<BeginGenerationRequest, 'operation' | 'promptKeys' | 'skillStages'> & { output: 'structured-data' | 'visible-text' }> = {
  global: { operation: 'import-global-facts', promptKeys: ['infer_novel_config_with_vectors', 'infer_novel_config'], skillStages: ['planning'], output: 'structured-data' },
  style: { operation: 'analyze-writing-style', promptKeys: ['analyze_writing_style'], skillStages: [], output: 'visible-text' },
  blueprints: { operation: 'import-blueprints', promptKeys: ['infer_single_chapter_blueprint'], skillStages: ['planning'], output: 'structured-data' },
}

type EffectOf = (handle: unknown) => { effectKey: string; kind: 'project-global-facts' | 'project-writing-style' | 'chapter-blueprint-range'; payload: Record<string, unknown> }

/**
 * 渲染端打开一个 slot 的方式：主进程已有这个 slot 的运行就接着用，没有才 begin。
 * 同一个工作流里前一步已经开过根时，begin 带着那个根（parentRootActionId）。
 */
export function openSlot(f: ImportGenerationFixture, slot: ImportGenerationSlot, execution: ImportRunExecutionLease, owner = f.owner, parentRootActionId?: string) {
  const recovery = owner.readImportGeneration(slot)
  if (recovery) return recovery.view.handle
  return owner.begin({ ...stageSelection[slot.stage], uiActionNonce: `${slot.stage}:${slot.batchId}`, modelId: model.id, selectedDraftIds: [], selectedFinalizedDraftIds: [],
    importSlot: slot, importExecution: { owner: execution.owner, epoch: execution.epoch }, ...(parentRootActionId ? { parentRootActionId } : {}) } as BeginGenerationRequest).handle
}

export function generateSlot(f: ImportGenerationFixture, slot: ImportGenerationSlot, execution: ImportRunExecutionLease, owner = f.owner, parentRootActionId?: string) {
  const handle = openSlot(f, slot, execution, owner, parentRootActionId)
  const receipt = owner.executeImportGeneration({ execution, handle, ordinal: 0, task: { purpose: `import-${slot.stage}`, output: stageSelection[slot.stage].output, messages: [{ role: 'user', content: '推演参考小说' }] } })
  return { handle, receipt }
}

export function commitSlot(f: ImportGenerationFixture, slot: ImportGenerationSlot, execution: ImportRunExecutionLease, effect: ReturnType<EffectOf>, owner = f.owner) {
  ImportRunRepository.prepareEffectReceipt({ runId: slot.runId, stage: slot.stage, batchId: slot.batchId, ...effect }, execution)
  expect(ImportRunRepository.commitEffectReceipt(slot.runId, slot.stage, slot.batchId, execution, Date.now(), owner.assertImportGenerationSources).receipt.state).toBe('committed')
}

export async function runSlot(f: ImportGenerationFixture, runId: string, slot: ImportGenerationSlot, payload: EffectOf, owner = f.owner, executor = '合成执行器') {
  const execution = ImportRunRepository.startOrResume(runId, executor).execution
  const { handle, receipt } = generateSlot(f, slot, execution, owner)
  expect((await receipt).outcome.status).toBe('completed')
  commitSlot(f, slot, execution, payload(handle), owner)
  return { handle, execution }
}

export const globalEffect = (f: ImportGenerationFixture, runId: string): EffectOf => generationRunHandle => {
  const core = { genre: '现实', subGenre: '冒险', targetAudience: '通用', totalChapters: f.chapters.length, wordsPerChapter: 900, plotStructure: 'three_act', narrativePov: 'third_limited', goldenFinger: '无', globalGuidance: '克制', premise: '海港来信', coreOutline: '寻找来信者', worldSetting: '海港', protagonistProfile: '林岚', worldbuilding: '海港街巷', synopsis: '找到信件' }
  const card = { name: '林岚', role: 'protagonist', gender: '未知', age: '18', appearance: '朴素', personality: '谨慎', background: '港口居民', abilities: '观察', motivation: '寻信', relationships: [], arc: '成长', notes: '待确认' }
  return { effectKey: 'global-facts', kind: 'project-global-facts', payload: { operationId: `novel-import-global-${runId}`, expectedRosterRevision: 0, core, characterEntries: [card], generationRunHandle } }
}

export const styleEffect: EffectOf = generationRunHandle => ({ effectKey: 'writing-style', kind: 'project-writing-style', payload: { writingStyle: '克制', generationRunHandle } })

export const blueprintSlot = (runId: string, batch: readonly ImportRunChapterSnapshot[]): ImportGenerationSlot => ({ runId, stage: 'blueprints', batchId: createImportRunChapterBatchCheckpointId(batch) })

export const blueprintEffect = (runId: string, batch: readonly ImportRunChapterSnapshot[]): EffectOf => generationRunHandle => {
  const start = batch[0]!.number, end = batch.at(-1)!.number, batchId = createImportRunChapterBatchCheckpointId(batch)
  return { effectKey: `blueprints:${batchId}`, kind: 'chapter-blueprint-range',
    payload: { mode: 'replace-range', operationId: `import-blueprints-${runId}-${start}-${end}`, startChapter: start, endChapter: end, generationRunHandle,
      blueprints: batch.map(item => ({ chapterNumber: item.number, title: `推演${item.number}`, role: 'setup', purpose: `推进第${item.number}章`, keyEvents: `事件${item.number}`, characters: [], suspenseHook: `悬念${item.number}`, userGuidance: '', notes: '', notesUpdatedAt: '' })) } }
}

export async function runGlobal(f: ImportGenerationFixture, runId = '长篇导入') {
  const { handle, execution } = await runSlot(f, runId, { runId, stage: 'global', batchId: 'done' }, globalEffect(f, runId))
  ImportRunRepository.advanceStage(runId, 'global', 'style', execution)
  return handle
}

export async function runStyle(f: ImportGenerationFixture, runId = '长篇导入') {
  const { handle, execution } = await runSlot(f, runId, { runId, stage: 'style', batchId: 'done' }, styleEffect)
  ImportRunRepository.advanceStage(runId, 'style', 'blueprints', execution)
  return handle
}

export async function runBlueprints(f: ImportGenerationFixture, chapters: readonly ImportRunChapterSnapshot[], runId = '长篇导入', owner = f.owner, executor = '合成执行器') {
  const handles = []
  for (let offset = 0; offset < chapters.length; offset += 5) {
    const batch = chapters.slice(offset, offset + 5)
    const { handle } = await runSlot(f, runId, blueprintSlot(runId, batch), blueprintEffect(runId, batch), owner, executor)
    handles.push(handle)
  }
  return handles
}

export const rootBudget = (f: ImportGenerationFixture, rootActionId: string) => JSON.parse(f.db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(rootActionId) as string) as Record<string, number>
