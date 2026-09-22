import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import * as yauzl from 'yauzl'

import {
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
  parsePortableProjectManifest,
  portablePathKey,
  type PortableArchiveLimits,
  type PortableProjectManifest,
  type PortableProjectManifestEntry,
} from './portable-project-format'

export type PortableProjectArchiveErrorCode =
  | 'PORTABLE_ARCHIVE_INVALID'
  | 'PORTABLE_ARCHIVE_LIMIT_EXCEEDED'
  | 'PORTABLE_ARCHIVE_SOURCE_CHANGED'
  | 'PORTABLE_ARCHIVE_SOURCE_UNSAFE'
  | 'PORTABLE_ARCHIVE_PUBLISH_UNSUPPORTED'
  | 'PORTABLE_ARCHIVE_TARGET_EXISTS'

export class PortableProjectArchiveError extends Error {
  constructor(readonly code: PortableProjectArchiveErrorCode) {
    super(code)
    this.name = 'PortableProjectArchiveError'
  }
}

export interface PortableArchiveSource {
  entry: PortableProjectManifestEntry
  sourcePath: string
}

export interface PortableArchiveReceipt {
  entryCount: number
  payloadBytes: number
  archiveBytes: number
  manifestSha256: string
}

export interface WritePortableProjectArchiveInput {
  manifest: PortableProjectManifest
  sources: readonly PortableArchiveSource[]
  targetPath: string
  limits?: Partial<PortableArchiveLimits>
  /** @internal Deterministic race injection for trust-boundary tests. */
  __testHooks?: {
    afterTemporaryOpened?(temporaryPath: string, targetPath: string): void
    beforePublish?(temporaryPath: string, targetPath: string): void
  }
}

export interface ExtractPortableProjectArchiveInput {
  archivePath: string
  /** Existing app-owned private directory. It must not be a user-writable shared directory. */
  stagingParentPath: string
  limits?: Partial<PortableArchiveLimits>
  /** @internal Deterministic race injection for trust-boundary tests. */
  __testHooks?: {
    afterDirectoryCreated?(directoryPath: string): void
    afterPayloadFileOpened?(filePath: string, stagingRoot: string): void
  }
}

export interface ExtractPortableProjectArchiveResult {
  manifest: PortableProjectManifest
  receipt: PortableArchiveReceipt
  stagingPath: string
}

const MANIFEST_PATH = 'manifest.json'
const ZIP_LOCAL = 0x04034b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_END = 0x06054b50
const ZIP64_END = 0x06064b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_EXTRA = 0x0001
const UTF8_FLAG = 0x0800
const DATA_DESCRIPTOR_FLAG = 0x0008
const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffffffff
const UNIX_REGULAR_MODE = 0o100600
const COPY_CHUNK_BYTES = 1024 * 1024

interface CentralRecord {
  name: Buffer
  crc32: number
  size: number
  offset: number
  dataDescriptor: boolean
}

interface OwnedStagingPath {
  path: string
  kind: 'file' | 'directory'
  identity: fs.BigIntStats
}

interface StagingAttempt {
  root: string
  directories: Map<string, fs.BigIntStats>
  created: OwnedStagingPath[]
}

type RawEntry = yauzl.Entry & { fileName: Buffer; fileComment: Buffer }

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  CRC_TABLE[index] = value >>> 0
}

function fail(code: PortableProjectArchiveErrorCode): never {
  throw new PortableProjectArchiveError(code)
}

function resolvedLimits(input?: Partial<PortableArchiveLimits>): PortableArchiveLimits {
  const resolved = { ...DEFAULT_PORTABLE_ARCHIVE_LIMITS, ...input }
  if (Object.values(resolved).some(value => !Number.isSafeInteger(value) || value <= 0)) {
    fail('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
  }
  return resolved
}

function updateCrc(crc: number, bytes: Buffer): number {
  let value = crc
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff]!
  return value
}

