import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Field, FixedSizeList as ArrowFixedSizeList, Float32, Int32, Schema as ArrowSchema, Utf8 } from 'apache-arrow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addChunks,
  closeConnection,
  getChunksForBackfill,
  getConnection,
  getEmbeddingSpaces,
  listDocuments,
  getStats,
  migrateFromJSON,
  removeDocument,
  search,
  searchWithScope,
  updateChunkVectors,
} from '../vector-store'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'

type VectorConnection = Awaited<ReturnType<typeof getConnection>>

function embeddingTableNames(tableNames: readonly string[]): string[] {
  return tableNames.filter(tableName => tableName.startsWith('chunks__space_')).sort()
}

function failCreateTableAfterSuccess(
  db: VectorConnection,
  targetTableName: string,
  message: string,
): void {
  const originalCreateTable = db.createTable
  vi.spyOn(db, 'createTable').mockImplementation(async (...args) => {
    const table = await Reflect.apply(originalCreateTable, db, args)
    if (String(args[0]) === targetTableName) throw new Error(message)
    return table
  })
}

function failNthTableOpen(
  db: VectorConnection,
  targetTableName: string,
  occurrence: number,
  message: string,
): void {
  const originalOpenTable = db.openTable
  let seen = 0
  vi.spyOn(db, 'openTable').mockImplementation(async (...args) => {
    if (String(args[0]) === targetTableName && ++seen === occurrence) throw new Error(message)
    return await Reflect.apply(originalOpenTable, db, args)
  })
}

