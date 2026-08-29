import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import {
  BlueprintRepository,
  type BlueprintData,
  type BlueprintRangeCommitReceipt,
} from '../blueprint-repository'
import { CharacterRosterRepository } from '../character-roster-repository'
import { ImportRunRepository } from '../import-run-repository'
import {
  ImportRunOrchestrator,
  type ImportRunOrchestratorDependencies,
} from '../../../src/services/workflows/import-run-orchestrator'
import type { ImportRunChapterSnapshot } from '../../../src/shared/import-run'
import type { CharacterRosterEntry } from '../../../src/shared/character-roster'

let root = ''

function chapter(number: number): ImportRunChapterSnapshot {
  const content = `reference-${number}`
  return {
    number,
    title: `Chapter ${number}`,
    content,
    contentFingerprint: createHash('sha256').update(content).digest('hex'),
    contentSize: Buffer.byteLength(content),
  }
}

function blueprint(number: number): BlueprintData {
  return {
    chapterNumber: number,
    title: `Generated ${number}`,
    role: 'setup',
    purpose: `Advance chapter ${number}`,
    keyEvents: `Event ${number}`,
    characters: [],
    suspenseHook: `Hook ${number}`,
    userGuidance: '',
    notes: '',
    notesUpdatedAt: '',
  }
}

function rosterCharacter(name: string): CharacterRosterEntry {
  return {
    name,
    role: 'supporting',
    gender: '',
    age: '',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    motivation: '',
    relationships: [],
    arc: '',
    notes: 'Imported reference character',
  }
}

interface RecoveryTrace {
  knowledgeCalls: number[]
  globalCalls: number
  styleCalls: number
  blueprintModelCalls: number[][]
  replayedBlueprintBatches: string[]
  failSecondBlueprintBatchOnce: boolean
}

function completeBlueprintCharacterSync(receipt: BlueprintRangeCommitReceipt): void {
  BlueprintRepository.completeCharacterSyncOperation(
    receipt.characterSyncOperation.operationId,
  )
}

