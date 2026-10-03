import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { createMainGenerationOwner } from '../main-generation-owner'
import { batchRootBudget, buildMainGenerationPlan, MAIN_GENERATION_POLICY } from '../main-generation-plan'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { readBuiltinWritingSkill } from '../../../src/shared/builtin-writing-skills'
import type { BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import { generationOutputContract, MAX_BATCH_CHAPTERS } from '../../../src/shared/generation-owner-contract'
import { GenerationRunRepository, textHash } from '../../repositories/generation-run-repository'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import { composeVisibleContinuation } from '../../../src/shared/visible-continuation'
import { sanitizeDraftText, DRAFT_VISIBLE_TEXT_VERSION, type DraftVisibleTextVersion } from '../../../src/shared/draft-visible-text'
import { DRAFT_RECONCILE_PURPOSE, parseDraftReconciliation, renderDraftReconciliationBlock } from '../../../src/shared/draft-reconciliation'
import { DRAFT_SHORT_OUTLINE_PURPOSE, draftShortOutlineBlock } from '../../../src/shared/draft-short-outline'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { PostProcessRepository } from '../../repositories/post-process-repository'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { getProjectDb } from '../../database'
import { BlueprintRepository, type BlueprintRangeCommitRequest } from '../../repositories/blueprint-repository'
import { commitCharacterIdentities } from '../../repositories/character-roster-repository'
vi.mock('../../database', () => ({ getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn(() => null) }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanups: (() => void)[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0)) cleanup() })
const task = { purpose: 'chapter-draft', output: 'visible-text' as const, messages: [{ role: 'user' as const, content: '保留作者事实，创作中文段落。' }] }
function fixture(dispatch?: GenerationRunServiceDependencies['dispatch'], silicon = false,
  onReasoning?: (event: { projectId: string; epoch: string; rootActionId: string; runId: string; attemptId: string; text: string }) => void,
  onSnapshot?: import('../main-generation-owner').MainGenerationOwnerDependencies['onSnapshot']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s05-owner-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  const projectStorageRoot = path.join(root, 'project'), globalDataRoot = path.join(root, 'global')
  fs.mkdirSync(projectStorageRoot); fs.mkdirSync(globalDataRoot)
  let db = new Database(path.join(root, 'project.db'))
  vi.mocked(getProjectDb).mockImplementation(() => db)
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.exec("INSERT INTO project_core(id,project_name,global_guidance) VALUES('main','合成小说','保持原文'); INSERT INTO blueprints(chapter_number,title) VALUES(1,'第一章')")
  let epoch = 'epoch-1', current = true
  const model: ModelProfile = { id: 'model', name: '合成模型', provider: silicon ? 'siliconflow' : 'openai', protocol: 'openai',
    modelName: silicon ? 'deepseek-ai/DeepSeek-V4-Flash' : 'gpt-4.1', apiKey: 'synthetic-private-key',
    baseUrl: silicon ? 'https://api.siliconflow.cn/v1' : 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'],
    capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: false, usage: true } }
  const makeOwner = () => {
    const capturedDb = db, capturedEpoch = epoch
    const sourceDeps = { db: capturedDb, projectStorageRoot, globalDataRoot,
      readBuiltinPrompt: (key: string, language: 'zh-CN' | 'en-US') => JSON.stringify(getBuiltinPromptTemplate(key, language)), readBuiltinSkill: readBuiltinWritingSkill }
    return createMainGenerationOwner({ database: capturedDb, projectId: 'project', epoch: capturedEpoch,
      assertCurrent: () => { if (!current || capturedEpoch !== epoch || capturedDb !== db) throw new Error('GENERATION_EPOCH_STALE') },
      leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch,
      onReasoning,
      onSnapshot,
      buildBinding: (selection, modelReceipt) => buildGenerationSourceBinding(sourceDeps, { ...selection, projectId: 'project', epoch: capturedEpoch,
        modelReceipt, policy: MAIN_GENERATION_POLICY, outputContract: generationOutputContract(selection) }).binding,
      rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(sourceDeps, previous, capturedEpoch, modelReceipt, MAIN_GENERATION_POLICY).binding,
    })
  }
  const owners = [makeOwner()]
  cleanups.push(() => { for (const owner of owners) { try { owner.suspendForProjectClose() } catch { /* injected disk error retains tail */ } }
    if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const begin: BeginGenerationRequest = { operation: 'chapter-draft', uiActionNonce: 'click', modelId: model.id, chapterNumber: 1,
    selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['first_chapter_draft'], skillStages: [], output: 'visible-text' }
  return { root, model, get db() { return db }, owner: owners[0], begin,
    invalidate: () => { current = false },
    reopen: () => { owners.at(-1)!.suspendForProjectClose(); db.close(); db = new Database(path.join(root, 'project.db')); epoch = 'epoch-2';
      const owner = makeOwner(); owners.push(owner); return owner },
  }
}
function syntheticStream() {
  const fetch = vi.fn<(url: string, options: RequestInit) => Promise<{ ok: boolean; body: ReadableStream<Uint8Array> }>>(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"隐藏推理","content":" 正文\\n"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":12,"total_tokens":62}}\n\ndata: [DONE]\n\n'))
    controller.close()
  } }) }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('automatic short outline binding', () => {
  const base = '原目标：读信。作者约束：不得离开房间。'
  const outlinePrompt = '短细纲输入'
  const outline = '前驱：信已送到；行动：在房内读信；结果：获知消息。'
  const composed = `${base}\n\n${draftShortOutlineBlock('zh-CN', outline)}`
  const decision = { version: 1 as const, verdict: 'admitted' as const,
    promptHash: textHash(base), shortOutlinePromptHash: textHash(outlinePrompt),
    capacity: { maxInputUnits: 8000, methodVersion: 'utf8-bytes-v1' as const, admittedUnits: 1 },
    coverage: { required: 1, included: 1, complete: true }, included: [{ sourceId: 'author:required', revision: 1, contentHash: 'a'.repeat(64), category: 'author' as const, required: true, units: 1 }], omitted: [] }
  const outlineTask = { purpose: DRAFT_SHORT_OUTLINE_PURPOSE, output: 'visible-text' as const, messages: [{ role: 'user' as const, content: outlinePrompt }] }
  const draftTask = (content: string) => ({ ...task, messages: [{ role: 'user' as const, content }] })
  it('sends a hand-entered model through the native adapter for outline then prose with unknown usage', async () => {
    const f = fixture()
    Object.assign(f.model, { provider: 'custom', baseUrl: 'http://localhost:8000/v1', modelName: 'hand-entered', capabilities: null })
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe('hand-entered')
      expect(body).not.toHaveProperty('reasoning_effort')
      const content = body.messages[0].content === outlinePrompt ? outline : '正文。'
      return { ok: true, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
        controller.close()
      } }) }
    })
    vi.stubGlobal('fetch', fetch)
    const run = f.owner.begin({ ...f.begin, materialDecision: decision })
    await f.owner.execute({ handle: run.handle, invocationNonce: 'outline', task: outlineTask })
    const drafted = await f.owner.execute({ handle: run.handle, invocationNonce: 'prose', task: draftTask(composed) })
    expect(drafted.outcome).toMatchObject({ status: 'completed', content: '正文。' })
    expect(drafted.run.ledger).toMatchObject({ physicalRequests: 2 })
    const repository = new GenerationRunRepository(() => f.db)
    expect(repository.budget(run.handle.rootActionId).attempts.every(attempt => attempt.status === 'unknown' && attempt.reservedTokens > 0)).toBe(true)
    const owner = f.reopen(), resumed = await owner.resume(run.handle)
    await owner.execute({ handle: resumed.handle, invocationNonce: 'prose', task: draftTask(composed) })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(owner.readContext(resumed.handle).draftShortOutline?.completedOutput).toBe(outline)
  })
  it('requires and consumes its native artifact, then preserves the exact draft task across reopen', async () => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (request, options) => {
      options.onVisible({ kind: 'delta', text: (request as { task: GenerationTask }).task.purpose === DRAFT_SHORT_OUTLINE_PURPOSE ? outline : '正文。' })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    const run = f.owner.begin({ ...f.begin, materialDecision: decision })
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'skip', task: draftTask(base) })).rejects.toThrow('GENERATION_DRAFT_SHORT_OUTLINE_REQUIRED')
    const planned = await f.owner.execute({ handle: run.handle, invocationNonce: 'outline', task: outlineTask })
    expect(planned.run.artifacts[0]).toMatchObject({ text: outline, compositionEligible: false })
    expect(() => f.owner.composeVisible(run.handle, [planned.run.artifacts[0]!.artifactId], textHash(outline), DRAFT_VISIBLE_TEXT_VERSION)).toThrow('GENERATION_COMPOSITION_SOURCE_INVALID')
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'omit', task: draftTask(base) })).rejects.toThrow('GENERATION_MATERIAL_PROMPT_MISMATCH')
    await f.owner.execute({ handle: run.handle, invocationNonce: 'draft', task: draftTask(composed) })
    const owner = f.reopen()
    const resumed = await owner.resume(run.handle)
    expect(owner.readContext(resumed.handle).draftShortOutline).toMatchObject({ completedOutput: outline, promptHash: textHash(outlinePrompt), initialDraftTask: draftTask(composed) })
    await expect(owner.execute({ handle: resumed.handle, invocationNonce: 'replan', task: outlineTask })).rejects.toThrow('GENERATION_DRAFT_SHORT_OUTLINE_ALREADY_ATTEMPTED')
    await expect(owner.execute({ handle: resumed.handle, invocationNonce: 'replace', task: draftTask(composed + '改目标') })).rejects.toThrow('GENERATION_MATERIAL_PROMPT_MISMATCH')
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
  it.each(['length', 'error', 'empty'] as const)('never admits prose or resends a failed outline: %s', async failure => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      if (failure !== 'empty') options.onVisible({ kind: 'delta', text: '未完成的细纲' })
      return { finishReason: failure === 'empty' ? 'stop' : failure, usage: null }
    })
    const f = fixture(dispatch)
    const run = f.owner.begin({ ...f.begin, materialDecision: decision })
    await f.owner.execute({ handle: run.handle, invocationNonce: 'outline', task: outlineTask })
    const owner = f.reopen()
    const resumed = await owner.resume(run.handle)
    expect(owner.readContext(resumed.handle).draftShortOutline?.completedOutput).toBeNull()
    await expect(owner.execute({ handle: resumed.handle, invocationNonce: 'prose', task: draftTask(composed) })).rejects.toThrow('GENERATION_DRAFT_SHORT_OUTLINE_REQUIRED')
    await expect(owner.execute({ handle: resumed.handle, invocationNonce: 'again', task: outlineTask })).rejects.toThrow('GENERATION_DRAFT_SHORT_OUTLINE_ALREADY_ATTEMPTED')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('reuses the completed outline after a crash before prose without a second outline request', async () => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (request, options) => {
      options.onVisible({ kind: 'delta', text: (request as { task: GenerationTask }).task.purpose === DRAFT_SHORT_OUTLINE_PURPOSE ? outline : '正文。' })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    const run = f.owner.begin({ ...f.begin, materialDecision: decision })
    const planned = await f.owner.execute({ handle: run.handle, invocationNonce: 'outline', task: outlineTask })
    const owner = f.reopen(), resumed = await owner.resume(run.handle)
    expect(owner.readContext(resumed.handle).draftShortOutline).toEqual({ artifactIds: [planned.run.artifacts[0]!.artifactId], completedOutput: outline, promptHash: textHash(outlinePrompt) })
    const drafted = await owner.execute({ handle: resumed.handle, invocationNonce: 'prose', task: draftTask(composed) })
    expect(drafted.run.ledger?.physicalRequests).toBe(2)
    expect(drafted.run.handle.rootActionId).toBe(run.handle.rootActionId)
  })
})

