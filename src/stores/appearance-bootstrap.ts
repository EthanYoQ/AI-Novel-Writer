import { create } from 'zustand'
import {
  APPEARANCE_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY, LEGACY_UI_STORAGE_KEY, INITIAL_APPEARANCE,
  AppearanceProfileError, migrateLegacyAppearance, parseAppearanceProfile, resolveShell, RELEASE_DEFAULT_SHELL,
  type AppearancePatch, type CanonicalAppearanceProfile, type Shell,
} from '../shared/appearance-profile'
import { mayHydrateAppearance, type MainReady } from '../shared/project-storage'
import type { AppearanceSkinSnapshot, AppearanceReadbackAck } from '../shared/startup-contract'
export type { AppearanceSkinSnapshot, AppearanceReadbackAck } from '../shared/startup-contract'
export interface AppearanceBootstrapDependencies {
  /** Main's real startup coordinator. Renderer fallback must never manufacture ready. */
  waitForMainReady(): Promise<MainReady>
  readSkinSnapshot(ready: Extract<MainReady, { state: 'ready' }>): Promise<AppearanceSkinSnapshot>
  /** Main validates sender/origin and generation, then records this read-back acknowledgement. */
  acknowledgeReadback(ack: AppearanceReadbackAck): Promise<boolean>
  storage?: () => Pick<Storage, 'getItem' | 'setItem'>
  systemTheme?: () => 'light' | 'dark'
}
export interface AppearanceBootstrapState {
  phase: 'pending' | 'migrated' | 'blocked'
  profile: Readonly<CanonicalAppearanceProfile> | null
  snapshot: Readonly<AppearanceSkinSnapshot> | null
  resolvedShell: Shell
  notice: string | null
  failureCode: string | null
  bootstrap(dependencies: AppearanceBootstrapDependencies): Promise<boolean>
  update(patch: AppearancePatch): boolean
}

/** One writer per renderer. Importing the module performs no storage read or write. */
export function createAppearanceStore(releaseDefault: Shell = RELEASE_DEFAULT_SHELL) {
  let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null
  let acknowledgedRaw: string | null = null
  let inFlight: Promise<boolean> | null = null
  return create<AppearanceBootstrapState>()((set, get) => {
    const block = (error: unknown) => {
      set({ phase: 'blocked', resolvedShell: 'classic',
        notice: '外观偏好尚未安全加载或保存，已保留原设置。请重试；当前使用经典界面。',
        failureCode: error instanceof AppearanceProfileError ? error.code : 'APPEARANCE_STORAGE_OR_MAIN_FAILED' })
      return false
    }
    return {
      phase: 'pending', profile: null, snapshot: null, resolvedShell: 'classic', notice: null, failureCode: null,
      bootstrap(dependencies) {
        if (inFlight) return inFlight
        if (get().phase === 'migrated') return Promise.resolve(true)
        const run = async () => {
          set({ phase: 'pending', notice: null, failureCode: null })
          try {
            const ready = await dependencies.waitForMainReady()
            if (ready.state !== 'ready' || typeof ready.globalGeneration !== 'string' || !mayHydrateAppearance(ready)) throw new AppearanceProfileError('MAIN_NOT_READY')
            const skin = await dependencies.readSkinSnapshot(ready)
            if (skin.globalGeneration !== ready.globalGeneration || skin.skinRevision !== ready.skinRevision
              || !['classic', 'anime', 'custom'].includes(skin.backgroundSkin)) throw new AppearanceProfileError('SKIN_SNAPSHOT_NOT_READY')
            storage = (dependencies.storage ?? (() => window.localStorage))()
            const existing = storage.getItem(APPEARANCE_STORAGE_KEY)
            const profile = existing === null
              ? migrateLegacyAppearance(storage.getItem(LEGACY_THEME_STORAGE_KEY), storage.getItem(LEGACY_UI_STORAGE_KEY),
                (dependencies.systemTheme ?? (() => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))())
              : parseAppearanceProfile(existing)
            const serialized = existing ?? JSON.stringify(profile)
            if (existing === null) storage.setItem(APPEARANCE_STORAGE_KEY, serialized)
            if (storage.getItem(APPEARANCE_STORAGE_KEY) !== serialized) throw new AppearanceProfileError('APPEARANCE_READBACK_FAILED')
            const accepted = await dependencies.acknowledgeReadback({ storageKey: APPEARANCE_STORAGE_KEY,
              profileRevision: profile.revision, globalGeneration: skin.globalGeneration, skinRevision: skin.skinRevision })
            if (accepted !== true) throw new AppearanceProfileError('MAIN_ACK_REJECTED')
            if (storage.getItem(APPEARANCE_STORAGE_KEY) !== serialized) throw new AppearanceProfileError('APPEARANCE_CHANGED_DURING_ACK')
            acknowledgedRaw = serialized
            set({ phase: 'migrated', profile: Object.freeze(profile), snapshot: Object.freeze({ ...skin }),
              resolvedShell: resolveShell(profile.shellPreference, releaseDefault), notice: null, failureCode: null })
            return true
          } catch (error) { return block(error) }
        }
        inFlight = run().finally(() => { inFlight = null })
        return inFlight
      },
      update(patch) {
        const current = get()
        if (current.phase !== 'migrated' || !current.profile || !storage || !acknowledgedRaw) return false
        try {
          if (storage.getItem(APPEARANCE_STORAGE_KEY) !== acknowledgedRaw) throw new AppearanceProfileError('APPEARANCE_CHANGED_EXTERNALLY')
          const next = parseAppearanceProfile(JSON.stringify({ ...current.profile, ...patch,
            revision: current.profile.revision + 1, origin: 'author' }))
          const serialized = JSON.stringify(next)
          storage.setItem(APPEARANCE_STORAGE_KEY, serialized)
          if (storage.getItem(APPEARANCE_STORAGE_KEY) !== serialized) throw new AppearanceProfileError('APPEARANCE_READBACK_FAILED')
          acknowledgedRaw = serialized
          set({ profile: Object.freeze(next), resolvedShell: resolveShell(next.shellPreference, releaseDefault), notice: null, failureCode: null })
          return true
        } catch (error) { return block(error) }
      },
    }
  })
}

export const useAppearanceStore = createAppearanceStore()
export type AppearanceStore = ReturnType<typeof createAppearanceStore>
export { INITIAL_APPEARANCE }
