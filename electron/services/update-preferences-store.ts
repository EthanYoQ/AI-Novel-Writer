import type { GlobalConfig } from '../../src/shared/ipc-channels'
import {
  DEFAULT_GLOBAL_CONFIG,
  GLOBAL_CONFIG_PATH,
  tryReadJsonFile,
  writeJsonFile,
} from '../utils/config-utils'
import type { UpdatePreferences, UpdatePreferencesStore } from './update-service'

function isConfigRecord(value: unknown): value is GlobalConfig {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** 将更新检查时间和延后提醒写入既有的 ~/.vela/config.json。 */
export class GlobalConfigUpdatePreferencesStore implements UpdatePreferencesStore {
  read(): UpdatePreferences {
    const result = tryReadJsonFile<unknown>(GLOBAL_CONFIG_PATH)
    return result.status === 'ok' && isConfigRecord(result.value)
      ? result.value.updatePreferences ?? {}
      : {}
  }

  write(preferences: UpdatePreferences): void {
    const result = tryReadJsonFile<unknown>(GLOBAL_CONFIG_PATH)
    if (result.status === 'missing') {
      writeJsonFile(GLOBAL_CONFIG_PATH, {
        ...DEFAULT_GLOBAL_CONFIG,
        updatePreferences: preferences,
      })
      return
    }

    if (result.status !== 'ok' || !isConfigRecord(result.value)) {
      // 自动更新不能因为配置损坏而用默认值覆盖用户的模型、语言或代理设置。
      console.warn('[Vela Update] 全局配置不可安全读取，跳过更新偏好写入。')
      return
    }

    const config: GlobalConfig = result.value
    writeJsonFile(GLOBAL_CONFIG_PATH, {
      ...config,
      updatePreferences: preferences,
    })
  }
}
