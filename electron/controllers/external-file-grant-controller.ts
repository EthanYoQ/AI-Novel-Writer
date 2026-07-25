import path from 'node:path'
import { app, dialog, ipcMain } from 'electron'
import {
  ExternalFileGrantService,
  type ResolvedExternalFileGrant,
  externalFileGrants,
} from '../services/external-file-grant-service'
import { mainText } from '../i18n'
import {
  windowsSafeFileSystem,
  type WindowsSafeFileSystem,
} from '../security/windows-safe-file-system'

const EXPORT_GRANT_TTL_MS = 10 * 60 * 1_000
const EXPORT_GRANT_MAX_USES = 4_096

function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

/** 不把文件系统绝对路径或内部服务错误原样回传给渲染层。 */
function grantErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/过期|不存在|已撤销/.test(message)) {
    return text('外部文件授权已失效，请重新选择。', 'The external file grant has expired. Please choose again.')
  }
  if (/权限|webContents/.test(message)) {
    return text('当前窗口无权使用该外部文件授权。', 'This window is not allowed to use the external file grant.')
  }
  if (/相对路径|父目录遍历|绝对路径|NUL|超出授权范围|目标已变化|SECURE_FS_(REPARSE_POINT|INVALID_PATH|NOT_FOUND)/.test(message)) {
    return text('外部文件授权路径无效，已拒绝操作。', 'The external file grant path is invalid; the operation was rejected.')
  }
  if (/SECURE_FS_(UNSUPPORTED_PLATFORM|HELPER_UNAVAILABLE|HELPER_TIMEOUT)/.test(message)) {
    return text('安全外部文件服务不可用，已拒绝操作。', 'The secure external file service is unavailable; the operation was rejected.')
  }
  return text('外部文件授权操作失败。', 'The external file grant operation failed.')
}

type GrantEvent = {
  sender: {
    id: number
    once: (event: 'destroyed', listener: () => void) => unknown
  }
}

function revokeWhenSenderIsDestroyed(event: GrantEvent, grants: ExternalFileGrantService): void {
  const webContentsId = event.sender.id
  event.sender.once('destroyed', () => grants.revokeWebContents(webContentsId))
}

function resolveGrantPath(
  grants: ExternalFileGrantService,
  event: GrantEvent,
  grantId: string,
  operation: 'read' | 'list' | 'write' | 'create',
  relativePath?: string,
  consumeUse = true,
): ResolvedExternalFileGrant {
  const resolver = consumeUse ? grants.resolve.bind(grants) : grants.revalidate.bind(grants)
  return resolver({
    grantId,
    webContentsId: event.sender.id,
    operation,
    relativePath,
  })
}

/**
 * 授权型外部文件入口。这里永远不接受渲染层提供的绝对路径；路径只来自
 * 主进程文件选择器，并被转换为绑定 webContents 的短期授权标识。
 */
export function registerExternalFileGrantController(
  grants: ExternalFileGrantService = externalFileGrants,
  fileSystem: WindowsSafeFileSystem = windowsSafeFileSystem,
): void {
  ipcMain.handle('dialog:select-export-directory', async (event: GrantEvent) => {
    const result = await dialog.showOpenDialog({
      title: text('选择导出目录', 'Choose an export directory'),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const directoryPath = result.filePaths[0]
    const grant = grants.issueDirectory({
      webContentsId: event.sender.id,
      directoryPath,
      operations: ['write', 'create'],
      ttlMs: EXPORT_GRANT_TTL_MS,
      maxUses: EXPORT_GRANT_MAX_USES,
    })
    revokeWhenSenderIsDestroyed(event, grants)
    return {
      grantId: grant.grantId,
      displayName: path.basename(directoryPath),
    }
  })

  ipcMain.handle(
    'fs:grant-read-file',
    async (event: GrantEvent, grantId: string, relativePath?: string) => {
      try {
        const target = resolveGrantPath(grants, event, grantId, 'read', relativePath)
        return { success: true, content: await fileSystem.readText(target) }
      } catch (error) {
        return { success: false, content: '', error: grantErrorText(error) }
      }
    },
  )

  ipcMain.handle(
    'fs:grant-write-file',
    async (event: GrantEvent, grantId: string, relativePath: string, content: string) => {
      try {
        const target = resolveGrantPath(grants, event, grantId, 'write', relativePath)
        const targetExists = await fileSystem.exists(target)
        let canCreate = false
        let createPermissionError: unknown
        try {
          resolveGrantPath(grants, event, grantId, 'create', relativePath, false)
          canCreate = true
        } catch (error) {
          createPermissionError = error
        }
        if (!targetExists && !canCreate) {
          throw createPermissionError
        }
        // writeTextAtomically holds a root-relative Windows handle chain through
        // temporary-file creation and replacement. Revalidate the grant at the
        // ready phase and let the helper enforce create-vs-write at commit.
        await fileSystem.writeTextAtomically(target, content, () => {
          resolveGrantPath(grants, event, grantId, 'write', relativePath, false)
          if (canCreate) {
            resolveGrantPath(grants, event, grantId, 'create', relativePath, false)
          }
        }, { mustAlreadyExist: !canCreate })
        return { success: true }
      } catch (error) {
        return { success: false, error: grantErrorText(error) }
      }
    },
  )

  ipcMain.handle(
    'fs:grant-mkdir',
    async (event: GrantEvent, grantId: string, relativePath: string) => {
      try {
        const target = resolveGrantPath(grants, event, grantId, 'create', relativePath)
        await fileSystem.mkdir(target)
        return { success: true }
      } catch (error) {
        return { success: false, error: grantErrorText(error) }
      }
    },
  )
}
