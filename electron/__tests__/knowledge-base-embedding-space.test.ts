import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { generateEmbeddingsMock } = vi.hoisted(() => ({
  generateEmbeddingsMock: vi.fn(),
}))

vi.mock('../embedding', () => ({
  chunkText: (text: string) => [text],
  generateEmbeddings: generateEmbeddingsMock,
}))

import {
  backfillVectors,
  importDocument,
  importText,
  searchKnowledge,
  searchKnowledgeFTS,
} from '../knowledge-base'
import {
  addChunks,
  closeConnection,
  getChunksForBackfill,
  getChunksWithoutVectors,
  getConnection,
  getEmbeddingSpaces,
  listDocuments,
  search,
} from '../vector-store'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'
import { EmbeddingResponseValidationError } from '../services/embedding-response-error'

describe('知识库嵌入空间回填', () => {
  const projects: string[] = []

  afterEach(async () => {
    generateEmbeddingsMock.mockReset()
    for (const projectPath of projects.splice(0)) {
      closeConnection(projectPath)
      await removeDirectoryWithWindowsRetry(projectPath)
    }
  })

  it('通过主进程知识库生产缝逐字节保存并读回混合 UTF-8 参照文本', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-utf8-roundtrip-'))
    projects.push(projectPath)
    const content = 'The sign reads “夜航 Café” — déjà vu. 招牌写着“回家”。'
    const fileName = 'Chapter 1 夜航 Café.txt'
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2, 0.3]])

    await expect(importText(content, fileName, projectPath, 'openai', {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'test-key-not-persisted',
      modelName: 'fake-embedding',
    })).resolves.toMatchObject({ success: true, chunkCount: 1 })

    await expect(listDocuments(projectPath)).resolves.toEqual([
      expect.objectContaining({ fileName, corpusKind: 'project-knowledge' }),
    ])

    const results = await searchKnowledgeFTS('夜航 Café', projectPath, 5)
    expect(results).toEqual([
      expect.objectContaining({ fileName, text: content }),
    ])
    const restored = results[0]?.text ?? ''
    expect(Buffer.from(restored, 'utf8')).toEqual(Buffer.from(content, 'utf8'))
  })

  it('imports planning material as FTS-only without calling an embedding provider', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-planning-local-'))
    projects.push(projectPath)
    const content = '林晓是一名数据调查员。'

    await expect(importText(content, '人物设定.md', projectPath, 'openai', {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'configured-key',
      modelName: 'embedding-model',
    }, { mode: 'fts-only' })).resolves.toMatchObject({ success: true, chunkCount: 1 })

    expect(generateEmbeddingsMock).not.toHaveBeenCalled()
    await expect(searchKnowledgeFTS('数据调查员', projectPath, 5)).resolves.toEqual([
      expect.objectContaining({ fileName: '人物设定.md', text: content }),
    ])
  })

  it('keeps the first finalized chapter FTS-only when local planning material already awaits an explicit rebuild', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-planning-then-finalize-'))
    projects.push(projectPath)
    const model = {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'configured-key',
      modelName: 'embedding-model',
    }

    await expect(importText(
      '作者创作资料。',
      'planning-material.txt',
      projectPath,
      'openai',
      model,
      { mode: 'fts-only' },
    )).resolves.toMatchObject({ success: true, chunkCount: 1 })
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2, 0.3]])

    await expect(importText(
      '第一章定稿正文。',
      '第1章 初遇.txt',
      projectPath,
      'openai',
      model,
    )).resolves.toMatchObject({ success: true, chunkCount: 1 })

    expect(generateEmbeddingsMock).not.toHaveBeenCalled()
    await expect(getEmbeddingSpaces(projectPath)).resolves.toEqual({
      version: 1,
      activeGeneration: null,
      spaces: [],
    })
    await expect(searchKnowledgeFTS('第一章定稿正文', projectPath, 5)).resolves.toEqual([
      expect.objectContaining({ fileName: '第1章 初遇.txt', text: '第一章定稿正文。' }),
    ])
  })

  it('写作检索的 FTS 与语义路径都按 corpus kind 排除参照语料', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-writing-corpus-'))
    projects.push(projectPath)
    const vector = [0.1, 0.2, 0.3]
    const model = {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'test-key-not-persisted',
      modelName: 'fake-embedding',
    }
    const space = {
      modelFingerprint: 'openai|https://embedding.example/v1|fake-embedding',
      distanceMetric: 'l2',
    }
    await addChunks(
      projectPath,
      'legacy-document',
      'legacy.txt',
      ['写作检索哨兵 legacy fact'],
      [vector],
      undefined,
      { corpusKind: 'unknown' },
      space,
    )
    await addChunks(
      projectPath,
      'project-document',
      'project.txt',
      ['写作检索哨兵 project fact'],
      [vector],
      undefined,
      { corpusKind: 'project-knowledge' },
      space,
    )
    await addChunks(
      projectPath,
      'reference-document',
      'reference.txt',
      ['写作检索哨兵 REFERENCE_SENTINEL'],
      [vector],
      undefined,
      { corpusKind: 'reference' },
      space,
    )
    generateEmbeddingsMock.mockResolvedValue([vector])

    const ftsResults = await searchKnowledgeFTS(
      '写作检索哨兵',
      projectPath,
      10,
      undefined,
      ['reference'],
    )
    const semanticResults = await searchKnowledge(
      '写作检索哨兵',
      projectPath,
      'openai',
      model,
      10,
      undefined,
      ['reference'],
    )
    expect(semanticResults.every(result => result.score > 0.5)).toBe(true)

    for (const results of [ftsResults, semanticResults]) {
      expect(results.map(result => result.text)).toEqual(expect.arrayContaining([
        '写作检索哨兵 legacy fact',
        '写作检索哨兵 project fact',
      ]))
      expect(JSON.stringify(results)).not.toContain('REFERENCE_SENTINEL')
    }
  })

  it('ranks every lexical match before topK so a late explicit planning hint is retained', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-planning-ranking-'))
    projects.push(projectPath)
    const model = {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'test-key-not-persisted',
      modelName: 'fake-embedding',
    }
    for (let index = 0; index < 7; index += 1) {
      await importText(
        `林晓的普通课程记录 ${index}。`,
        `generic-${index}.md`,
        projectPath,
        'openai',
        model,
        { mode: 'fts-only' },
      )
    }
    await importText(
      '作者检索哨兵：周岚隐瞒历史事故以保护幸存者。',
      'author-planning.md',
      projectPath,
      'openai',
      model,
      { mode: 'fts-only' },
    )
    expect(generateEmbeddingsMock).not.toHaveBeenCalled()

    const results = await searchKnowledgeFTS(
      '作者检索哨兵 林晓 数据对峙 异常标签 旧实验室 陆星辰 系统警报 第七章 保护幸存者 历史事故',
      projectPath,
      2,
      undefined,
      ['reference'],
    )

    expect(results).toHaveLength(2)
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fileName: 'author-planning.md',
        text: '作者检索哨兵：周岚隐瞒历史事故以保护幸存者。',
      }),
    ]))
    expect(results[0]?.fileName).toBe('author-planning.md')
  })

  it('回填按模型实际 1536 维建空间并激活，不重建 chunks 全文表', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-backfill-'))
    projects.push(projectPath)
    expect(await addChunks(projectPath, 'fts-document', 'fts.txt', ['待回填的全文正文']))
      .toEqual({ success: true, chunkCount: 1 })

    const db = await getConnection(projectPath)
    const canonicalTable = await db.openTable('chunks')
    const canonicalVersionBefore = await canonicalTable.version()
    const vector = Array.from({ length: 1536 }, (_, index) => index / 1536)
    generateEmbeddingsMock.mockResolvedValue([vector])

    await expect(backfillVectors(projectPath, 'openai', {
      baseUrl: 'https://embedding.example/v1/',
      apiKey: 'test-key-not-persisted',
      modelName: 'model-1536',
    })).resolves.toEqual({ success: true, processed: 1, failed: 0 })

    const identity = {
      modelFingerprint: 'openai|https://embedding.example/v1|model-1536',
      distanceMetric: 'l2',
    }
    await expect(getEmbeddingSpaces(projectPath)).resolves.toMatchObject({
      spaces: [expect.objectContaining({ ...identity, vectorDimension: 1536, status: 'active' })],
    })
    expect(await (await db.openTable('chunks')).version()).toBe(canonicalVersionBefore)
    await expect(search(projectPath, '待回填', vector, 5, identity)).resolves.toEqual([
      expect.objectContaining({ fileName: 'fts.txt', text: '待回填的全文正文' }),
    ])
  })

  it('同一模型指纹从满 768 维空间变为 1536 维时，探测实际响应并完整建立新代际', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-dimension-rebuild-'))
    projects.push(projectPath)
    const identity = {
      modelFingerprint: 'openai|https://embedding.example/v1|same-model',
      distanceMetric: 'l2',
    }
    const vector768 = Array.from({ length: 768 }, (_, index) => index / 768)
    const vector1536 = Array.from({ length: 1536 }, (_, index) => index / 1536)
    expect(await addChunks(
      projectPath,
      'old-document',
      'old.txt',
      ['第一段旧正文', '第二段旧正文'],
      [vector768, vector768],
      undefined,
      undefined,
      identity,
    )).toEqual({ success: true, chunkCount: 2 })

    const before = await getEmbeddingSpaces(projectPath)
    const oldSpace = before.spaces.find(space => space.vectorDimension === 768)
    expect(oldSpace).toBeDefined()
    const db = await getConnection(projectPath)
    const oldCount = await (await db.openTable(oldSpace!.tableName)).countRows()
    generateEmbeddingsMock.mockImplementation(async (texts: string[]) => texts.map(() => vector1536))

    await expect(backfillVectors(projectPath, 'openai', {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'test-key-not-persisted',
      modelName: 'same-model',
    })).resolves.toMatchObject({ success: true, processed: 2, failed: 0 })

    const after = await getEmbeddingSpaces(projectPath)
    const active = after.spaces.find(space => space.generation === after.activeGeneration)
    const retired = after.spaces.find(space => space.generation === oldSpace!.generation)
    expect(active).toMatchObject({ ...identity, vectorDimension: 1536, status: 'active' })
    expect(retired).toMatchObject({ vectorDimension: 768, status: 'inactive' })
    expect(await (await db.openTable(oldSpace!.tableName)).countRows()).toBe(oldCount)
    expect(await (await db.openTable(active!.tableName)).countRows()).toBe(2)
    await expect(search(projectPath, '第一段旧正文', vector1536, 5, identity)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName: 'old.txt', text: '第一段旧正文' }),
    ]))
  })

  it('同一模型指纹变更维度的重建失败时，旧 active 代际、表和查询结果保持不变', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-dimension-rebuild-failure-'))
    projects.push(projectPath)
    const identity = {
      modelFingerprint: 'openai|https://embedding.example/v1|same-model',
      distanceMetric: 'l2',
    }
    const vector768 = Array.from({ length: 768 }, (_, index) => index / 768)
    const vector1536 = Array.from({ length: 1536 }, (_, index) => index / 1536)
    expect(await addChunks(
      projectPath,
      'old-document',
      'old.txt',
      ['第一段旧正文', '第二段旧正文'],
      [vector768, vector768],
      undefined,
      undefined,
      identity,
    )).toEqual({ success: true, chunkCount: 2 })

    const beforeRegistry = await getEmbeddingSpaces(projectPath)
    const db = await getConnection(projectPath)
    const beforeTables = await db.tableNames()
    generateEmbeddingsMock
      .mockResolvedValueOnce([vector1536])
      .mockRejectedValueOnce(new Error('embedding provider unavailable'))

    await expect(backfillVectors(projectPath, 'openai', {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'test-key-not-persisted',
      modelName: 'same-model',
    })).resolves.toMatchObject({ success: false, processed: 0 })

    expect(await getEmbeddingSpaces(projectPath)).toEqual(beforeRegistry)
    expect(await db.tableNames()).toEqual(beforeTables)
    await expect(search(projectPath, '第一段旧正文', vector768, 5, identity)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName: 'old.txt', text: '第一段旧正文' }),
    ]))
  })

  it('回填响应包含非法数值时在 Arrow 前失败，全文表和 FTS 保持可用', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-backfill-invalid-'))
    projects.push(projectPath)
    expect(await addChunks(projectPath, 'fts-document', 'fts.txt', ['仍需保留的全文正文']))
      .toEqual({ success: true, chunkCount: 1 })
    const db = await getConnection(projectPath)
    const tablesBefore = await db.tableNames()
    generateEmbeddingsMock.mockResolvedValue([
      Array.from({ length: 1536 }, (_, index) => index === 7 ? Number.NaN : 0),
    ])

    await expect(backfillVectors(projectPath, 'openai', {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'test-key-not-persisted',
      modelName: 'model-1536',
    })).resolves.toMatchObject({ success: false, processed: 0, failed: 1, error: expect.stringMatching(/非有限/) })

    expect(await db.tableNames()).toEqual(tablesBefore)
    await expect(search(projectPath, '仍需保留', undefined, 5)).resolves.toEqual([
      expect.objectContaining({ fileName: 'fts.txt', text: '仍需保留的全文正文' }),
    ])
  })

  it('导入遇到无效 Embedding 响应时返回可理解错误且不打开 LanceDB', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-import-invalid-response-'))
    projects.push(projectPath)
    generateEmbeddingsMock.mockRejectedValue(new EmbeddingResponseValidationError(
      'OpenAI',
      '第 1 个向量的第 2 个值不是有限数字（收到 null）',
    ))

    await expect(importText('不应写入数据库的正文', 'invalid.txt', projectPath, 'openai', {
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: 'test-key',
      modelName: 'qwen3-embedding',
    })).resolves.toEqual({
      success: false,
      error: 'OpenAI Embedding 响应无效：第 1 个向量的第 2 个值不是有限数字（收到 null）',
    })

    expect(fs.existsSync(path.join(projectPath, '.vela', 'lancedb'))).toBe(false)
  })

  it('文件导入遇到无效 Embedding 响应时不打开 LanceDB', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-file-invalid-response-'))
    projects.push(projectPath)
    const filePath = path.join(projectPath, 'invalid.txt')
    fs.writeFileSync(filePath, '不应写入数据库的文件正文', 'utf8')
    generateEmbeddingsMock.mockRejectedValue(new EmbeddingResponseValidationError(
      'OpenAI',
      '第 1 个向量的第 2 个值不是有限数字（收到 null）',
    ))

    await expect(importDocument(filePath, projectPath, 'openai', {
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: 'test-key',
      modelName: 'qwen3-embedding',
    })).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/OpenAI Embedding 响应无效.*第 2 个值.*null/),
    })

    expect(fs.existsSync(path.join(projectPath, '.vela', 'lancedb'))).toBe(false)
  })

  it('importText 遇到 reindex_required 时不先删除同名旧文档', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-import-conflict-'))
    projects.push(projectPath)
    const oldSpace = {
      modelFingerprint: 'openai|https://embedding.example/v1|model-a',
      distanceMetric: 'l2',
    }
    const oldVector = Array.from({ length: 768 }, (_, index) => index / 768)
    expect(await addChunks(
      projectPath,
      'old-document',
      'same-name.txt',
      ['同名旧文档必须保留'],
      [oldVector],
      undefined,
      undefined,
      oldSpace,
    )).toEqual({ success: true, chunkCount: 1 })

    generateEmbeddingsMock.mockResolvedValue([
      Array.from({ length: 1024 }, (_, index) => index / 1024),
    ])
    await expect(importText('不应覆盖的新内容', 'same-name.txt', projectPath, 'openai', {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'test-key-not-persisted',
      modelName: 'model-b',
    })).resolves.toMatchObject({ success: false, error: expect.stringMatching(/reindex_required/i) })

    await expect(search(projectPath, '同名旧文档', oldVector, 5, oldSpace)).resolves.toEqual([
      expect.objectContaining({ fileName: 'same-name.txt', text: '同名旧文档必须保留' }),
    ])
  })

  it('嵌入空间元数据损坏时回填与缺失统计显式失败，不伪报 0 条成功', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-corrupt-registry-'))
    projects.push(projectPath)
    expect(await addChunks(projectPath, 'fts-document', 'fts.txt', ['无法静默吞掉的全文正文']))
      .toEqual({ success: true, chunkCount: 1 })
    fs.writeFileSync(path.join(projectPath, '.vela', 'embedding-spaces.json'), '{invalid json', 'utf8')
    const space = { modelFingerprint: 'openai|https://embedding.example/v1|model-1536', distanceMetric: 'l2' }

    await expect(getChunksForBackfill(projectPath, 10, space)).rejects.toThrow(/嵌入空间元数据/)
    await expect(getChunksWithoutVectors(projectPath, space)).rejects.toThrow(/嵌入空间元数据/)
    await expect(backfillVectors(projectPath, 'openai', {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'test-key-not-persisted',
      modelName: 'model-1536',
    })).resolves.toMatchObject({
      success: false,
      processed: 0,
      error: expect.stringMatching(/^嵌入空间元数据/),
    })
    expect(generateEmbeddingsMock).not.toHaveBeenCalled()
  })

  it('旧 vectors.json 迁移失败时阻断导入、回填和检索，修正前不创建新空间', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-migration-barrier-'))
    projects.push(projectPath)
    const velaPath = path.join(projectPath, '.vela')
    fs.mkdirSync(velaPath, { recursive: true })
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)
    fs.writeFileSync(path.join(velaPath, 'vectors.json'), JSON.stringify({
      documents: [
        { id: 'legacy-valid', fileName: 'valid.txt', importedAt: '2026-01-01T00:00:00.000Z', chunkCount: 1, filePath: '' },
        { id: 'legacy-invalid', fileName: 'invalid.txt', importedAt: '2026-01-01T00:00:00.000Z', chunkCount: 1, filePath: '' },
      ],
      entries: [
        { id: 'legacy-valid-chunk', docId: 'legacy-valid', text: '合法旧正文', vector, meta: { fileName: 'valid.txt', chunkIndex: 0, totalChunks: 1 } },
        { id: 'legacy-invalid-chunk', docId: 'legacy-invalid', text: '非法旧正文', vector: [...vector.slice(0, 1), null, ...vector.slice(2)], meta: { fileName: 'invalid.txt', chunkIndex: 0, totalChunks: 1 } },
      ],
    }), 'utf8')
    const model = {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'test-key-not-persisted',
      modelName: 'model-768',
    }
    generateEmbeddingsMock.mockResolvedValue([vector])

    await expect(importText('新的正文不应导入', 'new.txt', projectPath, 'openai', model))
      .resolves.toMatchObject({ success: false, error: expect.stringMatching(/旧向量.*迁移|迁移.*未完成/) })
    await expect(backfillVectors(projectPath, 'openai', model))
      .resolves.toMatchObject({ success: false, processed: 0, error: expect.stringMatching(/旧向量.*迁移|迁移.*未完成/) })
    await expect(searchKnowledge('查询', projectPath, 'openai', model)).rejects.toThrow(/旧向量.*迁移|迁移.*未完成/)
    await expect(searchKnowledgeFTS('查询', projectPath)).rejects.toThrow(/旧向量.*迁移|迁移.*未完成/)
    expect(generateEmbeddingsMock).not.toHaveBeenCalled()

    const db = await getConnection(projectPath)
    expect(await db.tableNames()).toEqual([])
  })

  it('active 代际后 FTS-only 增量导入会先撤销 active，搜索仍能命中新文档并且全量重建后才重新激活', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-fts-increment-invalidate-'))
    projects.push(projectPath)
    const space = {
      modelFingerprint: 'openai|https://embedding.example/v1|model-768',
      distanceMetric: 'l2',
    }
    const model = {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'test-key-not-persisted',
      modelName: 'model-768',
    }
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)

    await expect(addChunks(
      projectPath,
      'document-a',
      'a.txt',
      ['文档 A 的完整向量正文'],
      [vector],
      undefined,
      undefined,
      space,
    )).resolves.toEqual({ success: true, chunkCount: 1 })
    const before = await getEmbeddingSpaces(projectPath)
    expect(before.activeGeneration).not.toBeNull()

    generateEmbeddingsMock.mockRejectedValueOnce(new Error('embedding unavailable for B'))
    await expect(importText('文档 B 的 FTS-only 新正文', 'b.txt', projectPath, 'openai', model))
      .resolves.toMatchObject({ success: true, chunkCount: 1 })

    const inactive = await getEmbeddingSpaces(projectPath)
    expect(inactive.activeGeneration).toBeNull()
    expect(inactive.spaces.find(space => space.generation === before.activeGeneration))
      .toMatchObject({ status: 'inactive' })

    generateEmbeddingsMock.mockRejectedValueOnce(new Error('embedding unavailable for query'))
    await expect(searchKnowledge('文档 B', projectPath, 'openai', model)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName: 'b.txt', text: '文档 B 的 FTS-only 新正文' }),
    ]))

    generateEmbeddingsMock.mockImplementation(async (texts: string[]) => texts.map(() => vector))
    await expect(backfillVectors(projectPath, 'openai', model)).resolves.toEqual({
      success: true,
      processed: 2,
      failed: 0,
    })
    const rebuilt = await getEmbeddingSpaces(projectPath)
    const active = rebuilt.spaces.find(space => space.generation === rebuilt.activeGeneration)
    expect(active).toMatchObject({ ...space, vectorDimension: 768, status: 'active' })
    expect(active?.generation).not.toBe(before.activeGeneration)
    await expect(search(projectPath, '文档 B', vector, 5, space)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName: 'b.txt', text: '文档 B 的 FTS-only 新正文' }),
    ]))
  })

  it('FTS-only 增量后回填失败保持 no-active，旧向量表不被破坏且 FTS 仍包含新增文档', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-fts-increment-failure-'))
    projects.push(projectPath)
    const space = {
      modelFingerprint: 'openai|https://embedding.example/v1|model-768',
      distanceMetric: 'l2',
    }
    const model = {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'test-key-not-persisted',
      modelName: 'model-768',
    }
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)
    await expect(addChunks(
      projectPath,
      'document-a',
      'a.txt',
      ['保留的文档 A 正文'],
      [vector],
      undefined,
      undefined,
      space,
    )).resolves.toEqual({ success: true, chunkCount: 1 })

    generateEmbeddingsMock.mockRejectedValueOnce(new Error('embedding unavailable for B'))
    await expect(importText('保留的文档 B 正文', 'b.txt', projectPath, 'openai', model))
      .resolves.toMatchObject({ success: true, chunkCount: 1 })
    const beforeFailure = await getEmbeddingSpaces(projectPath)
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    const oldSpace = beforeFailure.spaces[0]!
    const oldVectorCount = await (await db.openTable(oldSpace.tableName)).countRows()

    generateEmbeddingsMock.mockRejectedValueOnce(new Error('embedding unavailable for rebuild probe'))
    await expect(backfillVectors(projectPath, 'openai', model)).resolves.toMatchObject({
      success: false,
      processed: 0,
    })
    expect(await getEmbeddingSpaces(projectPath)).toEqual(beforeFailure)
    expect((await db.tableNames()).sort()).toEqual(tableNames.sort())
    expect(await (await db.openTable(oldSpace.tableName)).countRows()).toBe(oldVectorCount)

    generateEmbeddingsMock.mockRejectedValueOnce(new Error('embedding unavailable for query'))
    await expect(searchKnowledge('文档 B', projectPath, 'openai', model)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName: 'b.txt', text: '保留的文档 B 正文' }),
    ]))
  })

  it('无法先持久化 active 降级时拒绝写入 FTS-only canonical，旧代际保持完整', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-fts-increment-registry-failure-'))
    projects.push(projectPath)
    const space = {
      modelFingerprint: 'openai|https://embedding.example/v1|model-768',
      distanceMetric: 'l2',
    }
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)
    await expect(addChunks(
      projectPath,
      'document-a',
      'a.txt',
      ['完整的文档 A 正文'],
      [vector],
      undefined,
      undefined,
      space,
    )).resolves.toEqual({ success: true, chunkCount: 1 })

    const db = await getConnection(projectPath)
    const beforeRegistry = await getEmbeddingSpaces(projectPath)
    const oldSpace = beforeRegistry.spaces.find(space => space.generation === beforeRegistry.activeGeneration)!
    const oldVectorCount = await (await db.openTable(oldSpace.tableName)).countRows()
    const originalRenameSync = fs.renameSync
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('embedding-spaces.json')) {
        throw new Error('injected active invalidation persistence failure')
      }
      return originalRenameSync(from, to)
    })

    try {
      await expect(addChunks(
        projectPath,
        'document-b',
        'b.txt',
        ['不应在降级失败时写入的文档 B 正文'],
      )).resolves.toMatchObject({
        success: false,
        chunkCount: 0,
        error: expect.stringContaining('injected active invalidation persistence failure'),
      })
    } finally {
      renameSpy.mockRestore()
    }

    expect(await getEmbeddingSpaces(projectPath)).toEqual(beforeRegistry)
    expect(await (await db.openTable('chunks')).countRows()).toBe(1)
    expect(await (await db.openTable(oldSpace.tableName)).countRows()).toBe(oldVectorCount)
  })
})
