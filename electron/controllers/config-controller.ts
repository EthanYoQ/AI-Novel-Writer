import { app, ipcMain } from 'electron'
import {
  readJsonFile,
  tryReadJsonFile,
  writeJsonFile,
  GLOBAL_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
} from '../utils/config-utils'
import { GlobalConfig } from '../../src/shared/ipc-channels'
import { mainText } from '../i18n'

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
        // 设置页把这句原样拼进「保存失败」说明，所以在这里按界面语言写好。
        console.error('[config:set] 全局配置无法解析，已拒绝覆盖:', existingRead.error)
        return {
          success: false,
          error: mainText(
            app.getLocale(),
            '全局配置文件已损坏，已拒绝覆盖。请修复或删除应用数据目录里的 config.json 后重试。',
            'The global config file is damaged, so it was not overwritten. Repair or delete config.json in the app data folder, then try again.',
          ),
        }
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
