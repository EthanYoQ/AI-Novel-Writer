import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'

import { DraftRepository } from '../../electron/repositories/draft-repository'
import { FinalizationRepository } from '../../electron/repositories/finalization-repository'
import type { ReopenedFinal } from '../../src/shared/chapter-reopen'
import { countDraftUnits } from '../../src/shared/draft-units'

export function reopenWithContent(chapterNumber: number, content: string): number {
  const reopened = FinalizationRepository.reopen({ chapterNumber })
  if (!reopened.success) throw new Error(reopened.error)
  DraftRepository.updateContent(reopened.draftId, content, countDraftUnits(content))
  return reopened.draftId
}

export function registerAsReopenDraft(db: BetterSqlite3.Database, draftId: number): void {
  const final = db.prepare(`
    SELECT finalized.id, finalized.chapter_number, contents.body, finalization_outbox.finalization_id
    FROM drafts AS draft
    JOIN drafts AS finalized ON finalized.chapter_number = draft.chapter_number AND finalized.status = 'finalized'
    JOIN contents ON contents.id = finalized.content_id
    LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = finalized.id
    WHERE draft.id = ?
    ORDER BY finalized.version DESC, finalized.id DESC
    LIMIT 1
  `).get(draftId) as { id: number; chapter_number: number; body: string; finalization_id: string | null } | undefined
  if (!final) return
  const contentHash = createHash('sha256').update(final.body, 'utf8').digest('hex')
  const relation: ReopenedFinal = final.finalization_id === null
    ? { kind: 'legacy-finalized', draftId: final.id, chapterNumber: final.chapter_number, contentHash }
    : { kind: 'finalized', draftId: final.id, chapterNumber: final.chapter_number, finalizationId: final.finalization_id, contentHash }
  db.prepare('UPDATE drafts SET source_dependencies = ? WHERE id = ?').run(JSON.stringify([relation]), draftId)
}
