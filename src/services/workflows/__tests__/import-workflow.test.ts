import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))
const characterSyncMocks = vi.hoisted(() => ({ retry: vi.fn() }))
const commandMocks = vi.hoisted(() => ({ blueprintContext: undefined as WorkflowContext | undefined }))
vi.mock('../../ipc-client', () => ({
  ipc: { invokeWithProjectSession: ipcMocks.invoke },
}))
vi.mock('../directory-character-sync-recovery', () => ({
  retryDirectoryCharacterSync: characterSyncMocks.retry,
}))
vi.mock('../commands/import-novel.command', () => ({
  InferBlueprintsPerChapterCommand: class {
    async execute(params: { context: WorkflowContext }): Promise<void> {
      commandMocks.blueprintContext = params.context
      throw new Error('stop-after-blueprint-prompt-context')
    }
  },
}))

import { createImportWorkflow, loadAuthorImportChapterNumbers } from '../import-workflow'
import {
  IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
  type ImportRunEffectReceipt,
  type ImportRunSnapshot,
} from '../../../shared/import-run'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'
import { useProjectStore } from '../../../stores/project-store'

const session = { projectId: 'test-project', leaseId: 'lease-test-project', projectPath: 'C:\\test-project' }
const executionOwner = 'test-import-executor'

function run(overrides: Partial<ImportRunSnapshot> = {}): ImportRunSnapshot {
  return {
    id: 'import-run-1', purpose: 'reference', rootRunId: 'import-run-1', effectNamespace: 'import:reference:import-run-1',
    sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: 20 }],
    locale: 'zh-CN', stage: 'knowledge', status: 'running', completedBatches: {},
    lastError: '', resumable: true, cancelRequested: false, totalChapters: 1,
    totalContentSize: 20, manifestChapterCount: 1, manifestContentSize: 20,
    manifestWordCount: 20, completedChapters: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
    ...overrides,
  }
}

const callbacks: StepCallbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }

function context(): WorkflowContext {
  return {
    runId: 'import-run-1', projectPath: session.projectPath, projectSession: session,
    writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  characterSyncMocks.retry.mockResolvedValue({ operationId: 'sync-1' })
  useProjectStore.setState({
    currentProject: {
      id: 'test-project', sessionLease: 'lease-test-project', name: '测试项目', path: session.projectPath,
      novelConfig: {} as never, characterStates: '', createdAt: '', updatedAt: '',
    },
  })
})

afterEach(() => useProjectStore.setState({ currentProject: null }))

