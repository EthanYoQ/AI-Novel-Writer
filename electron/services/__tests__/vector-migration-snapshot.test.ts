import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as lance from '@lancedb/lancedb'
import { Field, Schema, Utf8, Int32, Float32, FixedSizeList } from 'apache-arrow'
import { exportVectorStoreForMigration, importVectorStoreForMigration, verifyVectorStoreForMigration } from '../vector-migration-snapshot'
import { closeConnection, closeVectorStoreForMigration, getConnection, search } from '../../vector-store'

let root: string
const projectPaths: string[] = []
const pendingCases: Promise<void>[] = []
let diagnosticCase = 0
type NativeStage = 'beforeEach-enter' | 'root-ready' | 'case-enter' | 'connect-enter' | 'connect-ready'
  | 'chunks-enter' | 'chunks-ready' | 'documents-enter' | 'documents-ready' | 'vectors-enter' | 'vectors-ready'
  | 'seed-close-enter' | 'seed-close-done' | 'copy-enter' | 'copy-done' | 'export-enter' | 'export-done'
  | 'import-enter' | 'import-done' | 'verify-enter' | 'verify-done' | 'sqlite-enter' | 'sqlite-done'
  | 'search-enter' | 'search-done' | 'rename-enter' | 'rename-done'
  | 'teardown-enter' | 'teardown-settled' | 'teardown-closed' | 'teardown-removed'
function nativeStage(stage: NativeStage): void {
  if (process.env.CI !== 'true') return
  try {
    fs.writeSync(2, '[vector-native-stage] ' + JSON.stringify({ stage, caseIndex: diagnosticCase,
      pid: process.pid, monotonicNs: process.hrtime.bigint().toString() }) + '\n')
  } catch { /* Diagnostic sink failures must not change the test. */ }
}

// Vitest can time out a case without cancelling its native operations. Keep the
// full case alive until teardown so its handles never race directory removal or
// the next case's root. The original test timeout still fails the test.
function nativeCase<T>(operation: (value: T) => Promise<void>): (value: T) => Promise<void> {
  return value => {
    nativeStage('case-enter')
    const pending = operation(value)
    pendingCases.push(pending)
    return pending
  }
}
beforeEach(() => {
  diagnosticCase += 1
  nativeStage('beforeEach-enter')
  if (pendingCases.length) throw new Error('PREVIOUS_NATIVE_CASE_NOT_SETTLED')
  fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true })
  root = fs.mkdtempSync(path.resolve('.runtime/.cache/vector-migration-'))
  nativeStage('root-ready')
})
afterEach(async () => {
  nativeStage('teardown-enter')
  await Promise.allSettled(pendingCases)
  nativeStage('teardown-settled')
  pendingCases.length = 0
  for (const project of projectPaths.splice(0)) closeConnection(project)
  nativeStage('teardown-closed')
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
  nativeStage('teardown-removed')
}, 10_000)
function fingerprint(directory: string): string {
  const parts: string[] = []
  const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else parts.push(path.relative(directory, file), fs.readFileSync(file).toString('base64'))
  } }
  walk(directory); return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}
