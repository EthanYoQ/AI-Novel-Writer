import { createHash } from 'node:crypto'

import type Database from 'better-sqlite3'

import { PORTABLE_SOURCE_SCHEMA_VERSION } from './portable-project-format'

const HASH = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ID = /^[\p{L}\p{N}._:@+-]{1,512}$/u
const MAX_RECORDS = 100_000
const MAX_BYTES = 4 * 1024 * 1024

export const PORTABLE_TRANSFER_AUTHORITY_PATH = '.ai-novel/portable-transfer-authority.json'

export interface PortableFinalizationAuthority {
  finalizationId: string
  draftId: number
  chapterNumber: number
  contentHash: string
}

export interface PortableSummarySourceAuthority {
  summaryId: number
  draftId: number
  chapterNumber: number
  sourceFinalizationId: string
  sourceContentHash: string
  projectionGeneration: number
}

export interface PortableTransferAuthority {
  version: 1
  receiptId: string
  originProjectId: string
  targetProjectId: string | null
  snapshotGeneration: string
  sourceSchemaVersion: 6
  portableDatabaseSha256: string
  requiresRuntimeFreezeGuard: true
  finalizations: PortableFinalizationAuthority[]
  summarySources: PortableSummarySourceAuthority[]
}

function invalid(): never { throw new Error('PORTABLE_TRANSFER_AUTHORITY_INVALID') }

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const result = value as Record<string, unknown>
  const actual = Object.keys(result).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid()
  return result
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) invalid()
  return value
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid()
  return value
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid()
  return value
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid()
  return value as number
}

function finalization(value: unknown): PortableFinalizationAuthority {
  const row = object(value, ['finalizationId', 'draftId', 'chapterNumber', 'contentHash'])
  return {
    finalizationId: identifier(row.finalizationId),
    draftId: integer(row.draftId, 1),
    chapterNumber: integer(row.chapterNumber, 1),
    contentHash: hash(row.contentHash),
  }
}

function summarySource(value: unknown): PortableSummarySourceAuthority {
  const row = object(value, [
    'summaryId', 'draftId', 'chapterNumber', 'sourceFinalizationId', 'sourceContentHash', 'projectionGeneration',
  ])
  return {
    summaryId: integer(row.summaryId, 1),
    draftId: integer(row.draftId, 1),
    chapterNumber: integer(row.chapterNumber, 1),
    sourceFinalizationId: identifier(row.sourceFinalizationId),
    sourceContentHash: hash(row.sourceContentHash),
    projectionGeneration: integer(row.projectionGeneration),
  }
}

function assertFacts(
  finalizations: PortableFinalizationAuthority[],
  summarySources: PortableSummarySourceAuthority[],
): void {
  if (new Set(finalizations.map(item => item.finalizationId)).size !== finalizations.length
    || new Set(finalizations.map(item => item.draftId)).size !== finalizations.length
    || new Set(finalizations.map(item => item.chapterNumber)).size !== finalizations.length
    || new Set(summarySources.map(item => item.summaryId)).size !== summarySources.length) invalid()
  const finalizationById = new Map(finalizations.map(item => [item.finalizationId, item]))
  if (summarySources.some(item => {
    const current = finalizationById.get(item.sourceFinalizationId)
    return current?.contentHash !== item.sourceContentHash || current.draftId !== item.draftId
      || current.chapterNumber !== item.chapterNumber
  })) invalid()
}

