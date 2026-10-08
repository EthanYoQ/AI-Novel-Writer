import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../test/helpers/canonical-project-fixture'
import { getProjectDataRoot } from '../services/project-data-locator'
import { addChunks, closeConnection, getConnection, getDocumentIntegrity, listDocuments, readPortableKnowledgeSnapshot, removeDocument, restorePortableKnowledgeSnapshot } from '../vector-store'
import { clearKnowledgeBase, importDocument, importText, readDocumentCopy, reindexDocumentCopy, saveDocumentCopy, searchKnowledge, searchKnowledgeFTS } from '../knowledge-base'
import { captureGenerationKnowledge, verifyGenerationKnowledge } from '../services/generation-knowledge-source'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'

const { generateEmbeddings } = vi.hoisted(() => ({ generateEmbeddings: vi.fn() }))
vi.mock('../embedding', () => ({ chunkText: (text: string) => [text], generateEmbeddings }))

const roots: string[] = []
function workspace() {
  fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true })
  const root = fs.mkdtempSync(path.resolve('.runtime/.cache/knowledge-repair-'))
  roots.push(root)
  prepareCanonicalStorageFixture(root)
  return root
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    closeConnection(root)
    await removeDirectoryWithWindowsRetry(root)
  }
})

it('keeps chapter identity and scoped metadata across reindex and exact deletion, preserving a same-name reference', async () => {
  const projectPath = workspace()
  const first = await importText('chapter before', '第1章.txt', projectPath, 'openai', { baseUrl: '', apiKey: '' })
  await addChunks(projectPath, 'reference', '第1章.txt', ['reference survives'], undefined, undefined, { corpusKind: 'reference' })
  const before = await readDocumentCopy(first.docId!, projectPath)
  await saveDocumentCopy(first.docId!, 'chapter after', before.contentHash!, projectPath)
  const remove = vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('EBUSY') })
  expect(await reindexDocumentCopy(first.docId!, projectPath)).toMatchObject({ success: true, docId: first.docId })
  expect(remove).not.toHaveBeenCalled()
  remove.mockRestore()
  expect(await searchKnowledgeFTS('chapter after', projectPath, 5, [1, 1])).toEqual([expect.objectContaining({ text: 'chapter after' })])
  expect(await removeDocument(projectPath, first.docId!)).toBe(true)
  expect(await searchKnowledgeFTS('chapter', projectPath)).toEqual([])
  expect(await listDocuments(projectPath)).toEqual([expect.objectContaining({ id: 'reference' })])
})

it('restores native tables on reindex failure while a concurrent import waits for the same gate', async () => {
  const projectPath = workspace()
  generateEmbeddings.mockResolvedValue([[1, 0]])
  const first = await importText('chapter before', 'chapter.txt', projectPath, 'openai', { baseUrl: 'fixture', apiKey: 'fixture' })
  const before = await readDocumentCopy(first.docId!, projectPath)
  const integrity = await getDocumentIntegrity(projectPath, first.docId!)
  await saveDocumentCopy(first.docId!, 'chapter after', before.contentHash!, projectPath)
  const db = await getConnection(projectPath)
  const open = db.openTable.bind(db)
  let fail!: () => void
  let reached!: () => void
  const paused = new Promise<void>(resolve => { reached = resolve })
  const failure = new Promise<never>((_, reject) => { fail = () => reject(new Error('CATALOG_WRITE_FAILED')) })
  vi.spyOn(db, 'openTable').mockImplementation(async (...args) => {
    const table = await open(...args)
    if (args[0] === 'documents') vi.spyOn(table, 'update').mockImplementation(() => { reached(); return failure })
    return table
  })
  const rebuild = reindexDocumentCopy(first.docId!, projectPath)
  await paused
  let imported = false
  const concurrent = addChunks(projectPath, 'unrelated', 'other.txt', ['unrelated retained']).then(result => { imported = true; return result })
  await Promise.resolve()
  expect(imported).toBe(false)
  fail()
  expect(await rebuild).toMatchObject({ success: false, error: 'CATALOG_WRITE_FAILED' })
  expect(await concurrent).toMatchObject({ success: true })
  vi.restoreAllMocks()
  expect(await getDocumentIntegrity(projectPath, first.docId!)).toEqual({ ...integrity,
    embeddingGenerations: integrity!.embeddingGenerations.map(generation => ({ ...generation, status: 'inactive' })),
  })
  expect(await readDocumentCopy(first.docId!, projectPath)).toMatchObject({ content: 'chapter after', indexStatus: 'stale' })
  expect(await searchKnowledgeFTS('chapter', projectPath)).toEqual([])
  expect(await searchKnowledgeFTS('unrelated', projectPath)).toHaveLength(1)
  const vectorTableName = (await db.tableNames()).find(name => name.startsWith('chunks__space_'))!
  const table = await open(vectorTableName)
  try { expect((await table.query().toArray()).map(row => row.text)).toEqual(['chapter before']) }
  finally { table.close() }
  expect(await reindexDocumentCopy(first.docId!, projectPath)).toMatchObject({ success: true, docId: first.docId })
  expect((await readPortableKnowledgeSnapshot(getProjectDataRoot(projectPath))).documents).toHaveLength(2)
})

