import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { getProjectDb } from '../../database'
import { FinalizationRepository } from '../finalization-repository'
import { SummaryRepository, invalidateContinuityProjectionFrom } from '../summary-repository'
import { parseFinalizedCharacterStateResponse, type FinalizedCharacterContext } from '../../../src/shared/finalized-continuity'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
type Db = import('better-sqlite3').Database
const open: Db[] = []
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const scope = { projectId: 'synthetic-s09b', epoch: 'epoch-1' }
const prose = '🌙林岚走进北塔。周研留在旧站。'
afterEach(() => { for (const db of open.splice(0)) db.close(); vi.restoreAllMocks() })

function draft(db: Db, id = 1, chapter = 1, content = prose, version = 1) {
  db.prepare('INSERT OR IGNORE INTO blueprints(chapter_number,title) VALUES(?,?)').run(chapter, '合成章节')
  db.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(id, '尚未定稿')
  db.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(?,?,?,'draft',?,0)").run(id, chapter, version, id)
  return { finalizationId: `finalization-${id}`, draftId: id, chapterNumber: chapter, chapterTitle: '合成章节', content,
    contentHash: hash(content), contentRevision: 1, targetFileName: `${chapter}.txt` }
}

function fixture(options: { sameName?: boolean; finalize?: boolean } = {}) {
  const db = new Database(':memory:'); open.push(db)
  vi.mocked(getProjectDb).mockReturnValue(db)
  initializeLegacyBaselineSchema(db)
  db.exec("INSERT INTO characters(name,notes) VALUES('林岚','作者静态档案'),('周研','另一份静态档案')")
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.exec("INSERT INTO project_core(id,project_name,characters_arch) VALUES('main','合成项目','作者尚未刷新静态Markdown')")
  const ids = ['林岚', '周研'].map(name => db.prepare('SELECT character_id FROM characters WHERE name=?').pluck().get(name) as string)
  if (options.sameName) db.prepare('UPDATE characters SET name=? WHERE character_id=?').run('林岚', ids[1])
  const request = draft(db)
  if (options.finalize !== false) FinalizationRepository.commit(request)
  const context = () => SummaryRepository.readFinalizedCharacterContext(1, scope, db)
  const response = (captured: FinalizedCharacterContext, currentState: Record<string, unknown>, id = ids[0], extra = {}) =>
    parseFinalizedCharacterStateResponse(JSON.stringify({ updates: [{ characterId: id, currentState,
      evidence: { start: 2, end: 9, text: prose.slice(2, 9) }, ...extra }] }), captured)
  const saveNotes = () => SummaryRepository.saveFinalizedContinuity({ draftId: 1, chapterNumber: 1, chapterNotes: '绑定定稿的摘要',
    facts: [], source: context().source, projectionGeneration: context().projectionGeneration })
  const row = (id = ids[0]) => db.prepare('SELECT * FROM characters WHERE character_id=?').get(id) as Record<string, unknown>
  return { db, ids, request, context, response, saveNotes, row }
}

