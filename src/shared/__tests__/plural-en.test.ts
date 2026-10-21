import { describe, expect, it } from 'vitest'
import { pluralEn } from '../plural-en'

describe('pluralEn', () => {
  it('1 用单数，其余加 s', () => {
    expect([0, 1, 2].map(count => `${count} ${pluralEn(count, 'chapter')}`)).toEqual(['0 chapters', '1 chapter', '2 chapters'])
  })

  it('不规则复数用显式传入的复数形式，不写成 entrys', () => {
    expect([1, 3].map(count => `${count} ${pluralEn(count, 'entry', 'entries')}`)).toEqual(['1 entry', '3 entries'])
  })
})
