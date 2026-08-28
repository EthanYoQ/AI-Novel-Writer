import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { BlueprintRepository, type BlueprintData } from '../blueprint-repository'
import { ImportRunRepository } from '../import-run-repository'
import {
  ImportRunOrchestrator,
  type ImportRunOrchestratorDependencies,
} from '../../../src/services/workflows/import-run-orchestrator'
import type { ImportRunChapterSnapshot } from '../../../src/shared/import-run'

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
})
