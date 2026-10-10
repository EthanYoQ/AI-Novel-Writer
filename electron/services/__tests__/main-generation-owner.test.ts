import { planBlueprintGenerationCost } from '../../../src/services/workflows/blueprint-batch-policy'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { createMainGenerationOwner, safeGenerationModelReceipt } from '../main-generation-owner'
import { batchRootBudget, buildMainGenerationPlan, MAIN_GENERATION_POLICY, newMainGenerationPolicy, readMainGenerationPolicy } from '../main-generation-plan'
import { createModelExecutionLeaseReceipt, ModelExecutionLeaseRegistry } from '../model-execution-lease'
import * as providerPresets from '../../../src/shared/provider-presets'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { readBuiltinWritingSkill } from '../../../src/shared/builtin-writing-skills'
import type { ArchitecturePlanningIntent, BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import { generationOutputContract, MAX_BATCH_CHAPTERS } from '../../../src/shared/generation-owner-contract'
import { GenerationRunRepository, textHash } from '../../repositories/generation-run-repository'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import { createMainOwnedGenerationRuntime, type MainGenerationSnapshot, type MainGenerationTransport } from '../../../src/services/generation/generation-runtime'
import { formatGenerationBudgetDiagnostic } from '../../../src/services/generation/prompt-budget-failure'
import { composeVisibleContinuation } from '../../../src/shared/visible-continuation'
import { sanitizeDraftText, DRAFT_VISIBLE_TEXT_VERSION, type DraftVisibleTextVersion } from '../../../src/shared/draft-visible-text'
import { DRAFT_RECONCILE_PURPOSE, parseDraftReconciliation, renderDraftReconciliationBlock } from '../../../src/shared/draft-reconciliation'
import { DRAFT_SHORT_OUTLINE_PURPOSE, draftShortOutlineBlock } from '../../../src/shared/draft-short-outline'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { PostProcessRepository } from '../../repositories/post-process-repository'
import { RevisionRepository } from '../../repositories/revision-repository'
import { DraftRepository } from '../../repositories/draft-repository'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { getProjectDb } from '../../database'
import { BlueprintRepository, type BlueprintRangeCommitRequest } from '../../repositories/blueprint-repository'
import { commitCharacterIdentities, refreshCharacterIdentityProjection } from '../../repositories/character-roster-repository'
import { proveCharacterProposal } from '../generation-character-proposal-proof'
import { CHARACTER_DETAIL_DESCRIPTION_FIELDS, CHARACTER_STATE_TEXT_FIELDS } from '../../../src/shared/character-proposal-parser'
import { PLOT_OUTLINE_CONTENT, PLOT_OUTLINE_PROTOCOL, joinPlotOutlineEntries, plotOutlinePurpose, plotOutlineRequestContract, planningTargetInstruction, renderPlotOutlineSynopsis, renderPlotOutlineRange, type PlotOutlineProgress } from '../../../src/shared/plot-outline-contract'
import { synopsisForDraftChapter } from '../../../src/services/workflows/commands/generate-draft.command'
import { parseTextBlueprintsStrict } from '../../../src/services/workflows/directory-workflow'
import { ProjectCoreRepository, type ProjectCoreSynopsisCommitRequest } from '../../repositories/project-core-repository'
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
      buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(sourceDeps, { ...selection, projectId: 'project', epoch: capturedEpoch,
        modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
      rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(sourceDeps, previous, capturedEpoch, modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding,
    })
  }
  const owners = [makeOwner()]
  cleanups.push(() => { for (const owner of owners) { try { owner.suspendForProjectClose() } catch { /* injected disk error retains tail */ } }
    if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const begin: BeginGenerationRequest = { operation: 'chapter-draft', uiActionNonce: 'click', modelId: model.id, chapterNumber: 1,
    selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['first_chapter_draft'], skillStages: [], output: 'visible-text' }
  return { root, model, get db() { return db }, owner: owners[0], begin,
    invalidate: () => { current = false },
    reopen: () => { owners.at(-1)!.suspendForProjectClose(); db.close(); db = new Database(path.join(root, 'project.db')); epoch = `epoch-${owners.length + 1}`;
      const owner = makeOwner(); owners.push(owner); return owner },
  }
}
function syntheticStream(includeUsage = true) {
  const fetch = vi.fn<(url: string, options: RequestInit) => Promise<{ ok: boolean; body: ReadableStream<Uint8Array> }>>(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"隐藏推理","content":" 正文\\n"},"finish_reason":"stop"}]}\n\n'
      + (includeUsage ? 'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":12,"total_tokens":62}}\n\n' : '') + 'data: [DONE]\n\n'))
    controller.close()
  } }) }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
function outlineTask(progress: PlotOutlineProgress): GenerationTask {
  if (progress.cursor.kind !== 'request') throw new Error('TEST_EXPECTED_OUTLINE_REQUEST')
  const { chapterNumber, attempt } = progress.cursor
  return { purpose: plotOutlinePurpose(chapterNumber, attempt), output: 'visible-text', reasoningStage: 'planning',
    messages: [{ role: 'user', content: `原始作者事实\n\n${plotOutlineRequestContract(progress, chapterNumber, attempt)}` }] }
}
function outlineSelection(f: ReturnType<typeof fixture>, to: number, from = 1): BeginGenerationRequest {
  return { operation: 'generate-plot-outline', uiActionNonce: 'outline', modelId: f.model.id, selectedDraftIds: [], selectedFinalizedDraftIds: [],
    promptKeys: ['synopsis'], skillStages: ['planning'], output: 'visible-text',
    authorInputs: [{ id: 'architecture:author-config', text: JSON.stringify({ totalChapters: to }) },
      { id: 'architecture:planning-intent', text: JSON.stringify({ version: 'architecture-action-v1', priorSteps: [], synopsisRange: { from, to } }) }] }
}
function acceptOutline(owner: ReturnType<typeof fixture>['owner'], handle: Parameters<typeof owner.read>[0]) {
  const view = owner.read(handle), progress = view.plotOutline!
  if (progress.cursor.kind !== 'accept') throw new Error('TEST_EXPECTED_OUTLINE_ACCEPT')
  const text = joinPlotOutlineEntries(progress.composition?.text ?? '', progress.cursor.text)
  return owner.composeVisible(handle, [...(progress.composition?.artifactIds ?? []), ...progress.cursor.artifactIds], textHash(text), PLOT_OUTLINE_PROTOCOL)
}
const outlineEntry = (chapter: number) => `## 第${chapter}章：线索${chapter}\n林岚确认第${chapter}份证词，与同伴商议下一步。`

function openAggregateRun(f: ReturnType<typeof fixture>, selection: BeginGenerationRequest) {
  const inputs = selection.authorInputs!
  const intent = JSON.parse(inputs.find(item => item.id === 'architecture:planning-intent')?.text ?? 'null') as ArchitecturePlanningIntent | null
  const requestedRange = JSON.parse(inputs.find(item => item.id === 'directory:requested-range')?.text ?? 'null') as { mode: 'full'; startChapter: number; endChapter: number } | null
  const small = { ...selection, operation: 'chapter-draft', authorInputs: [] }
  const base = newMainGenerationPolicy(small, f.model)
  const requests = Math.max(32, intent ? 2 * (intent.synopsisRange!.to - intent.synopsisRange!.from + 1) : planBlueprintGenerationCost(requestedRange!.endChapter - requestedRange!.startChapter + 1).recoveryCallBound)
  const policy = { ...base, budget: { ...base.budget, maxPhysicalRequests: requests,
    maxTokenLiability: base.budget.maxTokenLiability / base.budget.maxPhysicalRequests * requests, maxActiveElapsedMs: requests * 112500 },
    planning: intent ? { kind: 'architecture' as const, intent, outlineProtocol: PLOT_OUTLINE_PROTOCOL, outlineContent: PLOT_OUTLINE_CONTENT }
      : { kind: 'directory' as const, requestedRange: requestedRange! } }
  const binding = buildGenerationSourceBinding({ db: f.db, projectStorageRoot: path.join(f.root, 'project'), globalDataRoot: path.join(f.root, 'global'),
    readBuiltinPrompt: (key, language) => JSON.stringify(getBuiltinPromptTemplate(key, language)), readBuiltinSkill: readBuiltinWritingSkill },
  { ...selection, projectId: 'project', epoch: 'epoch-1', modelReceipt: safeGenerationModelReceipt(createModelExecutionLeaseReceipt(f.model, { leaseId: 'aggregate', createdAt: 0, expiresAt: 1 })), policy, outputContract: selection.output }).binding
  const saved = new GenerationRunRepository(() => f.db).open({ ...binding, operation: selection.operation, uiActionNonce: selection.uiActionNonce,
    frozenInputHash: textHash(JSON.stringify([binding.fingerprint, binding.contextSnapshotId, selection.output])), budget: policy.budget })
  return f.owner.read({ projectId: 'project', epoch: 'epoch-1', rootActionId: saved.rootActionId, runId: saved.runId })
}
async function frozenAggregateRun(f: ReturnType<typeof fixture>, selection: BeginGenerationRequest) {
  const run = openAggregateRun(f, selection)
  new GenerationRunRepository(() => f.db).pause(run.handle.rootActionId)
  return f.owner.resume(run.handle)
}

