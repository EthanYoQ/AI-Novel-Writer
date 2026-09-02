import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ProjectCoreRepository } from '../project-core-repository'
import { ImportRunRepository } from '../import-run-repository'
import { BlueprintRepository, type BlueprintData } from '../blueprint-repository'
import { CharacterRosterRepository } from '../character-roster-repository'

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

const blueprint: BlueprintData = {
  chapterNumber: 1,
  title: 'Chapter One',
  role: 'setup',
  purpose: 'Introduce the conflict',
  keyEvents: 'The protagonist discovers a clue',
  characters: ['Protagonist'],
  suspenseHook: 'Someone knocks at the door',
  userGuidance: '',
  notes: '',
  notesUpdatedAt: '',
}

function prepareCommittedBlueprintReceipt(): void {
  const batchId = `1-1-${createHash('sha256').update(content).digest('hex').slice(0, 8)}`
  const started = ImportRunRepository.startOrResume('receipt-run', 'renderer-a')
  getProjectDb()!.prepare(`
    UPDATE import_runs
    SET stage = 'blueprints', completed_batches_json = '{"knowledge":["1-1"],"global":["done"],"style":["done"]}'
    WHERE id = 'receipt-run'
  `).run()
  ImportRunRepository.prepareEffectReceipt({
    runId: 'receipt-run',
    stage: 'blueprints',
    batchId,
    effectKey: `blueprints:${batchId}`,
    kind: 'chapter-blueprint-range',
    payload: {
      mode: 'replace-range',
      operationId: 'import-blueprints-receipt-run-1-1',
      startChapter: 1,
      endChapter: 1,
      blueprints: [blueprint],
    },
  }, started.execution)
  ImportRunRepository.commitEffectReceipt('receipt-run', 'blueprints', batchId, started.execution)
}

function prepareCommittedGlobalReceipt(): void {
  const started = ImportRunRepository.startOrResume('receipt-run', 'renderer-a')
  getProjectDb()!.prepare(`
    UPDATE import_runs
    SET stage = 'global', completed_batches_json = '{"knowledge":["1-1"]}'
    WHERE id = 'receipt-run'
  `).run()
  ImportRunRepository.prepareEffectReceipt({
    runId: 'receipt-run',
    stage: 'global',
    batchId: 'done',
    effectKey: 'global-facts',
    kind: 'project-global-facts',
    payload: {
      operationId: 'novel-import-global-receipt-run',
      expectedRosterRevision: 0,
      core: {
        genre: 'Literary', subGenre: 'Drama', targetAudience: 'General', totalChapters: 1,
        wordsPerChapter: 2000, plotStructure: 'three_act', narrativePov: 'third_limited',
        goldenFinger: 'None', globalGuidance: 'Concise', coreOutline: 'A conflict unfolds',
        worldSetting: 'A small town', protagonistProfile: 'A careful observer',
        premise: 'Truth has a cost', worldbuilding: 'Contemporary', synopsis: 'A discovery changes a life',
      },
      characterEntries: [{
        name: 'Protagonist', role: 'protagonist', gender: '', age: '', appearance: '',
        personality: '', background: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '',
      }],
    },
  }, started.execution)
  ImportRunRepository.commitEffectReceipt('receipt-run', 'global', 'done', started.execution)
}

