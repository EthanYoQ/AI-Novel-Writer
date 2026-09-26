import type { MainReady } from './project-storage'
import type { SkinId } from './skin-types'
import type { APPEARANCE_STORAGE_KEY } from './appearance-profile'

export interface AppearanceSkinSnapshot {
  globalGeneration: string
  skinRevision: number
  backgroundSkin: SkinId
}

export interface AppearanceReadbackAck {
  storageKey: typeof APPEARANCE_STORAGE_KEY
  profileRevision: number
  globalGeneration: string
  skinRevision: number
}

export interface StartupMigrationNotice { legacySourceIgnored: boolean; preservedUnknownCount: number }
export type StartupBlockedCode = 'GLOBAL_DATA_BLOCKED' | 'GLOBAL_MODEL_CREDENTIALS_DIFFER' | 'SKIN_NOT_READY'
export type StartupState = MainReady & { code?: StartupBlockedCode; migrationNotice?: StartupMigrationNotice }
export interface StartupChannels {
  'startup:get-state': { args: []; return: StartupState }
  'startup:skin-snapshot': { args: [ready: Extract<MainReady, { state: 'ready' }>]; return: AppearanceSkinSnapshot }
  'startup:appearance-ack': { args: [ack: AppearanceReadbackAck]; return: boolean }
}
