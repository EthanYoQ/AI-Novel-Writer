import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { getProjectDb } from '../database'
import type {
  FinalizedCharacterStateCandidate,
  FinalizedContinuityFact,
  FinalizedContinuityProjection,
  FinalizedSourceIdentity,
  FinalizedSourceReadResult,
  FinalizedSourceSnapshot,
  SaveFinalizedCharacterStateCandidatesRequest,
  SaveFinalizedContinuityRequest,
} from '../../src/shared/finalized-continuity'
import {
  CHARACTER_STATE_TEXT_FIELDS,
  characterRosterIdentityKey,
  type CharacterStateTextField,
} from '../../src/shared/character-roster'

const FACT_CATEGORIES = new Set(['character-state', 'timeline', 'open-thread', 'plot'])
const CHARACTER_STATE_FIELDS = new Set<string>(CHARACTER_STATE_TEXT_FIELDS)

function normalizedFacts(value: unknown, chapterNumber: number): FinalizedContinuityFact[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('连续性事实参数无效')
  return value.map((input) => {
    if (!input || typeof input !== 'object') throw new Error('连续性事实参数无效')
    const fact = input as Record<string, unknown>
    const entities = Array.isArray(fact.entities)
      ? fact.entities.map(entity => typeof entity === 'string' ? entity.trim() : '')
      : []
    const statement = typeof fact.statement === 'string' ? fact.statement.trim() : ''
    const evidence = typeof fact.evidence === 'string' ? fact.evidence.trim() : ''
    if (
      !FACT_CATEGORIES.has(String(fact.category))
      || fact.sourceChapter !== chapterNumber
      || entities.length > 8
      || entities.some(entity => !entity || entity.length > 80)
      || !statement
      || statement.length > 280
      || !evidence
      || evidence.length > 240
    ) throw new Error('连续性事实参数无效')
    return {
      category: fact.category as FinalizedContinuityFact['category'],
      entities: [...new Set(entities)],
      statement,
      sourceChapter: chapterNumber,
      evidence,
    }
  })
}

function parseFacts(value: string, chapterNumber: number): FinalizedContinuityFact[] {
  try {
    return normalizedFacts(JSON.parse(value) as unknown, chapterNumber)
  } catch {
    return []
  }
}

function parseCharacterStateCandidates(value: string): FinalizedCharacterStateCandidate[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((input) => {
      if (!input || typeof input !== 'object') return []
      const candidate = input as Record<string, unknown>
      return typeof candidate.characterName === 'string'
        && Boolean(candidate.characterName.trim())
        && CHARACTER_STATE_FIELDS.has(String(candidate.field))
        && typeof candidate.value === 'string'
        ? [{
            characterName: candidate.characterName.trim(),
            field: candidate.field as CharacterStateTextField,
            value: candidate.value.trim(),
          }]
        : []
    })
  } catch {
    return []
  }
}

