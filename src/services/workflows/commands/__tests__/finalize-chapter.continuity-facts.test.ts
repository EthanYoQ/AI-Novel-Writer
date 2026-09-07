import { describe, expect, it } from 'vitest'

import { EN_US_BUILTIN_PROMPTS } from '../../../prompt-language'
import { BUILTIN_PROMPTS } from '../../../prompt-templates'
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

  it('does not treat a shared location as support for the opposite predicate', () => {
    const facts = buildFinalizedContinuityFacts(
      5,
      '林海在北京死亡。',
      '林海在北京生活。',
      ['林海'],
    )

    expect(facts).toEqual([])
  })

  it('applies the fact limit after rejecting unsupported note statements', () => {
    const supportedFact = '林岚在北塔因爆炸碎片受伤，顾砚亲眼看见。'
    const unsupportedNotes = Array.from(
      { length: 12 },
      (_, index) => `无正文证据的摘要陈述${index + 1}。`,
    )

    const facts = buildFinalizedContinuityFacts(
      6,
      [...unsupportedNotes, supportedFact].join('\n'),
      supportedFact,
      ['林岚', '顾砚'],
    )

    expect(facts).toEqual([{
      category: 'character-state',
      entities: ['林岚', '顾砚'],
      statement: supportedFact,
      sourceChapter: 6,
      evidence: supportedFact,
    }])
  })

  it('asks chapter notes to preserve only explicit continuity context without filling every field', () => {
    const zh = BUILTIN_PROMPTS.find(template => template.key === 'generate_chapter_notes')
    const en = EN_US_BUILTIN_PROMPTS.generate_chapter_notes

    expect(zh?.content).toContain('若正文明确写出其原因、发生地点、知情者或获知来源')
    expect(zh?.content).toContain('不要求每条凑齐这些要素')
    expect(zh?.content).toContain('正文未明确的信息不得补全或推测')
    expect(zh?.content).not.toContain('每项不超过 30 字')
    expect(en.content).toContain('an explicitly stated cause, location, witness, or source of knowledge')
    expect(en.content).toContain('Do not infer missing details or require every note to contain all of these elements')
  })
})
