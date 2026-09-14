import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { MAIN_GENERATION_POLICY } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { ReviewRepository } from '../../repositories/review-repository'
import { RevisionRepository } from '../../repositories/revision-repository'
import { createHumanConfirmedReviewSnapshot, serializeHumanConfirmedReviewSnapshot } from '../../../src/shared/human-confirmed-review'
import { getProjectDb } from '../../database'
import { textHash } from '../../repositories/generation-run-repository'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import type { PrepareReviewRevisionRequest } from '../../../src/shared/review-revision-generation'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const prose = '林岚走进北塔，灯火照亮了石阶。'.repeat(20)
const report = JSON.stringify({ summary: '检查完成', items: [{ category: '表达', severity: 'warning', description: '补充动作细节', quote: '林岚走进北塔' }] })
function fixture(dispatch?: GenerationRunServiceDependencies['dispatch']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/review-revision-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  let db = new Database(path.join(root, 'project.db'))
  vi.mocked(getProjectDb).mockReturnValue(db)
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.exec("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','合成审稿',100); INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔');")
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(prose)
  db.exec("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,280)")
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const spy = vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch ?? (async (_request, options) => { options.onVisible({ kind: 'delta', text: report }); return { finishReason: 'stop', usage: null } }))
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: () => '冻结的合成提示词' }
  const makeOwner = (epoch: string) => createMainGenerationOwner({ database: db, projectId: 'project', epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: spy,
    buildBinding: (selection, modelReceipt) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch, modelReceipt, policy: MAIN_GENERATION_POLICY, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt, MAIN_GENERATION_POLICY).binding })
  const owner = makeOwner('epoch-1')
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const prepare = (operation: PrepareReviewRevisionRequest['operation'] = 'review-chapter') => owner.prepareReviewRevision({ operation, draftId: 1, expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(prose) }, authorInputs: [], uiLocale: 'zh-CN' })
  const selection = (prepared: ReturnType<typeof prepare>): BeginGenerationRequest => ({ operation: prepared.context.operation, uiActionNonce: 'action', modelId: model.id, chapterNumber: 1, selectedDraftIds: [1], selectedFinalizedDraftIds: [], promptKeys: [prepared.context.operation === 'review-chapter' ? 'consistency_check' : prepared.context.operation === 'refine-draft' ? 'refine_chapter' : 'refine_from_review'], skillStages: [prepared.context.operation === 'review-chapter' ? 'review' : 'refinement'], output: prepared.context.operation === 'review-chapter' ? 'structured-data' : 'visible-text', reviewRevisionContextId: prepared.contextId, authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(prepared.context) }], ...(prepared.parentRootActionId ? { parentRootActionId: prepared.parentRootActionId } : {}) })
  const run = async (operation: PrepareReviewRevisionRequest['operation'] = 'review-chapter') => {
    const prepared = prepare(operation), begin = selection(prepared), view = owner.begin(begin)
    const result = await owner.execute({ handle: view.handle, invocationNonce: 'request', task: { purpose: operation, output: begin.output, messages: [{ role: 'user', content: '检查冻结正文' }] } })
    const artifact = result.run.artifacts.at(-1)!
    return { contextId: prepared.contextId, handle: view.handle, artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } }
  }
  const reopenStorage = () => { db.close(); db = new Database(path.join(root, 'project.db')); deps.db = db; vi.mocked(getProjectDb).mockReturnValue(db); return makeOwner('epoch-2') }
  return { get db() { return db }, owner, makeOwner, reopenStorage, prepare, selection, run, spy }
}
describe('review and revision generation through the actual owner and SQLite', () => {
  it('requires main context and rejects forged context and hashes before dispatch', () => {
    const f = fixture(), selection = f.selection(f.prepare())
    expect(() => f.owner.begin({ ...selection, reviewRevisionContextId: undefined })).toThrow('GENERATION_REVIEW_CONTEXT_REQUIRED')
    expect(() => f.owner.begin({ ...selection, authorInputs: [{ id: 'review-revision-context', text: '{}' }] })).toThrow('GENERATION_REVIEW_CONTEXT_MISMATCH')
    expect(() => f.owner.begin({ ...selection, reviewRevisionContextHash: 'a'.repeat(64) } as BeginGenerationRequest)).toThrow()
    expect(f.spy).not.toHaveBeenCalled()
  })
  it.each([['bad-json', 'stop'], [report, 'length']] as const)('does not save an invalid or incomplete review (%s)', async (text, finishReason) => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text }); return { finishReason, usage: null } }), request = await f.run()
    expect(() => f.owner.commitReview(request)).toThrow()
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
  })
  it('saves a review once and replays its saved ACK', async () => {
    const f = fixture(), request = await f.run(), saved = f.owner.commitReview(request)
    expect(saved).toMatchObject({ success: true, kind: 'review' })
    expect(f.owner.commitReview(request)).toEqual(saved)
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(1)
    expect(f.owner.readReviewRevisionRecovery(request.handle).saved).toEqual(saved)
    expect(f.spy).toHaveBeenCalledTimes(1)
  })
  it.each(['source', 'config'] as const)('rejects changed %s while preserving the candidate', async change => {
    const f = fixture(), request = await f.run()
    f.db.exec(change === 'source' ? "UPDATE contents SET body='作者新正文' WHERE id=1" : "UPDATE project_core SET global_guidance='作者新指导' WHERE id='main'")
    expect(() => f.owner.commitReview(request)).toThrow()
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
    expect(f.owner.readReviewRevisionRecovery(request.handle).sourceStatus).toBe('conflict')
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
  })
  it('rolls back the formal row and effect together, then retries the same revision candidate', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: prose }); return { finishReason: 'stop', usage: null } })
    const request = await f.run('refine-draft')
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(prose), 'visible-append-v1')
    const commit = { contextId: request.contextId, handle: request.handle, expectedCompositionHash: composition.textHash }
    const before = f.db.prepare('SELECT COUNT(*) FROM contents').pluck().get()
    f.db.exec("CREATE TRIGGER fail_effect BEFORE UPDATE OF usage_receipt_json ON generation_attempts BEGIN SELECT RAISE(ABORT,'SYNTHETIC_EFFECT_FAILURE'); END")
    expect(() => f.owner.commitRevision(commit)).toThrow('SYNTHETIC_EFFECT_FAILURE')
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) FROM contents').pluck().get()).toBe(before)
    expect(f.owner.readReviewRevisionRecovery(request.handle).saved).toBeUndefined()
    f.db.exec('DROP TRIGGER fail_effect')
    const saved = f.owner.commitRevision(commit)
    expect(saved).toMatchObject({ kind: 'revision', revisionStatus: 'pending', content: prose })
    expect(f.owner.commitRevision(commit)).toEqual(saved)
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(1)
  })
  it('rejects a short revision despite a stop and a valid visible composition', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: '太短' }); return { finishReason: 'stop', usage: null } }), request = await f.run('refine-draft')
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash('太短'), 'visible-append-v1')
    expect(() => f.owner.commitRevision({ contextId: request.contextId, handle: request.handle, expectedCompositionHash: composition.textHash })).toThrow()
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(0)
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
  })
  it('retains the saved review and frozen manifest after closing the owner and reopening a new epoch', async () => {
    const f = fixture(), request = await f.run(), saved = f.owner.commitReview(request)
    const before = f.owner.readReviewRevisionRecovery(request.handle).context
    f.owner.suspendForProjectClose()
    const reopened = f.reopenStorage()
    try {
      const recovery = reopened.readReviewRevisionRecovery(request.handle)
      expect(recovery.context).toEqual(before)
      expect(recovery.saved).toEqual(saved)
      expect(reopened.commitReview(request)).toEqual(saved)
      expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(1)
      expect(f.spy).toHaveBeenCalledTimes(1)
    } finally { reopened.suspendForProjectClose() }
  })
  it('derives review-fix lineage from the saved original review and refuses confirmation changes', async () => {
    const f = fixture(), original = await f.run(), saved = f.owner.commitReview(original)
    const snapshot = createHumanConfirmedReviewSnapshot({ sourceReviewId: saved.id, sourceDraft: saved.source, summary: '作者确认', authorGuidance: '保持克制', items: [{ category: '表达', severity: 'warning', description: '补充动作', decision: 'apply', origin: 'ai' }] })
    const content = serializeHumanConfirmedReviewSnapshot(snapshot!)
    const confirmation = ReviewRepository.create({ baseDraftId: 1, content, expectedSource: saved.source }, f.db)
    const request: PrepareReviewRevisionRequest = { operation: 'refine-from-review', draftId: 1, expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(prose) }, authorInputs: [], uiLocale: 'zh-CN', reviewSourceId: confirmation.id, confirmedReviewContent: content }
    const prepared = f.owner.prepareReviewRevision(request)
    expect(prepared.parentRootActionId).toBe(original.handle.rootActionId)
    expect(prepared.modelId).toBe('synthetic')
    const selection = { ...f.selection(prepared), uiActionNonce: 'confirmed-fix' }
    expect(() => f.owner.begin({ ...selection, parentRootActionId: undefined })).toThrow('GENERATION_BEGIN_INVALID')
    expect(() => f.owner.begin({ ...selection, modelId: 'other' })).toThrow()
    const view = f.owner.begin(selection)
    expect(view.handle.rootActionId).toBe(original.handle.rootActionId)
    await f.owner.execute({ handle: view.handle, invocationNonce: 'fix-1', task: { purpose: 'refine-from-review', output: 'visible-text', messages: [{ role: 'user', content: '按确认修改' }] } })
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(2)
    expect(f.db.prepare('SELECT COUNT(DISTINCT root_action_id) FROM generation_runs').pluck().get()).toBe(1)
    const candidate = f.owner.read(view.handle).candidates![0]
    const composition = f.owner.composeVisible(view.handle, [candidate.artifactId], textHash(report), 'visible-append-v1')
    f.db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM reviews WHERE id=?)').run('作者改了确认', confirmation.id)
    expect(f.owner.readReviewRevisionRecovery(view.handle).sourceStatus).toBe('conflict')
    expect(() => f.owner.commitRevision({ contextId: prepared.contextId, handle: view.handle, expectedCompositionHash: composition.textHash })).toThrow()
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(0)
    expect(f.owner.read(view.handle).candidates).toHaveLength(1)
    expect(() => f.owner.prepareReviewRevision(request)).toThrow('GENERATION_REVIEW_CONFIRMATION_CHANGED')
  })
  it('refuses a legacy AI review without an owner effect instead of opening a new budget root', () => {
    const f = fixture(), source = f.prepare().context.source
    const legacy = ReviewRepository.create({ baseDraftId: 1, content: report, expectedSource: source }, f.db)
    const content = serializeHumanConfirmedReviewSnapshot(createHumanConfirmedReviewSnapshot({ sourceReviewId: legacy.id, sourceDraft: source, summary: '确认旧稿', authorGuidance: '', items: [{ category: '表达', severity: 'warning', description: '修改', decision: 'apply', origin: 'ai' }] })!)
    const confirmation = ReviewRepository.create({ baseDraftId: 1, content, expectedSource: source }, f.db)
    expect(() => f.owner.prepareReviewRevision({ operation: 'refine-from-review', draftId: 1, expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(prose) }, authorInputs: [], uiLocale: 'zh-CN', reviewSourceId: confirmation.id, confirmedReviewContent: content })).toThrow('GENERATION_REVIEW_LINEAGE_UNPROVEN')
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
    expect(f.spy).not.toHaveBeenCalled()
  })
  it('replays an old revision ACK without discarding a later pending revision', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: prose }); return { finishReason: 'stop', usage: null } }), request = await f.run('refine-draft')
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(prose), 'visible-append-v1')
    const commit = { contextId: request.contextId, handle: request.handle, expectedCompositionHash: composition.textHash }
    const saved = f.owner.commitRevision(commit)
    const later = RevisionRepository.replacePending({ baseDraftId: 1, revisionType: 'refine', userPrompt: '后来的作者指导', content: prose + '后来候选', wordCount: 284, expectedSource: saved.source }, f.db)
    expect(f.owner.commitRevision(commit)).toMatchObject({ id: saved.id, revisionStatus: 'discarded' })
    expect(RevisionRepository.getFull(later.id, f.db)).toMatchObject({ status: 'pending', content: prose + '后来候选' })
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(2)
  })
  it('does not write a review when a cancelled provider returns late', async () => {
    let finish!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const f = fixture(async (_request, options) => {
      started()
      await new Promise<void>(resolve => { finish = resolve })
      options.onVisible({ kind: 'delta', text: report })
      return { finishReason: 'stop', usage: null }
    })
    const prepared = f.prepare(), view = f.owner.begin(f.selection(prepared))
    const pending = f.owner.execute({ handle: view.handle, invocationNonce: 'late', task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: '审稿' }] } })
    await entered
    f.owner.cancel(view.handle)
    finish()
    await pending
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
    expect(f.owner.readReviewRevisionRecovery(view.handle).saved).toBeUndefined()
    expect(f.owner.read(view.handle).artifacts.every(artifact => artifact.text === '')).toBe(true)
    expect(f.spy).toHaveBeenCalledTimes(1)
  })
  it('does not turn length-terminated revision text into a formal revision', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: prose }); return { finishReason: 'length', usage: null } }), request = await f.run('refine-draft')
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(prose), 'visible-append-v1')
    expect(() => f.owner.commitRevision({ contextId: request.contextId, handle: request.handle, expectedCompositionHash: composition.textHash })).toThrow('GENERATION_REVIEW_ARTIFACT_INVALID')
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(0)
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
  })
  it('seals a saved review artifact against discard and preserves its ACK after reopening', async () => {
    const f = fixture(), request = await f.run(), saved = f.owner.commitReview(request)
    expect(() => f.owner.discardCandidate(request.handle, request.artifact.artifactId)).toThrow('GENERATION_REVIEW_ALREADY_SAVED')
    expect(f.owner.readReviewRevisionRecovery(request.handle).saved).toEqual(saved)
    expect(f.owner.commitReview(request)).toEqual(saved)
    f.owner.suspendForProjectClose()
    const reopened = f.reopenStorage()
    try {
      expect(reopened.readReviewRevisionRecovery(request.handle).saved).toEqual(saved)
      expect(reopened.commitReview(request)).toEqual(saved)
      expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(1)
    } finally { reopened.suspendForProjectClose() }
  })
  it('seals a saved revision against new attempts while allowing the original invocation replay', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: prose }); return { finishReason: 'stop', usage: null } }), request = await f.run('refine-draft')
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(prose), 'visible-append-v1')
    const commit = { contextId: request.contextId, handle: request.handle, expectedCompositionHash: composition.textHash }
    const saved = f.owner.commitRevision(commit)
    const task = { purpose: 'refine-draft', output: 'visible-text' as const, messages: [{ role: 'user' as const, content: '检查冻结正文' }] }
    await expect(f.owner.execute({ handle: request.handle, invocationNonce: 'new-request', task })).rejects.toThrow('GENERATION_REVIEW_ALREADY_SAVED')
    await expect(f.owner.execute({ handle: request.handle, invocationNonce: 'request', task })).resolves.toBeDefined()
    expect(f.spy).toHaveBeenCalledTimes(1)
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(1)
    expect(() => f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(prose), 'visible-append-v1')).toThrow('GENERATION_REVIEW_ALREADY_SAVED')
    expect(f.owner.readReviewRevisionRecovery(request.handle).saved).toEqual(saved)
    f.owner.suspendForProjectClose()
    const reopened = f.reopenStorage()
    try {
      expect(reopened.readReviewRevisionRecovery(request.handle).saved).toEqual(saved)
      expect(reopened.commitRevision(commit)).toEqual(saved)
      expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(1)
    } finally { reopened.suspendForProjectClose() }
  })
  it('cannot switch a saved composition to another already generated artifact', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: prose }); return { finishReason: 'stop', usage: null } }), request = await f.run('refine-draft')
    const second = await f.owner.execute({ handle: request.handle, invocationNonce: 'second-before-save', task: { purpose: 'refine-draft', output: 'visible-text', messages: [{ role: 'user', content: '另一候选' }] } })
    const secondId = second.run.artifacts.at(-1)!.artifactId
    expect(secondId).not.toBe(request.artifact.artifactId)
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(prose), 'visible-append-v1')
    const commit = { contextId: request.contextId, handle: request.handle, expectedCompositionHash: composition.textHash }
    const saved = f.owner.commitRevision(commit)
    expect(() => f.owner.composeVisible(request.handle, [secondId], textHash(prose), 'visible-append-v1')).toThrow('GENERATION_REVIEW_ALREADY_SAVED')
    const recovery = f.owner.readReviewRevisionRecovery(request.handle)
    expect(recovery.composition?.artifactIds).toEqual([request.artifact.artifactId])
    expect(recovery.saved).toEqual(saved)
    expect(f.owner.commitRevision(commit)).toEqual(saved)
    expect(f.spy).toHaveBeenCalledTimes(2)
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(2)
  })})
