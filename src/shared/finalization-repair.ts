export interface SupersededFinalizationLeftover {
  draftId: number
  version: number
  knowledgeDocumentId: string
  targetFileName: string
}

export interface RepairedDuplicateChapter {
  chapterNumber: number
  keptDraftId: number
  keptVersion: number
  superseded: SupersededFinalizationLeftover[]
  /** 已在保留那份定稿的后处理里登记清理旧知识库文档或旧实体稿的步骤，作者点「重试」即可清理。 */
  cleanupRegistered: boolean
}

export interface DuplicateFinalizationRepair {
  chapters: RepairedDuplicateChapter[]
}

export type FinalizationRepairOnOpen =
  | { status: 'checked'; chapters: RepairedDuplicateChapter[] }
  | { status: 'failed'; error: string }
