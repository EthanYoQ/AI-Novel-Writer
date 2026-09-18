import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { CharacterRosterRepository, refreshCharacterIdentityProjection } from '../../repositories/character-roster-repository'
import { commitAuthorCharacterRoster } from '../character-roster-author'
import type { CharacterRosterCommitRequest } from '../../../src/shared/character-roster'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()))
const scope = { projectId: '合成项目', epoch: '原会话' }
function fixture() {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s09c-author-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'author-'))
  prepareCanonicalStorageFixture(root)
  const file = path.join(root, '.ai-novel', 'project.db')
  let db = new Database(file)
  db.pragma('foreign_keys=ON')
  db.exec("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','合成角色','zh-CN')")
  db.prepare('INSERT INTO characters(character_id,name,background,notes,relationships,cs_location,cs_updated_at_chapter,cs_provenance) VALUES(?,?,?,?,?,?,?,?)')
    .run('甲ID', '沈砺', '北塔守卫', '  原作者笔记\r\n', '  模糊旧关系原文\r\n', '矿场', 1, JSON.stringify({ location: { kind: 'legacy' } }))
  db.exec("INSERT INTO characters(character_id,name,background) VALUES('乙ID','沈砺','南港医者'); INSERT INTO character_aliases VALUES('甲ID','沈砺','原甲',0,NULL),('乙ID','沈砺','原乙',0,NULL)")
  db.transaction(() => refreshCharacterIdentityProjection(db))()
  cleanup.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { get db() { return db }, reopen() { db.close(); db = new Database(file); db.pragma('foreign_keys=ON') },
    request(operationId = '作者保存'): CharacterRosterCommitRequest {
      const read = CharacterRosterRepository.read(db)
      return { operationId, schemaVersion: 1, intent: 'manual_edit', expectedRevision: read.revision,
        expectedIdentityRevision: read.identityRevision, entries: structuredClone(read.entries) }
    } }
}
const facts = (db: import('better-sqlite3').Database) => ({ characters: db.prepare('SELECT * FROM characters ORDER BY character_id').all(),
  aliases: db.prepare('SELECT * FROM character_aliases ORDER BY character_id,name,valid_from').all(),
  relations: db.prepare('SELECT * FROM character_relationships ORDER BY relationship_id').all(),
  receipts: db.prepare('SELECT * FROM character_identity_approvals ORDER BY operation_id').all(),
  identity: db.prepare('SELECT * FROM character_identity_meta').all(), roster: db.prepare('SELECT * FROM character_roster_meta').all(), core: db.prepare('SELECT * FROM project_core').all() })
const save = (f: ReturnType<typeof fixture>, request = f.request()) => commitAuthorCharacterRoster(f.db, request, scope, () => {})