it('applies the current project strategy through the main owner while keeping model override and source freeze', async () => {
  const reasoning: unknown[] = []
  const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (request, options) => {
    reasoning.push((request as { plan: { options: { reasoning?: unknown } } }).plan.options.reasoning)
    options.onVisible({ kind: 'delta', text: '合成正文。' })
    return { finishReason: 'stop', usage: null }
  })
  const f = fixture(dispatch)
  Object.assign(f.model, { provider: 'deepseek', modelName: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', reasoningOverride: 'auto' })
  const generate = async (nonce: string) => {
    const run = f.owner.begin({ ...f.begin, uiActionNonce: nonce })
    await f.owner.execute({ handle: run.handle, invocationNonce: nonce, task: { ...task, reasoningStage: 'drafting' } })
  }

  await generate('strategy-auto')
  expect(reasoning.at(-1)).toEqual({ adapter: 'deepseek-v4-thinking', thinking: 'enabled', reasoningEffort: 'low' })

  f.db.prepare("UPDATE project_core SET creative_strategy='fluent-drafting' WHERE id='main'").run()
  await generate('strategy-fluent')
  expect(reasoning.at(-1)).toEqual({ adapter: 'deepseek-v4-thinking', thinking: 'disabled' })

  f.model.reasoningOverride = 'high'
  await generate('strategy-override')
  expect(reasoning.at(-1)).toEqual({ adapter: 'deepseek-v4-thinking', thinking: 'enabled', reasoningEffort: 'high' })

  const oldRun = f.owner.begin({ ...f.begin, uiActionNonce: 'strategy-stale' })
  f.db.prepare("UPDATE project_core SET creative_strategy='auto' WHERE id='main'").run()
  await expect(f.owner.execute({ handle: oldRun.handle, invocationNonce: 'strategy-stale', task: { ...task, reasoningStage: 'drafting' } }))
    .rejects.toThrow('GENERATION_SOURCE_CHANGED')
  expect(dispatch).toHaveBeenCalledTimes(3)
})

describe('S07 durable task budget diagnostics', () => {
  it('projects only the durable safe provider failure code into the renderer receipt', async () => {
    const f = fixture(async () => { throw new Error('GENERATION_PROVIDER_FAILED') })
    const run = f.owner.begin(f.begin)
    const saved = await f.owner.execute({ handle: run.handle, invocationNonce: 'provider-failure-code', task })
    expect(saved.outcome.receipt).toMatchObject({ failureCode: 'GENERATION_PROVIDER_FAILED' })
    expect(JSON.stringify(saved.outcome)).not.toContain('synthetic-private-key')
  })
  it('keeps a network failure category after reopening without storing provider text', async () => {
    const f = fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: '已收到的正文' })
      throw new Error('NETWORK_ERROR')
    })
    const run = f.owner.begin(f.begin)
    const saved = await f.owner.execute({ handle: run.handle, invocationNonce: 'network-proof', task })
    expect(saved.run.budgetDiagnostics![0]).toMatchObject({ failureCode: 'NETWORK_ERROR', actualState: 'unknown', actual: null })
    expect(saved.run.artifacts[0]).toMatchObject({ text: '已收到的正文', compositionEligible: false })
    expect(f.reopen().read(run.handle).budgetDiagnostics).toEqual(saved.run.budgetDiagnostics)
  })
  it.each([true, false])('stores the decision before dispatch and recovers actual/unknown accounting (trusted=%s)', async trusted => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      const row = f.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts').get() as { attempt_json: string; usage_receipt_json: string }
      expect(JSON.parse(row.attempt_json).status).toBe('dispatch-marked')
      expect(JSON.parse(row.usage_receipt_json).budgetDecision).toMatchObject({ decision: 'ready', requestedQuantity: 400, policyVersion: 's07-task-budget-v1' })
      options.onVisible({ kind: 'delta', text: '完整保留的合成正文。' })
      return { finishReason: 'stop', usage: trusted ? { promptTokens: 100, completionTokens: 60, reasoningTokens: 20, totalTokens: 160,
        accounting: 'included-in-completion', totalIncludesReasoning: true, trusted: true } : null }
    })
    const f = fixture(dispatch, true)
    const run = f.owner.begin(f.begin)
    const input = { ...task, budgetDemand: { kind: 'draft-units' as const, writingLanguage: 'zh-CN' as const, requestedUnits: 400, segmentable: false } }
    const saved = await f.owner.execute({ handle: run.handle, invocationNonce: 'budget-proof', task: input })
    const diagnostic = saved.run.budgetDiagnostics![0]
    expect(diagnostic).toMatchObject({ plannerVersion: 's07-task-budget-v1', reservedTokens: 1048576, finishReason: 'stop',
      actualState: trusted ? 'settled' : 'unknown', actual: trusted ? { input: 100, completion: 60, reasoning: 20, total: 160 } : null })
    expect(saved.run.ledger?.tokenLiability).toBe(trusted ? 160 : 1048576)
    const restored = f.reopen().read(run.handle)
    expect(restored.budgetDiagnostics).toEqual(saved.run.budgetDiagnostics)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('rejects an indivisible oversized target before any physical reservation', async () => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(), f = fixture(dispatch, true)
    const run = f.owner.begin(f.begin)
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'too-large', task: { ...task,
      budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 5000, segmentable: false } } })).rejects.toThrow('TASK_BUDGET_CAPACITY_CONFLICT')
    expect(dispatch).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
    expect(f.owner.read(run.handle).ledger?.physicalRequests).toBe(0)
  })
})

describe('durable directory commit and remaining stage', () => {
  const directoryTask = { ...task, purpose: 'directory-batch', output: 'structured-data' as const }
  const authorInputs = [{ id: 'directory:pacing-guidance', text: '  前缓后急\r\n' }, { id: 'directory:author-config', text: '{"totalChapters":3}' }]
  function directoryFixture() {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: '[{"chapterNumber":1,"title":"启程"}]' })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    const selection = { ...f.begin, operation: 'directory', selectedBlueprintChapterNumbers: [1, 2, 3], authorInputs, output: 'structured-data' as const }
    const run = f.owner.begin(selection)
    const request = (operationId: string, startChapter: number, endChapter: number): BlueprintRangeCommitRequest => ({
      operationId, mode: 'replace-range', startChapter, endChapter,
      blueprints: Array.from({ length: endChapter - startChapter + 1 }, (_, index) => ({ chapterNumber: startChapter + index,
        title: '已生成章节', role: '推进', purpose: '寻找线索', keyEvents: '角色发现关键线索', characters: [], suspenseHook: '', userGuidance: '', notes: '', notesUpdatedAt: '' })),
    })
    const commit = (owner: typeof f.owner, handle: typeof run.handle, input: BlueprintRangeCommitRequest, requestedRange: { startChapter: number; endChapter: number }) => f.db.transaction(() => {
      const receipt = BlueprintRepository.commitRange(input, () => owner.assertSourcesCurrent(handle, requestedRange))
      return owner.recordDirectoryCommit(handle, requestedRange, receipt)
    }).immediate()
    return { ...f, fixture: f, selection, run, dispatch, request, commit }
  }
  it('opens the default directory intent with explicitly empty pacing guidance', () => {
    const f = fixture()
    const run = f.owner.begin({ ...f.begin, operation: 'directory', output: 'structured-data', selectedBlueprintChapterNumbers: [1],
      authorInputs: [{ id: 'directory:pacing-guidance', text: '' }, { id: 'directory:author-config', text: '{"totalChapters":1}' }] })
    expect(run.ledger?.physicalRequests).toBe(0)
  })
  it('restores exact remaining work and raw author inputs after reopen without a new budget', async () => {
    const f = directoryFixture()
    await f.owner.execute({ handle: f.run.handle, invocationNonce: 'first', task: directoryTask })
    f.commit(f.owner, f.run.handle, f.request('saved-prefix', 1, 2), { startChapter: 1, endChapter: 3 })
    const reopened = f.reopen()
    expect(reopened.listDirectoryProgress()).toMatchObject([{ operationId: 'saved-prefix', remainingRange: { startChapter: 3, endChapter: 3 }, authorInputs }])
    f.fixture.db.exec("UPDATE blueprints SET title='作者修订的已完成章' WHERE chapter_number=1")
    const selection = { ...f.selection, uiActionNonce: 'remaining', selectedBlueprintChapterNumbers: [3, 1, 2], continueDirectoryOperationId: 'saved-prefix' }
    expect(() => reopened.begin({ ...selection, selectedBlueprintChapterNumbers: [1, 2] })).toThrow('GENERATION_DIRECTORY_CONTINUATION_INVALID')
    expect(() => reopened.begin({ ...selection, authorInputs: [{ ...authorInputs[0], text: '另一份指导' }, authorInputs[1]] })).toThrow('GENERATION_DIRECTORY_AUTHOR_INPUT_CHANGED')
    const next = reopened.begin(selection)
    expect(next.handle).toMatchObject({ epoch: 'epoch-2', rootActionId: f.run.handle.rootActionId })
    expect(next.ledger?.physicalRequests).toBe(1)
    expect(reopened.begin(selection).handle).toEqual(next.handle)
    expect(() => reopened.begin({ ...selection, uiActionNonce: 'duplicate-stage' })).toThrow('GENERATION_DIRECTORY_CONTINUATION_EXISTS')
    expect(() => reopened.assertSourcesCurrent(next.handle, { startChapter: 1, endChapter: 3 })).toThrow('GENERATION_DIRECTORY_CONTINUATION_RANGE_CHANGED')
    await reopened.execute({ handle: next.handle, invocationNonce: 'remaining', task: directoryTask })
    const final = f.commit(reopened, next.handle, f.request('saved-rest', 3, 3), { startChapter: 3, endChapter: 3 })
    expect(final.remainingRange).toBeNull()
    expect(reopened.read(next.handle).ledger?.physicalRequests).toBe(2)
    expect(f.fixture.db.prepare('SELECT title FROM blueprints WHERE chapter_number=1').pluck().get()).toBe('作者修订的已完成章')
    expect(reopened.listDirectoryProgress()[0].continuationHandle).toEqual(next.handle)
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  })
  it('rolls back formal rows and their operation when durable progress cannot be recorded', async () => {
    const f = directoryFixture()
    await f.owner.execute({ handle: f.run.handle, invocationNonce: 'first', task: directoryTask })
    f.fixture.db.exec("CREATE TRIGGER reject_progress BEFORE UPDATE OF usage_receipt_json ON generation_attempts BEGIN SELECT RAISE(ABORT,'PROGRESS_DISK_FAILURE'); END")
    expect(() => f.commit(f.owner, f.run.handle, f.request('atomic-prefix', 1, 2), { startChapter: 1, endChapter: 3 })).toThrow('PROGRESS_DISK_FAILURE')
    expect(f.fixture.db.prepare('SELECT title FROM blueprints WHERE chapter_number=1').pluck().get()).toBe('第一章')
    expect(f.fixture.db.prepare('SELECT COUNT(*) FROM blueprint_commit_operations').pluck().get()).toBe(0)
    expect(f.owner.listDirectoryProgress()).toEqual([])
    f.fixture.db.exec('DROP TRIGGER reject_progress')
    const saved = f.commit(f.owner, f.run.handle, f.request('atomic-prefix', 1, 2), { startChapter: 1, endChapter: 3 })
    f.fixture.db.exec("UPDATE blueprints SET title='作者后写' WHERE chapter_number=1")
    expect(f.commit(f.owner, f.run.handle, f.request('atomic-prefix', 1, 2), { startChapter: 1, endChapter: 3 })).toEqual(saved)
    expect(f.fixture.db.prepare('SELECT title FROM blueprints WHERE chapter_number=1').pluck().get()).toBe('作者后写')
  })
  it('retains exhausted request accounting when a saved prefix opens a remaining stage', async () => {
    const f = directoryFixture()
    for (let index = 0; index < MAIN_GENERATION_POLICY.budget.maxPhysicalRequests; index++)
      await f.owner.execute({ handle: f.run.handle, invocationNonce: `request-${index}`, task: directoryTask })
    f.commit(f.owner, f.run.handle, f.request('budget-prefix', 1, 2), { startChapter: 1, endChapter: 3 })
    const reopened = f.reopen()
    const next = reopened.begin({ ...f.selection, uiActionNonce: 'remaining', selectedBlueprintChapterNumbers: [3], continueDirectoryOperationId: 'budget-prefix' })
    expect(next.ledger?.physicalRequests).toBe(MAIN_GENERATION_POLICY.budget.maxPhysicalRequests)
    await expect(reopened.execute({ handle: next.handle, invocationNonce: 'over-budget', task: directoryTask })).rejects.toThrow(/BUDGET/)
    expect(f.dispatch).toHaveBeenCalledTimes(MAIN_GENERATION_POLICY.budget.maxPhysicalRequests)
    expect(f.fixture.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
  })
  it('rejects invalid persisted progress instead of inferring a replacement range', async () => {
    const f = directoryFixture()
    await f.owner.execute({ handle: f.run.handle, invocationNonce: 'first', task: directoryTask })
    f.commit(f.owner, f.run.handle, f.request('corrupt-prefix', 1, 2), { startChapter: 1, endChapter: 3 })
    f.fixture.db.exec("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.directoryProgress.requestedRange.endChapter',3.5)")
    expect(() => f.owner.listDirectoryProgress()).toThrow('GENERATION_DIRECTORY_PROGRESS_INVALID')
  })
  it.each(['sourceHandle.epoch', 'continuationHandle.epoch'])('rejects progress with missing %s before exposing a typed handle', async field => {
    const f = directoryFixture()
    await f.owner.execute({ handle: f.run.handle, invocationNonce: 'first', task: directoryTask })
    f.commit(f.owner, f.run.handle, f.request('identity-prefix', 1, 2), { startChapter: 1, endChapter: 3 })
    f.owner.begin({ ...f.selection, uiActionNonce: 'remaining', continueDirectoryOperationId: 'identity-prefix' })
    f.fixture.db.prepare('UPDATE generation_attempts SET usage_receipt_json=json_remove(usage_receipt_json,?)').run(`$.directoryProgress.${field}`)
    expect(() => f.owner.listDirectoryProgress()).toThrow('GENERATION_DIRECTORY_PROGRESS_INVALID')
  })
})

