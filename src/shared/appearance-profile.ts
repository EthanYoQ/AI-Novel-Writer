/**
 * 外观偏好：浅色或深色、缩放与两种字体，存在渲染进程的 localStorage。
 * v3 起换了新键：RD-10 之前的配置（带外壳偏好与 galaxy、paper 主题）只读不写，回退到旧版本时它原样还在。
 */
export const APPEARANCE_STORAGE_KEY = 'ai-novel-writer-appearance-v3'
export const PREVIOUS_APPEARANCE_STORAGE_KEY = 'ai-novel-writer-appearance'
/** 更早版本分开存的主题，迁移只读。 */
export const LEGACY_THEME_STORAGE_KEY = 'ai-novel-writer-theme'

export type ColorTheme = 'light' | 'dark'
export type AppearanceFont = 'inter' | 'noto-sans-sc' | 'lxgw-wenkai' | 'noto-serif-sc' | 'system'

/** 内存里的外观偏好。schemaVersion 只出现在存储里。 */
export interface CanonicalAppearanceProfile {
  revision: number
  colorTheme: ColorTheme
  zoom: number
  writingFont: AppearanceFont
  uiFont: AppearanceFont
  origin: 'legacy-import' | 'author'
  legacyImportCompleted: boolean
  /** Provenance only. Never triggers a font reset. */
  legacyFontDefaultsVersion?: number
}

export const INITIAL_APPEARANCE: Readonly<CanonicalAppearanceProfile> = Object.freeze({
  revision: 1, colorTheme: 'light', zoom: 1, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', origin: 'legacy-import', legacyImportCompleted: true,
})

const FONTS = ['inter', 'noto-sans-sc', 'lxgw-wenkai', 'noto-serif-sc', 'system']
const V3_FIELDS = ['schemaVersion', 'revision', 'colorTheme', 'zoom', 'writingFont', 'uiFont', 'origin', 'legacyImportCompleted', 'legacyFontDefaultsVersion']
/** 旧配置的主题：深色与星空迁为深色，纸面与浅色迁为浅色。 */
const PREVIOUS_THEME: Readonly<Record<string, ColorTheme>> = { light: 'light', paper: 'light', dark: 'dark', galaxy: 'dark' }
const PREVIOUS_SHELL_PREFERENCES: Readonly<Record<number, readonly string[]>> = {
  1: ['unset', 'classic', 'writer'],
  2: ['unset', 'classic', 'writer', 'stage'],
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export class AppearanceProfileError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AppearanceProfileError' }
}

function parseJson(raw: string, code: string): unknown {
  try { return JSON.parse(raw) } catch { throw new AppearanceProfileError(code) }
}

/** 各版本共有的字段：修订号、缩放、字体、来源与旧字体默认值版本。 */
function sharedFieldsValid(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.revision) && Number(value.revision) >= 1
    && typeof value.zoom === 'number' && Number.isFinite(value.zoom) && value.zoom >= 0.7 && value.zoom <= 1.5
    && typeof value.writingFont === 'string' && FONTS.includes(value.writingFont)
    && typeof value.uiFont === 'string' && FONTS.includes(value.uiFont)
    && typeof value.origin === 'string' && ['legacy-import', 'author'].includes(value.origin) && value.legacyImportCompleted === true
    && (value.legacyFontDefaultsVersion === undefined
      || (Number.isSafeInteger(value.legacyFontDefaultsVersion) && Number(value.legacyFontDefaultsVersion) >= 0))
}

function canonical(value: Record<string, unknown>, colorTheme: ColorTheme): CanonicalAppearanceProfile {
  const profile: CanonicalAppearanceProfile = {
    revision: value.revision as number, colorTheme, zoom: value.zoom as number,
    writingFont: value.writingFont as AppearanceFont, uiFont: value.uiFont as AppearanceFont,
    origin: value.origin as CanonicalAppearanceProfile['origin'], legacyImportCompleted: true,
  }
  if (value.legacyFontDefaultsVersion !== undefined) profile.legacyFontDefaultsVersion = value.legacyFontDefaultsVersion as number
  return profile
}

