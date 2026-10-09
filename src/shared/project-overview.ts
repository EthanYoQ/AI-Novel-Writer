export const PROJECT_OVERVIEW_STAGE_IDS = [
  'configuration',
  'architecture',
  'blueprint',
  'drafting',
  'review',
  'finalization',
] as const

export type ProjectOverviewStageId = typeof PROJECT_OVERVIEW_STAGE_IDS[number]
export type ProjectOverviewStageStatus = 'unknown' | 'not-started' | 'in-progress' | 'completed'

export interface ProjectOverviewStage {
  id: ProjectOverviewStageId
  status: ProjectOverviewStageStatus
  count: number
}

export interface ReadyProjectOverview {
  state: 'ready'
  projectId: string
  /** Opaque fact revision. It is never a filesystem path. */
  revision: string
  name: string
  totalWords: number
  characters: number
  finalizedChapters: number
  stages: readonly ProjectOverviewStage[]
  /** Present only when main reads the already-open current project. */
  excerpt?: string
}

export type ProjectOverview = ReadyProjectOverview | { state: 'unavailable' }

export interface ProjectPeekCapability {
  capabilityId: string
  projectId: string
}
