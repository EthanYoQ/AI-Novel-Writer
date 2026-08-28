import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ImportRunRepository } from '../import-run-repository'
import {
  createImportRunChapterBatchCheckpointId,
  type ImportRunExecutionLease,
} from '../../../src/shared/import-run'

let root = ''
let execution: ImportRunExecutionLease

function chapter(number: number) {
  const content = `reference-${number}`
  return {
    number,
    title: `Chapter ${number}`,
    content,
    contentFingerprint: createHash('sha256').update(content).digest('hex'),
    contentSize: Buffer.byteLength(content),
  }
}

function expectRejectedWithoutMutation(action: () => unknown, message: RegExp): void {
  const beforeBytes = getProjectDb()!.serialize()
  const beforeRun = ImportRunRepository.get('state-run')

  expect(action).toThrow(message)

  expect(getProjectDb()!.serialize().equals(beforeBytes)).toBe(true)
  expect(ImportRunRepository.get('state-run')).toEqual(beforeRun)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-state-'))
  initProjectDatabase(root)
  ImportRunRepository.prepare({
    runId: 'state-run',
    purpose: 'reference',
    sourceFingerprint: 'a'.repeat(64),
    sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: 22 }],
    locale: 'en-US',
    chapters: [chapter(1), chapter(2)],
  })
  execution = ImportRunRepository.startOrResume('state-run', 'state-test').execution
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('ImportRunRepository state machine', () => {
  it('rejects wrong-stage and malformed direct batch checkpoints without changing the database', () => {
    expectRejectedWithoutMutation(
      () => ImportRunRepository.completeBatch('state-run', 'global', 'done', execution),
      /当前阶段|阶段.*不匹配/,
    )
    expectRejectedWithoutMutation(
      () => ImportRunRepository.completeBatch('state-run', 'knowledge', '1', execution),
      /批次.*无效/,
    )
    expectRejectedWithoutMutation(
      () => ImportRunRepository.completeBatch('state-run', 'knowledge', '1-3', execution),
      /批次.*无效/,
    )
  })

  it('advances only to the next stage after every current-stage checkpoint is complete', () => {
    expectRejectedWithoutMutation(
      () => ImportRunRepository.advanceStage('state-run', 'knowledge', 'global', execution),
      /checkpoint.*未完成|检查点.*未完成/i,
    )

    ImportRunRepository.completeBatch('state-run', 'knowledge', '1-2', execution)
    expectRejectedWithoutMutation(
      () => ImportRunRepository.advanceStage('state-run', 'knowledge', 'style', execution),
      /下一阶段|转换.*无效/,
    )

    expect(ImportRunRepository.advanceStage('state-run', 'knowledge', 'global', execution))
      .toMatchObject({ stage: 'global', status: 'running' })
    expectRejectedWithoutMutation(
      () => ImportRunRepository.completeBatch('state-run', 'global', 'done', execution),
      /receipt|收据/i,
    )
    expectRejectedWithoutMutation(
      () => ImportRunRepository.advanceStage('state-run', 'global', 'style', execution),
      /checkpoint.*未完成|检查点.*未完成/i,
    )
  })

  it('fails only the active stage and fences all later writes from that execution', () => {
    expectRejectedWithoutMutation(
      () => ImportRunRepository.fail('state-run', 'global', 'wrong stage', execution),
      /当前阶段|阶段.*不匹配/,
    )

    expect(ImportRunRepository.fail('state-run', 'knowledge', 'provider unavailable', execution))
      .toMatchObject({ stage: 'knowledge', status: 'failed', lastError: 'provider unavailable' })
    expect(() => ImportRunRepository.completeBatch('state-run', 'knowledge', '1-2', execution))
      .toThrow(/执行租约/)
  })

  it('rejects malformed or mismatched blueprint receipt keys before writing receipt state', () => {
    getProjectDb()!.prepare(`
      UPDATE import_runs SET stage = 'blueprints' WHERE id = 'state-run'
    `).run()
    const payload = {
      mode: 'replace-range',
      operationId: 'state-blueprint-operation',
      startChapter: 1,
      endChapter: 2,
      blueprints: [
        { chapterNumber: 1, title: 'One' },
        { chapterNumber: 2, title: 'Two' },
      ],
    }
    expectRejectedWithoutMutation(() => ImportRunRepository.prepareEffectReceipt({
      runId: 'state-run',
      stage: 'blueprints',
      batchId: '1-2',
      effectKey: 'blueprints:1-2',
      kind: 'chapter-blueprint-range',
      payload,
    }, execution), /批次.*无效/)

    const checkpoint = createImportRunChapterBatchCheckpointId(
      ImportRunRepository.listChapterBatch('state-run', { afterChapterNumber: 0, limit: 10 }),
    )
    expectRejectedWithoutMutation(() => ImportRunRepository.prepareEffectReceipt({
      runId: 'state-run',
      stage: 'blueprints',
      batchId: checkpoint,
      effectKey: 'blueprints:mismatched',
      kind: 'chapter-blueprint-range',
      payload,
    }, execution), /receipt.*损坏|收据.*损坏/i)

    expectRejectedWithoutMutation(() => ImportRunRepository.prepareEffectReceipt({
      runId: 'state-run',
      stage: 'blueprints',
      batchId: checkpoint,
      effectKey: `blueprints:${checkpoint}`,
      kind: 'chapter-blueprint-range',
      payload: { ...payload, startChapter: 2, endChapter: 3 },
    }, execution), /receipt.*损坏|收据.*损坏/i)
  })

  it('completes only a running refresh stage with its durable refresh checkpoint', () => {
    expectRejectedWithoutMutation(
      () => ImportRunRepository.complete('state-run', execution),
      /refresh|刷新/i,
    )

    getProjectDb()!.prepare(`
      UPDATE import_runs SET stage = 'refresh', completed_batches_json = '{}'
      WHERE id = 'state-run'
    `).run()
    expectRejectedWithoutMutation(
      () => ImportRunRepository.complete('state-run', execution),
      /checkpoint.*未完成|检查点.*未完成/i,
    )

    ImportRunRepository.completeBatch('state-run', 'refresh', 'done', execution)
    expect(ImportRunRepository.complete('state-run', execution)).toMatchObject({
      stage: 'completed',
      status: 'completed',
      resumable: false,
    })
    expect(() => ImportRunRepository.fail('state-run', 'refresh', 'late failure', execution))
      .toThrow(/执行租约/)
  })
})
