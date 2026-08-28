import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ImportRunRepository } from '../import-run-repository'
import type { ImportRunPrepareRequest } from '../../../src/shared/import-run'

let root = ''
const request: ImportRunPrepareRequest = {
  runId: 'leased-run', purpose: 'reference', sourceFingerprint: 'a'.repeat(64), locale: 'en-US',
  sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: 1 }],
  chapters: [{
    number: 1, title: 'One', content: 'x', contentSize: 1,
    contentFingerprint: 'b'.repeat(64),
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
    const expectedKey = `reference:${'a'.repeat(64)}:1:${'b'.repeat(64)}`

    expect(() => ImportRunRepository.assertReferenceImportAuthority(
      'leased-run', authority, expectedKey, 'x', 1_050,
    )).not.toThrow()
    expect(() => ImportRunRepository.assertReferenceImportAuthority(
      'leased-run', authority, expectedKey, 'changed', 1_050,
    )).toThrow(/冻结章节/)
    expect(() => ImportRunRepository.assertReferenceImportAuthority(
      'leased-run', authority, 'reference:forged:1:key', 'x', 1_050,
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
    ImportRunRepository.requestCancel('leased-run', first.execution)
    expect(ImportRunRepository.completeBatch(
      'leased-run', 'knowledge', '1-1', first.execution,
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
})
