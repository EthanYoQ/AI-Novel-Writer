import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { DraftRepository } from '../draft-repository'
import { FinalizationRepository } from '../finalization-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-reopen-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function write(chapterNumber: number, content: string): number {
  return DraftRepository.create({ chapterNumber, source: 'write', content, wordCount: countDraftUnits(content) })
}

function finalize(draftId: number, title = '雾钟') {
  const draft = DraftRepository.getFull(draftId)!
  return FinalizationRepository.commit({
    finalizationId: randomUUID(),
    draftId,
    chapterNumber: draft.chapterNumber,
    chapterTitle: title,
    content: draft.content,
    contentHash: sha256(draft.content),
    contentRevision: 1,
    targetFileName: `第${draft.chapterNumber}章 ${title}.txt`,
  })
}

function legacyFinal(chapterNumber: number, content: string): number {
  const id = write(chapterNumber, content)
  getProjectDb()!.prepare("UPDATE drafts_all SET status = 'finalized' WHERE id = ?").run(id)
  return id
}

function draftCount(chapterNumber: number): number {
  return getProjectDb()!.prepare('SELECT COUNT(*) FROM drafts WHERE chapter_number = ?').pluck().get(chapterNumber) as number
}

const FIRST = '第一章初稿：雾从海面上升起来。'

describe('重新打开已定稿的章', () => {
  it('把当前权威定稿复制成新的工作稿，记下指向它的重开关系，旧定稿仍然有效', () => {
    const first = write(1, FIRST)
    const final = finalize(first)

    const result = FinalizationRepository.reopen({ chapterNumber: 1 })

    expect(result).toEqual({ success: true, created: true, draftId: expect.any(Number), version: 2 })
    const reopened = result.success ? DraftRepository.getFull(result.draftId) : null
    expect(reopened).toMatchObject({
      chapterNumber: 1,
      status: 'draft',
      source: 'rewrite',
      content: FIRST,
      dependenciesStale: false,
      sourceDependencies: [{
        kind: 'finalized',
        draftId: first,
        chapterNumber: 1,
        finalizationId: final.finalizationId,
        contentHash: sha256(FIRST),
      }],
    })
    expect(DraftRepository.getMeta(first)).toMatchObject({ status: 'finalized', finalizationId: final.finalizationId })
    expect(reopened?.finalizationId).toBeNull()
  })

  it('已有打开的重开稿时原样返回它，不再新建', () => {
    finalize(write(1, FIRST))
    const opened = FinalizationRepository.reopen({ chapterNumber: 1 })

    expect(FinalizationRepository.reopen({ chapterNumber: 1 })).toEqual({ ...opened, created: false })
    expect(draftCount(1)).toBe(2)
  })

  it('没有发布收据的旧定稿也能重开，基线取 contents.body 的哈希', () => {
    const legacy = legacyFinal(1, FIRST)

    const result = FinalizationRepository.reopen({ chapterNumber: 1 })

    expect(result.success && DraftRepository.getFull(result.draftId)).toMatchObject({
      content: FIRST,
      dependenciesStale: false,
      sourceDependencies: [{ kind: 'legacy-finalized', draftId: legacy, chapterNumber: 1, contentHash: sha256(FIRST) }],
    })
  })

  it('回退到此版本：以所选版本的正文为初始内容，重开关系仍指向当前定稿', () => {
    const older = write(1, FIRST)
    const current = write(1, '第一章二稿：钟声提前了一刻。')
    finalize(current)

    const result = FinalizationRepository.reopen({ chapterNumber: 1, initialDraftId: older })

    expect(result.success && DraftRepository.getFull(result.draftId)).toMatchObject({
      content: FIRST,
      sourceDependencies: [expect.objectContaining({ draftId: current })],
    })
  })

  it('回退要用的版本不属于这一章时拒绝', () => {
    finalize(write(1, FIRST))
    const other = write(2, '第二章草稿。')

    expect(() => FinalizationRepository.reopen({ chapterNumber: 1, initialDraftId: other }))
      .toThrow('CHAPTER_REOPEN_VERSION_INVALID')
    expect(draftCount(1)).toBe(1)
  })

  it('已有打开的重开稿时回退到另一份内容被拒绝，同样内容的重发返回原稿', () => {
    const older = write(1, FIRST)
    finalize(write(1, '第一章二稿：钟声提前了一刻。'))
    const opened = FinalizationRepository.reopen({ chapterNumber: 1 })

    expect(() => FinalizationRepository.reopen({ chapterNumber: 1, initialDraftId: older }))
      .toThrow('CHAPTER_REOPEN_ALREADY_OPEN')
    const rollback = FinalizationRepository.reopen({ chapterNumber: 1, initialDraftId: opened.success ? opened.draftId : -1 })
    expect(rollback).toEqual({ ...opened, created: false })
  })

  it('还没定稿的章不能重开', () => {
    write(1, FIRST)

    expect(() => FinalizationRepository.reopen({ chapterNumber: 1 })).toThrow('CHAPTER_REOPEN_NOT_FINALIZED')
  })

  it('收据与正文对不上的定稿不能作为重开基线', () => {
    const first = write(1, FIRST)
    finalize(first)
    getProjectDb()!.prepare("UPDATE contents SET body = '被外部改过的正文。' WHERE id = (SELECT content_id FROM drafts WHERE id = ?)").run(first)

    expect(() => FinalizationRepository.reopen({ chapterNumber: 1 })).toThrow('FINALIZATION_SNAPSHOT_HASH_MISMATCH')
    expect(draftCount(1)).toBe(1)
  })
})