describe('finalized character identities and derived state in the M02 database', () => {
  it.each(['rename', 'name-swap'] as const)('preserves frozen source identities through a later %s', kind => {
    const f = fixture(), before = f.context()
    const receiptBefore = f.db.prepare('SELECT * FROM finalization_outbox').get()
    f.db.prepare('UPDATE characters SET name=? WHERE character_id=?').run(kind === 'rename' ? '作者的新名' : '周研', f.ids[0])
    if (kind === 'name-swap') f.db.prepare('UPDATE characters SET name=? WHERE character_id=?').run('林岚', f.ids[1])
    const captured = f.context()
    expect(captured.characters).toEqual(before.characters)
    expect(SummaryRepository.commitFinalizedCharacterStates(captured, f.response(captured, { location: '北塔' }), f.db)).toMatchObject({ applied: 1 })
    expect(f.row()).toMatchObject({ name: kind === 'rename' ? '作者的新名' : '周研', cs_location: '北塔', notes: '作者静态档案' })
    expect(f.row(f.ids[1]).cs_location).toBe('')
    expect(f.db.prepare('SELECT body FROM contents WHERE id=1').pluck().get()).toBe(prose)
    expect(f.db.prepare('SELECT * FROM finalization_outbox').get()).toEqual(receiptBefore)
    expect(f.db.prepare("SELECT characters_arch FROM project_core WHERE id='main'").pluck().get()).toBe('作者尚未刷新静态Markdown')
  })

  it('retains two same-name source people as an unresolved occurrence, even with a model ID', () => {
    const f = fixture({ sameName: true }), context = f.context()
    const result = f.response(context, { location: '北塔' }, f.ids[0], { name: '林岚' })
    expect(result.updates).toEqual([])
    expect(result.unresolved).toMatchObject([{ selectionKey: 'update:0', displayName: '林岚', reason: 'ambiguous', candidateIds: expect.arrayContaining(f.ids) }])
    const withoutModelName = f.response(context, { location: '北塔' })
    expect(withoutModelName.unresolved).toMatchObject([{ displayName: '林岚', originalText: '', reason: 'ambiguous', rawValue: { characterId: f.ids[0] } }])
    expect(withoutModelName.unresolved[0].rawValue).not.toHaveProperty('name')
    expect(SummaryRepository.commitFinalizedCharacterStates(context, result, f.db)).toMatchObject({ applied: 0 })
    expect(f.row().cs_location).toBe('')
    expect(() => SummaryRepository.saveFinalizedContinuity({ draftId: 1, chapterNumber: 1, chapterNotes: '不可消歧', projectionGeneration: 0,
      source: context.source, facts: [{ category: 'character-state', entities: ['林岚'], characterRefs: [{ characterId: f.ids[0], displayNameSnapshot: '林岚' }],
        statement: '林岚走进北塔', sourceChapter: 1, evidence: prose.slice(2, 9) }] })).toThrow('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
  })

  it('keeps name-only and unknown-ID output raw without resolving names or inventing one', () => {
    const f = fixture(), context = f.context()
    const input = { updates: [{ name: ' 林岚 ', currentState: { location: '北塔' }, evidence: { start: 2, end: 9, text: prose.slice(2, 9) } },
      { characterId: 'unknown-id', currentState: { keyItems: '钥匙' }, evidence: { start: 2, end: 9, text: prose.slice(2, 9) } }] }
    const parsed = parseFinalizedCharacterStateResponse(JSON.stringify(input), context)
    expect(parsed.updates).toEqual([])
    expect(parsed.unresolved).toMatchObject([{ displayName: ' 林岚 ', rawValue: input.updates[0], reason: 'name-only' },
      { displayName: '', originalText: '', rawValue: input.updates[1], reason: 'unknown-id' }])
  })

  it('uses UTF-16 offsets and refuses a normalized or miscounted source quotation', () => {
    const f = fixture(), context = f.context()
    expect(f.response(context, { location: '  北塔\n' }).updates[0].currentState.location).toBe('  北塔\n')
    for (const evidence of [{ start: 1, end: 8, text: prose.slice(2, 9) }, { start: 2, end: 9, text: prose.slice(2, 9).replace('林岚', '林嵐') }]) {
      expect(() => f.response(context, { location: '北塔' }, f.ids[0], { evidence })).toThrow('FINALIZED_CHARACTER_EVIDENCE_INVALID')
    }
  })

  it.each(['林岚走进北塔。', '🌙林岚走进北塔。'])('locates one exact source quotation without asking the model to count offsets: %s', quote => {
    const f = fixture(), context = f.context()
    const response = f.response(context, { location: '北塔' }, f.ids[0], { evidence: { text: quote } })
    expect(response.updates[0].evidence).toEqual({ start: prose.indexOf(quote), end: prose.indexOf(quote) + quote.length, text: quote })
    expect(SummaryRepository.commitFinalizedCharacterStates(context, response, f.db)).toMatchObject({ applied: 1 })
  })

  it('never picks the first repeated quotation or repairs an explicit incomplete offset', () => {
    const f = fixture(), context = f.context()
    expect(() => f.response(context, { location: '北塔' }, f.ids[0], { evidence: { text: '。' } })).toThrow('EVIDENCE_NOT_UNIQUE')
    for (const evidence of [{ text: '' }, { start: 2, text: '林岚走进北塔。' }]) {
      expect(() => f.response(context, { location: '北塔' }, f.ids[0], { evidence })).toThrow('EVIDENCE_INVALID')
    }
  })

  it('protects author and nonempty legacy values, derives only allowed fields, and replays idempotently', () => {
    const f = fixture()
    f.db.prepare('UPDATE characters SET cs_location=?,cs_power_level=?,cs_provenance=? WHERE character_id=?')
      .run('作者地点', '旧卡能力', JSON.stringify({ location: { kind: 'author', chapterNumber: 0, revision: 3 } }), f.ids[0])
    f.saveNotes()
    const context = f.context(), response = f.response(context, { location: '北塔', powerLevel: '推断能力', keyItems: '  钥匙\n' })
    const commit = () => SummaryRepository.commitFinalizedCharacterStates(context, response, f.db)
    const first = commit()
    expect(first).toMatchObject({ applied: 1, unchanged: 0, candidates: [
      { characterId: f.ids[0], reason: 'author-protected', selectionKey: `state:${f.ids[0]}:location`, displayName: '林岚', rawValue: expect.any(Object) },
      { characterId: f.ids[0], reason: 'legacy-protected' },
    ] })
    expect(f.row()).toMatchObject({ cs_location: '作者地点', cs_power_level: '旧卡能力', cs_key_items: '  钥匙\n' })
    expect(JSON.parse(f.row().cs_provenance as string).keyItems).toEqual({ kind: 'derived', source: context.source, revision: 1, sourceOrder: context.sourceOrder })
    expect(commit()).toMatchObject({ applied: 0, unchanged: 1, candidates: first.candidates })
    expect(SummaryRepository.listFinalizedContinuityBefore(2)[0].characterStateCandidates).toHaveLength(2)
    expect(f.db.prepare('SELECT COUNT(*) FROM character_identity_approvals').pluck().get()).toBe(0)
  })

  it.each(['field', 'watermark', 'body', 'retired'] as const)('refuses %s changes after context capture with no partial state write', kind => {
    const f = fixture(), context = f.context(), response = f.response(context, { location: '北塔', recentEvents: '到达北塔' })
    if (kind === 'field') f.db.prepare('UPDATE characters SET cs_recent_events=? WHERE character_id=?').run('作者新值', f.ids[0])
    if (kind === 'watermark') invalidateContinuityProjectionFrom(f.db, 1)
    if (kind === 'body') f.db.prepare('UPDATE contents SET body=? WHERE id=1').run('作者修改正文')
    if (kind === 'retired') f.db.prepare('UPDATE characters SET retired=1 WHERE character_id=?').run(f.ids[0])
    expect(() => SummaryRepository.commitFinalizedCharacterStates(context, response, f.db)).toThrow(/FINALIZED_CHARACTER/)
    expect(f.row().cs_location).toBe('')
    if (kind === 'field') expect(f.row().cs_recent_events).toBe('作者新值')
  })

  it('rejects earlier finalized output after later source order and rolls back any preceding field update', () => {
    const f = fixture(), earlier = f.context()
    FinalizationRepository.commit(draft(f.db, 2, 2))
    const later = SummaryRepository.readFinalizedCharacterContext(2, scope, f.db)
    SummaryRepository.commitFinalizedCharacterStates(later, f.response(later, { recentEvents: '第二章事件' }), f.db)
    expect(() => SummaryRepository.commitFinalizedCharacterStates(earlier, f.response(earlier, { location: '旧站', recentEvents: '第一章事件' }), f.db))
      .toThrow('FINALIZED_CHARACTER_SOURCE_CONFLICT')
    expect(f.row()).toMatchObject({ cs_location: '', cs_recent_events: '第二章事件' })
  })

  it('clears an explicit empty derived field while preserving omitted fields and static author facts', () => {
    const f = fixture(), first = f.context()
    SummaryRepository.commitFinalizedCharacterStates(first, f.response(first, { location: '北塔', keyItems: '旧钥匙' }), f.db)
    FinalizationRepository.commit(draft(f.db, 2, 2))
    const later = SummaryRepository.readFinalizedCharacterContext(2, scope, f.db)
    expect(SummaryRepository.commitFinalizedCharacterStates(later, f.response(later, { keyItems: '' }), f.db)).toMatchObject({ applied: 1 })
    expect(f.row()).toMatchObject({ cs_key_items: '', cs_location: '北塔', notes: '作者静态档案' })
  })

  it('preserves legacy name projections as legacy and never backfills a missing identity receipt on retry', () => {
    const f = fixture(); f.saveNotes()
    const nameFact = { category: 'character-state', entities: ['林岚'], statement: '到北塔', sourceChapter: 1, evidence: prose.slice(2, 9) }
    f.db.prepare('UPDATE summary_snapshots SET continuity_facts=? WHERE draft_id=1').run(JSON.stringify([nameFact]))
    expect(SummaryRepository.listFinalizedContinuityBefore(2)[0]).toMatchObject({ sourceStatus: 'legacy', facts: [nameFact] })
    f.db.prepare('DELETE FROM character_identity_proposals WHERE proposal_id=?').run('fcs:finalization-1')
    FinalizationRepository.commit(f.request)
    expect(f.context()).toMatchObject({ identityStatus: 'legacy', characters: [] })
    expect(f.response(f.context(), { location: '北塔' }).unresolved).toMatchObject([{ reason: 'legacy' }])
    expect(f.db.prepare("SELECT COUNT(*) FROM character_identity_proposals WHERE source_key='finalized-character-snapshot:v1'").pluck().get()).toBe(0)
  })

  it('keeps proven continuity ID references after a name swap and rejects forged receipt hashes', () => {
    const f = fixture(), context = f.context()
    const fact = { category: 'character-state' as const, entities: ['林岚'], characterRefs: [{ characterId: f.ids[0], displayNameSnapshot: '林岚' }],
      statement: '到北塔', sourceChapter: 1, evidence: prose.slice(2, 9) }
    SummaryRepository.saveFinalizedContinuity({ draftId: 1, chapterNumber: 1, chapterNotes: '角色到北塔', facts: [fact], source: context.source, projectionGeneration: 0 })
    f.db.prepare('UPDATE characters SET name=? WHERE character_id=?').run('周研', f.ids[0])
    f.db.prepare('UPDATE characters SET name=? WHERE character_id=?').run('林岚', f.ids[1])
    expect(SummaryRepository.listFinalizedContinuityBefore(2)[0]).toMatchObject({ sourceStatus: 'current', facts: [fact] })
    f.db.prepare('UPDATE summary_snapshots SET continuity_facts=? WHERE draft_id=1').run(JSON.stringify([
      { ...fact, entities: ['陌生人'], characterRefs: [{ characterId: f.ids[0], displayNameSnapshot: '陌生人' }] },
    ]))
    expect(SummaryRepository.listFinalizedContinuityBefore(2)[0].sourceStatus).toBe('stale')
    f.db.prepare('UPDATE character_identity_proposals SET source_hash=? WHERE proposal_id=?').run('a'.repeat(64), 'fcs:finalization-1')
    expect(() => f.context()).toThrow('FINALIZED_CHARACTER_SNAPSHOT_INVALID')
    expect(SummaryRepository.listFinalizedContinuityBefore(2)[0].sourceStatus).toBe('stale')
  })

  it('commits one immutable identity receipt with the outbox and rolls both back on storage failure', () => {
    const f = fixture({ finalize: false })
    f.db.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON character_identity_proposals WHEN NEW.source_key='finalized-character-snapshot:v1' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_RECEIPT_FAILURE'); END")
    expect(() => FinalizationRepository.commit(f.request)).toThrow('SYNTHETIC_RECEIPT_FAILURE')
    expect(f.db.prepare('SELECT COUNT(*) FROM finalization_outbox').pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT status FROM drafts WHERE id=1').pluck().get()).toBe('draft')
    expect(f.db.prepare('SELECT body FROM contents WHERE id=1').pluck().get()).toBe('尚未定稿')
    f.db.exec('DROP TRIGGER reject_snapshot')
    FinalizationRepository.commit(f.request)
    const snapshot = f.db.prepare("SELECT * FROM character_identity_proposals WHERE proposal_id='fcs:finalization-1'").get()
    FinalizationRepository.commit(f.request)
    expect(f.db.prepare("SELECT * FROM character_identity_proposals WHERE proposal_id='fcs:finalization-1'").get()).toEqual(snapshot)
    expect(f.db.prepare('SELECT COUNT(*) FROM finalization_outbox').pluck().get()).toBe(1)
    expect(f.db.prepare('SELECT body FROM contents WHERE id=1').pluck().get()).toBe(prose)
  })
})
