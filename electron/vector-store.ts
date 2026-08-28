/**
 * Vela 向量数据库封装 — 基于 LanceDB
 *
 * `chunks` 是始终可用的全文文本事实源。每个嵌入空间都有独立物理表，避免
 * 不同模型、维度或距离语义的向量混写进同一 Arrow FixedSizeList。
 */
import * as lancedb from '@lancedb/lancedb'
import { Field, FixedSizeList as ArrowFixedSizeList, Float32, Int32, Utf8, Schema as ArrowSchema } from 'apache-arrow'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

// ===== 类型定义 =====

/** 写入 LanceDB 的文本块记录 */
export interface ChunkRecord {
  [key: string]: unknown
  id: string
  docId: string
  fileName: string
  /** 章节号（可选，用于范围检索） */
  chapterNumber?: number
  /** 章节标题（可选，用于展示） */
  chapterTitle?: string
  text: string
  vector?: number[]
  chunkIndex: number
  totalChunks: number
  importedAt: string
  corpusKind: KnowledgeCorpusKind
}

export type KnowledgeCorpusKind = 'reference' | 'project-knowledge' | 'unknown'

/** 文档元信息（聚合查询结果） */
export interface DocumentInfo {
  [key: string]: unknown
  id: string
  fileName: string
  importedAt: string
  chunkCount: number
  filePath: string
  corpusKind: KnowledgeCorpusKind
}

/** 检索结果 */
export interface SearchResult {
  text: string
  score: number
  fileName: string
}

/** 知识库统计 */
export interface KBStats {
  documentCount: number
  totalChunks: number
  vectorDimension: number
  hasVectors: boolean
}

/** 由调用方提供、且不包含密钥的嵌入模型身份。 */
export interface EmbeddingSpaceIdentity {
  modelFingerprint?: string
  distanceMetric?: string
}

export type EmbeddingSpaceStatus = 'active' | 'building' | 'inactive'

/** 一个可比较的向量集合及其物理表。 */
export interface EmbeddingSpace {
  generation: number
  tableName: string
  modelFingerprint: string
  vectorDimension: number
  distanceMetric: string
  status: EmbeddingSpaceStatus
  createdAt: string
}

export interface EmbeddingSpaceRegistry {
  version: 1
  activeGeneration: number | null
  spaces: EmbeddingSpace[]
}

/**
 * A rebuild is deliberately planned only after a real embedding response has
 * supplied its dimension.  `rebuild` always receives every canonical chunk
 * and writes an isolated generation; it never appends to the current active
 * table.
 */
export type EmbeddingRebuildMode = 'up-to-date' | 'activate' | 'rebuild'

export interface EmbeddingRebuildPlan {
  mode: EmbeddingRebuildMode
  identity: Required<EmbeddingSpaceIdentity>
  vectorDimension: number
  chunks: Array<{ id: string; text: string }>
}

export type EmbeddingRebuildPlanResult =
  | { success: true; plan: EmbeddingRebuildPlan }
  | { success: false; error: string }

// ===== 常量 =====

const TABLE_NAME = 'chunks'
const DOCS_TABLE_NAME = 'documents'
const EMBEDDING_TABLE_PREFIX = 'chunks__space_'
const EMBEDDING_REGISTRY_FILE = 'embedding-spaces.json'
const LEGACY_MIGRATION_JOURNAL_FILE = 'vectors.json.migration-journal.json'
const LEGACY_MODEL_FINGERPRINT = 'legacy:unknown'
const LEGACY_COMPAT_MODEL_PREFIX = 'legacy:dimension:'
const DEFAULT_DISTANCE_METRIC = 'l2'

// ===== 连接池（按项目路径缓存） =====

const connectionPool = new Map<string, lancedb.Connection>()
const legacyMigrationInFlight = new Map<string, Promise<{ success: boolean; migrated: number; error?: string }>>()
const embeddingTableCreationOwners = new Set<string>()

function databasePath(projectPath: string): string {
  return path.join(projectPath, '.vela', 'lancedb')
}

function registryPath(projectPath: string): string {
  return path.join(projectPath, '.vela', EMBEDDING_REGISTRY_FILE)
}

function legacyMigrationJournalPath(projectPath: string): string {
  return path.join(projectPath, '.vela', LEGACY_MIGRATION_JOURNAL_FILE)
}

/** 获取 LanceDB 连接（惰性创建） */
export async function getConnection(projectPath: string): Promise<lancedb.Connection> {
  const dbPath = databasePath(projectPath)
  const cached = connectionPool.get(dbPath)
  if (cached) return cached

  fs.mkdirSync(dbPath, { recursive: true })
  const db = await lancedb.connect(dbPath)
  connectionPool.set(dbPath, db)
  return db
}

/** 关闭指定项目的连接 */
export function closeConnection(projectPath: string): void {
  const dbPath = databasePath(projectPath)
  const connection = connectionPool.get(dbPath)
  connectionPool.delete(dbPath)
  connection?.close()
}

function canonicalChunkSchema(): ArrowSchema {
  return new ArrowSchema([
    new Field('id', new Utf8()),
    new Field('docId', new Utf8()),
    new Field('fileName', new Utf8()),
    new Field('chapterNumber', new Int32(), true),
    new Field('chapterTitle', new Utf8(), true),
    new Field('text', new Utf8()),
    new Field('chunkIndex', new Int32()),
    new Field('totalChunks', new Int32()),
    new Field('importedAt', new Utf8()),
    new Field('corpusKind', new Utf8()),
  ])
}

function embeddingChunkSchema(dimension: number): ArrowSchema {
  return new ArrowSchema([
    new Field('id', new Utf8()),
    new Field('docId', new Utf8()),
    new Field('fileName', new Utf8()),
    new Field('chapterNumber', new Int32(), true),
    new Field('chapterTitle', new Utf8(), true),
    new Field('text', new Utf8()),
    new Field('vector', new ArrowFixedSizeList(dimension, new Field('item', new Float32())), false),
    new Field('chunkIndex', new Int32()),
    new Field('totalChunks', new Int32()),
    new Field('importedAt', new Utf8()),
    new Field('corpusKind', new Utf8()),
  ])
}

function normalizedIdentity(identity?: EmbeddingSpaceIdentity, dimension?: number): Required<EmbeddingSpaceIdentity> {
  return {
    // 旧的 vector-store 直调没有模型描述符；以维度作为保守兼容身份，避免把
    // 不同维度误判为同一模型，同时不破坏同维度旧调用的读写行为。
    modelFingerprint: identity?.modelFingerprint?.trim() || `${LEGACY_COMPAT_MODEL_PREFIX}${dimension ?? 'unknown'}`,
    distanceMetric: identity?.distanceMetric?.trim().toLowerCase() || DEFAULT_DISTANCE_METRIC,
  }
}

function validateVectorsForChunks(chunks: readonly unknown[], vectors?: unknown): { vectors?: number[][]; dimension?: number; error?: string } {
  if (vectors === undefined) return {}
  if (!Array.isArray(vectors)) {
    return { error: '向量批次无效：必须是与文本块一一对应的数组' }
  }
  if (vectors.length !== chunks.length) {
    return { error: `向量批次数量不匹配：期望 ${chunks.length}，实际 ${vectors.length}` }
  }
  if (vectors.length === 0) {
    return { error: '向量批次为空，无法建立嵌入空间' }
  }

  let dimension: number | undefined
  const normalized: number[][] = []
  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index]
    if (!Array.isArray(vector) || vector.length === 0) {
      return { error: `第 ${index + 1} 个向量为空或无效` }
    }
    if (dimension === undefined) {
      dimension = vector.length
    } else if (vector.length !== dimension) {
      return { error: `向量维度不一致：第 1 个为 ${dimension} 维，第 ${index + 1} 个为 ${vector.length} 维` }
    }
    const values: number[] = []
    for (const value of vector) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: `第 ${index + 1} 个向量包含非有限数值` }
      }
      values.push(value)
    }
    normalized.push(values)
  }

  return { vectors: normalized, dimension }
}

function validateChunks(chunks: unknown): chunks is string[] {
  return Array.isArray(chunks) && chunks.length > 0 && chunks.every(chunk => typeof chunk === 'string')
}

function asNumberArray(value: unknown): number[] | undefined {
  if (Array.isArray(value)) return value.filter((entry): entry is number => typeof entry === 'number')
  if (value && typeof value === 'object' && 'toArray' in value && typeof value.toArray === 'function') {
    return asNumberArray(value.toArray())
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>)
  }
  return undefined
}

function vectorIsUsable(value: unknown, dimension?: number): boolean {
  const vector = asNumberArray(value)
  return vector !== undefined
    && vector.length > 0
    && (dimension === undefined || vector.length === dimension)
    && vector.every(Number.isFinite)
}

