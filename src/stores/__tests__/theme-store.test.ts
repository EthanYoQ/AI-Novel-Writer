import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY } from '../../shared/appearance-profile'

class MemoryStorage {
  private data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
}
function installDomStubs() {
  const classes = new Set<string>()
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true })
  Object.defineProperty(globalThis, 'window', { value: { matchMedia: () => ({ matches: false }) }, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: { documentElement: {
    classList: { add: (name: string) => classes.add(name), remove: (...names: string[]) => names.forEach(name => classes.delete(name)) },
    style: { setProperty: vi.fn() },
  } }, configurable: true })
}
async function stores() {
  const { createAppearanceStore } = await import('../appearance-bootstrap')
  const { createThemeStore } = await import('../theme-store')
  const appearance = createAppearanceStore()
  const theme = createThemeStore(appearance)
  const bootstrap = () => appearance.getState().bootstrap({
    // Deterministic main handshake fixture; does not assert real desktop startup qualification.
    waitForMainReady: async () => ({ state: 'ready', globalGeneration: 'fixture-generation', skinRevision: 1 }),
    readSkinSnapshot: async () => ({ globalGeneration: 'fixture-generation', skinRevision: 1, backgroundSkin: 'classic' }),
    acknowledgeReadback: async () => true,
    storage: () => localStorage, systemTheme: () => 'light',
  })
  return { appearance, theme, bootstrap }
}
describe('theme projection through the single appearance writer', () => {
  beforeEach(() => { vi.resetModules(); installDomStubs() })
  it('does not hydrate or write defaults before main readiness', async () => {
    const { theme } = await stores()
    theme.getState().initTheme()
    theme.getState().setTheme('dark')
    expect(theme.getState().theme).toBe('paper')
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull()
  })
  it.each(['dark', 'paper', 'galaxy', 'light', 'night'])('preserves the visible %s theme and original legacy bytes', async value => {
    const raw = JSON.stringify({ state: { theme: value, zoom: 1, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc' } })
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, raw)
    const { theme, bootstrap } = await stores()
    expect(await bootstrap()).toBe(true)
    theme.getState().initTheme()
    expect(theme.getState().theme).toBe(value === 'night' ? 'dark' : value)
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBe(raw)
  })
  it('writes canonical preferences and never resumes the old writer', async () => {
    const { theme, bootstrap } = await stores()
    await bootstrap()
    theme.getState().setTheme('dark')
    theme.getState().setWritingFont('noto-serif-sc')
    theme.getState().setZoom(1.2)
    const saved = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!)
    expect(saved).toMatchObject({ colorTheme: 'dark', writingFont: 'noto-serif-sc', zoom: 1.2, shellPreference: 'unset' })
    expect(theme.getState().theme).toBe('dark')
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull()
  })
  it('blocks corrupt preference without overwriting it or resetting unrelated data', async () => {
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, '{bad-json')
    localStorage.setItem('fixture-unrelated', 'preserved')
    const { appearance, theme, bootstrap } = await stores()
    expect(await bootstrap()).toBe(false)
    theme.getState().setTheme('dark')
    expect(appearance.getState().phase).toBe('blocked')
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBe('{bad-json')
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem('fixture-unrelated')).toBe('preserved')
  })
  it('retains zoom steps, bounds, reset and both font projections', async () => {
    const { theme, bootstrap } = await stores()
    await bootstrap()
    theme.getState().zoomIn()
    expect(theme.getState().zoom).toBe(1.05)
    theme.getState().zoomOut()
    expect(theme.getState().zoom).toBe(1)
    theme.getState().setZoom(9)
    theme.getState().zoomIn()
    expect(theme.getState().zoom).toBe(1.5)
    theme.getState().setZoom(-1)
    theme.getState().zoomOut()
    expect(theme.getState().zoom).toBe(0.7)
    theme.getState().zoomReset()
    expect(theme.getState().zoom).toBe(1)
    theme.getState().setUiFont('inter')
    theme.getState().setWritingFont('system')
    expect(theme.getState()).toMatchObject({ uiFont: 'inter', writingFont: 'system' })
    expect(document.documentElement.style.setProperty).toHaveBeenCalledWith('--font-sans', expect.stringContaining('Inter'))
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!)).toMatchObject({ zoom: 1, uiFont: 'inter', writingFont: 'system' })
  })
  it('resolves legacy system theme during import without rewriting its source', async () => {
    const raw = JSON.stringify({ state: { theme: 'system' } })
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, raw)
    const { theme, bootstrap } = await stores()
    expect(await bootstrap()).toBe(true)
    expect(theme.getState().resolvedTheme).toBe('light')
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBe(raw)
  })
})
