/**
 * Chapter role ("章节定位") vocabulary shared by the blueprint editor and the
 * chapter-creation dialog.
 *
 * A blueprint stores `role` as free text (the schema only requires a non-empty
 * string), so a stored value is not necessarily one of these labels. Both
 * selects then render that value as an extra option; without it the native
 * <select> falls back to its first option and every chapter appears to read the
 * same role. The value itself is never rewritten.
 */

export const CHAPTER_ROLES = [
  '建置',
  '铺垫',
  '发展',
  '冲突',
  '高潮',
  '转折',
  '收尾',
] as const

export type ChapterRole = typeof CHAPTER_ROLES[number]

export interface ChapterRoleLabels {
  zhCN: string
  enUS: string
}

export const CHAPTER_ROLE_LABELS: Readonly<Record<ChapterRole, ChapterRoleLabels>> = {
  建置: { zhCN: '建置', enUS: 'Setup' },
  铺垫: { zhCN: '铺垫', enUS: 'Foreshadowing' },
  发展: { zhCN: '发展', enUS: 'Development' },
  冲突: { zhCN: '冲突', enUS: 'Conflict' },
  高潮: { zhCN: '高潮', enUS: 'Climax' },
  转折: { zhCN: '转折', enUS: 'Turning point' },
  收尾: { zhCN: '收尾', enUS: 'Resolution' },
}

const CHAPTER_ROLE_SET: ReadonlySet<string> = new Set(CHAPTER_ROLES)

const CHAPTER_ROLE_UNSET_LABELS: ChapterRoleLabels = { zhCN: '未设定', enUS: 'Not set' }

export interface ChapterRoleOption {
  value: string
  /** null marks a stored custom label, which is shown verbatim. */
  labels: ChapterRoleLabels | null
}

/** Display labels for a stored role, or null when it is a custom label. */
export function getChapterRoleLabels(value: unknown): ChapterRoleLabels | null {
  return typeof value === 'string' && CHAPTER_ROLE_SET.has(value)
    ? CHAPTER_ROLE_LABELS[value as ChapterRole]
    : null
}

/**
 * Options for a role <select>: the canonical list, plus an entry for the stored
 * value when it is a custom label or not set yet. That entry keeps the real
 * value selected and visible instead of silently showing the first option.
 */
export function chapterRoleOptions(current: unknown): ChapterRoleOption[] {
  const options: ChapterRoleOption[] = CHAPTER_ROLES.map(role => ({
    value: role,
    labels: CHAPTER_ROLE_LABELS[role],
  }))
  const raw = typeof current === 'string' ? current : ''
  if (!raw.trim()) return [{ value: '', labels: CHAPTER_ROLE_UNSET_LABELS }, ...options]
  if (!CHAPTER_ROLE_SET.has(raw)) options.push({ value: raw, labels: null })
  return options
}

/**
 * The display value for a role <select>: the stored value when it is
 * non-blank, otherwise the unset option's value. Trimming only decides
 * "unset" here; it never rewrites the stored string, so a padded custom label
 * still matches its option and stays selected.
 */
export function chapterRoleSelectValue(current: unknown): string {
  return typeof current === 'string' && current.trim() ? current : ''
}
