import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppearanceStore, type AppearanceBootstrapDependencies } from '../appearance-bootstrap'
import { createThemeStore } from '../theme-store'
import {
  APPEARANCE_STORAGE_KEY as KEY, LEGACY_THEME_STORAGE_KEY as THEME, PREVIOUS_APPEARANCE_STORAGE_KEY as PREVIOUS,
} from '../../shared/appearance-profile'
import { registerStartupController, type StartupEvent } from '../../../electron/controllers/startup-controller'
import type { AppearanceReadbackAck, StartupState } from '../../shared/startup-contract'
import { parseAppearanceProfileV1 } from '../../shared/__tests__/fixtures/appearance-profile-v1-parser.fixture'

/** 旧版本单独存的界面版本键：迁移不读也不写，只用来确认它原样留着。 */
const OLD_SHELL = 'ai-novel-writer-ui-version'
const KEYS = [KEY, PREVIOUS, THEME, OLD_SHELL, 'f01-unrelated']

/** Real Chromium localStorage/DOM, deterministic main transport contract fixtures only. */
function dependencies(overrides: Partial<AppearanceBootstrapDependencies> = {}): AppearanceBootstrapDependencies {
  return {
    waitForMainReady: async () => ({ state: 'ready', globalGeneration: 'synthetic-main-generation' }),
    acknowledgeReadback: async () => true,
    ...overrides,
  }
}
const seedLegacy = (theme = 'paper') => {
  const raw = JSON.stringify({ state: { theme, zoom: 1.25, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', fontDefaultsVersion: 0 }, version: 1 })
  localStorage.setItem(THEME, raw)
  return raw
}
/** RD-10 之前的版本写下的配置：v1 带工作台外壳，v2 带新外壳。 */
const seedPrevious = (fields: Record<string, unknown> = {}) => {
  const raw = JSON.stringify({ schemaVersion: 1, revision: 5, shellPreference: 'writer', colorTheme: 'galaxy', zoom: 1.1,
    writingFont: 'noto-serif-sc', uiFont: 'inter', origin: 'author', legacyImportCompleted: true, legacyFontDefaultsVersion: 1, ...fields })
  localStorage.setItem(PREVIOUS, raw)
  return raw
}
beforeEach(() => { for (const key of KEYS) localStorage.removeItem(key) })
afterEach(() => { vi.restoreAllMocks(); for (const key of KEYS) localStorage.removeItem(key) })

describe('appearance bootstrap in real browser storage', () => {
  it('waits for main, then writes v3 once and readback-acks before projecting the theme', async () => {
    const original = seedLegacy('dark')
    localStorage.setItem(OLD_SHELL, 'v2')
    const store = createAppearanceStore()
    const theme = createThemeStore(store)
    let release!: (value: Awaited<ReturnType<AppearanceBootstrapDependencies['waitForMainReady']>>) => void
    const ready = new Promise<Awaited<ReturnType<AppearanceBootstrapDependencies['waitForMainReady']>>>(resolve => { release = resolve })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const ack = vi.fn(async () => {
      expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ schemaVersion: 3, colorTheme: 'dark' })
      expect(store.getState().phase).toBe('pending')
      return true
    })
    const dep = dependencies({ waitForMainReady: () => ready, acknowledgeReadback: ack })
    const pending = store.getState().bootstrap(dep)
    expect(store.getState().bootstrap(dep)).toBe(pending)
    theme.getState().setTheme('light')
    expect(localStorage.getItem(KEY)).toBeNull()
    release({ state: 'ready', globalGeneration: 'synthetic-main-generation' })
    expect(await pending).toBe(true)
    expect(setItem.mock.calls.filter(([key]) => key === KEY)).toHaveLength(1)
    expect(ack).toHaveBeenCalledWith({ storageKey: KEY, profileRevision: 1, globalGeneration: 'synthetic-main-generation' })
    expect(store.getState().phase).toBe('migrated')
    expect(theme.getState()).toMatchObject({ theme: 'dark', zoom: 1.25, writingFont: 'lxgw-wenkai' })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--font-writing')).toContain('LXGW WenKai')
    expect(localStorage.getItem(THEME)).toBe(original)
    expect(localStorage.getItem(OLD_SHELL)).toBe('v2')
  })

  it.each([
    [1, 'writer', 'light', 'light'],
    [1, 'classic', 'paper', 'light'],
    [1, 'unset', 'dark', 'dark'],
    [2, 'stage', 'galaxy', 'dark'],
  ] as const)('RD-10 之前的 v%s 配置（外壳 %s、主题 %s）迁成 %s 的 v3，旧键一个字节都不改，旧版本照样能读', async (schemaVersion, shellPreference, colorTheme, expected) => {
    const previous = seedPrevious({ schemaVersion, shellPreference, colorTheme })
    const store = createAppearanceStore()
    const ack = vi.fn(async () => true)
    expect(await store.getState().bootstrap(dependencies({ acknowledgeReadback: ack }))).toBe(true)
    createThemeStore(store)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ schemaVersion: 3, revision: 5, colorTheme: expected, zoom: 1.1,
      writingFont: 'noto-serif-sc', uiFont: 'inter', origin: 'author', legacyImportCompleted: true, legacyFontDefaultsVersion: 1 })
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ profileRevision: 5 }))
    expect(document.documentElement.classList.contains('dark')).toBe(expected === 'dark')
    expect(localStorage.getItem(PREVIOUS)).toBe(previous)
    if (schemaVersion === 1) expect(parseAppearanceProfileV1(previous)).toEqual(JSON.parse(previous))
  })

  it('已有 v3 时启动不写存储，回执用原 revision；改主题、字体与缩放只写 v3，旧键都不动', async () => {
    const previous = seedPrevious()
    const legacy = seedLegacy()
    const raw = JSON.stringify({ schemaVersion: 3, revision: 9, colorTheme: 'dark', zoom: 1, writingFont: 'lxgw-wenkai',
      uiFont: 'noto-sans-sc', origin: 'author', legacyImportCompleted: true })
    localStorage.setItem(KEY, raw)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const ack = vi.fn(async () => true)
    const store = createAppearanceStore()
    const theme = createThemeStore(store)
    expect(await store.getState().bootstrap(dependencies({ acknowledgeReadback: ack }))).toBe(true)
    expect(setItem.mock.calls.filter(([key]) => key === KEY)).toEqual([])
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ profileRevision: 9 }))
    theme.getState().setTheme('light')
    theme.getState().setWritingFont('noto-serif-sc')
    theme.getState().setUiFont('inter')
    theme.getState().zoomIn()
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ schemaVersion: 3, revision: 13, colorTheme: 'light',
      writingFont: 'noto-serif-sc', uiFont: 'inter', zoom: 1.05, origin: 'author' })
    expect(setItem.mock.calls.every(([key]) => key === KEY)).toBe(true)
    expect(localStorage.getItem(PREVIOUS)).toBe(previous)
    expect(localStorage.getItem(THEME)).toBe(legacy)
  })

  it.each(['已确认', '存储里更新'] as const)('%s的配置重置后写成初始的浅色 v3，revision 递增，旧键不动', async source => {
    const previous = seedPrevious()
    const store = createAppearanceStore()
    await store.getState().bootstrap(dependencies())
    expect(store.getState().update({ colorTheme: 'dark' })).toBe(true)
    let revision = store.getState().profile!.revision
    if (source === '存储里更新') {
      localStorage.setItem(KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(KEY)!), revision: revision + 5 }))
      revision += 5
    }
    expect(store.getState().resetAppearance()).toBe(true)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ schemaVersion: 3, colorTheme: 'light', revision: revision + 1, origin: 'author' })
    expect(localStorage.getItem(PREVIOUS)).toBe(previous)
    expect(await store.getState().bootstrap(dependencies())).toBe(true)
    expect(store.getState()).toMatchObject({ phase: 'migrated' })
  })

  it('同一窗口确认过较新的外观后重载、存储被写坏：受阻页重置外观偏好后主进程接受，工作台能打开', async () => {
    const handlers = new Map<string, (event: StartupEvent, input?: unknown) => unknown>()
    const sender = { id: 7, mainFrame: { url: 'file:///app/index.html' }, isDestroyed: () => false }
    const event = { sender, senderFrame: sender.mainFrame }
    registerStartupController({ ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } },
      getTrustedSender: () => sender, rendererUrl: 'file:///app/index.html',
      getGlobalGeneration: () => 'synthetic-main-generation', getBlockedCode: () => undefined })
    const main: AppearanceBootstrapDependencies = {
      waitForMainReady: async () => handlers.get('startup:get-state')!(event) as StartupState,
      acknowledgeReadback: async (ack: AppearanceReadbackAck) => handlers.get('startup:appearance-ack')!(event, ack) as boolean,
    }
    localStorage.setItem(KEY, JSON.stringify({ schemaVersion: 3, revision: 9, colorTheme: 'dark', zoom: 1, writingFont: 'lxgw-wenkai',
      uiFont: 'noto-sans-sc', origin: 'author', legacyImportCompleted: true }))
    expect(await createAppearanceStore().getState().bootstrap(main)).toBe(true)

    localStorage.setItem(KEY, '{broken')
    const reloaded = createAppearanceStore()
    expect(await reloaded.getState().bootstrap(main)).toBe(false)
    expect(reloaded.getState().resetAppearance()).toBe(true)
    expect(await reloaded.getState().bootstrap(main)).toBe(true)
    expect(reloaded.getState()).toMatchObject({ phase: 'migrated', profile: { colorTheme: 'light', revision: 10 } })
  })

  it.each(['legacy-json', 'previous-json', 'previous-stage-in-v1', 'canonical-json', 'canonical-shell'] as const)('preserves %s and blocks without writing defaults', async kind => {
    seedLegacy()
    if (kind === 'legacy-json') localStorage.setItem(THEME, '{broken')
    if (kind === 'previous-json') localStorage.setItem(PREVIOUS, '{broken')
    if (kind === 'previous-stage-in-v1') seedPrevious({ schemaVersion: 1, shellPreference: 'stage' })
    if (kind === 'canonical-json') localStorage.setItem(KEY, '{broken')
    if (kind === 'canonical-shell') localStorage.setItem(KEY, JSON.stringify({ schemaVersion: 3, revision: 2, shellPreference: 'stage', colorTheme: 'light',
      zoom: 1, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', origin: 'author', legacyImportCompleted: true }))
    const before = [localStorage.getItem(KEY), localStorage.getItem(PREVIOUS), localStorage.getItem(THEME)]
    localStorage.setItem('f01-unrelated', '不变')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const store = createAppearanceStore()
    expect(await store.getState().bootstrap(dependencies())).toBe(false)
    expect(store.getState()).toMatchObject({ phase: 'blocked', profile: null })
    expect(store.getState().notice).toContain('保留原设置')
    expect(setItem).not.toHaveBeenCalled()
    expect([localStorage.getItem(KEY), localStorage.getItem(PREVIOUS), localStorage.getItem(THEME)]).toEqual(before)
    expect(localStorage.getItem('f01-unrelated')).toBe('不变')
  })

  it.each(['pending', 'main-failure', 'empty-generation'] as const)('refuses %s before any storage mutation', async kind => {
    const before = seedLegacy()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const dep = dependencies()
    if (kind === 'pending') dep.waitForMainReady = async () => ({ state: 'pending' })
    if (kind === 'main-failure') dep.waitForMainReady = async () => { throw new Error('fixture main failure') }
    if (kind === 'empty-generation') dep.waitForMainReady = async () => ({ state: 'ready', globalGeneration: '' })
    expect(await createAppearanceStore().getState().bootstrap(dep)).toBe(false)
    expect(setItem).not.toHaveBeenCalled()
    expect(localStorage.getItem(THEME)).toBe(before)
  })

  it('handles unavailable storage without changing original keys', async () => {
    const before = seedLegacy()
    const store = createAppearanceStore()
    expect(await store.getState().bootstrap(dependencies({ storage: () => { throw new DOMException('fixture unavailable', 'SecurityError') } }))).toBe(false)
    expect(localStorage.getItem(THEME)).toBe(before)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it.each([
    ['main-not-ready', 'MAIN_NOT_READY'],
    ['readback', 'APPEARANCE_READBACK_FAILED'],
    ['ack', 'MAIN_ACK_REJECTED'],
    ['changed-during-ack', 'APPEARANCE_CHANGED_DURING_ACK'],
  ])('keeps %s blocked after an explicit appearance reset', async (fault, failureCode) => {
    localStorage.setItem(THEME, JSON.stringify({ state: { writingFont: 'retired-font' } }))
    const store = createAppearanceStore()
    expect(await store.getState().bootstrap(dependencies())).toBe(false)
    expect(store.getState().resetAppearance()).toBe(true)
    const dep = dependencies()
    if (fault === 'main-not-ready') dep.waitForMainReady = async () => ({ state: 'pending' })
    if (fault === 'readback') {
      let reads = 0
      dep.storage = () => ({ getItem: key => ++reads === 2 ? null : localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) })
    }
    if (fault === 'ack') dep.acknowledgeReadback = async () => false
    if (fault === 'changed-during-ack') dep.acknowledgeReadback = async () => { localStorage.setItem(KEY, '{changed'); return true }
    expect(await store.getState().bootstrap(dep)).toBe(false)
    expect(store.getState()).toMatchObject({ phase: 'blocked', profile: null, failureCode })
  })

  it.each(['before-write', 'after-write', 'ack'] as const)('recovers %s interruption without rewriting a durable canonical record', async fault => {
    const original = seedLegacy('dark')
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
    if (fault !== 'before-write') seedLegacy('light') // A later legacy write must not overwrite the committed profile.
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const reopened = createAppearanceStore()
    expect(await reopened.getState().bootstrap(dependencies())).toBe(true)
    expect(reopened.getState().profile?.colorTheme).toBe('dark')
    expect(setItem.mock.calls.filter(([key]) => key === KEY)).toHaveLength(fault === 'before-write' ? 1 : 0)
    if (durable) expect(localStorage.getItem(KEY)).toBe(durable)
    expect(writes).toBe(1)
  })

  it('refuses a changed readback during main acknowledgement, retaining the actual stored value', async () => {
    seedLegacy()
    const store = createAppearanceStore()
    expect(await store.getState().bootstrap(dependencies({ acknowledgeReadback: async () => {
      const profile = JSON.parse(localStorage.getItem(KEY)!)
      localStorage.setItem(KEY, JSON.stringify({ ...profile, revision: profile.revision + 1, colorTheme: 'dark' }))
      return true
    } }))).toBe(false)
    expect(store.getState().failureCode).toBe('APPEARANCE_CHANGED_DURING_ACK')
    const changed = localStorage.getItem(KEY)
    expect(store.getState().update({ colorTheme: 'light' })).toBe(false)
    expect(localStorage.getItem(KEY)).toBe(changed)
    expect(JSON.parse(localStorage.getItem(KEY)!).colorTheme).toBe('dark')
  })

  it('keeps failed user-save content and blocks subsequent writes', async () => {
    seedLegacy('paper')
    const store = createAppearanceStore()
    await store.getState().bootstrap(dependencies())
    const original = localStorage.getItem(KEY)
    const profile = store.getState().profile
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('fixture quota', 'QuotaExceededError') })
    expect(store.getState().update({ colorTheme: 'dark' })).toBe(false)
    expect(store.getState()).toMatchObject({ phase: 'blocked', profile })
    expect(store.getState().notice).toContain('当前工作台保持原状')
    expect(localStorage.getItem(KEY)).toBe(original)
    expect(store.getState().update({ zoom: 1.2 })).toBe(false)
  })
})