function crc32(bytes: Buffer): number {
  return (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0
}

function writeUInt64(buffer: Buffer, value: number, offset: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
  buffer.writeBigUInt64LE(BigInt(value), offset)
}

async function writeAll(handle: fs.promises.FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, null)
    if (result.bytesWritten === 0) fail('PORTABLE_ARCHIVE_INVALID')
    offset += result.bytesWritten
  }
}

function localHeader(name: Buffer, size: number, crc: number | null): Buffer {
  const zip64 = size >= UINT32_MAX
  const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0)
  if (zip64) {
    extra.writeUInt16LE(ZIP64_EXTRA, 0)
    extra.writeUInt16LE(16, 2)
    writeUInt64(extra, size, 4)
    writeUInt64(extra, size, 12)
  }
  const header = Buffer.alloc(30)
  header.writeUInt32LE(ZIP_LOCAL, 0)
  header.writeUInt16LE(zip64 ? 45 : 20, 4)
  header.writeUInt16LE(UTF8_FLAG | (crc === null ? DATA_DESCRIPTOR_FLAG : 0), 6)
  header.writeUInt16LE(0, 8)
  if (crc !== null) header.writeUInt32LE(crc, 14)
  header.writeUInt32LE(zip64 ? UINT32_MAX : crc === null ? 0 : size, 18)
  header.writeUInt32LE(zip64 ? UINT32_MAX : crc === null ? 0 : size, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(extra.length, 28)
  return Buffer.concat([header, name, extra])
}

function dataDescriptor(size: number, checksum: number): Buffer {
  const descriptor = Buffer.alloc(size >= UINT32_MAX ? 24 : 16)
  descriptor.writeUInt32LE(0x08074b50, 0)
  descriptor.writeUInt32LE(checksum, 4)
  if (size >= UINT32_MAX) {
    writeUInt64(descriptor, size, 8)
    writeUInt64(descriptor, size, 16)
  } else {
    descriptor.writeUInt32LE(size, 8)
    descriptor.writeUInt32LE(size, 12)
  }
  return descriptor
}

