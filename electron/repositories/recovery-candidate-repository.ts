import { createHash, randomUUID } from 'node:crypto'

import type {
  RecoveryCandidate,
  RecoveryCandidateRecordRequest,
  RecoveryCandidateStatus,
  RecoveryChapterSource,
} from '../../src/shared/recovery-candidate'
import { getProjectDb } from '../database'
import { BlueprintRepository } from './blueprint-repository'
import { DraftRepository } from './draft-repository'

interface RecoveryCandidateRow {
  candidate_id: string
  run_id: string
  step_id: string
  project_id: string
  chapter_number: number
  chapter_title: string
  source_snapshot: string
  source_hash: string
  source_draft_id: number | null
  source_draft_version: number | null
  source_draft_identity_captured: number
  visible_text: string
  content_hash: string
  failure_code: string
  failure_reason: string
  status: RecoveryCandidateStatus
  replaces_candidate_id: string | null
  created_at: string
  resolved_at: string | null
}

function requireDb() {
  const db = getProjectDb()
  if (!db) throw new Error('项目数据库未打开')
  return db
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sourceSnapshot(source: RecoveryChapterSource): RecoveryChapterSource {
  return {
    chapterNumber: source.chapterNumber,
    title: source.title,
    role: source.role,
    purpose: source.purpose,
    keyEvents: source.keyEvents,
    characters: [...source.characters],
    suspenseHook: source.suspenseHook ?? '',
    userGuidance: source.userGuidance ?? '',
  }
}

function serializedSource(source: RecoveryChapterSource): string {
  return JSON.stringify(sourceSnapshot(source))
}

function visibleOnly(text: string): string {
  const withoutPairedThinking = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/giu, '')
  const orphanClosingTag = /<\/think>/iu.exec(withoutPairedThinking)
  if (!orphanClosingTag || orphanClosingTag.index === undefined) {
    return withoutPairedThinking.replace(/<\/?think>/giu, '').trim()
  }
  const visibleSuffix = withoutPairedThinking.slice(orphanClosingTag.index + orphanClosingTag[0].length)
  return visibleSuffix
    .replace(/<\/?think>/giu, '')
    .trim()
}

function assertText(value: string, label: string, max: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > max) throw new Error(`${label}无效`)
  return normalized
}

function sourceIsCurrent(row: RecoveryCandidateRow): boolean {
  if (row.source_draft_identity_captured !== 1) return false
  const current = BlueprintRepository.getByChapter(row.chapter_number)
  if (!current) return false
  const blueprintCurrent = sha256(serializedSource({
    chapterNumber: current.chapterNumber,
    title: current.title,
    role: current.role,
    purpose: current.purpose,
    keyEvents: current.keyEvents,
    characters: current.characters,
    suspenseHook: current.suspenseHook,
    userGuidance: current.userGuidance,
  })) === row.source_hash
  if (!blueprintCurrent) return false

  const currentDraft = DraftRepository.getLatestByChapter(row.chapter_number)
  if (row.source_draft_id === null || row.source_draft_version === null) {
    return row.source_draft_id === null && row.source_draft_version === null && currentDraft === null
  }
  return currentDraft?.id === row.source_draft_id && currentDraft.version === row.source_draft_version
}

