import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { BlueprintRepository, type BlueprintData, type BlueprintRangeCommitReceipt } from '../blueprint-repository'
import { CharacterProposalService } from '../../services/character-proposal-service'
import { proveCharacterProposal } from '../../services/generation-character-proposal-proof'
import { GenerationRunRepository } from '../generation-run-repository'
import { projectAccess } from '../../services/project-access'
import { ImportRunRepository } from '../import-run-repository'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { ProjectCoreRepository } from '../project-core-repository'
import {
  ImportRunOrchestrator,
  type ImportRunOrchestratorDependencies,
} from '../../../src/services/workflows/import-run-orchestrator'
import { importStagesFor, type ImportRunChapterSnapshot } from '../../../src/shared/import-run'
import type { FinalizedDraftImportReceipt } from '../../../src/shared/finalized-draft-import'
import type { ImportGlobalFactsRequest } from '../../../src/shared/import-global-facts'
import { countDraftUnits } from '../../../src/shared/draft-units'

let root = ''
const RUN_ID = 'author-eight-stage-run'

function chapter(number: number): ImportRunChapterSnapshot {
  const content = `作者原稿第${number}章：沈默在雨夜重读旧案卷宗。`
  return {
    number,
    title: `第${number}章`,
    content,
    contentFingerprint: createHash('sha256').update(content).digest('hex'),
    contentSize: Buffer.byteLength(content, 'utf8'),
  }
}

const CHAPTERS = [chapter(1), chapter(2), chapter(3)]

function inferredFacts(runId: string): ImportGlobalFactsRequest {
  return {
    operationId: `novel-import-global-${runId}`,
    expectedRosterRevision: 0,
    core: {
      genre: '悬疑', subGenre: '本格', targetAudience: '成人', totalChapters: 3, wordsPerChapter: 2400,
      plotStructure: 'three_act', narrativePov: 'first_person', goldenFinger: '过目不忘', globalGuidance: '克制',
      coreOutline: '侦探追查旧案', worldSetting: '民国上海', protagonistProfile: '沈默，前巡捕',
      premise: '旧案重启', worldbuilding: '租界与华界', synopsis: '三章查清真相',
    },
    characterEntries: [{
      name: '沈默', role: 'protagonist', gender: '男', age: '35', appearance: '瘦', personality: '冷静',
      background: '前巡捕', abilities: '推理', motivation: '真相', relationships: [], arc: '和解', notes: '反推',
    }],
  }
}

function inferredBlueprint(number: number): BlueprintData {
  return {
    chapterNumber: number, title: `反推蓝图${number}`, role: 'setup', purpose: `推进${number}`,
    keyEvents: `事件${number}`, characters: [], suspenseHook: `钩子${number}`,
    userGuidance: '', notes: '', notesUpdatedAt: '',
  }
}

function prepareAuthorRun(authorInference: boolean): void {
  const preview = FinalizedDraftImportRepository.preview(CHAPTERS.map(item => ({
    chapterNumber: item.number, title: item.title, content: item.content, wordCount: countDraftUnits(item.content),
  })))
  ImportRunRepository.prepare({
    runId: RUN_ID,
    purpose: 'author-manuscript',
    sourceFingerprint: 'd'.repeat(64),
    sourceDisplay: [{ displayName: '原稿.txt', mediaType: 'text/plain', size: 256 }],
    locale: 'zh-CN',
    authorityFingerprint: preview.authorityFingerprint,
    expectedManifestFingerprint: preview.manifestFingerprint,
    chapters: CHAPTERS,
    authorInference,
  })
}

function completeBlueprintCharacterSync(receipt: BlueprintRangeCommitReceipt): void {
  const db = getProjectDb()!, project = projectAccess.probeExistingProject(root)
  if (project.kind !== 'manifest') throw new Error('test project identity missing')
  new CharacterProposalService(db, project.projectId, (source, forWrite) => proveCharacterProposal(db,
    new GenerationRunRepository(() => db), project.projectId, source, forWrite, () => {}))
    .stage({ kind: 'directory', operationId: receipt.characterSyncOperation.operationId })
  BlueprintRepository.completeCharacterSyncOperation(receipt.characterSyncOperation.operationId)
}

