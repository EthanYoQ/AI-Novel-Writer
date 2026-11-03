import { getProjectDb } from '../database'
import { FinalizationRepository } from '../repositories/finalization-repository'
import { GenerationRunRepository } from '../repositories/generation-run-repository'
import { GenerationDraftEffects } from './generation-draft-effects'
import type { ReopenChapterRequest, ReopenChapterResult } from '../../src/shared/chapter-reopen'

export function reopenFinalizedChapter(projectId: string, request: ReopenChapterRequest): ReopenChapterResult {
  const db = getProjectDb()
  if (!db) throw new Error('PROJECT_NOT_OPEN')
  return db.transaction(() => {
    const batches = new GenerationDraftEffects(db, new GenerationRunRepository(() => db))
    if (batches.unfinishedBatchChapters(projectId).has(request?.chapterNumber)) {
      throw new Error('CHAPTER_REOPEN_BATCH_UNFINISHED')
    }
    return FinalizationRepository.reopen(request)
  }).immediate()
}
