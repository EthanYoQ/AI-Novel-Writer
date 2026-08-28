import { describe, expect, it } from 'vitest'

import { ImportInspectionStore } from '../import-inspection-store'

function chapter(number: number, content = 'x') {
  return {
    number, sourceIndex: 0, sourceChapterNumber: number,
    title: `Chapter ${number}`, content, wordCount: content.length,
    contentFingerprint: number.toString(16).padStart(64, '0'),
    contentSize: Buffer.byteLength(content),
  }
}

describe('ImportInspectionStore bounds', () => {
  it('keeps content main-only, expires entries, and consumes each inspection once', () => {
    let now = 1_000
    const store = new ImportInspectionStore({ now: () => now, ttlMs: 100, maxActive: 2, maxAggregateBytes: 100 })
    const summary = store.create({
      webContentsId: 7,
      sources: [{ locationAliasDigest: 'a'.repeat(64), fileAliasDigest: 'b'.repeat(64), displayName: 'book.txt', mediaType: 'text/plain', size: 1 }],
      chapters: [chapter(1)],
    })
    expect(JSON.stringify(summary)).not.toContain('content')
    expect(JSON.stringify(summary)).not.toContain('C:/books/book.txt')
    expect(JSON.stringify(summary)).not.toContain('device:file')
    const consumed = store.consume(summary.inspectionId, 7)
    expect(consumed.chapters[0].content).toBe('x')
    expect(summary).toMatchObject({ sourceCount: 1, sourceDisplayNames: ['book.txt'] })
    expect(JSON.stringify(consumed.sources[0])).not.toContain('canonicalLocation')
    expect(JSON.stringify(consumed.sources[0])).not.toContain('fileIdentity')
    expect(() => store.consume(summary.inspectionId, 7)).toThrow(/失效/)

    const expiring = store.create({
      webContentsId: 7,
      sources: [{ locationAliasDigest: 'c'.repeat(64), fileAliasDigest: 'd'.repeat(64), displayName: 'book2.txt', mediaType: 'text/plain', size: 1 }],
      chapters: [chapter(2)],
    })
    now = 1_101
    expect(() => store.consume(expiring.inspectionId, 7)).toThrow(/失效/)
  })

  it('rejects 5001 chapters and aggregate bytes before caching any inspection', () => {
    const store = new ImportInspectionStore({ maxAggregateBytes: 10 })
    expect(() => store.create({
      webContentsId: 7,
      sources: [{ locationAliasDigest: 'a'.repeat(64), displayName: 'book.txt', mediaType: 'text/plain', size: 5_001 }],
      chapters: Array.from({ length: 5_001 }, (_, index) => chapter(index + 1)),
    })).toThrow(/5000/)
    expect(() => store.create({
      webContentsId: 7,
      sources: [{ locationAliasDigest: 'a'.repeat(64), displayName: 'book.txt', mediaType: 'text/plain', size: 11 }],
      chapters: [chapter(1, '12345678901')],
    })).toThrow(/字节/)
    expect(store.activeCount()).toBe(0)
  })

  it('rejects unsafe display names or malformed opaque aliases before renderer serialization', () => {
    const store = new ImportInspectionStore()
    expect(() => store.create({
      webContentsId: 7,
      sources: [{ locationAliasDigest: 'not-an-alias', displayName: 'C:/private/book.txt', mediaType: 'text/plain', size: 1 }],
      chapters: [chapter(1)],
    })).toThrow(/来源/)
    expect(store.activeCount()).toBe(0)
  })

  it('caps concurrent inspections and their aggregate retained bytes', () => {
    const store = new ImportInspectionStore({ maxActive: 1, maxAggregateBytes: 10 })
    store.create({
      webContentsId: 7,
      sources: [{ locationAliasDigest: 'a'.repeat(64), displayName: 'book.txt', mediaType: 'text/plain', size: 6 }],
      chapters: [chapter(1, '123456')],
    })
    expect(() => store.create({
      webContentsId: 8,
      sources: [{ locationAliasDigest: 'b'.repeat(64), displayName: 'book2.txt', mediaType: 'text/plain', size: 1 }],
      chapters: [chapter(2, 'x')],
    })).toThrow(/待处理导入检查过多/)
  })

  it('keeps the previous valid inspection when a replacement fails validation', () => {
    const store = new ImportInspectionStore({ maxAggregateBytes: 10 })
    const valid = store.create({
      webContentsId: 7,
      sources: [{ locationAliasDigest: 'a'.repeat(64), displayName: 'book.txt', mediaType: 'text/plain', size: 1 }],
      chapters: [chapter(1)],
    })

    expect(() => store.create({
      webContentsId: 7,
      sources: [{ locationAliasDigest: 'b'.repeat(64), displayName: 'book2.txt', mediaType: 'text/plain', size: 11 }],
      chapters: [chapter(2, '12345678901')],
    })).toThrow(/字节/)

    expect(store.consume(valid.inspectionId, 7).chapters[0].content).toBe('x')
  })

  it('replaces a renderer inspection without double-counting retained resources', () => {
    const store = new ImportInspectionStore({ maxActive: 1, maxAggregateBytes: 10 })
    const previous = store.create({
      webContentsId: 7,
      sources: [{ locationAliasDigest: 'a'.repeat(64), displayName: 'book.txt', mediaType: 'text/plain', size: 6 }],
      chapters: [chapter(1, '123456')],
    })
    const replacement = store.create({
      webContentsId: 7,
      sources: [{ locationAliasDigest: 'b'.repeat(64), displayName: 'book2.txt', mediaType: 'text/plain', size: 10 }],
      chapters: [chapter(2, '1234567890')],
    })

    expect(() => store.consume(previous.inspectionId, 7)).toThrow(/失效/)
    expect(store.consume(replacement.inspectionId, 7).chapters[0].content).toBe('1234567890')
  })
})
