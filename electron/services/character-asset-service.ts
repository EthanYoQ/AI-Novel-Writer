import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { MAX_CHARACTER_AVATAR_INPUT_BYTES, type CharacterAvatarView } from '../../src/shared/character-avatar'
import { CharacterAssetRepository, type CharacterAssetRecord } from '../repositories/character-asset-repository'
import { avatarMime, compressAvatarImage, detectAvatarExtension, type CompressedAvatar } from './avatar-image'

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const CHARACTER_ID = /^[a-zA-Z0-9_-]{1,128}$/u

export interface CharacterAssetProjectScope {
  projectId: string
  sessionLease: string
  /** Explicit canonical .ai-novel root authorized by the session resolver. */
  storageRoot: string
  database: Database.Database
}

export interface CharacterAssetServiceDependencies {
  compress?(bytes: Buffer, extension: NonNullable<ReturnType<typeof detectAvatarExtension>>): CompressedAvatar
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function assertSafePath(location: string, expected: 'file' | 'directory' | 'either' = 'either'): void {
  const absolute = path.resolve(location)
  let cursor = path.parse(absolute).root
  const parts = absolute.slice(cursor.length).split(path.sep).filter(Boolean)
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part)
    try {
      const info = fs.lstatSync(cursor)
      if (info.isSymbolicLink()) throw new Error('CHARACTER_ASSET_UNSAFE_PATH')
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error('CHARACTER_ASSET_UNSAFE_PATH')
      if (index === parts.length - 1 && expected !== 'either'
        && (expected === 'file' ? !info.isFile() : !info.isDirectory())) throw new Error('CHARACTER_ASSET_UNSAFE_PATH')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function targetPath(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.split('/'))
  if (!contained(path.resolve(root), target)) throw new Error('CHARACTER_ASSET_UNSAFE_PATH')
  assertSafePath(path.dirname(target), 'directory')
  return target
}

function installFile(root: string, relativePath: string, bytes: Buffer): boolean {
  const target = targetPath(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  assertSafePath(path.dirname(target), 'directory')
  if (fs.existsSync(target)) {
    assertSafePath(target, 'file')
    if (hash(fs.readFileSync(target)) !== hash(bytes)) throw new Error('CHARACTER_ASSET_TARGET_CONFLICT')
    return false
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  try { fs.linkSync(temporary, target) } finally { fs.rmSync(temporary, { force: true }) }
  return true
}

function validBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[a-zA-Z0-9+/]*={0,2}$/u.test(value)
}

export class CharacterAssetService {
  readonly repository: CharacterAssetRepository
  private readonly root: string
  private readonly compress: NonNullable<CharacterAssetServiceDependencies['compress']>

  constructor(readonly scope: CharacterAssetProjectScope, dependencies: CharacterAssetServiceDependencies = {}) {
    if (!scope.projectId || !scope.sessionLease) throw new Error('CHARACTER_ASSET_SCOPE_REQUIRED')
    this.root = path.resolve(scope.storageRoot)
    if (!fs.existsSync(this.root)) throw new Error('CHARACTER_ASSET_SCOPE_REQUIRED')
    assertSafePath(this.root, 'directory')
    this.repository = new CharacterAssetRepository(scope.database)
    this.compress = dependencies.compress ?? compressAvatarImage
  }

  hasCharacter(characterId: string): boolean {
    return CHARACTER_ID.test(characterId) && this.repository.characterExists(characterId)
  }

  private reclaim(record: CharacterAssetRecord, sourceReference: string): void {
    if (this.repository.referencedPaths().has(record.relativePath)) return
    try { fs.rmSync(targetPath(this.root, record.relativePath), { force: true }); return } catch { /* Preserve below. */ }
    const recordId = hash(JSON.stringify([sourceReference, record.relativePath, record.contentHash]))
    this.scope.database.prepare(`INSERT OR IGNORE INTO character_avatar_unresolved(
      record_id,disposition,source_reference,source_relative_path,preserved_relative_path,
      content_hash,mime,byte_size,candidate_character_ids_json
    ) VALUES(?,'orphan',?,?,?,?,?,?,?)`).run(recordId, sourceReference, record.relativePath,
      record.relativePath, record.contentHash, record.mime, record.byteSize, JSON.stringify([record.characterId]))
  }

  async previewFile(characterId: string, filePath: string): Promise<Omit<CharacterAvatarView, 'assetRevision'>> {
    if (!this.hasCharacter(characterId)) throw new Error('CHARACTER_NOT_FOUND')
    assertSafePath(filePath, 'file')
    const before = await fs.promises.lstat(filePath)
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0) throw new Error('IMAGE_READ_FAILED')
    if (before.size > MAX_CHARACTER_AVATAR_INPUT_BYTES) throw new Error('IMAGE_TOO_LARGE')
    const handle = await fs.promises.open(filePath, 'r')
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size !== before.size) throw new Error('IMAGE_READ_FAILED')
      const bytes = Buffer.alloc(opened.size)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) throw new Error('IMAGE_READ_FAILED')
        offset += bytesRead
      }
      const extension = detectAvatarExtension(bytes)
      if (!extension) throw new Error('IMAGE_FORMAT_INVALID')
      return { characterId, mime: avatarMime(extension), base64: bytes.toString('base64') }
    } finally { await handle.close() }
  }

  commit(characterId: string, base64: string): CharacterAvatarView {
    if (!this.hasCharacter(characterId)) throw new Error('CHARACTER_NOT_FOUND')
    if (!validBase64(base64)) throw new Error('IMAGE_FORMAT_INVALID')
    if (base64.length > Math.ceil(MAX_CHARACTER_AVATAR_INPUT_BYTES * 4 / 3) + 4) throw new Error('IMAGE_TOO_LARGE')
    const original = Buffer.from(base64, 'base64')
    if (!original.length) throw new Error('IMAGE_FORMAT_INVALID')
    if (original.length > MAX_CHARACTER_AVATAR_INPUT_BYTES) throw new Error('IMAGE_TOO_LARGE')
    const extension = detectAvatarExtension(original)
    if (!extension) throw new Error('IMAGE_FORMAT_INVALID')
    const encoded = this.compress(original, extension)
    const encodedExtension = detectAvatarExtension(encoded.bytes)
    if (!encodedExtension) throw new Error('IMAGE_FORMAT_INVALID')
    const contentHash = hash(encoded.bytes)
    const assetRevision = this.repository.nextRevision(characterId)
    const suffix = encodedExtension === 'jpeg' ? 'jpg' : encodedExtension
    const relativePath = `avatars/${hash(characterId)}/${assetRevision}-${contentHash}.${suffix}`
    const installed = installFile(this.root, relativePath, encoded.bytes)
    let previous: CharacterAssetRecord | null
    try {
      previous = this.repository.replace({ characterId, assetRevision, relativePath, contentHash,
        mime: avatarMime(encodedExtension), byteSize: encoded.bytes.byteLength, sourceReference: '' })
    } catch (error) {
      if (installed) fs.rmSync(targetPath(this.root, relativePath), { force: true })
      throw error
    }
    if (previous && previous.relativePath !== relativePath) this.reclaim(previous, `runtime-replace:${characterId}`)
    return { characterId, assetRevision, mime: avatarMime(encodedExtension), base64: encoded.bytes.toString('base64') }
  }

  readMany(characterIds: readonly string[]): CharacterAvatarView[] {
    const ids = [...new Set(characterIds)]
    if (ids.length > 256 || ids.some(id => !CHARACTER_ID.test(id))) throw new Error('INVALID_CHARACTER_ID')
    const views: CharacterAvatarView[] = []
    for (const record of this.repository.readMany(ids)) {
      try {
        const file = targetPath(this.root, record.relativePath)
        assertSafePath(file, 'file')
        const bytes = fs.readFileSync(file)
        const extension = detectAvatarExtension(bytes)
        if (!extension || bytes.length !== record.byteSize || hash(bytes) !== record.contentHash) continue
        views.push({ characterId: record.characterId, assetRevision: record.assetRevision,
          mime: avatarMime(extension), base64: bytes.toString('base64') })
      } catch { /* Missing or unsafe assets fall back to the initial avatar. */ }
    }
    return views
  }

  remove(characterId: string): void {
    if (!CHARACTER_ID.test(characterId)) throw new Error('INVALID_CHARACTER_ID')
    const previous = this.repository.remove(characterId)
    if (previous) this.reclaim(previous, `runtime-remove:${characterId}`)
  }

  /** Records crash leftovers as recoverable orphans; it never deletes them. */
  recordReclaimableOrphans(): number {
    const avatarRoot = path.join(this.root, 'avatars')
    if (!fs.existsSync(avatarRoot)) return 0
    assertSafePath(avatarRoot, 'directory')
    const referenced = this.repository.referencedPaths()
    const files: string[] = []
    const walk = (directory: string) => {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name), info = fs.lstatSync(file)
        if (info.isSymbolicLink()) throw new Error('CHARACTER_ASSET_UNSAFE_PATH')
        if (info.isDirectory()) walk(file)
        else if (info.isFile()) files.push(file)
      }
    }
    walk(avatarRoot)
    let recorded = 0
    this.scope.database.transaction(() => {
      for (const file of files) {
        const relativePath = path.relative(this.root, file).split(path.sep).join('/')
        if (referenced.has(relativePath)) continue
        const bytes = fs.readFileSync(file), contentHash = hash(bytes), extension = detectAvatarExtension(bytes)
        const recordId = hash(JSON.stringify(['runtime-crash', relativePath, contentHash]))
        this.scope.database.prepare(`INSERT OR IGNORE INTO character_avatar_unresolved(
          record_id,disposition,source_reference,source_relative_path,preserved_relative_path,
          content_hash,mime,byte_size,candidate_character_ids_json
        ) VALUES(?,'orphan','runtime-crash',?,?,?,?,?,'[]')`).run(recordId, relativePath,
          relativePath, contentHash, extension ? avatarMime(extension) : 'application/octet-stream', bytes.length)
        recorded += 1
      }
    })()
    return recorded
  }
}