it('read补ID及别名不改变原投影hash或写库；同名两人不折叠', () => {
  const f = fixture(), before = facts(f.db), changes = f.db.prepare('SELECT total_changes()').pluck().get()
  const read = CharacterRosterRepository.read(f.db)
  expect(read.status).toBe('ready'); expect(read.identityRevision).toBe(0)
  expect(read.entries.map(item => item.characterId).sort()).toEqual(['乙ID', '甲ID'])
  expect(read.aliases).toHaveLength(2); expect(facts(f.db)).toEqual(before)
  expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
})
it('按ID改名、关系同名目标保持独立；原字节和未改动态来源保留', () => {
  const f = fixture(), request = f.request()
  request.entries.find(entry => entry.characterId === '甲ID')!.relationships = [{ target: '沈砺', targetCharacterId: '乙ID', relation: '同伴' }]
  const first = save(f, request)
  const relation = f.db.prepare('SELECT * FROM character_relationships').get()
  const second = f.request('改名'); second.entries.find(entry => entry.characterId === '甲ID')!.name = '沈医'
  second.entries.find(entry => entry.characterId === '乙ID')!.name = '沈卫'
  const saved = save(f, second)
  expect(saved.snapshot.entries.find(entry => entry.characterId === '甲ID')).toMatchObject({ name: '沈医', notes: '  原作者笔记\r\n',
    legacyRelationshipNotes: '  模糊旧关系原文\r\n', currentState: { location: '矿场', provenance: { location: { kind: 'legacy' } } },
    relationships: [{ target: '沈卫', targetCharacterId: '乙ID', relation: '同伴' }] })
  expect(f.db.prepare('SELECT * FROM character_relationships').get()).toEqual(relation)
  expect(first.snapshot.entries.map(entry => entry.name)).toEqual(['沈砺', '沈砺'])
})
it('新draft ID由main生成正式ID且一次批准内重映射关系，重开原ACK不重写后续作者变更', () => {
  const f = fixture(), request = f.request(), draft = 'draft:12345678-1234-4234-9234-123456789012'
  request.entries.push({ ...structuredClone(request.entries[0]), characterId: draft, name: '新人物', currentState: undefined,
    relationships: [{ target: '沈砺', targetCharacterId: '乙ID', relation: '受托' }] })
  const first = save(f, request), id = first.created![0].characterId
  expect(id).toMatch(/^[a-f0-9-]{36}$/u); expect(id).not.toBe(draft)
  expect(first.created).toEqual([{ selectionKey: draft, characterId: id }])
  const later = f.request('后续作者变更'); later.entries.find(entry => entry.characterId === id)!.notes = '后续内容'
  save(f, later); f.reopen()
  const before = facts(f.db), changes = f.db.prepare('SELECT total_changes()').pluck().get()
  expect(commitAuthorCharacterRoster(f.db, request, { ...scope, epoch: '重开会话' }, () => {})).toEqual({ ...first, idempotent: true })
  expect(facts(f.db)).toEqual(before); expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
})
it('删除退休ID而不删除原角色/历史边；剩余同名角色不受影响', () => {
  const f = fixture(), initial = f.request()
  initial.entries.find(entry => entry.characterId === '甲ID')!.relationships = [{ target: '沈砺', targetCharacterId: '乙ID', relation: '旧相识' }]
  save(f, initial)
  const request = f.request('删除甲'); request.entries = request.entries.filter(entry => entry.characterId !== '甲ID')
  const before = f.db.prepare('SELECT * FROM character_relationships').all(), saved = save(f, request)
  expect(saved.snapshot.entries.map(entry => entry.characterId)).toEqual(['乙ID'])
  expect(f.db.prepare("SELECT retired FROM characters WHERE character_id='甲ID'").pluck().get()).toBe(1)
  expect(f.db.prepare('SELECT * FROM character_relationships').all()).toEqual(before)
})
it('作者仅修改动态location时按字段标author，不能伪造其他字段provenance', () => {
  const f = fixture(), request = f.request(), entry = request.entries.find(item => item.characterId === '甲ID')!
  entry.currentState!.location = '南港'; entry.currentState!.provenance = { mentalState: { kind: 'author', chapterNumber: 99 } }
  const saved = save(f, request).snapshot.entries.find(item => item.characterId === '甲ID')!
  expect(saved.currentState!.provenance).toEqual({ location: { kind: 'author', chapterNumber: 1 } })
})
it.each(['missing-id', 'unknown-id', 'name-only-relation', 'stale-roster', 'stale-identity', 'duplicate-id'] as const)('拒绝%s且零写', mode => {
  const f = fixture(), request = f.request(), before = facts(f.db)
  if (mode === 'missing-id') delete request.entries[0].characterId
  if (mode === 'unknown-id') request.entries[0].characterId = '不属于此项目'
  if (mode === 'name-only-relation') request.entries[0].relationships = [{ target: '沈砺', relation: '同伴' }]
  if (mode === 'stale-roster') request.expectedRevision--
  if (mode === 'stale-identity') request.expectedIdentityRevision = 9
  if (mode === 'duplicate-id') request.entries[1].characterId = request.entries[0].characterId
  expect(() => save(f, request)).toThrow(); expect(facts(f.db)).toEqual(before)
})
it('项目会话过期在写入前拒绝', () => {
  const f = fixture(), before = facts(f.db), assert = vi.fn(() => { throw new Error('STALE_SESSION') })
  expect(() => commitAuthorCharacterRoster(f.db, f.request(), scope, assert)).toThrow('STALE_SESSION')
  expect(facts(f.db)).toEqual(before)
})
it('事务末尾失败回滚静态、动态、关系、退休及全部ACK', () => {
  const f = fixture(), request = f.request(), before = facts(f.db)
  request.entries[0].notes = '不能落盘'; request.entries[0].currentState = { location: '新位置', powerLevel: '', physicalState: '', mentalState: '', keyItems: '', recentEvents: '', updatedAtChapter: 2 }
  request.entries = [request.entries[0]]
  f.db.exec("CREATE TRIGGER reject_author_ack BEFORE INSERT ON character_identity_approvals WHEN NEW.operation_id LIKE 'author-roster-request:%' BEGIN SELECT RAISE(ABORT,'FINAL_ACK_FAILED'); END")
  expect(() => save(f, request)).toThrow('FINAL_ACK_FAILED'); expect(facts(f.db)).toEqual(before)
})
it.each(['request', 'receipt', 'effect'] as const)('历史%s被改不能假ACK或重写', mode => {
  const f = fixture(), request = f.request(); save(f, request)
  if (mode === 'request') request.entries[0].notes = '不同payload'
  if (mode === 'receipt') {
    const text = f.db.prepare("SELECT receipt_json FROM character_identity_approvals WHERE operation_id='author-roster-request:作者保存'").pluck().get() as string
    const envelope = JSON.parse(text); envelope.receipt.created.push({ selectionKey: '伪', characterId: '伪' })
    f.db.prepare("UPDATE character_identity_approvals SET receipt_json=? WHERE operation_id='author-roster-request:作者保存'").run(JSON.stringify(envelope))
  }
  if (mode === 'effect') f.db.exec("UPDATE character_identity_approvals SET payload_hash='被改' WHERE operation_id='author-roster-effect:作者保存'")
  const before = facts(f.db); expect(() => save(f, request)).toThrow(); expect(facts(f.db)).toEqual(before)
})
