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
  legacyKnowledgeConfirmedAt: string
  legacyKnowledgeConsumedAt: string
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
