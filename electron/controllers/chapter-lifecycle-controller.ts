import { ipcMain } from 'electron'

import { isProjectSessionContext } from '../../src/shared/project-session-context'
import type { DeleteFinalizedChapterRequest } from '../../src/shared/chapter-deletion'
import { getCurrentProjectPath } from '../database'
import {
  chapterDeletionService,
  type ChapterDeletionService,
} from '../services/chapter-deletion-service'
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

  register('chapter:get-deletion', async (
    _event,
    operationId: string,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return { success: true, operation: service.get(operationId) }
  })

  register('chapter:list-incomplete-deletions', async (
    _event,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return { success: true, operations: service.listIncomplete() }
  })
}
