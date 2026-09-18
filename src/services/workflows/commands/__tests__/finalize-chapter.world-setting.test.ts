import { describe, expect, it } from 'vitest'

import {
  evidenceAppearsInContent,
  resolveWorldSettingEntryId,
  type WorldSettingNameCandidate,
} from '../finalize-chapter.command'

function candidate(id: number, name: string, aliases: string[] = []): WorldSettingNameCandidate {
  return { id, name, aliases }
}

describe('evidenceAppearsInContent', () => {
  it('accepts evidence that appears verbatim in the frozen manuscript', () => {
    expect(evidenceAppearsInContent(
      '旅人独自离开了客栈，走向山路。',
      '旅人独自离开了客栈',
    )).toBe(true)
  })

  it('rejects evidence that never appears in the manuscript', () => {
    // review 反例：正文只有旅人离开客栈，模型却编造「青云宗覆灭」的引文。
    expect(evidenceAppearsInContent(
      '旅人独自离开了客栈，走向山路。',
      '青云宗已经彻底覆灭。',
    )).toBe(false)
  })

  it('normalizes whitespace and newlines before matching', () => {
    expect(evidenceAppearsInContent(
      '青云宗已经彻底覆灭。\n旅人独自离开了客栈。',
      '青云宗 已经 彻底 覆灭。',
    )).toBe(true)
  })

  it('rejects empty evidence even when the manuscript is empty', () => {
    expect(evidenceAppearsInContent('', '   ')).toBe(false)
    expect(evidenceAppearsInContent('正文。', '')).toBe(false)
  })
})

describe('resolveWorldSettingEntryId', () => {
  it('resolves a unique exact canonical name', () => {
    const entries = [candidate(1, '青云宗'), candidate(2, '玄阳子')]
    expect(resolveWorldSettingEntryId('青云宗', entries)).toBe(1)
  })

  it('resolves a unique name case-insensitively', () => {
    const entries = [candidate(1, 'Lin Lan')]
    expect(resolveWorldSettingEntryId('lin lan', entries)).toBe(1)
  })

  it('resolves a unique alias', () => {
    const entries = [candidate(1, '青云宗', ['青雲宗', '北境仙门'])]
    expect(resolveWorldSettingEntryId('北境仙门', entries)).toBe(1)
  })

  it('does not auto-resolve a substring that matches two different entries', () => {
    // review 反例：库中有东城商会、西城商会，模型只报「商会」。
    const entries = [candidate(1, '东城商会'), candidate(2, '西城商会')]
    expect(resolveWorldSettingEntryId('商会', entries)).toBeNull()
  })

  it('does not auto-resolve a duplicate alias shared by two entries', () => {
    const entries = [
      candidate(1, '青云宗', ['北境仙门']),
      candidate(2, '太玄宗', ['北境仙门']),
    ]
    expect(resolveWorldSettingEntryId('北境仙门', entries)).toBeNull()
  })

  it('returns null for an unknown name', () => {
    const entries = [candidate(1, '青云宗')]
    expect(resolveWorldSettingEntryId('不存在的名字', entries)).toBeNull()
  })

  it('returns null for a blank name', () => {
    const entries = [candidate(1, '青云宗')]
    expect(resolveWorldSettingEntryId('   ', entries)).toBeNull()
  })
})
