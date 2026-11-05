export type AuthorManuscriptPreviewClassification = 'ready' | 'exact-duplicate' | 'conflict'

export interface AuthorManuscriptPreviewChapter {
  number: number
  title: string
  wordCount: number
  disposition: 'new' | 'duplicate' | 'conflict'
}

export interface AuthorManuscriptImportPreview {
  classification: AuthorManuscriptPreviewClassification
  authorityFingerprint: string
  manifestFingerprint: string
  chapterCount: number
  targetStatus: 'finalized'
  nextChapterNumber?: number
  chapters: AuthorManuscriptPreviewChapter[]
  newChapterNumbers: number[]
  duplicateChapterNumbers: number[]
  conflictChapterNumbers: number[]
  firstGapChapterNumber?: number
  authorityInvalid: boolean
}
