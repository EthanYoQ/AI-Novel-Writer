import type { DraftSourceDependency } from './draft-source-dependency'
import { WORKING_DRAFT_STATUSES, type DraftStatus } from './draft-status'

export type ReopenedFinal = Extract<DraftSourceDependency, { chapterNumber: number }>

export interface ReopenChapterRequest {
  chapterNumber: number
  initialDraftId?: number
}

export type ReopenChapterResult =
  /** created=false：本章已有一份打开的重开稿，原样返回它。 */
  | { success: true; created: boolean; draftId: number; version: number }
  | { success: false; error: string }

export interface ReplacementImpact {
  chapterNumber: number
  /** 替换者，也就是本章当前定稿的 finalizationId。「知道了」按它记，同一章再替换一次就是新的提示。预览时为 null。 */
  finalizationId: string | null
  laterChapters: number[]
  blueprintOnlyChapters: number[]
  characters: string[]
  unmovedConfirmations: Array<{ threadTitle: string; evidence: string }>
}

export function reopenedFinal(draft: {
  chapterNumber: number
  sourceDependencies?: readonly DraftSourceDependency[]
}): ReopenedFinal | null {
  for (const dependency of draft.sourceDependencies ?? []) {
    if ('chapterNumber' in dependency && dependency.chapterNumber === draft.chapterNumber) return dependency
  }
  return null
}

export function isOpenReopenDraft(draft: {
  chapterNumber: number
  status: DraftStatus
  sourceDependencies?: readonly DraftSourceDependency[]
  dependenciesStale?: boolean
}): boolean {
  return (WORKING_DRAFT_STATUSES as readonly DraftStatus[]).includes(draft.status)
    && reopenedFinal(draft) !== null
    && draft.dependenciesStale === false
}