async function seed(storage: string, vectors = true) {
  fs.mkdirSync(storage, { recursive: true })
  nativeStage('connect-enter')
  const connection = await lance.connect(path.join(storage, 'lancedb'))
  nativeStage('connect-ready')
  const fields = [new Field('id', new Utf8()), new Field('docId', new Utf8()), new Field('fileName', new Utf8()), new Field('text', new Utf8()), new Field('chunkIndex', new Int32()), new Field('totalChunks', new Int32()), new Field('importedAt', new Utf8()), new Field('corpusKind', new Utf8())]
  const chunks = [{ id: '块甲', docId: '文档甲', fileName: '已删除原稿.pdf', text: '雨夜来信：铜钥匙藏在旧钟后面。', chunkIndex: 0, totalChunks: 1, importedAt: '2026-09-13', corpusKind: 'reference' }]
  const tables: lance.Table[] = []
  try {
    nativeStage('chunks-enter')
    tables.push(await connection.createTable('chunks', chunks, { schema: new Schema(fields) }))
    nativeStage('chunks-ready')
    nativeStage('documents-enter')
    tables.push(await connection.createTable('documents', [{ id: '文档甲', fileName: '已删除原稿.pdf', filePath: path.join(root, '已删除原稿.pdf'), importedAt: '2026-09-13', chunkCount: 1, corpusKind: 'reference' }]))
    nativeStage('documents-ready')
    if (vectors) {
      nativeStage('vectors-enter')
      for (const generation of [1, 2]) tables.push(await connection.createTable(`chunks__space_${generation}`, chunks.map(row => ({ ...row, vector: Array.from({ length: generation + 1 }, (_, i) => i / 4) })), { schema: new Schema([...fields, new Field('vector', new FixedSizeList(generation + 1, new Field('item', new Float32())))]) }))
      nativeStage('vectors-ready')
      fs.writeFileSync(path.join(storage, 'embedding-spaces.json'), JSON.stringify({ version: 1, activeGeneration: 2, spaces: [1, 2].map(generation => ({ generation, tableName: `chunks__space_${generation}`, modelFingerprint: `合成模型${generation}`, vectorDimension: generation + 1, distanceMetric: 'l2', status: generation === 2 ? 'active' : 'inactive', createdAt: '2026-09-13' })) }))
    }
  } finally { nativeStage('seed-close-enter'); for (const table of tables) table.close(); connection.close(); nativeStage('seed-close-done') }
}
async function copied(vectors = true) {
  const source = path.join(root, '原项目', '.vela'), copy = path.join(root, '只读副本')
  await seed(source, vectors)
  nativeStage('copy-enter')
  fs.cpSync(source, copy, { recursive: true })
  nativeStage('copy-done')
  return { source, copy }
}
it.each([false, true])('保全已删除源PDF的全文和全部向量代际：vectors=%s', nativeCase(async vectors => {
  const { source, copy } = await copied(vectors)
  const before = fingerprint(source)
  const connect = vi.spyOn(lance, 'connect')
  nativeStage('export-enter')
  const snapshot = await exportVectorStoreForMigration({ storageRoot: copy, originalSourceRoot: source })
  nativeStage('export-done')
  expect(connect.mock.calls.every(args => String(args[0]) !== path.join(source, 'lancedb'))).toBe(true)
  expect(snapshot.summary).toMatchObject({ documents: 1, chunks: 1, tableCount: vectors ? 4 : 2 })
  expect(fingerprint(source)).toBe(before)
  const project = path.join(root, '新项目'); const target = path.join(project, '.ai-novel'); fs.mkdirSync(target, { recursive: true })
  projectPaths.push(project)
  nativeStage('import-enter')
  expect(await importVectorStoreForMigration({ targetStorageRoot: target, snapshot })).toEqual(snapshot.summary)
  nativeStage('import-done')
  nativeStage('verify-enter')
  expect(await verifyVectorStoreForMigration({ storageRoot: target, snapshot })).toEqual(snapshot.summary)
  nativeStage('verify-done')
  expect(fs.existsSync(path.join(root, '已删除原稿.pdf'))).toBe(false)
  nativeStage('sqlite-enter')
  prepareCanonicalStorageFixture(project)
  nativeStage('sqlite-done')
  nativeStage('search-enter')
  expect(await search(project, '铜钥匙')).toEqual([expect.objectContaining({ text: '雨夜来信：铜钥匙藏在旧钟后面。', fileName: '已删除原稿.pdf' })])
  nativeStage('search-done')
  expect(fingerprint(source)).toBe(before)
  // Exact roots can be renamed after all migration-owned table/connection handles close.
  nativeStage('rename-enter')
  fs.renameSync(copy, copy + '-closed')
  nativeStage('rename-done')
}))
it('禁止把原根当副本，未知半迁移保全并拒绝', nativeCase(async () => {
  const { source, copy } = await copied(false)
  await expect(exportVectorStoreForMigration({ storageRoot: source, originalSourceRoot: source })).rejects.toThrow('COPY_REQUIRED')
  fs.writeFileSync(path.join(source, 'vectors.json.migration-journal.json'), '{未完成')
  fs.writeFileSync(path.join(copy, 'vectors.json.migration-journal.json'), '{未完成')
  const before = fingerprint(source)
  await expect(exportVectorStoreForMigration({ storageRoot: copy, originalSourceRoot: source })).rejects.toThrow('LEGACY_PENDING')
  expect(fingerprint(source)).toBe(before)
}))
it('空向量资产不创建目录，不连接LanceDB', nativeCase(async () => {
  const source = path.join(root, '原根'), copy = path.join(root, '副本'); fs.mkdirSync(source); fs.mkdirSync(copy)
  const connect = vi.spyOn(lance, 'connect')
  expect((await exportVectorStoreForMigration({ storageRoot: copy, originalSourceRoot: source })).summary.tableCount).toBe(0)
  expect(connect).not.toHaveBeenCalled(); expect(fs.readdirSync(source)).toEqual([]); expect(fs.readdirSync(copy)).toEqual([])
}))
it('拒绝损坏registry、快照篡改以及已有目标，原数据不改', nativeCase(async () => {
  const { source, copy } = await copied()
  nativeStage('export-enter')
  const snapshot = await exportVectorStoreForMigration({ storageRoot: copy, originalSourceRoot: source })
  nativeStage('export-done')
  const target = path.join(root, '目标'); fs.mkdirSync(target)
  await expect(importVectorStoreForMigration({ targetStorageRoot: target, snapshot: { ...snapshot, summary: { ...snapshot.summary, logicalHash: '伪造' } } })).rejects.toThrow('SNAPSHOT_INVALID')
  fs.mkdirSync(path.join(target, 'lancedb'))
  await expect(importVectorStoreForMigration({ targetStorageRoot: target, snapshot })).rejects.toThrow('TARGET_NOT_EMPTY')
  const registry = JSON.parse(Buffer.from(snapshot.registryBytes!).toString())
  registry.activeGeneration = 9
  const bad = Buffer.from(JSON.stringify(registry)); fs.writeFileSync(path.join(source, 'embedding-spaces.json'), bad); fs.writeFileSync(path.join(copy, 'embedding-spaces.json'), bad)
  await expect(exportVectorStoreForMigration({ storageRoot: copy, originalSourceRoot: source })).rejects.toThrow('ACTIVE_POINTER_INVALID')
}))
it('quiesce对曾暴露的连接拒绝证明，未开户fence阻止新连接', nativeCase(async () => {
  const project = path.join(root, '从未开户'); fs.mkdirSync(project)
  const fence = closeVectorStoreForMigration(project)
  await expect(getConnection(project)).rejects.toThrow('FENCED')
  expect(fs.readdirSync(project)).toEqual([])
  fence.release()
  nativeStage('sqlite-enter')
  prepareCanonicalStorageFixture(project)
  nativeStage('sqlite-done')
  projectPaths.push(project); await getConnection(project); closeConnection(project)
  expect(() => closeVectorStoreForMigration(project)).toThrow('HANDLES_UNPROVEN')
}))