function normalizeCharacterStateCandidates(
  db: BetterSqlite3.Database,
  value: unknown,
): FinalizedCharacterStateCandidate[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error('角色状态候选参数无效')
  const byIdentity = new Map<string, string>()
  for (const { name } of db.prepare('SELECT name FROM characters').all() as Array<{ name: string }>) {
    const identity = characterRosterIdentityKey(name)
    if (!identity || byIdentity.has(identity)) throw new Error('角色名单存在同名冲突')
    byIdentity.set(identity, name)
  }
  const normalized = new Map<string, FinalizedCharacterStateCandidate>()
  for (const input of value as FinalizedCharacterStateCandidate[]) {
    if (!input || typeof input !== 'object') throw new Error('角色状态候选参数无效')
    const characterName = typeof input.characterName === 'string' ? input.characterName.trim() : ''
    const storedName = byIdentity.get(characterRosterIdentityKey(characterName))
    if (!storedName || !CHARACTER_STATE_FIELDS.has(String(input.field)) || typeof input.value !== 'string') {
      throw new Error('角色状态候选参数无效')
    }
    const candidate = {
      characterName: storedName,
      field: input.field as CharacterStateTextField,
      value: input.value.trim(),
    }
    normalized.set(`${characterRosterIdentityKey(candidate.characterName)}\u0000${candidate.field}`, candidate)
  }
  return [...normalized.values()]
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sameSource(left: FinalizedSourceIdentity, right: FinalizedSourceIdentity): boolean {
  return left.draftId === right.draftId
    && left.finalizationId === right.finalizationId
    && left.chapterNumber === right.chapterNumber
    && left.contentHash === right.contentHash
}

function readFinalizedSourceFromDb(
  db: BetterSqlite3.Database,
  draftId: number,
): FinalizedSourceSnapshot | null {
  const row = db.prepare(`
    SELECT drafts.id AS draftId, drafts.chapter_number AS chapterNumber, drafts.status,
           contents.body AS content, finalization_outbox.finalization_id AS finalizationId,
           finalization_outbox.chapter_title AS chapterTitle,
           finalization_outbox.content_hash AS contentHash,
           finalization_outbox.content_snapshot AS contentSnapshot,
           continuity_projection_meta.generation AS projectionGeneration
    FROM drafts
    JOIN contents ON contents.id = drafts.content_id
    JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
    JOIN continuity_projection_meta ON continuity_projection_meta.id = 'main'
    WHERE drafts.id = ?
  `).get(draftId) as {
    draftId: number
    chapterNumber: number
    status: string
    content: string
    finalizationId: string
    chapterTitle: string
    contentHash: string
    contentSnapshot: string
    projectionGeneration: number
  } | undefined
  if (
    !row
    || row.status !== 'finalized'
    || !row.finalizationId.trim()
    || !/^[a-f0-9]{64}$/u.test(row.contentHash)
    || row.content !== row.contentSnapshot
    || sha256(row.contentSnapshot) !== row.contentHash
  ) return null
  return {
    source: {
      draftId: row.draftId,
      finalizationId: row.finalizationId,
      chapterNumber: row.chapterNumber,
      contentHash: row.contentHash,
    },
    chapterTitle: row.chapterTitle,
    content: row.contentSnapshot,
    projectionGeneration: row.projectionGeneration,
  }
}

export function invalidateContinuityProjectionFrom(
  db: BetterSqlite3.Database,
  chapterNumber: number,
): void {
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error('连续性投影失效章节无效')
  }
  db.prepare(`
    UPDATE continuity_projection_meta
    SET generation = generation + 1,
        stale_from_chapter = CASE
          WHEN stale_from_chapter IS NULL OR stale_from_chapter > ? THEN ?
          ELSE stale_from_chapter
        END
    WHERE id = 'main'
  `).run(chapterNumber, chapterNumber)
}

export class SummaryRepository {
  static saveFinalizedContinuity(input: SaveFinalizedContinuityRequest): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    const chapterNotes = input.chapterNotes.trim()
    const normalized = normalizedFacts(input.facts ?? [], input.chapterNumber)
    const facts = JSON.stringify(normalized)
    if (
      !Number.isSafeInteger(input.draftId)
      || input.draftId < 1
      || !Number.isSafeInteger(input.chapterNumber)
      || input.chapterNumber < 1
      || !Number.isSafeInteger(input.projectionGeneration)
      || input.projectionGeneration < 0
      || !chapterNotes
    ) throw new Error('连续性投影参数无效')

