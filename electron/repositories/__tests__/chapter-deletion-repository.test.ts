import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { ChapterDeletionRepository } from '../chapter-deletion-repository'
import { DraftRepository } from '../draft-repository'
import { FinalizationRepository } from '../finalization-repository'
import { removeDirectoryWithWindowsRetry } from '../../utils/remove-directory'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-deletion-invariant-'))
  openCanonicalProjectFixture(root)
})

afterEach(async () => {
  closeProjectDatabase()
  await removeDirectoryWithWindowsRetry(root)
})

function finalizedChapter(chapterNumber: number): number {
  const content = `第${chapterNumber}章正文`
  const draftId = DraftRepository.create({ chapterNumber, source: 'write', content, wordCount: content.length })
  FinalizationRepository.commit({ finalizationId: `finalization-${chapterNumber}`, draftId, chapterNumber,
    chapterTitle: `第${chapterNumber}章`, content, contentHash: `hash-${chapterNumber}`, contentRevision: 1,
    targetFileName: `第${chapterNumber}章.txt` })
  return draftId
}

function factsPresent(operationId: string): { draft: boolean; receipt: boolean } {
  const db = getProjectDb()!
  const row = db.prepare('SELECT draft_id, finalization_id FROM chapter_deletion_operations WHERE operation_id=?')
    .get(operationId) as { draft_id: number; finalization_id: string }
  return {
    draft: !!db.prepare('SELECT 1 FROM drafts WHERE id=?').get(row.draft_id),
    receipt: !!db.prepare('SELECT 1 FROM finalization_outbox WHERE finalization_id=?').get(row.finalization_id),
  }
}

/** 角色派生字段的改记把「删章记录已离开 authorization_required」当作「这次定稿的事实已经不在」的证明。 */
describe('删章记录的状态与定稿事实', () => {
  it('停在 authorization_required 时稿件和定稿收据都还在；确认后离开该状态，两者同时不在', () => {
    const draftId = finalizedChapter(1)
    const waiting = ChapterDeletionRepository.begin({ operationId: 'op-legacy', draftId, chapterNumber: 1, legacyKnowledgeAuthorizationRequired: true })
    expect(waiting.status).toBe('authorization_required')
    expect(factsPresent('op-legacy')).toEqual({ draft: true, receipt: true })
    expect(() => ChapterDeletionRepository.startAttempt('op-legacy')).toThrow('CHAPTER_DELETE_OPERATION_NOT_FOUND')

    const confirmed = ChapterDeletionRepository.confirmLegacyKnowledgeAbsent('op-legacy')
    expect(confirmed.status).not.toBe('authorization_required')
    expect(factsPresent('op-legacy')).toEqual({ draft: false, receipt: false })
  })

  it('不需要授权的删除一开始就不在 authorization_required，之后每个状态里事实都已不在', () => {
    const draftId = finalizedChapter(2)
    const statuses = [ChapterDeletionRepository.begin({ operationId: 'op-direct', draftId, chapterNumber: 2 }).status]
    const check = () => expect(factsPresent('op-direct')).toEqual({ draft: false, receipt: false })
    check()
    statuses.push(ChapterDeletionRepository.markProjection('op-direct', 'manuscript', 'failed', 'disk').status)
    check()
    statuses.push(ChapterDeletionRepository.startAttempt('op-direct').status)
    check()
    statuses.push(ChapterDeletionRepository.markProjection('op-direct', 'manuscript', 'completed').status)
    check()
    expect(statuses).toEqual(['pending', 'failed', 'pending', 'completed'])
  })
})