function fullRecoveryDependencies(trace: RecoveryTrace): ImportRunOrchestratorDependencies {
  return {
    getRun: async runId => ImportRunRepository.get(runId),
    startOrResume: async (runId, owner) => ImportRunRepository.startOrResume(runId, owner),
    renewExecution: async (runId, execution) => ImportRunRepository.renewExecution(runId, execution),
    getEffectReceipt: async (runId, stage, batchId) => (
      ImportRunRepository.getEffectReceipt(runId, stage, batchId)
    ),
    prepareEffectReceipt: async (request, execution) => (
      ImportRunRepository.prepareEffectReceipt(request, execution)
    ),
    commitEffectReceipt: async (runId, stage, batchId, execution) => (
      ImportRunRepository.commitEffectReceipt(runId, stage, batchId, execution)
    ),
    replayCommittedEffect: async receipt => {
      if (receipt.kind !== 'chapter-blueprint-range') return
      const committed = receipt.effectReceipt as BlueprintRangeCommitReceipt
      trace.replayedBlueprintBatches.push(receipt.batchId)
      completeBlueprintCharacterSync(committed)
    },
    listChapters: async (runId, afterChapterNumber, limit) => (
      ImportRunRepository.listChapterBatch(runId, { afterChapterNumber, limit })
    ),
    importReference: async (item, run, authority) => {
      trace.knowledgeCalls.push(item.number)
      const binding = ImportRunRepository.resolveReferenceImportAuthority(
        run.id,
        authority,
        item.number,
      )
      const documentId = createHash('sha256')
        .update(`reference-import:${binding.stableKey}`)
        .digest('hex')
      getProjectDb()!.prepare(`
        INSERT INTO import_reference_documents (
          document_id, idempotency_key_hash, content_hash, chunk_set_hash,
          expected_chunk_count, corpus_kind, state
        ) VALUES (?, ?, ?, ?, 1, 'reference', 'committed')
      `).run(
        documentId,
        createHash('sha256').update(binding.stableKey).digest('hex'),
        binding.contentFingerprint,
        createHash('sha256').update(`chunks:${item.number}`).digest('hex'),
      )
      ImportRunRepository.commitReferenceImportReceipt(
        run.id,
        authority,
        item.number,
        documentId,
      )
    },
    inferGlobal: async (_chapters, _stats, run, commit) => {
      trace.globalCalls += 1
      await commit({
        operationId: `novel-import-global-${run.id}`,
        expectedRosterRevision: 0,
        core: {
          genre: 'Science fiction',
          subGenre: 'Mystery',
          targetAudience: 'Adult',
          totalChapters: run.totalChapters,
          wordsPerChapter: 1_000,
          plotStructure: 'three_act',
          narrativePov: 'third_limited',
          goldenFinger: 'None',
          globalGuidance: 'Keep the mystery coherent.',
          coreOutline: 'Mara follows a signal across six chapters.',
          worldSetting: 'A remote orbital station.',
          protagonistProfile: 'Mara is a careful navigator.',
          premise: 'A signal predicts failures before they happen.',
          worldbuilding: 'The station depends on unreliable archival machines.',
          synopsis: 'Mara traces the signal and discovers its human source.',
        },
        characterEntries: [rosterCharacter('Mara')],
      })
    },
    analyzeStyle: async (_chapters, _run, commit) => {
      trace.styleCalls += 1
      await commit({ writingStyle: 'Precise, restrained prose.' })
    },
    inferBlueprints: async (chapters, _checkpoint, run, commit) => {
      trace.blueprintModelCalls.push(chapters.map(item => item.number))
      if (trace.blueprintModelCalls.length === 2 && trace.failSecondBlueprintBatchOnce) {
        trace.failSecondBlueprintBatchOnce = false
        throw new Error('injected later blueprint model failure')
      }
      const receipt = await commit({
        mode: 'replace-range',
        operationId: `import-blueprints-${run.id}-${chapters[0]!.number}-${chapters.at(-1)!.number}`,
        startChapter: chapters[0]!.number,
        endChapter: chapters.at(-1)!.number,
        blueprints: chapters.map(item => ({
          ...blueprint(item.number),
          characters: ['Mara'],
        })),
      }) as BlueprintRangeCommitReceipt
      completeBlueprintCharacterSync(receipt)
    },
    refresh: async () => undefined,
    completeBatch: async (runId, stage, batchId, execution) => (
      ImportRunRepository.completeBatch(runId, stage, batchId, execution)
    ),
    advanceStage: async (runId, completedStage, nextStage, execution) => (
      ImportRunRepository.advanceStage(runId, completedStage, nextStage, execution)
    ),
    fail: async (runId, stage, error, execution) => (
      ImportRunRepository.fail(runId, stage, error, execution)
    ),
    cancelAtBoundary: async (runId, execution) => (
      ImportRunRepository.cancelAtBoundary(runId, execution)
    ),
    complete: async (runId, execution) => ImportRunRepository.complete(runId, execution),
  }
}

function realDependencies(
  modelCalls: number[][],
  crashAfterFirstCommit: { current: boolean },
): ImportRunOrchestratorDependencies {
  return {
    getRun: async runId => ImportRunRepository.get(runId),
    startOrResume: async (runId, owner) => ImportRunRepository.startOrResume(runId, owner),
    renewExecution: async (runId, execution) => ImportRunRepository.renewExecution(runId, execution),
    getEffectReceipt: async (runId, stage, batchId) => ImportRunRepository.getEffectReceipt(runId, stage, batchId),
    prepareEffectReceipt: async (request, execution) => ImportRunRepository.prepareEffectReceipt(request, execution),
    commitEffectReceipt: async (runId, stage, batchId, execution) => {
      const committed = ImportRunRepository.commitEffectReceipt(runId, stage, batchId, execution)
      if (crashAfterFirstCommit.current) {
        crashAfterFirstCommit.current = false
        throw new Error('injected crash after durable blueprint commit')
      }
      return committed
    },
    replayCommittedEffect: async () => undefined,
    listChapters: async (runId, afterChapterNumber, limit) => (
      ImportRunRepository.listChapterBatch(runId, { afterChapterNumber, limit })
    ),
    importReference: async () => { throw new Error('unexpected knowledge stage') },
    inferGlobal: async () => { throw new Error('unexpected global stage') },
    analyzeStyle: async () => { throw new Error('unexpected style stage') },
    inferBlueprints: async (chapters, _checkpoint, run, commit) => {
      modelCalls.push(chapters.map(item => item.number))
      await commit({
        mode: 'replace-range',
        operationId: `import-blueprints-${run.id}-${chapters[0]!.number}-${chapters.at(-1)!.number}`,
        startChapter: chapters[0]!.number,
        endChapter: chapters.at(-1)!.number,
        blueprints: chapters.map(item => blueprint(item.number)),
      })
    },
    refresh: async () => { throw new Error('unexpected refresh stage') },
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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-orchestrator-integration-'))
  initProjectDatabase(root)
  ImportRunRepository.prepare({
    runId: 'integration-run',
    purpose: 'reference',
    sourceFingerprint: 'a'.repeat(64),
    sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: 22 }],
    locale: 'en-US',
    chapters: [chapter(1), chapter(2)],
  })
  getProjectDb()!.prepare(`
    UPDATE import_runs
    SET stage = 'blueprints', status = 'ready', completed_batches_json =
      '{"knowledge":["1-2"],"global":["done"],"style":["done"]}'
    WHERE id = 'integration-run'
  `).run()
})