    db.transaction(() => {
      const snapshot = readFinalizedSourceFromDb(db, input.draftId)
      if (!snapshot || !sameSource(snapshot.source, input.source) || input.chapterNumber !== snapshot.source.chapterNumber) {
        throw new Error('连续性投影来源已失效，已拒绝过期结果')
      }
      if (normalized.some(fact => !snapshot.content.includes(fact.evidence))) {
        throw new Error('连续性事实引文无法在绑定定稿正文中精确定位')
      }
      const generation = (db.prepare(`
        SELECT generation FROM continuity_projection_meta WHERE id = 'main'
      `).get() as { generation: number }).generation
      if (input.projectionGeneration !== generation) {
        throw new Error('连续性投影失效水位已推进，已拒绝过期结果')
      }
      const updated = db.prepare(`
        UPDATE summary_snapshots
        SET chapter_number = ?, chapter_notes = ?, continuity_facts = ?,
            source_finalization_id = ?, source_content_hash = ?, projection_generation = ?,
            created_at = datetime('now')
        WHERE draft_id = ?
      `).run(
        input.chapterNumber,
        chapterNotes,
        facts,
        input.source.finalizationId,
        input.source.contentHash,
        input.projectionGeneration,
        input.draftId,
      )
      if (updated.changes === 0) {
        db.prepare(`
          INSERT INTO summary_snapshots (
            draft_id, chapter_number, chapter_notes, continuity_facts,
            source_finalization_id, source_content_hash, projection_generation
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.draftId,
          input.chapterNumber,
          chapterNotes,
          facts,
          input.source.finalizationId,
          input.source.contentHash,
          input.projectionGeneration,
        )
      }
    })()
  }

  static saveFinalizedCharacterStateCandidates(input: SaveFinalizedCharacterStateCandidatesRequest): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    if (
      !Number.isSafeInteger(input.draftId)
      || input.draftId < 1
      || !Number.isSafeInteger(input.chapterNumber)
      || input.chapterNumber < 1
      || !Number.isSafeInteger(input.projectionGeneration)
      || input.projectionGeneration < 0
    ) throw new Error('角色状态候选参数无效')

    db.transaction(() => {
      const snapshot = readFinalizedSourceFromDb(db, input.draftId)
      if (!snapshot || !sameSource(snapshot.source, input.source) || input.chapterNumber !== snapshot.source.chapterNumber) {
        throw new Error('角色状态候选来源已失效，已拒绝过期结果')
      }
      if (input.projectionGeneration !== snapshot.projectionGeneration) {
        throw new Error('连续性投影失效水位已推进，已拒绝过期结果')
      }
      const row = db.prepare(`
        SELECT character_state_candidates AS candidates,
               source_finalization_id AS finalizationId,
               source_content_hash AS contentHash,
               projection_generation AS projectionGeneration
        FROM summary_snapshots
        WHERE draft_id = ?
      `).get(input.draftId) as {
        candidates: string
        finalizationId: string
        contentHash: string
        projectionGeneration: number
      } | undefined
      if (
        !row
        || row.finalizationId !== input.source.finalizationId
        || row.contentHash !== input.source.contentHash
        || row.projectionGeneration !== input.projectionGeneration
      ) throw new Error('角色状态候选缺少同代定稿连续性投影')

      const merged = new Map<string, FinalizedCharacterStateCandidate>()
      for (const candidate of [
        ...parseCharacterStateCandidates(row.candidates),
        ...normalizeCharacterStateCandidates(db, input.candidates),
      ]) merged.set(`${characterRosterIdentityKey(candidate.characterName)}\u0000${candidate.field}`, candidate)
      db.prepare(`
        UPDATE summary_snapshots
        SET character_state_candidates = ?, created_at = datetime('now')
        WHERE draft_id = ?
      `).run(JSON.stringify([...merged.values()]), input.draftId)
    })()
  }

  static listFinalizedContinuityBefore(chapterNumber: number): FinalizedContinuityProjection[] {
    const db = getProjectDb()
    if (!db) return []
    if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
      throw new Error('连续性投影目标章节无效')
    }
    const rows = db.prepare(`
      SELECT summary_snapshots.draft_id AS draftId,
             summary_snapshots.chapter_number AS chapterNumber,
             COALESCE(finalization_outbox.chapter_title, '') AS chapterTitle,
             summary_snapshots.chapter_notes AS chapterNotes,
             summary_snapshots.continuity_facts AS continuityFacts,
             summary_snapshots.character_state_candidates AS characterStateCandidates,
             summary_snapshots.source_finalization_id AS sourceFinalizationId,
             summary_snapshots.source_content_hash AS sourceContentHash,
             summary_snapshots.projection_generation AS projectionGeneration,
             finalization_outbox.finalization_id AS currentFinalizationId,
             finalization_outbox.content_hash AS currentContentHash,
             finalization_outbox.content_snapshot AS contentSnapshot,
             contents.body AS currentContent,
             continuity_projection_meta.generation AS currentGeneration,
             continuity_projection_meta.stale_from_chapter AS staleFromChapter
      FROM summary_snapshots
      JOIN drafts ON drafts.id = summary_snapshots.draft_id
      JOIN contents ON contents.id = drafts.content_id
      LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      JOIN continuity_projection_meta ON continuity_projection_meta.id = 'main'
      WHERE summary_snapshots.draft_id IS NOT NULL
        AND summary_snapshots.chapter_number < ?
        AND summary_snapshots.chapter_notes <> ''
        AND drafts.status = 'finalized'
        AND NOT EXISTS (
          SELECT 1 FROM drafts newer
          WHERE newer.chapter_number = drafts.chapter_number
            AND newer.status = 'finalized'
            AND (newer.version > drafts.version OR (newer.version = drafts.version AND newer.id > drafts.id))
        )
      ORDER BY summary_snapshots.chapter_number ASC, summary_snapshots.draft_id ASC
    `).all(chapterNumber) as Array<Omit<FinalizedContinuityProjection, 'facts' | 'characterStateCandidates' | 'source' | 'sourceStatus'> & {
      continuityFacts: string
      characterStateCandidates: string
      sourceFinalizationId: string
      sourceContentHash: string
      projectionGeneration: number
      currentFinalizationId: string | null
      currentContentHash: string | null
      contentSnapshot: string | null
      currentContent: string
      currentGeneration: number
      staleFromChapter: number | null
    }>
    return rows.map((row) => {
      const hasBoundSource = Boolean(row.sourceFinalizationId && row.sourceContentHash)
      const sourceCurrent = hasBoundSource
        && row.currentFinalizationId === row.sourceFinalizationId
        && row.currentContentHash === row.sourceContentHash
        && row.contentSnapshot === row.currentContent
        && sha256(row.currentContent) === row.currentContentHash
      const invalidated = row.staleFromChapter !== null
        && row.chapterNumber >= row.staleFromChapter
        && row.projectionGeneration < row.currentGeneration
      return {
        draftId: row.draftId,
        chapterNumber: row.chapterNumber,
        chapterTitle: row.chapterTitle,
        chapterNotes: row.chapterNotes,
        facts: parseFacts(row.continuityFacts, row.chapterNumber),
        ...(() => {
          const candidates = parseCharacterStateCandidates(row.characterStateCandidates)
          return candidates.length > 0 ? { characterStateCandidates: candidates } : {}
        })(),
        ...(hasBoundSource ? {
          source: {
            draftId: row.draftId,
            finalizationId: row.sourceFinalizationId,
            chapterNumber: row.chapterNumber,
            contentHash: row.sourceContentHash,
          },
        } : {}),
        sourceStatus: !hasBoundSource ? 'legacy' : sourceCurrent && !invalidated ? 'current' : 'stale',
      }
    })
  }

  /** Raw immutable prose is the deterministic fallback when a derived projection is stale. */
  static readFinalizedSource(draftId: number): FinalizedSourceReadResult {
    const db = getProjectDb()
    if (!db) return { status: 'invalid' }
    if (!Number.isSafeInteger(draftId) || draftId < 1) throw new Error('定稿来源身份无效')
    const row = db.prepare(`
      SELECT drafts.id AS draftId, drafts.chapter_number AS chapterNumber, drafts.status,
             contents.body AS content,
             COALESCE(finalization_outbox.chapter_title, blueprints.title, '') AS chapterTitle,
             finalization_outbox.draft_id AS receiptDraftId,
             finalization_outbox.finalization_id AS finalizationId
      FROM drafts
      JOIN contents ON contents.id = drafts.content_id
      LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      LEFT JOIN blueprints ON blueprints.chapter_number = drafts.chapter_number
      WHERE drafts.id = ?
    `).get(draftId) as {
      draftId: number
      chapterNumber: number
      status: string
      content: string
      chapterTitle: string
      receiptDraftId: number | null
      finalizationId: string | null
    } | undefined
    if (!row || row.status !== 'finalized') return { status: 'invalid' }
    if (row.receiptDraftId === null) {
      return {
        status: 'legacy',
        draftId: row.draftId,
        chapterNumber: row.chapterNumber,
        chapterTitle: row.chapterTitle,
        content: row.content,
      }
    }
    const snapshot = readFinalizedSourceFromDb(db, draftId)
    return snapshot ? { status: 'valid', snapshot } : { status: 'invalid' }
  }

  /** 保存角色状态快照 */
  static saveSnapshot(chapterNumber: number, characterStates: string): void {
    const db = getProjectDb()
    if (!db) return
    db.prepare(`
      INSERT INTO summary_snapshots (chapter_number, character_states)
      VALUES (?, ?)
    `).run(chapterNumber, characterStates)
  }

  /** 获取最新角色状态快照 */
  static getLatestSnapshot(): { characterStates: string; chapterNumber: number } | null {
    const db = getProjectDb()
    if (!db) return null
    const row = db.prepare(
      `SELECT character_states AS characterStates, chapter_number AS chapterNumber
       FROM summary_snapshots
       WHERE draft_id IS NULL
       ORDER BY id DESC LIMIT 1`,
    ).get() as { characterStates: string; chapterNumber: number } | undefined
    return row ?? null
  }
}
