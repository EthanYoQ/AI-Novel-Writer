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
const SOURCE_C = '33333333-3333-4333-8333-333333333333'

function chapter(number: number, content = `source chapter ${number}`) {
  return {
    number,
    title: `Chapter ${number}`,
    content,
    contentFingerprint: createHash('sha256').update(content).digest('hex'),
    contentSize: Buffer.byteLength(content),
  }
}

function begin(runId = 'parse-run') {
  return ImportRunRepository.beginParsing({
    runId,
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

function reauthorize(overrides: {
  runId?: string
  sourceFingerprint?: string
  sourceIds?: string[]
  sourceFingerprints?: string[]
  sourceDisplay?: Array<{ displayName: string; mediaType: string; size: number }>
} = {}) {
  return ImportRunRepository.beginParsing({
    runId: overrides.runId ?? 'reauthorized-run',
    purpose: 'reference',
    sourceFingerprint: overrides.sourceFingerprint ?? 'a'.repeat(64),
    sourceIds: overrides.sourceIds ?? [SOURCE_A, SOURCE_B],
    sourceFingerprints: overrides.sourceFingerprints ?? ['b'.repeat(64), 'c'.repeat(64)],
    sourceDisplay: overrides.sourceDisplay ?? [
      { displayName: 'renamed-a.txt', mediaType: 'text/plain', size: 37 },
      { displayName: 'renamed-b.txt', mediaType: 'text/plain', size: 41 },
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
    expect(reauthorize({
      runId: 'parse-run',
      sourceFingerprint: 'd'.repeat(64),
      sourceIds: [SOURCE_B],
      sourceFingerprints: ['c'.repeat(64)],
      sourceDisplay: [{ displayName: 'b-restored.txt', mediaType: 'text/plain', size: 30 }],
    })).toMatchObject({ id: 'parse-run', stage: 'parsing', completedSources: 1 })
    ImportRunRepository.commitParsedSource('parse-run', SOURCE_B, [chapter(1, 'second source')])

    const prepared = ImportRunRepository.finalizeParsing('parse-run')
    expect(prepared).toMatchObject({ classification: 'new', run: { stage: 'prepared', totalChapters: 3 } })
    expect(ImportRunRepository.startOrResume('parse-run', 'renderer')).toMatchObject({
      run: { stage: 'knowledge', status: 'running' },
    })
  })

  it('reopens after every source commit and finalizes only from persisted project snapshots', () => {
    begin('committed-before-crash')
    ImportRunRepository.commitParsedSource('committed-before-crash', SOURCE_A, [chapter(1, 'saved A')])
    ImportRunRepository.commitParsedSource('committed-before-crash', SOURCE_B, [chapter(1, 'saved B')])
    expect(ImportRunRepository.get('committed-before-crash')).toMatchObject({
      stage: 'parsing', completedSources: 2, totalSources: 2, progressCompleted: 2, progressTotal: 2,
    })

    closeProjectDatabase()
    initProjectDatabase(root)

    expect(ImportRunRepository.finalizeParsing('committed-before-crash')).toMatchObject({
      classification: 'new',
      run: { id: 'committed-before-crash', stage: 'prepared', totalChapters: 2 },
    })
    expect(ImportRunRepository.listChapterBatch(
      'committed-before-crash',
      { afterChapterNumber: 0, limit: 2 },
    ).map(item => item.content)).toEqual(['saved A', 'saved B'])
  })

  it('keeps every completed source recoverable when finalization is temporarily blocked', () => {
    begin('blocking-run')
    ImportRunRepository.commitParsedSource('blocking-run', SOURCE_A, [chapter(1, 'blocking A')])
    ImportRunRepository.commitParsedSource('blocking-run', SOURCE_B, [chapter(1, 'blocking B')])
    ImportRunRepository.finalizeParsing('blocking-run')

    begin('retry-finalize')
    ImportRunRepository.commitParsedSource('retry-finalize', SOURCE_A, [chapter(1, 'recovered A')])
    ImportRunRepository.commitParsedSource('retry-finalize', SOURCE_B, [chapter(1, 'recovered B')])
    const beforeFailedFinalize = getProjectDb()!.serialize()
    expect(() => ImportRunRepository.finalizeParsing('retry-finalize'))
      .toThrow(/另一个可恢复导入已包含相同来源/)
    expect(getProjectDb()!.serialize().equals(beforeFailedFinalize)).toBe(true)
    expect(ImportRunRepository.get('retry-finalize')).toMatchObject({
      stage: 'parsing', status: 'ready', resumable: true,
      completedSources: 2, totalSources: 2, progressCompleted: 2, progressTotal: 2,
    })

    getProjectDb()!.prepare(`
      UPDATE import_runs SET status = 'failed', resumable = 0 WHERE id = 'blocking-run'
    `).run()
    expect(ImportRunRepository.finalizeParsing('retry-finalize')).toMatchObject({
      classification: 'new',
      run: { id: 'retry-finalize', stage: 'prepared', totalChapters: 2 },
    })
    expect(ImportRunRepository.listChapterBatch(
      'retry-finalize',
      { afterChapterNumber: 0, limit: 2 },
    ).map(item => item.content)).toEqual(['recovered A', 'recovered B'])
  })

  it('resumes the stable source set after names and file sizes change and refreshes display metadata', () => {
    begin()
    ImportRunRepository.commitParsedSource('parse-run', SOURCE_A, [chapter(1)])

    expect(reauthorize()).toMatchObject({
      id: 'parse-run',
      completedSources: 1,
      sourceDisplay: [
        { displayName: 'renamed-a.txt', mediaType: 'text/plain', size: 37 },
        { displayName: 'renamed-b.txt', mediaType: 'text/plain', size: 41 },
      ],
    })
  })

  it('resumes an explicit parsing run with only its unfinished source selected', () => {
    begin()
    ImportRunRepository.commitParsedSource('parse-run', SOURCE_A, [chapter(1, 'saved first source')])
    ImportRunRepository.failParsedSource('parse-run', SOURCE_B, 'empty source')

    const failedSnapshot = ImportRunRepository.get('parse-run')
    expect(failedSnapshot).toMatchObject({
      unfinishedSourceDisplay: [
        { displayName: 'b.txt', mediaType: 'text/plain', size: 20 },
      ],
    })
    expect(JSON.stringify(failedSnapshot)).not.toContain(SOURCE_A)
    expect(JSON.stringify(failedSnapshot)).not.toContain(SOURCE_B)
    expect(JSON.stringify(failedSnapshot)).not.toContain('bbbbbbbb')
    expect(JSON.stringify(failedSnapshot)).not.toContain('cccccccc')

    expect(reauthorize({
      runId: 'parse-run',
      sourceFingerprint: 'd'.repeat(64),
      sourceIds: [SOURCE_B],
      sourceFingerprints: ['c'.repeat(64)],
      sourceDisplay: [{ displayName: 'fixed-b.txt', mediaType: 'text/plain', size: 51 }],
    })).toMatchObject({
      id: 'parse-run',
      stage: 'parsing',
      completedSources: 1,
      totalSources: 2,
      sourceDisplay: [
        { displayName: 'a.txt', mediaType: 'text/plain', size: 20 },
        { displayName: 'fixed-b.txt', mediaType: 'text/plain', size: 51 },
      ],
      unfinishedSourceDisplay: [
        { displayName: 'fixed-b.txt', mediaType: 'text/plain', size: 51 },
      ],
    })

    ImportRunRepository.commitParsedSource('parse-run', SOURCE_B, [chapter(1, 'recovered second source')])
    expect(ImportRunRepository.finalizeParsing('parse-run')).toMatchObject({
      classification: 'new',
      run: { id: 'parse-run', stage: 'prepared', totalChapters: 2 },
    })
    expect(ImportRunRepository.listChapterBatch('parse-run', { afterChapterNumber: 0, limit: 2 }).map(item => item.content))
      .toEqual(['saved first source', 'recovered second source'])
  })

  it('rejects injected or already-completed sources from a partial resume without changing the run', () => {
    begin()
    ImportRunRepository.commitParsedSource('parse-run', SOURCE_A, [chapter(1)])
    ImportRunRepository.failParsedSource('parse-run', SOURCE_B, 'empty source')
    const before = getProjectDb()!.serialize()

    expect(() => reauthorize({
      runId: 'parse-run',
      sourceFingerprint: 'd'.repeat(64),
      sourceIds: [SOURCE_C],
      sourceFingerprints: ['e'.repeat(64)],
      sourceDisplay: [{ displayName: 'injected.txt', mediaType: 'text/plain', size: 5 }],
    })).toThrow(/来源清单|重新授权/)
    expect(getProjectDb()!.serialize().equals(before)).toBe(true)

    expect(() => reauthorize({
      runId: 'parse-run',
      sourceFingerprint: 'f'.repeat(64),
      sourceIds: [SOURCE_A],
      sourceFingerprints: ['b'.repeat(64)],
      sourceDisplay: [{ displayName: 'a-again.txt', mediaType: 'text/plain', size: 99 }],
    })).toThrow(/来源清单|重新授权/)
    expect(getProjectDb()!.serialize().equals(before)).toBe(true)
  })

  it('rejects a different stable source key even when the caller reuses the collection fingerprint', () => {
    begin()

    expect(() => reauthorize({
      sourceIds: [SOURCE_A, '33333333-3333-4333-8333-333333333333'],
      sourceFingerprints: ['b'.repeat(64), 'd'.repeat(64)],
    })).toThrow(/来源清单|重新授权/)
    expect(ImportRunRepository.get('parse-run')).toMatchObject({
      id: 'parse-run',
      sourceDisplay: [
        { displayName: 'a.txt', mediaType: 'text/plain', size: 20 },
        { displayName: 'b.txt', mediaType: 'text/plain', size: 20 },
      ],
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

  it('rejects an empty parsed-source snapshot without marking the source completed', () => {
    begin()

    expect(() => ImportRunRepository.commitParsedSource('parse-run', SOURCE_A, []))
      .toThrow(/没有可导入的正文|不能为空/)
    expect(ImportRunRepository.get('parse-run')).toMatchObject({
      stage: 'parsing', status: 'ready', completedSources: 0, completedChapters: 0,
    })
  })

  it('rejects starting or finalizing incomplete parsing without changing persisted state', () => {
    begin()
    const before = getProjectDb()!.serialize()
    expect(() => ImportRunRepository.startOrResume('parse-run', 'renderer')).toThrow(/重新选择|授权/)
    expect(getProjectDb()!.serialize().equals(before)).toBe(true)
    expect(() => ImportRunRepository.finalizeParsing('parse-run')).toThrow(/尚未完成|来源/)
    expect(getProjectDb()!.serialize().equals(before)).toBe(true)
  })

  it('fences a failed parsing run and reparses every source without copying stale snapshots', () => {
    begin()
    ImportRunRepository.commitParsedSource('parse-run', SOURCE_A, [chapter(1)])
    ImportRunRepository.failParsedSource('parse-run', SOURCE_B, 'read interrupted')

    expect(ImportRunRepository.restart('parse-run', 'parse-restart')).toMatchObject({
      id: 'parse-restart', stage: 'parsing', status: 'ready', completedSources: 0, totalSources: 2,
    })
    expect(begin('ignored-new-id')).toMatchObject({ id: 'parse-restart', completedSources: 0 })
    expect(ImportRunRepository.commitParsedSource('parse-restart', SOURCE_A, [chapter(1, 'modified source')]))
      .toMatchObject({ completedSources: 1 })
  })

  it('discards a provisional parsing run when its manifest matches an existing resumable run', () => {
    begin('existing-run')
    ImportRunRepository.commitParsedSource('existing-run', SOURCE_A, [chapter(1)])
    ImportRunRepository.commitParsedSource('existing-run', SOURCE_B, [chapter(1, 'second source')])
    ImportRunRepository.finalizeParsing('existing-run')
    const execution = ImportRunRepository.startOrResume('existing-run', 'first-worker').execution
    ImportRunRepository.fail('existing-run', 'knowledge', 'provider unavailable', execution)

    begin('provisional-run')
    ImportRunRepository.commitParsedSource('provisional-run', SOURCE_A, [chapter(1)])
    ImportRunRepository.commitParsedSource('provisional-run', SOURCE_B, [chapter(1, 'second source')])

    expect(ImportRunRepository.finalizeParsing('provisional-run')).toMatchObject({
      classification: 'resumable',
      run: { id: 'existing-run', stage: 'knowledge', status: 'failed' },
    })
    expect(ImportRunRepository.get('provisional-run')).toBeNull()
    expect(ImportRunRepository.listResumable().map(run => run.id)).toEqual(['existing-run'])
  })

  it('removes a conflicting provisional run so a fresh selection can parse modified sources', () => {
    begin('completed-run')
    ImportRunRepository.commitParsedSource('completed-run', SOURCE_A, [chapter(1)])
    ImportRunRepository.commitParsedSource('completed-run', SOURCE_B, [chapter(1, 'second source')])
    ImportRunRepository.finalizeParsing('completed-run')
    getProjectDb()!.prepare(`
      UPDATE import_runs
      SET stage = 'completed', status = 'completed', resumable = 0,
          completed_chapters = total_chapters, completed_at = datetime('now')
      WHERE id = 'completed-run'
    `).run()

    begin('conflicting-run')
    ImportRunRepository.commitParsedSource('conflicting-run', SOURCE_A, [chapter(1, 'changed')])
    ImportRunRepository.commitParsedSource('conflicting-run', SOURCE_B, [chapter(1, 'second source')])
    expect(ImportRunRepository.finalizeParsing('conflicting-run')).toMatchObject({
      classification: 'conflict',
      run: undefined,
      conflictChapterNumbers: [1],
    })
    expect(ImportRunRepository.get('conflicting-run')).toBeNull()
    expect(ImportRunRepository.listResumable()).toEqual([])

    expect(begin('fresh-run')).toMatchObject({
      id: 'fresh-run', stage: 'parsing', completedSources: 0, totalSources: 2,
    })
    expect(ImportRunRepository.commitParsedSource('fresh-run', SOURCE_A, [chapter(1, 'changed again')]))
      .toMatchObject({ completedSources: 1 })
  })
})