function centralHeader(record: CentralRecord): Buffer {
  const largeSize = record.size >= UINT32_MAX
  const largeOffset = record.offset >= UINT32_MAX
  const extraData = Buffer.alloc((largeSize ? 16 : 0) + (largeOffset ? 8 : 0))
  let cursor = 0
  if (largeSize) {
    writeUInt64(extraData, record.size, cursor); cursor += 8
    writeUInt64(extraData, record.size, cursor); cursor += 8
  }
  if (largeOffset) writeUInt64(extraData, record.offset, cursor)
  const extra = extraData.length ? Buffer.concat([Buffer.from([1, 0, extraData.length, 0]), extraData]) : extraData
  const header = Buffer.alloc(46)
  header.writeUInt32LE(ZIP_CENTRAL, 0)
  header.writeUInt16LE((3 << 8) | (extra.length ? 45 : 20), 4)
  header.writeUInt16LE(extra.length ? 45 : 20, 6)
  header.writeUInt16LE(UTF8_FLAG | (record.dataDescriptor ? DATA_DESCRIPTOR_FLAG : 0), 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt32LE(record.crc32, 16)
  header.writeUInt32LE(largeSize ? UINT32_MAX : record.size, 20)
  header.writeUInt32LE(largeSize ? UINT32_MAX : record.size, 24)
  header.writeUInt16LE(record.name.length, 28)
  header.writeUInt16LE(extra.length, 30)
  header.writeUInt32LE((UNIX_REGULAR_MODE << 16) >>> 0, 38)
  header.writeUInt32LE(largeOffset ? UINT32_MAX : record.offset, 42)
  return Buffer.concat([header, record.name, extra])
}

function zipEnd(entryCount: number, centralSize: number, centralOffset: number, forceZip64: boolean): Buffer {
  const zip64 = forceZip64 || entryCount >= UINT16_MAX || centralSize >= UINT32_MAX || centralOffset >= UINT32_MAX
  const end = Buffer.alloc(22)
  end.writeUInt32LE(ZIP_END, 0)
  end.writeUInt16LE(zip64 ? UINT16_MAX : entryCount, 8)
  end.writeUInt16LE(zip64 ? UINT16_MAX : entryCount, 10)
  end.writeUInt32LE(zip64 ? UINT32_MAX : centralSize, 12)
  end.writeUInt32LE(zip64 ? UINT32_MAX : centralOffset, 16)
  if (!zip64) return end

  const zip64End = Buffer.alloc(56)
  zip64End.writeUInt32LE(ZIP64_END, 0)
  writeUInt64(zip64End, 44, 4)
  zip64End.writeUInt16LE(45, 12)
  zip64End.writeUInt16LE(45, 14)
  writeUInt64(zip64End, entryCount, 24)
  writeUInt64(zip64End, entryCount, 32)
  writeUInt64(zip64End, centralSize, 40)
  writeUInt64(zip64End, centralOffset, 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(ZIP64_LOCATOR, 0)
  writeUInt64(locator, centralOffset + centralSize, 8)
  locator.writeUInt32LE(1, 16)
  return Buffer.concat([zip64End, locator, end])
}

function sameEntry(left: PortableProjectManifestEntry, right: PortableProjectManifestEntry): boolean {
  return left.path === right.path && left.byteSize === right.byteSize
    && left.sha256 === right.sha256 && left.disposition === right.disposition
}

function normalizeRealPath(value: string): string {
  const normalized = path.normalize(value).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function assertRegularSource(sourcePath: string): fs.BigIntStats {
  const absolute = path.resolve(sourcePath)
  let info: fs.BigIntStats
  try {
    info = fs.lstatSync(absolute, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink()
      || normalizeRealPath(fs.realpathSync.native(absolute)) !== normalizeRealPath(absolute)) {
      fail('PORTABLE_ARCHIVE_SOURCE_UNSAFE')
    }
  } catch (error) {
    if (error instanceof PortableProjectArchiveError) throw error
    fail('PORTABLE_ARCHIVE_SOURCE_UNSAFE')
  }
  return info
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function sameObject(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function decodeEntryName(entry: RawEntry, maxPathBytes: number): string {
  if ((entry.generalPurposeBitFlag & UTF8_FLAG) === 0 || entry.fileName.length === 0
    || entry.fileName.length > maxPathBytes) fail('PORTABLE_ARCHIVE_INVALID')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(entry.fileName) }
  catch { fail('PORTABLE_ARCHIVE_INVALID') }
}

function assertEntryMetadata(entry: RawEntry): void {
  if (entry.isEncrypted() || entry.compressionMethod !== 0
    || (entry.generalPurposeBitFlag & ~(UTF8_FLAG | DATA_DESCRIPTOR_FLAG)) !== 0
    || entry.fileComment.length !== 0 || entry.internalFileAttributes !== 0) {
    fail('PORTABLE_ARCHIVE_INVALID')
  }
  const creator = entry.versionMadeBy >>> 8
  const unixType = (entry.externalFileAttributes >>> 16) & 0xf000
  if ((entry.externalFileAttributes & 0x10) !== 0 || (entry.externalFileAttributes & 0x400) !== 0
    || (creator === 3 && unixType !== 0x8000)) {
    fail('PORTABLE_ARCHIVE_INVALID')
  }
  const expectedZip64Bytes = (entry.uncompressedSize >= UINT32_MAX ? 8 : 0)
    + (entry.compressedSize >= UINT32_MAX ? 8 : 0)
    + (entry.relativeOffsetOfLocalHeader >= UINT32_MAX ? 8 : 0)
  if (entry.versionNeededToExtract > 45 || entry.extraFields.length !== (expectedZip64Bytes ? 1 : 0)
    || (expectedZip64Bytes > 0 && (entry.extraFields[0]?.id !== ZIP64_EXTRA
      || entry.extraFields[0].data.length !== expectedZip64Bytes))) {
    fail('PORTABLE_ARCHIVE_INVALID')
  }
}

class FileArchiveReader extends yauzl.RandomAccessReader {
  constructor(private readonly descriptor: number) { super() }

  _readStreamForRange(start: number, end: number): Readable {
    const descriptor = this.descriptor
    return Readable.from((async function* () {
      let position = start
      while (position < end) {
        const chunk = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, end - position))
        const bytesRead = await new Promise<number>((resolve, reject) => {
          fs.read(descriptor, chunk, 0, chunk.length, position, (error, count) => error ? reject(error) : resolve(count))
        })
        if (bytesRead === 0) return
        position += bytesRead
        yield chunk.subarray(0, bytesRead)
      }
    })())
  }

  close(callback: (error: Error | null) => void): void { setImmediate(callback, null) }
}

function openArchive(descriptor: number, size: number): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromRandomAccessReader(new FileArchiveReader(descriptor), size, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: false,
      validateEntrySizes: true,
    }, (error, zip) => error || !zip ? reject(error ?? new Error('missing zip')) : resolve(zip))
  })
}