describe('chapter outline main authority', () => {
  it.each(['zero-attempt', 'unknown-attempt'] as const)('saves author recovery after %s and freezes the old run without changing its six binding fields or liabilities', async mode => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async () => ({ finishReason: null, usage: null }))
    const f = fixture(dispatch), run = f.owner.begin(outlineSelection(f, 3))
    const repository = new GenerationRunRepository(() => f.db), binding = structuredClone(repository.get(run.handle.runId).binding)
    const originalTask = outlineTask(f.owner.read(run.handle).plotOutline!)
    if (mode === 'zero-attempt') {
      await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'capacity-refused',
        task: { ...originalTask, messages: [{ role: 'user', content: `${'A'.repeat(40000)}\n${originalTask.messages[0].content}` }] } }))
        .rejects.toThrow('GENERATION_INPUT_CAPACITY_EXCEEDED')
    } else await f.owner.execute({ handle: run.handle, invocationNonce: 'unknown', task: originalTask })
    const context = f.owner.readContext(run.handle), originalRoot = f.db.prepare('SELECT * FROM generation_roots').all()
    const originalAttempts = f.db.prepare('SELECT * FROM generation_attempts').all()
    expect(originalAttempts).toHaveLength(mode === 'zero-attempt' ? 0 : 1)
    const payload: ProjectCoreSynopsisCommitRequest = {
      synopsis: renderPlotOutlineSynopsis(outlineEntry(1), 1, context.plotOutline!.sourceExpected), expected: context.plotOutline!.sourceExpected,
      authorRecovery: { sourceHandle: run.handle, leaseEpoch: context.plotOutlineRecovery!.leaseEpoch, operationId: `author-${mode}`, committedRange: { from: 1, to: 1 } },
    }
    const saved = f.db.transaction(() => f.owner.commitPlotOutlineAuthorEdit(payload)).immediate()
    expect(saved).toMatchObject({ kind: 'author-edit', remainingRange: { from: 2, to: 3 }, idempotent: false })
    expect(ProjectCoreRepository.get(f.db)!.synopsis).toBe(payload.synopsis)
    expect(repository.get(run.handle.runId).binding).toEqual(binding)
    const stored = JSON.parse(f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(run.handle.runId) as string)
    expect(Object.keys(stored).sort()).toEqual([...Object.keys(binding), '$runEffects'].sort())
    expect(stored.$runEffects).toEqual({ plotOutlineAuthorEdit: saved })
    expect(f.owner.read(run.handle).nonReplayable).toBe(true)
    expect(f.owner.readContext(run.handle).plotOutlineRecovery).toMatchObject({ draft: payload.synopsis, saved, writeState: { kind: 'blocked', reason: 'author-saved' } })
    await expect(f.owner.resume(run.handle)).rejects.toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'late', task: originalTask })).rejects.toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    expect(() => repository.resume(run.handle.runId, binding)).toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    expect(() => repository.replaceUnstartedBinding(run.handle.runId, binding, binding)).toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    expect(() => repository.reserve(run.handle.runId, 'late', textHash('late'), 100, 10)).toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    expect(() => f.owner.assertSynopsisCommit(run.handle, payload.synopsis, payload.expected)).toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    expect(() => f.owner.composeVisible(run.handle, [], textHash(''), PLOT_OUTLINE_PROTOCOL)).toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    expect(() => f.db.transaction(() => f.owner.commitPlotOutlineAuthorEdit({ ...payload, synopsis: payload.synopsis.replace('证词', '新证词') })).immediate())
      .toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_RECEIPT_CONFLICT')
    expect(f.db.prepare('SELECT * FROM generation_roots').all()).toEqual(originalRoot)
    expect(f.db.prepare('SELECT * FROM generation_attempts').all()).toEqual(originalAttempts)
    const reopened = f.reopen(), fresh = reopened.readContext(run.handle).plotOutlineRecovery!
    expect(fresh.sourceHandle).toEqual(run.handle)
    expect(fresh.leaseEpoch).not.toBe(run.handle.epoch)
    const repeated = { ...payload, authorRecovery: { ...payload.authorRecovery!, leaseEpoch: fresh.leaseEpoch } }
    expect(f.db.transaction(() => reopened.commitPlotOutlineAuthorEdit(repeated)).immediate()).toEqual({ ...saved, idempotent: true })
    expect(f.db.prepare('SELECT * FROM generation_roots').all()).toEqual(originalRoot)
    expect(f.db.prepare('SELECT * FROM generation_attempts').all()).toEqual(originalAttempts)
    f.db.prepare("UPDATE project_core SET synopsis='第三方新正文' WHERE id='main'").run()
    expect(() => f.db.transaction(() => reopened.commitPlotOutlineAuthorEdit(repeated)).immediate()).toThrow('GENERATION_SOURCE_CHANGED')
    expect(dispatch).toHaveBeenCalledTimes(mode === 'zero-attempt' ? 0 : 1)
  })

  it('keeps author recovery read-only while a physical request is in flight and preserves changed sources', async () => {
    let finish!: () => void
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async () => {
      await new Promise<void>(resolve => { finish = resolve })
      return { finishReason: null, usage: null }
    })
    const f = fixture(dispatch), run = f.owner.begin(outlineSelection(f, 1))
    const work = f.owner.execute({ handle: run.handle, invocationNonce: 'pending', task: outlineTask(f.owner.read(run.handle).plotOutline!) })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const context = f.owner.readContext(run.handle)
    const payload: ProjectCoreSynopsisCommitRequest = { synopsis: renderPlotOutlineSynopsis(outlineEntry(1), 1, context.plotOutline!.sourceExpected),
      expected: context.plotOutline!.sourceExpected, authorRecovery: { sourceHandle: run.handle, leaseEpoch: context.plotOutlineRecovery!.leaseEpoch,
        operationId: 'author-pending', committedRange: { from: 1, to: 1 } } }
    expect(context.plotOutlineRecovery!.writeState).toEqual({ kind: 'blocked', reason: 'in-flight' })
    expect(() => f.db.transaction(() => f.owner.commitPlotOutlineAuthorEdit(payload)).immediate()).toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_IN_FLIGHT')
    finish(); await work
    f.db.exec("UPDATE project_core SET premise='作者已修改前提' WHERE id='main'")
    expect(f.owner.readContext(run.handle).plotOutlineRecovery!.writeState).toEqual({ kind: 'blocked', reason: 'source-changed' })
    expect(() => f.db.transaction(() => f.owner.commitPlotOutlineAuthorEdit(payload)).immediate()).toThrow('GENERATION_SOURCE_CHANGED')
    expect(ProjectCoreRepository.get(f.db)!.synopsis).toBe('')
  })

  it('rolls back the formal author CAS if the same-transaction receipt cannot persist', () => {
    const f = fixture(), run = f.owner.begin(outlineSelection(f, 1)), context = f.owner.readContext(run.handle)
    const payload: ProjectCoreSynopsisCommitRequest = { synopsis: renderPlotOutlineSynopsis(outlineEntry(1), 1, context.plotOutline!.sourceExpected),
      expected: context.plotOutline!.sourceExpected, authorRecovery: { sourceHandle: run.handle, leaseEpoch: context.plotOutlineRecovery!.leaseEpoch,
        operationId: 'author-storage-failure', committedRange: { from: 1, to: 1 } } }
    const record = vi.spyOn(GenerationRunRepository.prototype, 'recordPlotOutlineAuthorEdit').mockImplementationOnce(() => { throw new Error('TEST_RECEIPT_STORAGE_FAILED') })
    try {
      expect(() => f.db.transaction(() => f.owner.commitPlotOutlineAuthorEdit(payload)).immediate()).toThrow('TEST_RECEIPT_STORAGE_FAILED')
      expect(ProjectCoreRepository.get(f.db)!.synopsis).toBe('')
      expect(new GenerationRunRepository(() => f.db).readPlotOutlineAuthorEdit(run.handle.runId)).toBeNull()
    } finally { record.mockRestore() }
  })

  it('stops after two actual LENGTH outcomes without another physical request', async () => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async () => ({ finishReason: 'length', usage: null }))
    const f = fixture(dispatch), run = f.owner.begin(outlineSelection(f, 1))
    for (const invocationNonce of ['normal', 'compact']) {
      await f.owner.execute({ handle: run.handle, invocationNonce, task: outlineTask(f.owner.read(run.handle).plotOutline!) })
    }
    expect(f.owner.read(run.handle).plotOutline!.cursor).toEqual({ kind: 'stopped', chapterNumber: 1, reason: 'attempts-exhausted' })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(new GenerationRunRepository(() => f.db).budget(run.handle.rootActionId).attempts).toHaveLength(2)
  })

  it.each(['normal', 'compact'] as const)('accepts a complete long %s STOP without losing its final fact', async accepted => {
    const text = `## 第1章：完整长章\n${'原事实。'.repeat(400)}尾部硬事实：归还钥匙。`
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      if (accepted === 'compact' && dispatch.mock.calls.length === 1) return { finishReason: 'length', usage: null }
      options.onVisible({ kind: 'delta', text })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch), run = f.owner.begin(outlineSelection(f, 1))
    for (let index = 0; index < (accepted === 'normal' ? 1 : 2); index++)
      await f.owner.execute({ handle: run.handle, invocationNonce: `long-${index}`, task: outlineTask(f.owner.read(run.handle).plotOutline!) })
    expect(f.owner.read(run.handle).plotOutline!.cursor).toMatchObject({ kind: 'accept', text })
    acceptOutline(f.owner, run.handle)
    expect(f.owner.readVisibleComposition(run.handle)!.text).toBe(text)
    expect(synopsisForDraftChapter(renderPlotOutlineSynopsis(text, 1, f.owner.read(run.handle).plotOutline!.sourceExpected), 1)).toContain('尾部硬事实：归还钥匙。')
    expect(dispatch).toHaveBeenCalledTimes(accepted === 'normal' ? 1 : 2)
  })

  it('reopens after normal LENGTH, accepts one compact chapter and preserves its original target', async () => {
    const requests: GenerationTask[] = []
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (request, options) => {
      requests.push((request as { task: GenerationTask }).task)
      options.onVisible({ kind: 'delta', text: outlineEntry(1) })
      return { finishReason: requests.length === 1 ? 'length' : 'stop', usage: null }
    })
    const f = fixture(dispatch), selection = outlineSelection(f, 1)
    selection.authorInputs!.push({ id: 'planning:target-units', text: '777' })
    const run = f.owner.begin(selection)
    await f.owner.execute({ handle: run.handle, invocationNonce: 'normal', task: outlineTask(run.plotOutline!) })
    const owner = f.reopen(), resumed = await owner.resume(run.handle)
    await owner.execute({ handle: resumed.handle, invocationNonce: 'compact', task: outlineTask(resumed.plotOutline!) })
    acceptOutline(owner, resumed.handle)
    expect(owner.readVisibleComposition(resumed.handle)!.text).toBe(outlineEntry(1))
    expect(owner.readContext(resumed.handle).plotOutline!.targetUnits).toBe(777)
    expect(requests.every(item => item.messages.some(message => message.role === 'system' && message.content.includes('777')))).toBe(true)
    expect(requests.map(item => item.purpose)).toEqual(['plot-outline:chapter:1:normal', 'plot-outline:chapter:1:compact'])
  })

  it.each(['normal', 'compact'] as const)('keeps an unknown %s candidate and does not automatically resend it', async unknownKind => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (request, options) => {
      const kind = (request as { task: GenerationTask }).task.purpose.split(':').at(-1)
      options.onVisible({ kind: 'delta', text: outlineEntry(1) })
      return { finishReason: kind === unknownKind ? null : 'length', usage: null }
    })
    const f = fixture(dispatch), run = f.owner.begin(outlineSelection(f, 1))
    let last = outlineTask(run.plotOutline!)
    for (let index = 0; index < (unknownKind === 'normal' ? 1 : 2); index++) {
      last = outlineTask(f.owner.read(run.handle).plotOutline!)
      await f.owner.execute({ handle: run.handle, invocationNonce: last.purpose, task: last })
    }
    const before = new GenerationRunRepository(() => f.db).budget(run.handle.rootActionId)
    const owner = f.reopen(), resumed = await owner.resume(run.handle)
    expect(resumed.plotOutline!.cursor).toEqual({ kind: 'stopped', chapterNumber: 1, reason: 'unknown-completion' })
    await expect(owner.execute({ handle: resumed.handle, invocationNonce: 'never-replay', task: last })).rejects.toThrow('GENERATION_DISPATCH_PLOT_OUTLINE_CURSOR')
    expect(new GenerationRunRepository(() => f.db).budget(run.handle.rootActionId).attempts).toEqual(before.attempts)
    expect(owner.readContext(resumed.handle).plotOutlineRecovery!.draft).toContain(outlineEntry(1))
    expect(dispatch).toHaveBeenCalledTimes(before.attempts.length)
  })

  it.each(['text', 'revision', 'run'] as const)('rejects changed whole-chapter artifact %s before composition', async changed => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: outlineEntry(1) }); return { finishReason: 'stop', usage: null } })
    const run = f.owner.begin(outlineSelection(f, 1))
    await f.owner.execute({ handle: run.handle, invocationNonce: 'normal', task: outlineTask(run.plotOutline!) })
    const cursor = f.owner.read(run.handle).plotOutline!.cursor
    if (cursor.kind !== 'accept') throw new Error('TEST_EXPECTED_OUTLINE_ACCEPT')
    const ids = cursor.artifactIds
    if (changed === 'text') f.db.prepare("UPDATE generation_artifacts SET artifact_json=json_set(artifact_json,'$.text','changed') WHERE artifact_id=?").run(ids[0])
    if (changed === 'revision') f.db.prepare('UPDATE generation_artifacts SET revision=revision+1 WHERE artifact_id=?').run(ids[0])
    if (changed === 'run') { const foreign = f.owner.begin({ ...f.begin, uiActionNonce: 'foreign' }); f.db.prepare('UPDATE generation_artifacts SET run_id=? WHERE artifact_id=?').run(foreign.handle.runId, ids[0]) }
    expect(() => f.owner.composeVisible(run.handle, ids, textHash(cursor.text), PLOT_OUTLINE_PROTOCOL)).toThrow(/ARTIFACT_INTEGRITY_FAILED|GENERATION_COMPOSITION_SOURCE_INVALID|GENERATION_PLOT_OUTLINE_ENTRY_INVALID/u)
  })

  it.each([10, 50, 200])('accepts exactly %i chapters through persisted artifacts across reopen including the old 32 artifact boundary', async chapters => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (request, options) => {
      const purpose = (request as { task: GenerationTask }).task.purpose
      const chapter = Number(purpose.split(':')[2])
      options.onVisible({ kind: 'delta', text: outlineEntry(chapter) })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    f.db.prepare('UPDATE project_core SET total_chapters=?').run(chapters)
    let owner = f.owner, run = await frozenAggregateRun(f, outlineSelection(f, chapters))
    const rootId = run.handle.rootActionId
    for (let chapter = 1; chapter <= chapters; chapter++) {
      const request = { handle: run.handle, invocationNonce: `normal-${chapter}`, task: outlineTask(owner.read(run.handle).plotOutline!) }
      const first = await owner.execute(request)
      expect(first.run.plotOutline!.cursor).toMatchObject({ kind: 'accept', chapterNumber: chapter })
      if (chapter === Math.min(chapters, 33)) {
        owner = f.reopen(); run = await owner.resume(run.handle)
        expect(owner.read(run.handle).plotOutline!.cursor).toMatchObject({ kind: 'accept', chapterNumber: chapter })
        expect((await owner.execute({ ...request, handle: run.handle })).outcome.content).toBe(outlineEntry(chapter))
      }
      acceptOutline(owner, run.handle)
    }
    owner = f.reopen(); run = await owner.resume(run.handle)
    const progress = owner.readContext(run.handle).plotOutline!
    expect(progress.cursor).toEqual({ kind: 'complete' })
    expect(progress.composition!.artifactIds).toHaveLength(chapters)
    expect(progress.composition!.text).toBe(Array.from({ length: chapters }, (_, index) => outlineEntry(index + 1)).join('\n\n'))
    const formal = renderPlotOutlineSynopsis(progress.composition!.text, chapters, progress.sourceExpected)
    for (let chapter = 1; chapter <= chapters; chapter++) {
      const selected = synopsisForDraftChapter(formal, chapter)
      expect(selected).toContain(outlineEntry(chapter))
      expect(selected.match(/^## 第\d+章/gmu)).toHaveLength(1)
    }
    expect(run.handle.rootActionId).toBe(rootId)
    expect(dispatch).toHaveBeenCalledTimes(chapters)
    const budget = new GenerationRunRepository(() => f.db).budget(rootId)
    expect(budget.attempts.every(attempt => attempt.status === 'unknown' && attempt.reservedTokens > 0)).toBe(true)
    expect(run.ledger!.tokenLiability).toBe(budget.attempts.reduce((sum, attempt) => sum + attempt.reservedTokens, 0))
    await expect(owner.execute({ handle: run.handle, invocationNonce: 'extra', task: { ...task, purpose: plotOutlinePurpose(chapters + 1, 'normal') } })).rejects.toThrow('GENERATION_DISPATCH_PLOT_OUTLINE_CURSOR')
  }, 120_000)

  it.each([
    { name: 'empty LENGTH', text: '', finishReason: 'length' },
    { name: 'long STOP', text: `第1章：题\n${'字'.repeat(1201)}`, finishReason: 'stop' },
    { name: 'mixed chapters', text: '第1章：题\n第一章正文。\nChapter 2: Extra\n额外正文。', finishReason: 'stop' },
    { name: 'chapter group', text: '第1–2章：组\n合并正文。', finishReason: 'stop' },
  ])('allows exactly one compact after $name and preserves the failed candidate', async failure => {
    let count = 0
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      const first = ++count === 1
      if (first ? failure.text : true) options.onVisible({ kind: 'delta', text: first ? failure.text : outlineEntry(1) })
      return { finishReason: first ? failure.finishReason : 'stop', usage: null }
    })
    const f = fixture(dispatch), run = f.owner.begin(outlineSelection(f, 1))
    const normal = outlineTask(run.plotOutline!)
    await f.owner.execute({ handle: run.handle, invocationNonce: 'normal', task: normal })
    const failed = f.owner.read(run.handle)
    const rowsBefore = f.db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    expect(failed.plotOutline!.cursor).toEqual({ kind: 'request', chapterNumber: 1, attempt: 'compact' })
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'new-normal', task: normal })).rejects.toThrow('GENERATION_DISPATCH_PLOT_OUTLINE_CURSOR')
    const owner = f.reopen(), resumed = await owner.resume(run.handle)
    const compact = outlineTask(resumed.plotOutline!)
    const result = await owner.execute({ handle: resumed.handle, invocationNonce: 'compact', task: compact })
    expect(result.run.plotOutline!.cursor.kind).toBe('accept')
    expect(compact.messages[0].content).not.toContain(failure.text || 'candidate-must-not-be-included')
    acceptOutline(owner, resumed.handle)
    expect(owner.readVisibleComposition(resumed.handle)?.text).toBe(outlineEntry(1))
    expect(f.db.prepare('SELECT * FROM generation_attempts ORDER BY rowid LIMIT 1').all()).toEqual(rowsBefore)
    expect(new GenerationRunRepository(() => f.db).budget(run.handle.rootActionId).attempts).toHaveLength(2)
    await expect(owner.execute({ handle: resumed.handle, invocationNonce: 'another-compact', task: compact })).rejects.toThrow('GENERATION_DISPATCH_PLOT_OUTLINE_CURSOR')
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('refuses concurrent nonces and preserves a dispatched compact as unknown after actual close/reopen', async () => {
    let started!: () => void
    const dispatched = new Promise<void>(resolve => { started = resolve })
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      if (dispatch.mock.calls.length === 1) return { finishReason: 'length', usage: null }
      options.onVisible({ kind: 'delta', text: '第1章：尚未确定\n片段' })
      started()
      return new Promise(() => {})
    })
    const f = fixture(dispatch), run = f.owner.begin(outlineSelection(f, 1))
    await f.owner.execute({ handle: run.handle, invocationNonce: 'normal', task: outlineTask(run.plotOutline!) })
    const compact = outlineTask(f.owner.read(run.handle).plotOutline!)
    const request = { handle: run.handle, invocationNonce: 'compact', task: compact }
    const pending = f.owner.execute(request).catch(error => error)
    const sameNonce = f.owner.execute(request).catch(error => error)
    await dispatched
    await expect(f.owner.execute({ ...request, invocationNonce: 'concurrent-compact' })).rejects.toThrow('GENERATION_DISPATCH_PLOT_OUTLINE_CURSOR')
    const owner = f.reopen()
    await Promise.all([pending, sameNonce])
    const restored = await owner.resume(run.handle)
    expect(restored.plotOutline!.cursor).toEqual({ kind: 'stopped', chapterNumber: 1, reason: 'unknown-completion' })
    expect(restored.ledger!.physicalRequests).toBe(2)
    expect(restored.ledger!.tokenLiability).toBeGreaterThan(0)
    await expect(owner.execute({ ...request, handle: restored.handle, invocationNonce: 'post-restart' })).rejects.toThrow('GENERATION_DISPATCH_PLOT_OUTLINE_CURSOR')
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('rejects wrong chapter, prefix substitution, forged origin and a second child before dispatch', async () => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>()
    const f = fixture(dispatch), selection = outlineSelection(f, 2), run = f.owner.begin(selection)
    const correct = outlineTask(run.plotOutline!)
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'wrong-chapter', task: { ...correct, purpose: plotOutlinePurpose(2, 'normal') } })).rejects.toThrow('GENERATION_DISPATCH_PLOT_OUTLINE_CURSOR')
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'wrong-prefix', task: { ...correct, messages: [{ role: 'user', content: '替换前缀' }] } })).rejects.toThrow('GENERATION_DISPATCH_PLOT_OUTLINE_CURSOR')
    expect(() => f.owner.begin({ ...selection, uiActionNonce: 'second-child', parentRootActionId: run.handle.rootActionId })).toThrow('GENERATION_PLOT_OUTLINE_RECOVERY_REQUIRED')
    expect(() => f.owner.begin({ ...selection, uiActionNonce: 'forged', plotOutlineSource: { version: 1, core: {} } } as BeginGenerationRequest)).toThrow()
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(1)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('explicit planning recovery with real SQLite', () => {
  const blueprint = (chapterNumber: number, keyEvents = '作者补齐了完整行动、冲突与结果。') => ({ chapterNumber, title: `完整第${chapterNumber}章`, role: '转折',
    purpose: '确认线索', keyEvents, characters: ['林岚'], relationshipHints: [], newCharacterCandidates: [], suspenseHook: '下一步核验证据。', userGuidance: '', notes: '', notesUpdatedAt: '' })
  const directorySelection = (f: ReturnType<typeof fixture>, from = 1, to = 3): BeginGenerationRequest => ({
    operation: 'chapter-blueprint-directory', uiActionNonce: 'blueprint-action', modelId: f.model.id,
    selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [1, 2, 3],
    promptKeys: ['chapter_blueprint_chunk'], skillStages: ['planning'], output: 'structured-data', authorInputs: [
      { id: 'planning:target-units', text: '700' }, { id: 'directory:pacing-guidance', text: '先核实证据。' },
      { id: 'directory:author-config', text: '{"totalChapters":3}' },
      { id: 'directory:requested-range', text: JSON.stringify({ mode: from === 1 ? 'full' : 'append', startChapter: from, endChapter: to }) },
    ],
  })
  it('continues a zero-prefix double LENGTH only as one explicit new action and permanently closes old writes', async () => {
    const raw = '## 第1章：未完成\n候选原文还未写完'
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: raw }); return { finishReason: 'length', usage: null }
    })
    const f = fixture(dispatch), run = f.owner.begin(outlineSelection(f, 3))
    for (const nonce of ['normal', 'compact']) await f.owner.execute({ handle: run.handle, invocationNonce: nonce, task: outlineTask(f.owner.read(run.handle).plotOutline!) })
    const attempts = f.db.prepare('SELECT * FROM generation_attempts').all()
    expect(f.owner.readContext(run.handle)).toMatchObject({ plotOutlineRecovery: { draft: expect.stringContaining(raw) }, planningContinuation: { state: 'ready', remainingRange: { from: 1, to: 3 }, targetUnits: 600 } })
    const nextInput = { ...outlineSelection(f, 3), uiActionNonce: 'explicit-next' }
    const next = f.owner.restart(run.handle, nextInput)
    expect(next.handle.rootActionId).not.toBe(run.handle.rootActionId)
    expect(f.owner.restart(run.handle, { ...nextInput, uiActionNonce: 'same-confirmation-again' }).handle).toEqual(next.handle)
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(2)
    expect(f.db.prepare('SELECT * FROM generation_attempts').all()).toEqual(attempts)
    expect(ProjectCoreRepository.get(f.db)!.synopsis).toBe('')
    expect(dispatch).toHaveBeenCalledTimes(2)
    await expect(f.owner.resume(run.handle)).rejects.toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'late', task: { ...task, purpose: 'plot-outline:chapter:1:normal' } })).rejects.toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    const repository = new GenerationRunRepository(() => f.db), binding = repository.get(run.handle.runId).binding
    expect(() => repository.replaceUnstartedBinding(run.handle.runId, binding, binding)).toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    expect(() => repository.reserve(run.handle.runId, 'late', textHash('late'), 100, 10)).toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    const owner = f.reopen()
    expect(owner.readContext(run.handle).planningContinuation).toMatchObject({ state: 'continued', nextHandle: next.handle })
    expect(owner.restart(run.handle, nextInput).handle).toEqual(next.handle)
  })
  it('saves the accepted outline prefix without cost and authorizes only the remaining chapters', async () => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (request, options) => {
      const chapter = Number((request as { task: GenerationTask }).task.purpose.split(':')[2])
      options.onVisible({ kind: 'delta', text: outlineEntry(chapter) }); return { finishReason: chapter === 1 ? 'stop' : 'length', usage: null }
    })
    const f = fixture(dispatch), run = f.owner.begin(outlineSelection(f, 3))
    await f.owner.execute({ handle: run.handle, invocationNonce: 'one', task: outlineTask(run.plotOutline!) }); acceptOutline(f.owner, run.handle)
    for (const nonce of ['normal-two', 'compact-two']) await f.owner.execute({ handle: run.handle, invocationNonce: nonce, task: outlineTask(f.owner.read(run.handle).plotOutline!) })
    expect(f.owner.readContext(run.handle).planningContinuation?.state).toBe('save-prefix')
    expect(() => f.owner.restart(run.handle, { ...outlineSelection(f, 3), uiActionNonce: 'not-yet' })).toThrow('GENERATION_PLANNING_CONTINUATION_SAVE_PREFIX')
    const context = f.owner.readContext(run.handle), outline = context.plotOutline!
    const payload: ProjectCoreSynopsisCommitRequest = { synopsis: renderPlotOutlineRange(outlineEntry(1), { from: 1, to: 1 }, outline.sourceExpected), expected: outline.sourceExpected,
      authorRecovery: { sourceHandle: run.handle, leaseEpoch: context.plotOutlineRecovery!.leaseEpoch, operationId: 'author-prefix', committedRange: { from: 1, to: 1 } } }
    f.db.transaction(() => f.owner.commitPlotOutlineAuthorEdit(payload)).immediate()
    const remaining = { ...outlineSelection(f, 3, 2), uiActionNonce: 'only-missing' }
    expect(() => f.owner.restart(run.handle, { ...remaining, ...outlineSelection(f, 3), uiActionNonce: 'wrong-range' })).toThrow('GENERATION_PLANNING_CONTINUATION_RANGE_CHANGED')
    const next = f.owner.restart(run.handle, remaining)
    expect(next.plotOutline?.range).toEqual({ from: 2, to: 3 })
    expect(next.plotOutline?.confirmedPrefix).toBe(outlineEntry(1))
    expect(dispatch).toHaveBeenCalledTimes(3)
  })
  it('rejects explicit continuation while in flight or after a source change without creating a replacement', async () => {
    let release!: () => void
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async () => {
      await new Promise<void>(resolve => { release = resolve }); return { finishReason: null, usage: null }
    })
    const f = fixture(dispatch), run = f.owner.begin(outlineSelection(f, 1))
    const work = f.owner.execute({ handle: run.handle, invocationNonce: 'pending', task: outlineTask(run.plotOutline!) })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const next = { ...outlineSelection(f, 1), uiActionNonce: 'explicit-next' }
    expect(() => f.owner.restart(run.handle, next)).toThrow('GENERATION_PLANNING_CONTINUATION_IN_FLIGHT')
    release(); await work
    f.db.prepare("UPDATE project_core SET premise='作者新前提'").run()
    expect(() => f.owner.restart(run.handle, next)).toThrow('GENERATION_PLANNING_CONTINUATION_SOURCE_CHANGED')
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
  })
  it('preserves the source tail byte for byte when an author repairs an earlier outline chapter', () => {
    const f = fixture(), original = '# 情节大纲\n\n## 第1章：原一\n原文一。\n\n## 第2章：原二\n原文二。\n\n## 第3章：保留\n尾部事实与空格。  \n'
    f.db.prepare('UPDATE project_core SET synopsis=?,total_chapters=3').run(original)
    const run = f.owner.begin(outlineSelection(f, 2)), context = f.owner.readContext(run.handle), range = { from: 1, to: 1 }
    const synopsis = renderPlotOutlineRange(outlineEntry(1), range, context.plotOutline!.sourceExpected)
    const payload: ProjectCoreSynopsisCommitRequest = { synopsis, expected: context.plotOutline!.sourceExpected,
      authorRecovery: { sourceHandle: run.handle, leaseEpoch: context.plotOutlineRecovery!.leaseEpoch, operationId: 'replace-prefix', committedRange: range } }
    f.db.transaction(() => f.owner.commitPlotOutlineAuthorEdit(payload)).immediate()
    expect(ProjectCoreRepository.get(f.db)!.synopsis.slice(synopsis.indexOf('## 第2章'))).toBe(original.slice(original.indexOf('## 第2章')))
  })
  it('allows a corrected zero-prefix blueprint candidate to be saved at no model cost, preserves other rows, and continues missing chapters', async () => {
    const raw = '{"blueprints":[{"chapterNumber":1,"title":"未完'
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => { options.onVisible({ kind: 'delta', text: raw }); return { finishReason: 'length', usage: null } })
    const f = fixture(dispatch), run = f.owner.begin(directorySelection(f))
    BlueprintRepository.upsert(blueprint(8, '范围外作者原文。'))
    await f.owner.execute({ handle: run.handle, invocationNonce: 'failed', task: { ...task, purpose: 'chapter-blueprint-directory', output: 'structured-data' } })
    const context = f.owner.readContext(run.handle)
    expect(context.blueprintRecovery).toMatchObject({ draft: raw, editRange: { from: 1, to: 3 }, writeState: 'ready' })
    const before = f.db.prepare('SELECT * FROM generation_attempts').all(), outside = BlueprintRepository.getAll().find(item => item.chapterNumber === 8)
    const characters = Array.from({ length: 13 }, (_, index) => `角色${index}`)
    const repaired = { ...blueprint(1), title: '标题'.repeat(100), role: '角色作用'.repeat(100), purpose: '章节目的'.repeat(200),
      keyEvents: '完整叙述。'.repeat(280) + '尾部必须保留。', suspenseHook: '悬念'.repeat(200), characters,
      relationshipHints: characters.slice(1, 10).map(to => ({ from: characters[0], to, relation: '同行' })),
      newCharacterCandidates: characters.map(name => ({ name, role: 'supporting' as const })),
      userGuidance: '  作者指导保留原字节。\r\n', notes: '<think>作者备注中的原文标签</think>\n第二行。', notesUpdatedAt: '2026-10-04T13:00:00.000Z' }
    const request: BlueprintRangeCommitRequest = { mode: 'replace-range', operationId: 'author-blueprint', startChapter: 1, endChapter: 1,
      blueprints: parseTextBlueprintsStrict(JSON.stringify([repaired]), 1, 1, 'author'), authorRecovery: { sourceHandle: run.handle, leaseEpoch: context.blueprintRecovery!.leaseEpoch } }
    const save = () => f.db.transaction(() => f.owner.commitBlueprintAuthorEdit(request)).immediate()
    const saved = save()
    expect(saved.authorEdit).toMatchObject({ committedRange: { from: 1, to: 1 }, remainingRange: { from: 2, to: 3 } })
    expect(save().idempotent).toBe(true)
    const { relationshipHints, newCharacterCandidates, ...rowFields } = repaired
    expect(BlueprintRepository.getAll().find(item => item.chapterNumber === 1)).toMatchObject(rowFields)
    expect(BlueprintRepository.getCommittedRangeOperation(request.operationId)?.snapshot[0]).toMatchObject(repaired)
    expect(BlueprintRepository.getCharacterSyncOperation(saved.characterSyncOperation.operationId)?.characterSyncInput[0]).toMatchObject({ relationshipHints, newCharacterCandidates })
    expect(BlueprintRepository.getAll().find(item => item.chapterNumber === 8)).toEqual(outside)
    expect(f.db.prepare('SELECT * FROM generation_attempts').all()).toEqual(before)
    expect(dispatch).toHaveBeenCalledTimes(1)
    await expect(f.owner.resume(run.handle)).rejects.toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    const replacement = f.owner.restart(run.handle, { ...directorySelection(f, 2), uiActionNonce: 'blueprint-missing' })
    expect(replacement.handle.rootActionId).not.toBe(run.handle.rootActionId)
    expect(f.owner.readContext(replacement.handle).planningContinuation).toMatchObject({ remainingRange: { from: 2, to: 3 }, targetUnits: 700 })
    expect(f.owner.readContext(run.handle).blueprintRecovery!.draft).toBe(raw)
  })
  it.each(['directory-progress', 'author-saved'] as const)('rejects blueprint recovery writes when rebuilding sources fails after %s', async prefixKind => {
    const raw = '{"blueprints":[{"chapterNumber":2,"title":"未完'
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>()
      .mockImplementationOnce(async (_request, options) => { options.onVisible({ kind: 'delta', text: JSON.stringify([blueprint(1)]) }); return { finishReason: 'stop', usage: null } })
      .mockImplementationOnce(async (_request, options) => { options.onVisible({ kind: 'delta', text: raw }); return { finishReason: 'length', usage: null } })
    const f = fixture(dispatch), run = f.owner.begin(directorySelection(f))
    const execute = (invocationNonce: string) => f.owner.execute({ handle: run.handle, invocationNonce,
      task: { ...task, purpose: 'chapter-blueprint-directory', output: 'structured-data' } })
    const prefix: BlueprintRangeCommitRequest = { mode: 'replace-range', operationId: 'valid-prefix', startChapter: 1, endChapter: 1,
      blueprints: [blueprint(1)] }
    await execute('complete-prefix')
    await execute('incomplete-next')
    if (prefixKind === 'directory-progress') f.db.transaction(() => {
      const range = { startChapter: 1, endChapter: 3 }
      const receipt = BlueprintRepository.commitRange(prefix, () => f.owner.assertSourcesCurrent(run.handle, range))
      f.owner.recordDirectoryCommit(run.handle, range, receipt)
    }).immediate()
    const authorRecovery = { sourceHandle: run.handle, leaseEpoch: f.owner.readContext(run.handle).blueprintRecovery!.leaseEpoch }
    const savedPrefix = { ...prefix, authorRecovery }
    if (prefixKind === 'author-saved') f.db.transaction(() => f.owner.commitBlueprintAuthorEdit(savedPrefix)).immediate()
    expect(f.owner.readContext(run.handle).planningContinuation).toMatchObject({ state: 'ready', remainingRange: { from: 2, to: 3 } })
    expect(BlueprintRepository.getAll().find(item => item.chapterNumber === 1)?.keyEvents).toBe(blueprint(1).keyEvents)
    const request = prefixKind === 'author-saved' ? savedPrefix : { ...prefix, authorRecovery, operationId: 'repair-next',
      startChapter: 2, endChapter: 2, blueprints: [blueprint(2)] }
    const save = () => f.db.transaction(() => f.owner.commitBlueprintAuthorEdit(request)).immediate()
    const rows = BlueprintRepository.getAll(), operations = f.db.prepare('SELECT * FROM blueprint_commit_operations').all()
    const attempts = f.db.prepare('SELECT * FROM generation_attempts').all(), runs = f.db.prepare('SELECT * FROM generation_runs').all()
    const writingSkillsPath = path.join(f.root, 'project', 'writing-skills.json')
    fs.writeFileSync(writingSkillsPath, JSON.stringify({ version: 2, bindings: {} }))
    const context = f.owner.readContext(run.handle)
    expect.soft(context.planningContinuation).toMatchObject({ state: 'source-changed', remainingRange: { from: 2, to: 3 } })
    expect.soft(context.blueprintRecovery).toMatchObject({ draft: raw, editRange: { from: 2, to: 3 },
      writeState: prefixKind === 'author-saved' ? 'author-saved' : 'source-changed' })
    expect.soft(() => f.owner.restart(run.handle, { ...directorySelection(f, 2), uiActionNonce: 'blocked-next' }))
      .toThrow('GENERATION_PLANNING_CONTINUATION_SOURCE_CHANGED')
    expect.soft(save).toThrow(prefixKind === 'author-saved' ? 'GENERATION_SOURCE_CHANGED' : 'GENERATION_BLUEPRINT_AUTHOR_SOURCE_CHANGED')
    expect.soft(BlueprintRepository.getAll()).toEqual(rows)
    expect.soft(f.db.prepare('SELECT * FROM blueprint_commit_operations').all()).toEqual(operations)
    expect.soft(f.db.prepare('SELECT * FROM generation_runs').all()).toEqual(runs)
    expect.soft(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
    expect.soft(f.db.prepare('SELECT * FROM generation_attempts').all()).toEqual(attempts)
    fs.unlinkSync(writingSkillsPath)
    expect(save().idempotent).toBe(prefixKind === 'author-saved')
    expect(save().idempotent).toBe(true)
    expect(f.db.prepare('SELECT * FROM generation_attempts').all()).toEqual(attempts)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
  it('rolls back corrected blueprints if the author receipt cannot persist and rejects malformed identities', () => {
    const f = fixture(), run = f.owner.begin(directorySelection(f)), context = f.owner.readContext(run.handle)
    const request: BlueprintRangeCommitRequest = { mode: 'replace-range', operationId: 'author-atomic', startChapter: 1, endChapter: 1,
      blueprints: [blueprint(1)], authorRecovery: { sourceHandle: run.handle, leaseEpoch: context.blueprintRecovery!.leaseEpoch } }
    const before = BlueprintRepository.getAll()
    expect(() => f.db.transaction(() => f.owner.commitBlueprintAuthorEdit({ ...request, blueprints: [{ ...blueprint(1), characters: ['林岚', '林岚'] }] })).immediate()).toThrow()
    const write = vi.spyOn(GenerationRunRepository.prototype, 'recordBlueprintAuthorEdit').mockImplementationOnce(() => { throw new Error('TEST_RECEIPT_STORAGE_FAILED') })
    try { expect(() => f.db.transaction(() => f.owner.commitBlueprintAuthorEdit(request)).immediate()).toThrow('TEST_RECEIPT_STORAGE_FAILED') }
    finally { write.mockRestore() }
    expect(BlueprintRepository.getAll()).toEqual(before)
    expect(f.db.prepare('SELECT COUNT(*) FROM blueprint_commit_operations').pluck().get()).toBe(0)
  })
})

describe('frozen planning roots', () => {
  const fullIntent: ArchitecturePlanningIntent = { version: 'architecture-action-v1',
    priorSteps: ['premise', 'characters', 'worldbuilding'], synopsisRange: { from: 1, to: 10 } }
  function planningFixture() {
    const f = fixture()
    f.db.prepare('UPDATE project_core SET total_chapters=200').run()
    Object.assign(f.model, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash',
      maxTokens: 65536, reasoningOverride: 'high',
      capabilities: { contextWindowTokens: 262144, maxOutputTokens: 65536, reasoning: true, structuredOutput: true, usage: true },
    } satisfies Partial<ModelProfile>)
    return f
  }
  const architectureSelection = (f: ReturnType<typeof fixture>, intent: ArchitecturePlanningIntent, operation = 'generate-core-seed'): BeginGenerationRequest => ({
    operation, uiActionNonce: operation, modelId: f.model.id, selectedDraftIds: [], selectedFinalizedDraftIds: [],
    promptKeys: [operation === 'generate-plot-outline' ? 'synopsis' : 'premise'], skillStages: ['planning'], output: 'visible-text',
    authorInputs: [{ id: 'architecture:author-config', text: '{"totalChapters":200}' },
      { id: 'architecture:planning-intent', text: JSON.stringify(intent) }],
  })
  const directorySelection = (f: ReturnType<typeof fixture>, chapters: number): BeginGenerationRequest => ({
    operation: 'chapter-blueprint-directory', uiActionNonce: 'directory', modelId: f.model.id, selectedDraftIds: [], selectedFinalizedDraftIds: [],
    selectedBlueprintChapterNumbers: Array.from({ length: chapters }, (_, index) => index + 1),
    promptKeys: ['chapter_blueprint_chunk'], skillStages: ['planning'], output: 'structured-data',
    authorInputs: [{ id: 'directory:pacing-guidance', text: '' },
      { id: 'directory:author-config', text: JSON.stringify({ totalChapters: chapters }) },
      { id: 'directory:requested-range', text: JSON.stringify({ mode: 'full', startChapter: 1, endChapter: chapters }) }],
  })
  const plotTask: GenerationTask = { purpose: 'generate-plot-outline', output: 'visible-text', reasoningStage: 'planning', messages: [{ role: 'user', content: 'x' }] }
  async function legacyPlanningRun(f: ReturnType<typeof fixture>, intent: ArchitecturePlanningIntent) {
    const selection = architectureSelection(f, intent, 'generate-plot-outline')
    const current = { ...MAIN_GENERATION_POLICY, version: 's07-planning-v1' as const, budget: { ...MAIN_GENERATION_POLICY.budget, maxOutputPerRequest: 65536 } }
    const requests = Math.max(32, 2 * (intent.synopsisRange!.to - intent.synopsisRange!.from + 1))
    const policy = { ...current, budget: { ...current.budget, maxPhysicalRequests: requests, maxTokenLiability: requests * 65536,
      maxActiveElapsedMs: requests * 112500 }, planning: { kind: 'architecture' as const, intent, outlineProtocol: 'legacy-range-v1' as const } }
    const binding = buildGenerationSourceBinding({ db: f.db, projectStorageRoot: path.join(f.root, 'project'), globalDataRoot: path.join(f.root, 'global'),
      readBuiltinPrompt: (key, language) => JSON.stringify(getBuiltinPromptTemplate(key, language)), readBuiltinSkill: readBuiltinWritingSkill },
    { ...selection, projectId: 'project', epoch: 'epoch-1', modelReceipt: safeGenerationModelReceipt(createModelExecutionLeaseReceipt(f.model, { leaseId: 'legacy', createdAt: 0, expiresAt: 1 })),
      policy, outputContract: 'visible-text' }).binding
    const saved = new GenerationRunRepository(() => f.db).open({ ...binding, operation: selection.operation, uiActionNonce: selection.uiActionNonce,
      frozenInputHash: textHash(JSON.stringify([binding.fingerprint, binding.contextSnapshotId, selection.output])), budget: policy.budget })
    new GenerationRunRepository(() => f.db).pause(saved.rootActionId)
    return f.owner.resume({ projectId: 'project', epoch: 'epoch-1', rootActionId: saved.rootActionId, runId: saved.runId })
  }

  it('freezes the complete architecture on premise, shares liability with synopsis, and restores its exact chapter policy', async () => {
    const fetch = syntheticStream(), f = planningFixture()
    const root = f.owner.begin(architectureSelection(f, fullIntent))
    expect(root.ledger!.policy).toEqual({ maxPhysicalRequests: 40, maxTokenLiability: 10485760, maxOutputPerRequest: 65536, maxActiveElapsedMs: 4500000 })
    const repository = new GenerationRunRepository(() => f.db)
    const policy = repository.get(root.handle.runId).binding.sourceManifest.policy
    expect(policy).toMatchObject({ version: 's07-capacity-v2', planning: { kind: 'architecture', intent: fullIntent, outlineProtocol: PLOT_OUTLINE_PROTOCOL }, budget: root.ledger!.policy })
    await f.owner.execute({ handle: root.handle, invocationNonce: 'premise', task: { ...plotTask, purpose: 'generate-core-seed' } })
    const childSelection = { ...architectureSelection(f, fullIntent, 'generate-plot-outline'), parentRootActionId: root.handle.rootActionId }
    expect(() => f.owner.begin({ ...childSelection, ...architectureSelection(f, { ...fullIntent, synopsisRange: { from: 1, to: 9 } }, 'generate-plot-outline') }))
      .toThrow('GENERATION_PLANNING_INTENT_CHANGED')
    expect(() => f.owner.begin({ ...childSelection, operation: 'chapter-blueprint-directory' })).toThrow('GENERATION_PLANNING_INTENT_INVALID')
    const child = f.owner.begin(childSelection)
    expect(child.handle.rootActionId).toBe(root.handle.rootActionId)
    expect(repository.get(child.handle.runId).binding.sourceManifest.policy).toEqual(policy)
    expect(child.ledger).toMatchObject({ tokenLiability: 62, physicalRequests: 1 })
    const reopened = f.reopen(), resumed = await reopened.resume(child.handle)
    expect(resumed.ledger!.policy).toEqual(root.ledger!.policy)
    await reopened.execute({ handle: resumed.handle, invocationNonce: 'synopsis', task: outlineTask(resumed.plotOutline!) })
    expect(fetch.mock.calls.map(call => JSON.parse(String(call[1].body)).max_tokens)).toEqual([65536, 65536])
    expect(new GenerationRunRepository(() => f.db).get(child.handle.runId).binding.sourceManifest.policy).toEqual(policy)
    expect(reopened.read(resumed.handle).ledger).toMatchObject({ tokenLiability: 124, physicalRequests: 2 })
  })

  it('freezes selected subsets and refuses an unselected child or invalid range before creating a run', () => {
    const f = planningFixture()
    const intent: ArchitecturePlanningIntent = { version: 'architecture-action-v1', priorSteps: ['worldbuilding'], synopsisRange: { from: 151, to: 160 } }
    const root = f.owner.begin(architectureSelection(f, intent, 'generate-world-building'))
    expect(root.ledger!.policy.maxPhysicalRequests).toBe(32)
    expect(() => f.owner.begin({ ...architectureSelection(f, intent), parentRootActionId: root.handle.rootActionId })).toThrow('GENERATION_PLANNING_OPERATION_NOT_SELECTED')
    for (const invalid of [
      { ...fullIntent, priorSteps: ['characters', 'characters'] },
      { ...fullIntent, synopsisRange: { from: 1, to: 201 } },
      { ...fullIntent, synopsisRange: { from: 1, to: Number.MAX_SAFE_INTEGER + 1 } },
    ]) {
      const request = architectureSelection(f, fullIntent)
      request.authorInputs![1].text = JSON.stringify(invalid)
      expect(() => f.owner.begin(request)).toThrow('GENERATION_PLANNING_INTENT_INVALID')
    }
    const overflow = architectureSelection(f, { ...fullIntent, synopsisRange: { from: 1, to: Number.MAX_SAFE_INTEGER } })
    overflow.authorInputs![0].text = JSON.stringify({ totalChapters: Number.MAX_SAFE_INTEGER })
    expect(() => f.owner.begin(overflow)).toThrow('GENERATION_PLANNING_RANGE_INVALID')
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(1)
  })

  it('refuses unknown saved policies and a root ledger that disagrees with its frozen planning budget', async () => {
    const fetch = syntheticStream(), f = planningFixture()
    const run = f.owner.begin(architectureSelection(f, fullIntent))
    const bindingJson = f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(run.handle.runId)
    f.db.prepare("UPDATE generation_runs SET binding_json=json_set(binding_json,'$.sourceManifest.policy.version','future-policy') WHERE run_id=?").run(run.handle.runId)
    await expect(f.owner.resume(run.handle)).rejects.toThrow('GENERATION_POLICY_UNSUPPORTED')
    f.db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(bindingJson, run.handle.runId)
    f.db.prepare("UPDATE generation_roots SET budget_json=json_set(budget_json,'$.maxPhysicalRequests',221) WHERE root_action_id=?").run(run.handle.rootActionId)
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'mismatch', task: plotTask })).rejects.toThrow('GENERATION_POLICY_BUDGET_MISMATCH')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('dispatches 40 normal directory requests for a 200 chapter scope across a real reopen under one finite root', async () => {
    const fetch = syntheticStream(), f = planningFixture()
    let owner = f.owner, run = await frozenAggregateRun(f, directorySelection(f, 200))
    const original = run.handle.rootActionId
    expect(run.ledger!.policy).toEqual({ maxPhysicalRequests: 561, maxTokenLiability: 147062784, maxOutputPerRequest: 65536, maxActiveElapsedMs: 63112500 })
    for (let batch = 0; batch < 40; batch++) {
      if (batch === 20) { owner = f.reopen(); run = await owner.resume(run.handle) }
      const result = await owner.execute({ handle: run.handle, invocationNonce: `batch-${batch}`, task: {
        purpose: 'chapter-blueprint-directory', output: 'structured-data', reasoningStage: 'planning',
        messages: [{ role: 'user', content: `Chapters ${batch * 5 + 1}-${batch * 5 + 5}` }],
        budgetDemand: { kind: 'structured-items', writingLanguage: 'zh-CN', requestedItems: 5 },
      } })
      expect(result.outcome.status).toBe('completed')
    }
    const budget = new GenerationRunRepository(() => f.db).budget(original)
    expect(fetch).toHaveBeenCalledTimes(40)
    expect(budget.attempts).toHaveLength(40)
    expect(budget.attempts.every(attempt => attempt.status === 'settled' && attempt.requestedOutputTokens === 65536)).toBe(true)
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
  })

  it.each([
    { name: '64K user', changes: {}, expected: 65536 },
    { name: 'user', changes: { maxTokens: 16384 }, expected: 16384 },
    { name: 'provider', changes: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', modelName: 'gpt-4.1' }, expected: 32768 },
    { name: 'context', changes: { capabilities: { contextWindowTokens: 4096, maxOutputTokens: 65536, reasoning: true, structuredOutput: true, usage: true } }, expected: 3515 },
  ] satisfies { name: string; changes: Partial<ModelProfile>; expected: number }[])('honors the $name bound on a standalone plot wire', async ({ changes, expected }) => {
    const fetch = syntheticStream(), f = planningFixture()
    Object.assign(f.model, changes)
    const intent: ArchitecturePlanningIntent = { version: 'architecture-action-v1', priorSteps: [], synopsisRange: { from: 11, to: 60 } }
    const run = await legacyPlanningRun(f, intent)
    expect(run.ledger!.policy.maxPhysicalRequests).toBe(100)
    await f.owner.execute({ handle: run.handle, invocationNonce: 'plot', task: plotTask })
    const wire = JSON.parse(String(fetch.mock.calls[0]![1].body))
    expect(wire.max_completion_tokens ?? wire.max_tokens).toBe(expected)
  })

  it('retains unknown usage liability and narrows the last request before the shared root is exhausted', async () => {
    const fetch = syntheticStream(false), f = planningFixture()
    Object.assign(f.model, { provider: 'openai', baseUrl: 'https://compatible.example/v1', modelName: 'custom-model', reasoningOverride: 'auto' })
    const run = await legacyPlanningRun(f, { version: 'architecture-action-v1', priorSteps: [], synopsisRange: { from: 1, to: 1 } })
    for (let request = 0; request < 32; request++) await f.owner.execute({ handle: run.handle, invocationNonce: `unknown-${request}`, task: plotTask })
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body)).max_tokens).toBe(65536)
    expect(JSON.parse(String(fetch.mock.calls[31]![1].body)).max_tokens).toBe(46944)
    const budget = new GenerationRunRepository(() => f.db).budget(run.handle.rootActionId)
    expect(budget.attempts.every(attempt => attempt.status === 'unknown')).toBe(true)
    await expect(f.owner.execute({ handle: run.handle, invocationNonce: 'exhausted', task: plotTask })).rejects.toThrow('ROOT_BUDGET_EXHAUSTED')
    expect(fetch).toHaveBeenCalledTimes(32)
  })

  it('resumes a pre-planning root and its child at the original 32K cap without upgrading its manifest', async () => {
    const fetch = syntheticStream(), f = planningFixture(), selection = architectureSelection(f, fullIntent, 'generate-plot-outline')
    selection.authorInputs = selection.authorInputs!.filter(input => input.id !== 'architecture:planning-intent')
    const binding = buildGenerationSourceBinding({ db: f.db, projectStorageRoot: path.join(f.root, 'project'), globalDataRoot: path.join(f.root, 'global'),
      readBuiltinPrompt: (key, language) => JSON.stringify(getBuiltinPromptTemplate(key, language)), readBuiltinSkill: readBuiltinWritingSkill },
    { ...selection, projectId: 'project', epoch: 'epoch-1', modelReceipt: safeGenerationModelReceipt(createModelExecutionLeaseReceipt(f.model, { leaseId: 'legacy', createdAt: 0, expiresAt: 1 })),
      policy: MAIN_GENERATION_POLICY, outputContract: 'visible-text' }).binding
    const legacy = new GenerationRunRepository(() => f.db).open({ ...binding, operation: selection.operation, uiActionNonce: selection.uiActionNonce,
      frozenInputHash: textHash(JSON.stringify([binding.fingerprint, binding.contextSnapshotId, selection.output])), budget: MAIN_GENERATION_POLICY.budget })
    const owner = f.reopen(), restored = await owner.resume({ projectId: 'project', epoch: 'epoch-1', rootActionId: legacy.rootActionId, runId: legacy.runId })
    const child = owner.begin({ ...architectureSelection(f, fullIntent, 'generate-plot-outline'), uiActionNonce: 'legacy-child', parentRootActionId: restored.handle.rootActionId })
    await owner.execute({ handle: child.handle, invocationNonce: 'legacy-plot', task: plotTask })
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body)).max_tokens).toBe(32768)
    expect(new GenerationRunRepository(() => f.db).get(child.handle.runId).binding.sourceManifest.policy).toEqual(MAIN_GENERATION_POLICY)
    expect(restored.ledger!.policy).toEqual(MAIN_GENERATION_POLICY.budget)
  })
})

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
  it('retries one settled empty outline under the original root and preserves old invocations across reopen', async () => {
    let calls = 0
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      if (++calls > 1) options.onVisible({ kind: 'delta', text: outline })
      return { finishReason: calls === 1 ? 'length' : 'stop', usage: {
        promptTokens: 8093, completionTokens: 1712, totalTokens: 9805, reasoningTokens: 1712,
        accounting: 'unknown', totalIncludesReasoning: true, trusted: true,
      } }
    })
    const f = fixture(dispatch)
    Object.assign(f.model, { provider: 'custom', modelName: 'hand-entered', capabilities: null })
    const run = f.owner.begin({ ...f.begin, materialDecision: decision })
    const failed = await f.owner.execute({ handle: run.handle, invocationNonce: 'outline', task: outlineTask })
    const failedAttemptId = failed.outcome.receipt.visibleArtifact!.attemptId
    const before = f.db.prepare('SELECT * FROM generation_attempts WHERE attempt_id=?').get(failedAttemptId)
    const owner = f.reopen(), resumed = await owner.resume(run.handle)
    expect(owner.readContext(resumed.handle).draftShortOutline?.retry).toEqual({ kind: 'available', failedAttemptId })
    const [retried, duplicate] = await Promise.all([
      owner.retryDraftShortOutline({ handle: resumed.handle, failedAttemptId }),
      owner.retryDraftShortOutline({ handle: resumed.handle, failedAttemptId }),
    ])
    expect(retried.outcome).toMatchObject({ status: 'completed', content: outline })
    expect(duplicate.outcome.receipt.visibleArtifact).toEqual(retried.outcome.receipt.visibleArtifact)
    expect(retried.run.handle.rootActionId).toBe(run.handle.rootActionId)
    expect(retried.run.ledger).toMatchObject({ physicalRequests: 2, tokenLiability: 19610 })
    expect(f.db.prepare('SELECT * FROM generation_attempts WHERE attempt_id=?').get(failedAttemptId)).toEqual(before)
    expect(owner.readContext(resumed.handle).draftShortOutline?.retry).toEqual({ kind: 'unavailable' })
    const reopened = f.reopen(), next = await reopened.resume(resumed.handle)
    expect((await reopened.retryDraftShortOutline({ handle: next.handle, failedAttemptId })).outcome.content).toBe(outline)
    expect((await reopened.execute({ handle: next.handle, invocationNonce: 'outline', task: outlineTask })).outcome.content).toBe('')
    await expect(reopened.execute({ handle: next.handle, invocationNonce: 'outline', task: { ...outlineTask, reasoningStage: 'general' } })).rejects.toThrow('GENERATION_INVOCATION_CONFLICT')
    await expect(reopened.execute({ handle: next.handle, invocationNonce: 'third', task: outlineTask })).rejects.toThrow('GENERATION_DRAFT_SHORT_OUTLINE_ALREADY_ATTEMPTED')
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
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
  it.each(['length', 'stop'] as const)('keeps the second %s failure and never authorizes a third outline', async finishReason => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async () => ({ finishReason,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, reasoningTokens: null, accounting: 'included-in-completion', totalIncludesReasoning: true, trusted: true } }))
    const f = fixture(dispatch), run = f.owner.begin({ ...f.begin, materialDecision: decision })
    const first = await f.owner.execute({ handle: run.handle, invocationNonce: 'first', task: outlineTask })
    const failedAttemptId = first.outcome.receipt.visibleArtifact!.attemptId
    const retried = await f.owner.retryDraftShortOutline({ handle: run.handle, failedAttemptId })
    expect(f.owner.readContext(run.handle).draftShortOutline?.retry).toEqual({ kind: 'unavailable' })
    await expect(f.owner.retryDraftShortOutline({ handle: run.handle, failedAttemptId: retried.outcome.receipt.visibleArtifact!.attemptId })).rejects.toThrow('GENERATION_DRAFT_SHORT_OUTLINE_RETRY_UNAVAILABLE')
    await f.owner.retryDraftShortOutline({ handle: run.handle, failedAttemptId })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(f.owner.read(run.handle).ledger?.physicalRequests).toBe(2)
  })
  it.each(['unknown-usage', 'reserved', 'dispatch-marked', 'content_filter', 'unknown-finish', 'blocked', 'cancelled',
    'time-exhausted', 'tokens-exhausted', 'requests-exhausted', 'source-changed', 'model-changed', 'task-changed', 'wrong-attempt',
    'chapter-draft', 'chapter-draft-continuation', 'chapter-draft-no-progress-recovery', 'chapter-draft-condense'] as const)(
    'rejects unsafe outline retry without a new attempt: %s', async state => {
      const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async () => ({
        finishReason: state === 'content_filter' ? 'content_filter' : state === 'unknown-finish' ? 'unknown' : 'length',
        usage: state === 'unknown-usage' ? null : { promptTokens: 10, completionTokens: 2, totalTokens: 12,
          reasoningTokens: null, accounting: 'included-in-completion', totalIncludesReasoning: true, trusted: true },
      }))
      const f = fixture(dispatch), run = f.owner.begin({ ...f.begin, materialDecision: decision })
      const first = await f.owner.execute({ handle: run.handle, invocationNonce: 'first', task: outlineTask })
      const failedAttemptId = first.outcome.receipt.visibleArtifact!.attemptId
      const repository = new GenerationRunRepository(() => f.db)
      if (state === 'blocked') repository.block(run.handle.rootActionId, 'GENERATION_STORAGE_FAILED')
      if (state === 'cancelled') f.owner.cancel(run.handle)
      if (state === 'reserved' || state === 'dispatch-marked') {
        const attempt = repository.receipt(failedAttemptId).attempt
        f.db.prepare('UPDATE generation_attempts SET attempt_json=? WHERE attempt_id=?').run(JSON.stringify({ ...attempt, status: state }), failedAttemptId)
      }
      if (state === 'time-exhausted') f.db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?').run(MAIN_GENERATION_POLICY.budget.maxActiveElapsedMs, run.handle.rootActionId)
      if (state === 'tokens-exhausted' || state === 'requests-exhausted') f.db.prepare('UPDATE generation_roots SET budget_json=? WHERE root_action_id=?')
        .run(JSON.stringify({ ...MAIN_GENERATION_POLICY.budget, ...(state === 'tokens-exhausted' ? { maxTokenLiability: 12 } : { maxPhysicalRequests: 1 }) }), run.handle.rootActionId)
      if (state === 'source-changed') f.db.exec("UPDATE project_core SET global_guidance='作者改了约束'")
      if (state === 'model-changed') f.model.temperature = 0.1
      if (state === 'task-changed') {
        const stored = JSON.parse(f.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(failedAttemptId) as string)
        stored.replayTask.reasoningStage = 'general'
        f.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify(stored), failedAttemptId)
      }
      if (state.startsWith('chapter-draft')) repository.reserve(run.handle.runId, 'body-started', 'b'.repeat(64), 100, 20, undefined, state)
      if (state === 'tokens-exhausted' || state === 'requests-exhausted') expect(() => f.owner.readContext(run.handle)).toThrow('GENERATION_POLICY_BUDGET_MISMATCH')
      else if (state !== 'wrong-attempt') expect(f.owner.readContext(run.handle).draftShortOutline?.retry).toEqual({ kind: 'unavailable' })
      await expect(f.owner.retryDraftShortOutline({ handle: run.handle, failedAttemptId: state === 'wrong-attempt' ? 'another-attempt' : failedAttemptId })).rejects.toThrow()
      expect(dispatch).toHaveBeenCalledTimes(1)
    },
  )
  it.each(['reserved', 'dispatch-marked', 'unknown'] as const)('reads an existing %s retry nonce without redispatch', async status => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async () => ({ finishReason: 'length',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, reasoningTokens: null, accounting: 'included-in-completion', totalIncludesReasoning: true, trusted: true } }))
    const f = fixture(dispatch), run = f.owner.begin({ ...f.begin, materialDecision: decision })
    const first = await f.owner.execute({ handle: run.handle, invocationNonce: 'first', task: outlineTask })
    const failedAttemptId = first.outcome.receipt.visibleArtifact!.attemptId
    const repository = new GenerationRunRepository(() => f.db)
    const requestHash = textHash(JSON.stringify([outlineTask, repository.get(run.handle.runId).binding.fingerprint.modelLeaseRevision, repository.get(run.handle.runId).binding.fingerprint.policyHash]))
    const reserved = repository.reserve(run.handle.runId, `draft-short-outline-retry:${failedAttemptId}`, requestHash, 100, 20, undefined, outlineTask.purpose, outlineTask)
    f.db.prepare('UPDATE generation_attempts SET attempt_json=? WHERE attempt_id=?').run(JSON.stringify({ ...reserved.attempt, status }), reserved.attempt.attemptId)
    const receipt = await f.owner.retryDraftShortOutline({ handle: run.handle, failedAttemptId })
    expect(receipt.outcome.finishReason).toBe('unknown')
    expect(receipt.outcome.receipt.visibleArtifact?.attemptId).toBe(reserved.attempt.attemptId)
    const reopened = f.reopen(), resumed = await reopened.resume(run.handle)
    expect((await reopened.retryDraftShortOutline({ handle: resumed.handle, failedAttemptId })).outcome.receipt.visibleArtifact?.attemptId)
      .toBe(reserved.attempt.attemptId)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('continues from outline to prose after an owner running notification arrives behind the completed receipt', async () => {
    const emitted: MainGenerationSnapshot[] = []
    let listener: ((snapshot: MainGenerationSnapshot) => void) | undefined
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: dispatch.mock.calls.length === 1 ? outline : '正文。' })
      return { finishReason: 'stop', usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40,
        reasoningTokens: 0, accounting: 'included-in-completion', totalIncludesReasoning: true, trusted: true } }
    })
    const f = fixture(dispatch, false, undefined, snapshot => {
      emitted.push(snapshot)
      if (snapshot.status !== 'running') listener?.(snapshot)
    })
    const run = f.owner.begin({ ...f.begin, materialDecision: decision })
    const transport: MainGenerationTransport = {
      read: async handle => f.owner.read(handle), list: async () => f.owner.list(),
      execute: request => f.owner.execute(request), cancel: async handle => f.owner.cancel(handle),
      subscribe: (_handle, callback) => { listener = callback; return () => { listener = undefined } },
    }
    const shown = vi.fn()
    const runtime = await createMainOwnedGenerationRuntime({ runHandle: run.handle, onSnapshot: shown }, transport)
    try {
      await expect(runtime.execute(({ session }) => session.complete(outlineTask, { invocationNonce: 'outline' })))
        .resolves.toMatchObject({ status: 'completed', content: outline })
      expect(emitted.map(({ status, revision, durableRevision, text }) => ({ status, revision, durableRevision, text }))).toEqual([
        { status: 'running', revision: 0, durableRevision: 0, text: '' },
        { status: 'running', revision: 1, durableRevision: 1, text: outline },
        { status: 'completed', revision: 1, durableRevision: 1, text: outline },
      ])
      const lateRunning = emitted.filter(snapshot => snapshot.status === 'running').at(-1)
      if (!lateRunning || !listener) throw new Error('TEST_EXPECTED_OWNER_NOTIFICATION')
      listener(lateRunning)
      await expect(runtime.execute(({ session }) => session.complete(draftTask(composed), { invocationNonce: 'prose' })))
        .resolves.toMatchObject({ status: 'completed', content: '正文。' })
      expect(shown.mock.calls.map(([snapshot]) => ({ status: snapshot.status, text: snapshot.text }))).toEqual([
        { status: 'completed', text: outline }, { status: 'completed', text: '正文。' },
      ])
      expect(dispatch).toHaveBeenCalledTimes(2)
      expect(f.owner.read(run.handle).ledger?.physicalRequests).toBe(2)
    } finally { await runtime.close() }
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
    expect(owner.readContext(resumed.handle).draftShortOutline).toEqual({ artifactIds: [planned.run.artifacts[0]!.artifactId], completedOutput: outline, promptHash: textHash(outlinePrompt), retry: { kind: 'unavailable' } })
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
  it('lets the physical model capacity admit an indivisible target despite a larger semantic estimate', async () => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async () => ({ finishReason: 'stop', usage: null })), f = fixture(dispatch, true)
    const run = f.owner.begin(f.begin)
    await f.owner.execute({ handle: run.handle, invocationNonce: 'physical-capacity', task: { ...task,
      budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 5000, segmentable: false } } })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(new GenerationRunRepository(() => f.db).budget(run.handle.rootActionId).attempts[0].requestedOutputTokens).toBe(2048)
  })
})

