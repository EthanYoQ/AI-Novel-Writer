import { FinalizationRepository } from '../../repositories/finalization-repository'
import { SummaryRepository } from '../../repositories/summary-repository'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrepareReviewRevisionRequest } from '../../../src/shared/review-revision-generation'
import { serializeHumanConfirmedReviewSnapshot } from '../../../src/shared/human-confirmed-review'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { getProjectDb } from '../../database'
import { ReviewRepository } from '../../repositories/review-repository'
import { textHash } from '../../repositories/generation-run-repository'
import { captureReviewRevisionContext, reviewRevisionRequest } from '../review-revision-context'
vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const connections: import('better-sqlite3').Database[] = []
afterEach(() => { connections.splice(0).forEach(db => db.close()); vi.resetAllMocks() })
function fixture() {
  const db = new Database(':memory:'); connections.push(db)
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  vi.mocked(getProjectDb).mockReturnValue(db)
  db.exec("INSERT INTO project_core(id,project_name,worldbuilding) VALUES('main','合成项目','作者世界设定'); INSERT INTO contents(id,body) VALUES(1,' 原稿\r\n结尾 '); INSERT INTO drafts(id,chapter_number,version,status,content_id) VALUES(1,2,1,'draft',1)")
  const request: PrepareReviewRevisionRequest = { operation: 'review-chapter', draftId: 1,
    expectedDraft: { chapterNumber: 2, version: 1, status: 'draft', contentHash: textHash(' 原稿\r\n结尾 ') },
    authorInputs: [{ id: 'review-focus', text: ' 保留原文\r\n ' }], uiLocale: 'zh-CN' }
  return { db, request, capture: () => captureReviewRevisionContext(db, request) }
}
function confirmation(f: ReturnType<typeof fixture>) {
  const source = f.capture().source
  const original = ReviewRepository.create({ baseDraftId: 1, content: '{"summary":"原始 AI 意见"}', expectedSource: source }, f.db)
  const content = serializeHumanConfirmedReviewSnapshot({ kind: 'human-confirmed-review', schemaVersion: 1,
    sourceReviewId: original.id, sourceDraft: source, summary: '作者确认', authorGuidance: '保持动机',
    items: [{ category: '情节', severity: 'warning', description: '修复因果', decision: 'apply', origin: 'ai' },
      { category: '风格', severity: 'warning', description: '不要采用此项', decision: 'ignore', origin: 'author' }] })
  const saved = ReviewRepository.create({ baseDraftId: 1, content, expectedSource: source }, f.db)
  Object.assign(f.request, { operation: 'refine-from-review', authorInputs: [], reviewSourceId: saved.id, confirmedReviewContent: content })
  return { source, original, saved, content }
}
describe('审修上下文实际 SQLite 捕获', () => {
  it.each(['contentHash', 'version', 'status', 'chapterNumber', 'id', 'old-version'] as const)('拒绝 UI 来源失配 %s', key => {
    const f = fixture()
    if (key === 'id') f.request.draftId = 999
    else if (key === 'old-version') f.db.exec("INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(2,2,'draft',1)")
    else Object.assign(f.request.expectedDraft, { [key]: key === 'contentHash' ? textHash('别稿') : key === 'status' ? 'finalized' : 9 })
    expect(f.capture).toThrow('GENERATION_REVIEW_SOURCE_CHANGED')
  })
  it('保留作者输入字节并隔离调用方后续改动', () => {
    const f = fixture(), context = f.capture()
    f.request.authorInputs[0]!.text = '后来编辑'
    expect(context.authorInputs[0]!.text).toBe(' 保留原文\r\n ')
    expect(reviewRevisionRequest(context).expectedDraft).toEqual(f.request.expectedDraft)
    f.request.operation = 'refine-draft'; f.request.authorInputs = [{ id: 'user-prompt', text: '直接改稿' }, { id: 'merged-guidance', text: '作者指导' }]
    expect(f.capture().authorInputs).toEqual(f.request.authorInputs)
  })
  it.each(['user-prompt', 'candidate', 'merged-guidance'])('审稿拒绝越界作者输入 %s', id => {
    const f = fixture(); f.request.authorInputs = [{ id, text: '候选不能冒充作者' }]
    expect(f.capture).toThrow('GENERATION_REVIEW_CONTEXT_INVALID')
  })
  it('只采纳活跃 ID 的作者状态，不采纳派生或退休状态', () => {
    const f = fixture()
    for (const [id, retired, kind, location] of [['active', 0, 'author', '北塔'], ['retired', 1, 'author', '旧站'], ['derived', 0, 'legacy', '猜测地点']] as const) {
      f.db.prepare('INSERT INTO characters(character_id,name,retired,cs_updated_at_chapter,cs_location,cs_provenance) VALUES(?,?,?,1,?,?)')
        .run(id, id, retired, location, JSON.stringify({ location: { kind, chapterNumber: 1 } }))
    }
    const context = f.capture()
    expect(context.characterStates).toContain('北塔'); expect(context.characterStates).not.toContain('旧站'); expect(context.characterStates).not.toContain('猜测地点')
  })
  it('冻结当前及后五章蓝图和目标，历史原文无凭据不变成事实', () => {
    const f = fixture()
    f.db.exec("INSERT INTO contents(id,body) VALUES(2,'历史正文'); INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(1,1,'finalized',2)")
    for (const chapter of [1,2,3,7,8]) f.db.prepare('INSERT INTO blueprints(chapter_number,title,key_events) VALUES(?,?,?)').run(chapter, '合成章节', '林岚抵达北塔')
    const context = f.capture()
    expect(context.blueprints.map(row => row.chapterNumber)).toEqual([2,3,7])
    expect(context.history).toEqual([expect.objectContaining({ content: '历史正文' })])
    expect(context.history[0]!.projection).toBeUndefined(); expect(context.preflightFindings).toEqual([])
    f.db.exec("UPDATE blueprints SET key_events='作者新目标'")
    expect(f.capture().frozenGoals).not.toEqual(context.frozenGoals)
    expect(context.worldbuilding).toBe('作者世界设定')
  })
  it('确认快照关联原 AI row，同 ID 的另一全局库不能混入', () => {
    const f = fixture(), c = confirmation(f)
    const wrong = new Database(f.db.serialize()); connections.push(wrong)
    wrong.exec("UPDATE contents SET body='错误全局库'")
    vi.mocked(getProjectDb).mockReturnValue(wrong)
    const context = f.capture()
    expect(context.confirmation?.originalReviewContentHash).toBe(textHash('{"summary":"原始 AI 意见"}'))
    expect(context.confirmation?.snapshot.items.map(item => item.decision)).toEqual(['apply','ignore'])
    expect(context.confirmation?.reviewSourceId).toBe(c.saved.id)
  })
  it.each(['bad-json','changed-confirmation','ignored-only','wrong-original-source'])('拒绝确认凭据错误 %s', kind => {
    const f = fixture(), c = confirmation(f)
    if (kind === 'bad-json') f.request.confirmedReviewContent = '{'
    if (kind === 'changed-confirmation') f.request.confirmedReviewContent = c.content.replace('保持动机','不同作者指导')
    if (kind === 'ignored-only') {
      const content = c.content.replaceAll('"apply"','"ignore"')
      f.db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM reviews WHERE id=?)').run(content,c.saved.id)
      f.request.confirmedReviewContent = content
    }
    if (kind === 'wrong-original-source') f.db.prepare('UPDATE reviews SET source_content=? WHERE id=?').run('别稿',c.original.id)
    expect(f.capture).toThrow('GENERATION_REVIEW_CONFIRMATION_CHANGED')
  })
})

