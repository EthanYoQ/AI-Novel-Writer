import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { dialog, ipcMain } from 'electron'

import type {
  PortableProjectOperationErrorCode,
  PortableProjectExportRequest,
  PortableProjectRestoreRequest,
} from '../../src/shared/ipc-channels'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY } from '../../src/shared/project-format'
import { getCurrentProjectPath } from '../database'
import { projectAccess } from '../services/project-access'
import { exportPortableProject } from '../services/project-archive-service'
import { createPortableProjectAssetProvider } from '../services/portable-project-assets'
import { restorePortableProject } from '../services/project-restore-service'
import { registerRecentProject } from './project-controller'

const require = createRequire(import.meta.url)
const BetterSqlite = require('better-sqlite3') as typeof import('better-sqlite3')
const portableAssets = createPortableProjectAssetProvider()
const ARCHIVE_EXTENSION = 'ainovel'
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

export function registerProjectArchiveController(): void {
  ipcMain.handle('dialog:select-project-archive-export', async (_event, suggestedName: string) => {
    const result = await dialog.showSaveDialog({
      title: '导出项目存档',
      defaultPath: `${safeSuggestedName(suggestedName, 'project-backup')}.${ARCHIVE_EXTENSION}`,
      filters: [{ name: 'AI Novel Archive', extensions: [ARCHIVE_EXTENSION] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    return result.canceled || !result.filePath ? null : result.filePath
  })

  ipcMain.handle('dialog:select-project-archive', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择项目存档',
      filters: [{ name: 'AI Novel Archive', extensions: [ARCHIVE_EXTENSION] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('dialog:select-project-restore-target', async (_event, suggestedName: string) => {
    const result = await dialog.showOpenDialog({ title: '选择恢复副本所在文件夹', properties: ['openDirectory', 'createDirectory'] })
    const parent = result.canceled ? undefined : result.filePaths[0]
    return parent ? availableRestoreTarget(parent, suggestedName) : null
  })

  ipcMain.handle('project:archive-export', async (_event, request: PortableProjectExportRequest) => {
    try {
      const active = projectAccess.assertCurrentProjectContext(
        request.projectSession,
        getCurrentProjectPath(),
      )
      const receipt = await exportPortableProject({
        sourceProjectRoot: active.rootPath,
        projectSession: request.projectSession,
        targetArchivePath: request.targetArchivePath,
        attemptParentPath: path.dirname(path.resolve(request.targetArchivePath)),
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

  ipcMain.handle('project:archive-restore', async (_event, request: PortableProjectRestoreRequest) => {
    try {
      const receipt = await restorePortableProject({
        archivePath: request.archivePath,
        targetProjectRoot: request.targetProjectRoot,
      })
      try {
        registerRecentProject({
          name: readRestoredProjectName(receipt.targetProjectRoot),
          path: receipt.targetProjectRoot,
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
