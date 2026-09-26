import { sameProjectPathKey } from '../shared/project-session-context'

export interface ProjectTransitionDraft {
  projectKey: string
  isDirty: () => boolean
  version: () => number
  save: () => void | Promise<void>
  discard: () => void
}

const drafts = new Set<ProjectTransitionDraft>()

export function registerProjectTransitionDraft(draft: ProjectTransitionDraft): () => void {
  drafts.add(draft)
  return () => drafts.delete(draft)
}

function matchingDrafts(projectKey: string): ProjectTransitionDraft[] {
  return [...drafts].filter(draft => (
    sameProjectPathKey(draft.projectKey, projectKey) && draft.isDirty()
  ))
}

export function hasProjectTransitionDrafts(projectKey: string): boolean {
  return matchingDrafts(projectKey).length > 0
}

export type ProjectTransitionDraftSnapshot = ReadonlyArray<Readonly<{
  draft: ProjectTransitionDraft
  dirty: boolean
  version: number
}>>

export function captureProjectTransitionDraftSnapshot(
  projectKey: string,
): ProjectTransitionDraftSnapshot {
  return [...drafts]
    .filter(draft => sameProjectPathKey(draft.projectKey, projectKey))
    .map(draft => ({ draft, dirty: draft.isDirty(), version: draft.version() }))
}

export function isProjectTransitionDraftSnapshotCurrent(
  projectKey: string,
  snapshot: ProjectTransitionDraftSnapshot,
): boolean {
  const current = captureProjectTransitionDraftSnapshot(projectKey)
  return current.length === snapshot.length && current.every((entry, index) => (
    entry.draft === snapshot[index]?.draft
    && entry.dirty === snapshot[index]?.dirty
    && entry.version === snapshot[index]?.version
  ))
}

export async function saveProjectTransitionDrafts(projectKey: string): Promise<void> {
  const pending = matchingDrafts(projectKey).map(draft => ({
    draft,
    version: draft.version(),
  }))
  for (const { draft } of pending) await draft.save()
  if (pending.some(({ draft, version }) => draft.version() !== version)) {
    throw new Error('保存期间助手输入发生变化，已取消项目切换')
  }
}

export function discardProjectTransitionDrafts(projectKey: string): void {
  for (const draft of matchingDrafts(projectKey)) draft.discard()
}
