import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../test/helpers/canonical-project-fixture'
import { getProjectDataRoot } from '../services/project-data-locator'
import { addChunks, closeConnection, getDocumentIntegrity, listDocuments, readPortableKnowledgeSnapshot, restorePortableKnowledgeSnapshot } from '../vector-store'
import { clearKnowledgeBase, importDocument, importText, readDocumentCopy, reindexDocumentCopy, saveDocumentCopy, searchKnowledge, searchKnowledgeFTS } from '../knowledge-base'
import { captureGenerationKnowledge, verifyGenerationKnowledge } from '../services/generation-knowledge-source'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'

const { generateEmbeddings } = vi.hoisted(() => ({ generateEmbeddings: vi.fn() }))
vi.mock('../embedding', () => ({ chunkText: (text: string) => [text], generateEmbeddings }))

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    closeConnection(root)
    await removeDirectoryWithWindowsRetry(root)
  }
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
    expect(rebuilt.docId).not.toBe(docId)
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
