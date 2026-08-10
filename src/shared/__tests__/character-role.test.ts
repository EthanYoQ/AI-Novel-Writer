import { describe, expect, it } from 'vitest'

import {
  CHARACTER_ROLES,
  getCharacterRoleLabels,
  normalizeCharacterRole,
} from '../character-role'

describe('character role domain', () => {
  it('preserves every canonical character role', () => {
    expect(normalizeCharacterRole('protagonist')).toBe('protagonist')
    expect(normalizeCharacterRole('antagonist')).toBe('antagonist')
    expect(normalizeCharacterRole('supporting')).toBe('supporting')
    expect(normalizeCharacterRole('minor')).toBe('minor')
  })

  it('defaults a missing role to supporting', () => {
    expect(normalizeCharacterRole(undefined)).toBe('supporting')
  })

  it('defaults an unknown role to supporting', () => {
    expect(normalizeCharacterRole('legacy-custom-role')).toBe('supporting')
  })

  it('maps the documented legacy aliases already accepted by character generation', () => {
    expect(normalizeCharacterRole('主角')).toBe('protagonist')
    expect(normalizeCharacterRole('villain')).toBe('antagonist')
    expect(normalizeCharacterRole('重要配角')).toBe('supporting')
    expect(normalizeCharacterRole('次要角色')).toBe('minor')
  })

  it('exposes canonical keys and locale-neutral labels from one shared seam', () => {
    expect(CHARACTER_ROLES).toEqual([
      'protagonist',
      'antagonist',
      'supporting',
      'minor',
    ])
    expect(getCharacterRoleLabels('protagonist')).toEqual({
      zhCN: '主角',
      enUS: 'Protagonist',
    })
    expect(getCharacterRoleLabels('legacy-custom-role')).toEqual({
      zhCN: '配角',
      enUS: 'Supporting character',
    })
  })
})