function dimensionFromField(field: { type?: unknown } | undefined): number | undefined {
  if (!field?.type || typeof field.type !== 'object') return undefined
  const listSize = (field.type as { listSize?: unknown }).listSize
  return typeof listSize === 'number' && Number.isInteger(listSize) && listSize > 0 ? listSize : undefined
}

async function vectorDimensionFromTable(table: lancedb.Table): Promise<number | undefined> {
  const schema = await table.schema()
  const vectorField = schema.fields.find(field => field.name === 'vector')
  const fieldDimension = dimensionFromField(vectorField)
  if (fieldDimension !== undefined) return fieldDimension

  if (!vectorField) return undefined
  const rows = await table.query().select(['vector']).limit(1).toArray()
  const vector = rows[0] && asNumberArray((rows[0] as { vector?: unknown }).vector)
  return vector?.length || undefined
}

function emptyRegistry(): EmbeddingSpaceRegistry {
  return { version: 1, activeGeneration: null, spaces: [] }
}

function validateRegistry(value: unknown): EmbeddingSpaceRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('嵌入空间元数据损坏，未修改现有向量表')
  }
  const candidate = value as Partial<EmbeddingSpaceRegistry>
  if (candidate.version !== 1 || !Array.isArray(candidate.spaces)) {
    throw new Error('嵌入空间元数据版本无效，未修改现有向量表')
  }
  const spaces = candidate.spaces.map((space) => {
    if (
      !space
      || typeof space.generation !== 'number'
      || !Number.isInteger(space.generation)
      || space.generation < 0
      || typeof space.tableName !== 'string'
      || !space.tableName
      || typeof space.modelFingerprint !== 'string'
      || !space.modelFingerprint
      || typeof space.vectorDimension !== 'number'
      || !Number.isInteger(space.vectorDimension)
      || space.vectorDimension <= 0
      || typeof space.distanceMetric !== 'string'
      || !space.distanceMetric
      || !['active', 'building', 'inactive'].includes(space.status)
      || typeof space.createdAt !== 'string'
    ) {
      throw new Error('嵌入空间元数据字段无效，未修改现有向量表')
    }
    return { ...space }
  })
  const activeGeneration = candidate.activeGeneration ?? null
  if (activeGeneration !== null && (!Number.isInteger(activeGeneration) || !spaces.some(space => space.generation === activeGeneration))) {
    throw new Error('嵌入空间 active 指针无效，未修改现有向量表')
  }
  return { version: 1, activeGeneration, spaces }
}

function readRegistry(projectPath: string): EmbeddingSpaceRegistry | undefined {
  const filePath = registryPath(projectPath)
  if (!fs.existsSync(filePath)) return undefined
  try {
    return validateRegistry(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch (error) {
    if (error instanceof Error && error.message.includes('嵌入空间')) throw error
    throw new Error('嵌入空间元数据无法读取，未修改现有向量表')
  }
}

function writeRegistry(projectPath: string, registry: EmbeddingSpaceRegistry): void {
  const filePath = registryPath(projectPath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true })
  }
}

async function inferLegacyRegistry(
  db: lancedb.Connection,
  tableNames: string[],
): Promise<EmbeddingSpaceRegistry> {
  const registry = emptyRegistry()
  if (tableNames.includes(TABLE_NAME)) {
    const legacyTable = await db.openTable(TABLE_NAME)
    const dimension = await vectorDimensionFromTable(legacyTable)
    if (dimension !== undefined) {
      registry.activeGeneration = 0
      registry.spaces.push({
        generation: 0,
        tableName: TABLE_NAME,
        modelFingerprint: LEGACY_MODEL_FINGERPRINT,
        vectorDimension: dimension,
        distanceMetric: DEFAULT_DISTANCE_METRIC,
        status: 'active',
        createdAt: new Date().toISOString(),
      })
    }
  }
  return registry
}

async function loadOrRegisterLegacyRegistry(
  projectPath: string,
  db: lancedb.Connection,
  tableNames: string[],
): Promise<EmbeddingSpaceRegistry> {
  const stored = readRegistry(projectPath)
  if (stored) return stored

  const registry = await inferLegacyRegistry(db, tableNames)
  if (registry.spaces.length > 0) {
    // 只登记，不转换、更名或删除旧表。
    writeRegistry(projectPath, registry)
  }
  return registry
}

/** 读取当前元数据；旧 2048 表会在这里安全登记为 legacy 空间。 */
export async function getEmbeddingSpaces(projectPath: string): Promise<EmbeddingSpaceRegistry> {
  const db = await getConnection(projectPath)
  const registry = await loadOrRegisterLegacyRegistry(projectPath, db, await db.tableNames())
  return {
    ...registry,
    spaces: registry.spaces.map(space => ({ ...space })),
  }
}

function matchingSpace(
  registry: EmbeddingSpaceRegistry,
  identity: Required<EmbeddingSpaceIdentity>,
  dimension: number,
): EmbeddingSpace | undefined {
  return registry.spaces.find(space => (
    space.modelFingerprint === identity.modelFingerprint
    && space.distanceMetric === identity.distanceMetric
    && space.vectorDimension === dimension
  ))
}

function nextSpace(registry: EmbeddingSpaceRegistry, identity: Required<EmbeddingSpaceIdentity>, dimension: number): EmbeddingSpace {
  const generation = Math.max(0, ...registry.spaces.map(space => space.generation)) + 1
  return {
    generation,
    tableName: `${EMBEDDING_TABLE_PREFIX}${generation}`,
    modelFingerprint: identity.modelFingerprint,
    distanceMetric: identity.distanceMetric,
    vectorDimension: dimension,
    status: 'building',
    createdAt: new Date().toISOString(),
  }
}

function embeddingTableDirectory(projectPath: string, tableName: string): string {
  return path.join(databasePath(projectPath), `${tableName}.lance`)
}

function removeEmptyUnregisteredTableDirectory(projectPath: string, tableName: string): void {
  const tableDirectory = embeddingTableDirectory(projectPath, tableName)
  if (!fs.existsSync(tableDirectory)) return
  const stat = fs.statSync(tableDirectory)
  if (!stat.isDirectory() || fs.readdirSync(tableDirectory).length > 0) {
    throw new Error(`嵌入空间 ${tableName} 存在未登记数据，已拒绝覆盖；请修复知识库后重试`)
  }
  fs.rmdirSync(tableDirectory)
}

async function cleanupOwnedTableCreation(
  projectPath: string,
  db: lancedb.Connection,
  tableName: string,
): Promise<void> {
  const registry = readRegistry(projectPath)
  if (registry?.spaces.some(space => space.tableName === tableName)) return
  try {
    if ((await db.tableNames()).includes(tableName)) {
      await db.dropTable(tableName)
    } else {
      removeEmptyUnregisteredTableDirectory(projectPath, tableName)
    }
  } catch (cleanupError) {
    console.warn(`[Vela VectorStore] 清理本次失败的嵌入表 ${tableName} 失败:`, cleanupError)
  }
}

async function createOwnedEmbeddingTable(
  projectPath: string,
  db: lancedb.Connection,
  space: EmbeddingSpace,
  records: ReadonlyArray<Record<string, unknown>>,
  schema: ArrowSchema,
): Promise<void> {
  const ownershipKey = `${databasePath(projectPath)}\0${space.tableName}`
  if (embeddingTableCreationOwners.has(ownershipKey)) {
    throw new Error(`嵌入空间 ${space.tableName} 正在创建，请稍后重试`)
  }

  embeddingTableCreationOwners.add(ownershipKey)
  try {
    // A native createTable failure can leave an empty unregistered directory.
    // Removing only an empty exact candidate is safe and lets the same
    // generation be retried without deleting any table that contains data.
    removeEmptyUnregisteredTableDirectory(projectPath, space.tableName)
    try {
      await db.createTable(space.tableName, recordsForSchema(records, schema), { schema })
    } catch (error) {
      await cleanupOwnedTableCreation(projectPath, db, space.tableName)
      throw error
    }
  } finally {
    embeddingTableCreationOwners.delete(ownershipKey)
  }
}

function recordsForSchema(records: ReadonlyArray<Record<string, unknown>>, schema: { fields: Array<{ name: string }> }): Record<string, unknown>[] {
  const fieldNames = new Set(schema.fields.map(field => field.name))
  return records.map((record) => {
    const compatible: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (value !== undefined && fieldNames.has(key)) compatible[key] = value
    }
    return compatible
  })
}

async function appendCompatibleRecords(table: lancedb.Table, records: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  if (records.length === 0) return
  await ensureCorpusKindColumn(table)
  const schema = await table.schema()
  await table.add(recordsForSchema(records, schema))
}