it('副本与原根不一致或原根读期变动均拒绝，不返回可安装快照', nativeCase(async () => {
  const { source, copy } = await copied(false)
  fs.writeFileSync(path.join(copy, 'embedding-spaces.json'), '{}')
  await expect(exportVectorStoreForMigration({ storageRoot: copy, originalSourceRoot: source })).rejects.toThrow('COPY_MISMATCH')
  fs.unlinkSync(path.join(copy, 'embedding-spaces.json'))
  const realConnect = lance.connect
  vi.spyOn(lance, 'connect').mockImplementationOnce(async (...args) => {
    fs.writeFileSync(path.join(source, 'embedding-spaces.json'), '{}')
    return Reflect.apply(realConnect, lance, args)
  })
  await expect(exportVectorStoreForMigration({ storageRoot: copy, originalSourceRoot: source })).rejects.toThrow('SOURCE_CHANGED')
}))
it('未知表不被静默抛弃，失败后副本句柄仍释放', nativeCase(async () => {
  const { source, copy } = await copied(false)
  const connection = await lance.connect(path.join(source, 'lancedb'))
  const table = await connection.createTable('unknown_records', [{ id: '必须保全', text: '作者资料' }]); table.close(); connection.close()
  fs.cpSync(source, copy, { recursive: true, force: true })
  const before = fingerprint(source)
  await expect(exportVectorStoreForMigration({ storageRoot: copy, originalSourceRoot: source })).rejects.toThrow('UNKNOWN_TABLE')
  expect(fingerprint(source)).toBe(before)
  fs.renameSync(copy, copy + '-failed-closed')
}))

it.each(['nullable', 'metadata'] as const)('嵌套向量字段%s篡改不能沿用原快照哈希', nativeCase(async mutation => {
  const { source, copy } = await copied()
  const before = fingerprint(source)
  nativeStage('export-enter')
  const snapshot = await exportVectorStoreForMigration({ storageRoot: copy, originalSourceRoot: source })
  nativeStage('export-done')
  const arrow = createRequire(import.meta.url)('apache-arrow') as typeof import('apache-arrow')
  const item = snapshot.tables.find(table => table.name === 'chunks__space_1')!
  const table = arrow.tableFromIPC(item.arrowIpc)
  const child = table.schema.fields.find(field => field.name === 'vector')!.type.children[0]
  if (mutation === 'nullable') child.nullable = !child.nullable
  else child.metadata.set('合成隐藏字段', '必须拒绝')
  item.arrowIpc = arrow.tableToIPC(table)
  const target = path.join(root, '篡改目标'); fs.mkdirSync(target)
  await expect(importVectorStoreForMigration({ targetStorageRoot: target, snapshot })).rejects.toThrow(mutation === 'nullable' ? 'HASH_MISMATCH' : 'SCHEMA_METADATA_UNSUPPORTED')
  expect(fs.readdirSync(target)).toEqual([])
  expect(fingerprint(source)).toBe(before)
}))