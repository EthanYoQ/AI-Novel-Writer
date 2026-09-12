import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationOwnerChannels, BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
import { registerGenerationController } from '../generation-controller'
import { registerDatabaseController } from '../db-controller'
import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import { getProjectDataRoot } from '../../services/project-data-locator'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { projectAccess } from '../../services/project-access'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../database'

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
function stream() {
  const fetch = vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"中文候选"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
    controller.close()
  } }) }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
describe('generation public IPC with actual project authority and SQLite', () => {
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