it.each(['', ' ', null, 7])('rejects malformed parent root %j before creating a fresh budget', parent => {
  const f = fixture();
  expect(() => f.owner.begin({ ...f.begin, parentRootActionId: parent as string })).toThrow('GENERATION_BEGIN_INVALID');
  expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(0);
});

it('freezes a valid material decision into the run and rejects a malformed one before any budget', () => {
  // S10B 步骤 3：写稿入口把脱敏准入收据交给主进程，主进程校验后冻进 sourceManifest。
  const f = fixture()
  const decision: NonNullable<BeginGenerationRequest['materialDecision']> = {
    version: 1, verdict: 'admitted', promptHash: textHash(task.messages[0].content),
    capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 12 },
    coverage: { required: 1, included: 1, complete: true },
    included: [{ sourceId: 'author:required', revision: 1, contentHash: 'a'.repeat(64), category: 'author', required: true, units: 12 }],
    omitted: [],
  }
  const run = f.owner.begin({ ...f.begin, materialDecision: decision })
  const binding = JSON.parse(f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(run.handle.runId) as string) as {
    sourceManifest: Record<string, unknown>; fingerprint: { contextSnapshotHash: string }; contextSnapshotId: string
  }
  expect(binding.sourceManifest.materialDecision).toEqual(decision)
  expect(binding.sourceManifest.materialDecisionHash).toMatch(/^[a-f0-9]{64}$/)
  expect(binding.contextSnapshotId).toBe(`context:${binding.fingerprint.contextSnapshotHash}`)
  expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
  // 非法裁决在开出任何预算/运行之前就被拒绝：形状校验先于 DB 事务。
  expect(() => f.owner.begin({ ...f.begin, uiActionNonce: 'click:invalid',
    materialDecision: { ...decision, verdict: 'capacity-conflict' } as unknown as BeginGenerationRequest['materialDecision'] }))
    .toThrow('GENERATION_MATERIAL_DECISION_INVALID')
  expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
});

it('rejects prompt substitution before the first material-bound request', async () => {
  const f = fixture()
  const prompt = '只审查当前正文。'
  const decision: NonNullable<BeginGenerationRequest['materialDecision']> = {
    version: 1, verdict: 'admitted', promptHash: textHash(prompt),
    capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 12 },
    coverage: { required: 1, included: 1, complete: true },
    included: [{ sourceId: 'author:required', revision: 1, contentHash: 'a'.repeat(64), category: 'author', required: true, units: 12 }],
    omitted: [],
  }
  const run = f.owner.begin({ ...f.begin, materialDecision: decision })
  await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'wrong-prompt', task: {
    purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: '被替换的提示词' }],
  } })).rejects.toThrow('GENERATION_MATERIAL_PROMPT_MISMATCH')
  expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
});

describe('pre-draft finalized reconciliation binding', () => {
  const basePrompt = '【本章执行卡（作者原文重列）】\n- 必需事件: 核查遇阻\n\n【本章篇幅合同】\n目标 900 字。'
  const reconcilePrompt = '你是连载小说的连续性编辑。只做对账。'
  const output = JSON.stringify({ finalState: ['林澄已撤回核查安排。'], events: [{ event: '核查遇阻', conflict: true, realization: '许可被驳回。' }] })
  const block = renderDraftReconciliationBlock('zh-CN', parseDraftReconciliation(output)!)
  const reconciledPrompt = basePrompt.replace('\n\n【本章篇幅合同】', `\n\n${block}\n\n【本章篇幅合同】`)
  const decision = (reconciliation = true): NonNullable<BeginGenerationRequest['materialDecision']> => ({
    version: 1, verdict: 'admitted', promptHash: textHash(basePrompt),
    ...(reconciliation ? { reconciliationPromptHash: textHash(reconcilePrompt) } : {}),
    capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 12 },
    coverage: { required: 1, included: 1, complete: true },
    included: [{ sourceId: 'author:required', revision: 1, contentHash: 'a'.repeat(64), category: 'author', required: true, units: 12 }],
    omitted: [],
  })
  const reconcileTask = (content = reconcilePrompt) => ({ purpose: DRAFT_RECONCILE_PURPOSE, output: 'visible-text' as const, messages: [{ role: 'user' as const, content }] })
  const draftTask = (content: string) => ({ purpose: 'chapter-draft', output: 'visible-text' as const, messages: [{ role: 'user' as const, content }] })
  const setup = (reconcileOutput = output) => {
    const f = fixture(async (request, options) => {
      options.onVisible({ kind: 'delta', text: (request as { task: { purpose: string } }).task.purpose === DRAFT_RECONCILE_PURPOSE ? reconcileOutput : '合成正文。' })
      return { finishReason: 'stop', usage: null }
    })
    return { f, run: f.owner.begin({ ...f.begin, materialDecision: decision() }) }
  }

  it('admits one reconciliation first and a draft prompt that differs only by the recomputed block', async () => {
    const { f, run } = setup()
    const reconciled = await f.owner.execute({ handle: run.handle, invocationNonce: 'reconcile', task: reconcileTask() })
    expect(reconciled.outcome.content).toBe(output)
    // 对账产物只作依据：不能作为正文候选组合。
    expect(reconciled.run.artifacts[0]).toMatchObject({ text: output, compositionEligible: false })
    expect(() => f.owner.composeVisible(run.handle, [reconciled.outcome.receipt.visibleArtifact!.artifactId], textHash(output), DRAFT_VISIBLE_TEXT_VERSION))
      .toThrow('GENERATION_COMPOSITION_SOURCE_INVALID')
    expect(f.owner.readContext(run.handle).draftReconciliation).toEqual({
      artifactIds: [reconciled.outcome.receipt.visibleArtifact!.artifactId], completedOutput: output })
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'smuggle', task: draftTask(`${reconciledPrompt}\n\n夹带内容`) }))
      .rejects.toThrow('GENERATION_MATERIAL_PROMPT_MISMATCH')
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'reconcile-again', task: reconcileTask() }))
      .rejects.toThrow('GENERATION_MATERIAL_PROMPT_MISMATCH')
    const drafted = await f.owner.execute({ handle: run.handle, invocationNonce: 'draft', task: draftTask(reconciledPrompt) })
    expect(drafted.outcome.content).toBe('合成正文。')
    expect(f.owner.readContext(run.handle).attemptedPurposes).toEqual([DRAFT_RECONCILE_PURPOSE, 'chapter-draft'])
    expect(f.owner.readContext(run.handle).draftReconciliation?.completedOutput).toBe(output)
  })

  it('does not offer the reconciliation to recovery when the first draft was sent without its block', async () => {
    // 例如对账已在主进程完成，但渲染层 IPC 报错后按无对账发出了首稿。
    const { f, run } = setup()
    await f.owner.execute({ handle: run.handle, invocationNonce: 'reconcile', task: reconcileTask() })
    expect(f.owner.readContext(run.handle).draftReconciliation?.completedOutput).toBe(output)
    await f.owner.execute({ handle: run.handle, invocationNonce: 'draft', task: draftTask(basePrompt) })
    expect(f.owner.readContext(run.handle).draftReconciliation).toMatchObject({ completedOutput: null })
  })

  it('still admits the unreconciled draft prompt when the reconciliation output is unusable', async () => {
    const { f, run } = setup('没有 JSON')
    await f.owner.execute({ handle: run.handle, invocationNonce: 'reconcile', task: reconcileTask() })
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'draft-with-block', task: draftTask(reconciledPrompt) }))
      .rejects.toThrow('GENERATION_MATERIAL_PROMPT_MISMATCH')
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'draft', task: draftTask(basePrompt) })).resolves.toBeTruthy()
  })

  it('offers no recorded reconciliation when the reconcile attempt failed or ended unknown', async () => {
    const f = fixture(async (request, options) => {
      if ((request as { task: { purpose: string } }).task.purpose === DRAFT_RECONCILE_PURPOSE) {
        options.onVisible({ kind: 'delta', text: output })
        throw new Error('NETWORK_ERROR')
      }
      options.onVisible({ kind: 'delta', text: '合成正文。' })
      return { finishReason: 'stop', usage: null }
    })
    const run = f.owner.begin({ ...f.begin, materialDecision: decision() })
    const reconciled = await f.owner.execute({ handle: run.handle, invocationNonce: 'reconcile', task: reconcileTask() })
    expect(reconciled.outcome.receipt).toMatchObject({ failureCode: 'NETWORK_ERROR' })
    expect(reconciled.run.budgetDiagnostics![0]).toMatchObject({ actualState: 'unknown' })
    expect(f.owner.readContext(run.handle).draftReconciliation?.completedOutput).toBeNull()
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'draft-with-block', task: draftTask(reconciledPrompt) }))
      .rejects.toThrow('GENERATION_MATERIAL_PROMPT_MISMATCH')
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'draft', task: draftTask(basePrompt) })).resolves.toBeTruthy()
  })

  it('rejects an unbound or substituted reconciliation before dispatch', async () => {
    const { f, run } = setup()
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'wrong', task: reconcileTask('其他内容') }))
      .rejects.toThrow('GENERATION_MATERIAL_PROMPT_MISMATCH')
    const unbound = f.owner.begin({ ...f.begin, uiActionNonce: 'click:unbound', materialDecision: decision(false) })
    await expect(f.owner.execute({ handle: unbound.handle, invocationNonce: 'unbound', task: reconcileTask() }))
      .rejects.toThrow('GENERATION_MATERIAL_PROMPT_MISMATCH')
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
  })
})

