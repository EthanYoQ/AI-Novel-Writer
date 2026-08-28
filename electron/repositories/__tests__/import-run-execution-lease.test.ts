import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, initProjectDatabase } from '../../database'
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
})
