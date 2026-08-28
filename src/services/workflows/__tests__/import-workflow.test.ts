import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../ipc-client', () => ({
  ipc: { invokeWithProjectSession: ipcMocks.invoke },
}))

import { createImportWorkflow } from '../import-workflow'
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
  useProjectStore.setState({
    currentProject: {
      id: 'test-project', sessionLease: 'lease-test-project', name: '测试项目', path: session.projectPath,
      novelConfig: {} as never, characterStates: '', createdAt: '', updatedAt: '',
    },
  })
})

afterEach(() => useProjectStore.setState({ currentProject: null }))

describe('createImportWorkflow', () => {
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
      '第1章 Start.txt',
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

  it('fails closed before creating an author-manuscript stage plan', () => {
    expect(() => createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: run({ purpose: 'author-manuscript' }),
      executionOwner,
    })).toThrow(/不支持作者手稿/)
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
