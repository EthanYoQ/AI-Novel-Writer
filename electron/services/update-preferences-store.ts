import { GLOBAL_CONFIG_PATH, isGlobalConfigRecord, tryReadJsonFile, updateGlobalConfig } from '../utils/config-utils'
import type { UpdatePreferences, UpdatePreferencesStore } from './update-service'

/** Updates only the configuration in the admitted canonical global generation. */
export class GlobalConfigUpdatePreferencesStore implements UpdatePreferencesStore {
  read(): UpdatePreferences {
    const result = tryReadJsonFile<unknown>(GLOBAL_CONFIG_PATH)
    return result.status === 'ok' && isGlobalConfigRecord(result.value)
      ? result.value.updatePreferences ?? {}
      : {}
  }

  write(preferences: UpdatePreferences): boolean {
    const written = updateGlobalConfig(config => ({ ...config, updatePreferences: preferences }))
    if (!written) {
      // 自动更新不能因为配置损坏而用默认值覆盖用户的模型、语言或代理设置。
      console.warn('[AI Novel Update] 全局配置不可安全读取，跳过更新偏好写入。')
    }
    return written
  }
}
