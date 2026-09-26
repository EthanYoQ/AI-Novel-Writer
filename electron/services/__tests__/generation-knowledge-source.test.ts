import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as lance from '@lancedb/lancedb'
import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from 'apache-arrow'
import { captureGenerationKnowledge, verifyGenerationKnowledge } from '../generation-knowledge-source'
let root: string
beforeEach(() => {
  const parent = path.resolve('.runtime/.cache/novel-quality-modernization/generation-knowledge-tests')
  fs.mkdirSync(parent, { recursive: true }); root = fs.mkdtempSync(path.join(parent, 'case-'))
})
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true }) })
const record = (id = 'chunk', docId = 'doc') => ({ id, docId, fileName: '同名资料.md', text: '原始中文资料\n保留空白。 ', chunkIndex: 0, totalChunks: 1, importedAt: '2026-09-13', corpusKind: 'project-knowledge' })
async function seed(options: { duplicate?: boolean; vector?: boolean } = {}) {
  const db = await lance.connect(path.join(root, 'lancedb'))
  const rows = [record(), ...(options.duplicate ? [record('other-chunk', 'other-doc')] : [])]
  const tables: lance.Table[] = []
  try {
    tables.push(await db.createTable('chunks', rows))
    tables.push(await db.createTable('documents', rows.map(row => ({ id: row.docId, fileName: row.fileName, chunkCount: 1, corpusKind: row.corpusKind, filePath: 'private-original-path-not-in-snapshot' }))))
    if (options.vector) {
      const fields: Field[] = Object.keys(rows[0]).map(key => new Field(key, typeof rows[0][key as keyof typeof rows[0]] === 'number' ? new Int32() : new Utf8()))
      fields.push(new Field('vector', new FixedSizeList(2, new Field('item', new Float32()))))
      tables.push(await db.createTable('chunks__space_1', rows.map(row => ({ ...row, vector: [1, 0] })), { schema: new Schema(fields) }))
      fs.writeFileSync(path.join(root, 'embedding-spaces.json'), JSON.stringify({ version: 1, activeGeneration: 1, spaces: [{ generation: 1, tableName: 'chunks__space_1', modelFingerprint: 'synthetic', vectorDimension: 2, distanceMetric: 'l2', status: 'active', createdAt: '2026-09-13' }] }))
    }
  } finally { for (const table of tables) table.close(); db.close() }
}
async function mutate(tableName: string, operation: (table: lance.Table) => Promise<unknown>) {
  const db = await lance.connect(path.join(root, 'lancedb')); const table = await db.openTable(tableName)
  try { await operation(table) } finally { table.close(); db.close() }
}
function physicalHash() {
  const values: string[] = []
  const walk = (directory: string) => { for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name)
    if (fs.lstatSync(file).isDirectory()) walk(file)
    else values.push(path.relative(root, file), fs.readFileSync(file).toString('base64'))
  } }; walk(root); return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}
it('reads exact canonical identities without collapsing equal names/text and performs no writes or embedding', async () => {
  await seed({ duplicate: true }); const before = physicalHash()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_FORBIDDEN') }))
  const snapshot = await captureGenerationKnowledge({ projectStorageRoot: root, query: '中文', topK: 5 })
  expect(snapshot.items.map(item => item.chunkId)).toEqual(['chunk', 'other-chunk'])
  expect(snapshot.items[0].text).toBe(record().text)
  expect(snapshot.items[0].contentHash).toBe(createHash('sha256').update(record().text).digest('hex'))
  expect(snapshot.query).toBe('中文'); expect(snapshot.topK).toBe(5)
  expect(JSON.stringify(snapshot)).not.toContain('private-original-path')
  await verifyGenerationKnowledge({ projectStorageRoot: root, snapshot })
  expect(physicalHash()).toBe(before); expect(fetch).not.toHaveBeenCalled()
})
it('does not create an absent store and rejects empty to populated transition', async () => {
  const snapshot = await captureGenerationKnowledge({ projectStorageRoot: root, query: '中文' })
  expect(snapshot.storageState).toBe('absent'); expect(fs.readdirSync(root)).toEqual([])
  await seed()
  await expect(verifyGenerationKnowledge({ projectStorageRoot: root, snapshot })).rejects.toThrow('SOURCE_STALE')
})
it.each(['chunk', 'document'] as const)('rejects %s corruption as an explicit failure, not empty retrieval', async kind => {
  await seed()
  await mutate(kind === 'chunk' ? 'chunks' : 'documents', async table => {
    await table.update({ where: "id = '" + (kind === 'chunk' ? 'chunk' : 'doc') + "'", values: kind === 'chunk' ? { totalChunks: 7 } : { chunkCount: 7 } })
  })
  await expect(captureGenerationKnowledge({ projectStorageRoot: root, query: '中文' })).rejects.toThrow('DOCUMENT_INCOMPLETE')
})
it('rejects same-name replacement and any canonical revision change without re-searching', async () => {
  await seed(); const snapshot = await captureGenerationKnowledge({ projectStorageRoot: root, query: '中文' })
  await mutate('chunks', async table => { await table.delete("id = 'chunk'"); await table.add([{ ...record('replacement', 'doc'), text: '替换资料' }]) })
  await expect(verifyGenerationKnowledge({ projectStorageRoot: root, snapshot })).rejects.toThrow('SOURCE_STALE')
})
it('rejects altered text, identity and hash in a supplied snapshot at an unchanged table version', async () => {
  await seed(); const snapshot = await captureGenerationKnowledge({ projectStorageRoot: root, query: '中文' })
  for (const patch of [{ text: '改变' }, { documentId: 'other' }, { contentHash: 'f'.repeat(64) }]) {
    const copy = structuredClone(snapshot); Object.assign(copy.items[0], patch)
    await expect(verifyGenerationKnowledge({ projectStorageRoot: root, snapshot: copy })).rejects.toThrow('SOURCE_STALE')
  }
})
it('resolves vector hits to canonical identity and rejects stale vector text', async () => {
  await seed({ vector: true })
  const input = { projectStorageRoot: root, query: '中文', queryVector: [1, 0], embeddingSpace: { modelFingerprint: 'synthetic', distanceMetric: 'l2' } }
  expect((await captureGenerationKnowledge(input)).items[0].chunkId).toBe('chunk')
  await mutate('chunks__space_1', table => table.update({ where: "id = 'chunk'", values: { text: '过时向量镜像' } }))
  await expect(captureGenerationKnowledge(input)).rejects.toThrow('VECTOR_CANONICAL_MISMATCH')
})
it('rejects legacy pending inputs and does not lazily migrate them', async () => {
  fs.writeFileSync(path.join(root, 'vectors.json'), '[]'); const before = physicalHash()
  await expect(captureGenerationKnowledge({ projectStorageRoot: root, query: '中文' })).rejects.toThrow('LEGACY_PENDING')
  expect(physicalHash()).toBe(before)
})

