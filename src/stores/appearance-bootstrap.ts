import { create } from 'zustand'
import { useLocaleStore } from './locale-store'
import {
  APPEARANCE_STORAGE_KEY, INITIAL_APPEARANCE, LEGACY_THEME_STORAGE_KEY, PREVIOUS_APPEARANCE_STORAGE_KEY,
  AppearanceProfileError, migrateLegacyAppearance, migratePreviousAppearance, parseAppearanceProfile, serializeAppearanceProfile,
  type AppearancePatch, type CanonicalAppearanceProfile, type ColorTheme,
} from '../shared/appearance-profile'
import { mayHydrateAppearance, type MainReady } from '../shared/project-storage'
import type { AppearanceReadbackAck } from '../shared/startup-contract'
export type { AppearanceReadbackAck } from '../shared/startup-contract'
export interface AppearanceBootstrapDependencies {
  /** Main's real startup coordinator. Renderer fallback must never manufacture ready. */
  waitForMainReady(): Promise<MainReady>
  /** Main validates sender/origin and generation, then records this read-back acknowledgement. */
  acknowledgeReadback(ack: AppearanceReadbackAck): Promise<boolean>
  storage?: () => Pick<Storage, 'getItem' | 'setItem'>
  systemTheme?: () => ColorTheme
}
export interface AppearanceBootstrapState {
  phase: 'pending' | 'migrated' | 'blocked'
  profile: Readonly<CanonicalAppearanceProfile> | null
  notice: string | null
  failureCode: string | null
  bootstrap(dependencies: AppearanceBootstrapDependencies): Promise<boolean>
  update(patch: AppearancePatch): boolean
  resetAppearance(): boolean
}

/**
 * 读出这台机器上的外观偏好：已有 v3 就用它；没有时依次从 RD-10 之前的配置、更早的主题键迁移，都没有就用初始偏好。
 * 旧键只读，回退到旧版本时它们原样还在。
 */
function readOrMigrate(storage: Pick<Storage, 'getItem'>, systemTheme: () => ColorTheme): { profile: CanonicalAppearanceProfile; stored: string | null } {
  const stored = storage.getItem(APPEARANCE_STORAGE_KEY)
  if (stored !== null) return { profile: parseAppearanceProfile(stored), stored }
  const previous = storage.getItem(PREVIOUS_APPEARANCE_STORAGE_KEY)
  if (previous !== null) return { profile: migratePreviousAppearance(previous), stored }
  return { profile: migrateLegacyAppearance(storage.getItem(LEGACY_THEME_STORAGE_KEY), systemTheme()), stored }
}

/** One writer per renderer. Importing the module performs no storage read or write. */
export function createAppearanceStore() {
  let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null
  let acknowledgedRaw: string | null = null
  let inFlight: Promise<boolean> | null = null
  return create<AppearanceBootstrapState>()((set, get) => {
    const block = (error: unknown) => {
      set({ phase: 'blocked',
        notice: get().profile
          ? useLocaleStore.getState().text('外观偏好尚未安全保存，已保留原设置。请重试；当前工作台保持原状。', 'Appearance preferences could not be saved safely. Your previous settings and workspace are preserved. Please try again.')
          : useLocaleStore.getState().text('外观偏好尚未安全加载，已保留原设置。请重试；工作台尚未加载。', 'Appearance preferences could not be loaded safely. Your previous settings are preserved. Please try again before opening the workspace.'),
        failureCode: error instanceof AppearanceProfileError ? error.code : 'APPEARANCE_STORAGE_OR_MAIN_FAILED' })
      return false
    }
    return {
      phase: 'pending', profile: null, notice: null, failureCode: null,
      bootstrap(dependencies) {
        if (inFlight) return inFlight
        if (get().phase === 'migrated') return Promise.resolve(true)
        const run = async () => {
          set({ phase: 'pending', notice: null, failureCode: null })
          try {
            const ready = await dependencies.waitForMainReady()
            if (!mayHydrateAppearance(ready)) throw new AppearanceProfileError('MAIN_NOT_READY')
            storage = (dependencies.storage ?? (() => window.localStorage))()
            const { profile, stored } = readOrMigrate(storage,
              dependencies.systemTheme ?? (() => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
            const serialized = stored ?? serializeAppearanceProfile(profile)
            if (stored === null) storage.setItem(APPEARANCE_STORAGE_KEY, serialized)
            if (storage.getItem(APPEARANCE_STORAGE_KEY) !== serialized) throw new AppearanceProfileError('APPEARANCE_READBACK_FAILED')
            const accepted = await dependencies.acknowledgeReadback({ storageKey: APPEARANCE_STORAGE_KEY,
              profileRevision: profile.revision, globalGeneration: ready.globalGeneration })
            if (accepted !== true) throw new AppearanceProfileError('MAIN_ACK_REJECTED')
            acknowledgedRaw = serialized
            if (storage.getItem(APPEARANCE_STORAGE_KEY) !== serialized) throw new AppearanceProfileError('APPEARANCE_CHANGED_DURING_ACK')
            set({ phase: 'migrated', profile: Object.freeze(profile), notice: null, failureCode: null })
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
          const serialized = serializeAppearanceProfile({ ...current.profile, ...patch, revision: current.profile.revision + 1, origin: 'author' })
          const next = parseAppearanceProfile(serialized)
          storage.setItem(APPEARANCE_STORAGE_KEY, serialized)
          if (storage.getItem(APPEARANCE_STORAGE_KEY) !== serialized) throw new AppearanceProfileError('APPEARANCE_READBACK_FAILED')
          acknowledgedRaw = serialized
          set({ profile: Object.freeze(next), notice: null, failureCode: null })
          return true
        } catch (error) { return block(error) }
      },
      resetAppearance() {
        try {
          const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage)
          if (!target) return false
          let revision = Math.max(get().profile?.revision ?? 0, acknowledgedRaw ? parseAppearanceProfile(acknowledgedRaw).revision : 0)
          const existing = target.getItem(APPEARANCE_STORAGE_KEY)
          if (existing !== null) {
            try { revision = Math.max(revision, parseAppearanceProfile(existing).revision) }
            catch (error) { if (!(error instanceof AppearanceProfileError)) throw error }
          }
          const serialized = serializeAppearanceProfile({ ...INITIAL_APPEARANCE, revision: revision + 1, origin: 'author' })
          target.setItem(APPEARANCE_STORAGE_KEY, serialized)
          if (target.getItem(APPEARANCE_STORAGE_KEY) !== serialized) throw new AppearanceProfileError('APPEARANCE_READBACK_FAILED')
          set({ phase: 'pending', profile: null, notice: null, failureCode: null })
          return true
        } catch { return false }
      },
    }
  })
}

export const useAppearanceStore = createAppearanceStore()
export type AppearanceStore = ReturnType<typeof createAppearanceStore>
export { INITIAL_APPEARANCE }
