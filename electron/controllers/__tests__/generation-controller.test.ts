import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationOwnerChannels, BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { FinalizedCharacterGenerationChannels } from '../../../src/shared/finalized-character-generation'
import type { FinalizationGenerationChannels } from '../../../src/shared/finalization-generation'
import type { ReviewRevisionGenerationInvokeChannels, ReviewRevisionOperation } from '../../../src/shared/review-revision-generation'
import { createHumanConfirmedReviewSnapshot, renderHumanConfirmedReviewBrief, serializeHumanConfirmedReviewSnapshot } from '../../../src/shared/human-confirmed-review'
import { ipc } from '../../../src/services/ipc-client'
import { ReviewRepository } from '../../repositories/review-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { SummaryRepository } from '../../repositories/summary-repository'
import type { ModelProfile, ProjectSessionContext, NovelConfig } from '../../../src/shared/ipc-channels'
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null }))
import { registerGenerationController } from '../generation-controller'
import { registerDatabaseController } from '../db-controller'
import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import { getProjectDataRoot } from '../../services/project-data-locator'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { projectAccess } from '../../services/project-access'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../database'
import { textHash } from '../../repositories/generation-run-repository'
import { KnowledgeBaseUnavailableError, knowledgeBaseLoader } from '../../services/knowledge-base-loader'
import { LegacyVectorMigrationBlockedError } from '../../services/knowledge-base-migration-error'
import { GeneratePlotArchitectureCommand } from '../../../src/services/workflows/commands/architecture.command'
import { ReviewChapterCommand } from '../../../src/services/workflows/commands/review-chapter.command'
import { RefineDraftCommand } from '../../../src/services/workflows/commands/refine-draft.command'
import { useProjectStore } from '../../../src/stores/project-store'
import type { WorkflowContext, StepCallbacks } from '../../../src/stores/workflow-store'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'
import { PLOT_OUTLINE_PROTOCOL, renderPlotOutlineSynopsis } from '../../../src/shared/plot-outline-contract'
import { clearProjectCustomPrompts } from '../../../src/services/prompt-templates'
import { exportPortableProject } from '../../services/project-archive-service'
import { restorePortableProject } from '../../services/project-restore-service'
import { readPortableRuntimeFreeze } from '../../services/portable-runtime-freeze'

const model: ModelProfile = { id: 'fixture', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-only', maxTokens: 1024, temperature: 0.7, purposes: ['generation'] }
const sender = { isDestroyed: () => false, send: vi.fn() }
let root: string, session: ProjectSessionContext
let openedProject: ReturnType<typeof projectAccess.createProject>
const request: BeginGenerationRequest = { operation: 'draft', uiActionNonce: 'click', modelId: 'fixture',
  selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['first_chapter_draft'], skillStages: [], output: 'visible-text' }
const materialDecision = (prompt = '合成初始提示词'): NonNullable<BeginGenerationRequest['materialDecision']> => ({
  version: 1, verdict: 'admitted', promptHash: textHash(prompt),
  capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 12 },
  coverage: { required: 1, included: 1, complete: true },
  included: [{ sourceId: 'author:required', revision: 1, contentHash: 'a'.repeat(64), category: 'author', required: true, units: 12 }],
  omitted: [],
})
beforeAll(() => {
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, applyProxyConfig: () => {} })
  registerDatabaseController()
})
beforeEach(() => {
  const cache = path.resolve('.runtime/.cache/t12c')
  fs.mkdirSync(cache, { recursive: true })
  root = fs.mkdtempSync(path.join(cache, 'ipc-'))
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  const project = projectAccess.createProject(root, '合成小说')
  openedProject = project
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  getProjectDb()!.exec("INSERT INTO project_core(id,project_name,global_guidance) VALUES('main','合成小说','保留作者事实')")
  const lease = projectAccess.beginSession(project)
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
  sender.send.mockClear()
})
afterEach(() => { closeProjectDatabase(); projectAccess.invalidateCurrentSession(); useProjectStore.setState({ currentProject: null }); clearProjectCustomPrompts(); vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
type TestedChannels = GenerationOwnerChannels & FinalizedCharacterGenerationChannels & ReviewRevisionGenerationInvokeChannels & FinalizationGenerationChannels
function invoke<C extends keyof TestedChannels>(channel: C, ...args: TestedChannels[C]['args']) {
  return mocks.handlers.get(channel)!({ sender }, ...args, { ...session }) as Promise<TestedChannels[C]['return']>
}
function stream(content = '中文候选', reasoning?: string) {
  const fetch = vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
    controller.close()
  } }) }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