async function ensureCorpusKindColumn(table: lancedb.Table): Promise<void> {
  const schema = await table.schema()
  if (schema.fields.some(field => field.name === 'corpusKind')) return
  await table.addColumns([{ name: 'corpusKind', valueSql: "'unknown'" }])
}

async function appendCanonicalRecords(
  db: lancedb.Connection,
  tableNames: readonly string[],
  records: ReadonlyArray<ChunkRecord>,
): Promise<void> {
  if (!tableNames.includes(TABLE_NAME)) {
    await db.createTable(TABLE_NAME, recordsForSchema(records, canonicalChunkSchema()), { schema: canonicalChunkSchema() })
    return
  }
  await appendCompatibleRecords(await db.openTable(TABLE_NAME), records)
}

async function ensureTextIndex(table: lancedb.Table): Promise<void> {
  try {
    await table.createIndex('text', { config: lancedb.Index.fts() })
  } catch {
    // 已有索引和不支持 FTS 的旧 LanceDB 都不应阻断文本写入。
  }
}

interface EmbeddingWrite {
  space: EmbeddingSpace
  tableName: string
  newlyCreated: boolean
}

async function appendEmbeddingRecords(
  projectPath: string,
  db: lancedb.Connection,
  registry: EmbeddingSpaceRegistry,
  records: ReadonlyArray<ChunkRecord>,
  dimension: number,
  identity: Required<EmbeddingSpaceIdentity>,
): Promise<EmbeddingWrite> {
  const existing = matchingSpace(registry, identity, dimension)
  if (existing) {
    await appendCompatibleRecords(await db.openTable(existing.tableName), records)
    return { space: existing, tableName: existing.tableName, newlyCreated: false }
  }

  const space = nextSpace(registry, identity, dimension)
  await createOwnedEmbeddingTable(projectPath, db, space, records, embeddingChunkSchema(dimension))
  return { space, tableName: space.tableName, newlyCreated: true }
}

/**
 * Compensate only the physical embedding write owned by the failed operation.
 * A newly-created generation can be dropped wholesale; a pre-existing
 * generation must keep its table and all rows except the exact IDs appended by
 * this operation.  Keeping ownership explicit prevents cleanup from ever
 * dropping an old or active generation.
 */
async function compensateEmbeddingWrite(
  db: lancedb.Connection,
  write: EmbeddingWrite,
  recordIds: readonly string[],
): Promise<void> {
  try {
    const tableNames = await db.tableNames()
    if (!tableNames.includes(write.tableName)) return
    if (write.newlyCreated) {
      await db.dropTable(write.tableName)
      return
    }

    const table = await db.openTable(write.tableName)
    for (const recordId of recordIds) {
      await table.delete(`id = '${recordId.replace(/'/g, "''")}'`)
    }
  } catch (error) {
    console.warn(`[Vela VectorStore] 补偿嵌入写入 ${write.tableName} 失败:`, error)
  }
}

async function completeForCanonicalTable(
  db: lancedb.Connection,
  space: EmbeddingSpace,
): Promise<boolean> {
  const canonicalRows = await (await db.openTable(TABLE_NAME)).query().select(['id']).toArray()
  const vectorRows = await (await db.openTable(space.tableName)).query().select(['id', 'vector']).toArray()
  const canonicalIds = canonicalRows.map(row => (row as { id?: unknown }).id)
  const vectorIds = vectorRows.map(row => (row as { id?: unknown }).id)
  if (
    canonicalRows.length !== vectorRows.length
    || canonicalIds.some(id => typeof id !== 'string' || !id)
    || vectorIds.some(id => typeof id !== 'string' || !id)
    || new Set(canonicalIds).size !== canonicalIds.length
    || new Set(vectorIds).size !== vectorIds.length
    || vectorRows.some(row => !vectorIsUsable((row as { vector?: unknown }).vector, space.vectorDimension))
  ) {
    return false
  }

  const vectorIdSet = new Set(vectorIds)
  return canonicalIds.every(id => vectorIdSet.has(id))
}

async function verifyQueryableEmbeddingSpace(
  db: lancedb.Connection,
  space: EmbeddingSpace,
): Promise<boolean> {
  const table = await db.openTable(space.tableName)
  const rows = await table.query().select(['vector']).limit(1).toArray()
  const probe = rows[0] && asNumberArray((rows[0] as { vector?: unknown }).vector)
  if (!probe || !vectorIsUsable(probe, space.vectorDimension)) return false
  // 用真实向量做一次最小查询，确保“可读行”不是只有 Arrow schema 表面成立。
  return (await table.search(probe).limit(1).toArray()).length > 0
}

function registryWithActiveGeneration(
  registry: EmbeddingSpaceRegistry,
  generation: number,
): EmbeddingSpaceRegistry {
  return {
    version: 1,
    activeGeneration: generation,
    spaces: registry.spaces.map((space) => ({
      ...space,
      status: space.generation === generation
        ? 'active'
        : space.status === 'active'
          ? 'inactive'
          : space.status,
    })),
  }
}

/**
 * Canonical text can outgrow every existing vector generation when an import
 * falls back to FTS-only.  Persist this conservative transition before any
 * canonical write: a crash may lose vector acceleration, but never exposes an
 * active generation that omits newly committed canonical rows.
 */
function registryWithNoActiveGeneration(registry: EmbeddingSpaceRegistry): EmbeddingSpaceRegistry {
  return {
    version: 1,
    activeGeneration: null,
    spaces: registry.spaces.map((space) => ({
      ...space,
      status: space.status === 'active' ? 'inactive' : space.status,
    })),
  }
}

async function finaliseEmbeddingWrite(
  projectPath: string,
  db: lancedb.Connection,
  registry: EmbeddingSpaceRegistry,
  write: EmbeddingWrite,
): Promise<void> {
  if (write.newlyCreated) registry.spaces.push(write.space)
  const complete = await completeForCanonicalTable(db, write.space)
  const queryable = complete && await verifyQueryableEmbeddingSpace(db, write.space)
  if (queryable) {
    for (const space of registry.spaces) {
      if (space.generation === write.space.generation) {
        space.status = 'active'
      } else if (space.status === 'active') {
        space.status = 'inactive'
      }
    }
    registry.activeGeneration = write.space.generation
  } else {
    write.space.status = 'building'
    if (registry.activeGeneration === write.space.generation) {
      const fallback = registry.spaces.find(space => (
        space.generation !== write.space.generation && space.status === 'active'
      ))
      registry.activeGeneration = fallback?.generation ?? null
    }
  }
  // 仅在表已写入、可重新打开且完整性已验证后切换 active 指针。
  writeRegistry(projectPath, registry)
}

async function canonicalRecordsForEmbeddingRebuild(
  db: lancedb.Connection,
): Promise<ChunkRecord[]> {
  const rows = await (await db.openTable(TABLE_NAME)).query().toArray()
  return rows.map(row => ({ ...(row as Record<string, unknown>) })) as ChunkRecord[]
}

function canonicalReferences(records: readonly ChunkRecord[]): Array<{ id: string; text: string }> {
  return records.map(record => ({ id: record.id, text: record.text }))
}

/**
 * Return canonical text without selecting an embedding generation.  The
 * knowledge-base layer uses one of these rows as an actual-provider probe
 * before deciding which generation may receive a write.
 */
export async function getCanonicalChunksForEmbeddingRebuild(
  projectPath: string,
): Promise<Array<{ id: string; text: string }>> {
  // Validate persisted metadata before the caller makes any provider request.
  // This is intentionally read-only and does not infer/register legacy state.
  readRegistry(projectPath)
  const db = await getConnection(projectPath)
  if (!(await db.tableNames()).includes(TABLE_NAME)) return []
  return canonicalReferences(await canonicalRecordsForEmbeddingRebuild(db))
}

/**
 * Plan an explicit rebuild only after a real response established the actual
 * vector dimension.  This is read-only: invalid probes and failed planning
 * leave the existing registry and every vector table untouched.
 */
