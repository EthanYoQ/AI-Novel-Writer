import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../test/helpers/canonical-project-fixture'
import { Index, openLanceDatabase } from '../lance-database'
import { addChunks, closeConnection } from '../vector-store'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'

/**
 * Lance 数据文件末 8 字节是 major(u16 LE)、minor(u16 LE)、'LANC'。
 * 2.0 格式按历史编号写成 0.3（legacy 是 0.2，2.1 起写作 2.1），0.22.3 实测如此。
 */
const LANCE_2_0_FOOTER = '0.3'
const FIXTURE_ROOT = path.resolve('scripts/fixtures/s14c-official-old-sources')

const roots: string[] = []
const projects: string[] = []

beforeAll(() => { fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true }) })

afterEach(async () => {
  for (const projectPath of projects) closeConnection(projectPath)
  for (const root of [...roots.splice(0), ...projects.splice(0)]) await removeDirectoryWithWindowsRetry(root)
})

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(path.resolve('.runtime/.cache'), prefix))
  roots.push(root)
  return root
}

function dataFileFooters(databaseDirectory: string): string[] {
  const footers: string[] = []
  for (const table of fs.readdirSync(databaseDirectory)) {
    const dataDirectory = path.join(databaseDirectory, table, 'data')
    if (!fs.existsSync(dataDirectory)) continue
    for (const file of fs.readdirSync(dataDirectory)) {
      const bytes = fs.readFileSync(path.join(dataDirectory, file))
      expect(bytes.subarray(bytes.length - 4).toString('latin1')).toBe('LANC')
      footers.push(`${bytes.readUInt16LE(bytes.length - 8)}.${bytes.readUInt16LE(bytes.length - 6)}`)
    }
  }
  return footers
}

