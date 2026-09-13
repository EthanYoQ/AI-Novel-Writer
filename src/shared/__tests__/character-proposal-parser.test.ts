import { describe, expect, it } from 'vitest'
import { characterProposalMaterialChunks, decodeCharacterDetails, parseArchitectureCharacterProposal, parsePlanningMaterialCharacterProposal } from '../character-proposal-parser'

function architecture() {
  const slots = ['同名', '同名', '反派'].map((name, index) => ({ slotId: `slot-${index}`, name,
    role: index === 0 ? 'protagonist' : 'supporting', narrativeDuty: '推动冲突',
    relations: [{ targetSlotId: `slot-${(index + 1) % 3}`, relation: '原始关系' }] }))
  const entries = slots.map(slot => ({ slotId: slot.slotId, name: slot.name, role: slot.role,
    gender: '未知', age: 18, appearance: '外貌', personality: '性格', background: '背景', abilities: '能力',
    motivation: '动机', arc: '弧光', notes: '备注', currentState: { location: '城中', powerLevel: '普通',
      physicalState: '健康', mentalState: '警觉', keyItems: ['原物件'], recentEvents: ['原事件'], updatedAtChapter: 19 } }))
  return { slots, entries, manifest: { artifactId: 'manifest', text: JSON.stringify({ slots }) },
    details: [{ artifactId: 'details', text: JSON.stringify({ entries }) }] }
}
describe('main-safe source-local character proposal parsing', () => {
  it('keeps equal names distinct, exact slot relationships and raw dynamic provenance', () => {
    const fixture = architecture(), result = parseArchitectureCharacterProposal(fixture)
    expect(result.map(item => item.fields.name)).toEqual(['同名', '同名', '反派'])
    expect(result.map(item => item.selectionKey)).toEqual(['slot-0', 'slot-1', 'slot-2'])
    expect(result[0].relationships).toEqual([{ targetSelectionKey: 'slot-1', relation: '原始关系' }])
    expect(result[0].fields).not.toHaveProperty('currentState')
    expect(result[0].rawValue).toMatchObject({ detail: { currentState: { updatedAtChapter: 19, keyItems: ['原物件'] } } })
    expect(decodeCharacterDetails(fixture.details[0].text)[0].currentState?.updatedAtChapter).toBe(0)
  })
  it.each(['missing', 'duplicate', 'renamed', 'unknown-slot', 'unknown-field'] as const)('rejects %s details instead of merging by name', mutation => {
    const fixture = architecture()
    if (mutation === 'missing') fixture.entries.pop()
    if (mutation === 'duplicate') fixture.entries[1] = fixture.entries[0]
    if (mutation === 'renamed') fixture.entries[0].name = '另一个人'
    if (mutation === 'unknown-slot') fixture.entries[0].slotId = 'unknown'
    if (mutation === 'unknown-field') Object.assign(fixture.entries[0], { permission: 'invented' })
    fixture.details[0].text = JSON.stringify({ entries: fixture.entries })
    expect(() => parseArchitectureCharacterProposal(fixture)).toThrow()
  })
  it('rejects unselected malformed attempts and accepts only the complete successful split set', () => {
    const fixture = architecture()
    const split = fixture.entries.map((entry, index) => ({ artifactId: `split-${index}`, text: JSON.stringify({ entries: [entry] }) }))
    expect(parseArchitectureCharacterProposal({ ...fixture, details: split })).toHaveLength(3)
    expect(() => parseArchitectureCharacterProposal({ ...fixture, details: [{ artifactId: 'failed', text: '{"entries":[' }, ...split] })).toThrow()
  })
  it('preserves every material source record and name-only relationship without resolving it', () => {
    const result = parsePlanningMaterialCharacterProposal({ expectedSourceIds: ['1:1', '2:1'], artifacts: [{ artifactId: 'a', text: JSON.stringify({ results: [
      { sourceId: '1:1', characterCards: [{ name: '同名', role: 'supporting', notes: '第一来源', relationships: [{ target: '同名', relation: '原关系' }] }] },
      { sourceId: '2:1', characterCards: [{ name: '同名', role: 'supporting', notes: '第二来源' }] },
    ] }) }] })
    expect(result.map(item => item.selectionKey)).toEqual(['1:1:character:1', '2:1:character:1'])
    expect(result[0].relationships[0]).toMatchObject({ targetName: '同名', relation: '原关系' })
    expect(result[0].relationships[0]).not.toHaveProperty('targetSelectionKey')
  })
  it.each(['missing', 'duplicate', 'unknown'] as const)('rejects %s material source coverage', mutation => {
    const ids = mutation === 'missing' ? ['1:1'] : mutation === 'duplicate' ? ['1:1', '1:1'] : ['1:1', '3:1']
    expect(() => parsePlanningMaterialCharacterProposal({ expectedSourceIds: ['1:1', '2:1'], artifacts: [{ artifactId: 'a', text: JSON.stringify({ results: ids.map(sourceId => ({ sourceId, characterCards: [] })) }) }] })).toThrow()
  })
  it('rebuilds exact material chunk selection without splitting a Unicode surrogate pair', () => {
    const text = `${'中'.repeat(11999)}😀后续`
    const chunks = characterProposalMaterialChunks([{ fileName: '原稿', text }])
    expect(chunks.map(item => item.sourceId)).toEqual(['1:1', '1:2'])
    expect(chunks.map(item => item.text).join('')).toBe(text)
    expect(chunks[1].text.startsWith('😀')).toBe(true)
  })
})