export async function planEmbeddingRebuild(
  projectPath: string,
  embeddingSpace: EmbeddingSpaceIdentity | undefined,
  probeVector: unknown,
): Promise<EmbeddingRebuildPlanResult> {
  const validation = validateVectorsForChunks(['canonical probe'], [probeVector])
  if (validation.error || validation.dimension === undefined) {
    return { success: false, error: validation.error ?? '嵌入探测响应为空，无法确定向量维度' }
  }

  const identity = normalizedIdentity(embeddingSpace, validation.dimension)
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) {
      return {
        success: true,
        plan: { mode: 'up-to-date', identity, vectorDimension: validation.dimension, chunks: [] },
      }
    }

    // Unlike ordinary reads, a failed probe/planning pass must not create a
    // registry for a legacy table.  A registry is persisted only with a
    // verified, successful switch below.
    const registry = readRegistry(projectPath) ?? await inferLegacyRegistry(db, tableNames)
    const canonical = await canonicalRecordsForEmbeddingRebuild(db)
    const matching = matchingSpace(registry, identity, validation.dimension)
    if (matching && tableNames.includes(matching.tableName)) {
      const complete = await completeForCanonicalTable(db, matching)
      const queryable = complete && await verifyQueryableEmbeddingSpace(db, matching)
      if (queryable) {
        return {
          success: true,
          plan: {
            mode: registry.activeGeneration === matching.generation ? 'up-to-date' : 'activate',
            identity,
            vectorDimension: validation.dimension,
            chunks: [],
          },
        }
      }
    }

    // An incomplete or dimension-incompatible generation is never amended in
    // place by this flow.  A separate table lets the prior active generation
    // continue serving queries until every canonical row is verified.
    return {
      success: true,
      plan: {
        mode: 'rebuild',
        identity,
        vectorDimension: validation.dimension,
        chunks: canonicalReferences(canonical),
      },
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Atomically select a previously complete generation.  It re-verifies the
 * table before changing the registry, so a failed activation cannot demote an
 * old active generation.
 */
export async function activatePlannedEmbeddingSpace(
  projectPath: string,
  plan: EmbeddingRebuildPlan,
): Promise<{ success: boolean; error?: string }> {
  if (plan.mode !== 'activate') {
    return { success: false, error: '当前嵌入空间不允许直接激活' }
  }
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    const registry = readRegistry(projectPath) ?? await inferLegacyRegistry(db, tableNames)
    const matching = matchingSpace(registry, plan.identity, plan.vectorDimension)
    if (!matching || !tableNames.includes(matching.tableName)) {
      return { success: false, error: '目标嵌入空间不存在，未修改当前索引' }
    }
    if (!(await completeForCanonicalTable(db, matching)) || !(await verifyQueryableEmbeddingSpace(db, matching))) {
      return { success: false, error: '目标嵌入空间未完整验证，旧索引保持不变' }
    }
    writeRegistry(projectPath, registryWithActiveGeneration(registry, matching.generation))
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Build a fresh generation from a full, frozen canonical snapshot.  Every
 * validation happens before creating the new table; after creation the table
 * is removed on every unsuccessful path.  The prior registry is only written
 * after the new generation has passed completeness and query probes.
 */
export async function rebuildPlannedEmbeddingSpace(
  projectPath: string,
  plan: EmbeddingRebuildPlan,
  updates: Array<{ id: string; vector: number[] }>,
): Promise<{ success: boolean; count: number; error?: string }> {
  if (plan.mode !== 'rebuild') {
    return { success: false, count: 0, error: '当前嵌入空间不需要新建代际' }
  }
  if (updates.length !== plan.chunks.length || new Set(updates.map(update => update.id)).size !== updates.length) {
    return { success: false, count: 0, error: '重建向量与冻结文本块不一致，未修改当前索引' }
  }
  const validation = validateVectorsForChunks(plan.chunks.map(chunk => chunk.id), updates.map(update => update.vector))
  if (validation.error || !validation.vectors || validation.dimension === undefined) {
    return { success: false, count: 0, error: validation.error ?? '重建向量无效' }
  }
  if (validation.dimension !== plan.vectorDimension) {
    return { success: false, count: 0, error: '重建期间向量维度发生变化，旧索引保持不变' }
  }

  let db: lancedb.Connection | undefined
  let newSpace: EmbeddingSpace | undefined
  let tableCreated = false
  try {
    db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) {
      return { success: false, count: 0, error: '知识库文本块不存在，未修改当前索引' }
    }
    const registry = readRegistry(projectPath) ?? await inferLegacyRegistry(db, tableNames)
    const canonical = await canonicalRecordsForEmbeddingRebuild(db)
    const plannedById = new Map(plan.chunks.map(chunk => [chunk.id, chunk.text]))
    if (
      canonical.length !== plan.chunks.length
      || plannedById.size !== plan.chunks.length
      || canonical.some(record => plannedById.get(record.id) !== record.text)
    ) {
      return { success: false, count: 0, error: '知识库文本已变化，请重新检查并重建向量索引' }
    }
    // A concurrent completed rebuild should be observed and replanned rather
    // than appended to. An incomplete generation is intentionally left alone;
    // this operation creates another isolated table instead of mutating it.
    const existing = matchingSpace(registry, plan.identity, plan.vectorDimension)
    if (
      existing
      && tableNames.includes(existing.tableName)
      && await completeForCanonicalTable(db, existing)
      && await verifyQueryableEmbeddingSpace(db, existing)
    ) {
      return { success: false, count: 0, error: '嵌入空间状态已变化，请重新检查并重建向量索引' }
    }

    const vectorsById = new Map(updates.map((update, index) => [update.id, validation.vectors![index]]))
    if (vectorsById.size !== canonical.length || canonical.some(record => !vectorsById.has(record.id))) {
      return { success: false, count: 0, error: '重建向量缺少文本块，旧索引保持不变' }
    }
    newSpace = nextSpace(registry, plan.identity, plan.vectorDimension)
    const records = canonical.map(record => ({ ...record, vector: vectorsById.get(record.id)! }))
    await createOwnedEmbeddingTable(
      projectPath,
      db,
      newSpace,
      records,
      embeddingChunkSchema(plan.vectorDimension),
    )
    tableCreated = true

    if (!(await completeForCanonicalTable(db, newSpace)) || !(await verifyQueryableEmbeddingSpace(db, newSpace))) {
      throw new Error('新嵌入空间未通过完整性验证')
    }
    const nextRegistry = registryWithActiveGeneration({
      version: 1,
      activeGeneration: registry.activeGeneration,
      spaces: [...registry.spaces.map(space => ({ ...space })), newSpace],
    }, newSpace.generation)
    writeRegistry(projectPath, nextRegistry)
    return { success: true, count: records.length }
  } catch (error) {
    if (tableCreated && db && newSpace) {
      try {
        await db.dropTable(newSpace.tableName)
      } catch (cleanupError) {
        console.warn('[Vela VectorStore] 清理失败的嵌入重建表失败:', cleanupError)
      }
    }
    return {
      success: false,
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function writeDocumentInfo(
  db: lancedb.Connection,
  tableNames: readonly string[],
  docInfo: DocumentInfo,
): Promise<void> {
  if (!tableNames.includes(DOCS_TABLE_NAME)) {
    await db.createTable(DOCS_TABLE_NAME, [docInfo])
    return
  }
  const docsTable = await db.openTable(DOCS_TABLE_NAME)
  await ensureCorpusKindColumn(docsTable)
  // 先追加。若后续 canonical/vector/catalog 任一步失败，旧同名文档仍然存在，
  // 回滚也只会删除本次 docId。
  await docsTable.add([docInfo])
}

async function pruneSupersededDocumentInfo(
  db: lancedb.Connection,
  docInfo: DocumentInfo,
): Promise<void> {
  try {
    const docsTable = await db.openTable(DOCS_TABLE_NAME)
    const fileName = docInfo.fileName.replace(/'/g, "''")
    const docId = docInfo.id.replace(/'/g, "''")
    const corpusKind = docInfo.corpusKind.replace(/'/g, "''")
    await docsTable.delete(`\`fileName\` = '${fileName}' AND \`corpusKind\` = '${corpusKind}' AND id != '${docId}'`)
  } catch (error) {
    // 这一步是旧元数据整理，不应将已完成的安全写入变成失败或删除新数据。
    console.warn('[Vela VectorStore] 清理同名旧文档元数据失败:', error)
  }
}

async function rollbackCurrentWrite(
  db: lancedb.Connection,
  chunkIds: readonly string[],
  docId: string,
): Promise<void> {
  try {
    const tableNames = await db.tableNames()
    const escapedDocId = docId.replace(/'/g, "''")
    for (const tableName of tableNames) {
      try {
        const table = await db.openTable(tableName)
        if (tableName === DOCS_TABLE_NAME) {
          await table.delete(`id = '${escapedDocId}'`)
        } else if (tableName === TABLE_NAME || tableName.startsWith(EMBEDDING_TABLE_PREFIX)) {
          // 以本次生成的 chunk id 精确删除，避免触碰同一 docId 的历史数据。
          for (const chunkId of chunkIds) {
            await table.delete(`id = '${chunkId.replace(/'/g, "''")}'`)
          }
        }
      } catch (error) {
        console.warn(`[Vela VectorStore] 回滚 ${tableName} 的本次写入失败:`, error)
      }
    }
  } catch (error) {
    console.warn('[Vela VectorStore] 读取回滚目标失败:', error)
  }
}

// ===== 核心操作 =====

/**
 * 写入文档块到 LanceDB。
 * 文本先后均可独立检索；带向量时仅写入匹配的版本化嵌入空间。
 */
export async function addChunks(
  projectPath: string,
  docId: string,
  fileName: string,
  chunks: string[],
  vectors?: number[][],
  filePath?: string,
  metadata?: {
    chapterNumber?: number
    chapterTitle?: string
    corpusKind?: KnowledgeCorpusKind
    replacementMode?: 'by-file-name' | 'stable-id'
  },
  embeddingSpace?: EmbeddingSpaceIdentity,
): Promise<{ success: boolean; chunkCount: number; error?: string }> {
  if (!validateChunks(chunks)) {
    return { success: false, chunkCount: 0, error: '文本块为空或格式无效' }
  }
  const validation = validateVectorsForChunks(chunks, vectors)
  if (validation.error) {
    return { success: false, chunkCount: 0, error: validation.error }
  }

  let db: lancedb.Connection | undefined
  let rollbackRequired = false
  let chunkIds: string[] = []
  let embeddingWrite: EmbeddingWrite | undefined
  try {
    db = await getConnection(projectPath)
    const now = new Date().toISOString()
    const corpusKind = metadata?.corpusKind ?? 'unknown'
    const canonicalRecords: ChunkRecord[] = chunks.map((text, index) => ({
      id: randomUUID(),
      docId,
      fileName,
      text,
      chunkIndex: index,
      totalChunks: chunks.length,
      importedAt: now,
      chapterNumber: metadata?.chapterNumber,
      chapterTitle: metadata?.chapterTitle,
      corpusKind,
    }))
    chunkIds = canonicalRecords.map(record => record.id)
    const tableNames = await db.tableNames()
    const registry = await loadOrRegisterLegacyRegistry(projectPath, db, tableNames)

    if (validation.vectors && validation.dimension !== undefined) {
      const identity = normalizedIdentity(embeddingSpace, validation.dimension)
      const existingSpace = matchingSpace(registry, identity, validation.dimension)
      const canonicalHasRows = tableNames.includes(TABLE_NAME)
        && await (await db.openTable(TABLE_NAME)).countRows() > 0
      // 普通导入不能把新模型当作“顺手重建”。存在任何已知空间，或已有仅全文
      // 文本但尚未显式回填时，调用方必须进入明确的 rebuild/backfill 流程。
      if (!existingSpace && (registry.spaces.length > 0 || canonicalHasRows)) {
        const active = activeSpace(registry)
        const current = active
          ? `${active.modelFingerprint} / ${active.vectorDimension} 维`
          : '当前全文知识库'
        return {
          success: false,
          chunkCount: 0,
          error: `reindex_required: 嵌入空间与${current}不兼容；请先执行显式向量回填/重建，旧代际未被修改`,
        }
      }
      const vectorRecords = canonicalRecords.map((record, index) => ({
        ...record,
        vector: validation.vectors![index],
      }))
      embeddingWrite = await appendEmbeddingRecords(
        projectPath,
        db,
        registry,
        vectorRecords,
        validation.dimension,
        identity,
      )
    }

    const docInfo: DocumentInfo = {
      id: docId,
      fileName,
      importedAt: now,
      chunkCount: chunks.length,
      filePath: filePath || '',
      corpusKind,
    }
    if (!validation.vectors && registry.activeGeneration !== null) {
      // This must precede document/canonical writes. Do not restore the old
      // active pointer on a later write failure: it may no longer cover a
      // committed canonical row, whereas FTS remains authoritative and safe.
      writeRegistry(projectPath, registryWithNoActiveGeneration(registry))
    }
    rollbackRequired = true
    await writeDocumentInfo(db, tableNames, docInfo)

    await appendCanonicalRecords(db, await db.tableNames(), canonicalRecords)
    const canonicalTable = await db.openTable(TABLE_NAME)
    await ensureTextIndex(canonicalTable)

    if (embeddingWrite) {
      await finaliseEmbeddingWrite(projectPath, db, registry, embeddingWrite)
    }

    if (metadata?.replacementMode !== 'stable-id') {
      await pruneSupersededDocumentInfo(db, docInfo)
    }

    rollbackRequired = false
    return { success: true, chunkCount: chunks.length }
  } catch (error) {
    if (rollbackRequired && db) {
      await rollbackCurrentWrite(db, chunkIds, docId)
    }
    if (db && embeddingWrite) {
      await compensateEmbeddingWrite(db, embeddingWrite, chunkIds)
    }
    console.error('[Vela VectorStore] 写入失败:', error)
    return { success: false, chunkCount: 0, error: String(error) }
  }
}

/** 删除文档及其在所有嵌入空间中的块，不删除任何表。 */
export async function removeDocument(projectPath: string, docId: string): Promise<boolean> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    const registry = await loadOrRegisterLegacyRegistry(projectPath, db, tableNames)
    const escapedId = docId.replace(/'/g, "''")
    const targets = new Set<string>([TABLE_NAME, ...registry.spaces.map(space => space.tableName)])
    for (const tableName of targets) {
      if (tableNames.includes(tableName)) await (await db.openTable(tableName)).delete(`\`docId\` = '${escapedId}'`)
    }
    if (tableNames.includes(DOCS_TABLE_NAME)) {
      await (await db.openTable(DOCS_TABLE_NAME)).delete(`id = '${escapedId}'`)
    }
    return true
  } catch (error) {
    console.error('[Vela VectorStore] 删除失败:', error)
    return false
  }
}

/**
 * 清空整个项目知识库。该函数是用户明确触发的清空操作，因而会删除所有代际。
 */
export async function clearAll(projectPath: string): Promise<boolean> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    for (const tableName of tableNames) {
      if (tableName === TABLE_NAME || tableName === DOCS_TABLE_NAME || tableName.startsWith(EMBEDDING_TABLE_PREFIX)) {
        await db.dropTable(tableName)
      }
    }
    const filePath = registryPath(projectPath)
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
    return true
  } catch (error) {
    console.error('[Vela VectorStore] 清空知识库失败:', error)
    return false
  }
}

function activeSpace(registry: EmbeddingSpaceRegistry): EmbeddingSpace | undefined {
  return registry.activeGeneration === null
    ? undefined
    : registry.spaces.find(space => space.generation === registry.activeGeneration)
}

function requestMatchesActiveSpace(
  space: EmbeddingSpace,
  queryVector: number[],
  identity?: EmbeddingSpaceIdentity,
): boolean {
  if (!vectorIsUsable(queryVector, space.vectorDimension)) return false
  if (!identity) return true // 保持既有 vector-store 直接调用的兼容性。
  const requested = normalizedIdentity(identity, queryVector.length)
  return space.modelFingerprint === requested.modelFingerprint && space.distanceMetric === requested.distanceMetric
}

async function tableSupportsChapterScope(table: lancedb.Table): Promise<boolean> {
  return (await table.schema()).fields.some(field => field.name === 'chapterNumber')
}

/** 统一检索入口 — 仅对当前 active 且身份匹配的空间使用向量，其他情况安全降级 FTS。 */
export async function search(
  projectPath: string,
  queryText: string,
  queryVector?: number[],
  topK: number = 5,
  embeddingSpace?: EmbeddingSpaceIdentity,
): Promise<SearchResult[]> {
  return searchWithScope(projectPath, queryText, queryVector, topK, undefined, embeddingSpace)
}

/** 支持章节范围限定的检索入口。 */
export async function searchWithScope(
  projectPath: string,
  queryText: string,
  queryVector?: number[],
  topK: number = 5,
  chapterScope?: [number, number],
  embeddingSpace?: EmbeddingSpaceIdentity,
): Promise<SearchResult[]> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) return []

    let scopeFilter: string | undefined
    if (chapterScope) {
      const [from, to] = chapterScope
      scopeFilter = `\`chapterNumber\` >= ${from} AND \`chapterNumber\` <= ${to}`
    }

    if (queryVector && vectorIsUsable(queryVector)) {
      try {
        const registry = await loadOrRegisterLegacyRegistry(projectPath, db, tableNames)
        const active = activeSpace(registry)
        if (active && tableNames.includes(active.tableName) && requestMatchesActiveSpace(active, queryVector, embeddingSpace)) {
          const vectorTable = await db.openTable(active.tableName)
          let query = vectorTable.search(queryVector).limit(topK)
          if (scopeFilter && await tableSupportsChapterScope(vectorTable)) query = query.where(scopeFilter)
          const results = await query.toArray()
          if (results.length > 0) {
            return results.map((row: { text: string; _distance?: number; fileName: string }) => ({
              text: row.text,
              score: row._distance != null ? 1 / (1 + row._distance) : 0.5,
              fileName: row.fileName,
            }))
          }
        }
      } catch (error) {
        console.warn('[Vela VectorStore] 向量检索降级为全文检索:', error)
      }
    }

    try {
      const canonicalTable = await db.openTable(TABLE_NAME)
      const escapedQuery = queryText.replace(/'/g, "''")
      const likePattern = `%${escapedQuery.split('').join('%')}%`
      const textFilter = `text LIKE '${likePattern}'`
      const filter = scopeFilter && await tableSupportsChapterScope(canonicalTable)
        ? `${textFilter} AND ${scopeFilter}`
        : textFilter
      const results = await canonicalTable.query().filter(filter).limit(topK).toArray()
      return results.map((row: { text: string; fileName: string }) => ({
        text: row.text,
        score: 0.5,
        fileName: row.fileName,
      }))
    } catch (error) {
      console.warn('[Vela VectorStore] 纯文本检索失败:', error)
      return []
    }
  } catch (error) {
    console.error('[Vela VectorStore] 检索失败:', error)
    return []
  }
}

export async function listDocuments(projectPath: string): Promise<DocumentInfo[]> {
  try {
    const db = await getConnection(projectPath)
    if (!(await db.tableNames()).includes(DOCS_TABLE_NAME)) return []
    const table = await db.openTable(DOCS_TABLE_NAME)
    await ensureCorpusKindColumn(table)
    const rows = await table.query().toArray()
    return rows.map((row: { id: string; fileName: string; importedAt: string; chunkCount: number; filePath?: string; corpusKind?: KnowledgeCorpusKind }) => ({
      id: row.id,
      fileName: row.fileName,
      importedAt: row.importedAt,
      chunkCount: row.chunkCount,
      filePath: row.filePath || '',
      corpusKind: row.corpusKind ?? 'unknown',
    }))
  } catch {
    return []
  }
}

export interface DocumentIntegrity {
  docId: string
  corpusKind: KnowledgeCorpusKind
  chunkCount: number
  chunkSetHash: string
  complete: boolean
}

export function hashCanonicalChunkSet(chunks: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(chunks), 'utf8').digest('hex')
}

/** Validate both the document commit row and every canonical chunk for a stable import. */
export async function getDocumentIntegrity(
  projectPath: string,
  docId: string,
): Promise<DocumentIntegrity | null> {
  const db = await getConnection(projectPath)
  const tableNames = await db.tableNames()
  if (!tableNames.includes(TABLE_NAME) && !tableNames.includes(DOCS_TABLE_NAME)) return null
  const escapedId = docId.replace(/'/g, "''")
  let chunkRows: Array<{ chunkIndex: number; totalChunks: number; text: string; corpusKind?: KnowledgeCorpusKind }> = []
  if (tableNames.includes(TABLE_NAME)) {
    const chunksTable = await db.openTable(TABLE_NAME)
    await ensureCorpusKindColumn(chunksTable)
    chunkRows = await chunksTable.query()
      .filter(`\`docId\` = '${escapedId}'`)
      .select(['chunkIndex', 'totalChunks', 'text', 'corpusKind'])
      .toArray() as typeof chunkRows
  }
  let documentRows: Array<{ id: string; chunkCount: number; corpusKind?: KnowledgeCorpusKind }> = []
  if (tableNames.includes(DOCS_TABLE_NAME)) {
    const docsTable = await db.openTable(DOCS_TABLE_NAME)
    await ensureCorpusKindColumn(docsTable)
    documentRows = await docsTable.query()
      .filter(`id = '${escapedId}'`)
      .select(['id', 'chunkCount', 'corpusKind'])
      .toArray() as typeof documentRows
  }
  if (documentRows.length === 0 && chunkRows.length === 0) return null
  const ordered = [...chunkRows].sort((left, right) => left.chunkIndex - right.chunkIndex)
  const document = documentRows[0]
  const corpusKind = document?.corpusKind ?? ordered[0]?.corpusKind ?? 'unknown'
  const complete = documentRows.length === 1
    && ordered.length > 0
    && document?.chunkCount === ordered.length
    && ordered.every((row, index) => (
      row.chunkIndex === index
      && row.totalChunks === ordered.length
      && (row.corpusKind ?? 'unknown') === corpusKind
      && typeof row.text === 'string'
    ))
  return {
    docId,
    corpusKind,
    chunkCount: ordered.length,
    chunkSetHash: hashCanonicalChunkSet(ordered.map(row => row.text)),
    complete,
  }
}

export async function getStats(projectPath: string): Promise<KBStats> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) {
      return { documentCount: 0, totalChunks: 0, vectorDimension: 0, hasVectors: false }
    }
    const docs = tableNames.includes(DOCS_TABLE_NAME)
      ? await (await db.openTable(DOCS_TABLE_NAME)).countRows()
      : 0
    const registry = await loadOrRegisterLegacyRegistry(projectPath, db, tableNames)
    const active = activeSpace(registry)
    return {
      documentCount: docs,
      totalChunks: await (await db.openTable(TABLE_NAME)).countRows(),
      vectorDimension: active?.vectorDimension ?? 0,
      hasVectors: active !== undefined,
    }
  } catch {
    return { documentCount: 0, totalChunks: 0, vectorDimension: 0, hasVectors: false }
  }
}