function toCandidate(row: RecoveryCandidateRow): RecoveryCandidate {
  if (sha256(row.source_snapshot) !== row.source_hash || sha256(row.visible_text) !== row.content_hash) {
    throw new Error('恢复候选完整性校验失败')
  }
  return {
    candidateId: row.candidate_id,
    runId: row.run_id,
    stepId: row.step_id,
    projectId: row.project_id,
    chapterNumber: row.chapter_number,
    chapterTitle: row.chapter_title,
    sourceHash: row.source_hash,
    visibleText: row.visible_text,
    contentHash: row.content_hash,
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    status: row.status,
    replacesCandidateId: row.replaces_candidate_id,
    sourceCurrent: sourceIsCurrent(row),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

export class RecoveryCandidateRepository {
  static record(request: RecoveryCandidateRecordRequest): RecoveryCandidate {
    const db = requireDb()
    const runId = assertText(request.runId, '候选任务身份', 160)
    const stepId = assertText(request.stepId, '候选步骤身份', 160)
    const projectId = assertText(request.projectId, '候选项目身份', 160)
    if (!Number.isSafeInteger(request.chapterNumber) || request.chapterNumber < 1) {
      throw new Error('候选章节身份无效')
    }
    if (request.source.chapterNumber !== request.chapterNumber) {
      throw new Error('候选源章节身份不一致')
    }
    if (request.sourceDraft !== null && (
      !request.sourceDraft
      || !Number.isSafeInteger(request.sourceDraft.id)
      || request.sourceDraft.id < 1
      || !Number.isSafeInteger(request.sourceDraft.version)
      || request.sourceDraft.version < 1
    )) throw new Error('候选源草稿身份无效')
    const visibleText = visibleOnly(request.visibleText)
    if (!visibleText) throw new Error('恢复候选没有可见正文')
    const serialized = serializedSource(request.source)
    const candidateId = randomUUID()

    if (request.replacesCandidateId) {
      const replaced = db.prepare(`
        SELECT run_id, project_id, chapter_number
        FROM recovery_candidates
        WHERE candidate_id = ?
      `).get(request.replacesCandidateId) as {
        run_id: string
        project_id: string
        chapter_number: number
      } | undefined
      if (
        !replaced
        || replaced.run_id !== runId
        || replaced.project_id !== projectId
        || replaced.chapter_number !== request.chapterNumber
      ) throw new Error('替代候选关系无效')
    }

    db.prepare(`
      INSERT INTO recovery_candidates (
        candidate_id, run_id, step_id, project_id, chapter_number,
        chapter_title, source_snapshot, source_hash, source_draft_id,
        source_draft_version, source_draft_identity_captured, visible_text,
        content_hash, failure_code, failure_reason, replaces_candidate_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      candidateId,
      runId,
      stepId,
      projectId,
      request.chapterNumber,
      request.chapterTitle.trim(),
      serialized,
      sha256(serialized),
      request.sourceDraft?.id ?? null,
      request.sourceDraft?.version ?? null,
      visibleText,
      sha256(visibleText),
      request.failureCode.trim().slice(0, 160),
      request.failureReason.trim().slice(0, 2_000),
      request.replacesCandidateId ?? null,
    )

    const row = db.prepare(`
      SELECT * FROM recovery_candidates WHERE candidate_id = ?
    `).get(candidateId) as RecoveryCandidateRow
    return toCandidate(row)
  }

  static listPending(): RecoveryCandidate[] {
    const rows = requireDb().prepare(`
      SELECT * FROM recovery_candidates
      WHERE status = 'pending'
      ORDER BY rowid ASC
    `).all() as RecoveryCandidateRow[]
    return rows.map(toCandidate)
  }

  static updatePending(candidateId: string, text: string): RecoveryCandidate {
    const db = requireDb()
    const id = assertText(candidateId, '恢复候选身份', 160)
    const row = db.prepare(`
      SELECT * FROM recovery_candidates
      WHERE candidate_id = ? AND status = 'pending'
    `).get(id) as RecoveryCandidateRow | undefined
    if (!row) throw new Error('恢复候选不存在或已处理')
    toCandidate(row)
    if (!sourceIsCurrent(row)) throw new Error('恢复候选的源章节已变化，已拒绝保存')
    const visibleText = visibleOnly(text)
    if (!visibleText) throw new Error('恢复候选没有可见正文')

    db.prepare(`
      UPDATE recovery_candidates
      SET visible_text = ?, content_hash = ?
      WHERE candidate_id = ? AND status = 'pending'
    `).run(visibleText, sha256(visibleText), id)

    return toCandidate(db.prepare(`
      SELECT * FROM recovery_candidates WHERE candidate_id = ?
    `).get(id) as RecoveryCandidateRow)
  }

  static resolve(candidateId: string, status: Exclude<RecoveryCandidateStatus, 'pending'>): void {
    if (status !== 'continued' && status !== 'discarded') throw new Error('恢复候选动作无效')
    const db = requireDb()
    if (status === 'continued') {
      const row = db.prepare(`
        SELECT * FROM recovery_candidates
        WHERE candidate_id = ? AND status = 'pending'
      `).get(candidateId) as RecoveryCandidateRow | undefined
      if (!row || !sourceIsCurrent(row)) throw new Error('恢复候选的源章节已变化，已拒绝继续')
    }
    const result = db.prepare(`
      UPDATE recovery_candidates
      SET status = ?, resolved_at = datetime('now')
      WHERE candidate_id = ? AND status = 'pending'
    `).run(status, candidateId)
    if (result.changes !== 1) throw new Error('恢复候选不存在或已处理')
  }
}
