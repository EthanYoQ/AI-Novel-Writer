import { expect, it } from 'vitest'
import { formatRelationshipsForEditor, relationshipStorageFromEditor, parseRelationshipEdges } from '../relationship-presentation'
const identities = [{ characterId: '甲', name: '同名' }, { characterId: '乙', name: '同名' }, { characterId: '丙', name: '第三人' }]
it('同名明确目标标签往返保ID；普通同名不猜首项', () => {
 const storage = JSON.stringify([{ target: '旧名字', targetCharacterId: '乙', relation: '盟友' }])
 expect(formatRelationshipsForEditor(storage, { identities })).toBe('同名〔乙〕：盟友')
 expect(JSON.parse(relationshipStorageFromEditor('同名〔乙〕：盟友', { identities, selfCharacterId: '丙', previousStorage: storage }))[0].targetCharacterId).toBe('乙')
 expect(relationshipStorageFromEditor('同名：盟友', { identities, selfCharacterId: '丙' })).toBe('同名：盟友')
 expect(parseRelationshipEdges('同名：盟友', { identities, selfCharacterId: '丙' })).toEqual([])
})
it('改名及名字交换不改关系目标身份', () => {
 const changed = [{ characterId: '甲', name: '乙名' }, { characterId: '乙', name: '甲名' }]
 const stored = JSON.stringify([{ target: '乙名', targetCharacterId: '乙', relation: '伙伴' }])
 expect(parseRelationshipEdges(stored, { identities: changed, selfCharacterId: '甲' })).toEqual([{ target: '甲名', targetCharacterId: '乙', relation: '伙伴' }])
 expect(formatRelationshipsForEditor(stored, { identities: changed })).toBe('甲名：伙伴')
})
it('两条同名关系不会被字符串去重合并；自环按ID拒绝', () => {
 const stored = JSON.stringify([{ target: '同名', targetCharacterId: '甲', relation: '友' }, { target: '同名', targetCharacterId: '乙', relation: '友' }])
 expect(parseRelationshipEdges(stored, { identities, selfCharacterId: '丙' })).toHaveLength(2)
 expect(parseRelationshipEdges(stored, { identities, selfCharacterId: '甲' }).map(edge => edge.targetCharacterId)).toEqual(['乙'])
})