afterEach(() => {
  vi.restoreAllMocks()
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('ImportRunOrchestrator with the real import repository', () => {
  it('imports sparse historical chapter numbers with exact knowledge checkpoints', async () => {
    ImportRunRepository.prepare({
      runId: 'sparse-run',
      purpose: 'reference',
      sourceFingerprint: 'b'.repeat(64),
      sourceDisplay: [{ displayName: 'sparse.txt', mediaType: 'text/plain', size: 22 }],
      locale: 'en-US',
      chapters: [chapter(1), chapter(2)],
    })
    getProjectDb()!.transaction(() => {
      getProjectDb()!.prepare(`
        UPDATE import_source_chapter_map
        SET chapter_number = 5
        WHERE purpose = 'reference' AND source_id = ? AND source_chapter_number = 2
      `).run(`legacy:${'b'.repeat(64)}`)
      getProjectDb()!.prepare(`
        UPDATE import_run_chapters SET chapter_number = 5
        WHERE run_id = 'sparse-run' AND chapter_number = 4
      `).run()
    })()
    const imported: number[] = []
    const dependencies = realDependencies([], { current: false })
    dependencies.importReference = async (item, _run, authority) => {
      imported.push(item.number)
      const binding = ImportRunRepository.resolveReferenceImportAuthority('sparse-run', authority, item.number)
      const documentId = createHash('sha256').update(`reference-import:${binding.stableKey}`).digest('hex')
      getProjectDb()!.prepare(`
        INSERT INTO import_reference_documents (
          document_id, idempotency_key_hash, content_hash, chunk_set_hash,
          expected_chunk_count, corpus_kind, state
        ) VALUES (?, ?, ?, ?, 1, 'reference', 'committed')
      `).run(
        documentId,
        createHash('sha256').update(binding.stableKey).digest('hex'),
        binding.contentFingerprint,
        createHash('sha256').update(`chunks:${item.number}`).digest('hex'),
      )
      ImportRunRepository.commitReferenceImportReceipt('sparse-run', authority, item.number, documentId)
    }

    await new ImportRunOrchestrator(dependencies).executeStage(
      'sparse-run',
      'knowledge',
      'sparse-runner',
      { cancelled: false },
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
    )

    expect(imported).toEqual([3, 5])
    expect(ImportRunRepository.get('sparse-run')).toMatchObject({
      stage: 'global',
      completedBatches: {
        knowledge: [
          expect.stringMatching(/^3-3-[a-f0-9]{8}$/u),
          expect.stringMatching(/^5-5-[a-f0-9]{8}$/u),
        ],
      },
    })
  })

  it('resumes after reopen without recalling the model or repeating a committed blueprint effect', async () => {
    const modelCalls: number[][] = []
    const crashAfterFirstCommit = { current: true }
    const commitSpy = vi.spyOn(BlueprintRepository, 'commitRange')
    const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }

    await expect(new ImportRunOrchestrator(realDependencies(modelCalls, crashAfterFirstCommit)).executeStage(
      'integration-run', 'blueprints', 'renderer-before-crash', { cancelled: false }, callbacks,
    )).rejects.toThrow('injected crash after durable blueprint commit')

    const failedRun = ImportRunRepository.get('integration-run')!
    expect(failedRun).toMatchObject({
      stage: 'blueprints',
      status: 'failed',
      lastError: 'injected crash after durable blueprint commit',
      completedBatches: { blueprints: [expect.stringMatching(/^1-2-[a-f0-9]{8}\.[a-f0-9]{8}$/u)] },
    })
    const checkpoint = failedRun.completedBatches.blueprints![0]!
    expect(ImportRunRepository.getEffectReceipt('integration-run', 'blueprints', checkpoint))
      .toMatchObject({ state: 'committed', effectKey: `blueprints:${checkpoint}` })
    expect(BlueprintRepository.getAll()).toEqual([
      expect.objectContaining({ chapterNumber: 1, title: 'Generated 1' }),
      expect.objectContaining({ chapterNumber: 2, title: 'Generated 2' }),
    ])
    expect(modelCalls).toEqual([[1, 2]])
    expect(commitSpy).toHaveBeenCalledTimes(1)

    closeProjectDatabase()
    initProjectDatabase(root)
    expect(ImportRunRepository.getEffectReceipt('integration-run', 'blueprints', checkpoint))
      .toMatchObject({ state: 'committed', effectKey: `blueprints:${checkpoint}` })

    await new ImportRunOrchestrator(realDependencies(modelCalls, crashAfterFirstCommit)).executeStage(
      'integration-run', 'blueprints', 'renderer-after-reopen', { cancelled: false }, callbacks,
    )

    expect(ImportRunRepository.get('integration-run')).toMatchObject({
      stage: 'refresh',
      status: 'running',
      completedChapters: 2,
    })
    expect(BlueprintRepository.count()).toBe(2)
    expect(modelCalls).toEqual([[1, 2]])
    expect(commitSpy).toHaveBeenCalledTimes(1)
  })

  it('continues the same failed run after reopen without repeating committed knowledge or blueprint work', async () => {
    const runId = 'full-recovery-run'
    const chapters = Array.from({ length: 6 }, (_, index) => chapter(index + 1))
    ImportRunRepository.prepare({
      runId,
      purpose: 'reference',
      sourceFingerprint: 'c'.repeat(64),
      sourceDisplay: [{ displayName: 'full-recovery.txt', mediaType: 'text/plain', size: 66 }],
      locale: 'en-US',
      chapters,
    })
    getProjectDb()!.prepare(
      "INSERT INTO project_core (id, project_name) VALUES ('main', 'Recovery integration')",
    ).run()
    const assignedChapterNumbers = ImportRunRepository.listChapterBatch(
      runId,
      { afterChapterNumber: 0, limit: 100 },
    ).map(item => item.number)
    const firstBlueprintBatch = assignedChapterNumbers.slice(0, 5)
    const laterBlueprintBatch = assignedChapterNumbers.slice(5)
    const trace: RecoveryTrace = {
      knowledgeCalls: [],
      globalCalls: 0,
      styleCalls: 0,
      blueprintModelCalls: [],
      replayedBlueprintBatches: [],
      failSecondBlueprintBatchOnce: true,
    }
    const commitSpy = vi.spyOn(BlueprintRepository, 'commitRange')
    const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }
    const beforeReopen = new ImportRunOrchestrator(fullRecoveryDependencies(trace))

    await beforeReopen.executeStage(
      runId, 'knowledge', 'renderer-before-reopen', { cancelled: false }, callbacks,
    )
    await beforeReopen.executeStage(
      runId, 'global', 'renderer-before-reopen', { cancelled: false }, callbacks,
    )
    await beforeReopen.executeStage(
      runId, 'style', 'renderer-before-reopen', { cancelled: false }, callbacks,
    )
    await expect(beforeReopen.executeStage(
      runId, 'blueprints', 'renderer-before-reopen', { cancelled: false }, callbacks,
    )).rejects.toThrow('injected later blueprint model failure')

    const failedRun = ImportRunRepository.get(runId)!
    expect(failedRun).toMatchObject({
      id: runId,
      stage: 'blueprints',
      status: 'failed',
      lastError: 'injected later blueprint model failure',
      completedBatches: {
        knowledge: [expect.any(String)],
        global: ['done'],
        style: ['done'],
        blueprints: [expect.any(String)],
      },
    })
    const firstBlueprintCheckpoint = failedRun.completedBatches.blueprints![0]!
    const firstBlueprintReceipt = ImportRunRepository.getEffectReceipt(
      runId,
      'blueprints',
      firstBlueprintCheckpoint,
    )!
    const firstBlueprintEffect = firstBlueprintReceipt.effectReceipt as BlueprintRangeCommitReceipt
    expect(firstBlueprintReceipt.state).toBe('committed')
    expect(BlueprintRepository.getCharacterSyncOperation(
      firstBlueprintEffect.characterSyncOperation.operationId,
    )).toMatchObject({ status: 'completed' })
    expect(BlueprintRepository.count()).toBe(5)
    expect(trace.knowledgeCalls).toEqual(assignedChapterNumbers)
    expect(trace.globalCalls).toBe(1)
    expect(trace.styleCalls).toBe(1)
    expect(trace.blueprintModelCalls).toEqual([firstBlueprintBatch, laterBlueprintBatch])
    expect(getProjectDb()!.prepare(
      "SELECT COUNT(*) AS count FROM import_reference_documents WHERE state = 'committed'",
    ).get()).toEqual({ count: 6 })
    expect(getProjectDb()!.prepare(
      'SELECT COUNT(*) AS count FROM import_run_knowledge_receipts WHERE run_id = ?',
    ).get(runId)).toEqual({ count: 6 })
    const firstBlueprintOperationId = `import-blueprints-${runId}-${firstBlueprintBatch[0]}-${firstBlueprintBatch.at(-1)}`
    expect(commitSpy.mock.calls.filter(([request]) => (
      request.operationId === firstBlueprintOperationId
    ))).toHaveLength(1)

    closeProjectDatabase()
    initProjectDatabase(root)
    expect(ImportRunRepository.get(runId)).toMatchObject({
      stage: 'blueprints',
      status: 'failed',
    })
    expect(BlueprintRepository.getCharacterSyncOperation(
      firstBlueprintEffect.characterSyncOperation.operationId,
    )).toMatchObject({ status: 'completed' })

    const afterReopen = new ImportRunOrchestrator(fullRecoveryDependencies(trace))
    await afterReopen.executeStage(
      runId, 'blueprints', 'renderer-after-reopen', { cancelled: false }, callbacks,
    )
    await afterReopen.executeStage(
      runId, 'refresh', 'renderer-after-reopen', { cancelled: false }, callbacks,
    )

    expect(ImportRunRepository.get(runId)).toMatchObject({
      id: runId,
      stage: 'completed',
      status: 'completed',
      resumable: false,
      completedChapters: 6,
    })
    expect(trace.knowledgeCalls).toEqual(assignedChapterNumbers)
    expect(trace.globalCalls).toBe(1)
    expect(trace.styleCalls).toBe(1)
    expect(trace.blueprintModelCalls).toEqual([
      firstBlueprintBatch,
      laterBlueprintBatch,
      laterBlueprintBatch,
    ])
    expect(trace.replayedBlueprintBatches).toEqual([firstBlueprintCheckpoint])
    expect(BlueprintRepository.count()).toBe(6)
    expect(commitSpy.mock.calls.filter(([request]) => (
      request.operationId === firstBlueprintOperationId
    ))).toHaveLength(1)
    expect(commitSpy).toHaveBeenCalledTimes(2)
    expect(getProjectDb()!.prepare(
      "SELECT COUNT(*) AS count FROM import_reference_documents WHERE state = 'committed'",
    ).get()).toEqual({ count: 6 })
    expect(CharacterRosterRepository.read()).toMatchObject({
      status: 'ready',
      entries: [expect.objectContaining({ name: 'Mara' })],
    })
  })
})