function backfillSpaceForIdentity(registry: EmbeddingSpaceRegistry, identity?: EmbeddingSpaceIdentity): EmbeddingSpace | undefined {
  if (!identity) return activeSpace(registry) ?? registry.spaces.find(space => space.status === 'building')
  const requested = normalizedIdentity(identity)
  return registry.spaces.find(space => (
    space.modelFingerprint === requested.modelFingerprint
    && space.distanceMetric === requested.distanceMetric
    && (space.status === 'active' || space.status === 'building')
  ))
}

async function vectorisedIdsForSpace(db: lancedb.Connection, space: EmbeddingSpace | undefined): Promise<Set<string>> {
  if (!space) return new Set()
  const rows = await (await db.openTable(space.tableName)).query().select(['id', 'vector']).toArray()
  return new Set(
    rows
      .filter(row => vectorIsUsable((row as { vector?: unknown }).vector, space.vectorDimension))
      .map(row => (row as { id: string }).id),
  )
}

async function missingCanonicalRows(
  db: lancedb.Connection,
  space: EmbeddingSpace | undefined,
): Promise<Array<{ id: string; text: string }>> {
  const rows = await (await db.openTable(TABLE_NAME)).query().select(['id', 'text']).toArray()
  const vectorisedIds = await vectorisedIdsForSpace(db, space)
  return rows
    .map(row => ({ id: (row as { id: string }).id, text: (row as { text: string }).text }))
    .filter(row => !vectorisedIds.has(row.id))
}

