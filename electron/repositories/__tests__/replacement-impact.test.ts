import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { BlueprintRepository } from '../blueprint-repository'
import { DraftRepository } from '../draft-repository'
import { FinalizationRepository } from '../finalization-repository'
import { NarrativeThreadRepository } from '../narrative-thread-repository'
import { ReplacementImpactRepository } from '../replacement-impact-repository'
import { SummaryRepository } from '../summary-repository'
import { refreshCharacterIdentityProjection } from '../character-roster-repository'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { parseFinalizedCharacterStateResponse } from '../../../src/shared/finalized-continuity'
import { removeDirectoryWithWindowsRetry } from '../../utils/remove-directory'

const roots: string[] = []
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const PROJECT_ID = randomUUID()
const LIN = '77777777-7777-4777-8777-777777777777'
const ZHOU = '88888888-8888-4888-8888-888888888888'

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replacement-impact-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, '.ai-novel'), { recursive: true })
  fs.writeFileSync(path.join(root, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId: PROJECT_ID, createdAt: '2026-11-01T00:00:00.000Z',
  })))
  createProjectDatabase(root, Buffer.alloc(32, 9))
  initProjectDatabase(root)
  BlueprintRepository.listPendingCharacterSyncOperations()
  const db = getProjectDb()!
  db.prepare("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','影响','zh-CN')").run()
  const character = db.prepare(`INSERT INTO characters(character_id,static_provenance,identity_revision,retired,name,role)
    VALUES(?,'{"kind":"author"}',0,0,?,?)`)
  character.run(LIN, '林岚', 'protagonist')
  character.run(ZHOU, '周放', 'supporting')
  db.transaction(() => refreshCharacterIdentityProjection(db))()
})

afterEach(async () => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) await removeDirectoryWithWindowsRetry(root)
})

function commitFinal(draftId: number, chapterNumber: number, body: string): string {
  const db = getProjectDb()!
  db.prepare('INSERT OR IGNORE INTO blueprints(chapter_number,title) VALUES(?,?)').run(chapterNumber, `第${chapterNumber}章`)
  const finalizationId = `finalization-${randomUUID()}`
  FinalizationRepository.commit({ finalizationId, draftId, chapterNumber, chapterTitle: `第${chapterNumber}章`, content: body,
    contentHash: sha256(body), contentRevision: 1, targetFileName: `${chapterNumber}-${draftId}.md` })
  const context = SummaryRepository.readFinalizedCharacterContext(draftId, { projectId: PROJECT_ID, epoch: 'session' }, db)
  SummaryRepository.saveFinalizedContinuity({ draftId, chapterNumber, chapterNotes: `第${chapterNumber}章摘要`, facts: [],
    source: context.source, projectionGeneration: context.projectionGeneration }, db)
  return finalizationId
}

function finalizeNew(chapterNumber: number, body: string): number {
  const draftId = DraftRepository.create({ chapterNumber, source: 'write', content: body, wordCount: body.length })
  commitFinal(draftId, chapterNumber, body)
  return draftId
}

function derive(draftId: number, characterId: string, currentState: Record<string, string>, evidence: string): void {
  const db = getProjectDb()!
  const context = SummaryRepository.readFinalizedCharacterContext(draftId, { projectId: PROJECT_ID, epoch: 'session' }, db)
  const response = parseFinalizedCharacterStateResponse(JSON.stringify({ updates: [{ characterId, currentState,
    evidence: { text: evidence } }] }), context)
  SummaryRepository.commitFinalizedCharacterStates(context, response, db)
}

function reopen(chapterNumber: number, body: string): number {
  const opened = FinalizationRepository.reopen({ chapterNumber })
  if (!opened.success) throw new Error(opened.error)
  DraftRepository.updateContent(opened.draftId, body, body.length)
  return opened.draftId
}

function confirm(draftId: number, title: string, evidence: string): void {
  const plan = NarrativeThreadRepository.createPlan({ title, type: '伏笔', targetStartChapter: 1, targetEndChapter: 6, authorIntent: '后面用上。' })
  NarrativeThreadRepository.confirmEvent({ planId: plan.id, draftId, type: 'planted', evidence, reason: '埋设。' })
}

const ORIGINAL_TWO = '林岚捡到钥匙。她把地图藏进靴子。'
const REVISED_TWO = '林岚捡到钥匙。她把地图烧了。'

function threeFinalChapters(): { two: number } {
  finalizeNew(1, '第一章：雾从海面上升起来。')
  const two = finalizeNew(2, ORIGINAL_TWO)
  const three = finalizeNew(3, '第三章：林岚到了旧码头。')
  derive(two, ZHOU, { mentalState: '起了疑心' }, ORIGINAL_TWO)
  derive(three, LIN, { location: '旧码头' }, '林岚到了旧码头。')
  for (const chapter of [4, 5, 6]) getProjectDb()!.prepare('INSERT INTO blueprints(chapter_number,title) VALUES(?,?)').run(chapter, `第${chapter}章`)
  confirm(two, '旧码头的钥匙', '林岚捡到钥匙。')
  confirm(two, '靴子里的地图', '她把地图藏进靴子。')
  return { two }
}

