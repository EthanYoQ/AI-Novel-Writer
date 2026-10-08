import { describe, expect, it } from 'vitest'
import { createTranslator, localize, resolveLocale, translate } from '../core'

describe('i18n core', () => {
  it.each([
    ['zh-CN', 'zh-CN'],
    ['zh-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-Hant', 'zh-TW'],
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
      'zh-TW': {},
    })

    expect(localTranslate('zh-CN', 'common.open')).toBe('Open')
    expect(localTranslate('en-US', 'missing.key')).toBe('missing.key')
  })

  it('selects colocated UI copy and interpolates parameters', () => {
    expect(localize('zh-CN', '已关闭 {count} 个文件', 'Closed {count} files', { count: 3 }))
      .toBe('已关闭 3 个文件')
    expect(localize('en-US', '已关闭 {count} 个文件', 'Closed {count} files', { count: 3 }))
      .toBe('Closed 3 files')
  })

  it('renders Traditional Chinese UI copy while preserving interpolated user data', () => {
    expect(translate('zh-TW', 'language.chinese')).toBe('簡體中文')
    expect(localize('zh-TW', '已关闭 {count} 个文件：{name}', 'Closed {count} files: {name}', {
      count: 3, name: '简体书名.txt',
    })).toBe('已關閉 3 個檔案：简体书名.txt')
  })
})
