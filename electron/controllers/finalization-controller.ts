import { ipcMain } from 'electron'

import { getCurrentProjectPath } from '../database'
import { projectAccess } from '../services/project-access'
import { FinalizationService } from '../services/finalization-service'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import type { FinalizationSnapshot } from '../../src/services/finalization-snapshot'

const finalizationService = new FinalizationService()

function isFinalizationSnapshot(value: unknown): value is FinalizationSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<FinalizationSnapshot>
  return (
    typeof snapshot.tabId === 'string'
    && typeof snapshot.projectPath === 'string'
    && isProjectSessionContext(snapshot.projectSession)
    && Number.isInteger(snapshot.draftId)
    && Number.isInteger(snapshot.chapterNumber)
    && typeof snapshot.chapterTitle === 'string'
    && typeof snapshot.content === 'string'
    && Number.isInteger(snapshot.contentRevision)
  )
}

function snapshotMatchesContext(
  snapshot: FinalizationSnapshot,
  context: ProjectSessionContext,
): boolean {
  return snapshot.projectPath === context.projectPath
    && snapshot.projectSession.projectId === context.projectId
    && snapshot.projectSession.leaseId === context.leaseId
    && snapshot.projectSession.projectPath === context.projectPath
}

/**
 * #23 的窄 IPC 边界。这里不复用 db-controller 的路径兼容调用，也不向 shared
 * IPC 增加宽泛路径 API；每个动作都必须带 #21 的当前项目会话并由 ProjectAccess
 * 重新验证。
 */
export function registerFinalizationController(): void {
  ipcMain.handle('finalization:commit', async (
    _event,
    candidate: unknown,
    context: unknown,
  ) => {
    try {
      if (!isFinalizationSnapshot(candidate)) {
        throw new Error('定稿快照无效')
      }
      if (!isProjectSessionContext(context) || !snapshotMatchesContext(candidate, context)) {
        throw new Error('定稿快照与项目会话不匹配')
      }
      const active = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
      return await finalizationService.finalize({
        projectRoot: active.rootPath,
        draftId: candidate.draftId,
        chapterNumber: candidate.chapterNumber,
        chapterTitle: candidate.chapterTitle,
        content: candidate.content,
        contentRevision: candidate.contentRevision,
      })
    } catch (error) {
      return { success: false, committed: false, error: String(error) }
    }
  })

  ipcMain.handle('finalization:retry', async (
    _event,
    finalizationId: unknown,
    context: unknown,
  ) => {
    try {
      if (typeof finalizationId !== 'string' || !finalizationId) {
        throw new Error('缺少可重试的定稿提交身份')
      }
      if (!isProjectSessionContext(context)) {
        throw new Error('缺少项目会话，已拒绝实体稿重试')
      }
      const active = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
      return await finalizationService.retry({
        projectRoot: active.rootPath,
        finalizationId,
      })
    } catch (error) {
      return { success: false, committed: false, error: String(error) }
    }
  })
}
