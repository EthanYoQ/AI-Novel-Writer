export const CHARACTER_ROLES = [
  'protagonist',
  'antagonist',
  'supporting',
  'minor',
] as const

export type CharacterRole = typeof CHARACTER_ROLES[number]

export interface CharacterRoleLabels {
  zhCN: string
  enUS: string
}

export const CHARACTER_ROLE_LABELS: Readonly<Record<CharacterRole, CharacterRoleLabels>> = {
  protagonist: { zhCN: '主角', enUS: 'Protagonist' },
  antagonist: { zhCN: '反派', enUS: 'Antagonist' },
  supporting: { zhCN: '配角', enUS: 'Supporting character' },
  minor: { zhCN: '龙套', enUS: 'Minor character' },
}

const CHARACTER_ROLE_ALIASES: Readonly<Record<string, CharacterRole>> = {
  protagonist: 'protagonist',
  main: 'protagonist',
  主角: 'protagonist',
  男主: 'protagonist',
  女主: 'protagonist',
  核心主角: 'protagonist',
  antagonist: 'antagonist',
  villain: 'antagonist',
  反派: 'antagonist',
  对手: 'antagonist',
  敌人: 'antagonist',
  supporting: 'supporting',
  support: 'supporting',
  配角: 'supporting',
  重要配角: 'supporting',
  核心配角: 'supporting',
  minor: 'minor',
  龙套: 'minor',
  次要角色: 'minor',
}

/**
 * Normalize persisted or external role values before they enter application state.
 * Unknown legacy values deliberately fall back to the least surprising editable role.
 */
export function normalizeCharacterRole(value: unknown): CharacterRole {
  if (typeof value !== 'string') return 'supporting'
  const candidate = value.trim()
  return CHARACTER_ROLE_ALIASES[candidate]
    ?? CHARACTER_ROLE_ALIASES[candidate.toLowerCase()]
    ?? 'supporting'
}

/** Locale-neutral display data for renderer consumers. */
export function getCharacterRoleLabels(value: unknown): CharacterRoleLabels {
  return CHARACTER_ROLE_LABELS[normalizeCharacterRole(value)]
}
