import type { MainReady } from './project-storage'
import type { APPEARANCE_STORAGE_KEY } from './appearance-profile'

/** 渲染进程写好外观偏好并读回后，向主进程确认这一份的修订号与所在的全局数据世代。 */
export interface AppearanceReadbackAck {
  storageKey: typeof APPEARANCE_STORAGE_KEY
  profileRevision: number
  globalGeneration: string
}

export interface StartupMigrationNotice { legacySourceIgnored: boolean; preservedUnknownCount: number }
export type StartupBlockedCode = 'GLOBAL_DATA_BLOCKED' | 'GLOBAL_MODEL_CREDENTIALS_DIFFER'
export type StartupState = MainReady & {
  code?: StartupBlockedCode
  migrationNotice?: StartupMigrationNotice
  /** 这个窗口此前已确认过的外观修订号。重载后存储坏了时，重置要写得比它大，主进程才接受。 */
  appearanceRevisionFloor?: number
}
export interface StartupChannels {
  'startup:get-state': { args: []; return: StartupState }
  'startup:appearance-ack': { args: [ack: AppearanceReadbackAck]; return: boolean }
}
