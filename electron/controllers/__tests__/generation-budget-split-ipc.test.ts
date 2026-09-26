import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import { ipc } from '../../../src/services/ipc-client'
import { classifyGenerationFailure } from '../../../src/services/generation/prompt-budget-failure'
import { projectAccess } from '../../services/project-access'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../database'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null }))

import { registerGenerationController } from '../generation-controller'
import { registerDatabaseController } from '../db-controller'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

/**
 * 三个模型都指向官方 OpenAI host。已知模型带 verified 预算，未知模型带同样的
 * 用户上限但没有 provider 容量证据。旧实现会让未知模型沿无 demand 分支发送。
 */
const known: ModelProfile = { id: 'known', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-only', maxTokens: 16_384, temperature: 0.7, purposes: ['generation'] }
const tiny: ModelProfile = { ...known, id: 'tiny', maxTokens: 1024 }
const unknown: ModelProfile = { ...known, id: 'unknown', modelName: 'unknown-future-model' }
/** 目录里只带运维默认值的模型，用来守住「能选中就必须能生成」。 */
const catalog: ModelProfile = { ...known, id: 'catalog', modelName: 'gpt-4o', maxTokens: 2048 }
const models: Record<string, ModelProfile> = { known, tiny, unknown, catalog }
const loadModel = (id: string): ModelProfile | null => models[id] ?? null

const sender = { isDestroyed: () => false, send: vi.fn() }
let root = '', session: ProjectSessionContext
const task: GenerationTask = { purpose: 'chapter-draft', output: 'visible-text',
  messages: [{ role: 'user', content: '保留作者事实，创作中文段落。' }] }

beforeAll(() => {
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel }), loadModel, applyProxyConfig: () => {} })
  registerDatabaseController()
})

beforeEach(() => {
  const base = path.join(os.tmpdir(), 'an-budget-ipc-')
  root = fs.mkdtempSync(base)
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  const project = projectAccess.createProject(root, '合成小说')
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  getProjectDb()!.exec("INSERT INTO project_core(id,project_name,global_guidance) VALUES('main','合成小说','保留作者事实'); INSERT INTO blueprints(chapter_number,title) VALUES(1,'第一章')")
  const lease = projectAccess.beginSession(project)
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
  vi.stubGlobal('window', { aiNovelAPI: { invoke: (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender }, ...args) } })
  sender.send.mockClear()
})
afterEach(() => {
  closeProjectDatabase(); projectAccess.invalidateCurrentSession(); vi.unstubAllGlobals()
  if (root) fs.rmSync(root, { recursive: true, force: true }); root = ''
})

/** Synthetic provider stream. Its call count is the physical model-call count. */
function syntheticProvider(content = '中文候选') {
  const fetch = vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
    controller.close()
  } }) }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
async function begin(modelId: string, extra: Partial<BeginGenerationRequest> = {}): Promise<MainGenerationRunHandle> {
  const view = await ipc.invokeWithProjectSession(session, 'generation:begin', { operation: 'draft', uiActionNonce: `作者点击:${modelId}`,
    modelId, chapterNumber: 1, selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['first_chapter_draft'], skillStages: [], output: 'visible-text', ...extra })
  return view.handle
}
function run(input: GenerationTask, nonce: string, handle: MainGenerationRunHandle) {
  return ipc.invokeWithProjectSession(session, 'generation:execute', { handle, invocationNonce: nonce, task: input })
}
/** Asserts rejection and returns the thrown error without widening to the success type. */
function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(() => { throw new Error('EXPECTED_REJECTION') }, (reason: unknown) => reason as Error)
}
const attemptCount = () => getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get() as number
async function ledger(handle: MainGenerationRunHandle) {
  return (await ipc.invokeWithProjectSession(session, 'generation:read', handle)).ledger?.physicalRequests
}
const demand = (overrides: Partial<{ kind: 'draft-units'; writingLanguage: 'zh-CN'; requestedUnits: number; segmentable: boolean }> = {}) => ({
  ...task, purpose: 'chapter-draft', budgetDemand: { kind: 'draft-units' as const, writingLanguage: 'zh-CN' as const, requestedUnits: 20_000, segmentable: true, ...overrides } })

