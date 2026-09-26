import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  extractPortableProjectArchive,
  writePortableProjectArchive,
  type PortableArchiveSource,
} from '../portable-project-archive'
import type { PortableProjectManifest, PortableProjectManifestEntry } from '../portable-project-format'

interface RawZipEntry {
  name: string | Buffer
  bytes: Buffer
  flags?: number
  method?: number
  externalAttributes?: number
  versionMadeBy?: number
}

const roots: string[] = []
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function storedZip(entries: RawZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, 'utf8')
    const flags = entry.flags ?? 0x0800
    const method = entry.method ?? 0
    const checksum = crc32(entry.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.bytes.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, entry.bytes)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(entry.versionMadeBy ?? ((3 << 8) | 20), 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(entry.bytes.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(entry.externalAttributes ?? ((0o100600 << 16) >>> 0), 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + entry.bytes.length
  }
  const central = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, central, end])
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-project-archive-'))
  roots.push(root)
  return root
}

function entry(archivePath: string, bytes: Buffer): PortableProjectManifestEntry {
  return { path: archivePath, byteSize: bytes.length, sha256: hash(bytes), disposition: 'author-content' }
}

function manifest(entries: PortableProjectManifestEntry[], overrides: Partial<PortableProjectManifest> = {}): PortableProjectManifest {
  const total = entries.reduce((sum, item) => sum + item.byteSize, 0)
  return {
    formatVersion: 1,
    sourceSchemaVersion: 7,
    originProjectId: 'origin-project',
    snapshotGeneration: 'generation-1',
    createdAt: '2026-09-20T00:00:00.000Z',
    declaredUncompressedBytes: total,
    declaredCompressedBytes: total,
    entries,
    semanticCounts: { chapters: 1 },
    omittedItems: [],
    transferReceiptIds: [],
    historyProjectionIds: [],
    ...overrides,
  }
}

function archiveWith(payloads: Array<{ name: string; bytes: Buffer }>, manifestOverride?: PortableProjectManifest): Buffer {
  const portableManifest = manifestOverride ?? manifest(payloads.map(item => entry(item.name, item.bytes)))
  return storedZip([
    { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(portableManifest)) },
    ...payloads.map(item => ({ ...item })),
  ])
}

function writeArchive(root: string, bytes: Buffer): string {
  const archivePath = path.join(root, 'project.ainovel.zip')
  fs.writeFileSync(archivePath, bytes, { flag: 'wx' })
  return archivePath
}