describe('替换定稿对后续内容的影响', () => {
  it('lists the later chapters, blueprint-only chapters, characters with later-chapter state, and confirmations left on the replaced final', () => {
    threeFinalChapters()
    const reopened = reopen(2, REVISED_TWO)
    const finalizationId = commitFinal(reopened, 2, REVISED_TWO)

    expect(ReplacementImpactRepository.list()).toEqual([{
      chapterNumber: 2,
      finalizationId,
      laterChapters: [3],
      blueprintOnlyChapters: [4, 5, 6],
      characters: ['林岚'],
      unmovedConfirmations: [{ threadTitle: '靴子里的地图', evidence: '她把地图藏进靴子。' }],
    }])
  })

  it('leaves out blueprints created after the replacement, but keeps older ones even when a later edit touched them', () => {
    threeFinalChapters()
    const db = getProjectDb()!
    db.prepare("UPDATE blueprints SET created_at = datetime('now', '-1 hour') WHERE chapter_number > 3").run()
    commitFinal(reopen(2, REVISED_TWO), 2, REVISED_TWO)
    db.prepare("UPDATE blueprints SET created_at = datetime('now', '+1 hour') WHERE chapter_number = 5").run()
    db.prepare("UPDATE blueprints SET updated_at = datetime('now', '+1 hour') WHERE chapter_number = 6").run()

    expect(ReplacementImpactRepository.list()).toMatchObject([{ chapterNumber: 2, blueprintOnlyChapters: [4, 6] }])
  })

  it('previews the same impact for an open reopened draft before it is finalized', () => {
    threeFinalChapters()
    const reopened = reopen(2, REVISED_TWO)

    expect(ReplacementImpactRepository.preview(reopened, REVISED_TWO)).toEqual({
      chapterNumber: 2,
      finalizationId: null,
      laterChapters: [3],
      blueprintOnlyChapters: [4, 5, 6],
      characters: ['林岚'],
      unmovedConfirmations: [{ threadTitle: '靴子里的地图', evidence: '她把地图藏进靴子。' }],
    })
    expect(ReplacementImpactRepository.preview(DraftRepository.getFinalizedByChapter(3)!.id, ORIGINAL_TWO)).toBeNull()
  })

  it('previews the confirmations against the text the author is about to finalize, saved or not', () => {
    threeFinalChapters()
    const reopened = reopen(2, ORIGINAL_TWO)

    expect(ReplacementImpactRepository.preview(reopened, '她把地图藏进靴子。')?.unmovedConfirmations)
      .toEqual([{ threadTitle: '旧码头的钥匙', evidence: '林岚捡到钥匙。' }])
  })

  it('judges a later chapter by which final of the chapter it was written from, otherwise by time, and always counts a final without a receipt', () => {
    const { two } = threeFinalChapters()
    const db = getProjectDb()!
    const oldFinal = db.prepare('SELECT finalization_id, content_snapshot FROM finalization_outbox WHERE draft_id = ?').get(two) as { finalization_id: string; content_snapshot: string }
    const fromOldFinal = DraftRepository.create({ chapterNumber: 4, source: 'write', content: '第四章：照着旧地图走。', wordCount: 10, sourceDependencies: [
      { kind: 'finalized', draftId: two, chapterNumber: 2, finalizationId: oldFinal.finalization_id, contentHash: sha256(oldFinal.content_snapshot) },
    ] })
    const replacement = reopen(2, REVISED_TWO)
    const replacementId = commitFinal(replacement, 2, REVISED_TWO)
    const afterwards = DraftRepository.create({ chapterNumber: 5, source: 'write', content: '第五章：地图已经烧了。', wordCount: 10 })
    const fromReplacement = DraftRepository.create({ chapterNumber: 7, source: 'write', content: '第七章：灰烬里还有字。', wordCount: 10, sourceDependencies: [
      { kind: 'finalized', draftId: replacement, chapterNumber: 2, finalizationId: replacementId, contentHash: sha256(REVISED_TWO) },
    ] })
    db.prepare("UPDATE drafts SET created_at = datetime('now', '-1 hour') WHERE id = ?").run(fromReplacement)
    const legacy = DraftRepository.create({ chapterNumber: 6, source: 'write', content: '第六章：旧版本的定稿。', wordCount: 10 })
    db.prepare("UPDATE drafts SET status = 'finalized' WHERE id = ?").run(legacy)
    db.prepare(`UPDATE drafts SET created_at = datetime('now', '+1 hour') WHERE id IN (${[fromOldFinal, afterwards, legacy].join(',')})`).run()

    expect(ReplacementImpactRepository.list()).toMatchObject([{ chapterNumber: 2, laterChapters: [3, 4, 6], blueprintOnlyChapters: [] }])
  })

  it('leaves out chapters whose final was not a replacement and replacements with nothing after them', () => {
    finalizeNew(1, '第一章：雾从海面上升起来。')
    finalizeNew(2, ORIGINAL_TWO)
    commitFinal(reopen(2, REVISED_TWO), 2, REVISED_TWO)

    expect(ReplacementImpactRepository.list()).toEqual([])
  })
})
