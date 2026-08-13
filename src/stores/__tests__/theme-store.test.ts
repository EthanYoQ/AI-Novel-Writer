import { beforeEach, describe, expect, it, vi } from 'vitest'

class MemoryStorage {
  private data = new Map<string, string>()

  getItem(key: string) {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.data.set(key, value)
  }

  removeItem(key: string) {
    this.data.delete(key)
  }

  clear() {
    this.data.clear()
  }
}

function installDomStubs() {
  const classNames = new Set<string>()
  const styles = new Map<string, string>()

  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  })

  Object.defineProperty(globalThis, 'window', {
    value: {
      matchMedia: () => ({ matches: false }),
    },
    configurable: true,
  })

  Object.defineProperty(globalThis, 'document', {
    value: {
      documentElement: {
        classList: {
          add: (name: string) => classNames.add(name),
          remove: (...names: string[]) => names.forEach(name => classNames.delete(name)),
          contains: (name: string) => classNames.has(name),
        },
        style: {
          setProperty: (name: string, value: string) => styles.set(name, value),
        },
      },
    },
    configurable: true,
  })
}

function seedPersistedTheme(theme: string, version: number | null = 0) {
  localStorage.setItem(
    'ai-novel-writer-theme',
    JSON.stringify({
      state: {
        theme,
        zoom: 1,
        writingFont: 'lxgw-wenkai',
        uiFont: 'noto-sans-sc',
      },
      ...(version === null ? {} : { version }),
    })
  )
}

function seedPersistedState(state: Record<string, unknown>, version: number | null = 0) {
  localStorage.setItem(
    'ai-novel-writer-theme',
    JSON.stringify({ state, ...(version === null ? {} : { version }) })
  )
}

describe('theme store branding defaults', () => {
  beforeEach(() => {
    vi.resetModules()
    installDomStubs()
  })

  it('defaults to the accepted warm paper theme', async () => {
    const { useThemeStore } = await import('../theme-store')

    useThemeStore.getState().initTheme()

    expect(useThemeStore.getState().theme).toBe('paper')
    expect(useThemeStore.getState().resolvedTheme).toBe('paper')
  })

  it('uses the paper default when a historical persisted state omits the theme field', async () => {
    seedPersistedState({ zoom: 1, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc' })
    const { useThemeStore } = await import('../theme-store')

    useThemeStore.getState().initTheme()

    expect(useThemeStore.getState().theme).toBe('paper')
    expect(useThemeStore.getState().resolvedTheme).toBe('paper')
  })

  it('fails safely to the paper default when persisted JSON is corrupt', async () => {
    localStorage.setItem('ai-novel-writer-theme', '{not-json')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { useThemeStore } = await import('../theme-store')

    useThemeStore.getState().initTheme()

    expect(useThemeStore.getState().theme).toBe('paper')
    expect(useThemeStore.getState().resolvedTheme).toBe('paper')
    consoleError.mockRestore()
  })

  it('persists theme state under the AI novel writer storage key', async () => {
    const { useThemeStore } = await import('../theme-store')

    useThemeStore.getState().setTheme('dark')

    expect(localStorage.getItem('ai-novel-writer-theme')).toContain('"dark"')
    expect(localStorage.getItem('ve' + 'la-theme')).toBeNull()
  })

  it('preserves an explicitly selected dark theme when initializing', async () => {
    seedPersistedTheme('dark')
    const { useThemeStore } = await import('../theme-store')

    useThemeStore.getState().initTheme()

    expect(useThemeStore.getState().theme).toBe('dark')
    expect(useThemeStore.getState().resolvedTheme).toBe('dark')
  })

  it.each(['paper', 'galaxy'] as const)(
    'preserves a previously selected %s theme when initializing',
    async (theme) => {
      seedPersistedTheme(theme)
      const { useThemeStore } = await import('../theme-store')

      useThemeStore.getState().initTheme()

      expect(useThemeStore.getState().theme).toBe(theme)
      expect(useThemeStore.getState().resolvedTheme).toBe(theme)
    }
  )

  it('migrates the historical night theme to dark exactly once', async () => {
    seedPersistedTheme('night')
    const { useThemeStore } = await import('../theme-store')

    useThemeStore.getState().initTheme()

    expect(useThemeStore.getState().theme).toBe('dark')
    expect(useThemeStore.getState().resolvedTheme).toBe('dark')
    expect(JSON.parse(localStorage.getItem('ai-novel-writer-theme') ?? '{}')).toMatchObject({
      state: { theme: 'dark' },
      version: 1,
    })
    expect(localStorage.getItem('ai-novel-writer-theme-migrated')).toBeNull()
  })

  it('migrates an unversioned historical night theme during initialization', async () => {
    seedPersistedTheme('night', null)
    const { useThemeStore } = await import('../theme-store')

    useThemeStore.getState().initTheme()

    expect(useThemeStore.getState().theme).toBe('dark')
    expect(JSON.parse(localStorage.getItem('ai-novel-writer-theme') ?? '{}')).toMatchObject({
      state: { theme: 'dark' },
      version: 1,
    })
  })

  it('keeps theme initialization idempotent after migration', async () => {
    seedPersistedTheme('night')
    const { useThemeStore } = await import('../theme-store')

    useThemeStore.getState().initTheme()
    const firstPersistedState = localStorage.getItem('ai-novel-writer-theme')
    useThemeStore.getState().initTheme()

    expect(useThemeStore.getState().theme).toBe('dark')
    expect(useThemeStore.getState().resolvedTheme).toBe('dark')
    expect(localStorage.getItem('ai-novel-writer-theme')).toBe(firstPersistedState)
  })
})