it('reports the committed import as successful when superseded copy cleanup fails', async () => {
  const projectPath = workspace()
  await importText('old text', 'same.txt', projectPath, 'openai', { baseUrl: '', apiKey: '' })
  const remove = vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('EBUSY') })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const current = await importText('new text', 'same.txt', projectPath, 'openai', { baseUrl: '', apiKey: '' })
  expect(current).toMatchObject({ success: true, chunkCount: 1 })
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('旧文档清理未完成'), expect.any(Error))
  remove.mockRestore()
  expect(await readDocumentCopy(current.docId!, projectPath)).toMatchObject({ available: true, content: 'new text' })
  expect((await readPortableKnowledgeSnapshot(getProjectDataRoot(projectPath))).documents).toEqual([expect.objectContaining({ docId: current.docId })])
})

it('recovers only same-source orphan groups during explicit reimport', async () => {
  const projectPath = workspace()
  await addChunks(projectPath, 'old', 'same.txt', ['old'], undefined, undefined, { corpusKind: 'reference', replacementMode: 'stable-id' })
  await addChunks(projectPath, 'current', 'same.txt', ['current'], undefined, undefined, { corpusKind: 'reference', replacementMode: 'stable-id' })
  await addChunks(projectPath, 'unknown-orphan', 'unrelated.txt', ['unknown data'], undefined, undefined, { corpusKind: 'reference', replacementMode: 'stable-id' })
  const db = await getConnection(projectPath)
  const documents = await db.openTable('documents')
  try { await documents.delete("id = 'old' OR id = 'unknown-orphan'") }
  finally { documents.close() }
  await expect(readPortableKnowledgeSnapshot(getProjectDataRoot(projectPath))).rejects.toThrow('PORTABLE_KNOWLEDGE_INVALID')
  expect(await addChunks(projectPath, 'new', 'same.txt', ['new'], undefined, undefined, { corpusKind: 'reference' })).toMatchObject({ success: true })
  expect(await searchKnowledgeFTS('old', projectPath)).toEqual([])
  expect(await searchKnowledgeFTS('unknown data', projectPath)).toHaveLength(1)
  await expect(readPortableKnowledgeSnapshot(getProjectDataRoot(projectPath))).rejects.toThrow('PORTABLE_KNOWLEDGE_INVALID')
  await removeDocument(projectPath, 'unknown-orphan')
  expect((await readPortableKnowledgeSnapshot(getProjectDataRoot(projectPath))).documents).toEqual([expect.objectContaining({ docId: 'new' })])
})

it('does not reconstruct a full original from legacy retrieval chunks', async () => {
  const parent = path.resolve('.runtime/.cache')
  fs.mkdirSync(parent, { recursive: true })
  const projectPath = fs.mkdtempSync(path.join(parent, 'knowledge-chunks-only-'))
  roots.push(projectPath)
  prepareCanonicalStorageFixture(projectPath)
  expect((await addChunks(projectPath, 'legacy-doc', 'legacy.txt', ['only a search snippet'])).success).toBe(true)
  expect(await readDocumentCopy('legacy-doc', projectPath)).toEqual({ available: false, indexStatus: 'unavailable' })
  expect(await saveDocumentCopy('legacy-doc', 'invented original', 'hash', projectPath)).toMatchObject({ success: false })
})

it('removes stale canonical and vector rows on same-name reimport before search or portable export', async () => {
  const parent = path.resolve('.runtime/.cache')
  fs.mkdirSync(parent, { recursive: true })
  const projectPath = fs.mkdtempSync(path.join(parent, 'knowledge-reimport-'))
  roots.push(projectPath)
  prepareCanonicalStorageFixture(projectPath)
  const model = { baseUrl: 'https://embedding.example/v1', apiKey: 'test-only', modelName: 'fixture' }
  generateEmbeddings.mockResolvedValue([[1, 0]])
  const first = await importText('旧梦镇源句', '同名资料.txt', projectPath, 'openai', model)
  expect(first.success).toBe(true)
  const before = await readDocumentCopy(first.docId!, projectPath)
  const oldSnapshot = await captureGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), query: '旧梦镇' })
  expect(await saveDocumentCopy(first.docId!, '已编辑但未重建', before.contentHash!, projectPath)).toEqual({ success: true })

  const second = await importText('新雾城源句', '同名资料.txt', projectPath, 'openai', model)
  expect(second.success).toBe(true)
  expect(await listDocuments(projectPath)).toEqual([expect.objectContaining({ id: second.docId })])
  expect(await getDocumentIntegrity(projectPath, first.docId!)).toBeNull()
  expect(await searchKnowledgeFTS('旧梦镇', projectPath)).toEqual([])
  expect(await searchKnowledge('旧梦镇', projectPath, 'openai', model))
    .toEqual([expect.objectContaining({ text: '新雾城源句' })])
  expect((await captureGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), query: '旧梦镇' })).items).toEqual([])
  await expect(verifyGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), snapshot: oldSnapshot })).rejects.toThrow('SOURCE_STALE')
  expect((await readPortableKnowledgeSnapshot(getProjectDataRoot(projectPath))).documents)
    .toEqual([expect.objectContaining({ docId: second.docId, copy: expect.objectContaining({ content: '新雾城源句' }) })])
})

