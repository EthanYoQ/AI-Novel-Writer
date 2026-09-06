import { ipcMain } from 'electron'
import {
  readJsonFile,
  tryReadJsonFile,
  writeJsonFile,
  GLOBAL_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
} from '../utils/config-utils'
import { GlobalConfig } from '../../src/shared/ipc-channels'

export function registerConfigController() {
  /** 读取全局配置 */
  ipcMain.handle('config:get', async () => {
    return readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  })

  /** 保存全局配置 */
  ipcMain.handle('config:set', async (_event, config: Partial<GlobalConfig>) => {
    try {
      const existingRead = tryReadJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH)
      if (existingRead.status === 'error') {
        throw new Error('全局配置损坏，已拒绝覆盖', { cause: existingRead.error })
      }
      const existing = existingRead.status === 'ok'
        ? existingRead.value
        : { ...DEFAULT_GLOBAL_CONFIG }
      const updated = { ...existing, ...config }
      writeJsonFile(GLOBAL_CONFIG_PATH, updated)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
