export type FinalizedContinuityFactCategory =
  | 'character-state'
  | 'timeline'
  | 'open-thread'
  | 'plot'

/** Existing finalization receipt fields needed to bind derived material to immutable prose. */
export interface FinalizedSourceIdentity {
  draftId: number
  finalizationId: string
  chapterNumber: number
  contentHash: string
}

export type FinalizedProjectionStatus = 'current' | 'stale' | 'legacy'

export interface FinalizedSourceSnapshot {
  source: FinalizedSourceIdentity
  chapterTitle: string
  content: string
  /** Project continuity watermark frozen before semantic extraction starts. */
  projectionGeneration: number
}

export type FinalizedSourceReadResult =
  | { status: 'valid'; snapshot: FinalizedSourceSnapshot }
  | {
      status: 'legacy'
      draftId: number
      chapterNumber: number
      chapterTitle: string
      content: string
    }
  | { status: 'invalid' }

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
  /** Missing only for pre-v2 rows whose source cannot be safely reconstructed. */
  source?: FinalizedSourceIdentity
  /** Missing legacy callers must be treated exactly like `legacy`, never current. */
  sourceStatus?: FinalizedProjectionStatus
}

export interface SaveFinalizedContinuityRequest {
  draftId: number
  chapterNumber: number
  chapterNotes: string
  facts?: FinalizedContinuityFact[]
  /** Watermark frozen before extraction; stale in-flight results must not advance it. */
  projectionGeneration: number
  /** Frozen before extraction; the main process revalidates it at commit time. */
  source: FinalizedSourceIdentity
}