export function parsePortableTransferAuthority(value: unknown): PortableTransferAuthority {
  const source = object(value, [
    'version', 'receiptId', 'originProjectId', 'targetProjectId', 'snapshotGeneration', 'sourceSchemaVersion',
    'portableDatabaseSha256', 'requiresRuntimeFreezeGuard', 'finalizations', 'summarySources',
  ])
  if (source.version !== 1 || source.sourceSchemaVersion !== PORTABLE_SOURCE_SCHEMA_VERSION
    || source.requiresRuntimeFreezeGuard !== true || !Array.isArray(source.finalizations)
    || !Array.isArray(source.summarySources) || source.finalizations.length > MAX_RECORDS
    || source.summarySources.length > MAX_RECORDS) invalid()
  const finalizations = source.finalizations.map(finalization)
  const summarySources = source.summarySources.map(summarySource)
  assertFacts(finalizations, summarySources)
  const result: PortableTransferAuthority = {
    version: 1,
    receiptId: identifier(source.receiptId),
    originProjectId: uuid(source.originProjectId),
    targetProjectId: source.targetProjectId === null ? null : uuid(source.targetProjectId),
    snapshotGeneration: identifier(source.snapshotGeneration),
    sourceSchemaVersion: PORTABLE_SOURCE_SCHEMA_VERSION,
    portableDatabaseSha256: hash(source.portableDatabaseSha256),
    requiresRuntimeFreezeGuard: true,
    finalizations,
    summarySources,
  }
  const expectedReceiptId = receiptId(result)
  if (result.receiptId !== expectedReceiptId) invalid()
  return result
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }

function receiptId(input: Pick<PortableTransferAuthority,
  'originProjectId' | 'snapshotGeneration' | 'portableDatabaseSha256' | 'finalizations' | 'summarySources'>): string {
  return `portable-transfer:${sha256(JSON.stringify({ originProjectId: input.originProjectId,
    snapshotGeneration: input.snapshotGeneration, portableDatabaseSha256: input.portableDatabaseSha256,
    finalizations: input.finalizations, summarySources: input.summarySources })).slice(0, 32)}`
}

function currentness(database: Database.Database): Pick<PortableTransferAuthority, 'finalizations' | 'summarySources'> {
  const core = database.prepare('SELECT id FROM project_core').all() as Array<{ id: string }>
  if (core.length > 1 || core.some(row => row.id !== 'main')) invalid()
  const rows = database.prepare(`
    SELECT o.finalization_id AS finalizationId, o.draft_id AS draftId,
      o.chapter_number AS chapterNumber, o.content_hash AS contentHash,
      o.content_snapshot AS contentSnapshot, d.chapter_number AS draftChapterNumber,
      d.status AS draftStatus, c.body AS body
    FROM drafts d
    JOIN contents c ON c.id = d.content_id
    LEFT JOIN finalization_outbox o ON o.draft_id = d.id
    WHERE d.status = 'finalized'
      AND NOT EXISTS (
        SELECT 1 FROM drafts newer
        WHERE newer.chapter_number = d.chapter_number
          AND newer.status = 'finalized'
          AND (newer.version > d.version OR (newer.version = d.version AND newer.id > d.id))
      )
    ORDER BY o.finalization_id
  `).all() as Array<PortableFinalizationAuthority & {
    contentSnapshot: string; draftChapterNumber: number; draftStatus: string; body: string
  }>
  const finalizations = rows.map(row => {
    const projected = finalization({
      finalizationId: row.finalizationId,
      draftId: row.draftId,
      chapterNumber: row.chapterNumber,
      contentHash: row.contentHash,
    })
    if (row.draftStatus !== 'finalized' || row.chapterNumber !== row.draftChapterNumber
      || typeof row.contentSnapshot !== 'string' || typeof row.body !== 'string'
      || row.contentSnapshot !== row.body || sha256(row.contentSnapshot) !== row.contentHash) invalid()
    return projected
  })
  const summaries = database.prepare(`
    SELECT s.id AS summaryId, s.draft_id AS draftId, s.chapter_number AS chapterNumber,
      s.source_finalization_id AS sourceFinalizationId, s.source_content_hash AS sourceContentHash,
      s.projection_generation AS projectionGeneration
    FROM summary_snapshots s
    JOIN drafts d ON d.id = s.draft_id
    WHERE (s.source_finalization_id <> '' OR s.source_content_hash <> '')
      AND d.status = 'finalized'
      AND NOT EXISTS (
        SELECT 1 FROM drafts newer
        WHERE newer.chapter_number = d.chapter_number
          AND newer.status = 'finalized'
          AND (newer.version > d.version OR (newer.version = d.version AND newer.id > d.id))
      )
    ORDER BY s.id
  `).all() as Array<Record<string, unknown>>
  const summarySources = summaries.map(summarySource)
  assertFacts(finalizations, summarySources)
  return { finalizations, summarySources }
}

