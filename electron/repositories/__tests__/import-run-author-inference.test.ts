import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { ImportRunRepository } from '../import-run-repository'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { ProjectCoreRepository } from '../project-core-repository'
import { BlueprintRepository, type BlueprintData } from '../blueprint-repository'
import { captureImportGenerationContext } from '../../services/import-generation-source'
import { createImportRunChapterBatchCheckpointId, type ImportRunExecutionLease } from '../../../src/shared/import-run'
import type { ImportGlobalFactsRequest } from '../../../src/shared/import-global-facts'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { verifyM04ImportEffectLedger } from '../../migrations/m04-import-effect-ledger'

let root = ''
const RUN_ID = 'author-inference-run'

function chapter(number: number) {
  const content = `作者原稿第${number}章正文`
  return {
    number,
    title: `第${number}章`,
    content,
    contentFingerprint: createHash('sha256').update(content).digest('hex'),
    contentSize: Buffer.byteLength(content, 'utf8'),
  }
}

const CHAPTERS = [chapter(1), chapter(2), chapter(3)]

function globalFacts(): ImportGlobalFactsRequest {
  return {
    operationId: `novel-import-global-${RUN_ID}`,
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

function blueprint(number: number): BlueprintData {
  return {
    chapterNumber: number, title: `反推蓝图${number}`, role: 'setup', purpose: `推进${number}`,
    keyEvents: `事件${number}`, characters: [], suspenseHook: `钩子${number}`,
    userGuidance: '', notes: '', notesUpdatedAt: '',
  }
}

function prepareAuthorRun(authorInference: boolean, runId = RUN_ID) {
  const finalized = CHAPTERS.map(item => ({
    chapterNumber: item.number, title: item.title, content: item.content, wordCount: countDraftUnits(item.content),
  }))
  const preview = FinalizedDraftImportRepository.preview(finalized)
  const prepared = ImportRunRepository.prepare({
    runId,
    purpose: 'author-manuscript',
    sourceFingerprint: 'c'.repeat(64),
    sourceDisplay: [{ displayName: 'manuscript.txt', mediaType: 'text/plain', size: 64 }],
    locale: 'zh-CN',
    authorityFingerprint: preview.authorityFingerprint,
    expectedManifestFingerprint: preview.manifestFingerprint,
    chapters: CHAPTERS,
    authorInference,
  })
  return { preview, prepared }
}

/** 作者原稿已定稿后，把运行推到某个反推阶段。 */
function authorRunAt(stage: 'global' | 'style' | 'blueprints'): ImportRunExecutionLease {
  const { preview } = prepareAuthorRun(true)
  const execution = ImportRunRepository.startOrResume(RUN_ID, 'author-inference-runner').execution
  ImportRunRepository.prepareEffectReceipt({
    runId: RUN_ID, stage: 'author-commit', batchId: 'done',
    effectKey: 'author-finalized-batch', kind: 'author-finalized-batch',
    payload: {
      operationId: `author-import:${RUN_ID}`, runId: RUN_ID,
      authorityFingerprint: preview.authorityFingerprint, manifestFingerprint: preview.manifestFingerprint,
    },
  }, execution)
  ImportRunRepository.commitEffectReceipt(RUN_ID, 'author-commit', 'done', execution)
  getProjectDb()!.prepare('UPDATE import_runs SET stage = ? WHERE id = ?').run(stage, RUN_ID)
  return execution
}

function commitGlobal(execution: ImportRunExecutionLease) {
  ImportRunRepository.prepareEffectReceipt({
    runId: RUN_ID, stage: 'global', batchId: 'done', effectKey: 'global-facts',
    kind: 'project-global-facts', payload: globalFacts(),
  }, execution)
  return ImportRunRepository.commitEffectReceipt(RUN_ID, 'global', 'done', execution)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-author-inference-'))
  initProjectDatabase(root)
  if (!ProjectCoreRepository.get()) ProjectCoreRepository.init('作者项目')
}, 20_000)

afterEach(() => {
  vi.restoreAllMocks()
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('作者原稿运行的反推阶段', () => {
  it('全局事实只补空白：已有字段不变，非空字段的反推值进建议，重读收据仍通过校验', () => {
    ProjectCoreRepository.update({ genre: '武侠', coreOutline: '作者自己的大纲' })
    const execution = authorRunAt('global')

    const committed = commitGlobal(execution)

    expect(ProjectCoreRepository.get()).toMatchObject({
      genre: '武侠', coreOutline: '作者自己的大纲', subGenre: '本格', premise: '旧案重启', synopsis: '三章查清真相',
    })
    expect(committed.receipt.effectReceipt).toMatchObject({
      mode: 'fill-empty',
      suggestions: expect.arrayContaining([
        { field: 'genre', current: '武侠', inferred: '悬疑' },
        { field: 'coreOutline', current: '作者自己的大纲', inferred: '侦探追查旧案' },
      ]),
    })
    expect(ImportRunRepository.getEffectReceipt(RUN_ID, 'global', 'done')).toMatchObject({ state: 'committed' })
    expect(ImportRunRepository.getEffectReceipt(RUN_ID, 'author-commit', 'done')).toMatchObject({ state: 'committed' })
  })

  it('文风只在为空时写入，已有文风保留并进建议', () => {
    ProjectCoreRepository.update({ writingStyle: '作者的长句风格' })
    const execution = authorRunAt('style')
    ImportRunRepository.prepareEffectReceipt({
      runId: RUN_ID, stage: 'style', batchId: 'done', effectKey: 'writing-style',
      kind: 'project-writing-style', payload: { writingStyle: '短句，白描' },
    }, execution)

    const committed = ImportRunRepository.commitEffectReceipt(RUN_ID, 'style', 'done', execution)

    expect(ProjectCoreRepository.get()?.writingStyle).toBe('作者的长句风格')
    expect(committed.receipt.effectReceipt).toEqual({
      mode: 'fill-empty',
      writingStyle: '作者的长句风格',
      suggestions: [{ field: 'writingStyle', current: '作者的长句风格', inferred: '短句，白描' }],
    })
    expect(ImportRunRepository.getEffectReceipt(RUN_ID, 'style', 'done')).toMatchObject({ state: 'committed' })
  })

  it('文风为空时写入反推值，没有建议', () => {
    const execution = authorRunAt('style')
    ImportRunRepository.prepareEffectReceipt({
      runId: RUN_ID, stage: 'style', batchId: 'done', effectKey: 'writing-style',
      kind: 'project-writing-style', payload: { writingStyle: '短句，白描' },
    }, execution)

    const committed = ImportRunRepository.commitEffectReceipt(RUN_ID, 'style', 'done', execution)

    expect(ProjectCoreRepository.get()?.writingStyle).toBe('短句，白描')
    expect(committed.receipt.effectReceipt).toEqual({ mode: 'fill-empty', writingStyle: '短句，白描', suggestions: [] })
  })

  it('反推收据进生成来源闸门：带生成句柄时按运行校验，有闸门却没句柄时拒绝', () => {
    const execution = authorRunAt('global')
    const handle = { projectId: 'p', epoch: '1', rootActionId: 'root', runId: 'generation-run' }
    const assertSources = vi.fn()

    expect(() => ImportRunRepository.prepareEffectReceipt({
      runId: RUN_ID, stage: 'global', batchId: 'done', effectKey: 'global-facts',
      kind: 'project-global-facts', payload: globalFacts(),
    }, execution, Date.now(), assertSources)).toThrow('GENERATION_IMPORT_EFFECT_HANDLE_REQUIRED')

    ImportRunRepository.prepareEffectReceipt({
      runId: RUN_ID, stage: 'global', batchId: 'done', effectKey: 'global-facts',
      kind: 'project-global-facts', payload: { ...globalFacts(), generationRunHandle: handle },
    }, execution, Date.now(), assertSources)
    expect(assertSources).toHaveBeenCalledWith(handle, { runId: RUN_ID, stage: 'global', batchId: 'done' })
  })

  it('反推生成能从作者原稿运行冻结的章节取材', () => {
    authorRunAt('global')

    const context = captureImportGenerationContext(getProjectDb()!, { runId: RUN_ID, stage: 'global', batchId: 'done' })

    expect(context.chapters.map(item => item.number)).toEqual([1, 3])
    expect(context.totalChapters).toBe(3)
  })

  it('已有蓝图的章不需要本次运行的检查点，蓝图阶段在每章都有蓝图后才能推进', () => {
    BlueprintRepository.upsert({ ...blueprint(2), title: '作者写的第2章蓝图', userGuidance: '作者的微操' })
    const execution = authorRunAt('blueprints')
    const advance = () => ImportRunRepository.advanceStage(RUN_ID, 'blueprints', 'refresh', execution)
    const commitRange = (numbers: number[]) => {
      const batchId = createImportRunChapterBatchCheckpointId(numbers.map(chapter))
      ImportRunRepository.prepareEffectReceipt({
        runId: RUN_ID, stage: 'blueprints', batchId, effectKey: `blueprints:${batchId}`,
        kind: 'chapter-blueprint-range',
        payload: {
          mode: 'replace-range', operationId: `import-blueprints-${RUN_ID}-${numbers[0]}-${numbers.at(-1)}`,
          startChapter: numbers[0], endChapter: numbers.at(-1), blueprints: numbers.map(blueprint),
        },
      }, execution)
      ImportRunRepository.commitEffectReceipt(RUN_ID, 'blueprints', batchId, execution)
    }

    commitRange([1])
    expect(advance).toThrow('IMPORT_RUN_STAGE_INCOMPLETE')
    commitRange([3])

    expect(advance()).toMatchObject({ stage: 'refresh' })
    expect(BlueprintRepository.getByChapter(2)).toMatchObject({ title: '作者写的第2章蓝图', userGuidance: '作者的微操' })
  })
})

describe('作者原稿蓝图阶段的进度', () => {
  it('分母只算本次运行要反推的章：3 章里 1 章已有蓝图，提交 1 章后是 1/2', () => {
    BlueprintRepository.upsert({ ...blueprint(2), title: '作者写的第2章蓝图' })
    const execution = authorRunAt('blueprints')
    const batchId = createImportRunChapterBatchCheckpointId([chapter(1)])
    ImportRunRepository.prepareEffectReceipt({
      runId: RUN_ID, stage: 'blueprints', batchId, effectKey: `blueprints:${batchId}`, kind: 'chapter-blueprint-range',
      payload: { mode: 'replace-range', operationId: `import-blueprints-${RUN_ID}-1-1`, startChapter: 1, endChapter: 1, blueprints: [blueprint(1)] },
    }, execution)
    ImportRunRepository.commitEffectReceipt(RUN_ID, 'blueprints', batchId, execution)

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ progressCompleted: 1, progressTotal: 2 })
  })
})

describe('authorInference 随运行冻结在导入账本里', () => {
  it.each([true, false])('勾选为 %s 的运行重启后读回不变，重新确认同一份原稿也不改它', authorInference => {
    expect(prepareAuthorRun(authorInference).prepared.run).toMatchObject({ authorInference })

    closeProjectDatabase()
    initProjectDatabase(root)

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ authorInference })
    const again = prepareAuthorRun(!authorInference, 'author-inference-run-again').prepared
    expect(again).toMatchObject({ classification: 'resumable', run: { id: RUN_ID, authorInference } })
  })

  it('勾选写下的那一行不算进度：只有它时 completedBatches 为空，作者定稿提交后只多出 author-commit', () => {
    const { preview } = prepareAuthorRun(true)
    const execution = ImportRunRepository.startOrResume(RUN_ID, 'runner').execution

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ authorInference: true })
    expect(ImportRunRepository.get(RUN_ID)!.completedBatches).toEqual({})
    ImportRunRepository.prepareEffectReceipt({
      runId: RUN_ID, stage: 'author-commit', batchId: 'done',
      effectKey: 'author-finalized-batch', kind: 'author-finalized-batch',
      payload: {
        operationId: `author-import:${RUN_ID}`, runId: RUN_ID,
        authorityFingerprint: preview.authorityFingerprint, manifestFingerprint: preview.manifestFingerprint,
      },
    }, execution)
    ImportRunRepository.commitEffectReceipt(RUN_ID, 'author-commit', 'done', execution)

    expect(ImportRunRepository.get(RUN_ID)!.completedBatches).toEqual({ 'author-commit': ['done'] })
  })

  it('账本行通过 M04 的账本校验', () => {
    prepareAuthorRun(true)

    expect(verifyM04ImportEffectLedger(getProjectDb()!)).toBe(true)
  })

  it('M04 之前的旧运行没有账本，仍按 completed_batches_json 读进度，反推读作未勾选', () => {
    prepareAuthorRun(false)
    const checkpoints = { 'author-commit': ['done'], 'author-publish': ['chapter:1', 'chapter:2'] }
    getProjectDb()!.exec('DROP TABLE import_effect_ledger')
    getProjectDb()!.prepare('UPDATE import_runs SET stage = ?, completed_batches_json = ? WHERE id = ?')
      .run('author-publish', JSON.stringify(checkpoints), RUN_ID)

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ authorInference: false, completedBatches: checkpoints })
  })

  it.each([
    [true, 'global', 'refresh'],
    [false, 'refresh', 'global'],
  ] as const)('勾选为 %s 时后处理之后进 %s，不能进 %s', (authorInference, allowed, refused) => {
    prepareAuthorRun(authorInference)
    const execution = ImportRunRepository.startOrResume(RUN_ID, 'runner').execution
    getProjectDb()!.prepare("UPDATE import_runs SET stage = 'author-postprocess' WHERE id = ?").run(RUN_ID)
    for (const item of CHAPTERS) ImportRunRepository.completeBatch(RUN_ID, 'author-postprocess', `chapter:${item.number}`, execution)

    expect(() => ImportRunRepository.advanceStage(RUN_ID, 'author-postprocess', refused, execution))
      .toThrow('IMPORT_RUN_STAGE_MISMATCH')
    expect(ImportRunRepository.advanceStage(RUN_ID, 'author-postprocess', allowed, execution)).toMatchObject({ stage: allowed })
  })

  it('便携恢复冻结的旧运行只是历史：不列为可续跑、不能启动，勾选值照样可读', () => {
    prepareAuthorRun(true)
    fs.writeFileSync(path.join(root, '.ai-novel', 'portable-runtime-freeze.json'), JSON.stringify({
      version: 1, originProjectId: '11111111-1111-4111-8111-111111111111', snapshotGeneration: 'snapshot-1',
      nonReplayable: true, requiresRuntimeFreezeGuard: true, avatarReferenceProjections: [], records: [{
        projectionId: `history:import_runs:${RUN_ID}`, table: 'import_runs', recordId: RUN_ID,
        terminalState: 'ready', projection: {}, projectionHash: 'a'.repeat(64), excludedFields: [],
        nonReplayable: true, originalReceiptVerified: false,
      }],
    }), { mode: 0o600 })

    expect(ImportRunRepository.listResumable()).toEqual([])
    expect(() => ImportRunRepository.startOrResume(RUN_ID, 'runner')).toThrow('PORTABLE_RUNTIME_FROZEN')
    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ authorInference: true, status: 'ready' })
  })
})