describe('已定稿的章只能经重开稿再写', () => {
  it('不带重开关系的新稿被拒绝', () => {
    finalize(write(1, FIRST))

    expect(() => write(1, '绕过重开的新稿。')).toThrow('CHAPTER_FINALIZED_REOPEN_REQUIRED')
    expect(draftCount(1)).toBe(1)
  })

  it('同一章不能有第二份打开的重开稿', () => {
    const first = write(1, FIRST)
    const final = finalize(first)
    FinalizationRepository.reopen({ chapterNumber: 1 })

    expect(() => DraftRepository.create({
      chapterNumber: 1,
      source: 'rewrite',
      content: '第二份重开稿。',
      wordCount: 7,
      sourceDependencies: [{ kind: 'finalized', draftId: first, chapterNumber: 1, finalizationId: final.finalizationId, contentHash: sha256(FIRST) }],
    })).toThrow('CHAPTER_REOPEN_ALREADY_OPEN')
  })

  it('没有定稿的章照常新建草稿', () => {
    write(1, FIRST)

    expect(() => write(1, '第一章二稿。')).not.toThrow()
    expect(draftCount(1)).toBe(2)
  })

  it('定稿之前留下的工作稿不能直接定稿替换本章定稿', () => {
    const older = write(1, FIRST)
    const final = write(1, '第一章二稿：钟声提前了一刻。')
    finalize(final)

    expect(() => finalize(older)).toThrow('CHAPTER_FINALIZED_REOPEN_REQUIRED')
    expect(DraftRepository.getMeta(final)?.status).toBe('finalized')
    expect(DraftRepository.getMeta(older)?.status).toBe('draft')
  })

  it('重开关系已过期的重开稿（重开的定稿不再是本章定稿）不能定稿替换', () => {
    const first = write(1, FIRST)
    finalize(first)
    const stale = FinalizationRepository.reopen({ chapterNumber: 1 })
    if (!stale.success) throw new Error('reopen failed')
    getProjectDb()!.prepare("UPDATE drafts_all SET status = 'superseded' WHERE id = ?").run(first)
    const other = legacyFinal(1, '第一章另一份旧定稿。')

    expect(() => finalize(stale.draftId)).toThrow('CHAPTER_FINALIZED_REOPEN_REQUIRED')
    expect(DraftRepository.getMeta(other)?.status).toBe('finalized')
  })
})

describe('重开稿定稿与放弃', () => {
  it('重开稿定稿后替换旧定稿，章节可以再次重开', () => {
    const first = write(1, FIRST)
    const old = finalize(first)
    const opened = FinalizationRepository.reopen({ chapterNumber: 1 })
    if (!opened.success) throw new Error('reopen failed')
    DraftRepository.updateContent(opened.draftId, '第一章新稿：钟声提前了一刻。', 13)

    const replacement = finalize(opened.draftId, '新雾钟')

    expect(DraftRepository.getMeta(first)).toMatchObject({ status: 'superseded', finalizationId: old.finalizationId })
    expect(DraftRepository.getMeta(opened.draftId)).toMatchObject({ status: 'finalized', finalizationId: replacement.finalizationId })
    const again = FinalizationRepository.reopen({ chapterNumber: 1 })
    expect(again.success && DraftRepository.getFull(again.draftId)).toMatchObject({
      content: '第一章新稿：钟声提前了一刻。',
      sourceDependencies: [expect.objectContaining({ draftId: opened.draftId, finalizationId: replacement.finalizationId })],
    })
  })

  it('放弃修改（删除重开稿）后章节回到原定稿，可以再重开', () => {
    const first = write(1, FIRST)
    finalize(first)
    const opened = FinalizationRepository.reopen({ chapterNumber: 1 })
    if (!opened.success) throw new Error('reopen failed')

    DraftRepository.delete(opened.draftId)

    expect(draftCount(1)).toBe(1)
    expect(DraftRepository.getFinalizedByChapter(1)?.id).toBe(first)
    expect(FinalizationRepository.reopen({ chapterNumber: 1 })).toMatchObject({ success: true, created: true })
  })

  it('替换中间一章不推进连续性后缀水位', () => {
    for (const chapter of [1, 2, 3]) finalize(write(chapter, `第${chapter}章定稿正文。`))
    const db = getProjectDb()!
    const meta = () => db.prepare('SELECT * FROM continuity_projection_meta').all()
    const before = meta()
    const opened = FinalizationRepository.reopen({ chapterNumber: 2 })
    if (!opened.success) throw new Error('reopen failed')
    DraftRepository.updateContent(opened.draftId, '第2章改过的定稿正文。', 11)

    finalize(opened.draftId)

    expect(meta()).toEqual(before)
  })
})
