import type BetterSqlite3 from 'better-sqlite3'

import type { ExpectedDraftSource } from '../../src/shared/ipc-channels'

export const SOURCE_DRAFT_CHANGED = 'SOURCE_DRAFT_CHANGED' as const

/** 审稿、修稿的父稿还活着（drafts 视图不含回收站）。章节进回收站后，它的审稿和修稿既不读出，也不能再改状态。 */
export const LIVE_PARENT = 'base_draft_id IN (SELECT id FROM drafts)'

export class SourceDraftChangedError extends Error {
  readonly code = SOURCE_DRAFT_CHANGED

  constructor() {
    super(SOURCE_DRAFT_CHANGED)
    this.name = 'SourceDraftChangedError'
  }
}

export function isSourceDraftChangedError(error: unknown): error is SourceDraftChangedError {
  return error instanceof SourceDraftChangedError
}

export function assertExpectedDraftSource(
  db: BetterSqlite3.Database,
  baseDraftId: number,
  expected: ExpectedDraftSource,
): void {
  const source = db.prepare(`
    SELECT
      drafts.id,
      drafts.chapter_number AS chapterNumber,
      drafts.version,
      drafts.status,
      contents.body AS content
    FROM drafts
    JOIN contents ON contents.id = drafts.content_id
    WHERE drafts.id = ?
  `).get(baseDraftId) as ExpectedDraftSource | undefined

  if (
    baseDraftId !== expected.id
    || !source
    || source.id !== expected.id
    || source.chapterNumber !== expected.chapterNumber
    || source.version !== expected.version
    || source.status !== expected.status
    || source.content !== expected.content
  ) throw new SourceDraftChangedError()
}