function stagingParent(root: string, name = 'staging-parent'): string {
  const parent = path.join(root, name)
  fs.mkdirSync(parent)
  return parent
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('portable project archive', () => {
  it('流式写入并解包中文路径，保留大文件字节与hash', async () => {
    const root = temporaryRoot()
    const first = Buffer.from('第一章：雨夜。\nCafé 灯火未熄。', 'utf8')
    const large = Buffer.alloc(6 * 1024 * 1024 + 37, 0x5a)
    const definitions = [entry('正文/第一章.txt', first), entry('assets/大文件.bin', large)]
    const sources: PortableArchiveSource[] = definitions.map((item, index) => {
      const sourcePath = path.join(root, `source-${index}.bin`)
      fs.writeFileSync(sourcePath, index === 0 ? first : large)
      return { entry: item, sourcePath }
    })
    const portableManifest = manifest(definitions)
    const archivePath = path.join(root, 'project.ainovel.zip')
    const syncRead = vi.spyOn(fs, 'readFileSync')
    const asyncRead = vi.spyOn(fs.promises, 'readFile')

    let observedCompleteBeforePublish = false
    const writeReceipt = await writePortableProjectArchive({
      manifest: portableManifest,
      sources,
      targetPath: archivePath,
      __testHooks: {
        beforePublish(temporary, target) {
          observedCompleteBeforePublish = fs.statSync(temporary).size > large.length
          expect(fs.existsSync(target)).toBe(false)
        },
      },
    })
    expect(syncRead).not.toHaveBeenCalled()
    expect(asyncRead).not.toHaveBeenCalled()
    expect(observedCompleteBeforePublish).toBe(true)
    expect(writeReceipt).toMatchObject({ entryCount: 2, payloadBytes: first.length + large.length })
    expect(fs.readdirSync(root).filter(name => name.startsWith('.portable-project-archive-'))).toEqual([])

    const parent = stagingParent(root)
    const restored = await extractPortableProjectArchive({ archivePath, stagingParentPath: parent })
    const staging = restored.stagingPath
    expect(path.dirname(staging)).toBe(parent)
    expect(path.basename(staging)).toMatch(/^\.portable-project-attempt-/u)
    expect(restored.manifest.entries).toEqual(definitions)
    expect(fs.readFileSync(path.join(staging, '正文', '第一章.txt'))).toEqual(first)
    expect(hash(fs.readFileSync(path.join(staging, 'assets', '大文件.bin')))).toBe(hash(large))
  })

  it('目标CREATE_NEW且source hash/size变化不发布半归档', async () => {
    const root = temporaryRoot()
    const bytes = Buffer.from('正文')
    const sourcePath = path.join(root, 'source.txt')
    fs.writeFileSync(sourcePath, bytes)
    const definition = entry('正文/a.txt', bytes)
    const targetPath = path.join(root, 'archive.zip')
    fs.writeFileSync(targetPath, 'existing')
    await expect(writePortableProjectArchive({ manifest: manifest([definition]), sources: [{ entry: definition, sourcePath }], targetPath }))
      .rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_TARGET_EXISTS' })
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('existing')

    fs.unlinkSync(targetPath)
    await expect(writePortableProjectArchive({
      manifest: manifest([definition]), sources: [{ entry: definition, sourcePath }], targetPath,
      __testHooks: { beforePublish(_temporary, target) { fs.writeFileSync(target, 'raced', { flag: 'wx' }) } },
    })).rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_TARGET_EXISTS' })
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('raced')
    expect(fs.readdirSync(root).filter(name => name.startsWith('.portable-project-archive-'))).toEqual([])

    const badTarget = path.join(root, 'bad.zip')
    const wrong = { ...definition, sha256: '0'.repeat(64) }
    await expect(writePortableProjectArchive({ manifest: manifest([wrong]), sources: [{ entry: wrong, sourcePath }], targetPath: badTarget }))
      .rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_SOURCE_CHANGED' })
    expect(fs.existsSync(badTarget)).toBe(false)
  })

  it('拒绝payload hash或size损坏并清理本attempt staging', async () => {
    const root = temporaryRoot()
    const expected = Buffer.from('expected')
    const actual = Buffer.from('corrupt!')
    const definition = entry('正文/a.txt', expected)
    const archivePath = writeArchive(root, archiveWith([{ name: definition.path, bytes: actual }], manifest([definition])))
    const parent = stagingParent(root)
    await expect(extractPortableProjectArchive({ archivePath, stagingParentPath: parent }))
      .rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_INVALID' })
    expect(fs.readdirSync(parent)).toEqual([])
    expect(fs.existsSync(archivePath)).toBe(true)
  })

  it.each([
    ['manifest不首项', () => {
      const payload = Buffer.from('x'), m = manifest([entry('a.txt', payload)])
      return storedZip([{ name: 'a.txt', bytes: payload }, { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(m)) }])
    }],
    ['manifest重复', () => {
      const m = manifest([]), bytes = Buffer.from(JSON.stringify(m))
      return storedZip([{ name: 'manifest.json', bytes }, { name: 'manifest.json', bytes }])
    }],
    ['多余payload', () => archiveWith([{ name: 'extra.txt', bytes: Buffer.from('x') }], manifest([]))],
    ['缺少payload', () => {
      const payload = Buffer.from('x'), m = manifest([entry('missing.txt', payload)])
      return storedZip([{ name: 'manifest.json', bytes: Buffer.from(JSON.stringify(m)) }])
    }],
    ['payload重复', () => {
      const payload = Buffer.from('x'), m = manifest([entry('a.txt', payload)])
      return storedZip([{ name: 'manifest.json', bytes: Buffer.from(JSON.stringify(m)) },
        { name: 'a.txt', bytes: payload }, { name: 'a.txt', bytes: payload }])
    }],
  ])('拒绝%s', async (_label, build) => {
    const root = temporaryRoot()
    await expect(extractPortableProjectArchive({
      archivePath: writeArchive(root, build()),
      stagingParentPath: stagingParent(root),
    })).rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_INVALID' })
  })

  it('拒绝manifest与central payload重排，即使path/size集合相同', async () => {
    const root = temporaryRoot(), first = Buffer.from('a'), second = Buffer.from('b')
    const portableManifest = manifest([entry('a.txt', first), entry('b.txt', second)])
    const archive = storedZip([
      { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(portableManifest)) },
      { name: 'b.txt', bytes: second },
      { name: 'a.txt', bytes: first },
    ])
    await expect(extractPortableProjectArchive({
      archivePath: writeArchive(root, archive), stagingParentPath: stagingParent(root),
    })).rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_INVALID' })
  })

  it.each([
    '../outside.txt', '/absolute.txt', 'C:/absolute.txt', '目录\\file.txt',
  ])('拒绝不安全central路径 %s 且不写attempt外', async unsafe => {
    const root = temporaryRoot()
    const sentinel = path.join(root, 'sentinel.txt')
    fs.writeFileSync(sentinel, 'keep')
    const archive = archiveWith([{ name: unsafe, bytes: Buffer.from('x') }], manifest([]))
    await expect(extractPortableProjectArchive({
      archivePath: writeArchive(root, archive), stagingParentPath: stagingParent(root),
    })).rejects.toBeDefined()
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep')
    expect(fs.existsSync(path.resolve(root, unsafe))).toBe(false)
  })

  it.each([
    ['大小写冲突', ['Assets/a.txt', 'assets/a.txt']],
    ['Unicode NFKC冲突', ['正文/Café.txt', '正文/Café.txt']],
  ])('拒绝%s', async (_label, names) => {
    const root = temporaryRoot(), payload = Buffer.from('x')
    const portableManifest = manifest([entry(names[0]!, payload)])
    const archive = storedZip([{ name: 'manifest.json', bytes: Buffer.from(JSON.stringify(portableManifest)) },
      ...names.map(name => ({ name, bytes: payload }))])
    await expect(extractPortableProjectArchive({
      archivePath: writeArchive(root, archive), stagingParentPath: stagingParent(root),
    })).rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_INVALID' })
  })

  it.each([
    ['symlink entry', { externalAttributes: (0o120777 << 16) >>> 0 }],
    ['DOS reparse entry', { externalAttributes: 0x400, versionMadeBy: 20 }],
    ['encrypted entry', { flags: 0x0801 }],
    ['unsupported compression', { method: 99 }],
    ['invalid UTF-8 name', { name: Buffer.from([0xff, 0xfe]) }],
  ])('拒绝%s的central metadata', async (_label, mutation) => {
    const root = temporaryRoot(), payload = Buffer.from('x')
    const portableManifest = manifest([entry('a.txt', payload)])
    const archive = storedZip([
      { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(portableManifest)) },
      { name: 'a.txt', bytes: payload, ...mutation },
    ])
    await expect(extractPortableProjectArchive({
      archivePath: writeArchive(root, archive), stagingParentPath: stagingParent(root),
    })).rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_INVALID' })
  })

  it('数量/总量门在写staging前拒绝', async () => {
    const root = temporaryRoot(), payload = Buffer.from('1234')
    const archivePath = writeArchive(root, archiveWith([{ name: 'a.txt', bytes: payload }]))
    await expect(extractPortableProjectArchive({ archivePath, stagingParentPath: stagingParent(root, 'count'), limits: { maxEntries: 1 } }))
      .resolves.toBeDefined()
    const sizeParent = stagingParent(root, 'size')
    await expect(extractPortableProjectArchive({ archivePath, stagingParentPath: sizeParent, limits: { maxTotalBytes: 3 } }))
      .rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_LIMIT_EXCEEDED' })
    expect(fs.readdirSync(sizeParent)).toEqual([])
  })

  it('拒绝共享symlink staging parent与symlink source', async () => {
    const root = temporaryRoot(), payload = Buffer.from('x')
    const archivePath = writeArchive(root, archiveWith([{ name: 'a.txt', bytes: payload }]))
    const realParent = stagingParent(root), linkedParent = path.join(root, 'linked-parent')
    try { fs.symlinkSync(realParent, linkedParent, 'junction') } catch { return }
    await expect(extractPortableProjectArchive({ archivePath, stagingParentPath: linkedParent }))
      .rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_SOURCE_UNSAFE' })

    const source = path.join(root, 'source.txt'), link = path.join(root, 'source-link.txt')
    fs.writeFileSync(source, payload)
    fs.symlinkSync(source, link, 'file')
    const definition = entry('a.txt', payload)
    await expect(writePortableProjectArchive({
      manifest: manifest([definition]), sources: [{ entry: definition, sourcePath: link }], targetPath: path.join(root, 'link.zip'),
    })).rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_SOURCE_UNSAFE' })
  })

  it('模块创建不可预测attempt root，绝不把parent内预存同名前缀内容当attempt', async () => {
    const root = temporaryRoot(), payload = Buffer.from('x')
    const archivePath = writeArchive(root, archiveWith([{ name: 'a.txt', bytes: payload }]))
    const parent = stagingParent(root)
    const preexisting = path.join(parent, '.portable-project-attempt-fixed')
    fs.mkdirSync(preexisting)
    fs.writeFileSync(path.join(preexisting, 'owned.txt'), 'keep')
    const result = await extractPortableProjectArchive({ archivePath, stagingParentPath: parent })
    expect(result.stagingPath).not.toBe(preexisting)
    expect(path.dirname(result.stagingPath)).toBe(parent)
    expect(fs.readFileSync(path.join(preexisting, 'owned.txt'), 'utf8')).toBe('keep')
    expect(fs.readFileSync(path.join(result.stagingPath, 'a.txt'))).toEqual(payload)
  })

  it('writer失败时临时文件身份已替换则保留替换对象且final target从未出现', async () => {
    const root = temporaryRoot(), payload = Buffer.from('x')
    const sourcePath = path.join(root, 'source.txt'), targetPath = path.join(root, 'archive.zip')
    fs.writeFileSync(sourcePath, payload)
    const definition = entry('a.txt', payload)
    let temporaryPath = ''
    await expect(writePortableProjectArchive({
      manifest: manifest([definition]),
      sources: [{ entry: definition, sourcePath }],
      targetPath,
      __testHooks: {
        afterTemporaryOpened(temporary) {
          temporaryPath = temporary
          fs.renameSync(temporary, `${temporary}.original`)
          fs.writeFileSync(temporary, 'replacement', { flag: 'wx' })
          throw new Error('injected temporary replacement')
        },
      },
    })).rejects.toThrow('injected temporary replacement')
    expect(fs.existsSync(targetPath)).toBe(false)
    expect(fs.readFileSync(temporaryPath, 'utf8')).toBe('replacement')
    expect(fs.existsSync(`${temporaryPath}.original`)).toBe(true)
  })

  it('失败只逐项清理由本次创建的节点，保留注入的未知文件', async () => {
    const root = temporaryRoot(), payload = Buffer.from('x')
    const archivePath = writeArchive(root, archiveWith([{ name: 'a.txt', bytes: payload }]))
    const parent = stagingParent(root)
    let staging = ''
    await expect(extractPortableProjectArchive({
      archivePath,
      stagingParentPath: parent,
      __testHooks: {
        afterPayloadFileOpened(_target, attemptRoot) {
          staging = attemptRoot
          fs.writeFileSync(path.join(attemptRoot, 'unknown.txt'), 'keep', { flag: 'wx' })
          throw new Error('injected unknown file')
        },
      },
    })).rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_INVALID' })
    expect(fs.readFileSync(path.join(staging, 'unknown.txt'), 'utf8')).toBe('keep')
    expect(fs.existsSync(path.join(staging, 'a.txt'))).toBe(false)
  })

  it('目录身份被替换后在写payload前拒绝，且不递归删除替换目录或未知内容', async () => {
    const root = temporaryRoot(), payload = Buffer.from('secret')
    const archivePath = writeArchive(root, archiveWith([{ name: 'dir/a.txt', bytes: payload }]))
    const parent = stagingParent(root)
    let staging = ''
    await expect(extractPortableProjectArchive({
      archivePath,
      stagingParentPath: parent,
      __testHooks: {
        afterDirectoryCreated(directory) {
          staging = path.dirname(directory)
          const moved = `${directory}-moved`
          fs.renameSync(directory, moved)
          fs.mkdirSync(directory)
          fs.writeFileSync(path.join(directory, 'unknown.txt'), 'keep')
        },
      },
    })).rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_SOURCE_UNSAFE' })
    expect(fs.readFileSync(path.join(staging, 'dir', 'unknown.txt'), 'utf8')).toBe('keep')
    expect(fs.existsSync(path.join(staging, 'dir', 'a.txt'))).toBe(false)
    expect(fs.statSync(path.join(staging, 'dir-moved')).isDirectory()).toBe(true)
  })
})