function indexArchive(zip: yauzl.ZipFile, limits: PortableArchiveLimits): Promise<Array<{ name: string; entry: RawEntry }>> {
  return new Promise((resolve, reject) => {
    const indexed: Array<{ name: string; entry: RawEntry }> = []
    const failIndex = () => { zip.close(); reject(new PortableProjectArchiveError('PORTABLE_ARCHIVE_INVALID')) }
    zip.once('error', failIndex)
    zip.on('entry', raw => {
      try {
        if (indexed.length >= limits.maxEntries + 1) fail('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
        const entry = raw as RawEntry
        assertEntryMetadata(entry)
        const name = decodeEntryName(entry, limits.maxPathBytes)
        if (name.endsWith('/')) fail('PORTABLE_ARCHIVE_INVALID')
        indexed.push({ name, entry })
        zip.readEntry()
      } catch (error) {
        zip.close()
        reject(error)
      }
    })
    zip.once('end', () => {
      zip.removeListener('error', failIndex)
      resolve(indexed)
    })
    zip.readEntry()
  })
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error || !stream
      ? reject(new PortableProjectArchiveError('PORTABLE_ARCHIVE_INVALID')) : resolve(stream))
  })
}

async function readManifest(zip: yauzl.ZipFile, entry: RawEntry, limits: PortableArchiveLimits): Promise<Buffer> {
  if (entry.uncompressedSize > limits.maxEntryBytes) fail('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
  const stream = await openEntry(zip, entry)
  const chunks: Buffer[] = []
  let bytesRead = 0
  let crc = 0xffffffff
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    bytesRead += chunk.length
    if (bytesRead > entry.uncompressedSize || bytesRead > limits.maxEntryBytes) {
      stream.destroy(); fail('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    }
    crc = updateCrc(crc, chunk)
    chunks.push(chunk)
  }
  if (bytesRead !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
    fail('PORTABLE_ARCHIVE_INVALID')
  }
  return Buffer.concat(chunks, bytesRead)
}

function safeDirectory(directory: string): void {
  const absolute = path.resolve(directory)
  let cursor = path.parse(absolute).root
  for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const info = fs.lstatSync(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()
      || normalizeRealPath(fs.realpathSync.native(cursor)) !== normalizeRealPath(cursor)) {
      fail('PORTABLE_ARCHIVE_SOURCE_UNSAFE')
    }
  }
}

function assertAttemptDirectory(attempt: StagingAttempt, directory: string): void {
  const relative = path.relative(attempt.root, directory)
  if (!contained(attempt.root, directory)) fail('PORTABLE_ARCHIVE_SOURCE_UNSAFE')
  let cursor = attempt.root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const expected = attempt.directories.get(cursor)
    if (!expected) fail('PORTABLE_ARCHIVE_SOURCE_UNSAFE')
    const actual = fs.lstatSync(cursor, { bigint: true })
    if (!actual.isDirectory() || actual.isSymbolicLink() || !sameObject(expected, actual)) {
      fail('PORTABLE_ARCHIVE_SOURCE_UNSAFE')
    }
  }
  const rootExpected = attempt.directories.get(attempt.root)
  const rootActual = fs.lstatSync(attempt.root, { bigint: true })
  if (!rootExpected || !rootActual.isDirectory() || rootActual.isSymbolicLink()
    || !sameObject(rootExpected, rootActual)
    || normalizeRealPath(fs.realpathSync.native(attempt.root)) !== normalizeRealPath(attempt.root)
    || !contained(fs.realpathSync.native(attempt.root), fs.realpathSync.native(directory))) {
    fail('PORTABLE_ARCHIVE_SOURCE_UNSAFE')
  }
}

