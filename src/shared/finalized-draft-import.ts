export interface FinalizedDraftImportChapter {
  chapterNumber: number
  title: string
  content: string
  wordCount: number
}

export interface FinalizedDraftImportRequest {
  operationId: string
  chapters: FinalizedDraftImportChapter[]
}

export interface FinalizedDraftImportDraftReceipt {
  chapterNumber: number
  draftId: number
  finalizationId: string
  contentHash: string
  targetFileName: string
  status: 'finalized'
  publicationStatus: 'pending'
}

export interface FinalizedDraftImportReceipt {
  operationId: string
  payloadHash: string
  chapterNumbers: number[]
  drafts: FinalizedDraftImportDraftReceipt[]
  idempotent: boolean
}