it('rejects a table revision change even when the selected author text is unchanged', async () => {
  await seed(); const snapshot = await captureGenerationKnowledge({ projectStorageRoot: root, query: '中文' })
  await mutate('chunks', table => table.update({ where: "id = 'chunk'", values: { importedAt: 'changed' } }))
  await expect(verifyGenerationKnowledge({ projectStorageRoot: root, snapshot })).rejects.toThrow('SOURCE_STALE')
})
it('detects an actual concurrent mutation after pinning a table snapshot', async () => {
  await seed()
  const db = await lance.connect(path.join(root, 'lancedb')), table = await db.openTable('chunks')
  const prototype = Object.getPrototypeOf(table) as lance.Table
  const original = prototype.checkout
  let changed = false
  const spy = vi.spyOn(prototype, 'checkout').mockImplementation(async function (this: lance.Table, version) {
    await original.call(this, version)
    if (!changed) { changed = true; await mutate('chunks', target => target.update({ where: "id = 'chunk'", values: { text: '并发修改的资料' } })) }
  })
  try {
    await expect(captureGenerationKnowledge({ projectStorageRoot: root, query: '中文' })).rejects.toThrow('CHANGED_DURING_READ')
  } finally { spy.mockRestore(); table.close(); db.close() }
})
it('refuses an unproven embedding space without registering it or changing source files', async () => {
  await seed(); const before = physicalHash()
  await expect(captureGenerationKnowledge({ projectStorageRoot: root, query: '中文', queryVector: [1, 0], embeddingSpace: { modelFingerprint: 'unregistered' } })).rejects.toThrow('SPACE_NOT_MATCHED')
  expect(physicalHash()).toBe(before)
})
it('excludes reference corpus while keeping an identified legacy unknown source unconfirmed', async () => {
  await seed({ duplicate: true })
  await mutate('chunks', table => table.update({ where: "id = 'chunk'", values: { corpusKind: 'reference' } }))
  await mutate('documents', table => table.update({ where: "id = 'doc'", values: { corpusKind: 'reference' } }))
  await mutate('chunks', table => table.update({ where: "id = 'other-chunk'", values: { corpusKind: 'unknown' } }))
  await mutate('documents', table => table.update({ where: "id = 'other-doc'", values: { corpusKind: 'unknown' } }))
  const snapshot = await captureGenerationKnowledge({ projectStorageRoot: root, query: '中文' })
  expect(snapshot.items.map(item => [item.chunkId, item.corpusKind])).toEqual([['other-chunk', 'unknown']])
})

it('serializes an actual vector mutation behind the shared source-verification gate and allows nested connection acquisition', async () => {
  const { prepareCanonicalStorageFixture } = await import('../../../test/helpers/canonical-project-fixture')
  const { withKnowledgeSourceGate } = await import('../knowledge-source-gate')
  const { addChunks, closeConnection, closeVectorStoreForMigration } = await import('../../vector-store')
  const { closeProjectDatabase } = await import('../../database')
  const project = path.join(root, 'project'), storage = path.join(project, '.ai-novel')
  prepareCanonicalStorageFixture(project)
  let release!: () => void, entered!: () => void
  const opened = new Promise<void>(resolve => { entered = resolve })
  const blocker = new Promise<void>(resolve => { release = resolve })
  const held = withKnowledgeSourceGate(storage, async () => { entered(); await blocker })
  await opened
  const writing = addChunks(project, 'doc', '中文资料.md', ['完整中文资料'], undefined, undefined, { corpusKind: 'project-knowledge' })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(fs.existsSync(path.join(storage, 'lancedb'))).toBe(false)
    expect(() => closeConnection(project)).toThrow('GENERATION_KNOWLEDGE_BUSY')
    expect(() => closeVectorStoreForMigration(project)).toThrow('GENERATION_KNOWLEDGE_BUSY')
    release(); await held
    expect(await writing).toMatchObject({ success: true })
    expect((await captureGenerationKnowledge({ projectStorageRoot: storage, query: '中文' })).items).toHaveLength(1)
  } finally { release(); await Promise.allSettled([held, writing]); closeConnection(project); closeProjectDatabase() }
})