describe('durable directory commit and remaining stage', () => {
  const directoryTask = { ...task, purpose: 'directory-batch', output: 'structured-data' as const }
  const authorInputs = [{ id: 'directory:pacing-guidance', text: '  前缓后急\r\n' }, { id: 'directory:author-config', text: '{"totalChapters":3}' }]
  function directoryFixture(operation = 'directory', chapters = 3) {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: '[{"chapterNumber":1,"title":"启程"}]' })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    const selection = { ...f.begin, operation, selectedBlueprintChapterNumbers: Array.from({ length: chapters }, (_, index) => index + 1),
      authorInputs: operation === 'directory' ? authorInputs : [authorInputs[0],
        { id: 'directory:author-config', text: JSON.stringify({ totalChapters: chapters }) },
        { id: 'directory:requested-range', text: JSON.stringify({ mode: 'full', startChapter: 1, endChapter: chapters }) }], output: 'structured-data' as const }
    const run = chapters > 10 ? openAggregateRun(f, selection) : f.owner.begin(selection)
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
  it('keeps the original 50-chapter planning allowance after committing a prefix and reopening its remaining range', async () => {
    const f = directoryFixture('chapter-blueprint-directory', 50)
    new GenerationRunRepository(() => f.fixture.db).pause(f.run.handle.rootActionId)
    await f.owner.resume(f.run.handle)
    await f.owner.execute({ handle: f.run.handle, invocationNonce: 'prefix', task: directoryTask })
    const policy = new GenerationRunRepository(() => f.fixture.db).get(f.run.handle.runId).binding.sourceManifest.policy
    f.commit(f.owner, f.run.handle, f.request('planning-prefix', 1, 40), { startChapter: 1, endChapter: 50 })
    const reopened = f.reopen()
    const remaining = { ...f.selection, uiActionNonce: 'planning-remainder', continueDirectoryOperationId: 'planning-prefix',
      authorInputs: f.selection.authorInputs.map(input => input.id === 'directory:requested-range'
        ? { ...input, text: JSON.stringify({ mode: 'append', startChapter: 41, endChapter: 50 }) } : input) }
    const next = reopened.begin(remaining)
    expect(next.handle.rootActionId).toBe(f.run.handle.rootActionId)
    expect(next.ledger).toMatchObject({ physicalRequests: 1, policy: { maxPhysicalRequests: 141 } })
    expect(new GenerationRunRepository(() => f.fixture.db).get(next.handle.runId).binding.sourceManifest.policy).toEqual(policy)
    await reopened.execute({ handle: next.handle, invocationNonce: 'remainder', task: directoryTask })
    expect(f.dispatch).toHaveBeenCalledTimes(2)
    expect(f.fixture.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
  })
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
  it('freezes default five chapters and 600 units, admits ten and 1000, and keeps a complete longer outline', async () => {
    const content = `## 第1章：完整情节\n${'完整行动与结果。'.repeat(200)}`
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: content }); return { finishReason: 'stop', usage: null } })
    const defaultSelection = outlineSelection(f, 20)
    defaultSelection.authorInputs = defaultSelection.authorInputs!.filter(item => item.id !== 'architecture:planning-intent')
    const defaultRun = f.owner.begin(defaultSelection)
    expect(defaultRun.plotOutline).toMatchObject({ range: { from: 1, to: 5 }, targetUnits: 600 })
    const selected = { ...outlineSelection(f, 10), uiActionNonce: 'ten' }
    selected.authorInputs!.push({ id: 'planning:target-units', text: '1000' })
    const run = f.owner.begin(selected)
    expect(run.plotOutline).toMatchObject({ range: { from: 1, to: 10 }, targetUnits: 1000 })
    await f.owner.execute({ handle: run.handle, invocationNonce: 'complete-long', task: outlineTask(run.plotOutline!) })
    acceptOutline(f.owner, run.handle)
    expect(f.owner.read(run.handle).plotOutline!.composition!.text).toBe(content)
    expect(() => f.owner.begin({ ...outlineSelection(f, 11), uiActionNonce: 'eleven' })).toThrow('GENERATION_PLANNING_RANGE_INVALID')
    expect(() => f.owner.begin({ ...selected, uiActionNonce: 'target-too-large', authorInputs: selected.authorInputs!.map(item => item.id === 'planning:target-units' ? { ...item, text: '1001' } : item) }))
      .toThrow('GENERATION_PLANNING_TARGET_INVALID')
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(2)
  })
  it.each([65536, 32768])('uses actual context %i to admit or reject 43,699 bytes before reserving', async contextWindowTokens => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => { options.onVisible({kind:'delta',text:'{"blueprints":[]}'}); return {finishReason:'stop',usage:null} })
    const f = fixture(dispatch)
    Object.assign(f.model, { baseUrl:'https://compatible.example/v1', modelName:'custom', maxTokens:65536,
      capabilities:{contextWindowTokens,maxOutputTokens:65536,reasoning:false,structuredOutput:true,usage:false} })
    const run = f.owner.begin({ ...f.begin, operation:'chapter-blueprint-directory', output:'structured-data', authorInputs:[
      {id:'directory:author-config',text:'{"totalChapters":1}'},{id:'directory:requested-range',text:'{"mode":"full","startChapter":1,"endChapter":1}'},
    ] })
    const request = {handle:run.handle,invocationNonce:'full-input',task:{purpose:'chapter-blueprint-directory',output:'structured-data' as const,
      reasoningStage:'planning' as const,messages:[{role:'user' as const,content:'x'.repeat(43699)}],
      budgetDemand:{kind:'structured-items' as const,requestedItems:1,writingLanguage:'zh-CN' as const}}}
    if(contextWindowTokens===65536) {
      await f.owner.execute(request)
      expect(dispatch).toHaveBeenCalledTimes(1)
      const sent=dispatch.mock.calls[0][0] as {task:GenerationTask;plan:{requestedOutputTokens:number;reservedTokens:number}}
      expect(sent.task.messages.find(message=>message.role==='user')!.content).toBe(request.task.messages[0].content)
      expect(sent.plan.requestedOutputTokens).toBeGreaterThan(0)
      expect(sent.plan.reservedTokens).toBeLessThanOrEqual(contextWindowTokens)
    } else {
      await expect(f.owner.execute(request)).rejects.toThrow()
      expect(dispatch).not.toHaveBeenCalled()
      expect(new GenerationRunRepository(()=>f.db).budget(run.handle.rootActionId).attempts).toHaveLength(0)
    }
  })
  it('compares old and new UNKNOWN roots with the same input, retaining all costs and all 32 new request slots', async () => {
    const dispatch=vi.fn<GenerationRunServiceDependencies['dispatch']>(async()=>({finishReason:'stop',usage:null})), f=fixture(dispatch)
    Object.assign(f.model,{baseUrl:'https://compatible.example/v1',modelName:'unknown-custom',maxTokens:65536,capabilities:undefined})
    const sourceDeps={db:f.db,projectStorageRoot:path.join(f.root,'project'),globalDataRoot:path.join(f.root,'global'),
      readBuiltinPrompt:(key:string,language:'zh-CN'|'en-US')=>JSON.stringify(getBuiltinPromptTemplate(key,language)),readBuiltinSkill:readBuiltinWritingSkill}
    const binding=buildGenerationSourceBinding(sourceDeps,{...f.begin,projectId:'project',epoch:'epoch-1',
      modelReceipt:safeGenerationModelReceipt(createModelExecutionLeaseReceipt(f.model,{leaseId:'old',createdAt:0,expiresAt:1})),policy:MAIN_GENERATION_POLICY,outputContract:'visible-text'}).binding
    const repository=new GenerationRunRepository(()=>f.db), old=repository.open({...binding,operation:f.begin.operation,uiActionNonce:'old-root',
      frozenInputHash:textHash(JSON.stringify([binding.fingerprint,binding.contextSnapshotId,f.begin.output])),budget:MAIN_GENERATION_POLICY.budget})
    repository.pause(old.rootActionId)
    const oldRun=await f.owner.resume({projectId:'project',epoch:'epoch-1',rootActionId:old.rootActionId,runId:old.runId})
    const input={...task,messages:[{role:'user' as const,content:'x'.repeat(43699)}]}
    for(let index=0;index<27;index++) await f.owner.execute({handle:oldRun.handle,invocationNonce:`old-${index}`,task:input})
    await expect(f.owner.execute({handle:oldRun.handle,invocationNonce:'old-28',task:input})).rejects.toThrow('GENERATION_INPUT_CAPACITY_EXCEEDED')
    expect(repository.budget(old.rootActionId).policy).toEqual(MAIN_GENERATION_POLICY.budget)
    const next=f.owner.begin({...f.begin,uiActionNonce:'new-root'})
    for(let index=0;index<32;index++) await f.owner.execute({handle:next.handle,invocationNonce:`new-${index}`,task:input})
    const budget=repository.budget(next.handle.rootActionId)
    expect(budget.policy.maxTokenLiability).toBe(32*2_097_152)
    expect(budget.attempts).toHaveLength(32)
    expect(budget.attempts.every(attempt=>attempt.status==='unknown'&&attempt.requestedOutputTokens===65536)).toBe(true)
    expect(budget.attempts.reduce((sum,attempt)=>sum+attempt.reservedTokens,0)).toBeGreaterThan(MAIN_GENERATION_POLICY.budget.maxTokenLiability)
    await expect(f.owner.execute({handle:next.handle,invocationNonce:'new-33',task:input})).rejects.toThrow('ROOT_BUDGET_EXHAUSTED')
    expect(dispatch).toHaveBeenCalledTimes(59)
  })
  it('shows semantic 1712 and physical 16384 from the durable owner diagnostic with reservation 50410', async () => {
    const f = fixture(async () => ({ finishReason: 'length', usage: null }))
    Object.assign(f.model, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-flash',
      temperature: 0, maxTokens: 16384, reasoningOverride: 'high',
      reasoningMapping: { adapter: 'deepseek-v4-thinking', supportedEfforts: ['off', 'high'], providerValues: { off: 'disabled', high: 'high' } },
      capabilities: { contextWindowTokens: 1048576, maxOutputTokens: 393216, reasoning: true, structuredOutput: true, usage: true } })
    const run = f.owner.begin(f.begin)
    const receipt = await f.owner.execute({ handle: run.handle, invocationNonce: 'semantic-physical', task: {
      purpose: 'chapter-draft', output: 'visible-text', reasoningStage: 'planning',
      budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 500, segmentable: false },
      messages: [{ role: 'user', content: 'a'.repeat(33446) }],
    } })
    const diagnostic = receipt.run.budgetDiagnostics![0]!
    const stored = new GenerationRunRepository(() => f.db).receipt(diagnostic.attemptId)
    expect(stored.budgetDecision).toMatchObject({ requestedOutputTokens: 1712, reservedOutputTokens: 16384 })
    expect(stored.attempt).toMatchObject({ requestedOutputTokens: 16384, reservedTokens: 50410 })
    expect(formatGenerationBudgetDiagnostic(diagnostic, 'zh-CN')).toContain('语义输出估算 1,712 tokens，物理输出上限 16,384 tokens，总预留 50,410 tokens')
    expect(f.reopen().read(run.handle).budgetDiagnostics).toEqual(receipt.run.budgetDiagnostics)
  })
  it.each([16384, 32768, 65536])('honors the finite user output limit %i on a new planning root at the provider boundary', async maxTokens => {
    const fetch = syntheticStream(), f = fixture()
    Object.assign(f.model, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash',
      maxTokens, reasoningOverride: 'high',
      capabilities: { contextWindowTokens: 262144, maxOutputTokens: maxTokens, reasoning: true, structuredOutput: true, usage: true },
    } satisfies Partial<ModelProfile>)
    const run = f.owner.begin({ operation: 'chapter-blueprint-directory', uiActionNonce: 'planning-output-limit', modelId: f.model.id,
      selectedBlueprintChapterNumbers: [1], selectedDraftIds: [], selectedFinalizedDraftIds: [],
      promptKeys: ['chapter_blueprint_chunk'], skillStages: ['planning'], output: 'structured-data', authorInputs: [
        { id: 'directory:pacing-guidance', text: '' },
        { id: 'directory:author-config', text: '{"totalChapters":1,"wordsPerChapter":4000}' },
        { id: 'directory:requested-range', text: '{"mode":"full","startChapter":1,"endChapter":1}' },
      ] })
    const result = await f.owner.execute({ handle: run.handle, invocationNonce: 'blueprint', task: {
      purpose: 'chapter-blueprint-directory', output: 'structured-data', reasoningStage: 'planning',
      messages: [{ role: 'user', content: '为第1章生成完整蓝图，保留作者事实。' }],
      budgetDemand: { kind: 'structured-items', writingLanguage: 'zh-CN', requestedItems: 1 },
    } })
    expect(result.outcome.status).toBe('completed')
    expect(fetch).toHaveBeenCalledTimes(1)
    const wire: unknown = JSON.parse(String(fetch.mock.calls[0]![1].body))
    expect(wire).toMatchObject({ max_tokens: maxTokens })
    const attempt = new GenerationRunRepository(() => f.db).budget(run.handle.rootActionId).attempts[0]
    expect(attempt).toMatchObject({ status: 'settled', requestedOutputTokens: maxTokens })
  })
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
        { role: 'system', content: planningTargetInstruction('blueprint', 600, 'zh-CN') },
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
      expect(reopened.readContext(view.handle)).toMatchObject({ attemptedPurposes: [purpose], authorInputs: [...authorInputs, { id: 'planning:target-units', text: '600' }] })
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
  it('rejects changed legacy DeepSeek capability receipts and preserves unknown work through explicit restart', async () => {
    const resolveCapabilities = providerPresets.resolveModelProfileCapabilities
    const legacyCapabilities = vi.spyOn(providerPresets, 'resolveModelProfileCapabilities').mockImplementation(profile =>
      profile.baseUrl === 'https://api.deepseek.com/v1' ? undefined : resolveCapabilities(profile))
    cleanups.push(() => legacyCapabilities.mockRestore())
    const prefix = '  旧运行已收到的正文前缀。\r\n'
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: prefix }); return { usage: null, finishReason: 'length' }
    })
    const f = fixture(dispatch)
    Object.assign(f.model, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-v4-flash' })
    const identityOptions = { leaseId: 'fixture', createdAt: 0, expiresAt: 1 }
    const oldReceipt = createModelExecutionLeaseReceipt(f.model, identityOptions)
    expect(oldReceipt.capabilityEvidence).toMatchObject({ structuredOutput: null, source: { featureFlags: 'unknown' } })
    const view = f.owner.begin(f.begin)
    let repository = new GenerationRunRepository(() => f.db)
    const frozen = repository.get(view.handle.runId).binding
    const generated = await f.owner.execute({ handle: view.handle, invocationNonce: 'legacy-prefix', task })
    const artifact = repository.receipt(generated.outcome.receipt.visibleArtifact!.attemptId)
    expect(artifact.attempt.status).toBe('unknown')
    expect(artifact.artifact).toMatchObject({ text: prefix, textHash: textHash(prefix) })
    const liability = generated.run.ledger!.tokenLiability
    expect(liability).toBeGreaterThan(0)

    legacyCapabilities.mockRestore()
    const currentReceipt = createModelExecutionLeaseReceipt(f.model, identityOptions)
    expect(currentReceipt).toMatchObject({ modelRevision: oldReceipt.modelRevision,
      endpointFingerprint: oldReceipt.endpointFingerprint,
      capabilityEvidence: { subjectFingerprint: oldReceipt.capabilityEvidence.subjectFingerprint,
        structuredOutput: true, source: { featureFlags: 'verified-provider-preset' } } })
    await expect(f.owner.execute({ handle: view.handle, invocationNonce: 'changed-capability', task })).rejects.toThrow('GENERATION_SOURCE_CHANGED')
    const reopened = f.reopen()
    await expect(reopened.resume(view.handle)).rejects.toThrow('GENERATION_RECOVERY_UNAUTHORIZED')
    repository = new GenerationRunRepository(() => f.db)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(repository.budget(view.handle.rootActionId).attempts).toEqual([artifact.attempt])
    expect(repository.get(view.handle.runId).binding).toEqual(frozen)
    expect(repository.receipt(artifact.attempt.attemptId).artifact).toEqual(artifact.artifact)
    expect(reopened.read(view.handle).ledger).toMatchObject({ physicalRequests: 1, tokenLiability: liability })

    const restarted = reopened.restart(view.handle, { ...f.begin, uiActionNonce: 'explicit-new-action' })
    expect(restarted.handle.rootActionId).not.toBe(view.handle.rootActionId)
    expect(restarted.handle.runId).not.toBe(view.handle.runId)
    expect(restarted.ledger).toMatchObject({ physicalRequests: 0, tokenLiability: 0 })
    expect(repository.get(restarted.handle.runId).binding.sourceManifest.modelReceipt).toMatchObject({
      capabilityEvidence: { structuredOutput: true, source: { featureFlags: 'verified-provider-preset' } },
    })
    expect(repository.get(restarted.handle.runId).binding.fingerprint.modelLeaseRevision).not.toBe(frozen.fingerprint.modelLeaseRevision)
    expect(reopened.read(view.handle)).toMatchObject({ status: 'cancelled', ledger: { physicalRequests: 1, tokenLiability: liability } })
    expect(repository.get(view.handle.runId).binding).toEqual(frozen)
    expect(repository.budget(view.handle.rootActionId).attempts).toEqual([artifact.attempt])
    expect(repository.receipt(artifact.attempt.attemptId).artifact).toEqual(artifact.artifact)
    await reopened.execute({ handle: restarted.handle, invocationNonce: 'new-action-call', task })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(2)
  })
  it.each(['openai', 'deepseek'])('reopens a real database with unchanged %s capabilities without rewriting old candidate identity', async (provider) => {
    const dispatch = vi.fn(async (_request, options) => { options.onVisible({ kind: 'delta', text: '候选' }); return { usage: null, finishReason: 'stop' } })
    const f = fixture(dispatch)
    if (provider === 'deepseek') Object.assign(f.model, { provider, baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash' })
    const view = f.owner.begin(f.begin)
    await f.owner.execute({ handle: view.handle, invocationNonce: 'call', task })
    const reopened = f.reopen(), old = reopened.read(view.handle)
    expect(old.nonReplayable).toBe(true)
    await expect(reopened.execute({ handle: view.handle, invocationNonce: 'again', task })).rejects.toThrow('GENERATION_EPOCH_STALE')
    const resumed = await reopened.resume(view.handle)
    expect(resumed.handle.epoch).toBe('epoch-2')
    expect(resumed.handle.rootActionId).toBe(view.handle.rootActionId)
    expect(resumed.artifacts).toHaveLength(0)
    expect(resumed.candidates?.[0].epoch).toBe('epoch-1')
    await reopened.execute({ handle: resumed.handle, invocationNonce: 'new-call', task })
    expect(reopened.read(resumed.handle).artifacts).toHaveLength(1)
    expect(reopened.read(resumed.handle).candidates).toHaveLength(2)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
})

describe('durable character proposals from actual generation artifacts', () => {
  async function architectureProposed() {
    const description = `${'众人声称他背叛了同伴，'.repeat(15)}但这些传闻并不属实，他从未背叛同伴。`
    const state = `${'旁人声称宝剑已经失窃，'.repeat(10)}消息并不属实，宝剑仍在木箱里。`
    const slots = ['林岚', '同伴', '证人'].map((name, index) => ({ slotId: `slot-${index}`, name,
      role: index === 0 ? 'protagonist' : 'supporting', narrativeDuty: '查清传闻', relations: [] }))
    const entries = slots.map(({ slotId, name, role }) => ({ slotId, name, role, gender: '未知', age: 18,
      ...Object.fromEntries(CHARACTER_DETAIL_DESCRIPTION_FIELDS.map(field => [field, `  ${description}  `])),
      currentState: { ...Object.fromEntries(CHARACTER_STATE_TEXT_FIELDS.map(field => [field, `  ${state}  `])), updatedAtChapter: 19 } }))
    const outputs = [JSON.stringify({ slots }), JSON.stringify({ entries })]
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: outputs[dispatch.mock.calls.length - 1] }); return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    const run = f.owner.begin({ ...f.begin, operation: 'character-architecture', output: 'structured-data',
      promptKeys: ['character_dynamics'], skillStages: ['planning'] })
    for (const purpose of ['character-architecture-manifest', 'character-architecture-details']) {
      await f.owner.execute({ handle: run.handle, invocationNonce: purpose, task: { ...task, purpose, output: 'structured-data' } })
    }
    const artifacts = f.owner.read(run.handle).artifacts
    const source = { kind: 'generation' as const, inputKind: 'architecture' as const, handle: run.handle,
      manifestArtifactId: artifacts[0].artifactId,
      artifacts: artifacts.map(({ artifactId, revision, textHash }) => ({ artifactId, revision, textHash })) }
    return { ...f, fixture: f, source, dispatch, description, state, artifacts }
  }
  it.each([1, 2] as const)('keeps architecture derivation v%s through stage, reopen, approval and replay', async version => {
    const f = await architectureProposed()
    let batch = f.owner.characterProposals.stage(f.source)
    const readEnvelope = () => f.fixture.db.prepare('SELECT raw_value,source_hash FROM character_identity_proposals WHERE proposal_id=?')
      .get(batch.proposalBatchId) as { raw_value: string; source_hash: string }
    if (version === 1) {
      // Historical fixture: the old release persisted this proof without a derivation marker.
      const envelope = JSON.parse(readEnvelope().raw_value)
      envelope.proof = proveCharacterProposal(f.fixture.db, new GenerationRunRepository(() => f.fixture.db), 'project', f.source, false, () => {}, 1)
      envelope.batch.items = envelope.proof.items.map((item: { selectionKey: string }) => ({ ...item,
        resolution: batch.items.find(candidate => candidate.selectionKey === item.selectionKey)!.resolution }))
      delete envelope.architectureDerivationVersion
      const encoded = JSON.stringify(envelope)
      f.fixture.db.prepare('UPDATE character_identity_proposals SET raw_value=?,source_hash=? WHERE proposal_id=?')
        .run(encoded, textHash(encoded), batch.proposalBatchId)
      batch = envelope.batch
    }
    const expected = version === 1 ? Array.from(f.description).slice(0, 120).join('') : f.description
    for (const field of CHARACTER_DETAIL_DESCRIPTION_FIELDS) expect(batch.items[0].fields[field]).toBe(expected)
    const pendingEnvelope = readEnvelope()
    expect(JSON.parse(pendingEnvelope.raw_value).architectureDerivationVersion).toBe(version === 2 ? 2 : undefined)
    expect(f.owner.characterProposals.stage(f.source)).toEqual(batch)
    expect(readEnvelope()).toEqual(pendingEnvelope)
    const reopened = f.reopen()
    expect(reopened.characterProposals.read(batch.proposalBatchId)).toEqual(batch)
    expect(reopened.characterProposals.stage(f.source)).toEqual(batch)
    expect(readEnvelope()).toEqual(pendingEnvelope)
    expect(() => reopened.characterProposals.stage({ ...f.source, artifacts: f.source.artifacts.map((artifact, index) =>
      index === 0 ? { ...artifact, textHash: '0'.repeat(64) } : artifact) })).toThrow('CHARACTER_PROPOSAL_ARTIFACT_INVALID')
    const request = { proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision, operationId: `adopt-architecture-v${version}`,
      selections: batch.items.map(item => ({ selectionKey: item.selectionKey, action: 'create' as const })) }
    const approved = reopened.characterProposals.approve(request)
    const saved = f.fixture.db.prepare('SELECT appearance,personality,background,abilities,motivation,arc,notes FROM characters').all()
    expect(saved).toHaveLength(3)
    for (const row of saved) expect(row).toEqual(Object.fromEntries(CHARACTER_DETAIL_DESCRIPTION_FIELDS.map(field => [field, expected])))
    const approvedEnvelope = readEnvelope()
    expect(JSON.parse(approvedEnvelope.raw_value).architectureDerivationVersion).toBe(version === 2 ? 2 : undefined)
    const again = f.reopen()
    expect(again.characterProposals.read(batch.proposalBatchId)).toEqual(approved.batch)
    expect(again.characterProposals.approve(request)).toEqual(approved)
    // Adoption changes the roster source; a stage replay must retain its write-currentness gate.
    expect(() => again.characterProposals.stage(f.source)).toThrow('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    expect(readEnvelope()).toEqual(approvedEnvelope)
    expect(again.read(f.source.handle).artifacts).toEqual(f.artifacts)
    f.fixture.db.exec("UPDATE project_core SET global_guidance='作者改动来源'")
    expect(() => again.characterProposals.stage(f.source)).toThrow('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    expect(readEnvelope()).toEqual(approvedEnvelope)
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  })
  it.each(['unknown', 'misplaced'] as const)('rejects an %s architecture derivation marker', async mutation => {
    const f = mutation === 'unknown' ? await architectureProposed() : await proposed()
    const batch = f.owner.characterProposals.stage(f.source)
    const envelope = JSON.parse(f.db.prepare('SELECT raw_value FROM character_identity_proposals WHERE proposal_id=?').pluck().get(batch.proposalBatchId) as string)
    envelope.architectureDerivationVersion = mutation === 'unknown' ? 3 : 2
    const encoded = JSON.stringify(envelope)
    f.db.prepare('UPDATE character_identity_proposals SET raw_value=?,source_hash=? WHERE proposal_id=?').run(encoded, textHash(encoded), batch.proposalBatchId)
    expect(() => f.owner.characterProposals.read(batch.proposalBatchId)).toThrow('CHARACTER_PROPOSAL_RECEIPT_INVALID')
    expect(() => f.owner.characterProposals.stage(f.source)).toThrow('CHARACTER_PROPOSAL_RECEIPT_INVALID')
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
  })
  async function proposed(beforeBegin?: (f: ReturnType<typeof fixture>) => void) {
    const output = JSON.stringify({ results: ['1:1', '2:1'].map(sourceId => ({ sourceId, characterCards: [{ name: '林岚', role: 'supporting', background: '模型背景', appearance: '模型外貌', notes: `来源${sourceId}` }] })) })
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: output }); return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    beforeBegin?.(f)
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
    let existingId = ''
    const f = await proposed(seed => seed.db.transaction(() => {
      const seeded = commitCharacterIdentities(seed.db, { approval: { operationId: 'seed-author', expectedRevision: 0,
        action: 'author-edit', source: { kind: 'author', source: { projectId: 'project', epoch: 'epoch-1', sourceId: 'author-roster',
          revision: 0, contentHash: textHash('作者原始角色') } } },
        changes: [], creations: [{ selectionKey: 'seed', fields: { name: '林岚', role: 'supporting', background: '作者背景', notes: '作者笔记' } }],
        retireIds: [], relationships: [], resolutions: [] }, () => true)
      refreshCharacterIdentityProjection(seed.db)
      existingId = seeded.created[0]!.characterId
    }).immediate())
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
    expect(reopened.readContext(generated.run.handle)).toMatchObject({ draftSave: { kind: 'current', receipt: saved }, attemptedPurposes: ['chapter-draft'] })
    expect(f.fixture.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('reads saved generation history after a legitimate revision merge and reopen without changing either draft', async () => {
    const f = drafting(), generated = await generate(f, { ...f.begin, authorInputs })
    const saved = f.owner.commitDraft(generated.request)
    const receipts = f.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE run_id=?').all(generated.run.handle.runId)
    const artifacts = f.owner.read(generated.run.handle).artifacts
    const mergedContent = '清晨的街道渐渐苏醒，林岚停在城门前，确认昨日的线索仍藏在信封里。'
    const revision = RevisionRepository.create({ baseDraftId: saved.id, revisionType: 'refine', content: mergedContent,
      wordCount: mergedContent.length, expectedSource: { id: saved.id, chapterNumber: 1, version: saved.version,
        status: 'draft', content: saved.content } })
    RevisionRepository.mergeIntoDraft({ revisionId: revision.id, targetDraftId: saved.id,
      expectedDraftContent: saved.content, mergedContent, wordCount: mergedContent.length })
    expect(RevisionRepository.getFull(revision.id)).toMatchObject({ status: 'merged', mergedToDraftId: saved.id })

    const reopened = f.reopen()
    expect.soft(() => reopened.readContext(generated.run.handle)).not.toThrow()
    expect(reopened.readContext(generated.run.handle).draftSave).toEqual({ kind: 'changed' })
    expect(() => reopened.commitDraft(generated.request)).toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(f.fixture.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE run_id=?').all(generated.run.handle.runId))
      .toEqual(receipts)
    expect(reopened.read(generated.run.handle).artifacts).toEqual(artifacts)
    expect(f.fixture.db.prepare('SELECT body FROM contents JOIN drafts ON drafts.content_id=contents.id WHERE drafts.id=?')
      .pluck().get(saved.id)).toBe(mergedContent)
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
    expect(reopened.readContext(generated.run.handle).draftSave).toEqual({ kind: 'current', receipt: saved })
    expect(reopened.commitDraft(generated.request)).toEqual(saved)
    expect(reopened.read(generated.run.handle).artifacts[0]).toEqual(generated.raw)
    expect(generated.raw.text).toBe(`${manuscript}\n点我继续生成后续内容`)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('reads author-edited saved history but refuses to advance its batch', async () => {
    const f = drafting()
    f.db.exec("INSERT INTO blueprints(chapter_number,title) VALUES(2,'第二章')")
    const batch = f.owner.beginBatch({ mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 20,
      uiActionNonce: 'batch', modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const generated = await generate(f, { ...f.begin, authorInputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId })
    const saved = f.owner.commitDraft(generated.request)
    const edited = '作者修改后的当前正文。'
    DraftRepository.updateContent(saved.id, edited, edited.length)
    const reopened = f.reopen()
    expect(reopened.readContext(generated.run.handle).draftSave).toEqual({ kind: 'changed' })
    expect(reopened.listBatches()).toEqual([expect.objectContaining({ batchId: batch.batchId, sourceCurrent: false,
      nextChapterNumber: 2, completedChapters: [expect.objectContaining({ draftId: saved.id, contentHash: saved.contentHash })] })])
    expect(() => reopened.readBatch(batch.batchId)).toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(() => reopened.commitDraft(generated.request)).toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(() => reopened.begin({ ...f.begin, chapterNumber: 2, uiActionNonce: 'chapter2', authorInputs,
      batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId, selectedDraftIds: [saved.id] }))
      .toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(DraftRepository.getFull(saved.id)?.content).toBe(edited)
    expect(f.fixture.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it.each(['revision merge', 'author edit', 'deletion'])('lists completed batch history and an independent candidate after a legitimate %s', async change => {
    const f = drafting()
    const batch = f.owner.beginBatch({ mode: 'draft_review', range: { startChapter: 1, endChapter: 1 }, targetUnits: 20,
      uiActionNonce: 'batch', modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const generated = await generate(f, { ...f.begin, authorInputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId })
    const saved = f.owner.commitDraft(generated.request)
    const receipts = f.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE run_id=?').all(generated.run.handle.runId)
    const edited = '清晨的街道渐渐苏醒，林岚停在城门前，确认昨日的线索仍藏在信封里。'
    if (change === 'revision merge') {
      const revision = RevisionRepository.create({ baseDraftId: saved.id, revisionType: 'refine', content: edited,
        wordCount: edited.length, expectedSource: { id: saved.id, chapterNumber: 1, version: saved.version,
          status: 'draft', content: saved.content } })
      RevisionRepository.mergeIntoDraft({ revisionId: revision.id, targetDraftId: saved.id,
        expectedDraftContent: saved.content, mergedContent: edited, wordCount: edited.length })
      expect(RevisionRepository.getFull(revision.id)).toMatchObject({ status: 'merged', mergedToDraftId: saved.id })
    } else if (change === 'deletion') {
      DraftRepository.delete(saved.id)
    } else {
      DraftRepository.updateContent(saved.id, edited, edited.length)
    }
    const independent = await generate(f, { ...f.begin, authorInputs, uiActionNonce: 'independent' })
    const reopened = f.reopen()
    expect(reopened.list().map(run => run.handle.runId)).toEqual(expect.arrayContaining([
      batch.rootHandle.runId, generated.run.handle.runId, independent.run.handle.runId,
    ]))
    expect(reopened.readContext(independent.run.handle).draftSave).toEqual({ kind: 'absent' })
    expect(reopened.readContext(generated.run.handle).draftSave).toEqual({ kind: 'changed' })
    expect(() => reopened.commitDraft(generated.request)).toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(f.fixture.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE run_id=?').all(generated.run.handle.runId)).toEqual(receipts)
    expect(DraftRepository.getFull(saved.id)?.content).toBe(change === 'deletion' ? undefined : edited)
    expect(f.fixture.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(change === 'deletion' ? 0 : 1)
    expect(f.dispatch).toHaveBeenCalledTimes(2)
    expect(reopened.listBatches()).toEqual([expect.objectContaining({ batchId: batch.batchId, sourceCurrent: false, nextChapterNumber: null })])
  })
  it('lists replaced batch drafts by their original receipt but refuses to advance', async () => {
    const f = drafting()
    f.db.exec("INSERT INTO blueprints(chapter_number,title) VALUES(2,'第二章')")
    const batch = f.owner.beginBatch({ mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 20,
      uiActionNonce: 'batch', modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const generated = await generate(f, { ...f.begin, authorInputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId })
    const saved = f.owner.commitDraft(generated.request)
    expect(f.owner.listBatches()[0]?.sourceCurrent).toBe(true)
    const replacement = DraftRepository.create({ chapterNumber: 1, source: 'write', content: '作者创建的新版本。', wordCount: 9 })
    const reopened = f.reopen()
    expect(reopened.listBatches()).toEqual([expect.objectContaining({ batchId: batch.batchId, sourceCurrent: false,
      nextChapterNumber: 2, completedChapters: [expect.objectContaining({ draftId: saved.id, version: saved.version, contentHash: saved.contentHash })] })])
    expect(() => reopened.readBatch(batch.batchId)).toThrow('GENERATION_BATCH_DRAFT_REPLACED')
    expect(() => reopened.begin({ ...f.begin, chapterNumber: 2, uiActionNonce: 'chapter2', authorInputs,
      batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId, selectedDraftIds: [saved.id] }))
      .toThrow('GENERATION_BATCH_DRAFT_REPLACED')
    expect(DraftRepository.getFull(saved.id)?.content).toBe(saved.content)
    expect(DraftRepository.getFull(replacement)?.content).toBe('作者创建的新版本。')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it.each(['draft_review', 'auto_finalize'] as const)('reads revised finalization without crediting the original %s batch', async mode => {
    const f = drafting()
    const batch = f.owner.beginBatch({ mode, range: { startChapter: 1, endChapter: 1 }, targetUnits: 20,
      uiActionNonce: 'batch', modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const generated = await generate(f, { ...f.begin, authorInputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId })
    const saved = f.owner.commitDraft(generated.request), revised = '林岚确认信封中的线索后，走向城门。'
    FinalizationRepository.commit({ finalizationId: 'revised-finalization', draftId: saved.id, chapterNumber: 1,
      chapterTitle: '第一章', content: revised, contentHash: textHash(revised), contentRevision: 1, targetFileName: '第一章.txt' })
    FinalizationRepository.markPublished('revised-finalization')
    const post = PostProcessRepository.createRun({ triggerSourceType: 'chapter_finalize', triggerSourceId: '1', sourceLabel: '第一章',
      finalizedSource: { finalizationId: 'revised-finalization', draftId: saved.id, chapterNumber: 1, contentHash: textHash(revised) },
      steps: [{ key: 'kb_import', label: '知识库', critical: true }, { key: 'chapter_notes', label: '章节笔记', critical: true }] })
    PostProcessRepository.markStepOk(post, 'kb_import')
    PostProcessRepository.markStepOk(post, 'chapter_notes')
    const reopened = f.reopen(), history = reopened.listBatches()[0]!
    expect(history).toMatchObject({ sourceCurrent: false, nextChapterNumber: mode === 'auto_finalize' ? 1 : null,
      completedChapters: [{ draftId: saved.id, contentHash: saved.contentHash, postProcessComplete: false }] })
    expect(history.currentChapterRunHandle).toBeUndefined()
    expect(history.completedChapters[0]?.finalizationId).toBeUndefined()
    expect(history.completedChapters[0]?.pendingFinalizationId).toBeUndefined()
    expect(() => reopened.confirmBatchFinalization({ batchId: batch.batchId, chapterNumber: 1, finalizationId: 'revised-finalization' }))
      .toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(() => reopened.commitDraft(generated.request)).toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(DraftRepository.getFull(saved.id)).toMatchObject({ status: 'finalized', content: revised })
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it.each(['hash', 'unrelated snapshot', 'chapter', 'unfinalized draft'])('rejects a corrupt %s outbox despite changed batch prose', async corruption => {
    const f = drafting()
    const batch = f.owner.beginBatch({ mode: 'auto_finalize', range: { startChapter: 1, endChapter: 1 }, targetUnits: 20,
      uiActionNonce: 'batch', modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const generated = await generate(f, { ...f.begin, authorInputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId })
    const saved = f.owner.commitDraft(generated.request), revised = '修订后的定稿正文。'
    FinalizationRepository.commit({ finalizationId: 'revised-finalization', draftId: saved.id, chapterNumber: 1,
      chapterTitle: '第一章', content: revised, contentHash: textHash(revised), contentRevision: 1, targetFileName: '第一章.txt' })
    if (corruption === 'hash') f.db.exec("UPDATE finalization_outbox SET content_hash='invalid'")
    if (corruption === 'unrelated snapshot') f.db.prepare('UPDATE finalization_outbox SET content_snapshot=?,content_hash=?')
      .run('无关但哈希自洽的正文。', textHash('无关但哈希自洽的正文。'))
    if (corruption === 'chapter') f.db.exec('UPDATE finalization_outbox SET chapter_number=2')
    if (corruption === 'unfinalized draft') f.db.exec("UPDATE drafts SET status='draft'")
    const reopened = f.reopen()
    expect(() => reopened.listBatches()).toThrow('GENERATION_BATCH_FINALIZATION_CONFLICT')
    expect(() => reopened.readBatch(batch.batchId)).toThrow('GENERATION_BATCH_FINALIZATION_CONFLICT')
  })
  it.each(['edited', 'replaced'])('keeps validating later receipts after an earlier batch draft is %s', async change => {
    const f = drafting()
    f.db.exec("INSERT INTO blueprints(chapter_number,title) VALUES(2,'第二章')")
    const batch = f.owner.beginBatch({ mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 20,
      uiActionNonce: 'batch', modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const selection = { ...f.begin, authorInputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId }
    const first = await generate(f, selection), saved = f.owner.commitDraft(first.request)
    const second = await generate(f, { ...selection, chapterNumber: 2, uiActionNonce: 'chapter2', selectedDraftIds: [saved.id] })
    f.owner.commitDraft(second.request)
    if (change === 'edited') DraftRepository.updateContent(saved.id, '作者修改后的正文。', 9)
    else DraftRepository.create({ chapterNumber: 1, source: 'write', content: '作者的新版本。', wordCount: 7 })
    f.db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.draftCommit.contentHash','invalid') WHERE run_id=?")
      .run(second.run.handle.runId)
    const reopened = f.reopen()
    expect(() => reopened.listBatches()).toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(() => reopened.readBatch(batch.batchId)).toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  })
  it('rejects corrupted batch receipts when listing history after reopen', async () => {
    const f = drafting()
    const batch = f.owner.beginBatch({ mode: 'draft_review', range: { startChapter: 1, endChapter: 1 }, targetUnits: 20,
      uiActionNonce: 'batch', modelId: f.model.id, authorInputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const generated = await generate(f, { ...f.begin, authorInputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId })
    const saved = f.owner.commitDraft(generated.request)
    f.db.exec("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.draftCommit.contentHash','invalid') WHERE json_extract(usage_receipt_json,'$.draftCommit') IS NOT NULL")
    const reopened = f.reopen()
    expect(() => reopened.listBatches()).toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(() => reopened.commitDraft(generated.request)).toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(DraftRepository.getFull(saved.id)?.content).toBe(draftText)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it.each([
    'UPDATE drafts SET version=version+1',
    "UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.draftCommit.contentHash','invalid')",
  ])('still rejects invalid saved history after reopen: %s', async corruption => {
    const f = drafting(), generated = await generate(f, { ...f.begin, authorInputs })
    f.owner.commitDraft(generated.request)
    f.db.exec(corruption)
    const reopened = f.reopen()
    expect(() => reopened.readContext(generated.run.handle)).toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(() => reopened.commitDraft(generated.request)).toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
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
      expect(reopened.readContext(generated.run.handle).draftSave).toEqual({ kind: 'current', receipt: saved })
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
  it('saves a complete oversized composition and replays the same receipt', async () => {
    const f = drafting(draftText.repeat(2)), generated = await generate(f, { ...f.begin, authorInputs })
    const saved = f.owner.commitDraft(generated.request)
    expect(saved.content).toBe(draftText.repeat(2))
    const reopened = f.reopen()
    expect(reopened.commitDraft(generated.request)).toEqual(saved)
    expect(reopened.readContext(generated.run.handle).draftSave).toEqual({ kind: 'current', receipt: saved })
    expect(f.fixture.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })

  it('refuses a selected LENGTH composition even when its count is in range', async () => {
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: draftText })
      return { finishReason: 'length', usage: null }
    })
    const f = fixture(dispatch)
    const generated = await generate({ ...f, fixture: f, dispatch }, { ...f.begin, authorInputs })
    expect(() => f.owner.commitDraft(generated.request)).toThrow('GENERATION_DRAFT_INCOMPLETE')
    expect(f.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(0)
  })
  it('composes the single condense revision as a replacement of the oversized draft and commits it', async () => {
    const texts = [draftText.repeat(2), draftText]
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: texts.shift()! })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    const generated = await generate({ ...f, fixture: f, dispatch }, { ...f.begin, authorInputs })
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
  it.each([1400, 1450])('saves the complete %i-unit condense revision without requiring a shorter replacement', async units => {
    const original = `${'原'.repeat(1400)}。`, replacement = `${'修'.repeat(units)}。`
    const texts = [original, replacement]
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: texts.shift()! })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch)
    const generated = await generate({ ...f, fixture: f, dispatch }, { ...f.begin, authorInputs: [{ id: 'draft:target-units', text: '1000' }] })
    const condense = await f.owner.execute({ handle: generated.run.handle, invocationNonce: 'draft:condense',
      task: { ...task, purpose: 'chapter-draft-condense' } })
    const composed = f.owner.composeVisible(generated.run.handle, [generated.raw.artifactId, condense.run.artifacts.at(-1)!.artifactId],
      undefined, DRAFT_VISIBLE_TEXT_VERSION)
    expect(composed.text).toBe(replacement)
    const saved = f.owner.commitDraft({ ...generated.request, expectedCompositionHash: textHash(replacement) })
    expect(saved).toMatchObject({ content: replacement, contentHash: textHash(replacement) })
    expect(f.db.prepare('SELECT c.body,d.word_count FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(saved.id))
      .toEqual({ body: replacement, word_count: units })
    expect(f.owner.readContext(generated.run.handle).attemptedPurposes).toEqual(['chapter-draft', 'chapter-draft-condense'])
    expect(dispatch).toHaveBeenCalledTimes(2)
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
    [2601, null],
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
  it('saves all 1350 units and advances the batch after the single condense remains over target', async () => {
    const initial = `${'长'.repeat(1400)}。`, condensed = `${'缩'.repeat(1350)}。`
    const texts = [initial, condensed]
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: texts.shift()! })
      return { finishReason: 'stop', usage: null }
    })
    const f = fixture(dispatch), inputs = [{ id: 'draft:target-units', text: '1000' }]
    f.db.exec("INSERT INTO blueprints(chapter_number,title) VALUES(2,'第二章')")
    const batch = f.owner.beginBatch({ mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 1000,
      uiActionNonce: 'oversized-batch', modelId: f.model.id, authorInputs: inputs, promptKeys: f.begin.promptKeys, skillStages: [] })
    const generated = await generate({ ...f, fixture: f, dispatch }, { ...f.begin, authorInputs: inputs, batchId: batch.batchId, parentRootActionId: batch.rootHandle.rootActionId })
    const condense = await f.owner.execute({ handle: generated.run.handle, invocationNonce: 'draft:condense', task: { ...task, purpose: 'chapter-draft-condense' } })
    f.owner.composeVisible(generated.run.handle, [generated.raw.artifactId, condense.run.artifacts.at(-1)!.artifactId], textHash(condensed), DRAFT_VISIBLE_TEXT_VERSION)
    const request = { ...generated.request, expectedCompositionHash: textHash(condensed) }
    const saved = f.owner.commitDraft(request)
    expect(saved).toMatchObject({ content: condensed, contentHash: textHash(condensed) })
    expect(f.db.prepare('SELECT c.body,d.word_count FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(saved.id)).toEqual({ body: condensed, word_count: 1350 })
    const reopened = f.reopen()
    expect(reopened.commitDraft(request)).toEqual(saved)
    expect(reopened.readBatch(batch.batchId)).toMatchObject({ nextChapterNumber: 2, completedChapters: [{ draftId: saved.id, contentHash: textHash(condensed) }] })
    expect(reopened.readContext(generated.run.handle).attemptedPurposes).toEqual(['chapter-draft', 'chapter-draft-condense'])
    expect(f.db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
  it('uses the selected STOP receipt even when the latest condense attempt fails', async () => {
    const initial = `${'长'.repeat(1400)}。`
    const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>()
      .mockImplementationOnce(async (_request, options) => {
        options.onVisible({ kind: 'delta', text: initial })
        return { finishReason: 'stop', usage: null }
      }).mockRejectedValueOnce(new Error('synthetic provider failure'))
    const f = fixture(dispatch)
    const generated = await generate({ ...f, fixture: f, dispatch }, { ...f.begin, authorInputs: [{ id: 'draft:target-units', text: '1000' }] })
    await f.owner.execute({ handle: generated.run.handle, invocationNonce: 'draft:condense', task: { ...task, purpose: 'chapter-draft-condense' } })
    expect(f.owner.commitDraft(generated.request).content).toBe(initial)
    expect(f.owner.readContext(generated.run.handle).attemptedPurposes).toEqual(['chapter-draft', 'chapter-draft-condense'])
    expect(dispatch).toHaveBeenCalledTimes(2)
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

it('uses one OpenCode conversation header across attempts and changes it for independent roots',async()=>{
 const f=fixture(), fetch=syntheticStream()
 f.model.baseUrl='https://opencode.ai/zen/go/v1'
 const run=f.owner.begin(f.begin)
 await f.owner.execute({handle:run.handle,invocationNonce:'one',task})
 await f.owner.execute({handle:run.handle,invocationNonce:'two',task})
 const other=f.owner.begin({...f.begin,uiActionNonce:'independent-conversation'})
 await f.owner.execute({handle:other.handle,invocationNonce:'one',task})
 expect(fetch.mock.calls.map(([,options])=>(options.headers as Record<string,string>)['x-opencode-session']))
   .toEqual([run.handle.rootActionId,run.handle.rootActionId,other.handle.rootActionId])
})
it('keeps the next plot-outline recovery chapter empty instead of duplicating the accepted chapter',async()=>{
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:outlineEntry(1)});return {finishReason:'stop',usage:null}})
 const run=f.owner.begin(outlineSelection(f,2))
 await f.owner.execute({handle:run.handle,invocationNonce:'first',task:outlineTask(run.plotOutline!)})
 acceptOutline(f.owner,run.handle)
 const recovery=f.owner.readContext(run.handle).plotOutlineRecovery!
 expect(recovery.draft.split(outlineEntry(1))).toHaveLength(2)
 expect(recovery.draft).toContain('## 第2章：')
})
