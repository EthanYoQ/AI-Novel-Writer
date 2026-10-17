import { describe, expect, it } from 'vitest'
import {
  INITIAL_APPEARANCE, migrateLegacyAppearance, migratePreviousAppearance, parseAppearanceProfile, serializeAppearanceProfile,
} from '../appearance-profile'

/** RD-10 之前写下的配置：v1 的外壳只能是 unset、classic、writer，v2 还可以是 stage。 */
const previous = (fields: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: 1, revision: 7, shellPreference: 'writer', colorTheme: 'paper', zoom: 1.25, writingFont: 'noto-serif-sc',
  uiFont: 'inter', origin: 'author', legacyImportCompleted: true, legacyFontDefaultsVersion: 0, ...fields,
})

describe('RD-10 之前的外观配置迁到 v3', () => {
  it.each([
    ['light', 'light'], ['paper', 'light'], ['dark', 'dark'], ['galaxy', 'dark'],
  ])('旧主题 %s 迁为 %s，修订号、缩放、字体与来源照搬', (colorTheme, expected) => {
    expect(migratePreviousAppearance(previous({ colorTheme }))).toEqual({
      revision: 7, colorTheme: expected, zoom: 1.25, writingFont: 'noto-serif-sc', uiFont: 'inter',
      origin: 'author', legacyImportCompleted: true, legacyFontDefaultsVersion: 0,
    })
  })

  it.each([[1, 'unset'], [1, 'classic'], [1, 'writer'], [2, 'unset'], [2, 'stage']])('v%i 的外壳偏好 %s 迁移后丢弃，v3 不存外壳', (schemaVersion, shellPreference) => {
    const profile = migratePreviousAppearance(previous({ schemaVersion, shellPreference }))
    expect(profile).not.toHaveProperty('shellPreference')
    expect(JSON.parse(serializeAppearanceProfile(profile))).toEqual({ schemaVersion: 3, ...profile })
  })

  it('旧配置仍按它当时的规则校验：v1 里的 stage、未知版本与字段、坏 JSON、未知主题都拒绝', () => {
    expect(() => migratePreviousAppearance(previous({ shellPreference: 'stage' }))).toThrow('APPEARANCE_PROFILE_INVALID')
    expect(() => migratePreviousAppearance(previous({ schemaVersion: 3 }))).toThrow('APPEARANCE_PROFILE_INVALID')
    expect(() => migratePreviousAppearance(previous({ colorTheme: 'sepia' }))).toThrow('APPEARANCE_PROFILE_INVALID')
    expect(() => migratePreviousAppearance(previous({ zoom: 9 }))).toThrow('APPEARANCE_PROFILE_INVALID')
    expect(() => migratePreviousAppearance(previous({ extra: true }))).toThrow('APPEARANCE_UNKNOWN_FIELDS')
    expect(() => migratePreviousAppearance('{bad-json')).toThrow('APPEARANCE_JSON_INVALID')
  })
})

describe('旧皮肤', () => {
  // 皮肤从来不在外观偏好里，而在主进程全局数据的 skins/manifest.json；那份文件迁移后不再读取，原样留给回退。
  // 这里断言的是：任何版本的外观偏好都表达不了皮肤，所以三种旧皮肤迁移后都是没有背景图的纸墨界面。
  it.each(['classic', 'anime', 'custom'])('%s 皮肤写不进外观偏好：旧配置与 v3 里带皮肤字段都拒绝，迁移结果没有皮肤', skin => {
    expect(() => migratePreviousAppearance(previous({ backgroundSkin: skin }))).toThrow('APPEARANCE_UNKNOWN_FIELDS')
    const migrated = migratePreviousAppearance(previous())
    expect(Object.keys(migrated).some(key => /skin/i.test(key))).toBe(false)
    expect(() => parseAppearanceProfile(JSON.stringify({ ...JSON.parse(serializeAppearanceProfile(migrated)), backgroundSkin: skin })))
      .toThrow('APPEARANCE_UNKNOWN_FIELDS')
  })
})

describe('更早的主题键迁到 v3', () => {
  it('没有任何旧配置时是初始的浅色偏好', () => {
    expect(migrateLegacyAppearance(null, 'dark')).toEqual(INITIAL_APPEARANCE)
    expect(INITIAL_APPEARANCE.colorTheme).toBe('light')
  })

  it.each([
    ['light', 'light'], ['paper', 'light'], ['dark', 'dark'], ['galaxy', 'dark'], ['night', 'dark'],
  ])('旧主题 %s 迁为 %s', (theme, expected) => {
    expect(migrateLegacyAppearance(JSON.stringify({ state: { theme } }), 'light').colorTheme).toBe(expected)
  })

  it('跟随系统的主题按当时的系统外观落定', () => {
    expect(migrateLegacyAppearance('{"state":{"theme":"system"}}', 'dark').colorTheme).toBe('dark')
    expect(migrateLegacyAppearance('{"state":{"theme":"system"}}', 'light').colorTheme).toBe('light')
  })

  it('字体与缩放照搬，旧字体默认值版本只作来源记录', () => {
    expect(migrateLegacyAppearance(JSON.stringify({ state: {
      theme: 'paper', zoom: 1.25, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', fontDefaultsVersion: 0,
    }, version: 1 }), 'light')).toEqual({ ...INITIAL_APPEARANCE, colorTheme: 'light', zoom: 1.25, legacyFontDefaultsVersion: 0 })
  })

  it.each(['{bad-json', '{"state":null}', '{"version":9,"state":{}}', '{"state":{"writingFont":"future-font"}}', '{"state":{"zoom":9}}',
    '{"state":{"extra":true}}', '{"state":{"theme":"sepia"}}'])('拒绝无法换算的旧主题 %s', raw => {
    expect(() => migrateLegacyAppearance(raw, 'light')).toThrow()
  })
})

describe('v3 的存储格式', () => {
  const stored = (fields: Record<string, unknown> = {}) => JSON.stringify({
    schemaVersion: 3, revision: 4, colorTheme: 'dark', zoom: 1.1, writingFont: 'inter', uiFont: 'system',
    origin: 'author', legacyImportCompleted: true, ...fields,
  })

  it('读回再写出与原文逐字节相同，内存里不带版本号', () => {
    const profile = parseAppearanceProfile(stored())
    expect(profile).not.toHaveProperty('schemaVersion')
    expect(serializeAppearanceProfile(profile)).toBe(stored())
  })

  it.each([
    [{ schemaVersion: 1 }, 'APPEARANCE_PROFILE_INVALID'],
    [{ schemaVersion: 2 }, 'APPEARANCE_PROFILE_INVALID'],
    [{ colorTheme: 'paper' }, 'APPEARANCE_PROFILE_INVALID'],
    [{ colorTheme: 'galaxy' }, 'APPEARANCE_PROFILE_INVALID'],
    [{ revision: 0 }, 'APPEARANCE_PROFILE_INVALID'],
    [{ zoom: null }, 'APPEARANCE_PROFILE_INVALID'],
    [{ shellPreference: 'stage' }, 'APPEARANCE_UNKNOWN_FIELDS'],
  ])('拒绝 %j', (fields, code) => {
    expect(() => parseAppearanceProfile(stored(fields))).toThrow(code)
  })

  it('坏 JSON 拒绝；写入前同样校验', () => {
    expect(() => parseAppearanceProfile('{bad-json')).toThrow('APPEARANCE_JSON_INVALID')
    expect(() => serializeAppearanceProfile({ ...INITIAL_APPEARANCE, zoom: 9 })).toThrow('APPEARANCE_PROFILE_INVALID')
  })
})
