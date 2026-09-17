/**
 * 关系拆分与往返的边界测试。
 *
 * 这条接缝决定了「任意角色卡都能被拆解」是否成立：能确定目标的行走结构化边，
 * 其余原文必须原样留作关系备注 —— 既不因为一行解析不出来就整块降级，也不在
 * 作者清空关系之后把旧原文悄悄复活。
 */
import { describe, expect, it } from 'vitest'

import { splitRelationshipEditorValue, unregisteredRelationshipTargets } from '../relationship-presentation'
import { characterCardFromRosterEntry, characterRosterEntryFromCard } from '../../services/character-roster-client'
import type { CharacterRosterEntry } from '../character-roster'

const KNOWN = ['林岚', '周砚', '陆云飞']

function entry(overrides: Partial<CharacterRosterEntry> = {}): CharacterRosterEntry {
  return {
    name: '林岚',
    role: 'protagonist',
    gender: '女',
    age: '27',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    motivation: '',
    relationships: [],
    arc: '',
    notes: '',
    ...overrides,
  }
}

describe('relationship notes split', () => {
  it('splits recognised edges from unrecognised prose instead of degrading the whole block', () => {
    const split = splitRelationshipEditorValue(
      ['周砚：共同追查真相', '她与陆云飞有旧恩。', '[暂无明确关系]'].join('\n'),
      { knownNames: KNOWN, selfName: '林岚' },
    )

    expect(split.edges).toEqual([
      { target: '周砚', relation: '共同追查真相' },
      { target: '陆云飞', relation: '她与陆云飞有旧恩。' },
    ])
    expect(split.notes).toBe('[暂无明确关系]')
  })

  it('reads multi-target and reversed relationship lines', () => {
    expect(splitRelationshipEditorValue('周砚、陆云飞：同事', { knownNames: KNOWN, selfName: '林岚' }).edges)
      .toEqual([
        { target: '周砚', relation: '同事' },
        { target: '陆云飞', relation: '同事' },
      ])

    expect(splitRelationshipEditorValue('师父：陆云飞', { knownNames: KNOWN, selfName: '林岚' }).edges)
      .toEqual([{ target: '陆云飞', relation: '师父' }])
  })

  it('keeps a target that is not a known character as a note', () => {
    const split = splitRelationshipEditorValue('神秘人：宿敌', { knownNames: KNOWN, selfName: '林岚' })

    expect(split.edges).toEqual([])
    expect(split.notes).toBe('神秘人：宿敌')
  })

  it('never attributes a self reference as an edge', () => {
    const split = splitRelationshipEditorValue('林岚：自言自语', { knownNames: KNOWN, selfName: '林岚' })

    expect(split.edges).toEqual([])
    expect(split.notes).toBe('林岚：自言自语')
  })
})

describe('unregistered relationship targets', () => {
  it('lists explicit targets that are not in the roster, without duplicates', () => {
    const found = unregisteredRelationshipTargets(
      ['周砚：共同追查真相', '神秘人：宿敌', '神秘人：另一段描述', '师父：陆云飞'].join('\n'),
      { knownNames: KNOWN, selfName: '林岚' },
    )

    expect(found).toEqual(['神秘人'])
  })

  it('ignores prose lines that carry no explicit name', () => {
    const found = unregisteredRelationshipTargets(
      ['她与陆云飞有旧恩。', '林岚：自言自语'].join('\n'),
      { knownNames: KNOWN, selfName: '林岚' },
    )

    expect(found).toEqual([])
  })

  it('returns nothing when no roster is known', () => {
    expect(unregisteredRelationshipTargets('神秘人：宿敌', { selfName: '林岚' })).toEqual([])
  })
})

describe('roster entry round trip', () => {
  it('keeps edges and the author note side by side through a card round trip', () => {
    const original = entry({
      relationships: [{ target: '周砚', relation: '共同追查真相' }],
      relationshipNotes: '她与陆云飞有旧恩。',
    })

    const card = characterCardFromRosterEntry(original)
    const restored = characterRosterEntryFromCard(card, KNOWN)

    // 备注里写到已知角色的那一行会被提升成结构化边 —— 原句完整保留在 relation
    // 里，因此既没有丢原文，关系图谱也能画出这条边。
    expect(restored.relationships).toEqual([
      { target: '周砚', relation: '共同追查真相' },
      { target: '陆云飞', relation: '她与陆云飞有旧恩。' },
    ])
    expect(restored.relationshipNotes).toBeUndefined()
  })

  it('honours clearing the editor text instead of resurrecting the stored note', () => {
    const original = entry({ relationshipNotes: '她与陆云飞有旧恩。' })
    const card = characterCardFromRosterEntry(original)

    const cleared = characterRosterEntryFromCard({ ...card, relationships: '' }, KNOWN)

    expect(cleared.relationships).toEqual([])
    expect(cleared.relationshipNotes).toBeUndefined()
  })

  it('promotes a note into an edge once its target becomes a known character', () => {
    const card = characterCardFromRosterEntry(entry({ relationshipNotes: '陆云飞：旧识' }))

    const withTarget = characterRosterEntryFromCard(card, KNOWN)
    const withoutTarget = characterRosterEntryFromCard(card, ['林岚'])

    expect(withTarget.relationships).toEqual([{ target: '陆云飞', relation: '旧识' }])
    expect(withoutTarget.relationships).toEqual([])
    expect(withoutTarget.relationshipNotes).toBe('陆云飞：旧识')
  })

  it('carries relationship notes coming from a structured candidate card', () => {
    const restored = characterRosterEntryFromCard({
      name: '林岚',
      role: 'protagonist',
      gender: '',
      age: '',
      appearance: '',
      personality: '',
      background: '',
      abilities: '',
      motivation: '',
      relationships: JSON.stringify([{ target: '周砚', relation: '盟友' }]),
      relationshipNotes: '资料原话',
      arc: '',
      notes: '',
    }, KNOWN)

    expect(restored.relationships).toEqual([{ target: '周砚', relation: '盟友' }])
    expect(restored.relationshipNotes).toBe('资料原话')
  })
})
