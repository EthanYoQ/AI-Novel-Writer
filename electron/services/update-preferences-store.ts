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
    return updateGlobalConfig(config => ({ ...config, updatePreferences: preferences }))
  }
}