it('edits only the project copy and excludes stale text from search and generation until explicit local rebuild', async () => {
  const parent = path.resolve('.runtime/.cache')
  fs.mkdirSync(parent, { recursive: true })
  const projectPath = fs.mkdtempSync(path.join(parent, 'knowledge-copy-'))
  roots.push(projectPath)
  prepareCanonicalStorageFixture(projectPath)
  const external = path.join(projectPath, '..', `${path.basename(projectPath)}-original.txt`)
  const original = '原稿中的星图'
  const edited = '项目副本中的新星图'
  const model = { baseUrl: 'https://embedding.example/v1', apiKey: 'test-only', modelName: 'fixture' }
  generateEmbeddings.mockResolvedValue([[1, 0]])
  fs.writeFileSync(external, original)
  try {
    const imported = await importDocument(external, projectPath, 'openai', model)
    expect(imported.success).toBe(true)
    const docId = imported.docId!
    const opened = await readDocumentCopy(docId, projectPath)
    expect(opened).toMatchObject({ available: true, content: original, edited: false, indexStatus: 'current' })
    const snapshot = await captureGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), query: '星图' })
    expect(snapshot.items).toHaveLength(1)
    const vectorRequest = { projectStorageRoot: getProjectDataRoot(projectPath), query: '星图', queryVector: [1, 0], embeddingSpace: { modelFingerprint: 'openai|https://embedding.example/v1|fixture', distanceMetric: 'l2' } }
    expect((await captureGenerationKnowledge(vectorRequest)).items).toHaveLength(1)

    expect(await saveDocumentCopy(docId, edited, opened.contentHash!, projectPath)).toEqual({ success: true })
    expect(fs.readFileSync(external, 'utf8')).toBe(original)
    expect(await readDocumentCopy(docId, projectPath)).toMatchObject({ content: edited, edited: true, indexStatus: 'stale' })
    expect(await searchKnowledgeFTS('星图', projectPath)).toEqual([])
    expect(await searchKnowledge('星图', projectPath, 'openai', model)).toEqual([])
    expect((await captureGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), query: '星图' })).items).toEqual([])
    expect((await captureGenerationKnowledge(vectorRequest)).items).toEqual([])
    await expect(verifyGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), snapshot })).rejects.toThrow('SOURCE_STALE')

    const stalePortable = await readPortableKnowledgeSnapshot(getProjectDataRoot(projectPath))
    const restoredStale = fs.mkdtempSync(path.join(parent, 'knowledge-restored-stale-'))
    roots.push(restoredStale)
    prepareCanonicalStorageFixture(restoredStale)
    await restorePortableKnowledgeSnapshot(getProjectDataRoot(restoredStale), stalePortable)
    expect(await readDocumentCopy(docId, restoredStale)).toMatchObject({ content: edited, indexStatus: 'stale' })
    expect(await searchKnowledgeFTS('星图', restoredStale)).toEqual([])
    expect((await captureGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(restoredStale), query: '星图' })).items).toEqual([])

    const rebuilt = await reindexDocumentCopy(docId, projectPath)
    expect(rebuilt.success).toBe(true)
    expect(rebuilt.docId).toBe(docId)
    expect(await listDocuments(projectPath)).toEqual([expect.objectContaining({ id: rebuilt.docId })])
    expect(fs.readdirSync(path.join(getProjectDataRoot(projectPath), 'knowledge-copies'))).toHaveLength(1)
    expect(await readDocumentCopy(rebuilt.docId!, projectPath)).toMatchObject({ content: edited, edited: true, indexStatus: 'current' })
    expect(await searchKnowledgeFTS('新星图', projectPath)).toEqual([expect.objectContaining({ text: edited })])
    const currentPortable = await readPortableKnowledgeSnapshot(getProjectDataRoot(projectPath))
    const restoredCurrent = fs.mkdtempSync(path.join(parent, 'knowledge-restored-current-'))
    roots.push(restoredCurrent)
    prepareCanonicalStorageFixture(restoredCurrent)
    await restorePortableKnowledgeSnapshot(getProjectDataRoot(restoredCurrent), currentPortable)
    expect(await readDocumentCopy(rebuilt.docId!, restoredCurrent)).toMatchObject({ content: edited, edited: true, indexStatus: 'current' })
    expect(await searchKnowledgeFTS('新星图', restoredCurrent)).toEqual([expect.objectContaining({ text: edited })])
    expect(fs.readFileSync(external, 'utf8')).toBe(original)
    expect(await clearKnowledgeBase(projectPath)).toBe(true)
    expect(fs.existsSync(path.join(getProjectDataRoot(projectPath), 'knowledge-copies'))).toBe(false)
  } finally { fs.rmSync(external, { force: true }) }
})
