import { describe, expect, it } from 'vitest'

import { buildFinalizedContinuityFacts } from '../finalize-chapter.command'

describe('buildFinalizedContinuityFacts', () => {
  it('classifies an explicit character death as character state', () => {
    const finalizedContent = '韩峥被洪水卷入排水井，当场死亡。'

    const facts = buildFinalizedContinuityFacts(
      2,
      '韩峥被洪水卷入排水井，当场死亡。',
      finalizedContent,
      ['韩峥'],
    )

    expect(facts).toEqual([
      expect.objectContaining({
        category: 'character-state',
        entities: ['韩峥'],
        statement: '韩峥被洪水卷入排水井，当场死亡。',
      }),
    ])
  })

  it('binds each fact to its own finalized evidence and omits unsupported notes', () => {
    const facts = buildFinalizedContinuityFacts(
      4,
      [
        '林舟把铜钥匙交给苏遥。',
        '韩峥在洪水中死亡。',
        '顾明破解了保险箱密码。',
      ].join('\n'),
      '林舟把铜钥匙交给苏遥。韩峥随后被洪水卷走，当场死亡。',
      ['林舟', '苏遥', '韩峥', '顾明'],
    )

    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({
      entities: ['林舟', '苏遥'],
      evidence: '林舟把铜钥匙交给苏遥。',
    })
    expect(facts[1]).toMatchObject({
      entities: ['韩峥'],
      evidence: '韩峥随后被洪水卷走，当场死亡。',
    })
    expect(facts.some(fact => fact.statement.includes('顾明'))).toBe(false)
  })

  it('does not treat an entity boundary bigram as evidence for a contradictory fact', () => {
    const facts = buildFinalizedContinuityFacts(
      5,
      '林海在北京死亡。',
      '林海在上海生活。',
      ['林海'],
    )

    expect(facts).toEqual([])
  })
})
