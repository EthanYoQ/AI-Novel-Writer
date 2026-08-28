import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ImportRunRepository } from '../import-run-repository'

let root = ''
const SOURCE_A = '11111111-1111-4111-8111-111111111111'
const SOURCE_B = '22222222-2222-4222-8222-222222222222'

function chapter(number: number, content = `source chapter ${number}`) {
  return {
    number,
    title: `Chapter ${number}`,
    content,
    contentFingerprint: createHash('sha256').update(content).digest('hex'),
    contentSize: Buffer.byteLength(content),
  }
}

function begin() {
  return ImportRunRepository.beginParsing({
    runId: 'parse-run',
    purpose: 'reference',
    sourceFingerprint: 'a'.repeat(64),
    sourceIds: [SOURCE_A, SOURCE_B],
    sourceFingerprints: ['b'.repeat(64), 'c'.repeat(64)],
    sourceDisplay: [
      { displayName: 'a.txt', mediaType: 'text/plain', size: 20 },
      { displayName: 'b.txt', mediaType: 'text/plain', size: 20 },
    ],
    locale: 'en-US',
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-parsing-'))
  initProjectDatabase(root)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('persisted per-source parsing', () => {
  it('reopens with completed sources intact and only accepts the missing source after reauthorization', () => {
    expect(begin()).toMatchObject({ stage: 'parsing', completedSources: 0, totalSources: 2 })
    ImportRunRepository.commitParsedSource('parse-run', SOURCE_A, [chapter(1), chapter(2)])
    expect(ImportRunRepository.get('parse-run')).toMatchObject({
      stage: 'parsing', completedSources: 1, totalSources: 2, completedChapters: 2,
    })

    closeProjectDatabase()
    initProjectDatabase(root)
    expect(begin()).toMatchObject({ id: 'parse-run', stage: 'parsing', completedSources: 1 })
    expect(ImportRunRepository.commitParsedSource('parse-run', SOURCE_A, [chapter(1), chapter(2)]))
      .toMatchObject({ completedSources: 1 })
    ImportRunRepository.commitParsedSource('parse-run', SOURCE_B, [chapter(1, 'second source')])

    const prepared = ImportRunRepository.finalizeParsing('parse-run')
    expect(prepared).toMatchObject({ classification: 'new', run: { stage: 'prepared', totalChapters: 3 } })
    expect(ImportRunRepository.startOrResume('parse-run', 'renderer')).toMatchObject({
      run: { stage: 'knowledge', status: 'running' },
    })
  })

  it('commits one source atomically and leaves no half-source snapshots after validation failure', () => {
    begin()
    const before = getProjectDb()!.serialize()
    expect(() => ImportRunRepository.commitParsedSource('parse-run', SOURCE_A, [
      chapter(1),
      { ...chapter(2), contentFingerprint: '0'.repeat(64) },
    ])).toThrow(/快照|指纹/)
    expect(getProjectDb()!.serialize().equals(before)).toBe(true)
    expect(ImportRunRepository.get('parse-run')).toMatchObject({ completedSources: 0, completedChapters: 0 })
  })

  it('rejects starting or finalizing incomplete parsing without changing persisted state', () => {
    begin()
    const before = getProjectDb()!.serialize()
    expect(() => ImportRunRepository.startOrResume('parse-run', 'renderer')).toThrow(/重新选择|授权/)
    expect(getProjectDb()!.serialize().equals(before)).toBe(true)
    expect(() => ImportRunRepository.finalizeParsing('parse-run')).toThrow(/尚未完成|来源/)
    expect(getProjectDb()!.serialize().equals(before)).toBe(true)
  })

  it('restarts a failed parsing run with completed source checkpoints but not failed-source residue', () => {
    begin()
    ImportRunRepository.commitParsedSource('parse-run', SOURCE_A, [chapter(1)])
    ImportRunRepository.failParsedSource('parse-run', SOURCE_B, 'read interrupted')

    expect(ImportRunRepository.restart('parse-run', 'parse-restart')).toMatchObject({
      id: 'parse-restart', stage: 'parsing', status: 'ready', completedSources: 1, totalSources: 2,
    })
    expect(ImportRunRepository.commitParsedSource('parse-restart', SOURCE_A, [chapter(1)]))
      .toMatchObject({ completedSources: 1 })
  })
})
