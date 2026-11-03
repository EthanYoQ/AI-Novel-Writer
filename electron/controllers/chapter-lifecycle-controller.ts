import { ipcMain } from 'electron'

import { isProjectSessionContext } from '../../src/shared/project-session-context'
import type { DeleteFinalizedChapterRequest } from '../../src/shared/chapter-deletion'
import type { ReopenChapterRequest } from '../../src/shared/chapter-reopen'
import { getCurrentProjectPath } from '../database'
import {
  chapterDeletionService,
  type ChapterDeletionService,
} from '../services/chapter-deletion-service'
import { reopenFinalizedChapter } from '../services/chapter-reopen-service'
import { ReplacementImpactRepository } from '../repositories/replacement-impact-repository'
import { removeReplacedKnowledge, removeReplacedManuscripts } from '../services/replaced-final-cleanup'
import { projectAccess } from '../services/project-access'
import { assertRequiredExpectedProjectPath } from '../utils/project-context'

type ChapterLifecycleHandler = (event: unknown, ...args: never[]) => unknown

export function registerChapterLifecycleController(
  service: ChapterDeletionService = chapterDeletionService,
): void {
  const register = (channel: string, handler: ChapterLifecycleHandler) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const candidate = args.at(-1)
      const context = isProjectSessionContext(candidate) ? candidate : undefined
      if (context) args.pop()
      try {
        const lease = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
        return await (handler as (event: unknown, ...handlerArgs: unknown[]) => unknown)(
          event,
          ...args,
          lease.rootPath,
          lease.projectId,
        )
      } catch (error) {
        return {
          success: false,
          committed: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })
  }

  register('chapter:delete-finalized', async (
    _event,
    request: DeleteFinalizedChapterRequest,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return service.delete(projectRoot, request)
  })

  register('chapter:retry-deletion', async (
    _event,
    operationId: string,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return service.retry(projectRoot, operationId)
  })

  register('chapter:confirm-legacy-knowledge-absent', async (
    _event,
    operationId: string,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return service.confirmLegacyKnowledgeAbsent(projectRoot, operationId)
  })

  register('chapter:reopen', async (
    _event,
    request: ReopenChapterRequest,
    expectedProjectPath: string,
    projectRoot: string,
    projectId: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return reopenFinalizedChapter(projectId, request)
  })

  register('chapter:remove-replaced-knowledge', async (
    _event,
    draftId: number,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    await removeReplacedKnowledge(projectRoot, draftId)
    return { success: true }
  })

  register('chapter:remove-replaced-manuscripts', async (
    _event,
    draftId: number,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    await removeReplacedManuscripts(projectRoot, draftId)
    return { success: true }
  })

  register('chapter:replacement-impacts', async (
    _event,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return { success: true, impacts: ReplacementImpactRepository.list() }
  })

  register('chapter:replacement-impact-preview', async (
    _event,
    draftId: number,
    content: string,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return { success: true, impact: ReplacementImpactRepository.preview(draftId, content) }
  })

  register('chapter:list-incomplete-deletions', async (
    _event,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return { success: true, operations: service.listIncomplete(projectRoot) }
  })
}