describe('LanceDB 契约', () => {
  it('经入口新建的表按 2.0 数据格式落盘', async () => {
    const directory = tempRoot('lance-contract-format-')
    const db = await openLanceDatabase(directory)
    const table = await db.createTable('pinned', [{ id: 'a', vector: [0.1, 0.2, 0.3, 0.4] }])
    await table.add([{ id: 'b', vector: [0.4, 0.3, 0.2, 0.1] }])
    table.close()
    db.close()

    const footers = dataFileFooters(directory)
    expect(footers.length).toBe(2)
    expect(new Set(footers)).toEqual(new Set([LANCE_2_0_FOOTER]))
  })

  it('知识库导入建出的表也按 2.0 数据格式落盘', async () => {
    const projectPath = fs.mkdtempSync(path.join(path.resolve('.runtime/.cache'), 'lance-contract-project-'))
    projects.push(projectPath)
    prepareCanonicalStorageFixture(projectPath)

    expect(await addChunks(projectPath, 'doc-1', 'chapter.txt', ['第一段', '第二段'], [[1, 0, 0], [0, 1, 0]]))
      .toEqual({ success: true, chunkCount: 2 })

    const directory = path.join(projectPath, '.ai-novel', 'lancedb')
    const tables = fs.readdirSync(directory).filter(name => name.endsWith('.lance'))
    expect(tables).toEqual(expect.arrayContaining(['chunks.lance', 'documents.lance']))
    expect(tables.some(name => name.startsWith('chunks__space_'))).toBe(true)
    expect(new Set(dataFileFooters(directory))).toEqual(new Set([LANCE_2_0_FOOTER]))
  })

  it('应用用到的 API 子集在真实 LanceDB 上按约定工作', async () => {
    const directory = tempRoot('lance-contract-api-')
    const db = await openLanceDatabase(directory)
    expect(db.isOpen()).toBe(true)
    const table = await db.createTable('chunks', [
      { id: 'c1', docId: 'd1', text: '旧港档案', vector: [1, 0, 0] },
      { id: 'c2', docId: 'd2', text: "林'某的信", vector: [0, 1, 0] },
    ])
    expect(await db.tableNames()).toEqual(['chunks'])
    expect((await table.schema()).fields.map(field => field.name)).toEqual(['id', 'docId', 'text', 'vector'])
    expect(await table.countRows()).toBe(2)

    const initialVersion = await table.version()
    await table.add([{ id: 'c3', docId: 'd1', text: '第三段', vector: [0, 0, 1] }])
    expect(await table.countRows("`docId` = 'd1'")).toBe(2)

    const selected = await table.query().filter("`docId` = 'd2'").select(['id', 'text']).limit(5).toArray()
    expect(selected.map(row => ({ ...row }))).toEqual([{ id: 'c2', text: "林'某的信" }])
    expect((await table.query().where("text LIKE '%旧港%'").toArray()).map(row => row.id)).toEqual(['c1'])
    expect((await table.query().toArrow()).numRows).toBe(3)

    const hits = await table.search([0.9, 0.1, 0]).where("`docId` = 'd1'").limit(1).toArray()
    expect(hits.map(row => row.id)).toEqual(['c1'])

    await table.update({ where: "id = 'c3'", values: { text: '改过的第三段' } })
    expect((await table.query().filter("id = 'c3'").toArray())[0].text).toBe('改过的第三段')

    await table.mergeInsert('id').whenNotMatchedInsertAll()
      .whenNotMatchedBySourceDelete({ where: "`docId` = 'd1'" })
      .execute([{ id: 'c4', docId: 'd1', text: '合并插入', vector: [0, 0, 1] }])
    expect((await table.query().toArray()).map(row => row.id).sort()).toEqual(['c2', 'c4'])

    await table.delete("id = 'c2'")
    expect(await table.countRows()).toBe(1)

    await table.addColumns([{ name: 'corpusKind', valueSql: "'unknown'" }])
    expect((await table.query().toArray())[0].corpusKind).toBe('unknown')
    await table.createIndex('text', { config: Index.fts() })
    expect((await table.listIndices()).map(index => index.columns)).toEqual([['text']])

    await table.checkout(initialVersion)
    expect(await table.countRows()).toBe(2)
    await table.restore()
    await table.checkoutLatest()
    expect((await table.query().toArray()).map(row => row.id).sort()).toEqual(['c1', 'c2'])

    table.close()
    const reopened = await db.openTable('chunks')
    expect(await reopened.countRows()).toBe(2)
    reopened.close()
    await db.dropTable('chunks')
    expect(await db.tableNames()).toEqual([])
    db.close()
    expect(db.isOpen()).toBe(false)
  })

  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8')) as {
    cases: Array<{ version: string; directory: string; files: Record<string, string> }>
  }
  it.each(manifest.cases)('读得出官方 v$version 旧作品的知识库', async ({ directory: caseDirectory, files }) => {
    const expectedTables = [...new Set(Object.keys(files)
      .map(file => /^\.vela\/lancedb\/([^/]+)\.lance\//.exec(file)?.[1])
      .filter((name): name is string => Boolean(name)))].sort()
    const directory = path.join(tempRoot('lance-contract-fixture-'), 'lancedb')
    fs.cpSync(path.join(FIXTURE_ROOT, caseDirectory, '.vela', 'lancedb'), directory, { recursive: true })

    const db = await openLanceDatabase(directory)
    try {
      expect((await db.tableNames()).sort()).toEqual(expectedTables)
      const documents = await db.openTable('documents')
      const chunks = await db.openTable('chunks')
      const documentRows = await documents.query().toArray()
      expect(documentRows.length).toBeGreaterThan(0)
      for (const document of documentRows) {
        const owned = await chunks.query().filter(`\`docId\` = '${String(document.id).replace(/'/g, "''")}'`).toArray()
        expect(owned.length).toBe(document.chunkCount)
        expect(new Set(owned.map(row => row.fileName))).toEqual(new Set([document.fileName]))
      }
      documents.close()
      chunks.close()
    } finally {
      db.close()
    }
  })
})
