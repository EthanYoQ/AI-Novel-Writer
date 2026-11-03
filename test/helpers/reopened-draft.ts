import { DraftRepository } from '../../electron/repositories/draft-repository'
import { FinalizationRepository } from '../../electron/repositories/finalization-repository'
import { countDraftUnits } from '../../src/shared/draft-units'

/** 已定稿的章只能经重开稿再写（ADR-0024）：重开当前定稿，把正文换成 content，返回重开稿的 id。 */
export function reopenWithContent(chapterNumber: number, content: string): number {
  const reopened = FinalizationRepository.reopen({ chapterNumber })
  if (!reopened.success) throw new Error(reopened.error)
  DraftRepository.updateContent(reopened.draftId, content, countDraftUnits(content))
  return reopened.draftId
}