interface Trace {
  published: number[]
  postprocessed: number[]
  globalCalls: number
  styleCalls: number
  blueprintCalls: number[][]
  failSecondBlueprintBatchOnce: boolean
  beforeBlueprintCommit?: () => void
}

function newTrace(): Trace {
  return { published: [], postprocessed: [], globalCalls: 0, styleCalls: 0, blueprintCalls: [], failSecondBlueprintBatchOnce: false }
}

function dependencies(trace: Trace): ImportRunOrchestratorDependencies {
  return {
    getRun: async runId => ImportRunRepository.get(runId),
    startOrResume: async (runId, owner) => ImportRunRepository.startOrResume(runId, owner),
    renewExecution: async (runId, execution) => ImportRunRepository.renewExecution(runId, execution),
    getEffectReceipt: async (runId, stage, batchId) => ImportRunRepository.getEffectReceipt(runId, stage, batchId),
    prepareEffectReceipt: async (request, execution) => ImportRunRepository.prepareEffectReceipt(request, execution),
    commitEffectReceipt: async (runId, stage, batchId, execution) => (
      ImportRunRepository.commitEffectReceipt(runId, stage, batchId, execution)
    ),
    replayCommittedEffect: async receipt => {
      if (receipt.kind === 'chapter-blueprint-range') {
        completeBlueprintCharacterSync(receipt.effectReceipt as BlueprintRangeCommitReceipt)
      }
    },
    listChapters: async (runId, afterChapterNumber, limit) => (
      ImportRunRepository.listChapterBatch(runId, { afterChapterNumber, limit })
    ),
    importReference: async () => { throw new Error('作者原稿不走参考知识库导入') },
    inferGlobal: async (_chapters, _stats, run, commit) => {
      trace.globalCalls += 1
      await commit(inferredFacts(run.id))
    },
    analyzeStyle: async (_chapters, _run, commit) => {
      trace.styleCalls += 1
      await commit({ writingStyle: '短句，白描' })
    },
    inferBlueprints: async (chapters, _checkpoint, run, commit) => {
      trace.blueprintCalls.push(chapters.map(item => item.number))
      if (trace.blueprintCalls.length === 2 && trace.failSecondBlueprintBatchOnce) {
        trace.failSecondBlueprintBatchOnce = false
        throw new Error('第二批蓝图模型调用失败')
      }
      trace.beforeBlueprintCommit?.()
      const receipt = await commit({
        mode: 'replace-range',
        operationId: `import-blueprints-${run.id}-${chapters[0]!.number}-${chapters.at(-1)!.number}`,
        startChapter: chapters[0]!.number,
        endChapter: chapters.at(-1)!.number,
        blueprints: chapters.map(item => inferredBlueprint(item.number)),
      }) as BlueprintRangeCommitReceipt
      completeBlueprintCharacterSync(receipt)
    },
    listBlueprintChapterNumbers: async () => new Set(BlueprintRepository.getAll().map(item => item.chapterNumber)),
    commitAuthorManuscript: async (run, commit) => {
      await commit({
        operationId: `author-import:${run.id}`,
        runId: run.id,
        authorityFingerprint: run.authorityFingerprint,
        manifestFingerprint: run.manifestFingerprint,
      })
    },
    getAuthorCommitReceipt: async runId => (
      ImportRunRepository.getEffectReceipt(runId, 'author-commit', 'done')?.effectReceipt as FinalizedDraftImportReceipt | undefined
    ) ?? null,
    publishAuthorChapter: async item => { trace.published.push(item.number) },
    postprocessAuthorChapter: async item => { trace.postprocessed.push(item.number) },
    isAuthorDraftReplaced: async () => false,
    refresh: async () => undefined,
    completeBatch: async (runId, stage, batchId, execution) => (
      ImportRunRepository.completeBatch(runId, stage, batchId, execution)
    ),
    advanceStage: async (runId, completedStage, nextStage, execution) => (
      ImportRunRepository.advanceStage(runId, completedStage, nextStage, execution)
    ),
    fail: async (runId, stage, error, execution) => ImportRunRepository.fail(runId, stage, error, execution),
    cancelAtBoundary: async (runId, execution) => ImportRunRepository.cancelAtBoundary(runId, execution),
    complete: async (runId, execution) => ImportRunRepository.complete(runId, execution),
  }
}

