import { create } from 'zustand'
import { useAppearanceStore, type AppearanceStore } from './appearance-bootstrap'
import { LEGACY_UI_STORAGE_KEY } from '../shared/appearance-profile'

/** Compatibility projection for donor shell components; no legacy storage reader/writer. */
export type UiVersion = 'v1' | 'v2'
export const DEFAULT_UI_VERSION: UiVersion = 'v1'
export const UI_VERSION_STORAGE_KEY = LEGACY_UI_STORAGE_KEY
export interface UiVersionState {
  uiVersion: UiVersion
  setUiVersion(version: UiVersion): void
  toggleUiVersion(): void
}
export function isUiVersion(value: unknown): value is UiVersion { return value === 'v1' || value === 'v2' }
export function isV2(value: UiVersion): boolean { return value === 'v2' }

export function createUiVersionStore(appearance: AppearanceStore = useAppearanceStore) {
  const currentVersion = (): UiVersion => appearance.getState().resolvedShell === 'writer' ? 'v2' : 'v1'
  const store = create<UiVersionState>()((_set, get) => ({
    uiVersion: currentVersion(),
    setUiVersion(version) {
      if (isUiVersion(version)) appearance.getState().update({ shellPreference: version === 'v2' ? 'writer' : 'classic' })
    },
    toggleUiVersion() { get().setUiVersion(get().uiVersion === 'v2' ? 'v1' : 'v2') },
  }))
  appearance.subscribe(() => { store.setState({ uiVersion: currentVersion() }) })
  return store
}
export const useUiVersionStore = createUiVersionStore()
