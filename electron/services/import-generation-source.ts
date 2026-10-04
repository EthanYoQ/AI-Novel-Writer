import type Database from 'better-sqlite3'
import { textHash } from '../repositories/generation-run-repository'
import { countDraftUnits } from '../../src/shared/draft-units'
import { createImportRunChapterBatchCheckpointId, parseImportRunChapterBatchCheckpointId } from '../../src/shared/import-run'
import type { ImportGenerationContext, ImportGenerationSlot } from '../../src/shared/import-generation'
import { ProjectCoreRepository } from '../repositories/project-core-repository'

export function validateImportGenerationSlot(slot: ImportGenerationSlot): void {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot) || Object.keys(slot).some(key => !['runId', 'stage', 'batchId'].includes(key))
    || typeof slot.runId !== 'string' || !slot.runId.trim() || slot.runId.length > 256
    || !['global', 'style', 'blueprints'].includes(slot.stage) || typeof slot.batchId !== 'string' || slot.batchId.length > 256
    || (slot.stage === 'blueprints' ? !parseImportRunChapterBatchCheckpointId(slot.batchId) : slot.batchId !== 'done'))
    throw new Error('GENERATION_IMPORT_SLOT_INVALID')
}
export function importGenerationSlotKey(slot: ImportGenerationSlot): string {
  validateImportGenerationSlot(slot)
  return textHash(JSON.stringify([slot.runId, slot.stage, slot.batchId]))
}
/** Read immutable import material from the captured database, not renderer samples. */
export function captureImportGenerationContext(db: Database.Database, slot: ImportGenerationSlot): ImportGenerationContext {
  validateImportGenerationSlot(slot)
  const run = db.prepare('SELECT purpose,manifest_fingerprint,total_chapters,manifest_word_count FROM import_runs WHERE id=?').get(slot.runId) as {
    purpose: string; manifest_fingerprint: string; total_chapters: number; manifest_word_count: number
  } | undefined
  if (!run || run.purpose !== 'reference' || !/^[a-f0-9]{64}$/.test(run.manifest_fingerprint)) throw new Error('GENERATION_IMPORT_MANIFEST_REQUIRED')
  const range = slot.stage === 'blueprints' ? parseImportRunChapterBatchCheckpointId(slot.batchId) : null
  const rows = db.prepare('SELECT chapter_number,title,content_snapshot,content_fingerprint FROM import_run_chapters WHERE run_id=? ORDER BY chapter_number').all(slot.runId) as {
    chapter_number: number; title: string; content_snapshot: string; content_fingerprint: string
  }[]
  const selected = range ? rows.filter(row => row.chapter_number >= range.startChapter && row.chapter_number <= range.endChapter)
    : slot.stage === 'global' ? rows.filter((_, index) => index === 0 || index === rows.length - 1)
      : rows.filter((_, index) => rows.length <= 5 || index < 3 || index >= rows.length - 2)
  if (!selected.length || selected.some(row => textHash(row.content_snapshot) !== row.content_fingerprint)) throw new Error('GENERATION_IMPORT_CONTENT_CHANGED')
  const chapters = selected.map(row => ({ number: row.chapter_number, title: row.title, content: row.content_snapshot,
    contentFingerprint: row.content_fingerprint, wordCount: countDraftUnits(row.content_snapshot) }))
  if (range && createImportRunChapterBatchCheckpointId(chapters) !== slot.batchId) throw new Error('GENERATION_IMPORT_CHECKPOINT_CHANGED')
  const core = ProjectCoreRepository.get(db)
  if (!core || Buffer.byteLength(JSON.stringify(chapters), 'utf8') > 8 * 1024 * 1024) throw new Error('GENERATION_IMPORT_CONTEXT_LIMIT')
  return { slot: { ...slot }, manifestFingerprint: run.manifest_fingerprint, totalChapters: run.total_chapters, totalWords: run.manifest_word_count, chapters, core, prompts: {} }
}