it('freezes changed sources in a distinct child run without resetting the author action budget', async () => {
  const fetch = syntheticStream(), f = fixture();
  const first = f.owner.begin(f.begin);
  await f.owner.execute({ handle: first.handle, invocationNonce: 'first-stage', task });
  f.db.exec("UPDATE project_core SET premise='已完成并采用的故事前提'");
  const second = f.owner.begin({ ...f.begin, operation: 'worldbuilding', uiActionNonce: 'click:worldbuilding', parentRootActionId: first.handle.rootActionId });
  expect(second.handle.rootActionId).toBe(first.handle.rootActionId);
  expect(second.handle.runId).not.toBe(first.handle.runId);
  expect(second.ledger?.physicalRequests).toBe(1);
  const result = await f.owner.execute({ handle: second.handle, invocationNonce: 'second-stage', task });
  expect(result.run.ledger?.physicalRequests).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(2);
  await expect(f.owner.execute({ handle: first.handle, invocationNonce: 'old-stage', task })).rejects.toThrow('GENERATION_SOURCE_CHANGED');
});
describe('explicit visible continuation composition', () => {
  it.each(['content_filter', 'unknown', 'error'])('keeps %s raw text readable but refuses an automatic continuation seed', async finishReason => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: '不能自动续写的原始前缀' }); return { finishReason, usage: null } })
    const run = f.owner.begin(f.begin)
    const result = await f.owner.execute({ handle: run.handle, invocationNonce: 'untrusted', task })
    expect(result.run.artifacts[0].text).toBe('不能自动续写的原始前缀')
    expect(result.run.artifacts[0].compositionEligible).toBe(false)
    expect(() => f.owner.composeVisible(run.handle, [result.outcome.receipt.visibleArtifact!.artifactId], textHash(result.outcome.content))).toThrow('GENERATION_COMPOSITION_SOURCE_UNTRUSTED')
    expect(f.owner.readVisibleComposition(run.handle)).toBeNull()
  })
  function sequence(parts: string[]) {
    let index = 0
    return fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: parts[index++] })
      return { finishReason: 'length', usage: null }
    })
  }
  it('records only explicit ordered artifacts and preserves raw bytes across reopen', async () => {
    const overlap = '这段已经完成的正文需要保留原始字节'.repeat(4)
    const f = sequence([`  序章${overlap}\n`, `${overlap}\n新的故事继续展开。`])
    const run = f.owner.begin({ ...f.begin, authorInputs: [{ id: 'step-guidance', text: '  保留中文原要求\n' }] })
    const first = await f.owner.execute({ handle: run.handle, invocationNonce: 'first', task })
    const firstId = first.outcome.receipt.visibleArtifact!.artifactId
    expect(first.run.artifacts[0]).toMatchObject({ status: 'failed', compositionEligible: true })
    expect(f.owner.readVisibleComposition(run.handle)).toBeNull()
    const single = f.owner.composeVisible(run.handle, [firstId], textHash(first.outcome.content.trim()))
    expect(single.text).toBe(first.outcome.content.trim())
    expect(f.owner.read(run.handle).artifacts[0].text).toBe(`  序章${overlap}\n`)
    const second = await f.owner.execute({ handle: run.handle, invocationNonce: 'next', task })
    const secondId = second.outcome.receipt.visibleArtifact!.artifactId
    expect(f.owner.readVisibleComposition(run.handle)?.artifactIds).toEqual([firstId])
    const expected = composeVisibleContinuation(single.text, second.outcome.content)
    const result = f.owner.composeVisible(run.handle, [firstId, secondId], textHash(expected))
    expect(result.text).toBe(`序章${overlap}\n\n新的故事继续展开。`)
    expect(result.sources.map(source => source.textHash)).toEqual([textHash(first.outcome.content), textHash(second.outcome.content)])
    const reopened = f.reopen()
    expect(reopened.readVisibleComposition(run.handle)).toMatchObject({ text: expected, artifactIds: [firstId, secondId], authorInputs: [{ id: 'step-guidance', text: '  保留中文原要求\n' }] })
    const resumed = await reopened.resume(run.handle)
    expect(reopened.readVisibleComposition(resumed.handle)?.text).toBe(expected)
    expect(resumed.ledger?.physicalRequests).toBe(2)
  })
  it('rejects wrong hash, foreign/reordered artifacts and regression while keeping source-drift candidates readable', async () => {
    const f = sequence(['第一段正文。', '第二段正文。', '别的动作候选。'])
    const run = f.owner.begin(f.begin)
    const first = await f.owner.execute({ handle: run.handle, invocationNonce: 'first', task })
    const a = first.outcome.receipt.visibleArtifact!.artifactId
    expect(() => f.owner.composeVisible(run.handle, [a], textHash('伪造内容'))).toThrow('GENERATION_COMPOSITION_HASH_MISMATCH')
    f.owner.composeVisible(run.handle, [a], textHash(first.outcome.content))
    const second = await f.owner.execute({ handle: run.handle, invocationNonce: 'second', task })
    const b = second.outcome.receipt.visibleArtifact!.artifactId
    expect(() => f.owner.composeVisible(run.handle, [b, a], textHash(''))).toThrow('GENERATION_COMPOSITION_SOURCE_INVALID')
    expect(() => f.owner.composeVisible(run.handle, [b], textHash(second.outcome.content))).toThrow('GENERATION_COMPOSITION_REGRESSION')
    const another = f.owner.begin({ ...f.begin, uiActionNonce: 'another' })
    const other = await f.owner.execute({ handle: another.handle, invocationNonce: 'third', task })
    expect(() => f.owner.composeVisible(run.handle, [a, other.outcome.receipt.visibleArtifact!.artifactId], textHash(''))).toThrow('GENERATION_COMPOSITION_SOURCE_INVALID')
    f.db.exec("UPDATE project_core SET premise='作者刚修改的正式内容'")
    const candidate = composeVisibleContinuation(first.outcome.content, second.outcome.content)
    expect(f.owner.composeVisible(run.handle, [a, b], textHash(candidate)).text).toBe(candidate)
    expect(f.owner.readVisibleComposition(run.handle)).toMatchObject({ text: candidate, textHash: textHash(candidate), artifactIds: [a, b] })
    expect(() => f.owner.assertSourcesCurrent(run.handle)).toThrow('GENERATION_SOURCE_CHANGED')
    f.owner.cancel(run.handle)
    expect(() => f.owner.composeVisible(run.handle, [a, b], textHash(candidate))).toThrow('GENERATION_ACTION_CANCELLED')
  })
  it('refuses edited or discarded composition sources without hiding remaining raw candidates', async () => {
    const f = sequence(['合法候选正文。']), run = f.owner.begin(f.begin)
    const result = await f.owner.execute({ handle: run.handle, invocationNonce: 'first', task })
    const id = result.outcome.receipt.visibleArtifact!.artifactId
    f.owner.composeVisible(run.handle, [id], textHash(result.outcome.content))
    f.owner.discardCandidate(run.handle, id)
    expect(() => f.owner.readVisibleComposition(run.handle)).toThrow('GENERATION_COMPOSITION_SOURCE_INVALID')
  })
})

it('freezes a purpose-specific output exception and rejects all undeclared changes', async () => {
  const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: '合成结构候选' }); return { finishReason: 'stop', usage: null } })
  const selection: BeginGenerationRequest = { ...f.begin, output: 'structured-data', outputOverrides: [{ purpose: 'generate-global-guidance-replacement', output: 'visible-text' }] }
  const run = f.owner.begin(selection)
  await f.owner.execute({ handle: run.handle, invocationNonce: 'structured', task: { ...task, output: 'structured-data' } })
  await f.owner.execute({ handle: run.handle, invocationNonce: 'rules', task: { ...task, purpose: 'generate-global-guidance-replacement' } })
  await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'undeclared', task })).rejects.toThrow('GENERATION_OUTPUT_CONTRACT_CHANGED')
  await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'wrong-rule-output', task: { ...task, purpose: 'generate-global-guidance-replacement', output: 'structured-data' } })).rejects.toThrow('GENERATION_OUTPUT_CONTRACT_CHANGED')
  expect(f.owner.read(run.handle).ledger?.physicalRequests).toBe(2)
  expect(() => f.owner.begin({ ...selection, outputOverrides: [{ purpose: 'invalid purpose', output: 'visible-text' }] })).toThrow('GENERATION_OUTPUT_CONTRACT_INVALID')
})

