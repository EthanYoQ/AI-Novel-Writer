import type Database from 'better-sqlite3'
import { CHARACTER_STATE_TEXT_FIELDS } from '../../src/shared/character-roster'
import type { FinalizedSourceIdentity } from '../../src/shared/finalized-continuity'
import { isFinalizedSourceIdentity } from '../../src/shared/source-ref'
import { refreshCharacterStateProjection } from '../repositories/character-roster-repository'
import { readPortableCurrentAuthority } from './portable-current-authority'
import { getProjectDataRoot } from './project-data-locator'

const GENERATION = /^(0|[1-9][0-9]*)$/u

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 来源在本库留有证明：定稿收据还在，或者这一章已经删除、删章记录与来源对得上。
 * 删章记录离开 authorization_required 时稿件和收据已在同一事务里删掉，原项目照常允许后面的章节覆盖这类字段（#484）。
 */
function localSourceProof(db: Database.Database): (source: FinalizedSourceIdentity) => boolean {
  const receipt = db.prepare(`SELECT 1 FROM finalization_outbox o JOIN drafts d ON d.id=o.draft_id
    WHERE o.finalization_id=? AND o.draft_id=? AND o.chapter_number=? AND d.chapter_number=? AND o.content_hash=?`)
  const deletion = db.prepare(`SELECT 1 FROM chapter_deletion_operations t
    WHERE t.finalization_id=? AND t.draft_id=? AND t.chapter_number=? AND t.status<>'authorization_required'
      AND NOT EXISTS (SELECT 1 FROM finalization_outbox o WHERE o.finalization_id=t.finalization_id)
      AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.id=t.draft_id)`)
  return source => !!receipt.get(source.finalizationId, source.draftId, source.chapterNumber, source.chapterNumber, source.contentHash)
    || !!deletion.get(source.finalizationId, source.draftId, source.chapterNumber)
}

/**
 * 派生字段的续写纪元写成「写下它的项目 ID:投影代数」。项目每经一次备份恢复就换一个新 ID，
 * 而当前项目只认自己和上一个来源项目，隔两次恢复以上的字段就会被当成历史记录、定稿时报来源冲突（#491）。
 * 同一个数据库文件里的投影代数是随文件一路复制下来的同一个计数器，所以前缀只说明是谁写的。
 * 这里只改写前缀：字段的来源必须在本库留有证明，代数不超过本库的当前代数；值、来源与章节顺序都不动。
 * 返回改写的字段数；再次执行不再改动。调用方必须先确认本项目来自经验证的转移。
 */
export function adoptTransferredCharacterContinuity(db: Database.Database, projectId: string): number {
  if (!projectId) throw new Error('CHARACTER_CONTINUITY_PROJECT_REQUIRED')
  return db.transaction(() => {
    const watermark = db.prepare("SELECT generation FROM continuity_projection_meta WHERE id='main'").pluck().get()
    if (!Number.isSafeInteger(watermark)) return 0
    const provenInThisDatabase = localSourceProof(db)
    let adopted = 0
    for (const row of db.prepare('SELECT character_id,cs_provenance FROM characters').all() as Array<{ character_id: string; cs_provenance: string | null }>) {
      let provenance: unknown
      try { provenance = JSON.parse(row.cs_provenance || '{}') } catch { continue }
      if (!record(provenance)) continue
      let changed = false
      for (const field of CHARACTER_STATE_TEXT_FIELDS) {
        const entry = provenance[field]
        if (!record(entry) || entry.kind !== 'derived' || !record(entry.source) || !record(entry.sourceOrder)) continue
        const source = entry.source as unknown as FinalizedSourceIdentity, order = entry.sourceOrder
        const epoch = order.continuityEpoch
        if (typeof source.finalizationId !== 'string' || typeof epoch !== 'string'
          || !isFinalizedSourceIdentity(source) || order.chapterNumber !== source.chapterNumber) continue
        const separator = epoch.lastIndexOf(':'), prefix = epoch.slice(0, separator), generation = epoch.slice(separator + 1)
        if (separator < 1 || prefix === projectId || !GENERATION.test(generation) || Number(generation) > (watermark as number)
          || !provenInThisDatabase(source)) continue
        provenance[field] = { ...entry, sourceOrder: { ...order, continuityEpoch: `${projectId}:${generation}` } }
        changed = true
        adopted += 1
      }
      if (changed) db.prepare('UPDATE characters SET cs_provenance=? WHERE character_id=?').run(JSON.stringify(provenance), row.character_id)
    }
    if (adopted) refreshCharacterStateProjection(db)
    return adopted
  }).immediate()
}

/** 打开项目时调用。转移凭据缺失或无效时什么也不改，派生字段照旧按历史记录显示，打开项目不受影响。 */
export function adoptTransferredCharacterContinuityOnOpen(input: {
  database: Database.Database
  projectRoot: string
  projectId: string
}): number {
  try {
    const { database, projectId } = input
    if (!readPortableCurrentAuthority({ database, projectId, projectStorageRoot: getProjectDataRoot(input.projectRoot) })) return 0
    return adoptTransferredCharacterContinuity(database, projectId)
  } catch (error) {
    console.warn('[character-continuity] 打开项目时未能改记角色派生状态', error)
    return 0
  }
}
