import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ImportRunRepository } from '../import-run-repository'
import type { ImportRunPrepareRequest } from '../../../src/shared/import-run'
import { createImportRunChapterBatchCheckpointId } from '../../../src/shared/import-run'
import { createHash } from 'node:crypto'

let root = ''
const CONTENT_FINGERPRINT = createHash('sha256').update('x').digest('hex')
const request: ImportRunPrepareRequest = {
  runId: 'leased-run', purpose: 'reference', sourceFingerprint: 'a'.repeat(64), locale: 'en-US',
  sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: 1 }],
  chapters: [{
    number: 1, title: 'One', content: 'x', contentSize: 1,
    contentFingerprint: CONTENT_FINGERPRINT,
  }],
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-lease-'))
  initProjectDatabase(root)
  ImportRunRepository.prepare(request)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('import execution lease', () => {
  it('keeps main-process authority stable across heartbeat expiry updates and fences it on takeover', () => {
    const first = ImportRunRepository.startOrResume('leased-run', 'renderer-a', 1_000, 100)
    const authority = { owner: first.execution.owner, epoch: first.execution.epoch }

    expect(() => ImportRunRepository.assertExecutionAuthority('leased-run', authority, 1_050)).not.toThrow()
    ImportRunRepository.renewExecution('leased-run', first.execution, 1_050, 100)
    expect(() => ImportRunRepository.assertExecutionAuthority('leased-run', authority, 1_149)).not.toThrow()

    ImportRunRepository.startOrResume('leased-run', 'renderer-b', 1_151, 100)
    expect(() => ImportRunRepository.assertExecutionAuthority('leased-run', authority, 1_151))
      .toThrow(/执行租约/)
  })

  it('authorizes only the frozen chapter bound to the active reference-import epoch', () => {
    const started = ImportRunRepository.startOrResume('leased-run', 'renderer-a', 1_000, 100)
    const authority = { owner: started.execution.owner, epoch: started.execution.epoch }
    expect(ImportRunRepository.resolveReferenceImportAuthority(
      'leased-run', authority, 1, 1_050,
    )).toMatchObject({ chapterNumber: 1, content: 'x', contentFingerprint: CONTENT_FINGERPRINT })
    expect(() => ImportRunRepository.resolveReferenceImportAuthority(
      'leased-run', authority, 2, 1_050,
    )).toThrow(/冻结章节/)
  })

  it('revokes knowledge and embedding authority as soon as cancellation is requested', () => {
    const started = ImportRunRepository.startOrResume('leased-run', 'renderer-a')
    const authority = { owner: started.execution.owner, epoch: started.execution.epoch }
    expect(() => ImportRunRepository.resolveReferenceImportAuthority(
      'leased-run', authority, 1,
    )).not.toThrow()

    ImportRunRepository.requestCancel('leased-run', started.execution)

    expect(() => ImportRunRepository.resolveReferenceImportAuthority(
      'leased-run', authority, 1,
    )).toThrow(/冻结章节/)
  })

  it('rejects a concurrent owner, allows expiry takeover, and rejects every stale mutation', () => {
    const first = ImportRunRepository.startOrResume('leased-run', 'renderer-a', 1_000, 100)
    expect(() => ImportRunRepository.startOrResume('leased-run', 'renderer-b', 1_050, 100))
      .toThrow(/正在由另一执行器运行/)

    const takeover = ImportRunRepository.startOrResume('leased-run', 'renderer-b', 1_101, 100)
    expect(takeover.execution.epoch).toBe(first.execution.epoch + 1)

    expect(() => ImportRunRepository.completeBatch('leased-run', 'knowledge', '1', first.execution)).toThrow(/执行租约/)
    expect(() => ImportRunRepository.advanceStage('leased-run', 'knowledge', 'global', first.execution)).toThrow(/执行租约/)
    expect(() => ImportRunRepository.fail('leased-run', 'knowledge', 'late', first.execution)).toThrow(/执行租约/)
    expect(() => ImportRunRepository.cancelAtBoundary('leased-run', first.execution)).toThrow(/执行租约/)
    expect(() => ImportRunRepository.complete('leased-run', first.execution)).toThrow(/执行租约/)
  })

  it('releases and fences the execution lease on failure so another owner can resume immediately', () => {
    const base = Date.now()
    const first = ImportRunRepository.startOrResume('leased-run', 'renderer-a', base, 60_000)

    expect(ImportRunRepository.fail(
      'leased-run', 'knowledge', 'provider unavailable', first.execution,
    )).toMatchObject({ status: 'failed' })

    const resumed = ImportRunRepository.startOrResume('leased-run', 'renderer-b', base + 1, 60_000)
    expect(resumed.execution.epoch).toBeGreaterThan(first.execution.epoch)
    expect(() => ImportRunRepository.completeBatch(
      'leased-run', 'knowledge', 'late-old-runner', first.execution,
    )).toThrow(/执行租约/)
  })

  it('releases and fences cancellation and completion terminal boundaries', () => {
    const base = Date.now()
    const first = ImportRunRepository.startOrResume('leased-run', 'renderer-a', base, 60_000)
    const binding = ImportRunRepository.resolveReferenceImportAuthority('leased-run', first.execution, 1)
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
      createHash('sha256').update('chunks:1').digest('hex'),
    )
    ImportRunRepository.commitReferenceImportReceipt(
      'leased-run', first.execution, 1, documentId,
    )
    const checkpoint = createImportRunChapterBatchCheckpointId([{ number: 1, contentFingerprint: CONTENT_FINGERPRINT }])
    ImportRunRepository.requestCancel('leased-run', first.execution)
    expect(ImportRunRepository.completeBatch(
      'leased-run', 'knowledge', checkpoint, first.execution,
    )).toMatchObject({ cancelApplied: true, run: { status: 'cancelled' } })

    const resumed = ImportRunRepository.startOrResume('leased-run', 'renderer-b', base + 1, 60_000)
    expect(resumed.execution.epoch).toBeGreaterThan(first.execution.epoch)
    expect(() => ImportRunRepository.cancelAtBoundary('leased-run', first.execution)).toThrow(/执行租约/)

    getProjectDb()!.prepare(`
      UPDATE import_runs
      SET stage = 'refresh', completed_batches_json = '{"refresh":["done"]}'
      WHERE id = 'leased-run'
    `).run()
    expect(ImportRunRepository.complete('leased-run', resumed.execution))
      .toMatchObject({ status: 'completed', resumable: false })
    expect(() => ImportRunRepository.startOrResume('leased-run', 'renderer-c', base + 2, 60_000))
      .toThrow(/不可启动/)
    expect(() => ImportRunRepository.fail(
      'leased-run', 'knowledge', 'late-after-complete', resumed.execution,
    )).toThrow(/执行租约/)
  })

  it('fences a running lease when the project database reopens and allows immediate takeover', () => {
    const base = Date.now()
    const first = ImportRunRepository.startOrResume('leased-run', 'renderer-a', base, 60_000)

    closeProjectDatabase()
    initProjectDatabase(root)

    const resumed = ImportRunRepository.startOrResume('leased-run', 'renderer-b', base + 1, 60_000)
    expect(resumed.execution.epoch).toBeGreaterThan(first.execution.epoch)
    expect(() => ImportRunRepository.fail(
      'leased-run', 'knowledge', 'stale process', first.execution,
    )).toThrow(/执行租约/)
  })

  it('restarts only terminal or expired-running runs and fences the old execution epoch', () => {
    expect(() => ImportRunRepository.restart('leased-run', 'ready-restart', 1_000))
      .toThrow(/不可重新开始/)

    const first = ImportRunRepository.startOrResume('leased-run', 'renderer-a', 1_000, 100)
    expect(() => ImportRunRepository.restart('leased-run', 'active-restart', 1_050))
      .toThrow(/不可重新开始/)

    expect(ImportRunRepository.restart('leased-run', 'expired-restart', 1_101))
      .toMatchObject({ id: 'expired-restart', status: 'ready' })
    expect(() => ImportRunRepository.completeBatch(
      'leased-run', 'knowledge', 'late-after-restart', first.execution,
    )).toThrow(/执行租约/)
  })

  it('serializes execution across different import runs in the same project and allows expiry takeover', () => {
    ImportRunRepository.prepare({
      ...request,
      runId: 'second-run',
      sourceFingerprint: 'c'.repeat(64),
    })
    const first = ImportRunRepository.startOrResume('leased-run', 'renderer-a', 1_000, 100)

    expect(() => ImportRunRepository.startOrResume('second-run', 'renderer-b', 1_050, 100))
      .toThrow(/项目.*导入|另一.*导入|正在运行/)

    expect(ImportRunRepository.startOrResume('second-run', 'renderer-b', 1_101, 100))
      .toMatchObject({ run: { id: 'second-run', status: 'running' } })
    expect(() => ImportRunRepository.startOrResume('leased-run', 'renderer-c', 1_102, 100))
      .toThrow(/项目.*导入|另一.*导入|正在运行/)
    expect(() => ImportRunRepository.renewExecution('leased-run', first.execution, 1_102, 100))
      .toThrow(/执行租约/)
  })

  it('rejects a tampered frozen snapshot at both paged-read and knowledge-authority seams after reopen', () => {
    ImportRunRepository.startOrResume('leased-run', 'renderer-a', 1_000, 100)
    getProjectDb()!.prepare(`
      UPDATE import_run_chapters SET content_snapshot = 'y' WHERE run_id = 'leased-run'
    `).run()

    closeProjectDatabase()
    initProjectDatabase(root)
    const resumed = ImportRunRepository.startOrResume('leased-run', 'renderer-b', 1_050, 100)

    expect(() => ImportRunRepository.listChapterBatch(
      'leased-run', { afterChapterNumber: 0, limit: 10 },
    )).toThrow(/冻结.*快照|快照.*损坏/)
    expect(() => ImportRunRepository.resolveReferenceImportAuthority(
      'leased-run', resumed.execution, 1, 1_051,
    )).toThrow(/冻结.*快照|快照.*损坏/)
  })

  it('checks UTF-8 byte size independently of a matching snapshot fingerprint', () => {
    const content = 'é'
    getProjectDb()!.prepare(`
      UPDATE import_run_chapters
      SET content_snapshot = ?, content_fingerprint = ?
      WHERE run_id = 'leased-run'
    `).run(content, createHash('sha256').update(content).digest('hex'))

    expect(() => ImportRunRepository.listChapterBatch(
      'leased-run', { afterChapterNumber: 0, limit: 10 },
    )).toThrow(/冻结.*快照|快照.*损坏/)
  })
})
