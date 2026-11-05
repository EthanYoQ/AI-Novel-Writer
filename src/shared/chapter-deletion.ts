export type ChapterDeletionProjectionStatus = 'pending' | 'completed' | 'failed' | 'not_required'
export type ChapterDeletionStatus = 'authorization_required' | 'pending' | 'failed' | 'completed'
export type LegacyKnowledgeAuthorization = 'not_required' | 'required' | 'consumed'

export interface DeleteFinalizedChapterRequest {
  draftId: number
  chapterNumber: number
}

export interface ChapterDeletionOperation {
  operationId: string
  draftId: number
  chapterNumber: number
  chapterTitle: string
  finalizationId: string
  targetFileName: string
  knowledgeDocumentId: string
  postProcessRunIds: string[]
  manuscriptStatus: ChapterDeletionProjectionStatus
  manuscriptError: string
  knowledgeStatus: ChapterDeletionProjectionStatus
  knowledgeError: string
  legacyKnowledgeAuthorization: LegacyKnowledgeAuthorization
  legacyKnowledgeAuthorizedAt: string
  status: ChapterDeletionStatus
  attemptCount: number
  createdAt: string
  updatedAt: string
  completedAt: string
}

export interface ChapterDeletionResult {
  success: boolean
  committed: boolean
  operation?: ChapterDeletionOperation
  error?: string
}

/**
 * 回收站里的一项怎样恢复，由恢复那一刻的状态现算（ADR-0025）：
 * - into-gap：本章没有定稿，被删定稿原样回到原位；
 * - as-history：本章已重写出新定稿，被删的各版本作为被替换的旧定稿放回版本列表；
 * - reopen-as-draft：本章没有定稿，但被删定稿的收据随作品转移而冻结，只能以它的正文开一份新草稿。
 */
export const CHAPTER_RESTORE_MODES = Object.freeze(['into-gap', 'as-history', 'reopen-as-draft'] as const)
export type ChapterRestoreMode = typeof CHAPTER_RESTORE_MODES[number]

/** 回收站里的一项，即一次删除带走的全部行。deletionId 等于这次删除的主收据 operationId。 */
export interface TrashedChapter {
  deletionId: string
  /** 删除时这一章的定稿；恢复请求用它识别「已恢复」。 */
  draftId: number
  chapterNumber: number
  chapterTitle: string
  deletedAt: string
  wordCount: number
  /** 1 份删除时的定稿加若干份被替换的旧定稿。 */
  versionCount: number
  /** 删除时实体稿与知识库的清理进度（ADR-0011 收据）。 */
  cleanup: ChapterDeletionStatus
  restoreMode: ChapterRestoreMode
}

/** 读不全的一项单独列出，不挡其余各项。 */
export interface DamagedTrashEntry {
  deletionId: string
  error: string
}

export type ChapterTrashListResult =
  | { success: true; entries: TrashedChapter[]; damaged: DamagedTrashEntry[] }
  | { success: false; error: string }

export interface RestoreTrashedChapterRequest {
  deletionId: string
  draftId: number
  /** 作者确认时看到的恢复方式；事务里重算的结果不同就拒绝（CHAPTER_RESTORE_MODE_CHANGED）。 */
  expectedMode: ChapterRestoreMode
}

export type RestoreTrashedChapterResult =
  | { success: true; outcome: 'restored'; chapterNumber: number; draftId: number; finalizationId: string
      publicationStatus: 'pending' | 'published'; publicationError?: string }
  | { success: true; outcome: 'restored-as-history'; chapterNumber: number; draftId: number }
  | { success: true; outcome: 'reopened-as-draft'; chapterNumber: number; draftId: number; created: boolean }
  | { success: true; outcome: 'already-restored'; chapterNumber: number; draftId: number }
  | { success: false; error: string; operation?: ChapterDeletionOperation }

export type PurgeTrashRequest = { deletionIds: string[] } | { all: true }

export type PurgeTrashResult =
  | { success: true; purged: string[]; alreadyGone: string[] }
  | { success: false; error: string }
