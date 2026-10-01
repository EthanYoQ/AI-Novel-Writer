import { describe, expect, it } from 'vitest'

import { CHAPTER_ROLES, chapterRoleOptions, getChapterRoleLabels } from '../chapter-role'

describe('chapter role vocabulary', () => {
  it('shares one canonical list whose opening label is 建置', () => {
    expect(CHAPTER_ROLES[0]).toBe('建置')
    expect(CHAPTER_ROLES).toHaveLength(7)
    expect(new Set(CHAPTER_ROLES).size).toBe(CHAPTER_ROLES.length)
  })

  it('provides bilingual labels for every canonical role', () => {
    for (const role of CHAPTER_ROLES) {
      const labels = getChapterRoleLabels(role)
      expect(labels?.zhCN).toBe(role)
      expect(labels?.enUS).toBeTruthy()
    }
    expect(getChapterRoleLabels('建置')).toEqual({ zhCN: '建置', enUS: 'Setup' })
  })

  it('reports no labels for a custom or non-string value so callers show it verbatim', () => {
    expect(getChapterRoleLabels('双线交汇')).toBeNull()
    expect(getChapterRoleLabels('')).toBeNull()
    expect(getChapterRoleLabels(undefined)).toBeNull()
  })

  it('lists the canonical roles for a known value', () => {
    expect(chapterRoleOptions('发展').map(option => option.value)).toEqual([...CHAPTER_ROLES])
  })

  it('appends the stored custom label so the select cannot fall back to 建置', () => {
    const options = chapterRoleOptions('双线交汇')
    expect(options.map(option => option.value)).toEqual([...CHAPTER_ROLES, '双线交汇'])
    expect(options.at(-1)).toEqual({ value: '双线交汇', labels: null })
  })

  it('offers an explicit unset entry only while the field is empty', () => {
    expect(chapterRoleOptions('')[0]).toEqual({ value: '', labels: { zhCN: '未设定', enUS: 'Not set' } })
    expect(chapterRoleOptions('   ')[0]?.value).toBe('')
    expect(chapterRoleOptions('高潮').some(option => option.value === '')).toBe(false)
  })
})