describe('main generation owner with actual SQLite and provider adapter', () => {
  it.each(['chapter-blueprint-directory', 'chapter-blueprint-directory:compact-single:chapter-1'])(
    'sends the planned native wire for %s and recovers its full LENGTH candidate without committing or redispatching', async purpose => {
      const fetch = syntheticStream(), f = fixture()
      const authorInputs = [
        { id: 'directory:pacing-guidance', text: '  前缓后急\r\n' },
        { id: 'directory:author-config', text: '{"totalChapters":1,"wordsPerChapter":4000}' },
        { id: 'directory:requested-range', text: '{"mode":"full","startChapter":1,"endChapter":1}' },
      ]
      const view = f.owner.begin({ operation: 'chapter-blueprint-directory', uiActionNonce: 'directory', modelId: f.model.id,
        selectedBlueprintChapterNumbers: [1], selectedDraftIds: [], selectedFinalizedDraftIds: [],
        promptKeys: ['chapter_blueprint_chunk'], skillStages: ['planning'], authorInputs, output: 'structured-data' })
      const prompt = '为第1章生成完整蓝图，保留作者事实；必须且只能返回 chapterNumber=1 的一项。'
      const directoryTask: GenerationTask = { purpose, output: 'structured-data', messages: [
        { role: 'system', content: '你是一位经验丰富的章节架构师。' }, { role: 'user', content: prompt },
      ], ...(purpose.includes(':compact-single:') ? { promptBudget: { limitUtf8Bytes: 32 * 1024,
        sections: [{ sectionName: 'target-chapter', messageIndex: 1, finalText: 'chapterNumber=1' }] } } : {}) }
      const repository = new GenerationRunRepository(() => f.db), frozen = repository.get(view.handle.runId)
      const budget = repository.budget(view.handle.rootActionId)
      const plan = buildMainGenerationPlan(f.model,
        frozen.binding.sourceManifest.modelReceipt as Parameters<typeof buildMainGenerationPlan>[1], directoryTask, budget)
      expect(plan.requestedOutputTokens).toBe(2048)
      expect(plan.reservedTokens).toBeLessThanOrEqual(budget.policy.maxTokenLiability - view.ledger!.tokenLiability)
      const candidate = ' \r\n{"blueprints":[{"chapterNumber":1,"title":"完整原始候选","keyEvents":"作者事实保留"}]}\n  '
      const formalBefore = BlueprintRepository.getAll(), databasePath = f.db.name
      fetch.mockImplementationOnce(async (_url, options) => {
        const body = JSON.parse(options.body as string)
        expect(body.messages).toEqual(directoryTask.messages)
        expect(body.max_completion_tokens).toBe(plan.requestedOutputTokens)
        expect(body.max_tokens).toBeUndefined()
        expect(repository.budget(view.handle.rootActionId).attempts[0]).toMatchObject({ status: 'dispatch-marked',
          requestedOutputTokens: body.max_completion_tokens, reservedTokens: plan.reservedTokens })
        return { ok: true, body: new ReadableStream({ start(controller) {
          const chunk = { choices: [{ delta: { content: candidate }, finish_reason: 'length' }] }
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":12,"total_tokens":62}}\n\ndata: [DONE]\n\n`))
          controller.close()
        } }) }
      })
      const result = await f.owner.execute({ handle: view.handle, invocationNonce: 'directory-length', task: directoryTask })
      expect(result.outcome).toMatchObject({ status: 'incomplete', finishReason: 'length', content: candidate, receipt: { purpose } })
      const reference = result.outcome.receipt.visibleArtifact!, durable = repository.receipt(reference.attemptId)
      expect(durable.run.runId).toBe(view.handle.runId)
      expect(durable.artifact).toMatchObject({ artifactId: reference.artifactId, attemptId: reference.attemptId,
        rootActionId: view.handle.rootActionId, text: candidate, textHash: textHash(candidate), fingerprint: frozen.binding.fingerprint })
      expect(result.run.artifacts[0]).toMatchObject({ artifactId: reference.artifactId, status: 'failed', text: candidate,
        revision: reference.revision, durableRevision: reference.revision })
      expect(result.run.budgetDiagnostics![0]).toMatchObject({ requestedOutputTokens: plan.requestedOutputTokens,
        reservedTokens: plan.reservedTokens, actualState: 'settled', finishReason: 'length', actual: { input: 50, completion: 12, total: 62 } })
      expect(result.run.ledger).toMatchObject({ physicalRequests: 1, tokenLiability: 62, policy: budget.policy })
      expect(f.owner.readVisibleComposition(view.handle)).toBeNull()
      expect(BlueprintRepository.getAll()).toEqual(formalBefore)
      expect(f.db.prepare('SELECT COUNT(*) FROM blueprint_commit_operations').pluck().get()).toBe(0)
      const reopened = f.reopen(), restored = reopened.read(view.handle)
      expect(f.db.name).toBe(databasePath)
      expect(restored.artifacts).toEqual(result.run.artifacts)
      expect(restored.budgetDiagnostics).toEqual(result.run.budgetDiagnostics)
      expect(reopened.readContext(view.handle)).toMatchObject({ attemptedPurposes: [purpose], authorInputs })
      const reopenedRepository = new GenerationRunRepository(() => f.db)
      expect(reopenedRepository.receipt(reference.attemptId).artifact).toEqual(durable.artifact)
      expect(reopenedRepository.get(view.handle.runId).binding.sourceRefs).toEqual(frozen.binding.sourceRefs)
      const resumed = await reopened.resume(view.handle)
      expect(resumed.handle).toMatchObject({ epoch: 'epoch-2', rootActionId: view.handle.rootActionId })
      expect(resumed.candidates).toEqual(result.run.candidates)
      expect(resumed.ledger).toMatchObject({ physicalRequests: 1, tokenLiability: result.run.ledger!.tokenLiability,
        policy: result.run.ledger!.policy })
      expect(reopened.readVisibleComposition(resumed.handle)).toBeNull()
      expect(reopened.listDirectoryProgress()).toEqual([])
      expect(BlueprintRepository.getAll()).toEqual(formalBefore)
      expect(f.db.prepare('SELECT COUNT(*) FROM blueprint_commit_operations').pluck().get()).toBe(0)
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )
  it('marks before sending, preserves exact visible text and replays one durable nonce without network', async () => {
    const reasoning: string[] = [], fetch = syntheticStream(), f = fixture(undefined, false, event => reasoning.push(event.text)), view = f.owner.begin(f.begin)
    fetch.mockImplementationOnce(async (...args) => {
      expect(JSON.parse(f.db.prepare('SELECT attempt_json FROM generation_attempts').pluck().get() as string).status).toBe('dispatch-marked')
      const body = JSON.parse((args[1] as RequestInit).body as string)
      expect(body.max_completion_tokens).toBe(2048)
      expect(body.max_tokens).toBeUndefined()
      return { ok: true, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"隐藏","content":" 正文\\n"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); controller.close()
      } }) }
    })
    const result = await f.owner.execute({ handle: view.handle, invocationNonce: 'call', task })
    expect(result.outcome).toMatchObject({ status: 'completed', content: ' 正文\n' })
    expect(result.run.artifacts[0]).toMatchObject({ revision: 1, durableRevision: 1, status: 'completed' })
    expect(JSON.stringify(result)).not.toContain('synthetic-private-key')
    expect(JSON.stringify(result)).not.toContain('隐藏')
    expect(reasoning).toEqual(['隐藏'])
    expect(JSON.stringify(f.db.prepare('SELECT artifact_json FROM generation_artifacts').all())).not.toContain('隐藏')
    await f.owner.execute({ handle: view.handle, invocationNonce: 'call', task })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(f.owner.list()[0].ledger?.physicalRequests).toBe(1)
  })
  it('retains safe stream diagnostics through the owner, SQLite reopen and snapshot IPC without retry', async () => {
    const snapshots: import('../../../src/services/generation/generation-runtime').MainGenerationSnapshot[] = []
    const f = fixture(undefined, false, undefined, snapshot => snapshots.push(snapshot)), view = f.owner.begin(f.begin)
    let read = 0
    const fetch = vi.fn(async () => ({ ok: true, status: 200, body: { getReader: () => ({ read: async () => {
      if (read++ === 0) return { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"private thought"}}]}\n\n') }
      throw new TypeError('secret endpoint', { cause: Object.assign(new Error('secret raw cause'), { code: 'UND_ERR_BODY_TIMEOUT' }) })
    } }) } }))
    vi.stubGlobal('fetch', fetch)
    const result = await f.owner.execute({ handle: view.handle, invocationNonce: 'timeout', task })
    expect(result.outcome).toMatchObject({ status: 'incomplete', content: '', receipt: { failureCode: 'NETWORK_ERROR',
      diagnostics: { phase: 'stream', endReason: 'failed', causeCode: 'UND_ERR_BODY_TIMEOUT', httpStatus: 200, reasoningEvents: 1, visibleEvents: 0 } } })
    expect(snapshots.some(snapshot => snapshot.text === '' && snapshot.diagnostics?.httpStatus === 200)).toBe(true)
    const stored = new GenerationRunRepository(() => f.db).receipt(result.outcome.receipt.visibleArtifact!.attemptId)
    expect(stored.diagnostics).toEqual(result.outcome.receipt.diagnostics)
    expect(stored.attempt.status).toBe('unknown')
    expect(stored.attempt.actualTokens).toBeUndefined()
    expect(JSON.stringify(stored)).not.toMatch(/private thought|secret endpoint|secret raw cause/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('ends an actively cancelled reasoning stream and releases its active clock without releasing unknown liability', async () => {
    const f = fixture(), view = f.owner.begin(f.begin)
    let started!: () => void
    const reading = new Promise<void>(resolve => { started = resolve })
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, request: RequestInit) => ({ ok: true, status: 200,
      body: { getReader: () => ({ read: async () => {
        if (reads++ === 0) return { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n') }
        started()
        return new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }))
      } }) } })))
    const pending = f.owner.execute({ handle: view.handle, invocationNonce: 'cancel-thinking', task })
    await reading
    f.owner.cancel(view.handle)
    const result = await pending
    expect(result.outcome).toMatchObject({ status: 'incomplete', content: '', receipt: { diagnostics: { endReason: 'cancelled', reasoningEvents: 1 } } })
    expect(result.run.ledger).toMatchObject({ physicalRequests: 1, tokenLiability: expect.any(Number) })
    expect(result.run.ledger!.tokenLiability).toBeGreaterThan(0)
    expect(f.db.prepare('SELECT active_since_ms FROM generation_roots').pluck().get()).toBeNull()
    expect(f.owner.read(view.handle).status).toBe('cancelled')
  })
  it('rejects changed author sources and renderer physical controls before reserving or sending', async () => {
    const dispatch = vi.fn(), f = fixture(dispatch), view = f.owner.begin(f.begin)
    f.db.exec("UPDATE project_core SET global_guidance='作者已修改'")
    await expect(f.owner.execute({ handle: view.handle, invocationNonce: 'call', task })).rejects.toThrow('GENERATION_SOURCE_CHANGED')
    await expect(f.owner.execute({ handle: view.handle, invocationNonce: 'call', task: { ...task, maxTokens: 999 } as never })).rejects.toThrow('GENERATION_SEMANTIC_TASK_INVALID')
    expect(dispatch).not.toHaveBeenCalled()
    expect(f.owner.read(view.handle).ledger?.physicalRequests).toBe(0)
  })
  it('joins an in-flight nonce even when conservative reservations have exhausted the root', async () => {
    const release: (() => void)[] = [], dispatch = vi.fn(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: '候选' })
      await new Promise<void>(resolve => release.push(resolve))
      return { usage: null, finishReason: 'stop' }
    })
    const f = fixture(dispatch, true), view = f.owner.begin(f.begin)
    const one = f.owner.execute({ handle: view.handle, invocationNonce: 'one', task })
    const two = f.owner.execute({ handle: view.handle, invocationNonce: 'two', task })
    const repeat = f.owner.execute({ handle: view.handle, invocationNonce: 'one', task })
    expect(f.owner.read(view.handle).ledger?.tokenLiability).toBe(2_097_152)
    release.forEach(resolve => resolve())
    const [a, , repeated] = await Promise.all([one, two, repeat])
    expect(repeated.run.artifacts[0].attemptId).toBe(a.run.artifacts[0].attemptId)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
  it('returns copyable unsaved bytes separately and refuses close until explicit discard', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: '未保存原文\r\n' }); return { usage: null, finishReason: 'stop' } })
    const view = f.owner.begin(f.begin)
    f.db.exec("CREATE TRIGGER reject_snapshot BEFORE UPDATE OF artifact_json ON generation_artifacts BEGIN SELECT RAISE(FAIL,'synthetic disk failure'); END")
    const result = await f.owner.execute({ handle: view.handle, invocationNonce: 'call', task })
    expect(result.outcome.status).toBe('incomplete')
    expect(result.run.artifacts[0].text).toBe('')
    expect(result.run.unsavedTails?.[0].text).toBe('未保存原文\r\n')
    expect(f.owner.read(view.handle).unsavedTails?.[0].text).toBe('未保存原文\r\n')
    expect(() => f.owner.suspendForProjectClose()).toThrow('GENERATION_UNSAVED_TAIL_PRESENT')
    f.owner.discardCandidate(view.handle, result.run.artifacts[0].artifactId)
    expect(() => f.owner.suspendForProjectClose()).not.toThrow()
  })
  it('reopens a real database and authorizes a new epoch without rewriting old candidate identity', async () => {
    const dispatch = vi.fn(async (_request, options) => { options.onVisible({ kind: 'delta', text: '候选' }); return { usage: null, finishReason: 'stop' } })
    const f = fixture(dispatch), view = f.owner.begin(f.begin)
    await f.owner.execute({ handle: view.handle, invocationNonce: 'call', task })
    const reopened = f.reopen(), old = reopened.read(view.handle)
    expect(old.nonReplayable).toBe(true)
    await expect(reopened.execute({ handle: view.handle, invocationNonce: 'again', task })).rejects.toThrow('GENERATION_EPOCH_STALE')
    const resumed = await reopened.resume(view.handle)
    expect(resumed.handle.epoch).toBe('epoch-2')
    expect(resumed.artifacts).toHaveLength(0)
    expect(resumed.candidates?.[0].epoch).toBe('epoch-1')
    await reopened.execute({ handle: resumed.handle, invocationNonce: 'new-call', task })
    expect(reopened.read(resumed.handle).artifacts).toHaveLength(1)
    expect(reopened.read(resumed.handle).candidates).toHaveLength(2)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
})

