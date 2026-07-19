import { describe, expect, it } from 'vitest'
import { createTranslator, resolveLocale, translate } from '../core'

describe('i18n core', () => {
  it.each([
    ['zh-CN', 'zh-CN'],
    ['zh-TW', 'zh-CN'],
    ['en-US', 'en-US'],
    ['fr-FR', 'en-US'],
    [undefined, 'en-US'],
  ] as const)('resolves %s to %s', (input, expected) => {
    expect(resolveLocale(input)).toBe(expected)
  })

  it('translates and interpolates values as plain text', () => {
    expect(translate('en-US', 'project.current', { name: '<b>Book</b>' }))
      .toBe('Current project: <b>Book</b>')
  })

  it('falls back to English and then the key', () => {
    const localTranslate = createTranslator({
      'en-US': { 'common.open': 'Open' },
      'zh-CN': {},
    })

    expect(localTranslate('zh-CN', 'common.open')).toBe('Open')
    expect(localTranslate('en-US', 'missing.key')).toBe('missing.key')
  })
})