export async function getChunksWithoutVectors(
  projectPath: string,
  embeddingSpace?: EmbeddingSpaceIdentity,
): Promise<{ count: number }> {
  const db = await getConnection(projectPath)
  const tableNames = await db.tableNames()
  if (!tableNames.includes(TABLE_NAME)) return { count: 0 }
  const registry = await loadOrRegisterLegacyRegistry(projectPath, db, tableNames)
  return { count: (await missingCanonicalRows(db, backfillSpaceForIdentity(registry, embeddingSpace))).length }
}

/** 返回当前模型需要回填的文本块；不在此处创建或删除表。 */
export async function getChunksForBackfill(
  projectPath: string,
  batchSize: number = 50,
  embeddingSpace?: EmbeddingSpaceIdentity,
): Promise<Array<{ id: string; text: string }>> {
  const db = await getConnection(projectPath)
  const tableNames = await db.tableNames()
  if (!tableNames.includes(TABLE_NAME)) return []
  // Migration preflight must not create an embedding registry. If validation
  // rejects this legacy source, the project needs to remain byte-for-byte as
  // it was before the attempt.
  const registry = readRegistry(projectPath) ?? await inferLegacyRegistry(db, tableNames)
  return (await missingCanonicalRows(db, backfillSpaceForIdentity(registry, embeddingSpace))).slice(0, batchSize)
}

/**
 * 为已存在的 canonical 文本块添加向量。实际维度由更新批次决定；不覆写或
 * drop 旧表，且只有完整覆盖 canonical 表后才可能切换 active。
 */
