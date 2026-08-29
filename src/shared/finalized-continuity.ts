export type FinalizedContinuityFactCategory =
  | 'character-state'
  | 'timeline'
  | 'open-thread'
  | 'plot'

export interface FinalizedContinuityFact {
  category: FinalizedContinuityFactCategory
  entities: string[]
  statement: string
  sourceChapter: number
  evidence: string
}

export interface FinalizedContinuityProjection {
  draftId: number
  chapterNumber: number
  chapterTitle: string
  chapterNotes: string
  facts?: FinalizedContinuityFact[]
}

export interface SaveFinalizedContinuityRequest {
  draftId: number
  chapterNumber: number
  chapterNotes: string
  facts?: FinalizedContinuityFact[]
}
