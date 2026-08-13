import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
