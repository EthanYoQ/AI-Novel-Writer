import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ProjectCoreRepository } from '../project-core-repository'
import { ImportRunRepository } from '../import-run-repository'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

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

function prepareStyleReceipt() {
  const started = ImportRunRepository.startOrResume('receipt-run', 'renderer-a')
  moveRunToStyle()
  ImportRunRepository.prepareEffectReceipt({
    runId: 'receipt-run',
    stage: 'style',
    batchId: 'done',
    effectKey: 'writing-style',
    kind: 'project-writing-style',
    payload: { writingStyle: 'Frozen generated style' },
  }, started.execution)
  return started.execution
}

function moveRunToStyle(): void {
  getProjectDb()!.prepare(`
    UPDATE import_runs
    SET stage = 'style', completed_batches_json = '{"knowledge":["1-1"],"global":["done"]}'
    WHERE id = 'receipt-run'
  `).run()
}

function tamperOffline(sql: string): void {
  closeProjectDatabase()
  const offline = new Database(path.join(root, '.vela', 'vela.db'))
  offline.exec(sql)
  offline.close()
  initProjectDatabase(root)
}

describe('import-run durable effect receipt', () => {
  it('freezes generated output before effect commit and atomically commits effect with checkpoint after reopen', () => {
    let started = ImportRunRepository.startOrResume('receipt-run', 'renderer-a')
    moveRunToStyle()
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
    moveRunToStyle()
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

  it.each([
    ['payload', `UPDATE import_run_receipts SET payload_json = '{"writingStyle":"tampered"}'`],
    ['hash', `UPDATE import_run_receipts SET payload_hash = '${'0'.repeat(64)}'`],
    ['namespace', `UPDATE import_run_receipts SET effect_namespace = 'import:reference:other'`],
    ['effect key', `UPDATE import_run_receipts SET effect_key = 'other-key'`],
    ['kind/stage binding', `UPDATE import_run_receipts SET kind = 'project-global-facts'`],
    ['schema version', 'UPDATE import_run_receipts SET schema_version = 2'],
  ])('fails closed after reopen when stored receipt %s is tampered', (_label, mutation) => {
    prepareStyleReceipt()
    tamperOffline(mutation)

    expect(() => ImportRunRepository.getEffectReceipt('receipt-run', 'style', 'done'))
      .toThrow(/receipt.*损坏|收据.*损坏/i)
  })

  it('fails closed after reopen when a committed effect result is not valid for its kind', () => {
    const execution = prepareStyleReceipt()
    ImportRunRepository.commitEffectReceipt('receipt-run', 'style', 'done', execution)
    tamperOffline(`UPDATE import_run_receipts SET effect_receipt_json = '{}'`)

    expect(() => ImportRunRepository.getEffectReceipt('receipt-run', 'style', 'done'))
      .toThrow(/receipt.*损坏|收据.*损坏/i)
  })
})
