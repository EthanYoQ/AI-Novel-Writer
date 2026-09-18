import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Connection, Table } from '@lancedb/lancedb'
import type { EmbeddingSpaceIdentity, KnowledgeCorpusKind } from '../vector-store'

import type { GenerationKnowledgeItem, GenerationKnowledgeSnapshot } from '../../src/shared/generation-knowledge'
export type { GenerationKnowledgeItem, GenerationKnowledgeSnapshot } from '../../src/shared/generation-knowledge'

type Row = Record<string, unknown>
const fail = (code: string): never => { throw new Error(`GENERATION_KNOWLEDGE_${code}`) }
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const quote = (text: string) => `'${text.replace(/'/g, "''")}'`
const string = (value: unknown): string => typeof value === 'string' && value.length > 0 ? value : fail('INVALID_ROW')
const integer = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail('INVALID_ROW')
const corpus = (value: unknown): KnowledgeCorpusKind => value === undefined ? 'unknown'
  : value === 'reference' || value === 'project-knowledge' || value === 'unknown' ? value : fail('INVALID_CORPUS')
function physicalDirectory(directory: string): void {
  const stat = fs.lstatSync(directory)
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(fs.realpathSync.native(directory)) !== normalize(directory)) fail('UNSAFE_ROOT')
}
function registryBytes(root: string): string | null {
  const file = path.join(root, 'embedding-spaces.json')
  if (!fs.existsSync(file)) return null
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('UNSAFE_REGISTRY')
  return fs.readFileSync(file, 'utf8')
}
interface Reader {
  state: GenerationKnowledgeSnapshot['storageState']; canonicalRevision: number | null; documentsRevision: number | null
  chunks?: Table; documents?: Table; connection?: Connection; names: string[]
  pin(table: Table): Promise<void>
}
/** Owns and closes every handle. No locator fallback, migration, createTable, index, or registry write. */
async function readStable<T>(root: string, read: (reader: Reader) => Promise<T>): Promise<T> {
  if (!path.isAbsolute(root)) fail('ABSOLUTE_ROOT_REQUIRED')
  const directory = path.join(root, 'lancedb')
  let connection: Connection | undefined
  const pinned: { table: Table; version: number }[] = []
  try {
    physicalDirectory(root)
    const registry = registryBytes(root)
    if (fs.existsSync(path.join(root, 'vectors.json')) || fs.existsSync(path.join(root, 'vectors.json.migration-journal.json'))) fail('LEGACY_PENDING')
    const reader: Reader = { state: 'absent', canonicalRevision: null, documentsRevision: null, names: [], async pin(table) {
      const entry = { table, version: 0 }; pinned.push(entry)
      entry.version = integer(await table.version())
      await table.checkout(entry.version)
    } }
    if (fs.existsSync(directory)) {
      physicalDirectory(directory)
      const lance = await import('@lancedb/lancedb')
      connection = await lance.connect(directory)
      reader.connection = connection
      reader.names = await connection.tableNames()
      const hasChunks = reader.names.includes('chunks'), hasDocuments = reader.names.includes('documents')
      if (hasChunks !== hasDocuments) fail('INCOMPLETE_TABLES')
      reader.state = hasChunks ? 'present' : 'empty'
      if (hasChunks) {
        reader.chunks = await connection.openTable('chunks'); await reader.pin(reader.chunks)
        reader.documents = await connection.openTable('documents'); await reader.pin(reader.documents)
        reader.canonicalRevision = pinned[0].version; reader.documentsRevision = pinned[1].version
      }
    }
    const result = await read(reader)
    for (const { table, version } of pinned) {
      await table.checkoutLatest()
      if (await table.version() !== version) fail('CHANGED_DURING_READ')
    }
    if (registryBytes(root) !== registry) fail('CHANGED_DURING_READ')
    if (connection) {
      if (!isDeepStrictEqual((await connection.tableNames()).sort(), [...reader.names].sort())) fail('CHANGED_DURING_READ')
    } else if (fs.existsSync(directory)) fail('CHANGED_DURING_READ')
    return result
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('GENERATION_KNOWLEDGE_')) throw error
    return fail('READ_FAILED')
  } finally {
    for (const { table } of pinned.reverse()) table.close()
    connection?.close()
  }
}
async function sourceItem(reader: Reader, row: Row, score: number): Promise<GenerationKnowledgeItem> {
  const chunkId = string(row.id), documentId = string(row.docId), text = string(row.text), fileName = string(row.fileName)
  const chunkIndex = integer(row.chunkIndex), kind = corpus(row.corpusKind)
  if (kind === 'reference' || !Number.isFinite(score)) fail('INELIGIBLE_SOURCE')
  const docs = await reader.documents!.query().where(`id = ${quote(documentId)}`).toArray()
  const chunks = await reader.chunks!.query().where(`\`docId\` = ${quote(documentId)}`).toArray()
  const ordered = chunks.sort((a, b) => integer(a.chunkIndex) - integer(b.chunkIndex))
  if (docs.length !== 1 || !ordered.length || integer(docs[0].chunkCount) !== ordered.length
    || string(docs[0].fileName) !== fileName || corpus(docs[0].corpusKind) !== kind
    || new Set(ordered.map(item => string(item.id))).size !== ordered.length
    || ordered.some((item, index) => integer(item.chunkIndex) !== index || integer(item.totalChunks) !== ordered.length
      || corpus(item.corpusKind) !== kind || string(item.fileName) !== fileName || typeof item.text !== 'string')) fail('DOCUMENT_INCOMPLETE')
  const same = ordered.filter(item => item.id === chunkId)
  if (same.length !== 1 || same[0].text !== text || integer(same[0].chunkIndex) !== chunkIndex) fail('SOURCE_MISMATCH')
  return { revision: reader.canonicalRevision!, chunkId, documentId, chunkIndex, text, fileName, score, corpusKind: kind, contentHash: hash(text),
    documentChunkCount: ordered.length, documentChunkSetHash: hash(JSON.stringify(ordered.map(item => item.text))) }
}
export async function captureGenerationKnowledge(input: {
  projectStorageRoot: string; query: string; topK?: number; queryVector?: number[]; embeddingSpace?: EmbeddingSpaceIdentity
}): Promise<GenerationKnowledgeSnapshot> {
  const topK = input.topK ?? 5
  if (typeof input.query !== 'string' || !Number.isSafeInteger(topK) || topK < 1 || topK > 100) fail('INVALID_REQUEST')
  return readStable(input.projectStorageRoot, async reader => {
    const snapshot: GenerationKnowledgeSnapshot = { version: 1, state: 'empty', storageState: reader.state, query: input.query, topK, canonicalRevision: reader.canonicalRevision, documentsRevision: reader.documentsRevision, items: [] }
    if (!reader.chunks) return snapshot
    let hits: { row: Row; score: number }[] = []
    if (input.queryVector) {
      const bytes = registryBytes(input.projectStorageRoot)
      if (!bytes) fail('SPACE_NOT_MATCHED')
      const { validateRegistry } = await import('../vector-store')
      const registry = validateRegistry(JSON.parse(bytes!))
      const active = registry.spaces.filter(space => space.generation === registry.activeGeneration && space.status === 'active')
      if (active.length === 0) fail('SPACE_NOT_MATCHED')
      if (active.length !== 1 || !reader.names.includes(active[0].tableName)) fail('SPACE_UNPROVEN')
      if (!input.queryVector.every(Number.isFinite)) fail('INVALID_VECTOR')
      if (!input.embeddingSpace || active[0].modelFingerprint !== input.embeddingSpace.modelFingerprint
        || active[0].distanceMetric !== (input.embeddingSpace.distanceMetric ?? 'l2')
        || input.queryVector.length !== active[0].vectorDimension) fail('SPACE_NOT_MATCHED')
      const table = await reader.connection!.openTable(active[0].tableName); await reader.pin(table)
      if (!['l2', 'cosine', 'dot'].includes(active[0].distanceMetric)) fail('SPACE_UNPROVEN')
      const rows = await table.vectorSearch(input.queryVector).distanceType(active[0].distanceMetric as 'l2' | 'cosine' | 'dot').where("`corpusKind` != 'reference'").limit(topK).toArray()
      for (const hit of rows) {
        const canonical = await reader.chunks.query().where(`id = ${quote(string(hit.id))}`).toArray()
        if (canonical.length !== 1 || ['docId', 'text', 'fileName', 'chunkIndex', 'totalChunks', 'corpusKind'].some(key => !isDeepStrictEqual(canonical[0][key], hit[key]))) fail('VECTOR_CANONICAL_MISMATCH')
        const distance = hit._distance
        if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0 && active[0].distanceMetric !== 'dot') fail('INVALID_DISTANCE')
        hits.push({ row: canonical[0], score: active[0].distanceMetric === 'dot' ? 1 / (1 + Math.exp(distance)) : 1 / (1 + distance) })
      }
    }
    if (!hits.length) {
      const raw = input.query.match(/[\p{L}\p{N}-]+/gu) ?? [], meaningful = raw.filter(term => Array.from(term).length >= 2)
      const terms = [...new Map((meaningful.length ? meaningful : raw).map(term => [term.toLocaleLowerCase(), term])).values()].slice(0, 8)
      const filter = terms.length ? terms.map(term => `text LIKE ${quote(`%${term}%`)}`).join(' OR ') : "text LIKE '%%'"
      const rows = await reader.chunks.query().where(`(${filter})`).toArray()
      const rank = (row: Row) => terms.reduce((sum, term, index) => sum + (string(row.text).toLocaleLowerCase().includes(term.toLocaleLowerCase()) ? terms.length - index : 0), 0)
      hits = rows.filter(row => corpus(row.corpusKind) !== 'reference').sort((a, b) => rank(b) - rank(a) || string(a.id).localeCompare(string(b.id)))
        .slice(0, topK).map(row => ({ row, score: 0.5 }))
    }
    if (new Set(hits.map(hit => hit.row.id)).size !== hits.length) fail('DUPLICATE_CHUNK')
    for (const hit of hits) snapshot.items.push(await sourceItem(reader, hit.row, hit.score))
    snapshot.state = snapshot.items.length ? 'stored' : 'empty'
    return snapshot
  })
}
/** Re-read exact IDs, never re-search or follow a replacement by name. */
export async function verifyGenerationKnowledge(input: { projectStorageRoot: string; snapshot: GenerationKnowledgeSnapshot }): Promise<void> {
  const expected = input.snapshot
  if (expected.version !== 1 || !Array.isArray(expected.items) || typeof expected.query !== 'string'
    || !Number.isSafeInteger(expected.topK) || expected.topK < 1 || expected.topK > 100
    || expected.items.length > expected.topK || expected.state !== (expected.items.length ? 'stored' : 'empty')) fail('INVALID_SNAPSHOT')
  await readStable(input.projectStorageRoot, async reader => {
    if (reader.state !== expected.storageState || reader.canonicalRevision !== expected.canonicalRevision || reader.documentsRevision !== expected.documentsRevision) fail('SOURCE_STALE')
    if (new Set(expected.items.map(item => item.chunkId)).size !== expected.items.length) fail('INVALID_SNAPSHOT')
    for (const item of expected.items) {
      if (!reader.chunks) fail('SOURCE_STALE')
      const rows = await reader.chunks!.query().where(`id = ${quote(string(item.chunkId))}`).toArray()
      if (rows.length !== 1 || !isDeepStrictEqual(await sourceItem(reader, rows[0], item.score), item)) fail('SOURCE_STALE')
    }
  })
}
