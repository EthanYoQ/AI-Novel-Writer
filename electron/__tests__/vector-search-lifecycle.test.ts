import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../test/helpers/canonical-project-fixture'
import { closeConnection, getConnection, search } from '../vector-store'

it.each([false, true])('releases native search tables before the caller can close/remove the project: failure=%s', async failQuery => {
  const base = path.resolve('.runtime/.cache')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'vector-search-lifecycle-'))
  try {
    prepareCanonicalStorageFixture(root)
    const connection = await getConnection(root)
    const seed = await connection.createTable('chunks', [{ id: '合成块', docId: '合成文档', fileName: '合成原稿', text: '铜钥匙藏在旧钟后面。' }])
    seed.close()
    const originalOpen = connection.openTable.bind(connection)
    const closes: ReturnType<typeof vi.spyOn>[] = []
    vi.spyOn(connection, 'openTable').mockImplementation(async (...args) => {
      const table = await originalOpen(...args)
      closes.push(vi.spyOn(table, 'close'))
      if (failQuery) vi.spyOn(table, 'query').mockImplementation(() => { throw new Error('SYNTHETIC_QUERY_FAILURE') })
      return table
    })
    const results = await search(root, '铜钥匙')
    expect(results).toHaveLength(failQuery ? 0 : 1)
    expect(closes).toHaveLength(1)
    expect(closes[0]).toHaveBeenCalledTimes(1)
    closeConnection(root)
    fs.renameSync(root, `${root}-closed`)
    fs.rmSync(`${root}-closed`, { recursive: true, force: true })
  } finally {
    closeConnection(root)
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
