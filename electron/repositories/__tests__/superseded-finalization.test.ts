import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { FinalizationService } from '../../services/finalization-service'
import { DraftRepository } from '../draft-repository'
import { FinalizationRepository } from '../finalization-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-superseded-'))
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

function finalizedCountsByChapter(): Record<number, number> {
  const rows = getProjectDb()!.prepare(`
    SELECT chapter_number, COUNT(*) AS count FROM drafts WHERE status = 'finalized' GROUP BY chapter_number
  `).all() as Array<{ chapter_number: number; count: number }>
  return Object.fromEntries(rows.map(row => [row.chapter_number, row.count]))
}

function replacedChapter() {
  const first = write(1, '第一章初稿：雾从海面上升起来。')
  finalize(first)
  const second = write(1, '第一章新稿：钟声提前了一刻。')
  finalize(second, '新雾钟')
  return { first, second }
}

describe('同章再定稿把旧定稿降为 superseded', () => {
  it('旧定稿变为 superseded，标题收据仍可读，每章只剩一行 finalized', () => {
    const { first, second } = replacedChapter()

    expect({
      first: DraftRepository.getMeta(first),
      second: DraftRepository.getMeta(second)?.status,
      counts: finalizedCountsByChapter(),
    }).toMatchObject({
      first: { status: 'superseded', chapterTitle: '雾钟' },
      second: 'finalized',
      counts: { 1: 1 },
    })
  })

  it('superseded 行不能改正文、改状态或普通删除', () => {
    const { first } = replacedChapter()

    expect(() => DraftRepository.updateContent(first, '改', 1)).toThrow('DRAFT_FINALIZED_READ_ONLY')
    expect(() => DraftRepository.updateStatus(first, 'draft')).toThrow('DRAFT_FINALIZED_READ_ONLY')
    expect(() => DraftRepository.delete(first)).toThrow('SUPERSEDED_DRAFT_DELETE_FORBIDDEN')
    expect(DraftRepository.getMeta(first)?.status).toBe('superseded')
  })

  it('没有收据的 superseded 行不能再走定稿提交', () => {
    const legacy = write(2, '第二章旧定稿，没有收据。')
    getProjectDb()!.prepare("UPDATE drafts SET status = 'superseded' WHERE id = ?").run(legacy)

    expect(() => finalize(legacy)).toThrow('FINALIZATION_COMMIT_SUPERSEDED')
    expect(FinalizationRepository.getByDraftId(legacy)).toBeNull()
  })

  it('被替换的旧定稿不再发布实体稿', async () => {
    const published: string[] = []
    const service = new FinalizationService({ publisher: { publish: async input => { published.push(input.targetFileName) } } })
    const first = write(1, '第一章初稿：雾从海面上升起来。')
    const stale = finalize(first)
    finalize(write(1, '第一章新稿：钟声提前了一刻。'), '新雾钟')

    const result = await service.retry({ projectRoot, finalizationId: stale.finalizationId })

    expect({ result, published }).toMatchObject({
      result: { success: false, committed: true, error: 'FINALIZATION_SUPERSEDED' },
      published: [],
    })
  })
})