it('当前投影提供预检事实，失效或 legacy 投影只保留同一原文', () => {
  const f = fixture(), prose = '林岚已经死亡。'
  f.db.exec("INSERT INTO characters(character_id,name) VALUES('lin','林岚'); INSERT INTO contents(id,body) VALUES(2,'待定稿'); INSERT INTO drafts(id,chapter_number,version,status,content_id) VALUES(2,1,1,'draft',2)")
  f.db.prepare('INSERT INTO blueprints(chapter_number,title,characters,key_events) VALUES(2,?,?,?)').run('归来', JSON.stringify(['林岚']), '林岚归来')
  FinalizationRepository.commit({ finalizationId: 'context-final', draftId: 2, chapterNumber: 1,
    chapterTitle: '告别', content: prose, contentHash: textHash(prose), contentRevision: 1, targetFileName: '1.txt' })
  const generation = f.db.prepare("SELECT generation FROM continuity_projection_meta WHERE id='main'").pluck().get() as number
  SummaryRepository.saveFinalizedContinuity({ draftId: 2, chapterNumber: 1, chapterNotes: '告别',
    projectionGeneration: generation, source: { draftId: 2, chapterNumber: 1, finalizationId: 'context-final', contentHash: textHash(prose) },
    facts: [{ category: 'character-state', entities: ['林岚'], statement: prose, evidence: prose, sourceChapter: 1,
      characterRefs: [{ characterId: 'lin', displayNameSnapshot: '林岚' }] }] })
  const current = f.capture()
  expect(current.history[0]!.projection?.sourceStatus).toBe('current')
  expect(current.preflightFindings).toHaveLength(1)
  f.db.exec('UPDATE continuity_projection_meta SET generation=generation+1,stale_from_chapter=1')
  const stale = f.capture()
  expect(stale.history[0]!.content).toBe(prose); expect(stale.history[0]!.projection).toBeUndefined()
  expect(stale.preflightFindings).toEqual([])
  expect(current.preflightFindings).toHaveLength(1)
  f.db.exec("UPDATE summary_snapshots SET source_finalization_id='',source_content_hash=''")
  expect(f.capture().history[0]!.projection).toBeUndefined()
})
