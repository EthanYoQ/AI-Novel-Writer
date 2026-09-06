import type BetterSqlite3 from 'better-sqlite3'

import type { ExpectedDraftSource } from '../../src/shared/ipc-channels'

export const SOURCE_DRAFT_CHANGED = 'SOURCE_DRAFT_CHANGED' as const

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
