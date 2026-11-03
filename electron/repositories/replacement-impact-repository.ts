import type BetterSqlite3 from 'better-sqlite3'
import { getProjectDb } from '../database'
import { isOpenReopenDraft, reopenedFinal, type ReplacementImpact } from '../../src/shared/chapter-reopen'
import { CURRENT_DRAFT_STATUS_SQL } from '../../src/shared/draft-status'
import { CharacterRepository } from './character-repository'
import { DraftRepository, parseDependencies } from './draft-repository'
import { NarrativeThreadRepository } from './narrative-thread-repository'

function requireDb(): BetterSqlite3.Database {
  const db = getProjectDb()
  if (!db) throw new Error('PROJECT_NOT_OPEN')
  return db
}

interface Replacement {
  chapterNumber: number
  draftId: number
  content: string
  finalizationId: string | null
  replacedAt: string | null
  replacedDraftId: number
}

interface LaterDraft {
  chapterNumber: number
  status: string
  receipted: number
  sourceDependencies: string
  writtenBefore: number | null
}

function writtenBeforeReplacement(draft: LaterDraft, replacement: Replacement): boolean {
  if (draft.status === 'finalized' && !draft.receipted) return true
  const onChapter = parseDependencies(draft.sourceDependencies).dependencies
    .filter(dependency => 'chapterNumber' in dependency && dependency.chapterNumber === replacement.chapterNumber)
  if (onChapter.length) return onChapter.some(dependency => dependency.draftId !== replacement.draftId)
  return draft.writtenBefore !== 0
}

function impactOf(db: BetterSqlite3.Database, replacement: Replacement): ReplacementImpact {
  const later = db.prepare(`
    SELECT drafts.chapter_number AS chapterNumber, drafts.status, drafts.source_dependencies AS sourceDependencies,
           finalization_outbox.draft_id IS NOT NULL AS receipted,
           (? IS NULL OR NOT (julianday(drafts.created_at) > julianday(?))) AS writtenBefore
    FROM drafts
    LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
    WHERE drafts.chapter_number > ? AND drafts.status IN (${CURRENT_DRAFT_STATUS_SQL})
    ORDER BY drafts.chapter_number ASC, drafts.status = 'finalized' DESC, drafts.version DESC, drafts.id DESC
  `).all(replacement.replacedAt, replacement.replacedAt, replacement.chapterNumber) as LaterDraft[]
  const current = new Map<number, LaterDraft>()
  for (const draft of later) if (!current.has(draft.chapterNumber)) current.set(draft.chapterNumber, draft)
  const blueprintChapters = db.prepare(`SELECT chapter_number FROM blueprints WHERE chapter_number > ?
    AND (? IS NULL OR NOT (julianday(created_at) > julianday(?))) ORDER BY chapter_number ASC`)
    .pluck().all(replacement.chapterNumber, replacement.replacedAt, replacement.replacedAt) as number[]
  return {
    chapterNumber: replacement.chapterNumber,
    finalizationId: replacement.finalizationId,
    laterChapters: [...current.values()].filter(draft => writtenBeforeReplacement(draft, replacement)).map(draft => draft.chapterNumber),
    blueprintOnlyChapters: blueprintChapters.filter(chapter => !current.has(chapter)),
    characters: CharacterRepository.getAll(db)
      .filter(character => Object.values(character.currentState?.provenance ?? {}).some(field => (
        field?.kind === 'derived' && field.source.chapterNumber > replacement.chapterNumber
      )))
      .map(character => character.name),
    unmovedConfirmations: NarrativeThreadRepository.confirmationsNotCarried(replacement.replacedDraftId, replacement.content, db),
  }
}

export class ReplacementImpactRepository {
  static list(): ReplacementImpact[] {
    const db = requireDb()
    const finals = db.prepare(`
      SELECT drafts.id AS draftId, drafts.chapter_number AS chapterNumber, drafts.source_dependencies AS sourceDependencies,
             finalization_outbox.finalization_id AS finalizationId, finalization_outbox.content_snapshot AS content,
             finalization_outbox.created_at AS replacedAt
      FROM drafts
      JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      WHERE drafts.status = 'finalized'
      ORDER BY drafts.chapter_number ASC
    `).all() as Array<Omit<Replacement, 'replacedDraftId'> & { sourceDependencies: string }>
    return finals.flatMap(({ sourceDependencies, ...final }) => {
      const replaced = reopenedFinal({ chapterNumber: final.chapterNumber, sourceDependencies: parseDependencies(sourceDependencies).dependencies })
      if (!replaced) return []
      const impact = impactOf(db, { ...final, replacedDraftId: replaced.draftId })
      return impact.laterChapters.length || impact.blueprintOnlyChapters.length || impact.characters.length || impact.unmovedConfirmations.length
        ? [impact]
        : []
    })
  }

  static preview(draftId: number, content: string): ReplacementImpact | null {
    const db = requireDb()
    const draft = DraftRepository.getFull(draftId)
    const replaced = draft && isOpenReopenDraft(draft) ? reopenedFinal(draft) : null
    if (!draft || !replaced) return null
    return impactOf(db, { chapterNumber: draft.chapterNumber, draftId, content, finalizationId: null, replacedAt: null,
      replacedDraftId: replaced.draftId })
  }
}