export async function updateChunkVectors(
  projectPath: string,
  updates: Array<{ id: string; vector: number[] }>,
  embeddingSpace?: EmbeddingSpaceIdentity,
): Promise<{ success: boolean; count: number; error?: string }> {
  const validation = validateVectorsForChunks(updates.map(update => update.id), updates.map(update => update.vector))
  if (validation.error || !validation.vectors || validation.dimension === undefined) {
    return { success: false, count: 0, error: validation.error ?? '向量批次为空，无法回填' }
  }
  if (new Set(updates.map(update => update.id)).size !== updates.length) {
    return { success: false, count: 0, error: '回填向量包含重复块标识' }
  }

  let db: lancedb.Connection | undefined
  let write: EmbeddingWrite | undefined
  try {
    db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) return { success: false, count: 0, error: 'chunks 表不存在' }
    const canonicalRows = await (await db.openTable(TABLE_NAME)).query().toArray()
    const updateById = new Map(updates.map(update => [update.id, update.vector]))
    const records = canonicalRows
      .filter(row => updateById.has((row as { id: string }).id))
      .map((row) => ({
        ...(row as Record<string, unknown>),
        vector: updateById.get((row as { id: string }).id)!,
      })) as ChunkRecord[]
    if (records.length !== updates.length) {
      return { success: false, count: 0, error: '回填目标块不存在，未修改任何嵌入空间' }
    }

    const registry = await loadOrRegisterLegacyRegistry(projectPath, db, tableNames)
    write = await appendEmbeddingRecords(
      projectPath,
      db,
      registry,
      records,
      validation.dimension,
      normalizedIdentity(embeddingSpace, validation.dimension),
    )
    await finaliseEmbeddingWrite(projectPath, db, registry, write)
    return { success: true, count: updates.length }
  } catch (error) {
    if (db && write) {
      await compensateEmbeddingWrite(db, write, updates.map(update => update.id))
    }
    console.error('[Vela VectorStore] 批量更新向量失败:', error)
    return { success: false, count: 0, error: String(error) }
  }
}

interface LegacyVectorJsonDocument {
  id?: unknown
  fileName?: unknown
  filePath?: unknown
}

interface LegacyVectorJsonEntry {
  docId?: unknown
  text?: unknown
  vector?: unknown
  meta?: {
    fileName?: unknown
  }
}

interface LegacyMigrationDocument {
  docId: string
  fileName: string
  filePath?: string
  chunks: string[]
  vectors?: number[][]
}

interface LegacyMigrationPlan {
  documents: LegacyMigrationDocument[]
  migratedChunks: number
  vectorDimension?: number
}

interface LegacyMigrationJournal {
  version: 1
  sourceDigest: string
  docIds: string[]
  tableNamesBefore: string[]
  registryBefore?: string
}

function legacyMigrationError(detail: string): string {
  return `旧向量数据迁移未完成：${detail}。为防止知识库重复或损坏，导入、检索和向量回填已暂停；请修正 .vela/vectors.json 后重试。`
}

function legacySourceDigest(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

function readLegacyMigrationJournal(projectPath: string): LegacyMigrationJournal | undefined {
  const filePath = legacyMigrationJournalPath(projectPath)
  if (!fs.existsSync(filePath)) return undefined
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<LegacyMigrationJournal>
    if (
      value.version !== 1
      || typeof value.sourceDigest !== 'string'
      || !/^[a-f0-9]{64}$/i.test(value.sourceDigest)
      || !Array.isArray(value.docIds)
      || value.docIds.some(docId => typeof docId !== 'string' || !docId)
      || !Array.isArray(value.tableNamesBefore)
      || value.tableNamesBefore.some(tableName => typeof tableName !== 'string' || !tableName)
      || (value.registryBefore !== undefined && typeof value.registryBefore !== 'string')
    ) {
      throw new Error('格式无效')
    }
    return {
      version: 1,
      sourceDigest: value.sourceDigest,
      docIds: [...value.docIds],
      tableNamesBefore: [...value.tableNamesBefore],
      registryBefore: value.registryBefore,
    }
  } catch {
    throw new Error(legacyMigrationError('检测到损坏的迁移恢复记录，未修改任何知识库数据'))
  }
}

function writeLegacyMigrationJournal(projectPath: string, journal: LegacyMigrationJournal): void {
  const filePath = legacyMigrationJournalPath(projectPath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true })
  }
}

function removeLegacyMigrationJournal(projectPath: string): void {
  fs.rmSync(legacyMigrationJournalPath(projectPath), { force: true })
}

function createLegacyMigrationPlan(raw: string): LegacyMigrationPlan | { error: string } {
  let source: { documents?: unknown; entries?: unknown }
  try {
    source = JSON.parse(raw) as { documents?: unknown; entries?: unknown }
  } catch {
    return { error: legacyMigrationError('vectors.json 不是有效 JSON') }
  }
  if (source.entries !== undefined && !Array.isArray(source.entries)) {
    return { error: legacyMigrationError('vectors.json 的 entries 格式无效') }
  }
  if (source.documents !== undefined && !Array.isArray(source.documents)) {
    return { error: legacyMigrationError('vectors.json 的 documents 格式无效') }
  }

  const documentInfo = new Map<string, LegacyVectorJsonDocument>()
  for (const value of (source.documents ?? []) as LegacyVectorJsonDocument[]) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) {
      return { error: legacyMigrationError('vectors.json 含有无效文档标识') }
    }
    if (documentInfo.has(value.id)) {
      return { error: legacyMigrationError(`vectors.json 含有重复文档标识：${value.id}`) }
    }
    documentInfo.set(value.id, value)
  }

  const byDocument = new Map<string, LegacyVectorJsonEntry[]>()
  for (const value of (source.entries ?? []) as LegacyVectorJsonEntry[]) {
    if (!value || typeof value !== 'object' || typeof value.docId !== 'string' || !value.docId) {
      return { error: legacyMigrationError('vectors.json 含有无效块的文档标识') }
    }
    if (typeof value.text !== 'string') {
      return { error: legacyMigrationError(`文档 ${value.docId} 含有无效文本块`) }
    }
    const entries = byDocument.get(value.docId) ?? []
    entries.push(value)
    byDocument.set(value.docId, entries)
  }

  const documents: LegacyMigrationDocument[] = []
  let vectorDimension: number | undefined
  let includesVectors = false
  let includesVectorlessDocuments = false
  const fileNames = new Set<string>()
  for (const [docId, entries] of byDocument) {
    const info = documentInfo.get(docId)
    const metaFileName = entries[0]?.meta && typeof entries[0].meta.fileName === 'string'
      ? entries[0].meta.fileName
      : undefined
    const fileName = typeof info?.fileName === 'string' && info.fileName
      ? info.fileName
      : metaFileName || 'unknown'
    if (fileNames.has(fileName)) {
      return { error: legacyMigrationError(`vectors.json 含有重复文件名：${fileName}`) }
    }
    fileNames.add(fileName)

    const chunks = entries.map(entry => entry.text as string)
    if (!validateChunks(chunks)) {
      return { error: legacyMigrationError(`文档 ${docId} 没有可迁移文本块`) }
    }
    const rawVectors = entries.map(entry => entry.vector)
    const allMissing = rawVectors.every(vector => vector === undefined)
    if (allMissing) {
      includesVectorlessDocuments = true
      documents.push({
        docId,
        fileName,
        filePath: typeof info?.filePath === 'string' ? info.filePath : undefined,
        chunks,
      })
      continue
    }

    includesVectors = true
    const validation = validateVectorsForChunks(chunks, rawVectors)
    if (validation.error || !validation.vectors || validation.dimension === undefined) {
      return { error: legacyMigrationError(`文档 ${docId} 的向量无效：${validation.error ?? '无法建立嵌入空间'}`) }
    }
    if (vectorDimension !== undefined && vectorDimension !== validation.dimension) {
      return { error: legacyMigrationError(`旧数据混用了 ${vectorDimension} 与 ${validation.dimension} 维向量`) }
    }
    vectorDimension = validation.dimension
    documents.push({
      docId,
      fileName,
      filePath: typeof info?.filePath === 'string' ? info.filePath : undefined,
      chunks,
      vectors: validation.vectors,
    })
  }

  if (includesVectors && includesVectorlessDocuments) {
    return { error: legacyMigrationError('旧数据混合了有向量和无向量文档，无法安全建立单一嵌入空间') }
  }
  return {
    documents,
    migratedChunks: documents.reduce((count, document) => count + document.chunks.length, 0),
    vectorDimension,
  }
}

interface LegacyMigrationPreflight {
  tableNamesBefore: string[]
  registryBefore?: string
}

