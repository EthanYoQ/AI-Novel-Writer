import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let fixtureRoot = ''
let configPath = ''
let GlobalConfigUpdatePreferencesStore: typeof import('../update-preferences-store').GlobalConfigUpdatePreferencesStore

beforeEach(async () => {
  vi.resetModules()
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-update-preferences-'))
  const dataRoot = await (await import('./global-data-fixture')).prepareGlobalDataFixture(fixtureRoot)
  configPath = path.join(dataRoot, 'config.json')
  ;({ GlobalConfigUpdatePreferencesStore } = await import('../update-preferences-store'))
})

afterEach(() => {
  delete process.env.AI_NOVEL_VELA_HOME
  delete process.env.AI_NOVEL_APP_DATA_HOME
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('GlobalConfigUpdatePreferencesStore', () => {
  it('persists update timing and reminder data inside the existing global config', () => {
    fs.writeFileSync(configPath, JSON.stringify({ theme: 'dark', defaultModelId: null, locale: 'zh-CN' }))
    const store = new GlobalConfigUpdatePreferencesStore()
    const preferences = {
      lastCheckedAt: '2026-07-25T01:00:00.000Z',
      lastAutomaticCheckDate: '2026-07-25',
      reminder: { version: '0.2.6', until: '2026-08-01T01:00:00.000Z' },
    }

    expect(store.write(preferences)).toBe(true)

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({ locale: 'zh-CN', updatePreferences: preferences })
    expect(new GlobalConfigUpdatePreferencesStore().read()).toEqual(preferences)
  })

  it('does not overwrite a malformed global config while saving update preferences', () => {
    fs.writeFileSync(configPath, '{BROKEN')
    const store = new GlobalConfigUpdatePreferencesStore()

    expect(store.write({ lastAutomaticCheckDate: '2026-07-25' })).toBe(false)

    expect(fs.readFileSync(configPath, 'utf8')).toBe('{BROKEN')
  })

  it('does not overwrite a valid JSON file whose root is not a config object', () => {
    fs.writeFileSync(configPath, JSON.stringify(['not', 'a', 'config']))
    const store = new GlobalConfigUpdatePreferencesStore()

    expect(store.write({ lastAutomaticCheckDate: '2026-07-25' })).toBe(false)

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(['not', 'a', 'config'])
  })

  it('creates a new config from defaults only when the config file is genuinely absent', () => {
    fs.rmSync(configPath, { force: true })
    const store = new GlobalConfigUpdatePreferencesStore()
    const preferences = { lastAutomaticCheckDate: '2026-07-25' }

    expect(store.write(preferences)).toBe(true)

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
      theme: 'dark',
      defaultModelId: null,
      updatePreferences: preferences,
    })
  })
})
