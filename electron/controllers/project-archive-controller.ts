import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { dialog, ipcMain } from 'electron'

import type {
  ExternalFileGrant,
  PortableProjectOperationErrorCode,
  PortableProjectExportRequest,
  PortableProjectRestoreRequest,
} from '../../src/shared/ipc-channels'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY } from '../../src/shared/project-format'
import { getCurrentProjectPath } from '../database'
import {
  ExternalFileGrantService,
  externalFileGrants,
  type IssuedExternalFileGrant,
} from '../services/external-file-grant-service'
import { projectAccess } from '../services/project-access'
import { exportPortableProject } from '../services/project-archive-service'
import { createPortableProjectAssetProvider } from '../services/portable-project-assets'
import { restorePortableProject } from '../services/project-restore-service'
import { registerRecentProject } from './project-controller'

const require = createRequire(import.meta.url)
const BetterSqlite = require('better-sqlite3') as typeof import('better-sqlite3')
const portableAssets = createPortableProjectAssetProvider()
const ARCHIVE_EXTENSION = 'ainovel'
/** 选择器签发的一次性授权；恢复需要连续选择两次，故留出足够的选择时间。 */
const ARCHIVE_GRANT_TTL_MS = 10 * 60 * 1_000
const PORTABLE_ERROR_CODES = new Set<PortableProjectOperationErrorCode>([
  'PORTABLE_ARCHIVE_INVALID',
  'PORTABLE_ARCHIVE_LIMIT_EXCEEDED',
  'PORTABLE_ARCHIVE_SOURCE_CHANGED',
  'PORTABLE_ARCHIVE_SOURCE_UNSAFE',
  'PORTABLE_ARCHIVE_PUBLISH_UNSUPPORTED',
  'PORTABLE_ARCHIVE_TARGET_EXISTS',
  'PORTABLE_ASSET_MISSING',
  'PORTABLE_ASSET_UNSAFE',
  'PORTABLE_CONTEXT_INVALID',
  'PORTABLE_GRANT_INVALID',
  'PORTABLE_SCHEMA_UNSUPPORTED',
  'PORTABLE_SOURCE_CHANGED',
  'PORTABLE_TARGET_INSIDE_SOURCE',
  'PORTABLE_UNSAFE_PROJECTION',
  'PORTABLE_RESTORE_CANCELLED',
  'PORTABLE_RESTORE_INVALID',
  'PORTABLE_RESTORE_TARGET_EXISTS',
  'PORTABLE_RESTORE_UNSAFE_TARGET',
])

function failure(error: unknown) {
  const candidate = typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : error instanceof Error ? error.message : undefined
  const errorCode = PORTABLE_ERROR_CODES.has(candidate as PortableProjectOperationErrorCode)
    ? candidate as PortableProjectOperationErrorCode
    : undefined
  return {
    success: false as const,
    error: error instanceof Error ? error.message : String(error),
    ...(errorCode ? { errorCode } : {}),
  }
}

function readRestoredProjectName(projectRoot: string): string {
  const database = new BetterSqlite(
    path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE),
    { readonly: true, fileMustExist: true },
  )
  try {
    const row = database.prepare("SELECT project_name FROM project_core WHERE id = 'main'").get() as {
      project_name?: unknown
    } | undefined
    const name = typeof row?.project_name === 'string' ? row.project_name.trim() : ''
    if (!name) throw new Error('RESTORED_PROJECT_NAME_INVALID')
    return name
  } finally {
    database.close()
  }
}

function safeSuggestedName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const safe = Array.from(value.trim(), character => (
    character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '-' : character
  )).join('')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  return safe || fallback
}

function availableRestoreTarget(parent: string, suggestedName: string): string {
  const base = path.join(parent, safeSuggestedName(suggestedName, 'restored-project'))
  if (!fs.existsSync(base)) return base
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error('PORTABLE_RESTORE_TARGET_EXISTS')
}

interface ArchiveGrantEvent {
  sender: {
    id: number
    once: (event: 'destroyed', listener: () => void) => unknown
  }
}

/** 选择结果只以不透明授权标识交给渲染进程；授权绑定该窗口，窗口销毁即撤销。 */
function issueSelectedGrant(
  grants: ExternalFileGrantService,
  event: ArchiveGrantEvent,
  issued: IssuedExternalFileGrant,
  selectedPath: string,
): ExternalFileGrant {
  event.sender.once('destroyed', () => grants.revoke(issued.grantId))
  return { grantId: issued.grantId, displayName: path.basename(selectedPath) }
}

/**
 * 归档服务仍以路径为入参，因此授权在服务边界前由主进程解析成路径。
 * 无授权、他窗口授权、操作或范围不符、过期或已消费的授权一律折叠为同一个不含路径的错误码。
 */
