import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, initProjectDatabase } from '../../database'
import { ProjectCoreRepository } from '../project-core-repository'
import { ImportRunRepository } from '../import-run-repository'

let root = ''
const content = 'reference'

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-receipt-'))
  initProjectDatabase(root)
  ProjectCoreRepository.init('Receipt Test')
  ImportRunRepository.prepare({
    runId: 'receipt-run',
    purpose: 'reference',
    sourceFingerprint: 'a'.repeat(64),
    sourceDisplay: [{ displayName: 'book.txt', mediaType: 'text/plain', size: content.length }],
    locale: 'en-US',
    chapters: [{
      number: 1,
      title: 'One',
      content,
      contentFingerprint: createHash('sha256').update(content).digest('hex'),
      contentSize: Buffer.byteLength(content),
    }],
  })
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('import-run durable effect receipt', () => {
  it('freezes generated output before effect commit and atomically commits effect with checkpoint after reopen', () => {
    let started = ImportRunRepository.startOrResume('receipt-run', 'renderer-a')
    ImportRunRepository.advanceStage('receipt-run', 'knowledge', 'global', started.execution)
    ImportRunRepository.advanceStage('receipt-run', 'global', 'style', started.execution)
    const prepared = ImportRunRepository.prepareEffectReceipt({
      runId: 'receipt-run',
      stage: 'style',
      batchId: 'done',
      effectKey: 'writing-style',
      kind: 'project-writing-style',
      payload: { writingStyle: 'Frozen generated style' },
    }, started.execution)
    expect(prepared).toMatchObject({ state: 'prepared', payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(ProjectCoreRepository.get()?.writingStyle).toBe('')

    closeProjectDatabase()
    initProjectDatabase(root)
    started = ImportRunRepository.startOrResume('receipt-run', 'renderer-a')
    expect(ImportRunRepository.getEffectReceipt('receipt-run', 'style', 'done')).toMatchObject({ state: 'prepared' })

    const committed = ImportRunRepository.commitEffectReceipt(
      'receipt-run', 'style', 'done', started.execution,
    )
    expect(ProjectCoreRepository.get()?.writingStyle).toBe('Frozen generated style')
    expect(committed).toMatchObject({
      receipt: { state: 'committed' },
      run: { completedBatches: { style: ['done'] } },
    })
    expect(ImportRunRepository.commitEffectReceipt(
      'receipt-run', 'style', 'done', started.execution,
    )).toMatchObject({ receipt: { state: 'committed' } })
  })

  it('binds a receipt key to one payload and rejects a stale execution lease', () => {
    const base = Date.now()
    const first = ImportRunRepository.startOrResume('receipt-run', 'renderer-a', base, 100)
    ImportRunRepository.advanceStage('receipt-run', 'knowledge', 'global', first.execution)
    ImportRunRepository.advanceStage('receipt-run', 'global', 'style', first.execution)
    const request = {
      runId: 'receipt-run',
      stage: 'style' as const,
      batchId: 'done',
      effectKey: 'writing-style',
      kind: 'project-writing-style' as const,
      payload: { writingStyle: 'First' },
    }
    ImportRunRepository.prepareEffectReceipt(request, first.execution, base + 1)
    expect(() => ImportRunRepository.prepareEffectReceipt({
      ...request,
      payload: { writingStyle: 'Different' },
    }, first.execution, base + 2)).toThrow(/不同载荷/)

    ImportRunRepository.startOrResume('receipt-run', 'renderer-b', base + 101, 100)
    expect(() => ImportRunRepository.commitEffectReceipt(
      'receipt-run', 'style', 'done', first.execution, base + 102,
    )).toThrow(/执行租约/)
  })
})