describe('import-run durable effect receipt', () => {
  it('reopens a committed blueprint receipt after its durable character sync completes', () => {
    prepareCommittedBlueprintReceipt()
    const operation = BlueprintRepository.getCommittedRangeOperation('import-blueprints-receipt-run-1-1')
    expect(operation?.characterSyncOperation.status).toBe('pending')

    CharacterRosterRepository.commit({
      operationId: operation!.characterSyncOperation.operationId,
      expectedRevision: 0,
      schemaVersion: 1,
      intent: 'blueprint_sync',
      entries: [{
        name: 'Protagonist', role: 'supporting', gender: '', age: '', appearance: '',
        personality: '', background: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '',
      }],
    })
    expect(BlueprintRepository.completeCharacterSyncOperation(
      operation!.characterSyncOperation.operationId,
    ).status).toBe('completed')

    closeProjectDatabase()
    initProjectDatabase(root)

    expect(ImportRunRepository.getEffectReceipt('receipt-run', 'blueprints', '1-1-52367a66'))
      .toMatchObject({
        state: 'committed',
        effectReceipt: {
          operationId: 'import-blueprints-receipt-run-1-1',
          characterSyncOperation: { status: 'pending' },
        },
      })
  })

  it('rejects an offline-forged committed sync receipt without its roster operation proof', () => {
    prepareCommittedBlueprintReceipt()
    CharacterRosterRepository.commit({
      operationId: 'different-roster-operation',
      expectedRevision: 0,
      schemaVersion: 1,
      intent: 'blueprint_sync',
      entries: [{
        name: 'Protagonist', role: 'supporting', gender: '', age: '', appearance: '',
        personality: '', background: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '',
      }],
    })
    tamperOffline(`
      UPDATE blueprint_character_sync_operations
      SET status = 'completed',
          completion_receipt = json_object(
            'blueprintCommitOperationId', 'import-blueprints-receipt-run-1-1',
            'operationId', 'blueprint-sync-import-blueprints-receipt-run-1-1',
            'status', 'committed',
            'rosterReceipt', json_object(
              'operationId', 'blueprint-sync-import-blueprints-receipt-run-1-1',
              'payloadHash', '${'f'.repeat(64)}',
              'revision', 1,
              'idempotent', json('false')
            )
          ),
          completed_at = created_at
      WHERE operation_id = 'blueprint-sync-import-blueprints-receipt-run-1-1'
    `)

    expect(() => ImportRunRepository.getEffectReceipt('receipt-run', 'blueprints', '1-1-52367a66'))
      .toThrow(/receipt.*损坏|收据.*损坏/i)
  })

  it('accepts an already-satisfied receipt when blueprints need no existing-roster relationship update', () => {
    prepareCommittedBlueprintReceipt()
    tamperOffline(`
      UPDATE blueprint_character_sync_operations
      SET status = 'completed',
          completion_receipt = json_object(
            'blueprintCommitOperationId', 'import-blueprints-receipt-run-1-1',
            'operationId', 'blueprint-sync-import-blueprints-receipt-run-1-1',
            'status', 'already-satisfied'
          ),
          completed_at = created_at
      WHERE operation_id = 'blueprint-sync-import-blueprints-receipt-run-1-1'
    `)

    expect(ImportRunRepository.getEffectReceipt('receipt-run', 'blueprints', '1-1-52367a66'))
      .toMatchObject({ state: 'committed' })
  })

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

  it('fails closed after reopen when a blueprint receipt swaps its nested sync operation', () => {
    prepareCommittedBlueprintReceipt()
    tamperOffline(`
      INSERT INTO blueprint_commit_operations (
        operation_id, payload_hash, mode, start_chapter, end_chapter, character_sync_input
      ) SELECT
        'import-blueprints-another-run-1-1', payload_hash, mode, start_chapter, end_chapter, character_sync_input
      FROM blueprint_commit_operations
      WHERE operation_id = 'import-blueprints-receipt-run-1-1';
      INSERT INTO blueprint_character_sync_operations (
        operation_id, blueprint_commit_operation_id, blueprint_commit_payload_hash,
        status, start_chapter, end_chapter, character_sync_input
      ) SELECT
        'blueprint-sync-import-blueprints-another-run-1-1',
        'import-blueprints-another-run-1-1', blueprint_commit_payload_hash,
        status, start_chapter, end_chapter, character_sync_input
      FROM blueprint_character_sync_operations
      WHERE operation_id = 'blueprint-sync-import-blueprints-receipt-run-1-1';
      UPDATE import_run_receipts
      SET effect_receipt_json = json_set(
        effect_receipt_json,
        '$.characterSyncOperation.operationId',
        'blueprint-sync-import-blueprints-another-run-1-1',
        '$.characterSyncOperation.blueprintCommitOperationId',
        'import-blueprints-another-run-1-1'
      )
    `)

    expect(() => ImportRunRepository.getEffectReceipt('receipt-run', 'blueprints', '1-1-52367a66'))
      .toThrow(/receipt.*损坏|收据.*损坏/i)
    expect(getProjectDb()!.prepare(`
      SELECT stage, status FROM import_runs WHERE id = 'receipt-run'
    `).get()).toEqual({ stage: 'blueprints', status: 'running' })
  })

  it.each([
    ['payload hash', `UPDATE blueprint_commit_operations SET payload_hash = '${'0'.repeat(64)}' WHERE operation_id = 'import-blueprints-receipt-run-1-1'`],
    ['range', `UPDATE blueprint_commit_operations SET end_chapter = 2 WHERE operation_id = 'import-blueprints-receipt-run-1-1'`],
    ['sync status', `UPDATE blueprint_character_sync_operations SET status = 'completed' WHERE operation_id = 'blueprint-sync-import-blueprints-receipt-run-1-1'`],
  ])('fails closed after reopen when authoritative blueprint %s is tampered', (_label, mutation) => {
    prepareCommittedBlueprintReceipt()
    tamperOffline(mutation)

    expect(() => ImportRunRepository.getEffectReceipt('receipt-run', 'blueprints', '1-1-52367a66'))
      .toThrow(/receipt.*损坏|收据.*损坏/i)
    expect(getProjectDb()!.prepare(`
      SELECT stage, status FROM import_runs WHERE id = 'receipt-run'
    `).get()).toEqual({ stage: 'blueprints', status: 'running' })
  })

  it('does not recreate a deleted authoritative operation while validating replay', () => {
    prepareCommittedBlueprintReceipt()
    tamperOffline(`
      DELETE FROM blueprint_commit_operations
      WHERE operation_id = 'import-blueprints-receipt-run-1-1'
    `)

    expect(() => ImportRunRepository.getEffectReceipt('receipt-run', 'blueprints', '1-1-52367a66'))
      .toThrow(/receipt.*损坏|收据.*损坏/i)
    expect(getProjectDb()!.prepare(`
      SELECT COUNT(*) AS count FROM blueprint_commit_operations
      WHERE operation_id = 'import-blueprints-receipt-run-1-1'
    `).get()).toEqual({ count: 0 })
  })

  it.each([
    ['extra key', `json_set(effect_receipt_json, '$.unexpected', 1)`],
    ['missing key', `json_remove(effect_receipt_json, '$.payloadHash')`],
    ['nested payload hash', `json_set(effect_receipt_json, '$.characterSyncOperation.blueprintCommitPayloadHash', '${'0'.repeat(64)}')`],
    ['range', `json_set(effect_receipt_json, '$.endChapter', 2)`],
  ])('rejects a committed blueprint receipt with a tampered %s', (_label, expression) => {
    prepareCommittedBlueprintReceipt()
    tamperOffline(`UPDATE import_run_receipts SET effect_receipt_json = ${expression}`)

    expect(() => ImportRunRepository.getEffectReceipt('receipt-run', 'blueprints', '1-1-52367a66'))
      .toThrow(/receipt.*损坏|收据.*损坏/i)
    expect(getProjectDb()!.prepare(`
      SELECT status FROM blueprint_character_sync_operations
      WHERE operation_id = 'blueprint-sync-import-blueprints-receipt-run-1-1'
    `).get()).toEqual({ status: 'pending' })
  })

  it('rejects a global receipt whose operation ledger hash changes after reopen', () => {
    prepareCommittedGlobalReceipt()
    tamperOffline(`
      UPDATE import_global_fact_operations
      SET payload_hash = '${'0'.repeat(64)}'
      WHERE operation_id = 'novel-import-global-receipt-run'
    `)

    expect(() => ImportRunRepository.getEffectReceipt('receipt-run', 'global', 'done'))
      .toThrow(/receipt.*损坏|收据.*损坏/i)
  })
})
