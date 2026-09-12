import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppearanceStore, type AppearanceBootstrapDependencies } from '../appearance-bootstrap'
import { createThemeStore } from '../theme-store'
import { createUiVersionStore } from '../ui-version-store'
import { APPEARANCE_STORAGE_KEY as KEY, LEGACY_THEME_STORAGE_KEY as THEME, LEGACY_UI_STORAGE_KEY as SHELL } from '../../shared/appearance-profile'

/** Real Chromium localStorage/DOM, deterministic main transport contract fixtures only. */
function dependencies(overrides: Partial<AppearanceBootstrapDependencies> = {}): AppearanceBootstrapDependencies {
  return {
    waitForMainReady: async () => ({ state: 'ready', globalGeneration: 'synthetic-main-generation', skinRevision: 7 }),
    readSkinSnapshot: async () => ({ globalGeneration: 'synthetic-main-generation', skinRevision: 7, backgroundSkin: 'classic' }),
    acknowledgeReadback: async () => true,
    ...overrides,
  }
}
const seed = (theme = 'paper') => {
  const raw = JSON.stringify({ state: { theme, zoom: 1.25, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', fontDefaultsVersion: 0 }, version: 1 })
  localStorage.setItem(THEME, raw)
  return raw
}
beforeEach(() => { for (const key of [KEY, THEME, SHELL, 'f01-unrelated']) localStorage.removeItem(key) })
afterEach(() => { vi.restoreAllMocks(); for (const key of [KEY, THEME, SHELL, 'f01-unrelated']) localStorage.removeItem(key) })

describe('appearance bootstrap in real browser storage', () => {
  it('waits for main, then writes once and readback-acks before projecting theme and shell', async () => {
    const original = seed('dark')
    localStorage.setItem(SHELL, 'v2')
    const store = createAppearanceStore()
    const theme = createThemeStore(store)
    const shell = createUiVersionStore(store)
    let release!: (value: Awaited<ReturnType<AppearanceBootstrapDependencies['waitForMainReady']>>) => void
    const ready = new Promise<Awaited<ReturnType<AppearanceBootstrapDependencies['waitForMainReady']>>>(resolve => { release = resolve })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const ack = vi.fn(async () => {
      expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ shellPreference: 'writer', colorTheme: 'dark' })
      expect(store.getState().phase).toBe('pending')
      return true
    })
    const dep = dependencies({ waitForMainReady: () => ready, acknowledgeReadback: ack })
    const pending = store.getState().bootstrap(dep)
    expect(store.getState().bootstrap(dep)).toBe(pending)
    theme.getState().setTheme('light')
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(shell.getState().uiVersion).toBe('v1')
    release({ state: 'ready', globalGeneration: 'synthetic-main-generation', skinRevision: 7 })
    expect(await pending).toBe(true)
    expect(setItem.mock.calls.filter(([key]) => key === KEY)).toHaveLength(1)
    expect(ack).toHaveBeenCalledOnce()
    expect(store.getState().phase).toBe('migrated')
    expect(shell.getState().uiVersion).toBe('v2')
    expect(theme.getState()).toMatchObject({ theme: 'dark', zoom: 1.25, writingFont: 'lxgw-wenkai' })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--font-writing')).toContain('LXGW WenKai')
    expect(localStorage.getItem(THEME)).toBe(original)
    expect(localStorage.getItem(SHELL)).toBe('v2')
  })

  it('keeps unset separate from default activation and keeps main classic background independent', async () => {
    const development = createAppearanceStore('classic')
    await development.getState().bootstrap(dependencies())
    const saved = localStorage.getItem(KEY)
    const activated = createAppearanceStore('writer')
    expect(await activated.getState().bootstrap(dependencies())).toBe(true)
    expect(activated.getState().resolvedShell).toBe('writer')
    expect(activated.getState().profile?.shellPreference).toBe('unset')
    expect(activated.getState().snapshot?.backgroundSkin).toBe('classic')
    expect(localStorage.getItem(KEY)).toBe(saved)
    expect(saved).not.toContain('backgroundSkin')
    activated.getState().update({ shellPreference: 'classic' })
    const reopened = createAppearanceStore('writer')
    await reopened.getState().bootstrap(dependencies())
    expect(reopened.getState().resolvedShell).toBe('classic')
  })

  it('exits both legacy writers; theme/fonts/zoom and shell write one canonical profile', async () => {
    const legacy = seed()
    localStorage.setItem(SHELL, 'v1')
    const store = createAppearanceStore()
    const theme = createThemeStore(store)
    const shell = createUiVersionStore(store)
    await store.getState().bootstrap(dependencies())
    theme.getState().setTheme('galaxy')
    theme.getState().setWritingFont('noto-serif-sc')
    theme.getState().setUiFont('inter')
    theme.getState().zoomIn()
    shell.getState().setUiVersion('v2')
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ colorTheme: 'galaxy', writingFont: 'noto-serif-sc', uiFont: 'inter', zoom: 1.3, shellPreference: 'writer' })
    expect(localStorage.getItem(THEME)).toBe(legacy)
    expect(localStorage.getItem(SHELL)).toBe('v1')
  })

  it.each(['legacy-json', 'canonical-json', 'unknown-shell'] as const)('preserves %s and blocks without writing defaults', async kind => {
    seed()
    if (kind === 'legacy-json') localStorage.setItem(THEME, '{broken')
    if (kind === 'canonical-json') localStorage.setItem(KEY, '{broken')
    if (kind === 'unknown-shell') localStorage.setItem(SHELL, 'future-shell')
    const before = [localStorage.getItem(KEY), localStorage.getItem(THEME), localStorage.getItem(SHELL)]
    localStorage.setItem('f01-unrelated', '不变')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const store = createAppearanceStore()
    expect(await store.getState().bootstrap(dependencies())).toBe(false)
    expect(store.getState()).toMatchObject({ phase: 'blocked', resolvedShell: 'classic' })
    expect(store.getState().notice).toContain('保留原设置')
    expect(setItem).not.toHaveBeenCalled()
    expect([localStorage.getItem(KEY), localStorage.getItem(THEME), localStorage.getItem(SHELL)]).toEqual(before)
    expect(localStorage.getItem('f01-unrelated')).toBe('不变')
  })

  it.each(['pending', 'main-failure', 'skin-failure', 'skin-revision'] as const)('refuses %s before any storage mutation', async kind => {
    const before = seed()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const dep = dependencies()
    if (kind === 'pending') dep.waitForMainReady = async () => ({ state: 'pending' })
    if (kind === 'main-failure') dep.waitForMainReady = async () => { throw new Error('fixture main failure') }
    if (kind === 'skin-failure') dep.readSkinSnapshot = async () => { throw new Error('fixture skin failure') }
    if (kind === 'skin-revision') dep.readSkinSnapshot = async () => ({ globalGeneration: 'synthetic-main-generation', skinRevision: 8, backgroundSkin: 'classic' })
    expect(await createAppearanceStore().getState().bootstrap(dep)).toBe(false)
    expect(setItem).not.toHaveBeenCalled()
    expect(localStorage.getItem(THEME)).toBe(before)
  })

  it('handles unavailable storage without changing original keys', async () => {
    const before = seed()
    const store = createAppearanceStore()
    expect(await store.getState().bootstrap(dependencies({ storage: () => { throw new DOMException('fixture unavailable', 'SecurityError') } }))).toBe(false)
    expect(localStorage.getItem(THEME)).toBe(before)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it.each(['before-write', 'after-write', 'ack'] as const)('recovers %s interruption without rewriting a durable canonical record', async fault => {
    const original = seed('dark')
    let writes = 0
    const storage = {
      getItem: (key: string) => localStorage.getItem(key),
      setItem: (key: string, value: string) => {
        writes++
        if (fault === 'before-write') throw new Error('fixture crash before write')
        localStorage.setItem(key, value)
        if (fault === 'after-write') throw new Error('fixture crash after write')
      },
    }
    const interrupted = createAppearanceStore()
    expect(await interrupted.getState().bootstrap(dependencies({ storage: () => storage, acknowledgeReadback: async () => false }))).toBe(false)
    expect(localStorage.getItem(THEME)).toBe(original)
    const durable = localStorage.getItem(KEY)
    if (fault !== 'before-write') seed('light') // A later legacy write must not overwrite the committed profile.
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const reopened = createAppearanceStore()
    expect(await reopened.getState().bootstrap(dependencies())).toBe(true)
    expect(reopened.getState().profile?.colorTheme).toBe('dark')
    expect(setItem.mock.calls.filter(([key]) => key === KEY)).toHaveLength(fault === 'before-write' ? 1 : 0)
    if (durable) expect(localStorage.getItem(KEY)).toBe(durable)
    expect(writes).toBe(1)
  })

  it('refuses a changed readback during main acknowledgement, retaining the actual stored value', async () => {
    seed()
    const store = createAppearanceStore()
    expect(await store.getState().bootstrap(dependencies({ acknowledgeReadback: async () => {
      const profile = JSON.parse(localStorage.getItem(KEY)!)
      localStorage.setItem(KEY, JSON.stringify({ ...profile, revision: profile.revision + 1, colorTheme: 'dark' }))
      return true
    } }))).toBe(false)
    expect(store.getState().failureCode).toBe('APPEARANCE_CHANGED_DURING_ACK')
    expect(JSON.parse(localStorage.getItem(KEY)!).colorTheme).toBe('dark')
  })

  it('keeps failed user-save content and blocks subsequent legacy or default writes', async () => {
    seed('paper')
    const store = createAppearanceStore()
    await store.getState().bootstrap(dependencies())
    const original = localStorage.getItem(KEY)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('fixture quota', 'QuotaExceededError') })
    expect(store.getState().update({ colorTheme: 'dark' })).toBe(false)
    expect(store.getState().profile?.colorTheme).toBe('paper')
    expect(store.getState().phase).toBe('blocked')
    expect(localStorage.getItem(KEY)).toBe(original)
    expect(store.getState().update({ shellPreference: 'writer' })).toBe(false)
  })
})
