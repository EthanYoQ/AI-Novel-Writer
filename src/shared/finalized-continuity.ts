export interface FinalizedContinuityProjection {
  draftId: number
  chapterNumber: number
  chapterTitle: string
  chapterNotes: string
}

export interface SaveFinalizedContinuityRequest {
  draftId: number
  chapterNumber: number
  chapterNotes: string
}
