import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { DraftRepository } from '../draft-repository'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'

let projectRoot = ''

function chapters(count = 9) {
  return Array.from({ length: count }, (_, index) => {
    const chapterNumber = index + 1
    const content = `第${chapterNumber}章不可变导入正文`
    return {
      chapterNumber,
      title: `第${chapterNumber}章`,
      content,
      wordCount: content.length,
    }
  })
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-finalized-import-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('FinalizedDraftImportRepository transaction seam', () => {
  it('previews an empty project as a contiguous authoritative import without writing facts', () => {
    expect(FinalizedDraftImportRepository.authoritySequence()).toMatchObject({
      status: 'empty',
      lastChapterNumber: 0,
      nextChapterNumber: 1,
    })
    const preview = FinalizedDraftImportRepository.preview(chapters(2))

    expect(preview).toMatchObject({
      classification: 'ready',
      chapterCount: 2,
      targetStatus: 'finalized',
      nextChapterNumber: 3,
      newChapterNumbers: [1, 2],
      duplicateChapterNumbers: [],
      conflictChapterNumbers: [],
      authorityInvalid: false,
      authorityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(preview.chapters.map(chapter => chapter.disposition)).toEqual(['new', 'new'])
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM drafts').get()).toEqual({ count: 0 })
  })

  it('allows only the contiguous next range and classifies safe duplicates separately from conflicts', () => {
    FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'existing-authority',
      chapters: chapters(2),
    })

    const appended = chapters(3).slice(2)
    expect(FinalizedDraftImportRepository.preview(appended)).toMatchObject({
      classification: 'ready',
      newChapterNumbers: [3],
      nextChapterNumber: 4,
    })
    expect(FinalizedDraftImportRepository.preview(chapters(2))).toMatchObject({
      classification: 'exact-duplicate',
      duplicateChapterNumbers: [1, 2],
      newChapterNumbers: [],
    })

    const changed = [{ ...chapters(1)[0], content: '冲突正文', wordCount: '冲突正文'.length }]
    expect(FinalizedDraftImportRepository.preview(changed)).toMatchObject({
      classification: 'conflict',
      conflictChapterNumbers: [1],
    })
    expect(FinalizedDraftImportRepository.preview([{
      ...chapters(1)[0], title: '同正文的新标题',
    }])).toMatchObject({
      classification: 'conflict',
      conflictChapterNumbers: [1],
    })
    const skipped = [{ ...chapters(1)[0], chapterNumber: 4, title: '第四章' }]
    expect(FinalizedDraftImportRepository.preview(skipped)).toMatchObject({
      classification: 'conflict',
      firstGapChapterNumber: 3,
    })
  })

  it('refuses automatic continuation when existing finalized authority has a gap', () => {
    const imported = chapters(2)
    imported[1] = { ...imported[1], chapterNumber: 3, title: '第三章' }
    FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'gapped-authority',
      chapters: imported,
    })

    const sequence = FinalizedDraftImportRepository.authoritySequence()
    expect(sequence).toMatchObject({
      status: 'invalid',
      firstGapChapterNumber: 2,
    })
    expect(sequence).not.toHaveProperty('nextChapterNumber')
    expect(FinalizedDraftImportRepository.preview([
      { ...chapters(1)[0], chapterNumber: 4, title: '第四章' },
    ])).toMatchObject({
      classification: 'conflict',
      authorityInvalid: true,
      firstGapChapterNumber: 2,
    })
  })

  it('derives a continuous legacy authority sequence from finalized drafts without publication outbox rows', () => {
    const db = getProjectDb()!
    for (const chapter of chapters(3)) {
      const content = db.prepare('INSERT INTO contents (body) VALUES (?)').run(chapter.content)
      db.prepare(`
        INSERT INTO drafts (chapter_number, version, status, source, content_id, word_count)
        VALUES (?, 1, 'finalized', 'write', ?, ?)
      `).run(chapter.chapterNumber, Number(content.lastInsertRowid), chapter.wordCount)
    }

    expect(db.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get()).toEqual({ count: 0 })
    expect(FinalizedDraftImportRepository.authoritySequence()).toMatchObject({
      status: 'continuous',
      lastChapterNumber: 3,
      nextChapterNumber: 4,
      duplicateChapterNumbers: [],
    })
    expect(FinalizedDraftImportRepository.preview(chapters(4))).toMatchObject({
      classification: 'ready',
      duplicateChapterNumbers: [1, 2, 3],
      newChapterNumbers: [4],
      nextChapterNumber: 5,
    })
  })

  it('rechecks the frozen authority fingerprint inside the atomic commit', () => {
    const candidate = chapters(1)
    const preview = FinalizedDraftImportRepository.preview(candidate)
    FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'concurrent-authority-change',
      chapters: [{ ...chapters(1)[0], content: '另一份第一章', wordCount: '另一份第一章'.length }],
    })

    expect(() => FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'stale-preview',
      expectedAuthorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
      chapters: candidate,
    })).toThrow('预览已过期')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM drafts').get()).toEqual({ count: 1 })
  })

  it('preserves the legacy payload hash when no separate commit-manifest fingerprint is supplied', () => {
    const operationId = 'legacy-confirmed-manifest-hash'
    const candidate = chapters(1)
    const preview = FinalizedDraftImportRepository.preview(candidate)
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId,
      expectedAuthorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
      chapters: candidate,
    })
    const expectedPayloadHash = createHash('sha256').update(JSON.stringify({
      operationId,
      expectedAuthorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
      chapters: candidate,
    })).digest('hex')

    expect(receipt.payloadHash).toBe(expectedPayloadHash)
  })

  it('commits nine imported chapters as finalized facts with pending publication outbox in one batch', () => {
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'import-nine-chapters',
      chapters: chapters(),
    })

    expect(receipt).toMatchObject({
      operationId: 'import-nine-chapters',
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      chapterNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      idempotent: false,
    })
    expect(receipt.drafts).toHaveLength(9)
    expect(chapters().map(chapter => DraftRepository.getFinalizedByChapter(chapter.chapterNumber)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ chapterNumber: 1, status: 'finalized' }),
        expect.objectContaining({ chapterNumber: 9, status: 'finalized' }),
      ]))
    expect(chapters().every(chapter => DraftRepository.getFinalizedByChapter(chapter.chapterNumber) !== null))
      .toBe(true)
    const db = getProjectDb()!
    expect(db.prepare('SELECT DISTINCT status FROM drafts').all()).toEqual([{ status: 'finalized' }])
    expect(db.prepare('SELECT COUNT(*) AS count FROM contents').get()).toEqual({ count: 9 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM finalization_outbox WHERE publication_status = ?').get('pending'))
      .toEqual({ count: 9 })
    expect(FinalizedDraftImportRepository.authoritySequence()).toMatchObject({
      status: 'continuous',
      lastChapterNumber: 9,
      nextChapterNumber: 10,
    })
  })

  it('rolls back every chapter and the operation receipt when a later outbox insert fails', () => {
    const db = getProjectDb()!
    db.exec(`
      CREATE TRIGGER reject_fifth_imported_chapter
      BEFORE INSERT ON finalization_outbox
      WHEN NEW.chapter_number = 5
      BEGIN
        SELECT RAISE(ABORT, 'injected fifth chapter failure');
      END;
    `)

    expect(() => FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'import-rolls-back',
      chapters: chapters(),
    })).toThrow('injected fifth chapter failure')

    expect(db.prepare('SELECT COUNT(*) AS count FROM contents').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM drafts').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM finalized_draft_import_operations').get())
      .toEqual({ count: 0 })
  })

  it('replays the same operation without duplicating any finalized fact', () => {
    const request = { operationId: 'import-idempotent', chapters: chapters() }
    const first = FinalizedDraftImportRepository.commit(projectRoot, request)
    const replay = FinalizedDraftImportRepository.commit(projectRoot, request)

    expect(replay).toEqual({ ...first, idempotent: true })
    const db = getProjectDb()!
    expect(db.prepare('SELECT COUNT(*) AS count FROM contents').get()).toEqual({ count: 9 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM drafts').get()).toEqual({ count: 9 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get()).toEqual({ count: 9 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM finalized_draft_import_operations').get())
      .toEqual({ count: 1 })
  })

  it('replays an operation after its durable publication outbox was already published', () => {
    const request = { operationId: 'import-published-replay', chapters: chapters(2) }
    const first = FinalizedDraftImportRepository.commit(projectRoot, request)
    getProjectDb()!.prepare(`
      UPDATE finalization_outbox SET publication_status = 'published'
      WHERE finalization_id = ?
    `).run(first.drafts[0].finalizationId)

    expect(FinalizedDraftImportRepository.commit(projectRoot, request))
      .toEqual({ ...first, idempotent: true })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM drafts').get()).toEqual({ count: 2 })
  })

  it('rejects payload drift for an existing operation without changing persisted facts', () => {
    const original = chapters()
    FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'import-payload-bound',
      chapters: original,
    })
    const changed = chapters()
    changed[4] = {
      ...changed[4],
      content: '第五章被替换的正文',
      wordCount: '第五章被替换的正文'.length,
    }

    expect(() => FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'import-payload-bound',
      chapters: changed,
    })).toThrow('operationId 已绑定不同载荷')

    const db = getProjectDb()!
    expect(db.prepare('SELECT COUNT(*) AS count FROM drafts').get()).toEqual({ count: 9 })
    expect(db.prepare('SELECT body FROM contents ORDER BY id').all())
      .toEqual(original.map(chapter => ({ body: chapter.content })))
  })

  it('rejects invalid coverage and word counts before writing any fact', () => {
    const invalid = chapters(2)
    invalid[1] = { ...invalid[1], chapterNumber: 1, wordCount: invalid[1].wordCount + 1 }

    expect(() => FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'import-invalid',
      chapters: invalid,
    })).toThrow()

    const db = getProjectDb()!
    expect(db.prepare('SELECT COUNT(*) AS count FROM contents').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM drafts').get()).toEqual({ count: 0 })
  })
})