function prepareStaging(stagingParentPath: string): StagingAttempt {
  const parent = path.resolve(stagingParentPath)
  safeDirectory(parent)
  // Security depends on this parent being application-owned and private. Random naming prevents
  // pre-existing user content from ever becoming this attempt; it is not a defence from a same-privilege hostile process.
  const root = fs.mkdtempSync(path.join(parent, '.portable-project-attempt-'))
  fs.chmodSync(root, 0o700)
  const identity = fs.lstatSync(root, { bigint: true })
  const attempt: StagingAttempt = {
    root,
    directories: new Map([[root, identity]]),
    created: [{ path: root, kind: 'directory', identity }],
  }
  assertAttemptDirectory(attempt, root)
  return attempt
}

function targetFor(attempt: StagingAttempt, archivePath: string, hook?: (directoryPath: string) => void): string {
  let directory = attempt.root
  const segments = archivePath.split('/')
  for (const segment of segments.slice(0, -1)) {
    assertAttemptDirectory(attempt, directory)
    directory = path.join(directory, segment)
    if (!attempt.directories.has(directory)) {
      try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('PORTABLE_ARCHIVE_TARGET_EXISTS')
        throw error
      }
      const identity = fs.lstatSync(directory, { bigint: true })
      attempt.directories.set(directory, identity)
      attempt.created.push({ path: directory, kind: 'directory', identity })
      hook?.(directory)
    }
    assertAttemptDirectory(attempt, directory)
  }
  return path.join(directory, segments.at(-1)!)
}

async function assertOwnedOpenFile(
  attempt: StagingAttempt,
  target: string,
  handle: fs.promises.FileHandle,
): Promise<fs.BigIntStats> {
  assertAttemptDirectory(attempt, path.dirname(target))
  const opened = await handle.stat({ bigint: true })
  const actual = fs.lstatSync(target, { bigint: true })
  const real = fs.realpathSync.native(target)
  if (!actual.isFile() || actual.isSymbolicLink() || !sameFile(opened, actual)
    || !contained(fs.realpathSync.native(attempt.root), real)
    || normalizeRealPath(real) !== normalizeRealPath(target)) fail('PORTABLE_ARCHIVE_SOURCE_UNSAFE')
  return actual
}

function cleanupAttempt(attempt: StagingAttempt): void {
  for (const owned of [...attempt.created].reverse()) {
    try {
      const actual = fs.lstatSync(owned.path, { bigint: true })
      if (actual.isSymbolicLink() || !sameObject(owned.identity, actual)
        || normalizeRealPath(fs.realpathSync.native(owned.path)) !== normalizeRealPath(owned.path)) continue
      if (owned.kind === 'file' && actual.isFile()) fs.unlinkSync(owned.path)
      if (owned.kind === 'directory' && actual.isDirectory()) fs.rmdirSync(owned.path)
    } catch { /* Preserve unknown/replaced/non-empty paths. */ }
  }
}

async function assertOpenedTarget(target: string, handle: fs.promises.FileHandle): Promise<fs.BigIntStats> {
  const opened = await handle.stat({ bigint: true })
  const actual = fs.lstatSync(target, { bigint: true })
  if (!actual.isFile() || actual.isSymbolicLink() || !sameFile(opened, actual)
    || normalizeRealPath(fs.realpathSync.native(target)) !== normalizeRealPath(target)) {
    fail('PORTABLE_ARCHIVE_SOURCE_UNSAFE')
  }
  return actual
}