const callbacks = () => ({ log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() })

/** 照导入对话框建的工作流，按运行冻结的阶段表从当前阶段一路跑到完成。 */
async function runRemainingStages(trace: Trace, owner: string): Promise<void> {
  const orchestrator = new ImportRunOrchestrator(dependencies(trace))
  for (const stage of importStagesFor(ImportRunRepository.get(RUN_ID)!)) {
    if (stage === 'completed') break
    await orchestrator.executeStage(RUN_ID, stage, owner, { cancelled: false }, callbacks())
  }
}

function pendingProposalNames(): string[] {
  const rows = getProjectDb()!.prepare(
    "SELECT raw_value FROM character_identity_proposals WHERE source_key LIKE 'character-proposal-v1:%'",
  ).all() as Array<{ raw_value: string }>
  return rows.flatMap(row => {
    const batch = JSON.parse(row.raw_value).batch as { status: string; items: Array<{ fields: { name: string } }> }
    return batch.status === 'pending-approval' ? batch.items.map(item => item.fields.name) : []
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-author-eight-stage-'))
  initProjectDatabase(root)
  if (!ProjectCoreRepository.get()) ProjectCoreRepository.init('作者项目')
}, 20_000)

afterEach(() => {
  vi.restoreAllMocks()
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('勾选反推的作者原稿走完八个阶段', () => {
  it('空项目：取消后从反推阶段续跑，设定、架构、文风有值，角色是提议，每章都有蓝图', async () => {
    prepareAuthorRun(true)
    const trace = newTrace()
    const orchestrator = new ImportRunOrchestrator(dependencies(trace))
    for (const stage of ['author-commit', 'author-publish', 'author-postprocess'] as const) {
      await orchestrator.executeStage(RUN_ID, stage, 'renderer-before-cancel', { cancelled: false }, callbacks())
    }
    await expect(orchestrator.executeStage(
      RUN_ID, 'global', 'renderer-before-cancel', { cancelled: true }, callbacks(),
    )).rejects.toThrow('导入已取消')
    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ stage: 'global', status: 'cancelled', authorInference: true })
    expect(trace.globalCalls).toBe(0)

    await runRemainingStages(trace, 'renderer-after-cancel')

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ status: 'completed', stage: 'completed', authorInference: true })
    expect(trace).toMatchObject({ published: [1, 2, 3], postprocessed: [1, 2, 3], globalCalls: 1, styleCalls: 1, blueprintCalls: [[1, 2, 3]] })
    expect(ProjectCoreRepository.get()).toMatchObject({
      genre: '悬疑', coreOutline: '侦探追查旧案', premise: '旧案重启', worldbuilding: '租界与华界', synopsis: '三章查清真相',
      writingStyle: '短句，白描',
    })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
    expect(pendingProposalNames()).toEqual(['沈默'])
    expect(BlueprintRepository.getAll().map(item => [item.chapterNumber, item.title])).toEqual([
      [1, '反推蓝图1'], [2, '反推蓝图2'], [3, '反推蓝图3'],
    ])
  })

  it('已有设定：已有字段与蓝图不动，空的补上，不同的进建议；崩溃重开后续跑不重复调模型', async () => {
    ProjectCoreRepository.update({ genre: '武侠', coreOutline: '作者自己的大纲', writingStyle: '作者的长句' })
    BlueprintRepository.upsert({ ...inferredBlueprint(2), title: '作者写的第2章蓝图', userGuidance: '作者的微操' })
    prepareAuthorRun(true)
    const trace = { ...newTrace(), failSecondBlueprintBatchOnce: true }
    const commitRange = vi.spyOn(BlueprintRepository, 'commitRange')

    await expect(runRemainingStages(trace, 'renderer-before-crash')).rejects.toThrow('第二批蓝图模型调用失败')
    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ stage: 'blueprints', status: 'failed' })
    closeProjectDatabase()
    initProjectDatabase(root)
    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ stage: 'blueprints', authorInference: true })

    await runRemainingStages(trace, 'renderer-after-reopen')

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ status: 'completed', authorInference: true })
    expect(trace).toMatchObject({ globalCalls: 1, styleCalls: 1, blueprintCalls: [[1], [3], [3]] })
    expect(commitRange.mock.calls.map(([request]) => request.operationId)).toEqual([
      `import-blueprints-${RUN_ID}-1-1`, `import-blueprints-${RUN_ID}-3-3`,
    ])
    expect(ProjectCoreRepository.get()).toMatchObject({
      genre: '武侠', coreOutline: '作者自己的大纲', writingStyle: '作者的长句', subGenre: '本格', premise: '旧案重启',
    })
    expect(ImportRunRepository.getEffectReceipt(RUN_ID, 'global', 'done')?.effectReceipt).toMatchObject({
      suggestions: expect.arrayContaining([
        { field: 'genre', current: '武侠', inferred: '悬疑' },
        { field: 'coreOutline', current: '作者自己的大纲', inferred: '侦探追查旧案' },
      ]),
    })
    expect(ImportRunRepository.getEffectReceipt(RUN_ID, 'style', 'done')?.effectReceipt).toMatchObject({
      suggestions: [{ field: 'writingStyle', current: '作者的长句', inferred: '短句，白描' }],
    })
    expect(BlueprintRepository.getByChapter(2)).toMatchObject({ title: '作者写的第2章蓝图', userGuidance: '作者的微操' })
    expect(BlueprintRepository.getAll().map(item => item.title)).toEqual(['反推蓝图1', '作者写的第2章蓝图', '反推蓝图3'])
  })
})