describe('S07 budget admission through the actually registered generation IPC', () => {
  it('reports a safe split over IPC and reserves nothing before dispatch', async () => {
    const fetch = syntheticProvider()
    const handle = await begin('known')
    const error = await rejectionOf(run(demand(), '超限拆分', handle))
    expect(error.message).toMatch(/^TASK_BUDGET_SCOPE_SPLIT_REQUIRED:\d+$/u)
    // 这条稳定类别必须被共享分类器识别成 preflight，而不是落到 unknown。
    expect(classifyGenerationFailure(error.message, null)).toBe('capacity-preflight')

    expect(fetch).not.toHaveBeenCalled()
    expect(attemptCount()).toBe(0)
    // dispatch 前不 reserve：根账本没有物理请求，也没有持久化 attempt。
    expect(await ledger(handle)).toBe(0)
  })

  it('reports a capacity conflict over IPC when the scope cannot be segmented', async () => {
    const fetch = syntheticProvider()
    const handle = await begin('known')
    const error = await rejectionOf(run(demand({ segmentable: false }), '不可拆分', handle))
    expect(error.message).toContain('TASK_BUDGET_CAPACITY_CONFLICT')
    expect(classifyGenerationFailure(error.message, null)).toBe('capacity-preflight')

    expect(fetch).not.toHaveBeenCalled()
    expect(attemptCount()).toBe(0)
    expect(await ledger(handle)).toBe(0)
  })

  it('reports a capacity conflict over IPC when one structured item cannot fit', async () => {
    const fetch = syntheticProvider()
    const handle = await begin('tiny', { outputOverrides: [{ purpose: 'chapter:structured', output: 'structured-data' }] })
    await expect(run({ purpose: 'chapter:structured', output: 'structured-data',
      messages: [{ role: 'user', content: '保留作者事实，创作中文段落。' }],
      budgetDemand: { kind: 'structured-items', writingLanguage: 'zh-CN', requestedItems: 1 } }, '单项超限', handle))
      .rejects.toThrow('TASK_BUDGET_CAPACITY_CONFLICT')

    expect(fetch).not.toHaveBeenCalled()
    expect(attemptCount()).toBe(0)
    expect(await ledger(handle)).toBe(0)
  })

  it('persists the ready budget decision before dispatch and still reads it after reopen', async () => {
    const fetch = syntheticProvider()
    const handle = await begin('known')
    await run(demand({ requestedUnits: 100 }), '正常派遣', handle)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(attemptCount()).toBe(1)
    expect(await ledger(handle)).toBe(1)
    const stored = getProjectDb()!.prepare('SELECT usage_receipt_json FROM generation_attempts ORDER BY rowid').get() as { usage_receipt_json: string }
    expect(JSON.parse(stored.usage_receipt_json).budgetDecision)
      .toMatchObject({ decision: 'ready', requestedQuantity: 100, policyVersion: 's07-task-budget-v1' })

    // 重开物理数据库读取同一条已落盘决策，证明它不是进程内状态。
    const file = getProjectDb()!.name
    closeProjectDatabase()
    const reopened = new Database(file)
    const persisted = reopened.prepare('SELECT usage_receipt_json FROM generation_attempts ORDER BY rowid').get() as { usage_receipt_json: string }
    reopened.close()
    expect(JSON.parse(persisted.usage_receipt_json)).toEqual(JSON.parse(stored.usage_receipt_json))
  })

  it('still dispatches a shipped catalog model that only has an operational default cap', async () => {
    const fetch = syntheticProvider()
    const handle = await begin('catalog')
    await run(demand({ requestedUnits: 100 }), '目录模型派遣', handle)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(attemptCount()).toBe(1)
    expect(await ledger(handle)).toBe(1)
  })

  it('fails closed over IPC for an unknown model on an official host without a demand', async () => {
    const fetch = syntheticProvider()
    const handle = await begin('unknown')
    await expect(run(task, '未知模型', handle)).rejects.toThrow('GENERATION_MODEL_CAPABILITY_UNKNOWN')

    expect(fetch).not.toHaveBeenCalled()
    expect(attemptCount()).toBe(0)
    expect(await ledger(handle)).toBe(0)
  })
})
