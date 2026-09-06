export type RecoveryCandidateStatus = 'pending' | 'continued' | 'discarded'

export interface RecoveryChapterSource {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string[]
  suspenseHook?: string
  userGuidance?: string
}

export interface RecoveryCandidateRecordRequest {
  runId: string
  stepId: string
  projectId: string
  chapterNumber: number
  chapterTitle: string
  source: RecoveryChapterSource
  visibleText: string
  failureCode: string
  failureReason: string
  replacesCandidateId?: string
}

/** Renderer input; project identity is always supplied by the validated main-process lease. */
export type RecoveryCandidateRecordInput = Omit<RecoveryCandidateRecordRequest, 'projectId'>

export interface RecoveryCandidate {
  candidateId: string
  runId: string
  stepId: string
  projectId: string
  chapterNumber: number
  chapterTitle: string
  sourceHash: string
  visibleText: string
  contentHash: string
  failureCode: string
  failureReason: string
  status: RecoveryCandidateStatus
  replacesCandidateId: string | null
  sourceCurrent: boolean
  createdAt: string
  resolvedAt: string | null
}
