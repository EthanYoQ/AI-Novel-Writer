import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { ChapterDeletionRepository } from '../chapter-deletion-repository'
import { DraftRepository } from '../draft-repository'
import { FinalizationRepository } from '../finalization-repository'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { NarrativeThreadRepository } from '../narrative-thread-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-rollback-refinalize-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

function write(chapterNumber: number, content: string): number {
  return DraftRepository.create({ chapterNumber, source: 'write', content, wordCount: countDraftUnits(content) })
}

function finalize(draftId: number): void {
  const draft = DraftRepository.getFull(draftId)!
  FinalizationRepository.commit({
    finalizationId: randomUUID(),
    draftId,
    chapterNumber: draft.chapterNumber,
    chapterTitle: `第${draft.chapterNumber}章`,
    content: draft.content,
    contentHash: createHash('sha256').update(draft.content, 'utf8').digest('hex'),
    contentRevision: 1,
    targetFileName: `第${draft.chapterNumber}章.txt`,
  })
}

function rollback(chapterNumber: number, fromDraftId: number): number {
  const content = DraftRepository.getFull(fromDraftId)!.content
  return DraftRepository.create({
    chapterNumber,
    version: DraftRepository.getNextVersion(chapterNumber),
    source: 'rewrite',
    content,
    wordCount: countDraftUnits(content),
  })
}

function twoFinalizedChapters() {
  const chapter1Draft = write(1, '第一章初稿：雾从海面上升起来。')
  const chapter1Final = write(1, '第一章改稿：雾从海面上一层一层爬上来，钟声提前了一刻。')
  finalize(chapter1Final)
  const chapter2Final = write(2, '第二章定稿：北堤外的沉船。')
  finalize(chapter2Final)
  expect(FinalizedDraftImportRepository.authoritySequence()).toMatchObject({ status: 'continuous', nextChapterNumber: 3 })
  return { chapter1Draft, chapter1Final, chapter2Final }
}

const statusOf = (draftId: number) => DraftRepository.getMeta(draftId)?.status ?? null

describe('定稿章「回退到此版本」后再定稿', () => {
  it('权威序列仍连续，下一章仍是第 3 章', () => {
    const { chapter1Draft, chapter1Final } = twoFinalizedChapters()
    const reverted = rollback(1, chapter1Draft)
    finalize(reverted)

    expect({
      sequence: FinalizedDraftImportRepository.authoritySequence(),
      statuses: [statusOf(chapter1Final), statusOf(reverted)],
    }).toMatchObject({
      sequence: { status: 'continuous', nextChapterNumber: 3, duplicateChapterNumbers: [] },
      statuses: [expect.not.stringMatching(/^finalized$/), 'finalized'],
    })
  })

  it('删除再定稿后的最后一章，被替换的旧定稿不重新成为权威', () => {
    const { chapter2Final } = twoFinalizedChapters()
    const reverted = rollback(2, chapter2Final)
    finalize(reverted)

    ChapterDeletionRepository.begin({ operationId: randomUUID(), draftId: reverted, chapterNumber: 2 })

    expect({
      finalizedChapter2: DraftRepository.getFinalizedByChapter(2)?.id ?? null,
      sequence: FinalizedDraftImportRepository.authoritySequence(),
    }).toMatchObject({
      finalizedChapter2: null,
      sequence: { status: 'continuous', nextChapterNumber: 2 },
    })
  })

  it('叙事线索只认本章当前权威定稿上的确认', () => {
    const { chapter1Draft, chapter1Final } = twoFinalizedChapters()
    const plan = NarrativeThreadRepository.createPlan({
      title: '雾钟为何提前', type: '主线', targetStartChapter: 1, targetEndChapter: 6, authorIntent: '钟声提前与沉船有关。',
    })
    NarrativeThreadRepository.confirmEvent({ planId: plan.id, draftId: chapter1Final, type: 'planted', evidence: '钟声提前了一刻', reason: '埋下伏笔' })
    const reverted = rollback(1, chapter1Draft)
    finalize(reverted)

    const listed = NarrativeThreadRepository.list().find(thread => thread.id === plan.id)!
    expect({ status: listed.status, eventDrafts: listed.events.map(event => event.draftId) })
      .toEqual({ status: 'planned', eventDrafts: [] })
  })
})
