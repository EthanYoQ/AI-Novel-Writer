import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../test/helpers/canonical-project-fixture'
import { getProjectDataRoot } from '../services/project-data-locator'
import { closeConnection, listDocuments } from '../vector-store'
import { importText } from '../knowledge-base'
import { createPortableProjectAssetProvider } from '../services/portable-project-assets'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'

const { generateEmbeddings } = vi.hoisted(() => ({ generateEmbeddings: vi.fn() }))
vi.mock('../embedding', () => ({ chunkText: (text: string) => [text], generateEmbeddings }))

const roots: string[] = []
function workspace() {
  fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true })
  const root = fs.mkdtempSync(path.resolve('.runtime/.cache/knowledge-volume-'))
  roots.push(root)
  prepareCanonicalStorageFixture(root)
  return root
}
afterEach(async () => {
  vi.restoreAllMocks()
  generateEmbeddings.mockReset()
  for (const root of roots.splice(0)) {
    closeConnection(root)
    await removeDirectoryWithWindowsRetry(root)
  }
})

const embeddingModel = { provider: 'openai', baseUrl: 'fixture', apiKey: 'fixture' }
const lanceDirectory = (projectPath: string) => path.join(getProjectDataRoot(projectPath), 'lancedb')
const copiesDirectory = (projectPath: string) => path.join(getProjectDataRoot(projectPath), 'knowledge-copies')
const listing = (directory: string) => fs.existsSync(directory) ? fs.readdirSync(directory) : []
const probeLeftovers = (projectPath: string) => [getProjectDataRoot(projectPath), path.join(getProjectDataRoot(projectPath), 'temp')]
  .flatMap(directory => listing(directory).filter(name => name.startsWith('.link-probe-')))

// exFAT、FAT32 卷上建不了硬链接（Windows 报 ERROR_INVALID_FUNCTION，#571）；LanceDB 本地提交靠硬链接，每次都会失败。
function volumeWithoutHardLinks() {
  return vi.spyOn(fs, 'linkSync').mockImplementation(() => {
    throw Object.assign(new Error('EISDIR: illegal operation on a directory, link'), { code: 'EISDIR', errno: -4068 })
  })
}

it('#571 作品所在的卷不支持硬链接：导入前就报登记码，不调检索模型、不留副本和表', async () => {
  const projectPath = workspace()
  generateEmbeddings.mockResolvedValue([[1, 0]])
  volumeWithoutHardLinks()

  expect(await importText('第一章正文', '第1章 雾钟.txt', projectPath, 'openai', embeddingModel))
    .toEqual({ success: false, error: 'KNOWLEDGE_BASE_VOLUME_UNSUPPORTED' })
  expect(generateEmbeddings).not.toHaveBeenCalled()
  expect(listing(copiesDirectory(projectPath))).toEqual([])
  expect(listing(lanceDirectory(projectPath))).toEqual([])
  expect(probeLeftovers(projectPath)).toEqual([])
})

it('#571 能建硬链接的卷照常导入，探测不在作品数据目录留下文件', async () => {
  const projectPath = workspace()
  const result = await importText('第一章正文', '第1章 雾钟.txt', projectPath, 'openai', { provider: 'openai', baseUrl: '', apiKey: '' })

  expect(result).toMatchObject({ success: true, chunkCount: 1 })
  expect(await listDocuments(projectPath)).toEqual([expect.objectContaining({ id: result.docId })])
  expect(probeLeftovers(projectPath)).toEqual([])
})

// macOS 的 msdosfs 没有 link 操作，返回 ENOTSUP（XNU vfs_init.c 的 vn_default_error）。
it('#571 卷报 ENOTSUP 同样判为不支持', async () => {
  const projectPath = workspace()
  vi.spyOn(fs, 'linkSync').mockImplementation(() => {
    throw Object.assign(new Error('ENOTSUP: operation not supported on socket, link'), { code: 'ENOTSUP', errno: -45 })
  })

  expect(await importText('第一章正文', '第1章 雾钟.txt', projectPath, 'openai', embeddingModel))
    .toEqual({ success: false, error: 'KNOWLEDGE_BASE_VOLUME_UNSUPPORTED' })
})

// 只有能证明卷不支持硬链接的码才引导作者搬书；权限、磁盘满、句柄用尽等照常报原因。
// Windows 上 EPERM 来自 ERROR_ACCESS_DENIED（libuv win/error.c），是权限问题。
it.each([
  ['EPERM', 'operation not permitted'],
  ['EACCES', 'permission denied'],
  ['ENOSPC', 'no space left on device'],
  ['EMFILE', 'too many open files'],
])('#571 建硬链接报 %s：照常报原因，不说成磁盘不支持', async (code, message) => {
  const projectPath = workspace()
  vi.spyOn(fs, 'linkSync').mockImplementation(() => {
    throw Object.assign(new Error(`${code}: ${message}, link`), { code })
  })

  const result = await importText('第一章正文', '第1章 雾钟.txt', projectPath, 'openai', embeddingModel)
  expect(result).toMatchObject({ success: false })
  expect(result.error).toMatch(new RegExp(code, 'u'))
  expect(probeLeftovers(projectPath)).toEqual([])
})

it('#571 探测文件写不进去（只读卷、磁盘满）：照常报原因，不说成磁盘不支持', async () => {
  const projectPath = workspace()
  const write = fs.writeFileSync.bind(fs)
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
    if (String(file).includes('.link-probe-')) throw Object.assign(new Error('EROFS: read-only file system, open'), { code: 'EROFS' })
    return write(file, ...rest as [never])
  })

  const result = await importText('第一章正文', '第1章 雾钟.txt', projectPath, 'openai', embeddingModel)
  expect(result).toMatchObject({ success: false })
  expect(result.error).toMatch(/EROFS/u)
  expect(generateEmbeddings).not.toHaveBeenCalled()
})

it('#571 探测文件删不掉（例如杀毒软件占着）时，作品照样能导出备份', async () => {
  const projectPath = workspace()
  const unlink = fs.unlinkSync.bind(fs)
  vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (String(file).includes('.link-probe-')) throw Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' })
    unlink(file)
  })

  expect(await importText('第一章正文', '第1章 雾钟.txt', projectPath, 'openai', { provider: 'openai', baseUrl: '', apiKey: '' })).toMatchObject({ success: true })
  vi.restoreAllMocks()
  await expect(createPortableProjectAssetProvider().snapshot({ sourceProjectRoot: projectPath } as never)).resolves.toMatchObject({ files: expect.any(Array) })
})
