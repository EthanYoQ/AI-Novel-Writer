import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationOwnerChannels, BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
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
import { knowledgeBaseLoader } from '../../services/knowledge-base-loader'

const model: ModelProfile = { id: 'fixture', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-only', maxTokens: 1024, temperature: 0.7, purposes: ['generation'] }
const sender = { isDestroyed: () => false, send: vi.fn() }
let root: string, session: ProjectSessionContext
const request: BeginGenerationRequest = { operation: 'draft', uiActionNonce: 'click', modelId: 'fixture',
  selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['first_chapter_draft'], skillStages: [], output: 'visible-text' }
beforeAll(() => {
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, applyProxyConfig: () => {} })
  registerDatabaseController()
})
beforeEach(() => {
  const base = path.resolve('.runtime/.cache/s05-ipc')
  fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, 'case-'))
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  const project = projectAccess.createProject(root, '合成小说')
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  getProjectDb()!.exec("INSERT INTO project_core(id,project_name,global_guidance) VALUES('main','合成小说','保留作者事实')")
  const lease = projectAccess.beginSession(project)
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
  sender.send.mockClear()
})
afterEach(() => { closeProjectDatabase(); projectAccess.invalidateCurrentSession(); vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
function invoke<C extends keyof GenerationOwnerChannels>(channel: C, ...args: GenerationOwnerChannels[C]['args']) {
  return mocks.handlers.get(channel)!({ sender }, ...args, { ...session }) as Promise<GenerationOwnerChannels[C]['return']>
}
function stream(content = '中文候选') {
  const fetch = vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
    controller.close()
  } }) }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
describe('generation public IPC with actual project authority and SQLite', () => {
  const draftInputs = [{ id: 'draft:target-units', text: '10' }]
  async function prepareDraft() {
    getProjectDb()!.exec("INSERT INTO blueprints(chapter_number,title) VALUES(1,'灯塔')")
    const preparation = await invoke('generation:prepare-draft-context', { chapterNumber: 1, modelId: model.id,
      promptKeys: request.promptKeys, skillStages: [], authorInputs: draftInputs, query: '灯塔', selectedDraftIds: [] })
    const selection = { ...request, operation: 'chapter-draft', chapterNumber: 1, authorInputs: draftInputs,
      selectedBlueprintChapterNumbers: [1, 2, 3, 4, 5, 6], preparationId: preparation.preparationId }
    return { preparation, selection }
  }
  async function seedKnowledge() {
    const lance = await import('@lancedb/lancedb')
    const connection = await lance.connect(path.join(getProjectDataRoot(session.projectPath), 'lancedb'))
    const chunks = await connection.createTable('chunks', [{ id: '灯塔片段', docId: '原始资料', text: '灯塔位于旧城北岸。', fileName: '设定资料.md', chunkIndex: 0, totalChunks: 1, corpusKind: 'project-knowledge' }])
    const documents = await connection.createTable('documents', [{ id: '原始资料', fileName: '设定资料.md', chunkCount: 1, corpusKind: 'project-knowledge' }])
    chunks.close(); documents.close(); connection.close()
  }
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
      operation: 'chapter-draft', uiActionNonce: '明确开始', selectedBlueprintChapterNumbers: [2, 3, 4, 5, 6, 7], preparationId })
    const editSource = () => database.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)').run('作者后来改写的前章', selectedId)
    return { selectedId, prepareRequest, selectionFor, editSource }
  }
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
    const fetch = stream('林岚沿着旧城门的青石路走向灯塔。')
    const { selection, preparation } = await prepareDraft()
    expect(preparation.knowledgeSnapshot.items[0]?.documentId).toBe('原始资料')
    preparation.knowledgeSnapshot.items.length = 0
    const run = await invoke('generation:begin', selection)
    const result = await invoke('generation:execute', { handle: run.handle, invocationNonce: '正文', task: { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: '保留灯塔设定，继续故事。' }] } })
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
    expect((await invoke('generation:read-context', { handle: run.handle })).savedDraft).toEqual(saved)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('retains generated prose when its knowledge source changes before saving', async () => {
    await seedKnowledge()
    stream('林岚在灯塔前停下，仔细检查那扇紧闭的木门。')
    const { selection } = await prepareDraft()
    const run = await invoke('generation:begin', selection)
    const result = await invoke('generation:execute', { handle: run.handle, invocationNonce: '正文', task: { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: '根据资料继续故事。' }] } })
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
    const fetch = stream(), run = await invoke('generation:begin', request)
    const result = await invoke('generation:execute', { handle: run.handle, invocationNonce: 'physical-one',
      task: { purpose: 'draft', output: 'visible-text', messages: [{ role: 'user', content: '中文正文' }] } })
    expect(result.outcome.content).toBe('中文候选')
    expect(result.run.ledger?.physicalRequests).toBe(1)
    expect((await invoke('generation:list'))[0].handle).toEqual(run.handle)
    expect((await invoke('generation:read', run.handle)).artifacts[0].text).toBe('中文候选')
    expect(sender.send).toHaveBeenCalledWith('generation:snapshot', expect.objectContaining({ text: '中文候选', durableRevision: 1, status: 'completed' }))
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
