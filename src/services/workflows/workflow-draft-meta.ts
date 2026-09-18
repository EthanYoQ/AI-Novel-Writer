import { formatResourceUri } from '../../shared/project-paths'
import { canonicalResourceUri, parseResourceUri } from '../../shared/project-paths'
import type { DraftMeta } from '../draft-index'
import type { DraftStatus } from '../../shared/draft-status'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { ipc } from '../ipc-client'

/**
 * Explicit-session variant of the legacy chapter-workflow draft resolver.
 * Commands use this instead of importing the path-only helper, so a workflow
 * cannot resolve a draft through a newly opened same-path project lease.
 */
export async function readWorkflowDraftMeta(
  filePath: string,
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
): Promise<DraftMeta | null> {
  const resource = parseResourceUri(filePath)
  if (!resource || !['draft', 'manuscript', 'chapter'].includes(resource.kind)) return null
  filePath = canonicalResourceUri(filePath)!
  const idMatch = filePath.match(/^ai-novel:\/\/(?:draft|manuscript)\/(\d+)$/)
  if (idMatch) {
    const dbMeta = await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-get-meta',
      Number.parseInt(idMatch[1], 10),
      expectedProjectPath,
    )
    if (!dbMeta) return null
    return {
      ...dbMeta,
      status: dbMeta.status as DraftStatus,
      source: dbMeta.source as 'write' | 'rewrite',
      fileName: `draft_v${dbMeta.version}.md`,
      filePath: formatResourceUri({ kind: 'draft', id: dbMeta.id }),
    } as DraftMeta
  }

  const versionMatch = filePath.match(/v(\d+)(?:\.md)?$/)
  const chapterMatch = filePath.match(/ch(\d+)/)
  if (!versionMatch || !chapterMatch) return null
  const version = Number.parseInt(versionMatch[1], 10)
  const chapterNumber = Number.parseInt(chapterMatch[1], 10)
  const drafts = await ipc.invokeWithProjectSession(
    projectSession,
    'db:draft-list',
    chapterNumber,
    expectedProjectPath,
  )
  return (drafts as unknown as DraftMeta[]).find(draft => draft.version === version) ?? null
}
