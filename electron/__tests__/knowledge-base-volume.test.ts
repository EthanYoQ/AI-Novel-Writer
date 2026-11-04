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

it('#571 磁盘满等临时故障建不了硬链接：照常报原因，不说成磁盘不支持', async () => {
  const projectPath = workspace()
  vi.spyOn(fs, 'linkSync').mockImplementation(() => {
    throw Object.assign(new Error('ENOSPC: no space left on device, link'), { code: 'ENOSPC', errno: -4055 })
  })

  const result = await importText('第一章正文', '第1章 雾钟.txt', projectPath, 'openai', embeddingModel)
  expect(result).toMatchObject({ success: false })
  expect(result.error).toMatch(/ENOSPC/u)
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