function resolveGrantedPath(
  grants: ExternalFileGrantService,
  event: ArchiveGrantEvent,
  grantId: unknown,
  operation: 'read' | 'create',
): string {
  try {
    if (typeof grantId !== 'string' || grantId === '') throw new Error('grant missing')
    return grants.resolveExactPath({ grantId, webContentsId: event.sender.id, operation })
  } catch {
    throw Object.assign(new Error('PORTABLE_GRANT_INVALID'), { code: 'PORTABLE_GRANT_INVALID' })
  }
}

export function registerProjectArchiveController(
  grants: ExternalFileGrantService = externalFileGrants,
): void {
  ipcMain.handle('dialog:select-project-archive-export', async (event: ArchiveGrantEvent, suggestedName: string) => {
    const result = await dialog.showSaveDialog({
      title: '导出项目存档',
      defaultPath: `${safeSuggestedName(suggestedName, 'project-backup')}.${ARCHIVE_EXTENSION}`,
      filters: [{ name: 'AI Novel Archive', extensions: [ARCHIVE_EXTENSION] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (result.canceled || !result.filePath) return null
    const issued = grants.issueNewChild({
      webContentsId: event.sender.id,
      filePath: result.filePath,
      operations: ['create'],
      ttlMs: ARCHIVE_GRANT_TTL_MS,
      maxUses: 1,
    })
    return issueSelectedGrant(grants, event, issued, result.filePath)
  })

  ipcMain.handle('dialog:select-project-archive', async (event: ArchiveGrantEvent) => {
    const result = await dialog.showOpenDialog({
      title: '选择项目存档',
      filters: [{ name: 'AI Novel Archive', extensions: [ARCHIVE_EXTENSION] }],
      properties: ['openFile'],
    })
    const archivePath = result.canceled ? undefined : result.filePaths[0]
    if (!archivePath) return null
    const issued = grants.issueFile({
      webContentsId: event.sender.id,
      filePath: archivePath,
      operations: ['read'],
      ttlMs: ARCHIVE_GRANT_TTL_MS,
      maxUses: 1,
    })
    return issueSelectedGrant(grants, event, issued, archivePath)
  })

  ipcMain.handle('dialog:select-project-restore-target', async (event: ArchiveGrantEvent, suggestedName: string) => {
    const result = await dialog.showOpenDialog({ title: '选择恢复副本所在文件夹', properties: ['openDirectory', 'createDirectory'] })
    const parent = result.canceled ? undefined : result.filePaths[0]
    if (!parent) return null
    const targetPath = availableRestoreTarget(parent, suggestedName)
    const issued = grants.issueNewChild({
      webContentsId: event.sender.id,
      filePath: targetPath,
      operations: ['create'],
      ttlMs: ARCHIVE_GRANT_TTL_MS,
      maxUses: 1,
    })
    return issueSelectedGrant(grants, event, issued, targetPath)
  })

  ipcMain.handle('project:archive-export', async (event: ArchiveGrantEvent, request: PortableProjectExportRequest) => {
    try {
      const active = projectAccess.assertCurrentProjectContext(
        request.projectSession,
        getCurrentProjectPath(),
      )
      const targetArchivePath = resolveGrantedPath(grants, event, request.targetArchiveGrantId, 'create')
      const receipt = await exportPortableProject({
        sourceProjectRoot: active.rootPath,
        projectSession: request.projectSession,
        targetArchivePath,
        attemptParentPath: path.dirname(path.resolve(targetArchivePath)),
        assets: portableAssets,
        assertCurrentContext(context, sourceProjectRoot) {
          const current = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
          return projectAccess.sameCanonicalProjectRoot(current.rootPath, sourceProjectRoot)
        },
      })
      return { success: true as const, receipt }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('project:archive-restore', async (event: ArchiveGrantEvent, request: PortableProjectRestoreRequest) => {
    try {
      const archivePath = resolveGrantedPath(grants, event, request.archiveGrantId, 'read')
      const targetProjectRoot = resolveGrantedPath(grants, event, request.targetGrantId, 'create')
      const receipt = await restorePortableProject({ archivePath, targetProjectRoot })
      try {
        registerRecentProject({
          name: readRestoredProjectName(receipt.targetProjectRoot),
          path: receipt.targetProjectRoot,
          projectId: receipt.targetProjectId,
          updatedAt: new Date().toISOString(),
        })
        return { success: true as const, receipt, recentProjectUpdated: true }
      } catch {
        return {
          success: true as const,
          receipt,
          recentProjectUpdated: false,
          warning: '项目已恢复，但最近项目列表暂未更新',
        }
      }
    } catch (error) {
      return failure(error)
    }
  })
}
