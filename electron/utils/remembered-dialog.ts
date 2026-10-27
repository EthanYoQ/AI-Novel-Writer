import fs from 'node:fs'
import path from 'node:path'
import { dialog, type OpenDialogOptions, type OpenDialogReturnValue, type SaveDialogOptions, type SaveDialogReturnValue } from 'electron'
import type { DialogDirectoryKind, GlobalConfig } from '../../src/shared/ipc-channels'
import { GLOBAL_CONFIG_PATH, tryReadJsonFile, updateGlobalConfig } from './config-utils'

// Electron 43 起不给 defaultPath 时对话框固定打开「下载」，系统不再记住上次目录：
// https://github.com/electron/electron/blob/main/docs/breaking-changes.md#behavior-changed-dialog-methods-default-to-downloads-directory

function lastDirectory(kind: DialogDirectoryKind): string | undefined {
  try {
    const config = tryReadJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH)
    const directory = config.status === 'ok' ? config.value?.dialogDirectories?.[kind] : undefined
    return typeof directory === 'string' && fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()
      ? directory
      : undefined
  } catch {
    return undefined
  }
}

function tryRememberDirectory(kind: DialogDirectoryKind, directory: string): void {
  try {
    updateGlobalConfig(config => ({
      ...config,
      dialogDirectories: { ...config.dialogDirectories, [kind]: directory },
    }))
  } catch (error) {
    console.warn('[Dialog] 未能记住上次使用的目录', error)
  }
}

export async function showOpenDialogInLastDirectory(
  kind: DialogDirectoryKind,
  options: OpenDialogOptions,
): Promise<OpenDialogReturnValue> {
  const directory = lastDirectory(kind)
  const result = await dialog.showOpenDialog(directory ? { ...options, defaultPath: directory } : options)
  const selected = result.canceled ? undefined : result.filePaths[0]
  if (selected) {
    tryRememberDirectory(kind, options.properties?.includes('openDirectory') ? selected : path.dirname(selected))
  }
  return result
}

export async function showSaveDialogInLastDirectory(
  kind: DialogDirectoryKind,
  options: SaveDialogOptions,
): Promise<SaveDialogReturnValue> {
  const directory = lastDirectory(kind)
  const result = await dialog.showSaveDialog(directory
    ? { ...options, defaultPath: path.join(directory, options.defaultPath ?? '') }
    : options)
  if (!result.canceled && result.filePath) tryRememberDirectory(kind, path.dirname(result.filePath))
  return result
}
