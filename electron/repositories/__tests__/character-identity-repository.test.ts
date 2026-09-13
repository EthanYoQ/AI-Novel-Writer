import { createRequire } from 'node:module'
import { describe, it, expect, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { applyM02CharacterIdentity } from '../../migrations/m02-character-identity'
import { commitCharacterIdentities, readCharacterIdentitySnapshot, type CharacterIdentityCommitRequest } from '../character-roster-repository'
import { CharacterRepository } from '../character-repository'
const state = vi.hoisted(() => ({ db: null as import('better-sqlite3').Database | null }))
vi.mock('../../database', () => ({ getProjectDb: () => state.db }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
function fixture() {
  const db = new Database(':memory:'); state.db = db; db.pragma('foreign_keys=ON')
  db.transaction(() => { initializeLegacyBaselineSchema(db); db.exec("INSERT INTO characters(name,notes,cs_provenance) VALUES('甲','作者笔记','{\"location\":{\"kind\":\"legacy\"}}'),('乙','乙笔记','{}')"); db.prepare('UPDATE characters SET relationships=? WHERE name=?').run(JSON.stringify([{target:'乙',relation:'旧同伴'}]),'甲'); applyM02CharacterIdentity(db) })()
  const rows = db.prepare('SELECT character_id,name FROM characters ORDER BY rowid').all() as { character_id: string; name: string }[]
  const request: CharacterIdentityCommitRequest = { approval: { operationId: 'approval-1', expectedRevision: 0, action: 'author-edit', source: { kind: 'author', source: { projectId: 'p', epoch: 'e', sourceId: 'author-edit', revision: 1, contentHash: 'a'.repeat(64) } } }, changes: [], creations: [], retireIds: [], relationships: [], resolutions: [] }
  return { db, rows, request }
}
describe('approved ID character writes', () => {
  it('requires explicit main authorization and blocks legacy name-only writes', () => {
    const f = fixture(); try {
      expect(() => commitCharacterIdentities(f.db, f.request)).toThrow('CHARACTER_APPROVAL_REQUIRED')
      expect(() => CharacterRepository.delete('甲')).toThrow('CHARACTER_ID_WRITE_REQUIRED')
      expect(CharacterRepository.getByName('甲')).toBeNull()
      expect(CharacterRepository.getByName('甲', 'legacy:characters:0')?.characterId).toBe(f.rows[0].character_id)
    } finally { f.db.close() }
  })
  it('swaps names without changing identities or dynamic provenance and replays approval once', () => {
    const f = fixture(); try {
      f.request.changes = f.rows.map((row, index) => ({ characterId: row.character_id, fields: { name: index === 0 ? '乙' : '甲' } }))
      const receipt = commitCharacterIdentities(f.db, f.request, () => true)
      expect(commitCharacterIdentities(f.db, f.request, () => true)).toEqual({ ...receipt, idempotent: true })
      expect(CharacterRepository.getById(f.rows[0].character_id)?.name).toBe('乙')
      expect(f.db.prepare('SELECT cs_provenance FROM characters WHERE character_id=?').pluck().get(f.rows[0].character_id)).toBe('{"location":{"kind":"legacy"}}')
      expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(2)
      expect(() => commitCharacterIdentities(f.db, { ...f.request, retireIds: [f.rows[0].character_id] }, () => true)).toThrow('CHARACTER_APPROVAL_NONCE_CONFLICT')
    } finally { f.db.close() }
  })
  it('creates two same-display-name identities and preserves generated origin after adoption', () => {
    const f = fixture(); try {
      f.request.approval.action = 'adopt-generated'
      f.request.approval.source = { kind: 'generated', source: { projectId: 'p', epoch: 'e', sourceId: 'candidate', revision: 1, contentHash: 'a'.repeat(64) }, modelRevision: 'b'.repeat(64) }
      f.request.creations = [{ selectionKey: 'one', fields: { name: '队长' } }, { selectionKey: 'two', fields: { name: '队长' } }]
      const result = commitCharacterIdentities(f.db, f.request, () => true)
      expect(new Set(result.created.map(item => item.characterId)).size).toBe(2)
      expect(CharacterRepository.getByName('队长', 'approval-1')).toBeNull()
      expect(f.db.prepare("SELECT static_provenance FROM characters WHERE name='队长'").all()).toHaveLength(2)
      expect(JSON.parse(f.db.prepare("SELECT static_provenance FROM characters WHERE name='队长' LIMIT 1").pluck().get() as string).kind).toBe('generated')
    } finally { f.db.close() }
  })
  it('rolls back creations and approval if a relationship cannot bind; retirement keeps historical values', () => {
    const f = fixture(); try {
      f.request.creations = [{ selectionKey: 'new', fields: { name: '新增' } }]
      f.request.relationships = [{ sourceCharacterId: f.rows[0].character_id, targetCharacterId: 'missing', relation: '同伴' }]
      expect(() => commitCharacterIdentities(f.db, f.request, () => true)).toThrow('CHARACTER_ID_UNKNOWN')
      expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(2)
      expect(readCharacterIdentitySnapshot(f.db).revision).toBe(0)
      expect(f.db.prepare('SELECT COUNT(*) FROM character_identity_approvals').pluck().get()).toBe(0)
      f.request.creations = []; f.request.relationships = []; f.request.retireIds = [f.rows[0].character_id]
      commitCharacterIdentities(f.db, f.request, () => true)
      expect(CharacterRepository.getById(f.rows[0].character_id)).toBeNull()
      expect(f.db.prepare('SELECT notes FROM characters WHERE character_id=?').pluck().get(f.rows[0].character_id)).toBe('作者笔记')
    } finally { f.db.close() }
  })
})


it('commits new identities, relation remapping and approval together without losing old display snapshots', () => {
  const f = fixture(); try {
    f.request.creations = [{ selectionKey: 'one', fields: { name: '队长' } }, { selectionKey: 'two', fields: { name: '队长' } }]
    f.request.relationships = [{ sourceSelectionKey: 'one', targetSelectionKey: 'two', relation: '同伴' }]
    const receipt = commitCharacterIdentities(f.db, f.request, () => true)
    const relation = f.db.prepare('SELECT * FROM character_relationships').get() as { source_character_id: string; target_character_id: string; source_display_snapshot: string }
    expect(relation.source_character_id).toBe(receipt.created[0].characterId)
    expect(relation.target_character_id).toBe(receipt.created[1].characterId)
    const next = { ...f.request, approval: { ...f.request.approval, operationId: 'rename', expectedRevision: 1 }, creations: [], relationships: [], changes: [{ characterId: receipt.created[0].characterId, fields: { name: '新名字' } }] }
    commitCharacterIdentities(f.db, next, () => true)
    expect((f.db.prepare('SELECT source_display_snapshot FROM character_relationships').get() as { source_display_snapshot: string }).source_display_snapshot).toBe('队长')
    expect(f.db.pragma('foreign_key_check')).toEqual([])
  } finally { f.db.close() }
})
it('rejects damaged generated provenance and keeps a pending legacy relation unchanged on rejected approval', () => {
  const f = fixture(); try {
    f.request.approval.action = 'adopt-generated'
    f.request.approval.source = { kind: 'generated', source: { projectId: 'p', epoch: 'e', sourceId: 'candidate', revision: 1, contentHash: 'invalid' }, modelRevision: 'b'.repeat(64) }
    expect(() => commitCharacterIdentities(f.db, f.request, () => true)).toThrow('CHARACTER_PROVENANCE_INVALID')
    expect(readCharacterIdentitySnapshot(f.db).revision).toBe(0)
  } finally { f.db.close() }
})

it('resolves a legacy relationship only on explicit identity approval and atomically stores its ID edge', () => {
  const f = fixture(); try {
    const proposal = f.db.prepare('SELECT proposal_id FROM character_identity_proposals').get() as { proposal_id: string }
    f.request.resolutions = [{ proposalId: proposal.proposal_id, characterId: f.rows[1].character_id }]
    expect(() => commitCharacterIdentities(f.db, f.request, () => true)).toThrow('CHARACTER_ID_CONFIRMATION_REQUIRED')
    f.request.approval.action = 'confirm-identity'
    const receipt = commitCharacterIdentities(f.db, f.request, () => true)
    expect(f.db.prepare('SELECT source_character_id,target_character_id,relation FROM character_relationships').get()).toEqual({source_character_id:f.rows[0].character_id,target_character_id:f.rows[1].character_id,relation:'旧同伴'})
    expect(commitCharacterIdentities(f.db, f.request, () => true).idempotent).toBe(true)
    expect(f.db.prepare('SELECT COUNT(*) FROM character_relationships').pluck().get()).toBe(1)
    expect(receipt.approval.source.kind).toBe('author')
    expect(f.db.prepare('SELECT relationships FROM characters WHERE character_id=?').pluck().get(f.rows[0].character_id)).toBe(JSON.stringify([{target:'乙',relation:'旧同伴'}]))
  } finally { f.db.close() }
})

it.each([
  ['confirm-identity', 'invented'], ['confirm-identity', 'generated'], ['author-edit', 'derived'],
  ['adopt-generated', 'author'], ['adopt-import', 'author'], ['adopt-import', 'legacy'],
] as const)('rejects invalid approval action/source pair %s/%s with no durable effect', (action, kind) => {
  const f = fixture(); try {
    f.request.approval.action = action
    f.request.approval.source = { kind, source: { projectId: 'p', epoch: 'e', sourceId: 'source', revision: 1, contentHash: 'a'.repeat(64) }, modelRevision: 'b'.repeat(64) } as never
    f.request.creations = [{ selectionKey: 'new', fields: { name: '不能落盘' } }]
    expect(() => commitCharacterIdentities(f.db, f.request, () => true)).toThrow('CHARACTER_PROVENANCE_INVALID')
    expect(readCharacterIdentitySnapshot(f.db).revision).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(2)
    expect(f.db.prepare('SELECT COUNT(*) FROM character_identity_approvals').pluck().get()).toBe(0)
  } finally { f.db.close() }
})
