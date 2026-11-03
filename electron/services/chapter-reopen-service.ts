import { getProjectDb } from '../database'
import { FinalizationRepository } from '../repositories/finalization-repository'
import { GenerationRunRepository } from '../repositories/generation-run-repository'
import { GenerationDraftEffects } from './generation-draft-effects'
import type { ReopenChapterRequest, ReopenChapterResult } from '../../src/shared/chapter-reopen'

/**
 * 重新打开已定稿的一章（ADR-0024）。还没写完的批量写作写过的章不能重开：续跑按每章最高版本核对提交收据，
 * 多出一份重开稿，这次批量写作就再也续不上了。检查与建稿在同一个写事务里。
 */
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
