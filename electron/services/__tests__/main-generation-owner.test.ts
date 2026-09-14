import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { createMainGenerationOwner } from '../main-generation-owner'
import { MAIN_GENERATION_POLICY } from '../main-generation-plan'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { readBuiltinWritingSkill } from '../../../src/shared/builtin-writing-skills'
import type { BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import { generationOutputContract } from '../../../src/shared/generation-owner-contract'
import { textHash } from '../../repositories/generation-run-repository'
import { composeVisibleContinuation } from '../../../src/shared/visible-continuation'
import { sanitizeDraftText } from '../../../src/shared/draft-visible-text'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { PostProcessRepository } from '../../repositories/post-process-repository'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { getProjectDb } from '../../database'
import { BlueprintRepository, type BlueprintRangeCommitRequest } from '../../repositories/blueprint-repository'
vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanups: (() => void)[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0)) cleanup() })
const task = { purpose: 'chapter-draft', output: 'visible-text' as const, messages: [{ role: 'user' as const, content: '保留作者事实，创作中文段落。' }] }
function fixture(dispatch?: GenerationRunServiceDependencies['dispatch'], silicon = false) {
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
  it('rejects wrong hash, foreign/reordered artifacts, regression and changed formal sources', async () => {
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
    expect(() => f.owner.composeVisible(run.handle, [a, b], textHash(composeVisibleContinuation(first.outcome.content, second.outcome.content)))).toThrow('GENERATION_SOURCE_CHANGED')
    expect(f.owner.readVisibleComposition(run.handle)?.text).toBe(first.outcome.content)
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
  it('marks before sending, preserves exact visible text and replays one durable nonce without network', async () => {
    const fetch = syntheticStream(), f = fixture(), view = f.owner.begin(f.begin)
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
    await f.owner.execute({ handle: view.handle, invocationNonce: 'call', task })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(f.owner.list()[0].ledger?.physicalRequests).toBe(1)
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
    const output = JSON.stringify({ results: ['1:1', '2:1'].map(sourceId => ({ sourceId, characterCards: [{ name: '林岚', role: 'supporting', notes: `来源${sourceId}` }] })) })
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
    expect(f.owner.characterProposals.cancel(batch.proposalBatchId).status).toBe('cancelled')
    expect(f.owner.characterProposals.read(batch.proposalBatchId).items).toHaveLength(2)
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
  })
})

describe('main draft persistence and batch lineage', () => {
  const authorInputs = [{ id: 'draft:target-units', text: '10' }]
  const draftText = '清晨的街道渐渐苏醒，林岚带着昨日的线索走向城门。'
  function drafting() {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: `${draftText}\n点我继续生成后续内容` })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    return { ...f, fixture: f, dispatch }
  }
  async function generate(f: ReturnType<typeof drafting>, selection: BeginGenerationRequest) {
    const run = f.owner.begin(selection)
    const execution = await f.owner.execute({ handle: run.handle, invocationNonce: `draft:${selection.chapterNumber}`, task })
    const raw = execution.run.artifacts[0]!
    const visible = sanitizeDraftText(raw.text)
    f.owner.composeVisible(run.handle, [raw.artifactId], textHash(visible), 'draft-visible-v1')
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
  it('keeps chapter lineage, pending recovery identity and the original batch root', async () => {
    const f = drafting()
    f.db.exec("INSERT INTO blueprints(chapter_number,title) VALUES(2,'第二章')")
    const batch = f.owner.beginBatch({ mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 10,
      uiActionNonce: 'batch', modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const selection = { ...f.begin, authorInputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId }
    const first = await generate(f, selection), saved = f.owner.commitDraft(first.request)
    expect(f.owner.readBatch(batch.batchId).nextChapterNumber).toBe(2)
    expect(() => f.owner.begin({ ...selection, chapterNumber: 2, uiActionNonce: 'chapter2' })).toThrow('GENERATION_BATCH_LINEAGE_INVALID')
    const next = f.owner.begin({ ...selection, chapterNumber: 2, uiActionNonce: 'chapter2', selectedDraftIds: [saved.id] })
    expect(f.owner.readBatch(batch.batchId).currentChapterRunHandle).toEqual(next.handle)
    expect(() => f.owner.begin({ ...selection, chapterNumber: 2, uiActionNonce: 'duplicate', selectedDraftIds: [saved.id] })).toThrow('GENERATION_BATCH_RECOVERY_REQUIRED')
    const reopened = f.reopen()
    expect(reopened.readBatch(batch.batchId).currentChapterRunHandle).toEqual(next.handle)
    const resumed = await reopened.resume(next.handle)
    expect(resumed.handle.rootActionId).toBe(batch.rootHandle.rootActionId)
    expect(resumed.ledger?.physicalRequests).toBe(1)
  })
  it('waits for the exact finalization postprocess before advancing an automatic batch', async () => {
    const f = drafting()
    const batch = f.owner.beginBatch({ mode: 'auto_finalize', range: { startChapter: 1, endChapter: 1 }, targetUnits: 10,
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