describe('durable character proposals from actual generation artifacts', () => {
  async function proposed() {
    const output = JSON.stringify({ results: ['1:1', '2:1'].map(sourceId => ({ sourceId, characterCards: [{ name: '林岚', role: 'supporting', background: '模型背景', appearance: '模型外貌', notes: `来源${sourceId}` }] })) })
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: output }); return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    const run = f.owner.begin({ ...f.begin, operation: 'planning-material-character-extraction', output: 'structured-data',
      promptKeys: ['planning_material_character_extraction'], authorInputs: [0, 1].map(index => ({ id: `planning-material:${index}`, text: JSON.stringify({ fileName: `资料${index}.txt`, text: '作者资料原文' }) })) })
    const execution = await f.owner.execute({ handle: run.handle, invocationNonce: 'extract', task: { ...task, purpose: 'planning-material-character-extraction', output: 'structured-data' } })
    const artifact = execution.run.artifacts[0]!
    const source = { kind: 'generation' as const, inputKind: 'planning-material' as const, handle: run.handle,
      artifacts: [{ artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash }] }
    return { ...f, fixture: f, source, dispatch }
  }
  it('stages equal names separately and writes IDs only after an explicit decision', async () => {
    const f = await proposed(), batch = f.owner.characterProposals.stage(f.source)
    expect(batch.items).toHaveLength(2)
    expect(new Set(batch.items.map(item => item.selectionKey)).size).toBe(2)
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
    const request = { proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision, operationId: 'adopt-cards',
      selections: batch.items.map(item => ({ selectionKey: item.selectionKey, action: 'create' as const })) }
    const approved = f.owner.characterProposals.approve(request)
    expect(approved.created).toHaveLength(2)
    expect(new Set(approved.created.map(item => item.characterId)).size).toBe(2)
    expect(f.owner.characterProposals.approve(request)).toEqual(approved)
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(2)
    expect(f.owner.characterProposals.identitySnapshot().characters.every(item => item.provenance.kind === 'generated')).toBe(true)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('edits a planning-material candidate at approval with author provenance and exact replay', async () => {
    const f = await proposed(), batch = f.owner.characterProposals.stage(f.source)
    const originalItems = structuredClone(batch.items)
    const request = { proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision, operationId: 'edited-cards',
      selections: batch.items.map((item, index) => ({ selectionKey: item.selectionKey, action: index === 0 ? 'create' as const : 'keep-unresolved' as const })),
      edits: [{ selectionKey: batch.items[0]!.selectionKey, fields: { name: '作者改名', background: '作者补充背景' } }] }
    const approved = f.owner.characterProposals.approve(request)
    expect(approved.created).toHaveLength(1)
    const saved = f.db.prepare('SELECT name,background,notes,static_provenance AS provenance FROM characters').get() as {
      name: string; background: string; notes: string; provenance: string
    }
    expect(saved).toMatchObject({ name: '作者改名', background: '作者补充背景', notes: '来源1:1' })
    const provenance = JSON.parse(saved.provenance)
    expect(provenance.kind).toBe('generated')
    expect(provenance.fields.name.kind).toBe('author')
    expect(provenance.fields.background.kind).toBe('author')
    expect(provenance.fields.notes).toBeUndefined()
    expect(f.owner.characterProposals.read(batch.proposalBatchId).items).toEqual(originalItems)
    expect(f.owner.characterProposals.approve(request)).toEqual(approved)
    expect(() => f.owner.characterProposals.approve({ ...request, edits: [{ selectionKey: batch.items[0]!.selectionKey,
      fields: { name: '同 nonce 的不同改名' } }] })).toThrow('CHARACTER_APPROVAL_NONCE_CONFLICT')
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(1)
  })
  it('maps a partially edited candidate without overwriting existing author facts', async () => {
    const f = await proposed()
    const seeded = commitCharacterIdentities(f.db, { approval: { operationId: 'seed-author', expectedRevision: 0,
      action: 'author-edit', source: { kind: 'author', source: { projectId: 'project', epoch: 'epoch-1', sourceId: 'author-roster',
        revision: 0, contentHash: textHash('作者原始角色') } } },
      changes: [], creations: [{ selectionKey: 'seed', fields: { name: '林岚', role: 'supporting', background: '作者背景', notes: '作者笔记' } }],
      retireIds: [], relationships: [], resolutions: [] }, () => true)
    const existingId = seeded.created[0]!.characterId
    const batch = f.owner.characterProposals.stage(f.source)
    const request = { proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision, operationId: 'map-edited',
      selections: batch.items.map((item, index) => index === 0
        ? { selectionKey: item.selectionKey, action: 'map' as const, characterId: existingId }
        : { selectionKey: item.selectionKey, action: 'keep-unresolved' as const }),
      edits: [{ selectionKey: batch.items[0]!.selectionKey, fields: { age: '32' } }] }
    const approved = f.owner.characterProposals.approve(request)
    const row = f.db.prepare('SELECT name,age,background,appearance,notes,static_provenance AS provenance FROM characters WHERE character_id=?')
      .get(existingId) as Record<string, string>
    expect(row).toMatchObject({ name: '林岚', age: '32', background: '作者背景', appearance: '模型外貌', notes: '作者笔记' })
    const provenance = JSON.parse(row.provenance)
    expect(provenance.kind).toBe('author')
    expect(provenance.fields.age.kind).toBe('author')
    expect(provenance.fields.appearance.kind).toBe('generated')
    expect(provenance.fields.background).toBeUndefined()
    expect(provenance.fields.notes).toBeUndefined()
    expect(f.owner.characterProposals.approve(request)).toEqual(approved)
  })
  it('rejects edited proposals after cancellation, source drift, or invalid target without touching characters', async () => {
    const f = await proposed(), batch = f.owner.characterProposals.stage(f.source)
    const base = { proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision, operationId: 'rejected-edit',
      selections: batch.items.map(item => ({ selectionKey: item.selectionKey, action: 'create' as const })),
      edits: [{ selectionKey: batch.items[0]!.selectionKey, fields: { name: '作者改名' } }] }
    expect(() => f.owner.characterProposals.approve({ ...base, edits: [{ selectionKey: 'foreign', fields: { name: '伪造' } }] }))
      .toThrow('CHARACTER_PROPOSAL_EDIT_INVALID')
    expect(() => f.owner.characterProposals.approve({ ...base, edits: [base.edits[0]!, base.edits[0]!] }))
      .toThrow('CHARACTER_PROPOSAL_EDIT_INVALID')
    expect(() => f.owner.characterProposals.approve({ ...base, selections: base.selections.map((item, index) => ({
      ...item, action: index === 0 ? 'keep-unresolved' as const : 'create' as const,
    })) })).toThrow('CHARACTER_PROPOSAL_EDIT_INVALID')
    expect(() => f.owner.characterProposals.approve({ ...base, expectedRevision: batch.revision + 1 }))
      .toThrow('CHARACTER_ID_REVISION_CONFLICT')
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
    f.db.exec("UPDATE project_core SET global_guidance='作者的新约束'")
    expect(() => f.owner.characterProposals.approve(base)).toThrow('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
    f.owner.characterProposals.cancel({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision })
    expect(() => f.owner.characterProposals.approve(base)).toThrow('CHARACTER_PROPOSAL_CANCELLED')
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
  })
  it('reopens pending proposals without generating again and adopts the exact historical source', async () => {
    const f = await proposed(), batch = f.owner.characterProposals.stage(f.source), reopened = f.reopen()
    expect(reopened.characterProposals.read(batch.proposalBatchId)).toEqual(batch)
    expect(reopened.characterProposals.approve({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision,
      operationId: 'adopt-reopened', selections: batch.items.map(item => ({ selectionKey: item.selectionKey, action: 'create' })) }).created).toHaveLength(2)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('preserves cancelled proposals and refuses adoption after source drift or artifact tampering', async () => {
    const f = await proposed(), batch = f.owner.characterProposals.stage(f.source)
    expect(() => f.owner.characterProposals.stage({ ...f.source, artifacts: [{ ...f.source.artifacts[0]!, textHash: '0'.repeat(64) }] })).toThrow('CHARACTER_PROPOSAL_ARTIFACT_INVALID')
    f.db.exec("UPDATE project_core SET global_guidance='作者的新约束'")
    expect(() => f.owner.characterProposals.approve({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision,
      operationId: 'stale', selections: batch.items.map(item => ({ selectionKey: item.selectionKey, action: 'create' })) })).toThrow('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    expect(f.owner.characterProposals.cancel({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision }).status).toBe('cancelled')
    expect(f.owner.characterProposals.read(batch.proposalBatchId).items).toHaveLength(2)
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
  }, 15_000) // Full on-disk migration and proposal writes exceeded 7s on the macOS x64 runner.
})

describe('main draft persistence and batch lineage', () => {
  const authorInputs = [{ id: 'draft:target-units', text: '20' }]
  const draftText = '清晨的街道渐渐苏醒，林岚带着昨日的线索走向城门。'
  function drafting(text = draftText) {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: `${text}\n点我继续生成后续内容` })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    return { ...f, fixture: f, dispatch }
  }
  async function generate(f: ReturnType<typeof drafting>, selection: BeginGenerationRequest,
    algorithm: DraftVisibleTextVersion = DRAFT_VISIBLE_TEXT_VERSION) {
    const run = f.owner.begin(selection)
    const execution = await f.owner.execute({ handle: run.handle, invocationNonce: `draft:${selection.chapterNumber}`, task })
    const raw = execution.run.artifacts[0]!
    const visible = sanitizeDraftText(raw.text, algorithm)
    f.owner.composeVisible(run.handle, [raw.artifactId], textHash(visible), algorithm)
    return { run, raw, request: { handle: run.handle, chapterNumber: selection.chapterNumber!, source: 'write' as const,
      expectedCompositionHash: textHash(visible), ...(selection.batchId ? { batchId: selection.batchId } : {}) } }
  }
  it('preserves the raw artifact and reopens one saved draft after a lost acknowledgement', async () => {
    const f = drafting(), generated = await generate(f, { ...f.begin, authorInputs })
    const saved = f.owner.commitDraft(generated.request)
    expect(saved.content).toBe(draftText)
    expect(f.owner.read(generated.run.handle).artifacts[0]!.text).toContain('点我继续生成后续内容')
    const reopened = f.reopen()
    expect(reopened.commitDraft(generated.request)).toEqual(saved)
    expect(reopened.readContext(generated.run.handle)).toMatchObject({ savedDraft: saved, attemptedPurposes: ['chapter-draft'] })
    expect(f.fixture.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('preserves a repeated refrain through composition, draft persistence and reopening', async () => {
    const refrain = '他又读了一遍石碑上的旧誓言，声音一字不差，像是在回答二十年前的自己：无论谁来到门前，我们都将为他留下一盏灯。'
    const manuscript = `第一次仪式开始了。\n\n${refrain}\n\n二十年后，他带着女儿再次站在石碑前。\n\n${refrain}`
    const f = drafting(manuscript), generated = await generate(f, { ...f.begin,
      authorInputs: [{ id: 'draft:target-units', text: '120' }] })
    expect(f.owner.readVisibleComposition(generated.run.handle)?.text).toBe(manuscript)
    const saved = f.owner.commitDraft(generated.request)
    expect(saved.content).toBe(manuscript)
    const reopened = f.reopen()
    expect(reopened.readVisibleComposition(generated.run.handle)?.text).toBe(manuscript)
    expect(reopened.readContext(generated.run.handle).savedDraft).toEqual(saved)
    expect(reopened.commitDraft(generated.request)).toEqual(saved)
    expect(reopened.read(generated.run.handle).artifacts[0]).toEqual(generated.raw)
    expect(generated.raw.text).toBe(`${manuscript}\n点我继续生成后续内容`)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it.each([false, true])('reads an original v1 composition without changing its hash or saved draft: saved=%s', async savedBeforeReopen => {
    const refrain = '他又读了一遍石碑上的旧誓言，声音一字不差，像是在回答二十年前的自己：无论谁来到门前，我们都将为他留下一盏灯。'
    const first = `第一次仪式开始了。\n\n${refrain}`
    const laterScene = '二十年后，他带着女儿再次站在石碑前。'
    const manuscript = `${first}\n\n${laterScene}\n\n${refrain}`
    const legacyVisible = `${first}\n\n${laterScene}`
    const f = drafting(manuscript), generated = await generate(f, { ...f.begin,
      authorInputs: [{ id: 'draft:target-units', text: '80' }] }, 'draft-visible-v1')
    const saved = savedBeforeReopen ? f.owner.commitDraft(generated.request) : undefined
    const row = f.db.prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE run_id=?')
      .get(generated.run.handle.runId) as { attempt_id: string; usage_receipt_json: string }
    const usage = JSON.parse(row.usage_receipt_json)
    expect(usage.visibleComposition).toMatchObject({ algorithm: 'draft-visible-v1', textHash: textHash(legacyVisible) })
    expect(() => f.owner.composeVisible(generated.run.handle, [generated.raw.artifactId], textHash(manuscript), DRAFT_VISIBLE_TEXT_VERSION))
      .toThrow('GENERATION_COMPOSITION_ALGORITHM_CHANGED')
    const reopened = f.reopen()
    expect(reopened.read(generated.run.handle).artifacts[0]).toEqual(generated.raw)
    expect(reopened.readVisibleComposition(generated.run.handle)?.text).toBe(legacyVisible)
    expect(reopened.readContext(generated.run.handle).composition?.text).toBe(legacyVisible)
    if (saved) {
      expect(saved.content).toBe(legacyVisible)
      expect(reopened.readContext(generated.run.handle).savedDraft).toEqual(saved)
      expect(reopened.commitDraft(generated.request)).toEqual(saved)
      expect(f.fixture.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
    }
    expect(f.fixture.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(row.attempt_id))
      .toBe(row.usage_receipt_json)
    usage.visibleComposition.textHash = textHash(manuscript)
    f.fixture.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify(usage), row.attempt_id)
    expect(() => reopened.readVisibleComposition(generated.run.handle)).toThrow('GENERATION_COMPOSITION_INTEGRITY_FAILED')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('keeps an oversized composition reviewable without creating a draft', async () => {
    const f = drafting(draftText.repeat(2)), generated = await generate(f, { ...f.begin, authorInputs })
    expect(() => f.owner.commitDraft(generated.request)).toThrow('GENERATION_DRAFT_LENGTH_OUT_OF_RANGE')
    expect(f.owner.readVisibleComposition(generated.run.handle)?.text).toBe(draftText.repeat(2))
    expect(f.fixture.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(0)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.owner.pause(generated.run.handle).status).toBe('paused')
    const reopened = f.reopen()
    const resumed = await reopened.resume(generated.run.handle)
    expect(resumed.ledger?.physicalRequests).toBe(1)
    expect(reopened.readVisibleComposition(resumed.handle)?.text).toBe(draftText.repeat(2))
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('composes the single condense revision as a replacement of the oversized draft and commits it', async () => {
    const texts = [draftText.repeat(2), draftText]
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: texts.shift()! })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    const generated = await generate({ ...f, fixture: f, dispatch }, { ...f.begin, authorInputs })
    expect(() => f.owner.commitDraft(generated.request)).toThrow('GENERATION_DRAFT_LENGTH_OUT_OF_RANGE')
    const condense = await f.owner.execute({ handle: generated.run.handle, invocationNonce: 'draft:condense',
      task: { ...task, purpose: 'chapter-draft-condense' } })
    const condensedId = condense.run.artifacts.at(-1)!.artifactId
    expect(() => f.owner.composeVisible(generated.run.handle, [condensedId], textHash(draftText), DRAFT_VISIBLE_TEXT_VERSION))
      .toThrow('GENERATION_COMPOSITION_SOURCE_INVALID')
    const composed = f.owner.composeVisible(generated.run.handle, [generated.raw.artifactId, condensedId], textHash(draftText), DRAFT_VISIBLE_TEXT_VERSION)
    expect(composed.text).toBe(draftText)
    const saved = f.owner.commitDraft({ ...generated.request, expectedCompositionHash: textHash(draftText) })
    expect(saved.content).toBe(draftText)
    expect(f.owner.readContext(generated.run.handle).attemptedPurposes).toEqual(['chapter-draft', 'chapter-draft-condense'])
    expect(f.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
  })
  it('refuses a condense revision that does not shorten the composed draft', async () => {
    const texts = [draftText, `${draftText}城门外的风更紧了。`]
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: texts.shift()! })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    const generated = await generate({ ...f, fixture: f, dispatch }, { ...f.begin, authorInputs })
    const condense = await f.owner.execute({ handle: generated.run.handle, invocationNonce: 'draft:condense',
      task: { ...task, purpose: 'chapter-draft-condense' } })
    const longer = `${draftText}城门外的风更紧了。`
    expect(() => f.owner.composeVisible(generated.run.handle, [generated.raw.artifactId, condense.run.artifacts.at(-1)!.artifactId],
      textHash(longer), DRAFT_VISIBLE_TEXT_VERSION)).toThrow('GENERATION_COMPOSITION_NO_PROGRESS')
    expect(f.owner.readVisibleComposition(generated.run.handle)?.text).toBe(draftText)
  })
  it('refuses a condense revision that replaces a draft already within the frozen target maximum', async () => {
    const shorter = '清晨的街道渐渐苏醒，林岚走向城门。'
    const texts = [draftText, shorter]
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: texts.shift()! })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    const generated = await generate({ ...f, fixture: f, dispatch }, { ...f.begin, authorInputs })
    const condense = await f.owner.execute({ handle: generated.run.handle, invocationNonce: 'draft:condense',
      task: { ...task, purpose: 'chapter-draft-condense' } })
    expect(() => f.owner.composeVisible(generated.run.handle, [generated.raw.artifactId, condense.run.artifacts.at(-1)!.artifactId],
      textHash(shorter), DRAFT_VISIBLE_TEXT_VERSION)).toThrow('GENERATION_COMPOSITION_NO_PROGRESS')
    expect(f.owner.readVisibleComposition(generated.run.handle)?.text).toBe(draftText)
  })
  it.each([
    [1399, 'GENERATION_DRAFT_INCOMPLETE'],
    [1400, null],
    [2600, null],
    [2601, 'GENERATION_DRAFT_LENGTH_OUT_OF_RANGE'],
  ] as const)('enforces the exact main-owned 2000-unit boundary at %i', async (units, error) => {
    const text = '正'.repeat(units), f = drafting(text)
    const generated = await generate(f, { ...f.begin, authorInputs: [{ id: 'draft:target-units', text: '2000' }] })
    if (error) {
      expect(() => f.owner.commitDraft(generated.request)).toThrow(error)
      expect(f.fixture.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(0)
    } else {
      expect(f.owner.commitDraft(generated.request).content).toBe(text)
      expect(f.fixture.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
    }
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('refuses a formal save after a structured character fact changes', async () => {
    const f = drafting(), generated = await generate(f, { ...f.begin, authorInputs })
    f.db.exec("INSERT INTO characters(character_id,name) VALUES('author-character','新角色')")
    expect(() => f.owner.commitDraft(generated.request)).toThrow('GENERATION_SOURCE_CHANGED')
    expect(f.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(0)
    expect(f.owner.readVisibleComposition(generated.run.handle)?.text).toBe(draftText)
  })
  it.each(['项目指导', '剧情线', '角色关系'])('preserves the candidate and refuses a save after %s changes', async source => {
    const f = drafting()
    if (source === '角色关系') f.db.exec("INSERT INTO characters(character_id,name) VALUES('甲','林岚'),('乙','周平'); INSERT INTO character_identity_approvals VALUES('作者确认','合成摘要','{}')")
    const generated = await generate(f, { ...f.begin, authorInputs })
    if (source === '项目指导') {
      const directory = path.join(f.root, 'project', 'prompts')
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, '作者指导.md'), '作者新增的本项目要求')
    } else if (source === '剧情线') {
      f.db.exec("INSERT INTO narrative_thread_plans(title,type,target_start_chapter,target_end_chapter,author_intent) VALUES('城门之谜','主线',1,2,'逐步揭开真相')")
    } else {
      f.db.exec("INSERT INTO character_relationships VALUES('关系一','甲','乙','同伴','林岚','周平','{}','作者确认')")
    }
    expect(() => f.owner.commitDraft(generated.request)).toThrow('GENERATION_SOURCE_CHANGED')
    expect(f.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(0)
    expect(f.owner.readVisibleComposition(generated.run.handle)?.text).toBe(draftText)
  })
  it.each(['draft-visible-v1', DRAFT_VISIBLE_TEXT_VERSION] as const)('keeps %s chapter lineage, pending recovery identity and the original batch root', async algorithm => {
    const f = drafting()
    f.db.exec("INSERT INTO blueprints(chapter_number,title) VALUES(2,'第二章')")
    const batch = f.owner.beginBatch({ mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 20,
      uiActionNonce: 'batch', modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const selection = { ...f.begin, authorInputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId }
    const first = await generate(f, selection, algorithm), saved = f.owner.commitDraft(first.request)
    expect(f.owner.readBatch(batch.batchId).nextChapterNumber).toBe(2)
    expect(() => f.owner.begin({ ...selection, chapterNumber: 2, uiActionNonce: 'chapter2' })).toThrow('GENERATION_BATCH_LINEAGE_INVALID')
    const materialDecision: NonNullable<BeginGenerationRequest['materialDecision']> = {
      version: 1, verdict: 'admitted', promptHash: 'b'.repeat(64),
      capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 24 },
      coverage: { required: 2, included: 2, complete: true },
      included: [
        { sourceId: 'author:required', revision: 1, contentHash: 'a'.repeat(64), category: 'author', required: true, units: 12 },
        { sourceId: `candidate:${saved.id}`, revision: saved.version, contentHash: saved.contentHash,
          category: 'finalized-history', required: true, units: 12 },
      ],
      omitted: [],
    }
    const next = f.owner.begin({ ...selection, chapterNumber: 2, uiActionNonce: 'chapter2', selectedDraftIds: [saved.id], materialDecision })
    expect(f.owner.readContext(next.handle).selectedDrafts).toMatchObject([{ draftId: saved.id, required: true }])
    expect(f.owner.readBatch(batch.batchId).currentChapterRunHandle).toEqual(next.handle)
    expect(() => f.owner.begin({ ...selection, chapterNumber: 2, uiActionNonce: 'duplicate', selectedDraftIds: [saved.id] })).toThrow('GENERATION_BATCH_RECOVERY_REQUIRED')
    const reopened = f.reopen()
    expect(reopened.readBatch(batch.batchId).currentChapterRunHandle).toEqual(next.handle)
    const resumed = await reopened.resume(next.handle)
    expect(resumed.handle.rootActionId).toBe(batch.rootHandle.rootActionId)
    expect(resumed.ledger?.physicalRequests).toBe(1)
  })
  it('does not advance a batch after an oversized composition is refused', async () => {
    const f = drafting(draftText.repeat(2))
    f.db.exec("INSERT INTO blueprints(chapter_number,title) VALUES(2,'第二章')")
    const batch = f.owner.beginBatch({ mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 20,
      uiActionNonce: 'oversized-batch', modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const generated = await generate(f, { ...f.begin, authorInputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId })
    expect(() => f.owner.commitDraft(generated.request)).toThrow('GENERATION_DRAFT_LENGTH_OUT_OF_RANGE')
    expect(f.owner.readBatch(batch.batchId)).toMatchObject({ nextChapterNumber: 1, completedChapters: [] })
    expect(f.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(0)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it.each(['auto_finalize', 'draft_review'] as const)('enforces the shared %s batch chapter limit in main before any budget', mode => {
    const f = drafting()
    const intent = (endChapter: number, uiActionNonce: string) => ({ mode, range: { startChapter: 3, endChapter }, targetUnits: 20,
      uiActionNonce, modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    expect(() => f.owner.beginBatch(intent(3 + MAX_BATCH_CHAPTERS, 'eleven'))).toThrow('GENERATION_BATCH_INTENT_INVALID')
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(0)
    const accepted = f.owner.beginBatch(intent(2 + MAX_BATCH_CHAPTERS, 'ten'))
    expect(accepted.range).toEqual({ startChapter: 3, endChapter: 12 })
    expect(f.owner.read(accepted.rootHandle).budget.maxAttempts).toBe(batchRootBudget(MAX_BATCH_CHAPTERS).maxPhysicalRequests)
  })
  it('scales a 10-chapter automatic batch root so minimum and typical usage finish, and still fails closed beyond it', async () => {
    const f = drafting()
    const batch = f.owner.beginBatch({ mode: 'auto_finalize', range: { startChapter: 1, endChapter: 10 }, targetUnits: 20,
      uiActionNonce: 'ten-chapter-batch', modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const budget = batchRootBudget(10)
    expect(budget).toEqual({ maxPhysicalRequests: 80, maxTokenLiability: 5_242_880, maxOutputPerRequest: 32_768, maxActiveElapsedMs: 9_000_000 })
    const generated = await generate(f, { ...f.begin, authorInputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId })
    expect(generated.run.budget.maxAttempts).toBe(80)
    // 每章最低 4 次（对账、首稿、notes、cards）× 10 = 40；典型每章 6 次 = 60；新上限 80 全部可用。
    for (let request = 2; request <= 80; request++) {
      const result = await f.owner.execute({ handle: generated.run.handle, invocationNonce: `batch-request-${request}`, task: { ...task, purpose: 'chapter-draft-continuation' } })
      if ([40, 60, 80].includes(request)) expect(result.run.ledger?.physicalRequests).toBe(request)
    }
    await expect(f.owner.execute({ handle: generated.run.handle, invocationNonce: 'batch-request-81', task: { ...task, purpose: 'chapter-draft-continuation' } }))
      .rejects.toThrow('ROOT_BUDGET_EXHAUSTED')
    expect(f.dispatch).toHaveBeenCalledTimes(80)
    // 单章非批量根不变。
    expect(f.owner.begin({ ...f.begin, authorInputs, uiActionNonce: 'single' }).budget.maxAttempts).toBe(MAIN_GENERATION_POLICY.budget.maxPhysicalRequests)
  }, 60_000)
  it('waits for the exact finalization postprocess before advancing an automatic batch', async () => {
    const f = drafting()
    const batch = f.owner.beginBatch({ mode: 'auto_finalize', range: { startChapter: 1, endChapter: 1 }, targetUnits: 20,
      uiActionNonce: 'batch', modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const generated = await generate(f, { ...f.begin, authorInputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId })
    const saved = f.owner.commitDraft(generated.request)
    FinalizationRepository.commit({ finalizationId: 'finalization-one', draftId: saved.id, chapterNumber: 1, chapterTitle: '第一章', content: saved.content,
      contentHash: saved.contentHash, contentRevision: 1, targetFileName: '第一章.txt' })
    expect(f.owner.readBatch(batch.batchId)).toMatchObject({ nextChapterNumber: 1, completedChapters: [{ pendingFinalizationId: 'finalization-one' }] })
    FinalizationRepository.markPublished('finalization-one')
    expect(f.owner.readBatch(batch.batchId).nextChapterNumber).toBe(1)
    expect(() => f.owner.confirmBatchFinalization({ batchId: batch.batchId, chapterNumber: 1, finalizationId: 'finalization-one' })).toThrow('GENERATION_BATCH_FINALIZATION_REQUIRED')
    const post = PostProcessRepository.createRun({ triggerSourceType: 'chapter_finalize', triggerSourceId: '1', sourceLabel: '第一章',
      finalizedSource: { finalizationId: 'finalization-one', draftId: saved.id, chapterNumber: 1, contentHash: saved.contentHash },
      steps: [{ key: 'kb_import', label: '知识库', critical: true }, { key: 'chapter_notes', label: '章节笔记', critical: true }] })
    PostProcessRepository.markStepOk(post, 'kb_import')
    expect(f.owner.readBatch(batch.batchId).nextChapterNumber).toBe(1)
    PostProcessRepository.markStepOk(post, 'chapter_notes')
    expect(f.owner.confirmBatchFinalization({ batchId: batch.batchId, chapterNumber: 1, finalizationId: 'finalization-one' }).nextChapterNumber).toBeNull()
  })
})

it('rejects an empty begin prompt selection without creating a run or dispatching', () => {
  const dispatch = vi.fn(), f = fixture(dispatch)
  expect(() => f.owner.begin({ ...f.begin, promptKeys: [] })).toThrow('GENERATION_BEGIN_INVALID')
  expect(f.owner.list()).toHaveLength(0)
  expect(dispatch).not.toHaveBeenCalled()
})
it('refuses resume after selected template bytes change across a real reopen', async () => {
  const dispatch = vi.fn(), f = fixture(dispatch), view = f.owner.begin(f.begin)
  const prompts = path.join(f.root, 'project', 'prompts')
  fs.mkdirSync(prompts, { recursive: true })
  fs.writeFileSync(path.join(prompts, 'first_chapter_draft.json'), JSON.stringify({ key: 'first_chapter_draft', content: '作者修改后的模板' }))
  const reopened = f.reopen()
  await expect(reopened.resume(view.handle)).rejects.toThrow('GENERATION_RECOVERY_UNAUTHORIZED')
  expect(reopened.read(view.handle).handle.epoch).toBe('epoch-1')
  expect(dispatch).not.toHaveBeenCalled()
})
