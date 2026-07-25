import { beforeEach, describe, expect, it, vi } from 'vitest'

const configUtils = vi.hoisted(() => ({
  tryReadJsonFile: vi.fn(),
  writeJsonFile: vi.fn(),
  GLOBAL_CONFIG_PATH: 'C:/Users/test/.vela/config.json',
  DEFAULT_GLOBAL_CONFIG: {
    theme: 'dark',
    defaultModelId: null,
    editorFontSize: 16,
    editorFontFamily: 'Noto Serif SC',
    autoSaveInterval: 30,
  },
}))

vi.mock('../../utils/config-utils', () => configUtils)

import { GlobalConfigUpdatePreferencesStore } from '../update-preferences-store'

describe('GlobalConfigUpdatePreferencesStore', () => {
  beforeEach(() => {
    configUtils.tryReadJsonFile.mockReset()
    configUtils.writeJsonFile.mockReset()
    configUtils.tryReadJsonFile.mockReturnValue({
      status: 'ok',
      value: {
        ...configUtils.DEFAULT_GLOBAL_CONFIG,
        locale: 'zh-CN',
      },
    })
  })

  it('persists update timing and reminder data inside the existing global Vela config', () => {
    const store = new GlobalConfigUpdatePreferencesStore()
    const preferences = {
      lastCheckedAt: '2026-07-25T01:00:00.000Z',
      lastAutomaticCheckDate: '2026-07-25',
      reminder: { version: '0.2.6', until: '2026-08-01T01:00:00.000Z' },
    }

    expect(store.write(preferences)).toBe(true)

    expect(configUtils.writeJsonFile).toHaveBeenCalledWith(
      configUtils.GLOBAL_CONFIG_PATH,
      expect.objectContaining({
        locale: 'zh-CN',
        updatePreferences: preferences,
      }),
    )
  })

  it('does not overwrite a malformed global config while saving update preferences', () => {
    configUtils.tryReadJsonFile.mockReturnValue({
      status: 'error',
      error: new Error('invalid JSON'),
    })
    const store = new GlobalConfigUpdatePreferencesStore()

    expect(store.write({ lastAutomaticCheckDate: '2026-07-25' })).toBe(false)

    expect(configUtils.writeJsonFile).not.toHaveBeenCalled()
  })

  it('does not overwrite a valid JSON file whose root is not a config object', () => {
    configUtils.tryReadJsonFile.mockReturnValue({ status: 'ok', value: ['not', 'a', 'config'] })
    const store = new GlobalConfigUpdatePreferencesStore()

    expect(store.write({ lastAutomaticCheckDate: '2026-07-25' })).toBe(false)

    expect(configUtils.writeJsonFile).not.toHaveBeenCalled()
  })

  it('creates a new config only when the config file is genuinely absent', () => {
    configUtils.tryReadJsonFile.mockReturnValue({ status: 'missing' })
    const store = new GlobalConfigUpdatePreferencesStore()
    const preferences = { lastAutomaticCheckDate: '2026-07-25' }

    expect(store.write(preferences)).toBe(true)

    expect(configUtils.writeJsonFile).toHaveBeenCalledWith(
      configUtils.GLOBAL_CONFIG_PATH,
      expect.objectContaining({
        ...configUtils.DEFAULT_GLOBAL_CONFIG,
        updatePreferences: preferences,
      }),
    )
  })
})