describe('createImportWorkflow', () => {
  it('loads sparse frozen chapter numbers from a resumed author run manifest', async () => {
    const snapshot = run({
      purpose: 'author-manuscript',
      effectNamespace: 'import:author-manuscript:import-run-1',
      stage: 'author-publish',
      totalChapters: 2,
      manifestChapterCount: 2,
      authorityFingerprint: 'c'.repeat(64),
    })
    ipcMocks.invoke.mockImplementation(async (_session, _channel, _runId, after) => (
      after === 0
        ? [
            { number: 2, title: 'Second', contentFingerprint: 'a'.repeat(64), contentSize: 1, content: 'a' },
            { number: 7, title: 'Seventh', contentFingerprint: 'b'.repeat(64), contentSize: 1, content: 'b' },
          ]
        : []
    ))

    await expect(loadAuthorImportChapterNumbers(snapshot, session, session.projectPath))
      .resolves.toEqual([2, 7])
    expect(ipcMocks.invoke).toHaveBeenCalledWith(
      session,
      'db:import-run-list-chapters',
      snapshot.id,
      0,
      100,
      session.projectPath,
    )
    expect(ipcMocks.invoke).toHaveBeenCalledWith(
      session,
      'db:import-run-list-chapters',
      snapshot.id,
      7,
      100,
      session.projectPath,
    )
  })

  it('rejects an author manifest with durable rows beyond the declared chapter count', async () => {
    const snapshot = run({
      purpose: 'author-manuscript',
      effectNamespace: 'import:author-manuscript:import-run-1',
      stage: 'author-publish',
      totalChapters: 2,
      manifestChapterCount: 2,
      authorityFingerprint: 'c'.repeat(64),
    })
    ipcMocks.invoke.mockImplementation(async (_session, _channel, _runId, after) => {
      if (after === 0) return [
        { number: 2, title: 'Second', contentFingerprint: 'a'.repeat(64), contentSize: 1, content: 'a' },
        { number: 7, title: 'Seventh', contentFingerprint: 'b'.repeat(64), contentSize: 1, content: 'b' },
      ]
      if (after === 7) return [
        { number: 9, title: 'Ninth', contentFingerprint: 'd'.repeat(64), contentSize: 1, content: 'd' },
      ]
      return []
    })

    await expect(loadAuthorImportChapterNumbers(snapshot, session, session.projectPath))
      .rejects.toThrow('持久化章节清单不完整')
  })

  it('freezes the persisted run id, locale, session, and reference-only staged copy', () => {
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: run(), executionOwner })

    expect(workflow).toMatchObject({ runId: 'import-run-1', uiLocale: 'zh-CN', projectSession: session })
    expect(workflow.steps.map(step => step.name)).toEqual([
      '导入参照文本与构建知识库', 'AI 推演全局配置与架构', 'AI 拆解文风与仿写指南',
      'AI 分批推演章节蓝图', '刷新项目状态',
    ])
    expect(workflow.steps[0].description).toContain('不写入草稿或正文')
  })

  it('uses the run-start locale even when current UI state differs', () => {
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: run({ locale: 'en-US' }),
      executionOwner,
    })
    expect(workflow.title).toBe('Novel analysis and style study (1 chapter)')
    expect(workflow.steps[0].name).toBe('Import reference text and build the knowledge base')
  })

  it('builds blueprint prompt context in the frozen project writing language, not the UI locale', async () => {
    const snapshot = run({ stage: 'blueprints' })
    useProjectStore.setState({
      currentProject: {
        ...useProjectStore.getState().currentProject!,
        novelConfig: {
          writingLanguage: 'en-US',
          genre: 'Mystery',
          coreOutline: 'Find the missing witness',
          worldSetting: 'A coastal city',
          protagonistProfile: 'A patient investigator',
        } as never,
      },
    })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-start-resume') return {
        success: true,
        start: {
          run: snapshot,
          execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
        },
      }
      if (channel === 'db:import-run-renew-execution') return {
        success: true,
        execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
      }
      if (channel === 'db:import-run-list-chapters') {
        return (args[1] as number) === 0 ? [{
          number: 1, title: 'Start', content: 'frozen reference',
          contentFingerprint: 'c'.repeat(64), contentSize: 16,
        }] : []
      }
      if (channel === 'db:import-run-effect-receipt-get') return null
      if (channel === 'db:import-run-fail') return { success: true, run: { ...snapshot, status: 'failed' } }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({
      projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner,
    })
    const frozenContext = { ...context(), writingLanguage: 'en-US' as const, uiLocale: 'zh-CN' as const }

    await expect(workflow.steps[3].executor({} as never, frozenContext, callbacks))
      .rejects.toThrow('stop-after-blueprint-prompt-context')

    expect(commandMocks.blueprintContext?.data.novelConfigSummary).toContain('Genre: Mystery')
    expect(commandMocks.blueprintContext?.data.novelConfigSummary).not.toContain('类型:')
  })

  it('imports the frozen snapshot through the reference-only idempotent channel and checkpoints it', async () => {
    let snapshot = run()
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-start-resume') return {
        success: true,
        start: {
          run: snapshot,
          execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
        },
      }
      if (channel === 'db:import-run-renew-execution') return {
        success: true,
        execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
      }
      if (channel === 'db:import-run-list-chapters') {
        const after = args[1] as number
        return after === 0 ? [{
          number: 1, title: 'Start', content: 'frozen reference',
          contentFingerprint: 'c'.repeat(64), contentSize: 16,
        }] : []
      }
      if (channel === 'kb:import-reference-text') return { success: true, docId: 'stable', idempotent: false }
      if (channel === 'db:import-run-complete-batch') {
        snapshot = { ...snapshot, completedBatches: { knowledge: ['1-1'] } }
        return { success: true, run: snapshot, newlyCompleted: true, cancelApplied: false }
      }
      if (channel === 'db:import-run-advance-stage') {
        snapshot = { ...snapshot, stage: 'global' }
        return { success: true, run: snapshot }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })

    await workflow.steps[0].executor({} as never, context(), callbacks)

    expect(ipcMocks.invoke).toHaveBeenCalledWith(
      session,
      'kb:import-reference-text',
      1,
      'import-run-1',
      { owner: executionOwner, epoch: 1 },
    )
    expect(ipcMocks.invoke.mock.calls.map(call => call[1])).not.toContain('db:draft-create')
  })

  it('rejects a stale project lease before creating any task', () => {
    expect(() => createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: { ...session, leaseId: 'stale' },
      run: run(),
      executionOwner,
    })).toThrow('当前项目已切换')
  })

  it('re-reads and rejects a committed effect receipt that differs from durable storage', async () => {
    const snapshot = run({ stage: 'global' })
    const receipt: ImportRunEffectReceipt = {
      schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
      runId: snapshot.id,
      effectNamespace: snapshot.effectNamespace,
      effectKey: 'global-facts',
      stage: 'global',
      batchId: 'done',
      kind: 'project-global-facts',
      payloadHash: 'c'.repeat(64),
      state: 'committed',
      payload: {},
      effectReceipt: {},
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }
    let receiptReads = 0
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-start-resume') return {
        success: true,
        start: {
          run: snapshot,
          execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
        },
      }
      if (channel === 'db:import-run-renew-execution') return {
        success: true,
        execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
      }
      if (channel === 'db:import-run-list-chapters') return []
      if (channel === 'db:import-run-effect-receipt-get') {
        receiptReads += 1
        return receiptReads === 1 ? receipt : { ...receipt, payloadHash: 'd'.repeat(64) }
      }
      if (channel === 'db:import-run-effect-receipt-commit') return {
        success: true,
        result: { receipt, run: snapshot, cancelApplied: false },
      }
      if (channel === 'db:import-run-fail') return {
        success: true,
        run: { ...snapshot, status: 'failed' },
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: snapshot,
      executionOwner,
    })

    await expect(workflow.steps[1].executor({} as never, context(), callbacks))
      .rejects.toThrow(/does not match durable storage/)
    expect(receiptReads).toBe(2)
  })

  it('resumes a checkpointed blueprint batch by completing its pending character sync without generation', async () => {
    const checkpoint = '1-1-cccccccc'
    let snapshot = run({
      stage: 'blueprints',
      completedBatches: { blueprints: [checkpoint] },
    })
    const receipt: ImportRunEffectReceipt = {
      schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
      runId: snapshot.id,
      effectNamespace: snapshot.effectNamespace,
      effectKey: `blueprints:${checkpoint}`,
      stage: 'blueprints',
      batchId: checkpoint,
      kind: 'chapter-blueprint-range',
      payloadHash: 'c'.repeat(64),
      state: 'committed',
      payload: { blueprints: [{ chapterNumber: 1 }] },
      effectReceipt: { characterSyncOperation: { operationId: 'sync-1' } },
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-start-resume') return {
        success: true,
        start: {
          run: snapshot,
          execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
        },
      }
      if (channel === 'db:import-run-renew-execution') return {
        success: true,
        execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
      }
      if (channel === 'db:import-run-list-chapters') {
        const after = args[1] as number
        return after === 0 ? [{
          number: 1,
          title: 'Start',
          content: 'frozen reference',
          contentFingerprint: 'c'.repeat(64),
          contentSize: 16,
        }] : []
      }
      if (channel === 'db:import-run-effect-receipt-get') return receipt
      if (channel === 'db:import-run-effect-receipt-commit') return {
        success: true,
        result: { receipt, run: snapshot, cancelApplied: false },
      }
      if (channel === 'db:import-run-advance-stage') {
        snapshot = { ...snapshot, stage: 'refresh' }
        return { success: true, run: snapshot }
      }
      if (channel === 'db:import-run-fail') return {
        success: true,
        run: { ...snapshot, status: 'failed' },
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: snapshot,
      executionOwner,
    })

    await workflow.steps[3].executor({} as never, context(), callbacks)

    expect(characterSyncMocks.retry).toHaveBeenCalledWith('sync-1', session.projectPath, session)
    expect(snapshot.stage).toBe('refresh')
    expect(ipcMocks.invoke.mock.calls.map(call => call[1])).not.toContain('llm:generate')
  })

  it('creates an author-only finalization plan without reference analysis stages', () => {
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: run({
        purpose: 'author-manuscript',
        effectNamespace: 'import:author-manuscript:import-run-1',
        stage: 'author-commit',
        authorityFingerprint: 'c'.repeat(64),
      }),
      executionOwner,
      authorChapterNumbers: [1],
    })

    expect(workflow.title).toBe('导入作者原稿（1 章）')
    expect(workflow.steps.map(step => step.name)).toEqual([
      '提交权威定稿快照', '发布实体正文', '更新连续性事实', '刷新项目状态',
    ])
    expect(workflow.steps.map(step => step.name).join('\n')).not.toMatch(/知识库|文风|蓝图/)
  })

  it('persists author cancellation through the same durable request and boundary hooks as reference import', async () => {
    const snapshot = run({
      purpose: 'author-manuscript',
      effectNamespace: 'import:author-manuscript:import-run-1',
      stage: 'author-publish',
      authorityFingerprint: 'c'.repeat(64),
    })
    const renewed = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-request-cancel') return { success: true, run: { ...snapshot, cancelRequested: true } }
      if (channel === 'db:import-run-get') return { ...snapshot, cancelRequested: true }
      if (channel === 'db:import-run-renew-execution') return { success: true, execution: renewed }
      if (channel === 'db:import-run-cancel-at-boundary') {
        return { success: true, run: { ...snapshot, status: 'cancelled', cancelRequested: true } }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: snapshot,
      executionOwner,
      authorChapterNumbers: [1],
    })
    const workflowContext = context()
    workflowContext.data.importRunExecution = {
      owner: executionOwner,
      epoch: 1,
      expiresAt: Number.MAX_SAFE_INTEGER - 1,
    }

    expect(workflow.onCancelRequested).toBeTypeOf('function')
    expect(workflow.onCancelledAtBoundary).toBeTypeOf('function')
    await workflow.onCancelRequested!(workflowContext)
    await workflow.onCancelledAtBoundary!(workflowContext)

    expect(ipcMocks.invoke.mock.calls.map(call => call[1])).toEqual([
      'db:import-run-request-cancel',
      'db:import-run-get',
      'db:import-run-renew-execution',
      'db:import-run-cancel-at-boundary',
    ])
    expect(workflowContext.data.importRunExecution).toEqual(renewed)
  })

  it('keeps import workflow sources free of pseudo icon text', () => {
    const source = [
      'src/services/workflows/import-workflow.ts',
      'src/services/workflows/import-run-orchestrator.ts',
      'src/components/dialogs/ImportNovelDialog.tsx',
    ].map(file => readFileSync(resolve(process.cwd(), file), 'utf8')).join('\n')
    expect(source).not.toMatch(/[\u2600-\u27BF]/u)
    expect(source).not.toMatch(/\uFE0F/u)
    expect(source).not.toMatch(/[\p{Extended_Pictographic}]/u)
  })
})
