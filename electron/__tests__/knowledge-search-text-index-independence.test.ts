import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCanonicalProjectFixture, prepareCanonicalStorageFixture } from '../../test/helpers/canonical-project-fixture'
import { closeProjectDatabase } from '../database'
import { importReferenceText, importText, readDocumentCopy, reindexDocumentCopy, saveDocumentCopy, searchKnowledgeFTS } from '../knowledge-base'
import { Index } from '../lance-database'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { getProjectDataRoot } from '../services/project-data-locator'
import { addChunks, closeConnection, getConnection, readPortableKnowledgeSnapshot, restorePortableKnowledgeSnapshot, searchWithScope } from '../vector-store'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'

const model = { provider: 'openai', baseUrl: 'https://unused.example/v1', apiKey: '', modelName: 'fts-only' }
const LIGHTHOUSE = '灯塔守夜人在雾里点亮第三盏灯。'
const BELL_TOWER = '潮汐钟楼的钥匙藏在铜像底座。'
const TIDE_TABLE = '雾港的潮汐表记在旧航海日志里。'
const CHAPTER_1 = '第1章 雾灯 正文.md'
const CHAPTER_2 = '第2章 钟楼 正文.md'

const roots: string[] = []
let projectPath = ''

function newRoot(prefix: string): string {
  fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true })
  const root = fs.mkdtempSync(path.resolve('.runtime/.cache', prefix))
  roots.push(root)
  return root
}

async function addLegacyTextIndex(root: string): Promise<void> {
  const db = await getConnection(root)
  const chunks = await db.openTable('chunks')
  try {
    await chunks.createIndex('text', { config: Index.fts() })
    expect((await chunks.listIndices()).map(index => index.columns)).toEqual([['text']])
  } finally { chunks.close() }
}

async function seedProjectWithLegacyTextIndex(): Promise<string> {
  const seeded = await importText(LIGHTHOUSE, CHAPTER_1, projectPath, 'openai', model)
  expect(seeded.success).toBe(true)
  await addLegacyTextIndex(projectPath)
  return seeded.docId!
}

function authorizedReferenceImport(content: string) {
  const prepared = ImportRunRepository.prepare({
    runId: 'text-index-independence-reference',
    purpose: 'reference',
    sourceFingerprint: createHash('sha256').update('source:text-index-independence').digest('hex'),
    locale: 'zh-CN',
    sourceDisplay: [{ displayName: '参考.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{
      number: 1,
      title: '参考',
      content,
      contentSize: Buffer.byteLength(content),
      contentFingerprint: createHash('sha256').update(content).digest('hex'),
    }],
  })
  if (!prepared.run) throw new Error('Expected an import run')
  const chapterNumber = prepared.newChapterNumbers[0]
  const started = ImportRunRepository.startOrResume(prepared.run.id, 'text-index-independence-owner')
  const authority = { owner: started.execution.owner, epoch: started.execution.epoch }
  const stableKey = ImportRunRepository.resolveReferenceImportAuthority(prepared.run.id, authority, chapterNumber).stableKey
  return importReferenceText(content, '参考.txt', stableKey, chapterNumber, prepared.run.id, authority, projectPath, 'openai', model)
}

const hit = (text: string, fileName: string) => ({ text, score: 0.5, fileName })

beforeEach(() => {
  projectPath = newRoot('kb-text-index-')
  openCanonicalProjectFixture(projectPath)
})

afterEach(async () => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) {
    closeConnection(root)
    await removeDirectoryWithWindowsRetry(root)
  }
})

