import { describe, expect, it } from 'vitest'
import { INITIAL_APPEARANCE, migrateLegacyAppearance, parseAppearanceProfile, resolveShell } from '../appearance-profile'

describe('appearance preference conversion', () => {
  it('keeps missing shell unset across development and approved future default policies', () => {
    const profile = migrateLegacyAppearance(null, null, 'light')
    expect(profile.shellPreference).toBe('unset')
    expect(resolveShell(profile.shellPreference)).toBe('classic')
    expect(resolveShell(profile.shellPreference, 'writer')).toBe('writer')
    expect(profile.shellPreference).toBe('unset')
    expect(resolveShell('classic', 'writer')).toBe('classic')
  })
  it.each(['v1', '{"version":"v1"}', '{"state":{"uiVersion":"v1"},"version":0}'])('maps old Classic shape %s', raw => {
    expect(migrateLegacyAppearance(null, raw, 'light').shellPreference).toBe('classic')
  })
  it.each(['v2', '"v2"', '{"state":{"uiVersion":"v2"}}'])('maps old Writer shape %s', raw => {
    expect(migrateLegacyAppearance(null, raw, 'light').shellPreference).toBe('writer')
  })
  it('preserves explicit fonts even when equal to old defaults and donor version is zero', () => {
    const profile = migrateLegacyAppearance(JSON.stringify({ state: {
      theme: 'paper', zoom: 1.25, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', fontDefaultsVersion: 0,
    }, version: 1 }), 'v2', 'light')
    expect(profile).toMatchObject({ colorTheme: 'paper', zoom: 1.25, writingFont: 'lxgw-wenkai',
      uiFont: 'noto-sans-sc', legacyFontDefaultsVersion: 0, shellPreference: 'writer' })
    expect(profile).not.toHaveProperty('backgroundSkin')
  })
  it('preserves legacy night/system display meaning without modifying the source', () => {
    expect(migrateLegacyAppearance('{"state":{"theme":"night"}}', null, 'light').colorTheme).toBe('dark')
    expect(migrateLegacyAppearance('{"state":{"theme":"system"}}', null, 'dark').colorTheme).toBe('dark')
  })
  it.each(['future', '{bad-json', '{"version":"v3"}'])('rejects unknown shell %s for safe Classic fallback', raw => {
    expect(() => migrateLegacyAppearance(null, raw, 'light')).toThrow('LEGACY_SHELL_UNKNOWN')
  })
  it.each(['{bad-json', '{"state":null}', '{"version":9,"state":{}}', '{"state":{"writingFont":"future-font"}}', '{"state":{"zoom":9}}', '{"state":{"extra":true}}'])('refuses unsupported legacy theme %s without conversion', raw => {
    expect(() => migrateLegacyAppearance(raw, null, 'light')).toThrow()
  })
  it.each([{ colorTheme: ['dark'] }, { schemaVersion: 2 }, { backgroundSkin: 'classic' }, { revision: 0 }, { zoom: null }])('rejects malformed/future canonical profile %j', patch => {
    expect(() => parseAppearanceProfile(JSON.stringify({ ...INITIAL_APPEARANCE, ...patch }))).toThrow()
  })
})