function assertV3(value: unknown): asserts value is Record<string, unknown> {
  if (!record(value) || value.schemaVersion !== 3 || !sharedFieldsValid(value)
    || (value.colorTheme !== 'light' && value.colorTheme !== 'dark')) throw new AppearanceProfileError('APPEARANCE_PROFILE_INVALID')
  if (Object.keys(value).some(key => !V3_FIELDS.includes(key))) throw new AppearanceProfileError('APPEARANCE_UNKNOWN_FIELDS')
}

/** 读取已保存的 v3 配置，严格校验：别的版本、皮肤、外壳偏好等多出来的字段都拒绝。 */
export function parseAppearanceProfile(raw: string): CanonicalAppearanceProfile {
  const value = parseJson(raw, 'APPEARANCE_JSON_INVALID')
  assertV3(value)
  return canonical(value, value.colorTheme as ColorTheme)
}

export function serializeAppearanceProfile(profile: CanonicalAppearanceProfile): string {
  const stored = { schemaVersion: 3, ...profile }
  assertV3(stored)
  return JSON.stringify(stored)
}

/**
 * RD-10 之前的配置（schemaVersion 1、2）按它当时的规则严格校验后迁成 v3：主题按 PREVIOUS_THEME 换算，外壳偏好丢弃，
 * 修订号、缩放、字体与来源照搬。只读旧键，不改它。
 */
export function migratePreviousAppearance(raw: string): CanonicalAppearanceProfile {
  const value = parseJson(raw, 'APPEARANCE_JSON_INVALID')
  const shells = record(value) && typeof value.schemaVersion === 'number' ? PREVIOUS_SHELL_PREFERENCES[value.schemaVersion] : undefined
  if (!record(value) || !shells || !sharedFieldsValid(value)
    || typeof value.shellPreference !== 'string' || !shells.includes(value.shellPreference)
    || typeof value.colorTheme !== 'string' || !Object.hasOwn(PREVIOUS_THEME, value.colorTheme)) {
    throw new AppearanceProfileError('APPEARANCE_PROFILE_INVALID')
  }
  if (Object.keys(value).some(key => key !== 'shellPreference' && !V3_FIELDS.includes(key))) throw new AppearanceProfileError('APPEARANCE_UNKNOWN_FIELDS')
  return canonical(value, PREVIOUS_THEME[value.colorTheme]!)
}

/**
 * 最早的版本只存了主题、缩放与字体（ai-novel-writer-theme）。没有这一项时用初始偏好。
 * 跟随系统的主题按当时的系统外观落定，night 是深色的旧名。
 */
export function migrateLegacyAppearance(themeRaw: string | null, systemTheme: ColorTheme): CanonicalAppearanceProfile {
  const profile: CanonicalAppearanceProfile = { ...INITIAL_APPEARANCE }
  if (themeRaw === null) return profile
  const parsed = parseJson(themeRaw, 'LEGACY_THEME_JSON_INVALID')
  if (!record(parsed) || !record(parsed.state)) throw new AppearanceProfileError('LEGACY_THEME_INVALID')
  if (parsed.version !== undefined && parsed.version !== 0 && parsed.version !== 1) throw new AppearanceProfileError('LEGACY_THEME_VERSION_UNKNOWN')
  const state = parsed.state
  if (Object.keys(state).some(key => !['theme', 'zoom', 'writingFont', 'uiFont', 'fontDefaultsVersion'].includes(key))) {
    throw new AppearanceProfileError('LEGACY_THEME_FIELDS_UNKNOWN')
  }
  if (state.theme !== undefined) {
    const theme = state.theme === 'night' ? 'dark' : state.theme === 'system' ? systemTheme : state.theme
    if (typeof theme !== 'string' || !Object.hasOwn(PREVIOUS_THEME, theme)) throw new AppearanceProfileError('APPEARANCE_PROFILE_INVALID')
    profile.colorTheme = PREVIOUS_THEME[theme]!
  }
  if (state.zoom !== undefined) profile.zoom = state.zoom as number
  if (state.writingFont !== undefined) profile.writingFont = state.writingFont as AppearanceFont
  if (state.uiFont !== undefined) profile.uiFont = state.uiFont as AppearanceFont
  if (state.fontDefaultsVersion !== undefined) profile.legacyFontDefaultsVersion = state.fontDefaultsVersion as number
  return parseAppearanceProfile(serializeAppearanceProfile(profile))
}

export type AppearancePatch = Partial<Pick<CanonicalAppearanceProfile, 'colorTheme' | 'zoom' | 'writingFont' | 'uiFont'>>