export function createPortableTransferAuthority(input: {
  database: Database.Database
  originProjectId: string
  snapshotGeneration: string
  portableDatabaseSha256: string
}): PortableTransferAuthority {
  const facts = currentness(input.database)
  return parsePortableTransferAuthority({
    version: 1,
    originProjectId: input.originProjectId,
    targetProjectId: null,
    snapshotGeneration: input.snapshotGeneration,
    sourceSchemaVersion: PORTABLE_SOURCE_SCHEMA_VERSION,
    portableDatabaseSha256: input.portableDatabaseSha256,
    requiresRuntimeFreezeGuard: true,
    ...facts,
    receiptId: receiptId({ originProjectId: input.originProjectId, snapshotGeneration: input.snapshotGeneration,
      portableDatabaseSha256: input.portableDatabaseSha256, ...facts }),
  })
}

export function mapPortableTransferAuthority(
  authority: PortableTransferAuthority,
  targetProjectId: string,
): PortableTransferAuthority {
  return parsePortableTransferAuthority({ ...authority, targetProjectId })
}

export function verifyPortableTransferAuthority(
  database: Database.Database,
  authority: PortableTransferAuthority,
): void {
  const facts = currentness(database)
  if (JSON.stringify(facts.finalizations) !== JSON.stringify(authority.finalizations)
    || JSON.stringify(facts.summarySources) !== JSON.stringify(authority.summarySources)) invalid()
}

/** Original exported tuples are immutable history; newer finalized versions are allowed. */
export function verifyPortableTransferAuthorityHistory(
  database: Database.Database,
  authority: PortableTransferAuthority,
): void {
  for (const item of authority.finalizations) {
    const row = database.prepare(`
      SELECT d.status AS status,d.chapter_number AS chapterNumber,c.body AS body,
        o.finalization_id AS finalizationId,o.content_hash AS contentHash,o.content_snapshot AS contentSnapshot
      FROM drafts d JOIN contents c ON c.id=d.content_id
      LEFT JOIN finalization_outbox o ON o.draft_id=d.id WHERE d.id=?
    `).get(item.draftId) as { status: string; chapterNumber: number; body: string; finalizationId: string | null; contentHash: string | null; contentSnapshot: string | null } | undefined
    if (!row || row.status !== 'finalized' || row.chapterNumber !== item.chapterNumber
      || row.finalizationId !== item.finalizationId || row.contentHash !== item.contentHash
      || row.contentSnapshot !== row.body || sha256(row.body) !== item.contentHash) invalid()
  }
  for (const item of authority.summarySources) {
    const row = database.prepare(`
      SELECT id AS summaryId,draft_id AS draftId,chapter_number AS chapterNumber,
        source_finalization_id AS sourceFinalizationId,source_content_hash AS sourceContentHash,
        projection_generation AS projectionGeneration
      FROM summary_snapshots WHERE id=?
    `).get(item.summaryId) as PortableSummarySourceAuthority | undefined
    if (!row || row.draftId !== item.draftId || row.chapterNumber !== item.chapterNumber
      || row.sourceFinalizationId !== item.sourceFinalizationId || row.sourceContentHash !== item.sourceContentHash
      || row.projectionGeneration !== item.projectionGeneration) invalid()
  }
}

export function serializePortableTransferAuthority(authority: PortableTransferAuthority): Buffer {
  const bytes = Buffer.from(JSON.stringify(parsePortableTransferAuthority(authority)), 'utf8')
  if (bytes.length > MAX_BYTES) invalid()
  return bytes
}
