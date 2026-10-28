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
}

export interface DuplicateFinalizationRepair {
  chapters: RepairedDuplicateChapter[]
}

export type FinalizationRepairOnOpen =
  | { status: 'checked'; chapters: RepairedDuplicateChapter[] }
  | { status: 'failed'; error: string }