describe('generation public IPC with actual project authority and SQLite', () => {
  it.each(['review-chapter', 'refine-draft', 'refine-from-review'] as const)('routes %s through the renderer client, registered IPC, owner and actual formal repository', async operation => {
    const body = '林岚到达海港，发现了留下的信。'
    const revisedBody = '林岚到达海港，发现了父亲留下的信。'
    getProjectDb()!.exec("INSERT INTO blueprints(chapter_number,title) VALUES(1,'海港'); INSERT INTO contents(id,body) VALUES(1,''); INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,18)")
    getProjectDb()!.prepare('UPDATE contents SET body=? WHERE id=1').run(body)
    vi.stubGlobal('window', { aiNovelAPI: { invoke: (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender }, ...args) } })
    const source = { id: 1, chapterNumber: 1, version: 1, status: 'draft' as const, content: body }
    const prepare = (op: ReviewRevisionOperation, confirmation?: { reviewSourceId: number; confirmedReviewContent: string }) => ipc.invokeWithProjectSession(session, 'review-revision:prepare', {
      operation: op, draftId: 1, expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(body) },
      authorInputs: [], uiLocale: 'zh-CN', ...confirmation,
    })
    const report = JSON.stringify({ summary: '保持正文来源', items: [{ category: '连贯性', severity: 'pass', description: '正文与计划相符。' }] })
    const runStage = async (op: ReviewRevisionOperation, prepared: Awaited<ReturnType<typeof prepare>>) => {
      stream(op === 'review-chapter' ? report : revisedBody)
      const prompt = '仅处理原稿与作者确认意见。'
      const run = await ipc.invokeWithProjectSession(session, 'generation:begin', { operation: op, uiActionNonce: `明确作者动作:${op}`,
        modelId: prepared.modelId ?? model.id, chapterNumber: 1, selectedDraftIds: [1], selectedFinalizedDraftIds: [],
        promptKeys: [op === 'review-chapter' ? 'consistency_check' : op === 'refine-draft' ? 'refine_chapter' : 'refine_from_review'],
        skillStages: [op === 'review-chapter' ? 'review' : 'refinement'], output: op === 'review-chapter' ? 'structured-data' : 'visible-text',
        reviewRevisionContextId: prepared.contextId, authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(prepared.context) }],
        ...(prepared.parentRootActionId ? { parentRootActionId: prepared.parentRootActionId } : {}) })
      const confirmation = prepared.context.confirmation
      const reviewBrief = confirmation ? renderHumanConfirmedReviewBrief(confirmation.snapshot, prepared.context.writingLanguage) : ''
      const decision = confirmation
        ? { ...materialDecision(prompt), capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1' as const, admittedUnits: Buffer.byteLength(reviewBrief) },
          included: [{ sourceId: `review:confirmed:${confirmation.reviewSourceId}`, revision: confirmation.reviewSourceId,
            contentHash: textHash(reviewBrief), category: 'author' as const, required: true, units: Buffer.byteLength(reviewBrief) }] }
        : { ...materialDecision(prompt), capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1' as const, admittedUnits: 0 },
          coverage: { required: 0, included: 0, complete: true }, included: [] }
      const bound = await ipc.invokeWithProjectSession(session, 'generation:bind-material-decision', { handle: run.handle, materialDecision: decision })
      expect((await ipc.invokeWithProjectSession(session, 'generation:bind-material-decision', { handle: run.handle, materialDecision: decision })).handle)
        .toEqual(bound.handle)
      await expect(ipc.invokeWithProjectSession(session, 'generation:bind-material-decision', { handle: run.handle,
        materialDecision: { ...decision, promptHash: textHash('被替换的提示词') } })).rejects.toThrow('GENERATION_MATERIAL_DECISION_CONFLICT')
      const result = await ipc.invokeWithProjectSession(session, 'generation:execute', { handle: run.handle, invocationNonce: `实际请求:${op}`, task: {
        purpose: op, output: op === 'review-chapter' ? 'structured-data' : 'visible-text', messages: [{ role: 'user', content: prompt }],
      } })
      return { run, artifact: result.run.artifacts.at(-1)! }
    }
    let confirmation: { reviewSourceId: number; confirmedReviewContent: string } | undefined, originalRoot: string | undefined
    if (operation === 'refine-from-review') {
      const prepared = await prepare('review-chapter'), { run, artifact } = await runStage('review-chapter', prepared)
      const saved = await ipc.invokeWithProjectSession(session, 'review-revision:commit-review', { contextId: prepared.contextId, handle: run.handle,
        artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } })
      const snapshot = createHumanConfirmedReviewSnapshot({ sourceReviewId: saved.id, sourceDraft: source, summary: '', authorGuidance: '保留叙述视角',
        items: [{ category: '连贯性', severity: 'warning', description: '检查信件内容', quote: '留下的信', decision: 'apply', origin: 'author' }] })!
      const content = serializeHumanConfirmedReviewSnapshot(snapshot)
      const row = ReviewRepository.create({ baseDraftId: 1, content, expectedSource: source }, getProjectDb())
      confirmation = { reviewSourceId: row.id, confirmedReviewContent: content }; originalRoot = run.handle.rootActionId
    }
    const prepared = await prepare(operation, confirmation), { run, artifact } = await runStage(operation, prepared)
    if (operation !== 'review-chapter') expect(artifact.text).toBe(revisedBody)
    if (originalRoot) expect(run.handle.rootActionId).toBe(originalRoot)
    const reference = { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash }
    if (operation !== 'review-chapter') await ipc.invokeWithProjectSession(session, 'generation:compose-visible', run.handle, [artifact.artifactId], artifact.textHash)
    const save = () => operation === 'review-chapter'
      ? ipc.invokeWithProjectSession(session, 'review-revision:commit-review', { contextId: prepared.contextId, handle: run.handle, artifact: reference })
      : ipc.invokeWithProjectSession(session, 'review-revision:commit-revision', { contextId: prepared.contextId, handle: run.handle, expectedCompositionHash: artifact.textHash })
    if (operation === 'review-chapter') {
      const create = ReviewRepository.create
      vi.spyOn(ReviewRepository, 'create').mockImplementationOnce((params, db) => {
        db!.prepare('UPDATE contents SET body=? WHERE id=1').run('保存事务内源稿已变化')
        return create(params, db)
      })
      await expect(save()).rejects.toThrow('SOURCE_DRAFT_CHANGED')
      expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
      expect((await invoke('generation:read', run.handle)).candidates).toHaveLength(1)
    }
    const receipt = await save()
    const table = operation === 'review-chapter' ? 'reviews' : 'revisions'
    expect(receipt).toMatchObject({ success: true, kind: operation === 'review-chapter' ? 'review' : 'revision', source })
    expect(getProjectDb()!.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(1)
    expect(getProjectDb()!.prepare('SELECT body FROM contents WHERE id=1').pluck().get()).toBe(body)
    getProjectDb()!.prepare('UPDATE contents SET body=? WHERE id=1').run('作者后来修改源稿')
    expect(await save()).toEqual(receipt)
    const recovered = await ipc.invokeWithProjectSession(session, 'review-revision:read-recovery', { handle: run.handle })
    expect(recovered).toMatchObject({ sourceStatus: 'conflict', saved: receipt })
    expect((await invoke('generation:read', run.handle)).ledger?.physicalRequests).toBe(originalRoot ? 2 : 1)
  })
  it.each(['zh-CN', 'en-US'] as const)('localizes actual prepare source drift for review and refinement in %s', async uiLocale => {
    getProjectDb()!.exec("INSERT INTO contents(id,body) VALUES(1,'作者已保存的新稿'); INSERT INTO drafts(id,chapter_number,version,status,content_id) VALUES(1,1,1,'draft',1)")
    useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath,
      name: '合成小说', sessionLease: session.leaseId, characterStates: '', createdAt: '', updatedAt: '',
      novelConfig: { genre: '', subGenre: '', targetAudience: '', totalChapters: 1, wordsPerChapter: 2000,
        plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '' } } })
    vi.stubGlobal('window', { aiNovelAPI: { invoke: (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender }, ...args) } })
    const fetch = stream()
    const source = { draftPath: 'ai-novel://draft/1', draftContent: '选择时的旧稿', chapterNumber: 1,
      sourceDraft: { id: 1, chapterNumber: 1, version: 1, status: 'draft' as const, contentRevision: 1 } }
    await expect(invoke('review-revision:prepare', { operation: 'review-chapter', draftId: 1,
      expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(source.draftContent) },
      authorInputs: [], uiLocale })).rejects.toThrow('GENERATION_REVIEW_SOURCE_CHANGED')
    const context: WorkflowContext = { runId: 'stale-review-source', projectPath: session.projectPath, projectSession: session,
      writingLanguage: 'zh-CN', uiLocale, cancelled: false, data: {} }
    const callbacks: StepCallbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }
    const commands = [new ReviewChapterCommand(source), new RefineDraftCommand({ ...source,
      chapterInfo: { projectPath: session.projectPath, chapterNumber: 1, title: '', role: '', purpose: '', keyEvents: '', characters: [] } })]
    const messages = uiLocale === 'zh-CN'
      ? ['源草稿在 AI 审稿期间已变化。审稿报告未保存，请重新打开当前草稿后再次执行 AI 审稿。',
        '源草稿在 AI 修稿期间已变化。修订未保存，请重新打开当前草稿后再次执行 AI 修稿。']
      : ['The source draft changed during AI review. The review report was not saved. Reopen the current draft and run AI review again.',
        'The source draft changed during AI refinement. The revision was not saved. Reopen the current draft and run AI refinement again.']
    for (const [index, command] of commands.entries()) {
      await expect(command.execute({ step: {}, context, callbacks })).rejects.toMatchObject({ code: 'SOURCE_DRAFT_CHANGED', message: messages[index] })
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(getProjectDb()!.prepare('SELECT body FROM contents WHERE id=1').pluck().get()).toBe('作者已保存的新稿')
  })
  async function finalizedCharacterFixture() {
    const body = '林岚来到北塔。', characterId = 'character-fixture'
    getProjectDb()!.exec("INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔'); INSERT INTO characters(character_id,name) VALUES('character-fixture','林岚'); INSERT INTO contents(id,body) VALUES(1,'旧稿'); INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,2)")
    FinalizationRepository.commit({ finalizationId: 'ipc-finalized', draftId: 1, chapterNumber: 1, chapterTitle: '北塔',
      content: body, contentHash: textHash(body), contentRevision: 1, targetFileName: '第一章.txt' })
    const prepared = await invoke('finalized-character:read-context', { draftId: 1 })
    const fetch = stream(JSON.stringify({ updates: [{ characterId, currentState: { location: '北塔' }, evidence: { start: 0, end: body.length, text: body } }] }))
    const selection: BeginGenerationRequest = { ...request, operation: 'finalized-character-state', chapterNumber: 1, selectedFinalizedDraftIds: [1],
      output: 'structured-data', finalizedCharacterContextId: prepared.contextId, authorInputs: [{ id: 'finalized-character-context', text: JSON.stringify(prepared.context) }] }
    return { prepared, selection, fetch, characterId, slot: { source: prepared.context.source, stepKey: 'character_cards' as const } }
  }
  it('commits finalized character state through the registered context, generation and effect IPC', async () => {
    const f = await finalizedCharacterFixture()
    await expect(invoke('generation:begin', { ...f.selection, finalizedCharacterContextId: 'forged' })).rejects.toThrow('GENERATION_FINALIZATION_ADMISSION_REQUIRED')
    expect(f.fetch).not.toHaveBeenCalled()
    const { view: run } = await invoke('finalization-generation:begin', { slot: f.slot, modelId: model.id })
    const receipt = await invoke('finalization-generation:execute', { handle: run.handle })
    const artifact = receipt.run.artifacts.at(-1)!
    await expect(invoke('finalization-generation:commit', { handle: run.handle,
      artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } })).resolves.toMatchObject({ applied: 1, unresolved: [] })
    expect(getProjectDb()!.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('北塔')
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
  it('reports the registered field-conflict boundary and preserves the durable candidate', async () => {
    const f = await finalizedCharacterFixture(), { view: run } = await invoke('finalization-generation:begin', { slot: f.slot, modelId: model.id })
    const receipt = await invoke('finalization-generation:execute', { handle: run.handle })
    const artifact = receipt.run.artifacts.at(-1)!
    getProjectDb()!.prepare('UPDATE characters SET cs_location=? WHERE character_id=?').run('作者确认的新地点', f.characterId)
    await expect(invoke('finalization-generation:commit', { handle: run.handle,
      artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } })).rejects.toThrow('FINALIZED_CHARACTER_FIELD_CONFLICT')
    expect((await invoke('generation:read', run.handle)).candidates).toHaveLength(1)
    expect(getProjectDb()!.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('作者确认的新地点')
  })
  it('routes durable finalized state candidate decisions through the captured project owner', async () => {
    const body = '林岚来到北塔。', characterId = 'candidate-character'
    getProjectDb()!.exec("INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔'); INSERT INTO characters(character_id,name,cs_location,cs_provenance) VALUES('candidate-character','林岚','作者地点','{\"location\":{\"kind\":\"author\",\"chapterNumber\":0,\"revision\":1}}'); INSERT INTO contents(id,body) VALUES(1,'旧稿'); INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,2)")
    FinalizationRepository.commit({ finalizationId: 'ipc-state-candidate', draftId: 1, chapterNumber: 1, chapterTitle: '北塔',
      content: body, contentHash: textHash(body), contentRevision: 1, targetFileName: '第一章.txt' })
    const context = SummaryRepository.readFinalizedCharacterContext(1, { projectId: session.projectId, epoch: session.leaseId }, getProjectDb()!)
    SummaryRepository.saveFinalizedContinuity({ draftId: 1, chapterNumber: 1, chapterNotes: '定稿摘要', facts: [],
      source: context.source, projectionGeneration: context.projectionGeneration }, getProjectDb()!)
    SummaryRepository.commitFinalizedCharacterStates(context, { updates: [{ characterId, currentState: { location: '北塔' },
      evidence: { start: 0, end: body.length, text: body } }], unresolved: [] }, getProjectDb()!)

    const [summary] = await invoke('finalized-character:list-state-candidates')
    expect(summary).toMatchObject({ draftId: 1, characterId, field: 'location' })
    const candidate = await invoke('finalized-character:read-state-candidate', { draftId: summary.draftId, candidateKey: summary.candidateKey })
    const receipt = await invoke('finalized-character:decide-state-candidate', { draftId: summary.draftId,
      candidateKey: candidate.candidateKey, characterId: candidate.characterId, field: candidate.field,
      expectedFieldRevision: candidate.expectedFieldRevision, expectedFieldValueHash: candidate.expectedFieldValueHash,
      operationId: 'ipc-decline-state-candidate', decision: 'decline' })
    expect(receipt).toMatchObject({ decision: 'decline', idempotent: false })
    expect(await invoke('finalized-character:list-state-candidates')).toEqual([])
    expect(getProjectDb()!.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(characterId)).toBe('作者地点')
  })
  const draftInputs = [{ id: 'draft:target-units', text: '10' }]
  async function prepareDraft() {
    getProjectDb()!.exec("INSERT INTO blueprints(chapter_number,title) VALUES(1,'灯塔')")
    const preparation = await invoke('generation:prepare-draft-context', { chapterNumber: 1, modelId: model.id,
      promptKeys: request.promptKeys, skillStages: [], authorInputs: draftInputs, query: '灯塔', selectedDraftIds: [] })
    const selection = { ...request, operation: 'chapter-draft', chapterNumber: 1, authorInputs: draftInputs,
      selectedBlueprintChapterNumbers: [1, 2, 3, 4, 5, 6], preparationId: preparation.preparationId,
      materialDecision: materialDecision() }
    return { preparation, selection }
  }
  async function seedKnowledge() {
    const lance = await import('@lancedb/lancedb')
    const connection = await lance.connect(path.join(getProjectDataRoot(session.projectPath), 'lancedb'))
    const chunks = await connection.createTable('chunks', [{ id: '灯塔片段', docId: '原始资料', text: '灯塔位于旧城北岸。', fileName: '设定资料.md', chunkIndex: 0, totalChunks: 1, corpusKind: 'project-knowledge' }])
    const documents = await connection.createTable('documents', [{ id: '原始资料', fileName: '设定资料.md', chunkCount: 1, corpusKind: 'project-knowledge' }])
    chunks.close(); documents.close(); connection.close()
  }
  it('routes the explicit outline retry through project authority and SQLite without accepting renderer task or nonce', async () => {
    const { selection } = await prepareDraft()
    const prompt = '保留作者事实，规划细纲。'
    selection.materialDecision = { ...materialDecision(), shortOutlinePromptHash: textHash(prompt) }
    let physicalCalls = 0
    const fetch = vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
      const retried = ++physicalCalls === 2
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: retried ? '完整的细纲。' : '' }, finish_reason: retried ? 'stop' : 'length' }] })}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n`))
      controller.close()
    } }) }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', { aiNovelAPI: { invoke: (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender }, ...args) } })
    const run = await invoke('generation:begin', selection)
    const failed = await invoke('generation:execute', { handle: run.handle, invocationNonce: 'original',
      task: { purpose: 'chapter-draft-short-outline', output: 'visible-text', messages: [{ role: 'user', content: prompt }] } })
    const failedAttemptId = failed.outcome.receipt.visibleArtifact!.attemptId
    await invoke('generation:pause', run.handle)
    const resumed = await invoke('generation:resume', run.handle)
    const before = getProjectDb()!.prepare('SELECT * FROM generation_attempts WHERE attempt_id=?').get(failedAttemptId)
    const payload = { handle: resumed.handle, failedAttemptId, invocationNonce: 'renderer-chosen', task: { messages: [{ role: 'user', content: '替换原提示' }] } }
    await expect(mocks.handlers.get('generation:retry-draft-short-outline')!({ sender }, payload, { ...session, leaseId: 'stale' })).rejects.toThrow()
    const retried = await ipc.invokeWithProjectSession(session, 'generation:retry-draft-short-outline', payload)
    expect(retried.outcome).toMatchObject({ status: 'completed', content: '完整的细纲。' })
    expect(retried.run.handle.rootActionId).toBe(run.handle.rootActionId)
    expect(getProjectDb()!.prepare('SELECT * FROM generation_attempts WHERE attempt_id=?').get(failedAttemptId)).toEqual(before)
    expect(getProjectDb()!.prepare('SELECT invocation_nonce FROM generation_attempts ORDER BY rowid').pluck().all())
      .toEqual(['original', `draft-short-outline-retry:${failedAttemptId}`])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  async function selectedSourceFixture() {
    const database = getProjectDb()!
    database.exec("INSERT INTO blueprints(chapter_number,title) VALUES(1,'北岸'),(2,'灯塔'),(3,'港口')")
    const create = async (version: number) => {
      const result = await mocks.handlers.get('db:draft-create')!({ sender }, { chapterNumber: 1, version,
        source: 'write', content: `作者前章版本${version}`, wordCount: 7 }, session.projectPath, session) as { success: boolean; id: number }
      expect(result.success).toBe(true)
      return result.id
    }
    const selectedId = await create(1), archivedId = await create(2)
    database.prepare("UPDATE drafts SET status='archived' WHERE id=?").run(archivedId)
    const prepareRequest = { chapterNumber: 2, modelId: model.id, promptKeys: ['next_chapter_draft'],
      skillStages: [], authorInputs: draftInputs, query: '灯塔', selectedDraftIds: [selectedId] }
    const selectionFor = (preparationId: string): BeginGenerationRequest => ({ ...request, chapterNumber: 2,
      promptKeys: prepareRequest.promptKeys, authorInputs: draftInputs, selectedDraftIds: [selectedId],
      operation: 'chapter-draft', uiActionNonce: '明确开始', selectedBlueprintChapterNumbers: [2, 3, 4, 5, 6, 7], preparationId,
      materialDecision: materialDecision() })
    const editSource = () => database.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)').run('作者后来改写的前章', selectedId)
    return { selectedId, prepareRequest, selectionFor, editSource }
  }
  it.each([new KnowledgeBaseUnavailableError(new Error('native missing')),new LegacyVectorMigrationBlockedError('untrusted details')])('preserves known knowledge failure code before drafting',async error=>{
    const fixture=await selectedSourceFixture()
    vi.spyOn(knowledgeBaseLoader,'load').mockRejectedValueOnce(error)
    await expect(invoke('generation:prepare-draft-context',fixture.prepareRequest)).rejects.toThrow(error.code)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
  })
  it('requires an issued preparation and rejects source changes before opening a drafting root', async () => {
    const fetch = stream()
    await expect(invoke('generation:begin', { ...request, operation: 'chapter-draft', chapterNumber: 1 })).rejects.toThrow('GENERATION_DRAFT_PREPARATION_REQUIRED')
    const { selection } = await prepareDraft()
    await expect(invoke('generation:begin', { ...selection, preparationId: '伪造凭据' })).rejects.toThrow('GENERATION_DRAFT_PREPARATION_REQUIRED')
    getProjectDb()!.exec("UPDATE project_core SET global_guidance='作者修改后的指导'")
    await expect(invoke('generation:begin', selection)).rejects.toThrow('GENERATION_DRAFT_PREPARATION_CHANGED')
    expect(fetch).not.toHaveBeenCalled()
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
  })
  it.each(['edit', 'omit'] as const)('cannot replace a prepared source hidden behind an archived version: %s', async change => {
    const fetch = stream(), fixture = await selectedSourceFixture()
    const prepared = await invoke('generation:prepare-draft-context', fixture.prepareRequest)
    expect(prepared.selectedDrafts[0].content).toBe('作者前章版本1')
    const selection = fixture.selectionFor(prepared.preparationId)
    if (change === 'edit') fixture.editSource()
    else selection.selectedDraftIds = []
    await expect(invoke('generation:begin', selection)).rejects.toThrow('GENERATION_DRAFT_PREPARATION_CHANGED')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('admits a chapter draft that carries the sanitized material decision of its own admission', async () => {
    // S10B 步骤 3：写稿入口在 prepare 之后才拿到准入裁决，所以收据必须能与已签发的
    // preparation 并存——它不属于「准备期冻结源」，但必须被冻进运行并折进上下文指纹。
    const fetch = stream(), fixture = await selectedSourceFixture()
    const prepared = await invoke('generation:prepare-draft-context', fixture.prepareRequest)
    const decision = materialDecision()
    const run = await invoke('generation:begin', { ...fixture.selectionFor(prepared.preparationId), materialDecision: decision })
    const binding = JSON.parse(getProjectDb()!.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(run.handle.runId) as string) as {
      sourceManifest: Record<string, unknown>; fingerprint: { contextSnapshotHash: string }; contextSnapshotId: string }
    expect(binding.sourceManifest.materialDecision).toEqual(decision)
    expect(binding.sourceManifest.materialDecisionHash).toMatch(/^[a-f0-9]{64}$/)
    expect(binding.contextSnapshotId).toBe(`context:${binding.fingerprint.contextSnapshotHash}`)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a prepared chapter draft that omits the material decision before opening a root', async () => {
    const fetch = stream(), fixture = await selectedSourceFixture()
    const prepared = await invoke('generation:prepare-draft-context', fixture.prepareRequest)
    const selection = fixture.selectionFor(prepared.preparationId)
    delete selection.materialDecision
    await expect(invoke('generation:begin', selection)).rejects.toThrow('GENERATION_MATERIAL_DECISION_REQUIRED')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('checks the selected source across asynchronous knowledge preparation', async () => {
    const fixture = await selectedSourceFixture(), knowledgeBase = await knowledgeBaseLoader.load()
    vi.spyOn(knowledgeBaseLoader, 'load').mockImplementationOnce(async () => {
      fixture.editSource()
      return knowledgeBase
    })
    await expect(invoke('generation:prepare-draft-context', fixture.prepareRequest)).rejects.toThrow('GENERATION_DRAFT_PREPARATION_CHANGED')
  })
  it('keeps the original root active when a restart preparation is rejected', async () => {
    const fixture = await selectedSourceFixture()
    const prepared = await invoke('generation:prepare-draft-context', fixture.prepareRequest)
    const originalSelection = fixture.selectionFor(prepared.preparationId)
    const run = await invoke('generation:begin', originalSelection)
    const before = getProjectDb()!.prepare('SELECT * FROM generation_roots').all()
    fixture.editSource()
    await expect(invoke('generation:restart', run.handle, { ...originalSelection, uiActionNonce: '明确重新开始' })).rejects.toThrow('GENERATION_DRAFT_PREPARATION_CHANGED')
    expect(getProjectDb()!.prepare('SELECT * FROM generation_roots').all()).toEqual(before)
    const context = await invoke('generation:read-context', { handle: run.handle })
    expect(context.selectedDraftIds).toEqual([fixture.selectedId])
    expect(context.selectedDrafts).toBeUndefined()
  })
  it('rejects source edits while knowledge preparation is awaiting its reader', async () => {
    const fetch = stream(), knowledgeBase = await knowledgeBaseLoader.load()
    vi.spyOn(knowledgeBaseLoader, 'load').mockImplementationOnce(async () => {
      getProjectDb()!.exec("UPDATE project_core SET global_guidance='读取资料期间的作者修改'")
      return knowledgeBase
    })
    await expect(prepareDraft()).rejects.toThrow('GENERATION_DRAFT_PREPARATION_CHANGED')
    expect(fetch).not.toHaveBeenCalled()
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
  })
  it.each(['begin', 'restart'] as const)('rechecks prepared knowledge at %s before changing generation roots', async action => {
    await seedKnowledge()
    const fetch = stream(), old = action === 'restart' ? await invoke('generation:begin', request) : null
    const { selection } = await prepareDraft()
    const beforeRoots = getProjectDb()!.prepare('SELECT * FROM generation_roots').all()
    if (old) {
      await expect(invoke('generation:restart', old.handle, { ...selection, uiActionNonce: '重新开始', preparationId: undefined })).rejects.toThrow('GENERATION_DRAFT_PREPARATION_REQUIRED')
      await expect(invoke('generation:restart', old.handle, { ...selection, uiActionNonce: '重新开始', preparationId: '伪造凭据' })).rejects.toThrow('GENERATION_DRAFT_PREPARATION_REQUIRED')
    }
    const lance = await import('@lancedb/lancedb')
    const connection = await lance.connect(path.join(getProjectDataRoot(session.projectPath), 'lancedb'))
    const table = await connection.openTable('chunks')
    await table.update({ where: "id='灯塔片段'", values: { text: '准备后作者修改：灯塔在东岸。' } })
    table.close(); connection.close()
    const operation = old ? invoke('generation:restart', old.handle, { ...selection, uiActionNonce: '重新开始' }) : invoke('generation:begin', selection)
    await expect(operation).rejects.toThrow('GENERATION_KNOWLEDGE_SOURCE_STALE')
    expect(getProjectDb()!.prepare('SELECT * FROM generation_roots').all()).toEqual(beforeRoots)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('persists the main knowledge snapshot and reads a saved acknowledgement without new generation after reopen', async () => {
    await seedKnowledge()
    const fetch = stream('林岚沿旧城门走向灯塔。')
    const { selection, preparation } = await prepareDraft()
    expect(preparation.knowledgeSnapshot.items[0]?.documentId).toBe('原始资料')
    preparation.knowledgeSnapshot.items.length = 0
    const prompt = '保留灯塔设定，继续故事。'
    selection.materialDecision = materialDecision(prompt)
    const run = await invoke('generation:begin', selection)
    const result = await invoke('generation:execute', { handle: run.handle, invocationNonce: '正文', task: { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: prompt }] } })
    await invoke('generation:compose-visible', run.handle, [result.run.artifacts[0].artifactId], textHash(result.outcome.content), 'draft-visible-v1')
    const commit = { handle: run.handle, expectedCompositionHash: textHash(result.outcome.content), chapterNumber: 1, source: 'write' as const }
    const saved = await invoke('generation:commit-draft', commit)
    expect((await invoke('generation:read-context', { handle: run.handle })).knowledgeSnapshot?.items).toHaveLength(1)
    const projectPath = session.projectPath
    closeProjectDatabase(); projectAccess.invalidateCurrentSession()
    const project = projectAccess.probeExistingProject(projectPath)
    if (project.kind !== 'manifest') throw new Error('合成项目清单缺失')
    initProjectDatabase(projectPath)
    const lease = projectAccess.beginSession(project)
    session = { projectId: project.projectId, projectPath, leaseId: lease.leaseId }
    getProjectDb()!.exec("UPDATE project_core SET global_guidance='保存后作者修改'")
    expect(await invoke('generation:commit-draft', commit)).toEqual(saved)
    expect((await invoke('generation:read-context', { handle: run.handle })).draftSave).toEqual({ kind: 'current', receipt: saved })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('reads changed saved history but rejects all four generation actions before effects', async () => {
    const fetch = stream('林岚沿旧城门走向灯塔。')
    const { selection } = await prepareDraft()
    const run = await invoke('generation:begin', selection)
    const execution = { handle: run.handle, invocationNonce: '正文', task: { purpose: 'chapter-draft',
      output: 'visible-text' as const, messages: [{ role: 'user' as const, content: '合成初始提示词' }] } }
    const result = await invoke('generation:execute', execution)
    await invoke('generation:compose-visible', run.handle, [result.run.artifacts[0].artifactId], textHash(result.outcome.content), 'draft-visible-v1')
    const commit = { handle: run.handle, expectedCompositionHash: textHash(result.outcome.content), chapterNumber: 1, source: 'write' as const }
    const saved = await invoke('generation:commit-draft', commit)
    const db = getProjectDb()!
    db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)').run('作者修改后的当前正文。', saved.id)
    const attempts = db.prepare('SELECT * FROM generation_attempts').all()
    expect((await invoke('generation:read-context', { handle: run.handle })).draftSave).toEqual({ kind: 'changed' })
    await expect(invoke('generation:execute', { ...execution, invocationNonce: '不得重发' })).rejects.toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    await expect(invoke('generation:retry-draft-short-outline', { handle: run.handle, failedAttemptId: result.run.artifacts[0].attemptId }))
      .rejects.toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    await expect(invoke('generation:commit-draft', commit)).rejects.toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    await expect(invoke('generation:resume', run.handle)).rejects.toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(db.prepare('SELECT * FROM generation_attempts').all()).toEqual(attempts)
    expect(db.prepare('SELECT body FROM contents JOIN drafts ON drafts.content_id=contents.id WHERE drafts.id=?').pluck().get(saved.id))
      .toBe('作者修改后的当前正文。')
    expect(db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('retains generated prose when its knowledge source changes before saving', async () => {
    await seedKnowledge()
    stream('林岚在灯塔前停下，仔细检查那扇紧闭的木门。')
    const { selection } = await prepareDraft()
    const prompt = '根据资料继续故事。'
    selection.materialDecision = materialDecision(prompt)
    const run = await invoke('generation:begin', selection)
    const result = await invoke('generation:execute', { handle: run.handle, invocationNonce: '正文', task: { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: prompt }] } })
    await invoke('generation:compose-visible', run.handle, [result.run.artifacts[0].artifactId], textHash(result.outcome.content), 'draft-visible-v1')
    const lance = await import('@lancedb/lancedb')
    const connection = await lance.connect(path.join(getProjectDataRoot(session.projectPath), 'lancedb'))
    const table = await connection.openTable('chunks')
    await table.update({ where: "id='灯塔片段'", values: { text: '作者修订：灯塔位于东岸。' } })
    table.close(); connection.close()
    await expect(invoke('generation:commit-draft', { handle: run.handle, expectedCompositionHash: textHash(result.outcome.content), chapterNumber: 1, source: 'write' })).rejects.toThrow('GENERATION_KNOWLEDGE_SOURCE_STALE')
    expect((await invoke('generation:read', run.handle)).artifacts[0].text).toBe(result.outcome.content)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(0)
  })
  it.each(['core', 'template'])('rejects a changed %s at the actual formal commit channel and keeps the candidate', async source => {
    stream()
    const template = path.join(getProjectDataRoot(session.projectPath), 'prompts/first_chapter_draft.json')
    fs.mkdirSync(path.dirname(template), { recursive: true })
    fs.writeFileSync(template, JSON.stringify({ key: 'first_chapter_draft', content: '作者模板原文' }))
    const run = await invoke('generation:begin', request)
    await invoke('generation:execute', { handle: run.handle, invocationNonce: 'candidate', task: { purpose: 'draft', output: 'visible-text', messages: [{ role: 'user', content: '中文正文' }] } })
    if (source === 'core') getProjectDb()!.exec("UPDATE project_core SET global_guidance='作者更新约束'")
    else fs.writeFileSync(template, JSON.stringify({ key: 'first_chapter_draft', content: '作者新模板' }))
    const before = ProjectCoreRepository.get()
    const result = await mocks.handlers.get('db:project-core-commit-generated')!({ sender },
      { data: { worldbuilding: '不得覆盖的生成设定' }, generationRunHandle: run.handle }, session.projectPath, session)
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('GENERATION_SOURCE_CHANGED') })
    expect(ProjectCoreRepository.get()).toEqual(before)
    expect((await invoke('generation:read', run.handle)).candidates?.[0].text).toBe('中文候选')
  })
  it('checks live source bytes and writes once in the same actual SQLite transaction', async () => {
    const template = path.join(getProjectDataRoot(session.projectPath), 'prompts/first_chapter_draft.json')
    fs.mkdirSync(path.dirname(template), { recursive: true })
    fs.writeFileSync(template, JSON.stringify({ key: 'first_chapter_draft', content: '原始模板' }))
    const run = await invoke('generation:begin', request), database = getProjectDb()!
    const originalRead = fs.readFileSync, sourceTransactions: boolean[] = []
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === template) sourceTransactions.push(database.inTransaction)
      return originalRead(...args)
    })
    const originalUpdate = ProjectCoreRepository.update
    const writes = vi.spyOn(ProjectCoreRepository, 'update').mockImplementation(data => {
      expect(database.inTransaction).toBe(true)
      return originalUpdate(data)
    })
    expect(await mocks.handlers.get('db:project-core-commit-generated')!({ sender },
      { data: { worldbuilding: '正式设定', narrativePov: 'first_person' }, generationRunHandle: run.handle }, session.projectPath, session)).toEqual({ success: true })
    expect(writes).toHaveBeenCalledTimes(1)
    expect(sourceTransactions.length).toBeGreaterThan(0)
    expect(sourceTransactions.every(Boolean)).toBe(true)
    expect(ProjectCoreRepository.get()).toMatchObject({ worldbuilding: '正式设定', narrativePov: 'first_person' })
  })
  it('combines the synopsis CAS and source guard in one registered transaction', async () => {
    const run = await invoke('generation:begin', request), database = getProjectDb()!, expected = ProjectCoreRepository.get()!
    const original = ProjectCoreRepository.commitSynopsis
    const commit = vi.spyOn(ProjectCoreRepository, 'commitSynopsis').mockImplementation(input => {
      expect(database.inTransaction).toBe(true)
      return original(input)
    })
    const handler = mocks.handlers.get('db:project-core-synopsis-commit')!
    expect(await handler({ sender }, { synopsis: '过期值', expected: { ...expected, synopsis: '错误旧稿' }, generationRunHandle: run.handle }, session.projectPath, session)).toMatchObject({ success: false })
    expect(ProjectCoreRepository.get()?.synopsis).toBe(expected.synopsis)
    expect(await handler({ sender }, { synopsis: '正式大纲', expected, generationRunHandle: run.handle }, session.projectPath, session)).toEqual({ success: true })
    expect(ProjectCoreRepository.get()?.synopsis).toBe('正式大纲')
    commit.mockClear()
    expect(await handler({ sender }, { synopsis: '重复旧候选', expected, generationRunHandle: run.handle }, session.projectPath, session)).toMatchObject({ success: false, error: expect.stringContaining('GENERATION_SOURCE_CHANGED') })
    expect(commit).not.toHaveBeenCalled()
  })
  it('exposes begin, execute, read, list and durable snapshot without leaking model credentials', async () => {
    const fetch = stream('中文候选', '临时推理'), run = await invoke('generation:begin', request)
    const result = await invoke('generation:execute', { handle: run.handle, invocationNonce: 'physical-one',
      task: { purpose: 'draft', output: 'visible-text', messages: [{ role: 'user', content: '中文正文' }] } })
    expect(result.outcome.content).toBe('中文候选')
    expect(result.run.ledger?.physicalRequests).toBe(1)
    expect((await invoke('generation:list'))[0].handle).toEqual(run.handle)
    expect((await invoke('generation:read', run.handle)).artifacts[0].text).toBe('中文候选')
    expect(sender.send).toHaveBeenCalledWith('generation:snapshot', expect.objectContaining({ text: '中文候选', durableRevision: 1, status: 'completed' }))
    expect(sender.send).toHaveBeenCalledWith('generation:reasoning', expect.objectContaining({ ...run.handle, text: '临时推理' }))
    expect(JSON.stringify(result)).not.toContain('临时推理')
    expect(JSON.stringify(result)).not.toContain(model.apiKey)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects missing, stale, foreign-root and forged handle authority before touching an owner', async () => {
    const fetch = stream()
    await expect(mocks.handlers.get('generation:begin')!({ sender }, request)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    for (const invalid of [{ ...session, leaseId: 'forged' }, { ...session, projectPath: mocks.globalRoot }, { ...session, projectId: 'foreign' }]) {
      await expect(mocks.handlers.get('generation:begin')!({ sender }, request, invalid)).rejects.toThrow('GENERATION_REQUEST_FAILED')
    }
    const run = await invoke('generation:begin', request)
    await expect(invoke('generation:read', { ...run.handle, rootActionId: 'foreign' })).rejects.toThrow('GENERATION_RUN_IDENTITY_MISMATCH')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('requires source revalidation for public resume and leaves stale candidates readable', async () => {
    stream()
    const run = await invoke('generation:begin', request)
    await invoke('generation:execute', { handle: run.handle, invocationNonce: 'one', task: { purpose: 'draft', output: 'visible-text', messages: [{ role: 'user', content: '中文正文' }] } })
    await invoke('generation:pause', run.handle)
    getProjectDb()!.exec("UPDATE project_core SET global_guidance='作者更新规则'")
    await expect(invoke('generation:resume', run.handle)).rejects.toThrow('GENERATION_RECOVERY_UNAUTHORIZED')
    const read = await invoke('generation:read', run.handle)
    expect(read.candidates?.[0].text).toBe('中文候选')
    expect(read.nonReplayable).toBe(true)
    await invoke('generation:discard-candidate', run.handle, read.candidates![0].artifactId)
    expect((await invoke('generation:read', run.handle)).candidates).toHaveLength(0)
  })
})

describe('chapter outline command through registered main IPC and formal CAS', () => {
  type Crash = 'normal-saved' | 'composition-saved' | 'complete-before-cas' | 'cas-reply-lost'
  function outlineFixture(options: { chapters?: number; crash?: Crash; crashCall?: number; compact?: 'once' | 'fails'; customTemplate?: boolean } = {}) {
    const chapters = options.chapters ?? 3
    const premise = `${'前提原文。'.repeat(40)}前提尾部：证据原件必须留在岛上。`
    const characters = `${'角色原文。'.repeat(40)}角色尾部：林岚左手不能持重物。`
    const world = `${'世界原文。'.repeat(40)}世界尾部：渡口在日落后关闭。`
    const guidance = `${'作者指导。'.repeat(40)}指导尾部：结尾必须归还借来的钥匙。`
    const config: NovelConfig = { genre: '悬疑', subGenre: '', targetAudience: '', totalChapters: chapters, wordsPerChapter: 2000,
      plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '配置硬事实：受害者始终活着。',
      worldSetting: '配置背景：调查只在岛内开展。', goldenFinger: '', protagonistProfile: '', globalGuidance: guidance, writingLanguage: 'zh-CN' }
    getProjectDb()!.prepare('UPDATE project_core SET synopsis=?,premise=?,characters_arch=?,worldbuilding=?,genre=?,total_chapters=?,words_per_chapter=?,global_guidance=?')
      .run('旧正式大纲', premise, characters, world, config.genre, chapters, config.wordsPerChapter, guidance)
    const expected = ProjectCoreRepository.get()!
    if (options.customTemplate) {
      const dir = path.join(getProjectDataRoot(session.projectPath), 'prompts')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'synopsis.json'), JSON.stringify({ key: 'synopsis', name: '作者自定义', content: '以行动和后果组织当前章。', variables: {} }))
    }
    const syncProject = () => useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath,
      name: '合成小说', sessionLease: session.leaseId, novelConfig: config, characterStates: '', createdAt: '', updatedAt: '' } })
    syncProject()
    let fault = options.crash, calls = 0
    const prompts: string[] = [], accepted = (chapter: number) => `## 第${chapter}章：证词${chapter}\n林岚核对证词${chapter}，保留原件，并约定下一步。`
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] }
      const prompt = body.messages.find(message => message.role === 'user')!.content
      prompts.push(prompt)
      const chapter = Number(/本次只写第 (\d+) 章/u.exec(prompt)![1])
      const call = calls++
      const failed = !!options.compact && (call === 0 || options.compact === 'fails')
      const content = failed ? '## 第1–2章：FAILED-CANDIDATE\n不可采用的章组。' : accepted(chapter)
      return { ok: true, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: failed ? 'length' : 'stop' }] })}\n\ndata: [DONE]\n\n`))
        controller.close()
      } }) }
    })
    vi.stubGlobal('fetch', fetch)
    const bridge = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return fs.existsSync(String(args[0]))
      if (channel === 'fs:list-dir') return fs.readdirSync(String(args[0]), { withFileTypes: true }).map(item => ({ name: item.name, path: path.join(String(args[0]), item.name), isDir: item.isDirectory() }))
      if (channel === 'fs:read-file') return { success: true, content: fs.readFileSync(String(args[0]), 'utf8') }
      if (channel === 'fs:read-json') return fs.existsSync(String(args[0])) ? { success: true, data: JSON.parse(fs.readFileSync(String(args[0]), 'utf8')) } : { success: false }
      if (channel === 'fs:write-json') { fs.mkdirSync(path.dirname(String(args[0])), { recursive: true }); fs.writeFileSync(String(args[0]), JSON.stringify(args[1])); return { success: true } }
      if (channel === 'db:project-core-synopsis-commit' && fault === 'complete-before-cas') { fault = undefined; throw new Error('TEST_TRANSPORT_LOST_BEFORE_CAS') }
      const handler = mocks.handlers.get(channel)
      if (!handler) throw new Error(`UNEXPECTED_TEST_TRANSPORT:${channel}`)
      const result = await handler({ sender }, ...args)
      if (channel === 'generation:execute' && fault === 'normal-saved' && calls === (options.crashCall ?? 1)
        || channel === 'generation:compose-visible' && fault === 'composition-saved'
        || channel === 'db:project-core-synopsis-commit' && fault === 'cas-reply-lost') {
        fault = undefined
        throw new Error('TEST_TRANSPORT_REPLY_LOST')
      }
      return result
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke: bridge, on: () => () => {} } })
    const callbacks: StepCallbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn(), replaceText: vi.fn() }
    const execute = (resumeHandle?: MainGenerationRunHandle) => {
      const context: WorkflowContext = { runId: resumeHandle ? 'outline-resumed' : 'outline-original', projectPath: session.projectPath,
        projectSession: session, generationModelId: model.id, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', cancelled: false,
        data: { stepGuidance: { synopsis: '步骤尾部：最终章必须归还借来的钥匙。' } } }
      const command = new GeneratePlotArchitectureCommand(['synopsis'], { expectedProjectPath: session.projectPath, novelConfig: config }, undefined,
        resumeHandle ? { resumeSynopsis: true, resumeHandle } : { synopsisRange: { from: 1, to: chapters } })
      return command.execute({ step: {}, context, callbacks })
    }
    const reopen = () => {
      closeProjectDatabase(); projectAccess.invalidateCurrentSession(); initProjectDatabase(session.projectPath)
      session = { ...session, leaseId: projectAccess.beginSession(openedProject).leaseId }
      syncProject()
    }
    const navigation = () => JSON.parse(fs.readFileSync(path.join(getProjectDataRoot(session.projectPath), 'partial_arch.json'), 'utf8')) as { synopsis_generation_handle: MainGenerationRunHandle; synopsis_incomplete: boolean; synopsis_protocol: string; synopsis_result?: string }
    const target = renderPlotOutlineSynopsis(Array.from({ length: chapters }, (_, index) => accepted(index + 1)).join('\n\n'), chapters, expected)
    return { execute, reopen, navigation, target, accepted, fetch, bridge, prompts, expected, facts: [premise, characters, world, guidance, config.coreOutline, config.worldSetting] }
  }

  it('rebuilds once from complete original facts and accepts six chapters before a single formal CAS', async () => {
    const f = outlineFixture({ chapters: 6, compact: 'once', customTemplate: true })
    const original = ProjectCoreRepository.commitSynopsis
    const commit = vi.spyOn(ProjectCoreRepository, 'commitSynopsis').mockImplementation(input => {
      expect(getProjectDb()!.inTransaction).toBe(true)
      expect(ProjectCoreRepository.get()?.synopsis).toBe('旧正式大纲')
      return original(input)
    })
    await f.execute()
    expect(f.fetch).toHaveBeenCalledTimes(7)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(ProjectCoreRepository.get()?.synopsis).toBe(f.target)
    expect(f.navigation()).toMatchObject({ synopsis_protocol: PLOT_OUTLINE_PROTOCOL, synopsis_incomplete: false })
    expect(f.prompts[1]).toContain('本次从原始冻结事实和已接受前缀重新构建此章')
    for (const prompt of f.prompts) {
      for (const fact of f.facts) expect(prompt.split(fact)).toHaveLength(2)
      expect(prompt).toContain('步骤尾部：最终章必须归还借来的钥匙。')
      expect(prompt).not.toContain('FAILED-CANDIDATE')
    }
    expect(f.prompts[2]).toContain(f.accepted(1))
    const view = await invoke('generation:read', f.navigation().synopsis_generation_handle)
    expect(view.plotOutline?.composition?.artifactIds).toHaveLength(6)
    expect(view.ledger!.tokenLiability).toBeGreaterThan(7 * model.maxTokens!)
  })

  it('saves an author recovery prefix under the current lease without model calls or changing the old responsibility', async () => {
    const f = outlineFixture({ chapters: 3, compact: 'fails' })
    await expect(f.execute()).rejects.toThrow('attempts-exhausted')
    const handle = f.navigation().synopsis_generation_handle
    const attempts = getProjectDb()!.prepare('SELECT attempt_json FROM generation_attempts ORDER BY rowid').all()
    f.reopen()
    const roots = getProjectDb()!.prepare('SELECT * FROM generation_roots').all()
    const context = await invoke('generation:read-context', { handle })
    expect(context.plotOutlineRecovery).toMatchObject({ sourceHandle: handle, leaseEpoch: session.leaseId,
      completeChapters: [], writeState: { kind: 'ready' } })
    expect(context.plotOutlineRecovery!.draft).toContain('FAILED-CANDIDATE')
    const synopsis = renderPlotOutlineSynopsis('## 第1章：作者补齐\n作者核对证词，归还钥匙。', 1, context.plotOutline!.sourceExpected)
    const payload = { synopsis, expected: context.plotOutline!.sourceExpected,
      authorRecovery: { sourceHandle: handle, leaseEpoch: session.leaseId, operationId: 'author-recovery-1', committedRange: { from: 1, to: 1 } } }
    const commit = mocks.handlers.get('db:project-core-synopsis-commit')!
    expect(await commit({ sender }, { ...payload, authorRecovery: { ...payload.authorRecovery, leaseEpoch: handle.epoch } }, session.projectPath, session))
      .toMatchObject({ success: false, error: expect.stringContaining('GENERATION_EPOCH_STALE') })
    const saved = await commit({ sender }, payload, session.projectPath, session)
    expect(saved).toMatchObject({ success: true, receipt: { kind: 'author-edit', committedRange: { from: 1, to: 1 }, remainingRange: { from: 2, to: 3 }, idempotent: false } })
    expect(await commit({ sender }, payload, session.projectPath, session)).toMatchObject({ success: true, receipt: { idempotent: true } })
    expect(ProjectCoreRepository.get()?.synopsis).toBe(synopsis)
    expect(getProjectDb()!.prepare('SELECT attempt_json FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(getProjectDb()!.prepare('SELECT * FROM generation_roots').all()).toEqual(roots)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    await expect(invoke('generation:resume', handle)).rejects.toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    f.reopen()
    const recovered = await invoke('generation:read-context', { handle })
    expect(recovered.plotOutlineRecovery).toMatchObject({ draft: synopsis, writeState: { kind: 'blocked', reason: 'author-saved' }, saved: { operationId: 'author-recovery-1' } })
    expect(await commit({ sender }, { ...payload, authorRecovery: { ...payload.authorRecovery, leaseEpoch: session.leaseId } }, session.projectPath, session))
      .toMatchObject({ success: true, receipt: { idempotent: true } })
    const archivePath = path.join(root, 'outline-author.zip'), restoredRoot = path.join(root, 'restored-author')
    await exportPortableProject({ sourceProjectRoot: session.projectPath, projectSession: session, targetArchivePath: archivePath,
      attemptParentPath: root, assertCurrentContext: context => { expect(context).toEqual(session) },
      assets: { snapshot: () => ({ files: [], verifyUnchanged: () => {} }) } })
    await restorePortableProject({ archivePath, targetProjectRoot: restoredRoot })
    const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
    const restored = new Database(path.join(restoredRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      expect(ProjectCoreRepository.get(restored)!.synopsis).toBe(synopsis)
      expect(restored.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(handle.runId)).toBe('{}')
      expect(readPortableRuntimeFreeze(restoredRoot).isFrozen('generation_runs', handle.runId)).toBe(true)
      expect(() => readPortableRuntimeFreeze(restoredRoot).assertMutable('generation_roots', handle.rootActionId)).toThrow('PORTABLE_RUNTIME_FROZEN')
    } finally { restored.close() }
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['normal-saved', 'composition-saved', 'complete-before-cas', 'cas-reply-lost'] as const)('recovers %s through actual command, transport and a new project lease', async crash => {
    const f = outlineFixture({ crash }), commit = vi.spyOn(ProjectCoreRepository, 'commitSynopsis')
    await expect(f.execute()).rejects.toThrow('TEST_TRANSPORT_')
    const handle = f.navigation().synopsis_generation_handle
    const before = await invoke('generation:read', handle)
    expect(before.plotOutline!.cursor.kind).toBe(crash === 'normal-saved' ? 'accept' : crash === 'composition-saved' ? 'request' : 'complete')
    expect(ProjectCoreRepository.get()?.synopsis).toBe(crash === 'cas-reply-lost' ? f.target : '旧正式大纲')
    const attempts = getProjectDb()!.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    const binding = getProjectDb()!.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(handle.runId)
    f.reopen()
    expect(session.leaseId).not.toBe(handle.epoch)
    await f.execute(handle)
    expect(ProjectCoreRepository.get()?.synopsis).toBe(f.target)
    expect(f.fetch).toHaveBeenCalledTimes(3)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(f.navigation().synopsis_incomplete).toBe(false)
    if (crash === 'cas-reply-lost') {
      expect(getProjectDb()!.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
      expect(getProjectDb()!.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(handle.runId)).toBe(binding)
      expect(f.bridge.mock.calls.filter(([channel]) => channel === 'generation:cancel')).toHaveLength(0)
      await expect(invoke('generation:execute', { handle, invocationNonce: 'historical-execution', task: { purpose: 'plot-outline:chapter:1:normal', output: 'visible-text', messages: [] } })).rejects.toThrow()
    }
  })

  it('keeps both failed whole-chapter candidates and the formal original after double LENGTH', async () => {
    const f = outlineFixture({ compact: 'fails' }), commit = vi.spyOn(ProjectCoreRepository, 'commitSynopsis')
    await expect(f.execute()).rejects.toThrow('attempts-exhausted')
    expect(ProjectCoreRepository.get()?.synopsis).toBe('旧正式大纲')
    expect(commit).not.toHaveBeenCalled()
    const handle = f.navigation().synopsis_generation_handle
    const view = await invoke('generation:read', handle)
    expect(view.candidates).toHaveLength(2)
    expect(view.plotOutline!.composition).toBeNull()
    f.reopen()
    await expect(f.execute(handle)).rejects.toThrow('attempts-exhausted')
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(ProjectCoreRepository.get()?.synopsis).toBe('旧正式大纲')
  })

  it.each(['third-text', 'other-core', 'prompt', 'model'] as const)('refuses lost-CAS-response recovery when %s changed', async changed => {
    const f = outlineFixture({ crash: 'cas-reply-lost' })
    await expect(f.execute()).rejects.toThrow('TEST_TRANSPORT_REPLY_LOST')
    const handle = f.navigation().synopsis_generation_handle
    const temperature = model.temperature
    if (changed === 'third-text') getProjectDb()!.prepare('UPDATE project_core SET synopsis=?').run('作者第三种正文')
    if (changed === 'other-core') getProjectDb()!.prepare('UPDATE project_core SET worldbuilding=?').run('作者更新世界观')
    if (changed === 'prompt') {
      const dir = path.join(getProjectDataRoot(session.projectPath), 'prompts')
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'synopsis.json'), JSON.stringify({ key: 'synopsis', content: '新模板' }))
    }
    if (changed === 'model') model.temperature = 0.1
    const saved = ProjectCoreRepository.get()!
    try {
      f.reopen()
      await expect(f.execute(handle)).rejects.toThrow(/GENERATION_(?:SOURCE_CHANGED|RECOVERY_UNAUTHORIZED|MODEL_CHANGED)/u)
      expect(ProjectCoreRepository.get()).toEqual(saved)
      expect(f.fetch).toHaveBeenCalledTimes(3)
    } finally { model.temperature = temperature }
  })
})
