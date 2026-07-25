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
  search,
} from '../vector-store'

describe('知识库嵌入空间回填', () => {
  const projects: string[] = []

  afterEach(() => {
    generateEmbeddingsMock.mockReset()
    for (const projectPath of projects.splice(0)) {
      closeConnection(projectPath)
      fs.rmSync(projectPath, { recursive: true, force: true })
    }
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
