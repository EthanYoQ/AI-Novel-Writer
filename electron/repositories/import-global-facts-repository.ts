import { createHash } from 'node:crypto'

import type {
  ImportGlobalFactsCore,
  ImportGlobalFactsReceipt,
  ImportGlobalFactsRequest,
} from '../../src/shared/import-global-facts'
import { getProjectDb } from '../database'
import { CharacterRosterRepository } from './character-roster-repository'
import { ProjectCoreRepository } from './project-core-repository'

interface OperationRow {
  operation_id: string
  payload_hash: string
  receipt_json: string
}

const CORE_TEXT_FIELDS = [
  'genre', 'subGenre', 'targetAudience', 'plotStructure', 'narrativePov',
  'goldenFinger', 'globalGuidance', 'coreOutline', 'worldSetting', 'protagonistProfile',
  'premise', 'worldbuilding', 'synopsis',
] as const
const PLOT_STRUCTURES = new Set(['three_act', 'heros_journey', 'save_the_cat', 'kishotenketsu', 'multi_thread', 'freeform'])
const NARRATIVE_POVS = new Set(['third_limited', 'first_person', 'third_omniscient', 'multi_pov'])

function normalizedRequest(candidate: ImportGlobalFactsRequest): ImportGlobalFactsRequest {
  const operationId = candidate.operationId?.trim()
  if (!operationId || operationId.length > 160) throw new Error('导入全局事实 operationId 无效')
  if (!Number.isSafeInteger(candidate.expectedRosterRevision) || candidate.expectedRosterRevision < 0) {
    throw new Error('导入全局事实角色 revision 无效')
  }
  if (!candidate.core || typeof candidate.core !== 'object') throw new Error('导入全局事实配置无效')
  const core = { ...candidate.core }
  const mutableCore = core as unknown as Record<string, unknown>
  for (const field of CORE_TEXT_FIELDS) {
    const value = core[field]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`导入全局事实字段 ${field} 无效`)
    mutableCore[field] = value.trim()
  }
  if (!PLOT_STRUCTURES.has(core.plotStructure)) throw new Error('导入全局事实字段 plotStructure 无效')
  if (!NARRATIVE_POVS.has(core.narrativePov)) throw new Error('导入全局事实字段 narrativePov 无效')
  if (!Number.isSafeInteger(core.totalChapters) || core.totalChapters < 1) {
    throw new Error('导入全局事实总章数无效')
  }
  if (!Number.isSafeInteger(core.wordsPerChapter) || core.wordsPerChapter < 1) {
    throw new Error('导入全局事实章节字数无效')
  }
  if (!Array.isArray(candidate.characterEntries) || candidate.characterEntries.length === 0) {
    throw new Error('导入全局事实角色名单不能为空')
  }
  return {
    operationId,
    expectedRosterRevision: candidate.expectedRosterRevision,
    core,
    characterEntries: structuredClone(candidate.characterEntries),
  }
}

function hashRequest(request: ImportGlobalFactsRequest): string {
  return createHash('sha256').update(JSON.stringify(request), 'utf8').digest('hex')
}

function coreSnapshot(): ImportGlobalFactsCore {
  const core = ProjectCoreRepository.get()
  if (!core) throw new Error('项目主台账未初始化')
  return {
    genre: core.genre,
    subGenre: core.subGenre,
    targetAudience: core.targetAudience,
    totalChapters: core.totalChapters,
    wordsPerChapter: core.wordsPerChapter,
    plotStructure: core.plotStructure as ImportGlobalFactsCore['plotStructure'],
    narrativePov: core.narrativePov as ImportGlobalFactsCore['narrativePov'],
    goldenFinger: core.goldenFinger,
    globalGuidance: core.globalGuidance,
    coreOutline: core.coreOutline,
    worldSetting: core.worldSetting,
    protagonistProfile: core.protagonistProfile,
    premise: core.premise,
    worldbuilding: core.worldbuilding,
    synopsis: core.synopsis,
  }
}

function parseReceipt(row: OperationRow): ImportGlobalFactsReceipt {
  try {
    const parsed = JSON.parse(row.receipt_json) as ImportGlobalFactsReceipt
    if (parsed.operationId !== row.operation_id || parsed.payloadHash !== row.payload_hash) throw new Error()
    return parsed
  } catch {
    throw new Error('导入全局事实收据损坏，已拒绝重放')
  }
}

function ensureLedger(): void {
  const db = getProjectDb()
  if (!db) throw new Error('项目数据库未打开')
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_global_fact_operations (
      operation_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}

/** Atomic import seam for config, non-character architecture and roster facts. */
export class ImportGlobalFactsRepository {
  /** Read-only authoritative evidence for a previously committed import operation. */
  static getCommittedOperation(operationId: string): ImportGlobalFactsReceipt | null {
    if (!operationId.trim()) throw new Error('导入全局事实 operationId 无效')
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    ensureLedger()
    const row = db.prepare(`
      SELECT operation_id, payload_hash, receipt_json
      FROM import_global_fact_operations WHERE operation_id = ?
    `).get(operationId) as OperationRow | undefined
    if (!row) return null
    const stored = parseReceipt(row)
    const currentCore = coreSnapshot()
    const currentRoster = CharacterRosterRepository.read()
    if (
      JSON.stringify(currentCore) !== JSON.stringify(stored.core)
      || currentRoster.factHash !== stored.roster.snapshot.factHash
    ) throw new Error('导入全局事实已被后续修改，不能将历史操作冒充为当前事实')
    return stored
  }

  static commit(candidate: ImportGlobalFactsRequest): ImportGlobalFactsReceipt {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    ensureLedger()
    const request = normalizedRequest(candidate)
    const payloadHash = hashRequest(request)

    return db.transaction(() => {
      const existing = db.prepare(`
        SELECT operation_id, payload_hash, receipt_json
        FROM import_global_fact_operations WHERE operation_id = ?
      `).get(request.operationId) as OperationRow | undefined
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new Error('导入全局事实 operationId 已绑定不同载荷')
        const stored = parseReceipt(existing)
        const currentCore = coreSnapshot()
        const currentRoster = CharacterRosterRepository.read()
        if (
          JSON.stringify(currentCore) !== JSON.stringify(stored.core)
          || currentRoster.factHash !== stored.roster.snapshot.factHash
        ) throw new Error('导入全局事实已被后续修改，不能将历史操作冒充为当前事实')
        return {
          ...stored,
          idempotent: true,
          roster: { ...stored.roster, revision: currentRoster.revision, snapshot: currentRoster },
        }
      }

      ProjectCoreRepository.update(request.core)
      const roster = CharacterRosterRepository.commit({
        operationId: `${request.operationId}:roster`,
        expectedRevision: request.expectedRosterRevision,
        schemaVersion: 1,
        intent: 'novel_import',
        entries: request.characterEntries,
      })
      const receipt: ImportGlobalFactsReceipt = {
        operationId: request.operationId,
        payloadHash,
        idempotent: false,
        core: coreSnapshot(),
        roster,
      }
      db.prepare(`
        INSERT INTO import_global_fact_operations (operation_id, payload_hash, receipt_json)
        VALUES (?, ?, ?)
      `).run(request.operationId, payloadHash, JSON.stringify(receipt))
      return receipt
    })()
  }
}