async function preflightLegacyMigrationTarget(
  projectPath: string,
  plan: LegacyMigrationPlan,
): Promise<LegacyMigrationPreflight | { error: string }> {
  if (plan.documents.length === 0) return { tableNamesBefore: [] }
  const db = await getConnection(projectPath)
  const tableNames = await db.tableNames()
  const registryFile = registryPath(projectPath)
  const registryBefore = fs.existsSync(registryFile) ? fs.readFileSync(registryFile, 'utf8') : undefined
  const preflight = { tableNamesBefore: [...tableNames], registryBefore }
  const sourceDocIds = new Set(plan.documents.map(document => document.docId))
  const sourceFileNames = new Set(plan.documents.map(document => document.fileName))
  if (tableNames.includes(TABLE_NAME)) {
    const existingRows = await (await db.openTable(TABLE_NAME)).query().select(['docId']).toArray()
    if (existingRows.some(row => sourceDocIds.has(String((row as { docId?: unknown }).docId ?? '')))) {
      return { error: legacyMigrationError('发现与旧数据相同的已迁移块，未写入重复数据') }
    }
  }
  if (tableNames.includes(DOCS_TABLE_NAME)) {
    const existingDocuments = await (await db.openTable(DOCS_TABLE_NAME)).query().select(['id', 'fileName']).toArray()
    if (existingDocuments.some(row => sourceDocIds.has(String((row as { id?: unknown }).id ?? '')))) {
      return { error: legacyMigrationError('发现与旧数据相同的已迁移文档，未写入重复数据') }
    }
    if (existingDocuments.some(row => sourceFileNames.has(String((row as { fileName?: unknown }).fileName ?? '')))) {
      return { error: legacyMigrationError('现有知识库已使用同名文档，未修改任何数据') }
    }
  }
  if (plan.vectorDimension === undefined) return preflight

  // Migration preflight must not create an embedding registry. If validation
  // rejects this legacy source, the project needs to remain byte-for-byte as
  // it was before the attempt.
  const registry = readRegistry(projectPath) ?? await inferLegacyRegistry(db, tableNames)
  const identity = normalizedIdentity({ modelFingerprint: 'legacy-json', distanceMetric: DEFAULT_DISTANCE_METRIC }, plan.vectorDimension)
  const existingSpace = matchingSpace(registry, identity, plan.vectorDimension)
  const canonicalHasRows = tableNames.includes(TABLE_NAME)
    && await (await db.openTable(TABLE_NAME)).countRows() > 0
  if (!existingSpace && (registry.spaces.length > 0 || canonicalHasRows)) {
    const active = activeSpace(registry)
    const current = active
      ? `${active.modelFingerprint} / ${active.vectorDimension} 维`
      : '当前全文知识库'
    return { error: legacyMigrationError(`reindex_required: 嵌入空间与${current}不兼容，旧代际未被修改`) }
  }
  return preflight
}

function restoreLegacyRegistrySnapshot(projectPath: string, registryBefore: string | undefined): void {
  const filePath = registryPath(projectPath)
  if (registryBefore === undefined) {
    fs.rmSync(filePath, { force: true })
    return
  }
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, registryBefore, 'utf8')
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true })
  }
}

async function rollbackLegacyMigrationDocuments(projectPath: string, journal: LegacyMigrationJournal): Promise<boolean> {
  try {
    for (const docId of journal.docIds) {
      if (!await removeDocument(projectPath, docId)) return false
    }
    const db = await getConnection(projectPath)
    const tableNamesBefore = new Set(journal.tableNamesBefore)
    for (const tableName of await db.tableNames()) {
      const isKnowledgeTable = tableName === TABLE_NAME
        || tableName === DOCS_TABLE_NAME
        || tableName.startsWith(EMBEDDING_TABLE_PREFIX)
      if (isKnowledgeTable && !tableNamesBefore.has(tableName)) {
        await db.dropTable(tableName)
      }
    }
    restoreLegacyRegistrySnapshot(projectPath, journal.registryBefore)
    return true
  } catch (error) {
    console.warn('[Vela VectorStore] 回滚旧 vectors.json 迁移失败:', error)
    return false
  }
}

async function migrateFromJSONOnce(projectPath: string): Promise<{ success: boolean; migrated: number; error?: string }> {
  const jsonPath = path.join(projectPath, '.vela', 'vectors.json')
  const journalPath = legacyMigrationJournalPath(projectPath)
  if (!fs.existsSync(jsonPath)) {
    if (fs.existsSync(journalPath)) {
      const migratedPath = `${jsonPath}.migrated`
      try {
        const journal = readLegacyMigrationJournal(projectPath)
        if (
          journal
          && fs.existsSync(migratedPath)
          && legacySourceDigest(fs.readFileSync(migratedPath, 'utf8')) === journal.sourceDigest
        ) {
          // The source was renamed only after every document write completed.
          // A matching renamed file therefore proves commit; deleting this
          // leftover journal makes the operation idempotent after a crash.
          removeLegacyMigrationJournal(projectPath)
          return { success: true, migrated: 0 }
        }
      } catch (error) {
        return {
          success: false,
          migrated: 0,
          error: error instanceof Error ? error.message : legacyMigrationError(String(error)),
        }
      }
      return {
        success: false,
        migrated: 0,
        error: legacyMigrationError('检测到未完成迁移记录但原 vectors.json 不存在，未自动删除任何数据'),
      }
    }
    return { success: true, migrated: 0 }
  }

  try {
    const raw = fs.readFileSync(jsonPath, 'utf8')
    const plan = createLegacyMigrationPlan(raw)
    if ('error' in plan) return { success: false, migrated: 0, error: plan.error }

    const journal = readLegacyMigrationJournal(projectPath)
    if (journal) {
      const sourceDocIds = new Set(plan.documents.map(document => document.docId))
      if (journal.docIds.some(docId => !sourceDocIds.has(docId))) {
        return {
          success: false,
          migrated: 0,
          error: legacyMigrationError('检测到与当前源数据不匹配的中断迁移记录，未自动删除任何数据'),
        }
      }
      if (!await rollbackLegacyMigrationDocuments(projectPath, journal)) {
        return {
          success: false,
          migrated: 0,
          error: legacyMigrationError('无法清理上次中断迁移的临时数据，未写入新数据'),
        }
      }
      removeLegacyMigrationJournal(projectPath)
    }

    const preflight = await preflightLegacyMigrationTarget(projectPath, plan)
    if ('error' in preflight) return { success: false, migrated: 0, error: preflight.error }

    if (plan.documents.length === 0) {
      fs.renameSync(jsonPath, `${jsonPath}.migrated`)
      return { success: true, migrated: 0 }
    }

    const sourceDigest = legacySourceDigest(raw)
    const docIds = plan.documents.map(document => document.docId)
    const journalForAttempt: LegacyMigrationJournal = {
      version: 1,
      sourceDigest,
      docIds,
      tableNamesBefore: preflight.tableNamesBefore,
      registryBefore: preflight.registryBefore,
    }
    writeLegacyMigrationJournal(projectPath, journalForAttempt)
    for (const document of plan.documents) {
      const result = await addChunks(
        projectPath,
        document.docId,
        document.fileName,
        document.chunks,
        document.vectors,
        document.filePath,
        undefined,
        { modelFingerprint: 'legacy-json', distanceMetric: DEFAULT_DISTANCE_METRIC },
      )
      if (!result.success) {
        const rolledBack = await rollbackLegacyMigrationDocuments(projectPath, journalForAttempt)
        if (rolledBack) removeLegacyMigrationJournal(projectPath)
        return {
          success: false,
          migrated: 0,
          error: legacyMigrationError(result.error ?? '写入 LanceDB 失败'),
        }
      }
    }

    try {
      fs.renameSync(jsonPath, `${jsonPath}.migrated`)
    } catch (error) {
      const rolledBack = await rollbackLegacyMigrationDocuments(projectPath, journalForAttempt)
      if (rolledBack) removeLegacyMigrationJournal(projectPath)
      return {
        success: false,
        migrated: 0,
        error: legacyMigrationError(`未能标记原 vectors.json：${String(error)}`),
      }
    }
    removeLegacyMigrationJournal(projectPath)
    console.log(`[Vela VectorStore] 迁移完成：${plan.migratedChunks} 个块已写入 LanceDB`)
    return { success: true, migrated: plan.migratedChunks }
  } catch (error) {
    console.error('[Vela VectorStore] 迁移失败:', error)
    return { success: false, migrated: 0, error: legacyMigrationError(String(error)) }
  }
}

/**
 * 从旧 vectors.json 迁移数据到 LanceDB。
 * 在任意写入前验证完整源文件，并以持久 journal 回滚中断批次，避免重试重复写入。
 */
export async function migrateFromJSON(projectPath: string): Promise<{ success: boolean; migrated: number; error?: string }> {
  const key = path.resolve(projectPath)
  const running = legacyMigrationInFlight.get(key)
  if (running) return running
  const migration = migrateFromJSONOnce(projectPath)
  legacyMigrationInFlight.set(key, migration)
  try {
    return await migration
  } finally {
    if (legacyMigrationInFlight.get(key) === migration) legacyMigrationInFlight.delete(key)
  }
}
