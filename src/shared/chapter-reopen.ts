import type { DraftSourceDependency } from './draft-source-dependency'
import { WORKING_DRAFT_STATUSES, type DraftStatus } from './draft-status'

/** 重开稿记下的「重开的是本章哪一份定稿」：draft id 加正文哈希，有收据的定稿另带 finalizationId（ADR-0024）。 */
export type ReopenedFinal = Extract<DraftSourceDependency, { chapterNumber: number }>

export interface ReopenChapterRequest {
  chapterNumber: number
  /** 版本历史「回退到此版本」：以本章这一稿的正文作为重开稿的初始内容。缺省时复制当前定稿。 */
  initialDraftId?: number
}

export type ReopenChapterResult =
  /** created=false：本章已有一份打开的重开稿，原样返回它。 */
  | { success: true; created: boolean; draftId: number; version: number }
  | { success: false; error: string }

/**
 * 一章的定稿被重开稿替换后，对后续内容的影响（ADR-0024）。每次读取时从稿件、蓝图、角色字段来源和线索确认现算，不存储。
 * 定稿确认框的预览用同一套算法，那时还没有 finalizationId。
 */
export interface ReplacementImpact {
  chapterNumber: number
  /** 替换者，也就是本章当前定稿的 finalizationId。「知道了」按它记，同一章再替换一次就是新的提示。预览时为 null。 */
  finalizationId: string | null
  /** 有正文、写于本章修改之前的后续章。 */
  laterChapters: number[]
  /** 只有蓝图、还没有正文的后续章。 */
  blueprintOnlyChapters: number[]
  /** 当前状态里有字段来自后续章节的角色（显示名）。这些字段替换后保留，没有按新内容重算。 */
  characters: string[]
  /** 证据不在新正文里、留在旧定稿上的线索确认，它们不再计入线索进度。 */
  unmovedConfirmations: Array<{ threadTitle: string; evidence: string }>
}

/**
 * 稿件记着的重开关系：一条指向同一章定稿的依赖。生成稿只引用前面各章的定稿，
 * 所以同章的定稿依赖只会由重开写入。定稿之后这条依赖仍在，说明它当初替换的是哪一份。
 */
export function reopenedFinal(draft: {
  chapterNumber: number
  sourceDependencies?: readonly DraftSourceDependency[]
}): ReopenedFinal | null {
  for (const dependency of draft.sourceDependencies ?? []) {
    if ('chapterNumber' in dependency && dependency.chapterNumber === draft.chapterNumber) return dependency
  }
  return null
}

/**
 * 打开着的重开稿：还在写、改、审的工作稿，带重开关系，且重开的那份仍是本章当前权威定稿。每章至多一份。
 * 重开稿只带这一条依赖，所以 dependenciesStale 就是重开关系是否过期：本章被删除后，
 * 留下的重开稿退回普通工作稿，不再挡住本章以后的重开。
 */
export function isOpenReopenDraft(draft: {
  chapterNumber: number
  status: DraftStatus
  sourceDependencies?: readonly DraftSourceDependency[]
  dependenciesStale: boolean
}): boolean {
  return (WORKING_DRAFT_STATUSES as readonly DraftStatus[]).includes(draft.status)
    && reopenedFinal(draft) !== null
    && !draft.dependenciesStale
}