export async function writePortableProjectArchive(input: WritePortableProjectArchiveInput): Promise<PortableArchiveReceipt> {
  const limits = resolvedLimits(input.limits)
  const manifest = parsePortableProjectManifest(input.manifest, limits)
  if (manifest.declaredCompressedBytes !== manifest.declaredUncompressedBytes
    || input.sources.length !== manifest.entries.length
    || manifest.entries.some(entry => portablePathKey(entry.path, limits.maxPathBytes) === MANIFEST_PATH)) {
    fail('PORTABLE_ARCHIVE_INVALID')
  }
  const sourceByKey = new Map<string, PortableArchiveSource>()
  for (const source of input.sources) {
    const key = portablePathKey(source.entry.path, limits.maxPathBytes)
    if (sourceByKey.has(key)) fail('PORTABLE_ARCHIVE_INVALID')
    sourceByKey.set(key, source)
  }
  const ordered = manifest.entries.map(entry => {
    const source = sourceByKey.get(portablePathKey(entry.path, limits.maxPathBytes))
    if (!source || !sameEntry(source.entry, entry)) fail('PORTABLE_ARCHIVE_INVALID')
    return source
  })

  const target = path.resolve(input.targetPath)
  const targetParent = path.dirname(target)
  safeDirectory(targetParent)
  try {
    fs.lstatSync(target)
    fail('PORTABLE_ARCHIVE_TARGET_EXISTS')
  } catch (error) {
    if (error instanceof PortableProjectArchiveError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // The archive is built under an unpredictable private name and only published by a no-overwrite hard link.
  // This assumes the target parent is application-controlled; it does not claim resistance to a hostile peer process.
  const temporary = path.join(targetParent, `.portable-project-archive-${randomUUID()}.tmp`)
  let handle: fs.promises.FileHandle
  try { handle = await fs.promises.open(temporary, 'wx', 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('PORTABLE_ARCHIVE_TARGET_EXISTS')
    throw error
  }
  try {
    await assertOpenedTarget(temporary, handle)
    input.__testHooks?.afterTemporaryOpened?.(temporary, target)
    await assertOpenedTarget(temporary, handle)
    let offset = 0
    const central: CentralRecord[] = []
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
    const manifestName = Buffer.from(MANIFEST_PATH)
    const manifestHeader = localHeader(manifestName, manifestBytes.length, crc32(manifestBytes))
    central.push({ name: manifestName, crc32: crc32(manifestBytes), size: manifestBytes.length, offset, dataDescriptor: false })
    await writeAll(handle, manifestHeader); await writeAll(handle, manifestBytes)
    offset += manifestHeader.length + manifestBytes.length

    for (const source of ordered) {
      const before = assertRegularSource(source.sourcePath)
      if (before.size !== BigInt(source.entry.byteSize)) fail('PORTABLE_ARCHIVE_SOURCE_CHANGED')
      const sourceHandle = await fs.promises.open(path.resolve(source.sourcePath), 'r')
      try {
        const opened = await sourceHandle.stat({ bigint: true })
        if (!sameFile(before, opened)) fail('PORTABLE_ARCHIVE_SOURCE_CHANGED')
        const name = Buffer.from(source.entry.path, 'utf8')
        const headerOffset = offset
        const header = localHeader(name, source.entry.byteSize, null)
        await writeAll(handle, header); offset += header.length
        const digest = createHash('sha256')
        let checksum = 0xffffffff
        let copied = 0
        const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
        while (copied < source.entry.byteSize) {
          const length = Math.min(buffer.length, source.entry.byteSize - copied)
          const { bytesRead } = await sourceHandle.read(buffer, 0, length, copied)
          if (bytesRead === 0) fail('PORTABLE_ARCHIVE_SOURCE_CHANGED')
          const chunk = buffer.subarray(0, bytesRead)
          digest.update(chunk); checksum = updateCrc(checksum, chunk)
          await writeAll(handle, chunk); copied += bytesRead; offset += bytesRead
        }
        const finalHandleInfo = await sourceHandle.stat({ bigint: true })
        const finalPathInfo = assertRegularSource(source.sourcePath)
        if (!sameFile(before, finalHandleInfo) || !sameFile(before, finalPathInfo)
          || digest.digest('hex') !== source.entry.sha256) fail('PORTABLE_ARCHIVE_SOURCE_CHANGED')
        checksum = (checksum ^ 0xffffffff) >>> 0
        const descriptor = dataDescriptor(copied, checksum)
        await writeAll(handle, descriptor); offset += descriptor.length
        central.push({ name, crc32: checksum, size: copied, offset: headerOffset, dataDescriptor: true })
      } finally { await sourceHandle.close() }
    }

    const centralOffset = offset
    let centralSize = 0
    let hasZip64Entry = false
    for (const record of central) {
      hasZip64Entry ||= record.size >= UINT32_MAX || record.offset >= UINT32_MAX
      const header = centralHeader(record)
      await writeAll(handle, header); centralSize += header.length; offset += header.length
    }
    const end = zipEnd(central.length, centralSize, centralOffset, hasZip64Entry)
    await writeAll(handle, end); offset += end.length
    await handle.sync()
    const publishIdentity = await assertOpenedTarget(temporary, handle)
    input.__testHooks?.beforePublish?.(temporary, target)
    await assertOpenedTarget(temporary, handle)
    try { fs.linkSync(temporary, target) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('PORTABLE_ARCHIVE_TARGET_EXISTS')
      fail('PORTABLE_ARCHIVE_PUBLISH_UNSUPPORTED')
    }
    const published = fs.lstatSync(target, { bigint: true })
    if (!published.isFile() || published.isSymbolicLink() || !sameObject(publishIdentity, published)
      || normalizeRealPath(fs.realpathSync.native(target)) !== normalizeRealPath(target)) {
      fail('PORTABLE_ARCHIVE_INVALID')
    }
    return {
      entryCount: manifest.entries.length,
      payloadBytes: manifest.declaredUncompressedBytes,
      archiveBytes: offset,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    }
  } finally {
    let cleanupIdentity: fs.BigIntStats | undefined
    try { cleanupIdentity = await handle.stat({ bigint: true }) } catch { /* Preserve temporary path below. */ }
    await handle.close()
    if (cleanupIdentity) {
      try {
        const actual = fs.lstatSync(temporary, { bigint: true })
        if (actual.isFile() && !actual.isSymbolicLink() && sameFile(cleanupIdentity, actual)
          && normalizeRealPath(fs.realpathSync.native(temporary)) === normalizeRealPath(temporary)) fs.unlinkSync(temporary)
      } catch { /* Never remove a replaced or unknown temporary path. */ }
    }
  }
}

export async function extractPortableProjectArchive(input: ExtractPortableProjectArchiveInput): Promise<ExtractPortableProjectArchiveResult> {
  const limits = resolvedLimits(input.limits)
  const archivePath = path.resolve(input.archivePath)
  const before = assertRegularSource(archivePath)
  const archiveDescriptor = fs.openSync(archivePath, 'r')
  let zip: yauzl.ZipFile | undefined
  let staging: StagingAttempt | undefined
  let success = false
  try {
    const opened = fs.fstatSync(archiveDescriptor, { bigint: true })
    if (!sameFile(before, opened)) fail('PORTABLE_ARCHIVE_SOURCE_CHANGED')
    zip = await openArchive(archiveDescriptor, Number(opened.size))
    if (zip.entryCount === 0 || zip.entryCount > limits.maxEntries + 1
      || (Buffer.isBuffer(zip.comment) ? zip.comment.length !== 0 : zip.comment !== '')) {
      fail('PORTABLE_ARCHIVE_INVALID')
    }
    const indexed = await indexArchive(zip, limits)
    if (indexed.length !== zip.entryCount || indexed[0]?.name !== MANIFEST_PATH
      || indexed.slice(1).some(item => item.name === MANIFEST_PATH)) fail('PORTABLE_ARCHIVE_INVALID')

    const pathKeys = new Set<string>()
    let compressedBytes = 0
    let uncompressedBytes = 0
    for (const item of indexed.slice(1)) {
      const key = portablePathKey(item.name, limits.maxPathBytes)
      if (key === MANIFEST_PATH || pathKeys.has(key)) fail('PORTABLE_ARCHIVE_INVALID')
      pathKeys.add(key)
      if (item.entry.uncompressedSize > limits.maxEntryBytes
        || item.entry.compressedSize > limits.maxDeclaredCompressedBytes
        || item.entry.uncompressedSize / Math.max(1, item.entry.compressedSize) > limits.maxCompressionRatio) {
        fail('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
      }
      uncompressedBytes += item.entry.uncompressedSize
      compressedBytes += item.entry.compressedSize
      if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > limits.maxTotalBytes
        || !Number.isSafeInteger(compressedBytes) || compressedBytes > limits.maxDeclaredCompressedBytes) {
        fail('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
      }
    }
    const manifestBytes = await readManifest(zip, indexed[0]!.entry, limits)
    let decoded: string
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes) }
    catch { fail('PORTABLE_ARCHIVE_INVALID') }
    let manifestValue: unknown
    try { manifestValue = JSON.parse(decoded) }
    catch { fail('PORTABLE_ARCHIVE_INVALID') }
    const manifest = parsePortableProjectManifest(manifestValue, limits)
    if (manifest.declaredUncompressedBytes !== uncompressedBytes
      || manifest.declaredCompressedBytes !== compressedBytes
      || manifest.entries.length !== indexed.length - 1) fail('PORTABLE_ARCHIVE_INVALID')
    const payloads = indexed.slice(1)
    for (const [index, item] of payloads.entries()) {
      const entry = manifest.entries[index]
      if (!entry || entry.path !== item.name || entry.byteSize !== item.entry.uncompressedSize) {
        fail('PORTABLE_ARCHIVE_INVALID')
      }
    }

    staging = prepareStaging(input.stagingParentPath)
    for (const [index, item] of payloads.entries()) {
      const expectedEntry = manifest.entries[index]!
      const target = targetFor(staging, item.name, input.__testHooks?.afterDirectoryCreated)
      let output: fs.promises.FileHandle
      try { output = await fs.promises.open(target, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('PORTABLE_ARCHIVE_TARGET_EXISTS')
        throw error
      }
      let owned = await assertOwnedOpenFile(staging, target, output)
      const record: OwnedStagingPath = { path: target, kind: 'file', identity: owned }
      staging.created.push(record)
      try {
        input.__testHooks?.afterPayloadFileOpened?.(target, staging.root)
        owned = await assertOwnedOpenFile(staging, target, output)
        record.identity = owned
        const stream = await openEntry(zip, item.entry)
        const digest = createHash('sha256')
        let checksum = 0xffffffff
        let written = 0
        for await (const value of stream) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
          written += chunk.length
          if (written > expectedEntry.byteSize) { stream.destroy(); fail('PORTABLE_ARCHIVE_INVALID') }
          digest.update(chunk); checksum = updateCrc(checksum, chunk)
          await writeAll(output, chunk)
        }
        if (written !== expectedEntry.byteSize || digest.digest('hex') !== expectedEntry.sha256
          || ((checksum ^ 0xffffffff) >>> 0) !== item.entry.crc32) fail('PORTABLE_ARCHIVE_INVALID')
        await output.sync()
        record.identity = await assertOwnedOpenFile(staging, target, output)
      } finally {
        try { record.identity = await assertOwnedOpenFile(staging, target, output) } catch { /* Preserve recorded owner. */ }
        await output.close()
      }
    }
    const after = fs.fstatSync(archiveDescriptor, { bigint: true })
    if (!sameFile(before, after) || !sameFile(before, assertRegularSource(archivePath))) {
      fail('PORTABLE_ARCHIVE_SOURCE_CHANGED')
    }
    success = true
    return {
      manifest,
      stagingPath: staging.root,
      receipt: {
        entryCount: manifest.entries.length,
        payloadBytes: uncompressedBytes,
        archiveBytes: Number(before.size),
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      },
    }
  } catch (error) {
    if (error instanceof PortableProjectArchiveError) throw error
    throw new PortableProjectArchiveError('PORTABLE_ARCHIVE_INVALID')
  } finally {
    zip?.close()
    try { fs.closeSync(archiveDescriptor) } catch { /* yauzl may have already released the descriptor. */ }
    if (!success && staging) cleanupAttempt(staging)
  }
}