describe('知识库向量维度', () => {
  const projects: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const projectPath of projects.splice(0)) {
      closeConnection(projectPath)
      await removeDirectoryWithWindowsRetry(projectPath)
    }
  })

  it('closeConnection 会真正释放缓存的 LanceDB 原生连接', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-close-'))
    projects.push(projectPath)
    const db = await getConnection(projectPath)

    expect(db.isOpen()).toBe(true)
    closeConnection(projectPath)

    expect(db.isOpen()).toBe(false)
  })

  it('接受嵌入模型返回的非 2048 维有限向量', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-dimension-'))
    projects.push(projectPath)

    const result = await addChunks(
      projectPath,
      'document-1',
      'chapter.txt',
      ['第一章正文'],
      [Array.from({ length: 768 }, (_, index) => index / 768)],
    )

    expect(result).toEqual({
      success: true,
      chunkCount: 1,
    })
  })

  it('2048 维控制组能够写入同一个公共接口', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-control-'))
    projects.push(projectPath)

    const result = await addChunks(
      projectPath,
      'document-control',
      'control.txt',
      ['控制组正文'],
      [Array.from({ length: 2048 }, (_, index) => index / 2048)],
    )

    expect(result).toEqual({
      success: true,
      chunkCount: 1,
    })
  })

  it.each([1024, 1536, 3072])('接受 %d 维有限向量并可通过公共检索接口读取', async (dimension) => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), `ai-novel-vector-${dimension}-`))
    projects.push(projectPath)
    const space = { modelFingerprint: `test/embedding-${dimension}`, distanceMetric: 'l2' }
    const vector = Array.from({ length: dimension }, (_, index) => index / dimension)

    expect(await addChunks(
      projectPath,
      `document-${dimension}`,
      `${dimension}.txt`,
      [`${dimension} 维正文`],
      [vector],
      undefined,
      undefined,
      space,
    )).toEqual({ success: true, chunkCount: 1 })
    await expect(search(projectPath, `${dimension} 维`, vector, 5, space)).resolves.toEqual([
      expect.objectContaining({ fileName: `${dimension}.txt` }),
    ])
    await expect(getEmbeddingSpaces(projectPath)).resolves.toMatchObject({
      spaces: [expect.objectContaining({ vectorDimension: dimension, status: 'active', ...space })],
    })
  })

  it('FTS-only 文档不依赖向量列，仍可导入和检索', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-fts-only-'))
    projects.push(projectPath)

    expect(await addChunks(
      projectPath,
      'fts-document',
      'fts.txt',
      ['全文检索仍然可用'],
    )).toEqual({ success: true, chunkCount: 1 })
    await expect(search(projectPath, '全文检索', undefined, 5)).resolves.toEqual([
      expect.objectContaining({ fileName: 'fts.txt', text: '全文检索仍然可用' }),
    ])
    await expect(getEmbeddingSpaces(projectPath)).resolves.toEqual({ version: 1, activeGeneration: null, spaces: [] })
  })

  it('替换同名文档时清理旧的文档元数据', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-superseded-document-'))
    projects.push(projectPath)

    await expect(addChunks(
      projectPath,
      'old-document',
      'same-name.txt',
      ['旧文档正文'],
    )).resolves.toEqual({ success: true, chunkCount: 1 })
    await expect(addChunks(
      projectPath,
      'new-document',
      'same-name.txt',
      ['新文档正文'],
    )).resolves.toEqual({ success: true, chunkCount: 1 })

    await expect(listDocuments(projectPath)).resolves.toEqual([
      expect.objectContaining({ id: 'new-document', fileName: 'same-name.txt' }),
    ])
  })

  it('删除文档时按驼峰 docId 移除其 chunks', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-remove-document-'))
    projects.push(projectPath)

    await expect(addChunks(
      projectPath,
      'remove-document',
      'remove-me.txt',
      ['待删除的正文'],
    )).resolves.toEqual({ success: true, chunkCount: 1 })
    await expect(removeDocument(projectPath, 'remove-document')).resolves.toBe(true)

    await expect(listDocuments(projectPath)).resolves.toEqual([])
    await expect(getStats(projectPath)).resolves.toMatchObject({ totalChunks: 0 })
    await expect(search(projectPath, '待删除')).resolves.toEqual([])
  })

  it('在大小写敏感的 LanceDB SQL 上按章节范围检索', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-chapter-scope-'))
    projects.push(projectPath)

    await expect(addChunks(
      projectPath,
      'chapter-one',
      'chapter-one.txt',
      ['范围检索共同正文'],
      undefined,
      undefined,
      { chapterNumber: 1 },
    )).resolves.toEqual({ success: true, chunkCount: 1 })
    await expect(addChunks(
      projectPath,
      'chapter-two',
      'chapter-two.txt',
      ['范围检索共同正文'],
      undefined,
      undefined,
      { chapterNumber: 2 },
    )).resolves.toEqual({ success: true, chunkCount: 1 })
    await expect(addChunks(
      projectPath,
      'chapter-two-unmatched',
      'chapter-two-unmatched.txt',
      ['本章不匹配检索条件'],
      undefined,
      undefined,
      { chapterNumber: 2 },
    )).resolves.toEqual({ success: true, chunkCount: 1 })

    await expect(searchWithScope(projectPath, '范围检索', undefined, 5, [2, 2])).resolves.toEqual([
      expect.objectContaining({ fileName: 'chapter-two.txt' }),
    ])
  })

  it('在大小写敏感的 LanceDB SQL 上将向量检索限定在章节范围', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-chapter-scope-vector-'))
    projects.push(projectPath)
    const embeddingSpace = { modelFingerprint: 'test/chapter-scope', distanceMetric: 'l2' }

    await expect(addChunks(
      projectPath,
      'chapter-one-vector',
      'chapter-one-vector.txt',
      ['向量范围检索共同正文'],
      [[1, 0]],
      undefined,
      { chapterNumber: 1 },
      embeddingSpace,
    )).resolves.toEqual({ success: true, chunkCount: 1 })
    await expect(addChunks(
      projectPath,
      'chapter-two-vector',
      'chapter-two-vector.txt',
      ['向量范围检索共同正文'],
      [[0, 1]],
      undefined,
      { chapterNumber: 2 },
      embeddingSpace,
    )).resolves.toEqual({ success: true, chunkCount: 1 })

    await expect(searchWithScope(
      projectPath,
      '向量范围检索',
      [1, 0],
      5,
      [2, 2],
      embeddingSpace,
    )).resolves.toEqual([
      expect.objectContaining({ fileName: 'chapter-two-vector.txt' }),
    ])
  })

  it('安全登记缺少元数据的旧 2048 维 chunks 表并保持可检索', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-legacy-'))
    projects.push(projectPath)
    const legacyVector = Array.from({ length: 2048 }, (_, index) => index / 2048)
    const db = await getConnection(projectPath)
    const legacySchema = new ArrowSchema([
      new Field('id', new Utf8()),
      new Field('docId', new Utf8()),
      new Field('fileName', new Utf8()),
      new Field('chapterNumber', new Int32(), true),
      new Field('chapterTitle', new Utf8(), true),
      new Field('text', new Utf8()),
      new Field('vector', new ArrowFixedSizeList(2048, new Field('item', new Float32())), true),
      new Field('chunkIndex', new Int32()),
      new Field('totalChunks', new Int32()),
      new Field('importedAt', new Utf8()),
    ])
    await db.createTable('chunks', [{
      id: 'legacy-chunk',
      docId: 'legacy-document',
      fileName: 'legacy.txt',
      chapterNumber: null,
      chapterTitle: null,
      text: '旧知识库正文',
      vector: legacyVector,
      chunkIndex: 0,
      totalChunks: 1,
      importedAt: '2026-01-01T00:00:00.000Z',
    }], { schema: legacySchema })

    await expect(getEmbeddingSpaces(projectPath)).resolves.toEqual({
      version: 1,
      activeGeneration: 0,
      spaces: [expect.objectContaining({
        generation: 0,
        tableName: 'chunks',
        modelFingerprint: 'legacy:unknown',
        vectorDimension: 2048,
        status: 'active',
      })],
    })
    await expect(search(projectPath, '旧知识库', legacyVector)).resolves.toEqual([
      expect.objectContaining({ fileName: 'legacy.txt', text: '旧知识库正文' }),
    ])
    expect(await db.tableNames()).toEqual(['chunks'])
  })

  it('旧 vectors.json 按真实 1536 维迁移，而不是回退到固定 2048', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-migration-'))
    projects.push(projectPath)
    const vector = Array.from({ length: 1536 }, (_, index) => index / 1536)
    const velaPath = path.join(projectPath, '.vela')
    fs.mkdirSync(velaPath, { recursive: true })
    const sourcePath = path.join(velaPath, 'vectors.json')
    fs.writeFileSync(sourcePath, JSON.stringify({
      documents: [{
        id: 'legacy-json-document',
        fileName: 'legacy-json.txt',
        importedAt: '2026-01-01T00:00:00.000Z',
        chunkCount: 1,
        filePath: '',
      }],
      entries: [{
        id: 'legacy-json-chunk',
        docId: 'legacy-json-document',
        text: '迁移后的正文',
        vector,
        meta: { fileName: 'legacy-json.txt', chunkIndex: 0, totalChunks: 1 },
      }],
    }), 'utf8')

    expect(await migrateFromJSON(projectPath)).toEqual({ success: true, migrated: 1 })
    expect(fs.existsSync(sourcePath)).toBe(false)
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true)
    await expect(getEmbeddingSpaces(projectPath)).resolves.toMatchObject({
      spaces: [expect.objectContaining({
        modelFingerprint: 'legacy-json',
        vectorDimension: 1536,
        status: 'active',
      })],
    })
    await expect(getStats(projectPath)).resolves.toMatchObject({
      vectorDimension: 1536,
      hasVectors: true,
    })
    await expect(search(projectPath, '迁移后', vector, 5, {
      modelFingerprint: 'legacy-json',
      distanceMetric: 'l2',
    })).resolves.toEqual([
      expect.objectContaining({ fileName: 'legacy-json.txt', text: '迁移后的正文' }),
    ])
  })

  it('迁移遇到不兼容空间时保留原 JSON、旧 active 和旧表', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-migration-failure-'))
    projects.push(projectPath)
    const oldSpace = { modelFingerprint: 'test/migration-old', distanceMetric: 'l2' }
    const oldVector = Array.from({ length: 768 }, (_, index) => index / 768)
    expect(await addChunks(
      projectPath,
      'old-document',
      'old.txt',
      ['仍可读取的旧正文'],
      [oldVector],
      undefined,
      undefined,
      oldSpace,
    )).toEqual({ success: true, chunkCount: 1 })
    const beforeRegistry = await getEmbeddingSpaces(projectPath)
    const db = await getConnection(projectPath)
    const beforeTables = await db.tableNames()
    const sourcePath = path.join(projectPath, '.vela', 'vectors.json')
    fs.writeFileSync(sourcePath, JSON.stringify({
      documents: [],
      entries: [{
        id: 'new-chunk',
        docId: 'new-document',
        text: '不应写入的新正文',
        vector: Array.from({ length: 1024 }, (_, index) => index / 1024),
        meta: { fileName: 'new.txt', chunkIndex: 0, totalChunks: 1 },
      }],
    }), 'utf8')

    await expect(migrateFromJSON(projectPath)).resolves.toMatchObject({
      success: false,
      migrated: 0,
      error: expect.stringMatching(/reindex_required/i),
    })
    expect(fs.existsSync(sourcePath)).toBe(true)
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false)
    expect(await getEmbeddingSpaces(projectPath)).toEqual(beforeRegistry)
    expect(await db.tableNames()).toEqual(beforeTables)
    await expect(search(projectPath, '仍可读取', oldVector, 5, oldSpace)).resolves.toEqual([
      expect.objectContaining({ fileName: 'old.txt', text: '仍可读取的旧正文' }),
    ])
  })

  it('迁移预检发现不兼容的旧 chunks 表时不创建新的嵌入空间注册表', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-migration-preflight-'))
    projects.push(projectPath)
    const db = await getConnection(projectPath)
    const legacyVector = Array.from({ length: 768 }, (_, index) => index / 768)
    const legacySchema = new ArrowSchema([
      new Field('id', new Utf8()),
      new Field('docId', new Utf8()),
      new Field('fileName', new Utf8()),
      new Field('chapterNumber', new Int32(), true),
      new Field('chapterTitle', new Utf8(), true),
      new Field('text', new Utf8()),
      new Field('vector', new ArrowFixedSizeList(768, new Field('item', new Float32())), true),
      new Field('chunkIndex', new Int32()),
      new Field('totalChunks', new Int32()),
      new Field('importedAt', new Utf8()),
    ])
    await db.createTable('chunks', [{
      id: 'old-chunk',
      docId: 'old-document',
      fileName: 'old.txt',
      chapterNumber: null,
      chapterTitle: null,
      text: '不应在预检失败时被改动的旧正文',
      vector: legacyVector,
      chunkIndex: 0,
      totalChunks: 1,
      importedAt: '2026-01-01T00:00:00.000Z',
    }], { schema: legacySchema })
    const velaPath = path.join(projectPath, '.vela')
    const registryPath = path.join(velaPath, 'embedding-spaces.json')
    const sourcePath = path.join(velaPath, 'vectors.json')
    fs.writeFileSync(sourcePath, JSON.stringify({
      documents: [{ id: 'new-document', fileName: 'new.txt' }],
      entries: [{
        id: 'new-chunk',
        docId: 'new-document',
        text: '不应写入的新正文',
        vector: Array.from({ length: 1024 }, (_, index) => index / 1024),
        meta: { fileName: 'new.txt' },
      }],
    }), 'utf8')

    expect(fs.existsSync(registryPath)).toBe(false)
    await expect(migrateFromJSON(projectPath)).resolves.toMatchObject({
      success: false,
      migrated: 0,
      error: expect.stringMatching(/reindex_required/i),
    })
    expect(fs.existsSync(registryPath)).toBe(false)
    expect(fs.existsSync(sourcePath)).toBe(true)
    expect(await db.tableNames()).toEqual(['chunks'])
  })

  it('两份旧 JSON 中后一份非法时不写入前一份，重试与修正后都不会重复迁移', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-migration-atomic-'))
    projects.push(projectPath)
    const velaPath = path.join(projectPath, '.vela')
    fs.mkdirSync(velaPath, { recursive: true })
    const sourcePath = path.join(velaPath, 'vectors.json')
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)
    const source = {
      documents: [
        { id: 'legacy-valid', fileName: 'valid.txt', importedAt: '2026-01-01T00:00:00.000Z', chunkCount: 1, filePath: '' },
        { id: 'legacy-invalid', fileName: 'invalid.txt', importedAt: '2026-01-01T00:00:00.000Z', chunkCount: 1, filePath: '' },
      ],
      entries: [
        {
          id: 'legacy-valid-chunk',
          docId: 'legacy-valid',
          text: '第一份旧正文不能被半迁移',
          vector,
          meta: { fileName: 'valid.txt', chunkIndex: 0, totalChunks: 1 },
        },
        {
          id: 'legacy-invalid-chunk',
          docId: 'legacy-invalid',
          text: '第二份旧正文含有非法向量',
          vector: [...vector.slice(0, 20), null, ...vector.slice(21)],
          meta: { fileName: 'invalid.txt', chunkIndex: 0, totalChunks: 1 },
        },
      ],
    }
    fs.writeFileSync(sourcePath, JSON.stringify(source), 'utf8')

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(migrateFromJSON(projectPath)).resolves.toMatchObject({
        success: false,
        migrated: 0,
        error: expect.stringMatching(/向量|迁移/),
      })
      await expect(listDocuments(projectPath)).resolves.toEqual([])
      const db = await getConnection(projectPath)
      expect(await db.tableNames()).toEqual([])
      expect(fs.existsSync(sourcePath)).toBe(true)
      expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false)
    }

    const repaired = structuredClone(source)
    repaired.entries[1].vector = vector
    fs.writeFileSync(sourcePath, JSON.stringify(repaired), 'utf8')

    await expect(migrateFromJSON(projectPath)).resolves.toEqual({ success: true, migrated: 2 })
    await expect(listDocuments(projectPath)).resolves.toHaveLength(2)
    const db = await getConnection(projectPath)
    expect(await (await db.openTable('chunks')).countRows()).toBe(2)
    const registry = await getEmbeddingSpaces(projectPath)
    const active = registry.spaces.find(space => space.generation === registry.activeGeneration)
    expect(active).toMatchObject({ vectorDimension: 768, status: 'active' })
    expect(await (await db.openTable(active!.tableName)).countRows()).toBe(2)

    await expect(migrateFromJSON(projectPath)).resolves.toEqual({ success: true, migrated: 0 })
    await expect(listDocuments(projectPath)).resolves.toHaveLength(2)
    expect(await (await db.openTable('chunks')).countRows()).toBe(2)
    expect(await (await db.openTable(active!.tableName)).countRows()).toBe(2)
  })

  it('迁移写入后若无法标记原 JSON，会回滚全部文档且修正环境后只迁移一次', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-migration-marker-'))
    projects.push(projectPath)
    const velaPath = path.join(projectPath, '.vela')
    fs.mkdirSync(velaPath, { recursive: true })
    const sourcePath = path.join(velaPath, 'vectors.json')
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)
    fs.writeFileSync(sourcePath, JSON.stringify({
      documents: [
        { id: 'marker-one', fileName: 'marker-one.txt' },
        { id: 'marker-two', fileName: 'marker-two.txt' },
      ],
      entries: [
        { id: 'marker-one-chunk', docId: 'marker-one', text: '第一份必须被回滚', vector, meta: { fileName: 'marker-one.txt' } },
        { id: 'marker-two-chunk', docId: 'marker-two', text: '第二份也必须被回滚', vector, meta: { fileName: 'marker-two.txt' } },
      ],
    }), 'utf8')

    const originalRenameSync = fs.renameSync
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === `${sourcePath}.migrated`) {
        throw new Error('simulated source marker failure')
      }
      return originalRenameSync(from, to)
    })
    await expect(migrateFromJSON(projectPath)).resolves.toMatchObject({
      success: false,
      migrated: 0,
      error: expect.stringMatching(/未能标记原 vectors\.json/),
    })
    renameSpy.mockRestore()

    const db = await getConnection(projectPath)
    expect(await listDocuments(projectPath)).toEqual([])
    expect(await db.tableNames()).toEqual([])
    expect(fs.existsSync(sourcePath)).toBe(true)
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false)
    expect(fs.existsSync(path.join(velaPath, 'vectors.json.migration-journal.json'))).toBe(false)

    await expect(migrateFromJSON(projectPath)).resolves.toEqual({ success: true, migrated: 2 })
    expect(await listDocuments(projectPath)).toHaveLength(2)
    expect(await (await db.openTable('chunks')).countRows()).toBe(2)
    const registry = await getEmbeddingSpaces(projectPath)
    const active = registry.spaces.find(space => space.generation === registry.activeGeneration)
    expect(await (await db.openTable(active!.tableName)).countRows()).toBe(2)
  })

  it('迁移已提交但进程在删除 journal 前退出时，会用已标记源文件安全完成恢复', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-migration-commit-recovery-'))
    projects.push(projectPath)
    const velaPath = path.join(projectPath, '.vela')
    fs.mkdirSync(velaPath, { recursive: true })
    const sourcePath = path.join(velaPath, 'vectors.json')
    const source = {
      documents: [{ id: 'committed-document', fileName: 'committed.txt' }],
      entries: [{
        id: 'committed-chunk',
        docId: 'committed-document',
        text: '已经写入但尚未清理 journal 的正文',
        vector: Array.from({ length: 768 }, (_, index) => index / 768),
        meta: { fileName: 'committed.txt' },
      }],
    }
    const raw = JSON.stringify(source)
    fs.writeFileSync(sourcePath, raw, 'utf8')
    await expect(migrateFromJSON(projectPath)).resolves.toEqual({ success: true, migrated: 1 })

    const journalPath = path.join(velaPath, 'vectors.json.migration-journal.json')
    fs.writeFileSync(journalPath, JSON.stringify({
      version: 1,
      sourceDigest: createHash('sha256').update(raw).digest('hex'),
      docIds: ['committed-document'],
      tableNamesBefore: [],
    }), 'utf8')

    await expect(migrateFromJSON(projectPath)).resolves.toEqual({ success: true, migrated: 0 })
    expect(fs.existsSync(journalPath)).toBe(false)
    expect(await listDocuments(projectPath)).toHaveLength(1)
  })

  it.each([
    ['空向量', [[], Array.from({ length: 768 }, () => 0)]],
    ['缺少一个批次结果', [Array.from({ length: 768 }, () => 0)]],
    ['null 向量', [null, Array.from({ length: 768 }, () => 0)]],
    ['null 元素', [Array.from({ length: 768 }, (_, index) => index === 3 ? null : 0), Array.from({ length: 768 }, () => 0)]],
    ['NaN 元素', [Array.from({ length: 768 }, (_, index) => index === 3 ? Number.NaN : 0), Array.from({ length: 768 }, () => 0)]],
    ['Infinity 元素', [Array.from({ length: 768 }, (_, index) => index === 3 ? Number.POSITIVE_INFINITY : 0), Array.from({ length: 768 }, () => 0)]],
    ['同批次维度不一致', [Array.from({ length: 768 }, () => 0), Array.from({ length: 1024 }, () => 0)]],
  ])('在写入 Arrow 前拒绝%s，并且不留下错误维度的表', async (_label, invalidVectors) => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-invalid-'))
    projects.push(projectPath)

    const invalid = await addChunks(
      projectPath,
      'invalid-document',
      'invalid.txt',
      ['第一块', '第二块'],
      invalidVectors as unknown as number[][],
    )

    expect(invalid.success).toBe(false)
    expect(invalid.error).toMatch(/向量|批次|有限/)
    expect(invalid.error).not.toContain('Arrow')

    const valid = await addChunks(
      projectPath,
      'valid-document',
      'valid.txt',
      ['合法向量'],
      [Array.from({ length: 768 }, (_, index) => index / 768)],
    )

    expect(valid).toEqual({ success: true, chunkCount: 1 })
  })

  it('模型或维度变化要求显式重建，并在拒绝前保持旧代际 active', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-generation-'))
    projects.push(projectPath)
    const oldSpace = { modelFingerprint: 'test/embedding-768', distanceMetric: 'l2' }
    const newSpace = { modelFingerprint: 'test/embedding-1024', distanceMetric: 'l2' }
    const oldVector = Array.from({ length: 768 }, (_, index) => index / 768)
    const newVector = Array.from({ length: 1024 }, (_, index) => index / 1024)

    expect(await addChunks(
      projectPath,
      'old-document',
      'old.txt',
      ['旧代际正文'],
      [oldVector],
      undefined,
      undefined,
      oldSpace,
    )).toEqual({ success: true, chunkCount: 1 })

    const beforeRegistry = await getEmbeddingSpaces(projectPath)
    const db = await getConnection(projectPath)
    const beforeTableNames = await db.tableNames()
    const beforeChunkCount = await (await db.openTable('chunks')).countRows()

    const mismatch = await addChunks(
      projectPath,
      'new-document',
      'new.txt',
      ['新代际正文'],
      [newVector],
      undefined,
      undefined,
      newSpace,
    )

    expect(mismatch).toMatchObject({ success: false, chunkCount: 0, error: expect.stringMatching(/reindex_required/i) })
    const registry = await getEmbeddingSpaces(projectPath)
    const [first] = registry.spaces
    expect(registry).toEqual(beforeRegistry)
    expect(first).toMatchObject({ vectorDimension: 768, status: 'active', ...oldSpace })
    expect(await db.tableNames()).toEqual(beforeTableNames)
    expect(await (await db.openTable('chunks')).countRows()).toBe(beforeChunkCount)

    await expect(search(projectPath, '旧代际', oldVector, 5, oldSpace)).resolves.toEqual([
      expect.objectContaining({ fileName: 'old.txt' }),
    ])
  })

  it('同一维度但不同模型身份同样要求显式重建，不会混写同一表', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-model-conflict-'))
    projects.push(projectPath)
    const oldSpace = { modelFingerprint: 'test/model-a', distanceMetric: 'l2' }
    const newSpace = { modelFingerprint: 'test/model-b', distanceMetric: 'l2' }
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)
    expect(await addChunks(
      projectPath,
      'model-a-document',
      'model-a.txt',
      ['模型 A 正文'],
      [vector],
      undefined,
      undefined,
      oldSpace,
    )).toEqual({ success: true, chunkCount: 1 })
    const before = await getEmbeddingSpaces(projectPath)

    await expect(addChunks(
      projectPath,
      'model-b-document',
      'model-b.txt',
      ['模型 B 正文'],
      [vector],
      undefined,
      undefined,
      newSpace,
    )).resolves.toMatchObject({ success: false, error: expect.stringMatching(/reindex_required/i) })
    expect(await getEmbeddingSpaces(projectPath)).toEqual(before)
    await expect(search(projectPath, '模型 A', vector, 5, oldSpace)).resolves.toEqual([
      expect.objectContaining({ fileName: 'model-a.txt' }),
    ])
  })

  it('显式回填完整验证新空间后才切换 active，旧表仍保留', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-rebuild-'))
    projects.push(projectPath)
    const oldSpace = { modelFingerprint: 'test/embedding-old', distanceMetric: 'l2' }
    const rebuiltSpace = { modelFingerprint: 'test/embedding-rebuilt', distanceMetric: 'l2' }
    const oldVector = Array.from({ length: 768 }, (_, index) => index / 768)

    expect(await addChunks(
      projectPath,
      'document',
      'chapter.txt',
      ['第一块正文', '第二块正文'],
      [oldVector, oldVector],
      undefined,
      undefined,
      oldSpace,
    )).toEqual({ success: true, chunkCount: 2 })

    const before = await getEmbeddingSpaces(projectPath)
    const candidates = await getChunksForBackfill(projectPath, 10, rebuiltSpace)
    expect(candidates).toHaveLength(2)
    const rebuiltVector = Array.from({ length: 1024 }, (_, index) => index / 1024)
    expect(await updateChunkVectors(
      projectPath,
      candidates.map(candidate => ({ id: candidate.id, vector: rebuiltVector })),
      rebuiltSpace,
    )).toEqual({ success: true, count: 2 })

    const after = await getEmbeddingSpaces(projectPath)
    const oldGeneration = after.spaces.find(space => space.generation === before.activeGeneration)!
    const activeGeneration = after.spaces.find(space => space.generation === after.activeGeneration)!
    expect(oldGeneration).toMatchObject({ status: 'inactive', vectorDimension: 768, ...oldSpace })
    expect(activeGeneration).toMatchObject({ status: 'active', vectorDimension: 1024, ...rebuiltSpace })
    expect(activeGeneration.tableName).not.toBe(oldGeneration.tableName)
    expect(await (await getConnection(projectPath)).tableNames()).toEqual(expect.arrayContaining([
      'chunks', oldGeneration.tableName, activeGeneration.tableName,
    ]))
    await expect(search(projectPath, '第一块', rebuiltVector, 5, rebuiltSpace)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName: 'chapter.txt', text: '第一块正文' }),
    ]))
  })

  it('候选空间含孤儿或重复块时不切换 active', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-incomplete-candidate-'))
    projects.push(projectPath)
    const oldSpace = { modelFingerprint: 'test/complete-old', distanceMetric: 'l2' }
    const candidateIdentity = { modelFingerprint: 'test/complete-candidate', distanceMetric: 'l2' }
    const oldVector = Array.from({ length: 768 }, (_, index) => index / 768)
    const candidateVector = Array.from({ length: 1024 }, (_, index) => index / 1024)
    expect(await addChunks(
      projectPath,
      'old-document',
      'old.txt',
      ['旧空间正文'],
      [oldVector],
      undefined,
      undefined,
      oldSpace,
    )).toEqual({ success: true, chunkCount: 1 })

    const db = await getConnection(projectPath)
    const before = await getEmbeddingSpaces(projectPath)
    const canonicalRows = await (await db.openTable('chunks')).query().toArray()
    const candidate = {
      generation: 2,
      tableName: 'chunks__space_2',
      modelFingerprint: candidateIdentity.modelFingerprint,
      vectorDimension: 1024,
      distanceMetric: 'l2',
      status: 'building' as const,
      createdAt: new Date().toISOString(),
    }
    const candidateSchema = new ArrowSchema([
      new Field('id', new Utf8()),
      new Field('docId', new Utf8()),
      new Field('fileName', new Utf8()),
      new Field('chapterNumber', new Int32(), true),
      new Field('chapterTitle', new Utf8(), true),
      new Field('text', new Utf8()),
      new Field('vector', new ArrowFixedSizeList(1024, new Field('item', new Float32())), false),
      new Field('chunkIndex', new Int32()),
      new Field('totalChunks', new Int32()),
      new Field('importedAt', new Utf8()),
    ])
    await db.createTable(candidate.tableName, [
      ...canonicalRows.map(row => ({ ...(row as Record<string, unknown>), vector: candidateVector })),
      {
        id: 'orphan-chunk',
        docId: 'orphan-document',
        fileName: 'orphan.txt',
        chapterNumber: null,
        chapterTitle: null,
        text: '不属于 canonical 的孤儿向量',
        vector: candidateVector,
        chunkIndex: 0,
        totalChunks: 1,
        importedAt: '2026-07-26T00:00:00.000Z',
      },
    ], { schema: candidateSchema })
    fs.writeFileSync(path.join(projectPath, '.vela', 'embedding-spaces.json'), `${JSON.stringify({
      ...before,
      spaces: [...before.spaces, candidate],
    }, null, 2)}\n`, 'utf8')

    const canonicalId = (canonicalRows[0] as { id: string }).id
    await expect(updateChunkVectors(projectPath, [{ id: canonicalId, vector: candidateVector }], candidateIdentity))
      .resolves.toEqual({ success: true, count: 1 })

    const after = await getEmbeddingSpaces(projectPath)
    expect(after.activeGeneration).toBe(before.activeGeneration)
    expect(after.spaces.find(space => space.generation === candidate.generation)).toMatchObject({ status: 'building' })
    expect(await (await db.openTable(candidate.tableName)).countRows()).toBe(3)
  })

  it('catalog 切换落盘失败时补偿本次 docId，旧表、registry、docs 与 canonical 不变', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-rollback-'))
    projects.push(projectPath)
    const space = { modelFingerprint: 'test/rollback', distanceMetric: 'l2' }
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)
    expect(await addChunks(
      projectPath,
      'old-document',
      'old.txt',
      ['旧正文'],
      [vector],
      undefined,
      undefined,
      space,
    )).toEqual({ success: true, chunkCount: 1 })

    const db = await getConnection(projectPath)
    const beforeRegistry = await getEmbeddingSpaces(projectPath)
    const beforeTables = await db.tableNames()
    const beforeCanonicalRows = await (await db.openTable('chunks')).countRows()
    const beforeDocumentRows = await (await db.openTable('documents')).countRows()
    const activeTable = beforeRegistry.spaces.find(item => item.generation === beforeRegistry.activeGeneration)!.tableName
    const beforeVectorRows = await (await db.openTable(activeTable)).countRows()
    const originalRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('embedding-spaces.json')) {
        throw new Error('injected catalog switch failure')
      }
      return originalRename(from, to)
    })

    await expect(addChunks(
      projectPath,
      'new-document',
      'new.txt',
      ['不得遗留的新正文'],
      [vector],
      undefined,
      undefined,
      space,
    )).resolves.toMatchObject({ success: false, chunkCount: 0, error: expect.stringContaining('injected catalog switch failure') })
    vi.restoreAllMocks()

    expect(await getEmbeddingSpaces(projectPath)).toEqual(beforeRegistry)
    expect(await db.tableNames()).toEqual(beforeTables)
    expect(await (await db.openTable('chunks')).countRows()).toBe(beforeCanonicalRows)
    expect(await (await db.openTable('documents')).countRows()).toBe(beforeDocumentRows)
    expect(await (await db.openTable(activeTable)).countRows()).toBe(beforeVectorRows)
    await expect(search(projectPath, '旧正文', vector, 5, space)).resolves.toEqual([
      expect.objectContaining({ fileName: 'old.txt', text: '旧正文' }),
    ])
  })

  it.each([
    ['document info', (db: VectorConnection) => failCreateTableAfterSuccess(db, 'documents', 'injected document info failure')],
    ['canonical append', (db: VectorConnection) => failCreateTableAfterSuccess(db, 'chunks', 'injected canonical append failure')],
    ['final verification', (db: VectorConnection) => failNthTableOpen(db, 'chunks', 2, 'injected final verification failure')],
  ])('首次向量导入在 %s 失败后删除本次新建代际并可复用同一 generation', async (_stage, injectFailure) => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-orphan-first-import-'))
    projects.push(projectPath)
    const db = await getConnection(projectPath)
    const space = { modelFingerprint: 'test/orphan-first-import', distanceMetric: 'l2' }
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)
    injectFailure(db)

    await expect(addChunks(
      projectPath,
      'failed-document',
      'failed.txt',
      ['不得残留的首次导入'],
      [vector],
      undefined,
      undefined,
      space,
    )).resolves.toMatchObject({ success: false, chunkCount: 0 })
    vi.restoreAllMocks()

    const tableNamesAfterFailure = await db.tableNames()
    expect(embeddingTableNames(tableNamesAfterFailure)).toEqual([])
    expect(fs.existsSync(path.join(projectPath, '.vela', 'embedding-spaces.json'))).toBe(false)
    if (tableNamesAfterFailure.includes('documents')) {
      expect(await (await db.openTable('documents')).countRows()).toBe(0)
    }
    if (tableNamesAfterFailure.includes('chunks')) {
      expect(await (await db.openTable('chunks')).countRows()).toBe(0)
    }

    await expect(addChunks(
      projectPath,
      'successful-document',
      'successful.txt',
      ['重试成功正文'],
      [vector],
      undefined,
      undefined,
      space,
    )).resolves.toEqual({ success: true, chunkCount: 1 })
    await expect(getEmbeddingSpaces(projectPath)).resolves.toMatchObject({
      activeGeneration: 1,
      spaces: [expect.objectContaining({ generation: 1, tableName: 'chunks__space_1', status: 'active' })],
    })
  })

  it('createTable 内部创建代际后失败时清理本次表并让重试复用同一 generation', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-create-owned-'))
    projects.push(projectPath)
    const db = await getConnection(projectPath)
    const space = { modelFingerprint: 'test/create-owned', distanceMetric: 'l2' }
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)
    failCreateTableAfterSuccess(db, 'chunks__space_1', 'injected createTable internal failure')

    await expect(addChunks(
      projectPath,
      'failed-document',
      'failed.txt',
      ['不得留下孤儿代际'],
      [vector],
      undefined,
      undefined,
      space,
    )).resolves.toMatchObject({
      success: false,
      chunkCount: 0,
      error: expect.stringContaining('createTable internal failure'),
    })
    vi.restoreAllMocks()

    expect(embeddingTableNames(await db.tableNames())).toEqual([])
    await expect(addChunks(
      projectPath,
      'successful-document',
      'successful.txt',
      ['重试成功正文'],
      [vector],
      undefined,
      undefined,
      space,
    )).resolves.toEqual({ success: true, chunkCount: 1 })
    expect((await getEmbeddingSpaces(projectPath)).spaces).toEqual([
      expect.objectContaining({ generation: 1, tableName: 'chunks__space_1', status: 'active' }),
    ])
  })

  it('安全复用未登记的空物理代际目录，不轮换 generation', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-empty-orphan-'))
    projects.push(projectPath)
    const orphanDirectory = path.join(projectPath, '.vela', 'lancedb', 'chunks__space_1.lance')
    fs.mkdirSync(orphanDirectory, { recursive: true })
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)

    await expect(addChunks(
      projectPath,
      'document',
      'document.txt',
      ['空孤儿目录后的成功正文'],
      [vector],
      undefined,
      undefined,
      { modelFingerprint: 'test/empty-orphan', distanceMetric: 'l2' },
    )).resolves.toEqual({ success: true, chunkCount: 1 })

    expect((await getEmbeddingSpaces(projectPath)).spaces).toEqual([
      expect.objectContaining({ generation: 1, tableName: 'chunks__space_1', status: 'active' }),
    ])
  })

  it('保留未登记的非空物理代际目录并在重试时拒绝覆盖而非继续轮换', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-foreign-orphan-'))
    projects.push(projectPath)
    const orphanDirectory = path.join(projectPath, '.vela', 'lancedb', 'chunks__space_1.lance')
    const markerPath = path.join(orphanDirectory, 'unknown-data')
    fs.mkdirSync(orphanDirectory, { recursive: true })
    fs.writeFileSync(markerPath, 'must-not-delete', 'utf8')
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)

    for (const attempt of [1, 2]) {
      await expect(addChunks(
        projectPath,
        `document-${attempt}`,
        `document-${attempt}.txt`,
        [`不得覆盖的正文 ${attempt}`],
        [vector],
        undefined,
        undefined,
        { modelFingerprint: 'test/foreign-orphan', distanceMetric: 'l2' },
      )).resolves.toMatchObject({
        success: false,
        chunkCount: 0,
        error: expect.stringContaining('存在未登记数据，已拒绝覆盖'),
      })
    }

    expect(fs.readFileSync(markerPath, 'utf8')).toBe('must-not-delete')
    // LanceDB enumerates any `*.lance` directory as a table name even when it
    // is not a valid table. The important invariant is that the foreign
    // directory remains untouched and no new generation is allocated.
    expect(embeddingTableNames(await (await getConnection(projectPath)).tableNames())).toEqual(['chunks__space_1'])
    expect(fs.existsSync(path.join(projectPath, '.vela', 'lancedb', 'chunks__space_2.lance'))).toBe(false)
  })

  it('首次导入 registry 原子写重复失败不堆积孤儿表或跳 generation', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-orphan-registry-'))
    projects.push(projectPath)
    const db = await getConnection(projectPath)
    const space = { modelFingerprint: 'test/orphan-registry', distanceMetric: 'l2' }
    const vector = Array.from({ length: 768 }, (_, index) => index / 768)
    const createTableSpy = vi.spyOn(db, 'createTable')
    const originalRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('embedding-spaces.json')) throw new Error('injected registry persistence failure')
      return originalRename(from, to)
    })

    for (const attempt of [1, 2]) {
      await expect(addChunks(
        projectPath,
        `failed-document-${attempt}`,
        `failed-${attempt}.txt`,
        [`失败正文 ${attempt}`],
        [vector],
        undefined,
        undefined,
        space,
      )).resolves.toMatchObject({ success: false, chunkCount: 0, error: expect.stringContaining('registry persistence failure') })
      const tableNames = await db.tableNames()
      expect(embeddingTableNames(tableNames)).toEqual([])
      expect(await (await db.openTable('documents')).countRows()).toBe(0)
      expect(await (await db.openTable('chunks')).countRows()).toBe(0)
      expect(fs.existsSync(path.join(projectPath, '.vela', 'embedding-spaces.json'))).toBe(false)
    }

    expect(createTableSpy.mock.calls
      .map(call => String(call[0]))
      .filter(tableName => tableName.startsWith('chunks__space_')))
      .toEqual(['chunks__space_1', 'chunks__space_1'])
    vi.restoreAllMocks()

    await expect(addChunks(
      projectPath,
      'successful-document',
      'successful.txt',
      ['最终重试正文'],
      [vector],
      undefined,
      undefined,
      space,
    )).resolves.toEqual({ success: true, chunkCount: 1 })
    expect((await getEmbeddingSpaces(projectPath)).activeGeneration).toBe(1)
  })

  it('updateChunkVectors 新代际 registry 写入重复失败时删除新表并保留旧 active', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-orphan-update-registry-'))
    projects.push(projectPath)
    const oldSpace = { modelFingerprint: 'test/orphan-update-old', distanceMetric: 'l2' }
    const newSpace = { modelFingerprint: 'test/orphan-update-new', distanceMetric: 'l2' }
    const oldVector = Array.from({ length: 768 }, (_, index) => index / 768)
    const newVector = Array.from({ length: 1536 }, (_, index) => index / 1536)
    expect(await addChunks(
      projectPath,
      'document',
      'document.txt',
      ['需要回填的正文'],
      [oldVector],
      undefined,
      undefined,
      oldSpace,
    )).toEqual({ success: true, chunkCount: 1 })

    const db = await getConnection(projectPath)
    const beforeRegistry = await getEmbeddingSpaces(projectPath)
    const beforeTables = (await db.tableNames()).slice().sort()
    const oldActive = beforeRegistry.spaces.find(space => space.generation === beforeRegistry.activeGeneration)!
    const oldVectorRows = await (await db.openTable(oldActive.tableName)).countRows()
    const canonicalRows = await (await db.openTable('chunks')).query().toArray()
    const canonicalId = (canonicalRows[0] as { id: string }).id
    const createTableSpy = vi.spyOn(db, 'createTable')
    const originalRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('embedding-spaces.json')) throw new Error('injected update registry failure')
      return originalRename(from, to)
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(updateChunkVectors(projectPath, [{ id: canonicalId, vector: newVector }], newSpace))
        .resolves.toMatchObject({ success: false, count: 0, error: expect.stringContaining('update registry failure') })
      expect((await db.tableNames()).slice().sort()).toEqual(beforeTables)
      expect(await getEmbeddingSpaces(projectPath)).toEqual(beforeRegistry)
      expect(await (await db.openTable(oldActive.tableName)).countRows()).toBe(oldVectorRows)
      expect(await (await db.openTable('chunks')).countRows()).toBe(canonicalRows.length)
    }

    expect(createTableSpy.mock.calls
      .map(call => String(call[0]))
      .filter(tableName => tableName.startsWith('chunks__space_')))
      .toEqual(['chunks__space_2', 'chunks__space_2'])
    vi.restoreAllMocks()

    await expect(updateChunkVectors(projectPath, [{ id: canonicalId, vector: newVector }], newSpace))
      .resolves.toEqual({ success: true, count: 1 })
    await expect(getEmbeddingSpaces(projectPath)).resolves.toMatchObject({
      activeGeneration: 2,
      spaces: expect.arrayContaining([
        expect.objectContaining({ generation: 1, status: 'inactive' }),
        expect.objectContaining({ generation: 2, tableName: 'chunks__space_2', status: 'active' }),
      ]),
    })
  })

  it('updateChunkVectors 最终验证失败时删除本次新表且重试仍使用同一 generation', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-orphan-update-verify-'))
    projects.push(projectPath)
    const oldSpace = { modelFingerprint: 'test/orphan-verify-old', distanceMetric: 'l2' }
    const newSpace = { modelFingerprint: 'test/orphan-verify-new', distanceMetric: 'l2' }
    const oldVector = Array.from({ length: 768 }, (_, index) => index / 768)
    const newVector = Array.from({ length: 1024 }, (_, index) => index / 1024)
    expect(await addChunks(
      projectPath,
      'document',
      'document.txt',
      ['验证失败正文'],
      [oldVector],
      undefined,
      undefined,
      oldSpace,
    )).toEqual({ success: true, chunkCount: 1 })

    const db = await getConnection(projectPath)
    const beforeRegistry = await getEmbeddingSpaces(projectPath)
    const beforeTables = (await db.tableNames()).slice().sort()
    const canonicalId = ((await (await db.openTable('chunks')).query().select(['id']).toArray())[0] as { id: string }).id
    failNthTableOpen(db, 'chunks__space_2', 2, 'injected update final verification failure')

    await expect(updateChunkVectors(projectPath, [{ id: canonicalId, vector: newVector }], newSpace))
      .resolves.toMatchObject({ success: false, count: 0, error: expect.stringContaining('update final verification failure') })
    vi.restoreAllMocks()
    expect((await db.tableNames()).slice().sort()).toEqual(beforeTables)
    expect(await getEmbeddingSpaces(projectPath)).toEqual(beforeRegistry)

    await expect(updateChunkVectors(projectPath, [{ id: canonicalId, vector: newVector }], newSpace))
      .resolves.toEqual({ success: true, count: 1 })
    expect((await getEmbeddingSpaces(projectPath)).activeGeneration).toBe(2)
  })

  it('updateChunkVectors 对预存 building 空间失败时只回滚本次行，不删除物理表或旧 active', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-vector-orphan-update-existing-'))
    projects.push(projectPath)
    const oldSpace = { modelFingerprint: 'test/orphan-existing-old', distanceMetric: 'l2' }
    const candidateIdentity = { modelFingerprint: 'test/orphan-existing-candidate', distanceMetric: 'l2' }
    const oldVector = Array.from({ length: 768 }, (_, index) => index / 768)
    const candidateVector = Array.from({ length: 1024 }, (_, index) => index / 1024)
    expect(await addChunks(
      projectPath,
      'document',
      'document.txt',
      ['第一块正文', '第二块正文'],
      [oldVector, oldVector],
      undefined,
      undefined,
      oldSpace,
    )).toEqual({ success: true, chunkCount: 2 })

    const db = await getConnection(projectPath)
    const oldRegistry = await getEmbeddingSpaces(projectPath)
    const canonicalRows = await (await db.openTable('chunks')).query().toArray()
    const candidate = {
      generation: 2,
      tableName: 'chunks__space_2',
      modelFingerprint: candidateIdentity.modelFingerprint,
      vectorDimension: 1024,
      distanceMetric: 'l2',
      status: 'building' as const,
      createdAt: new Date().toISOString(),
    }
    const candidateSchema = new ArrowSchema([
      new Field('id', new Utf8()),
      new Field('docId', new Utf8()),
      new Field('fileName', new Utf8()),
      new Field('chapterNumber', new Int32(), true),
      new Field('chapterTitle', new Utf8(), true),
      new Field('text', new Utf8()),
      new Field('vector', new ArrowFixedSizeList(1024, new Field('item', new Float32())), false),
      new Field('chunkIndex', new Int32()),
      new Field('totalChunks', new Int32()),
      new Field('importedAt', new Utf8()),
    ])
    await db.createTable(candidate.tableName, [{
      ...(canonicalRows[0] as Record<string, unknown>),
      vector: candidateVector,
    }], { schema: candidateSchema })
    const registryBeforeUpdate = {
      ...oldRegistry,
      spaces: [...oldRegistry.spaces, candidate],
    }
    fs.writeFileSync(
      path.join(projectPath, '.vela', 'embedding-spaces.json'),
      `${JSON.stringify(registryBeforeUpdate, null, 2)}\n`,
      'utf8',
    )
    const beforeTables = (await db.tableNames()).slice().sort()
    const oldActive = oldRegistry.spaces.find(space => space.generation === oldRegistry.activeGeneration)!
    const oldActiveRows = await (await db.openTable(oldActive.tableName)).countRows()
    const missingId = (canonicalRows[1] as { id: string }).id
    const originalRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('embedding-spaces.json')) throw new Error('injected existing-space registry failure')
      return originalRename(from, to)
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(updateChunkVectors(projectPath, [{ id: missingId, vector: candidateVector }], candidateIdentity))
        .resolves.toMatchObject({ success: false, count: 0, error: expect.stringContaining('existing-space registry failure') })
      expect((await db.tableNames()).slice().sort()).toEqual(beforeTables)
      expect(await (await db.openTable(candidate.tableName)).countRows()).toBe(1)
      expect(await (await db.openTable(oldActive.tableName)).countRows()).toBe(oldActiveRows)
      expect(await getEmbeddingSpaces(projectPath)).toEqual(registryBeforeUpdate)
    }
    vi.restoreAllMocks()

    await expect(updateChunkVectors(projectPath, [{ id: missingId, vector: candidateVector }], candidateIdentity))
      .resolves.toEqual({ success: true, count: 1 })
    expect(await (await db.openTable(candidate.tableName)).countRows()).toBe(2)
    expect((await getEmbeddingSpaces(projectPath)).activeGeneration).toBe(candidate.generation)
  })
})