describe('反推蓝图途中作者自己保存了蓝图', () => {
  it('提交时按当时的蓝图只补空：作者在模型调用期间保存的那一章不被反推结果覆盖', async () => {
    prepareAuthorRun(true)
    const trace = newTrace()
    trace.beforeBlueprintCommit = () => {
      if (trace.blueprintCalls.length === 1) {
        BlueprintRepository.upsert({ ...inferredBlueprint(1), title: '作者刚存的第1章', purpose: '作者自己的目的', keyEvents: '作者写的事件' })
      }
    }

    await runRemainingStages(trace, 'renderer')

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ status: 'completed', authorInference: true })
    expect(trace.blueprintCalls).toEqual([[1, 2, 3]])
    expect(BlueprintRepository.getByChapter(1)).toMatchObject({ title: '作者刚存的第1章', purpose: '作者自己的目的', keyEvents: '作者写的事件' })
    expect(BlueprintRepository.getAll().map(item => item.title)).toEqual(['作者刚存的第1章', '反推蓝图2', '反推蓝图3'])
  })
})

describe('不勾选反推的作者原稿', () => {
  it('只走定稿、发布、后处理与刷新，不调模型，设定与蓝图不变', async () => {
    ProjectCoreRepository.update({ genre: '武侠' })
    const before = ProjectCoreRepository.get()
    prepareAuthorRun(false)
    const trace = newTrace()

    await runRemainingStages(trace, 'renderer')

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ status: 'completed', authorInference: false })
    expect(trace).toMatchObject({ published: [1, 2, 3], postprocessed: [1, 2, 3], globalCalls: 0, styleCalls: 0, blueprintCalls: [] })
    expect(ProjectCoreRepository.get()).toEqual(before)
    expect(BlueprintRepository.count()).toBe(0)
  })
})