describe('knowledge search does not depend on a full-text index', () => {
  it('finalized-chapter import on a table with a leftover text index keeps text search, ranking and chapter scope', async () => {
    await seedProjectWithLegacyTextIndex()
    expect((await importText(BELL_TOWER, CHAPTER_2, projectPath, 'openai', model)).success).toBe(true)

    expect(await searchKnowledgeFTS('灯塔', projectPath)).toEqual([hit(LIGHTHOUSE, CHAPTER_1)])
    expect(await searchKnowledgeFTS('钟楼 钥匙', projectPath)).toEqual([hit(BELL_TOWER, CHAPTER_2)])
    expect(await searchKnowledgeFTS('钟楼 灯塔', projectPath)).toEqual([hit(BELL_TOWER, CHAPTER_2), hit(LIGHTHOUSE, CHAPTER_1)])
    expect(await searchKnowledgeFTS('钟楼 灯塔', projectPath, 5, [1, 1])).toEqual([hit(LIGHTHOUSE, CHAPTER_1)])
    expect(await searchKnowledgeFTS('不存在的词', projectPath)).toEqual([])
  })

  it('reference import on a table with a leftover text index stays searchable and excludable by corpus kind', async () => {
    await seedProjectWithLegacyTextIndex()
    expect(await authorizedReferenceImport(TIDE_TABLE)).toMatchObject({ success: true })

    expect(await searchKnowledgeFTS('潮汐表', projectPath)).toEqual([hit(TIDE_TABLE, '参考.txt')])
    expect(await searchKnowledgeFTS('潮汐表 灯塔', projectPath, 5, undefined, ['reference'])).toEqual([hit(LIGHTHOUSE, CHAPTER_1)])
  })

  it('rebuilding a document from its edited copy on a table with a leftover text index replaces the searchable text', async () => {
    const docId = await seedProjectWithLegacyTextIndex()
    const copy = await readDocumentCopy(docId, projectPath)
    expect((await saveDocumentCopy(docId, BELL_TOWER, copy.contentHash!, projectPath)).success).toBe(true)

    expect(await reindexDocumentCopy(docId, projectPath)).toMatchObject({ success: true, docId, chunkCount: 1 })
    expect(await searchKnowledgeFTS('钟楼', projectPath)).toEqual([hit(BELL_TOWER, CHAPTER_1)])
    expect(await searchKnowledgeFTS('灯塔', projectPath)).toEqual([])
  })

  it('a restored portable knowledge snapshot answers text queries like its source', async () => {
    await seedProjectWithLegacyTextIndex()
    expect((await importText(BELL_TOWER, CHAPTER_2, projectPath, 'openai', model)).success).toBe(true)
    const snapshot = await readPortableKnowledgeSnapshot(getProjectDataRoot(projectPath))

    const restored = newRoot('kb-text-index-restored-')
    prepareCanonicalStorageFixture(restored)
    await restorePortableKnowledgeSnapshot(getProjectDataRoot(restored), snapshot)

    expect(await searchKnowledgeFTS('灯塔', restored)).toEqual([hit(LIGHTHOUSE, CHAPTER_1)])
    expect(await searchKnowledgeFTS('钟楼 灯塔', restored)).toEqual([hit(BELL_TOWER, CHAPTER_2), hit(LIGHTHOUSE, CHAPTER_1)])
    expect(await searchKnowledgeFTS('不存在的词', restored)).toEqual([])
  })

  it('vector search through an active embedding space is unaffected by a leftover text index', async () => {
    const space = { modelFingerprint: 'text-index-independence', distanceMetric: 'l2' }
    expect((await addChunks(projectPath, 'doc-1', CHAPTER_1, [LIGHTHOUSE], [[1, 0, 0]], undefined, { chapterNumber: 1 }, space)).success).toBe(true)
    await addLegacyTextIndex(projectPath)
    expect((await addChunks(projectPath, 'doc-2', CHAPTER_2, [BELL_TOWER], [[0, 1, 0]], undefined, { chapterNumber: 2 }, space)).success).toBe(true)

    const nearest = await searchWithScope(projectPath, '', [0, 1, 0], 5, undefined, space)
    expect(nearest.map(result => result.text)).toEqual([BELL_TOWER, LIGHTHOUSE])
    expect(nearest[0].score).toBe(1)
    expect((await searchWithScope(projectPath, '', [0, 1, 0], 5, [1, 1], space)).map(result => result.text)).toEqual([LIGHTHOUSE])
  })
})
