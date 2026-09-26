import fs, { createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import {
  CANONICAL_PROJECT_DATABASE,
  CANONICAL_PROJECT_DIRECTORY,
  createCanonicalProjectManifest,
  parseCanonicalProjectManifest,
} from '../../src/shared/project-format'
import { assertPortableSourceSchema, portablePathKey } from './portable-project-format'
import { extractPortableProjectArchive } from './portable-project-archive'
import { readPortableRuntimeFreeze } from './portable-runtime-freeze'
import { verifyProjectSqlite } from './sqlite-project-migration'
import {
  parsePortableKnowledgeSnapshot,
  restorePortableKnowledgeSnapshot,
  verifyPortableKnowledgeSnapshot,
  type PortableKnowledgeSnapshot,
} from '../vector-store'
import { PORTABLE_KNOWLEDGE_SOURCE_PATH } from './portable-project-assets'
import {
  PORTABLE_TRANSFER_AUTHORITY_PATH,
  mapPortableTransferAuthority,
  parsePortableTransferAuthority,
  serializePortableTransferAuthority,
  type PortableTransferAuthority,
  verifyPortableTransferAuthority,
} from './portable-transfer-authority'

const require = createRequire(import.meta.url)
const BetterSqlite = require('better-sqlite3') as typeof import('better-sqlite3')
const HASH = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const FREEZE_ARCHIVE_PATH = 'portable-runtime-freeze.json'
const PROJECT_MANIFEST_NAME = 'project.json'
const INSTALL_MARKER_NAME = '.portable-restore-reservation.json'
const INSTALL_JOURNAL_VERSION = 1
const activeInstallJournals = new Set<string>()

export type ProjectRestoreServiceErrorCode =
  | 'PORTABLE_RESTORE_CANCELLED'
  | 'PORTABLE_RESTORE_INVALID'
  | 'PORTABLE_RESTORE_TARGET_EXISTS'
  | 'PORTABLE_RESTORE_UNSAFE_TARGET'

export class ProjectRestoreServiceError extends Error {
  constructor(readonly code: ProjectRestoreServiceErrorCode) {
    super(code)
    this.name = 'ProjectRestoreServiceError'
  }
}

export interface RestorePortableProjectInput {
  archivePath: string
  targetProjectRoot: string
  signal?: AbortSignal
  now?: () => Date
  newProjectId?: () => string
  /** @internal Deterministic trust-boundary tests. */
  __testHooks?: {
    afterStagingCaptured?(stagingPath: string): void
    beforeInstall?(stagingProjectRoot: string, targetProjectRoot: string): void
    afterTargetReserved?(journalPath: string, targetProjectRoot: string): void
    afterInstallCommitted?(targetProjectRoot: string): void
  }
}

export interface RestorePortableProjectReceipt {
  originProjectId: string
  targetProjectId: string
  targetProjectRoot: string
  snapshotGeneration: string
  portableDatabaseSha256: string
  requiresRuntimeFreezeGuard: true
}

interface OwnedPath {
  path: string
  kind: 'file' | 'directory'
  identity: fs.BigIntStats
}

interface OwnedAttempt {
  root: string
  paths: Map<string, OwnedPath>
}

interface InstallJournal {
  version: 1
  targetRoot: string
  archiveSha256: string
  originProjectId: string
  snapshotGeneration: string
  transferReceiptId: string
  portableDatabaseSha256: string
  targetProjectId: string
  reservationToken: string
}

interface ReadInstallJournal {
  document: InstallJournal
  path: string
  identity: fs.BigIntStats
}

function fail(code: ProjectRestoreServiceErrorCode): never { throw new ProjectRestoreServiceError(code) }

function normalized(value: string): string {
  const result = path.resolve(value).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? result.toLocaleLowerCase('en-US') : result
}

function physicalDirectory(directory: string): void {
  const absolute = path.resolve(directory)
  let cursor = path.parse(absolute).root
  for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    let info: fs.Stats
    try { info = fs.lstatSync(cursor) } catch { fail('PORTABLE_RESTORE_UNSAFE_TARGET') }
    if (!info.isDirectory() || info.isSymbolicLink()
      || normalized(fs.realpathSync.native(cursor)) !== normalized(cursor)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(normalized(root), normalized(candidate))
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function same(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function exactOwned(owned: OwnedPath): fs.BigIntStats {
  const actual = fs.lstatSync(owned.path, { bigint: true })
  const rightKind = owned.kind === 'file' ? actual.isFile() : actual.isDirectory()
  if (!rightKind || actual.isSymbolicLink() || !same(owned.identity, actual)
    || normalized(fs.realpathSync.native(owned.path)) !== normalized(owned.path)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  return actual
}

function readPhysicalFile(file: string, maxBytes = 4 * 1024 * 1024): { bytes: Buffer; identity: fs.BigIntStats } {
  let descriptor: number
  try { descriptor = fs.openSync(file, 'r') } catch { return fail('PORTABLE_RESTORE_UNSAFE_TARGET') }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true })
    const current = fs.lstatSync(file, { bigint: true })
    if (!opened.isFile() || opened.size > BigInt(maxBytes) || !current.isFile() || current.isSymbolicLink()
      || !same(opened, current) || normalized(fs.realpathSync.native(file)) !== normalized(file)) {
      fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    }
    const bytes = fs.readFileSync(descriptor)
    const finalOpened = fs.fstatSync(descriptor, { bigint: true })
    const final = fs.lstatSync(file, { bigint: true })
    if (bytes.length !== Number(opened.size) || !same(opened, finalOpened) || !same(opened, final)
      || final.isSymbolicLink() || normalized(fs.realpathSync.native(file)) !== normalized(file)) {
      fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    }
    return { bytes, identity: opened }
  } finally { fs.closeSync(descriptor) }
}

function unlinkIdentity(file: string, identity: fs.BigIntStats): void {
  const actual = fs.lstatSync(file, { bigint: true })
  if (!actual.isFile() || actual.isSymbolicLink() || !same(identity, actual)
    || normalized(fs.realpathSync.native(file)) !== normalized(file)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  fs.unlinkSync(file)
}

function captureAttempt(root: string, archivePaths: readonly string[]): OwnedAttempt {
  const absolute = path.resolve(root)
  const paths = new Map<string, OwnedPath>()
  const capture = (candidate: string, expectedKind: OwnedPath['kind']) => {
    const resolved = path.resolve(candidate)
    const existing = paths.get(resolved)
    if (existing) {
      if (existing.kind !== expectedKind) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
      exactOwned(existing)
      return
    }
    const info = fs.lstatSync(candidate, { bigint: true })
    if (info.isSymbolicLink() || !contained(absolute, candidate)
      || normalized(fs.realpathSync.native(candidate)) !== normalized(candidate)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    const kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    if (kind !== expectedKind || kind === 'file' && info.nlink !== 1n) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    paths.set(resolved, { path: resolved, kind, identity: info })
  }
  const attempt = { root: absolute, paths }
  try {
    capture(absolute, 'directory')
    for (const archivePath of archivePaths) {
      let cursor = absolute
      const segments = archivePath.split('/')
      for (const segment of segments.slice(0, -1)) {
        cursor = path.join(cursor, segment)
        capture(cursor, 'directory')
      }
      capture(path.join(cursor, segments.at(-1)!), 'file')
    }
    return attempt
  } catch (error) {
    cleanupAttempt(attempt)
    throw error
  }
}

function cleanupAttempt(attempt: OwnedAttempt | undefined): void {
  if (!attempt) return
  const ordered = [...attempt.paths.values()].sort((left, right) => right.path.length - left.path.length)
  for (const owned of ordered) {
    try {
      const actual = fs.lstatSync(owned.path, { bigint: true })
      if (actual.isSymbolicLink() || !same(owned.identity, actual)
        || normalized(fs.realpathSync.native(owned.path)) !== normalized(owned.path)) continue
      if (owned.kind === 'file' && actual.isFile()) fs.unlinkSync(owned.path)
      if (owned.kind === 'directory' && actual.isDirectory()) fs.rmdirSync(owned.path)
    } catch { /* Preserve missing, replaced, or non-empty paths. */ }
  }
}

function mkdirOwned(attempt: OwnedAttempt, directory: string): void {
  const absolute = path.resolve(directory)
  if (!contained(attempt.root, absolute)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  const existing = attempt.paths.get(absolute)
  if (existing) { exactOwned(existing); return }
  mkdirOwned(attempt, path.dirname(absolute))
  fs.mkdirSync(absolute, { mode: 0o700 })
  const identity = fs.lstatSync(absolute, { bigint: true })
  attempt.paths.set(absolute, { path: absolute, kind: 'directory', identity })
  exactOwned(attempt.paths.get(absolute)!)
}

function moveOwnedFile(attempt: OwnedAttempt, source: string, target: string): void {
  const from = path.resolve(source)
  const to = path.resolve(target)
  const owned = attempt.paths.get(from)
  if (!owned || owned.kind !== 'file') fail('PORTABLE_RESTORE_INVALID')
  exactOwned(owned)
  if (fs.existsSync(to)) fail('PORTABLE_RESTORE_INVALID')
  mkdirOwned(attempt, path.dirname(to))
  fs.renameSync(from, to)
  attempt.paths.delete(from)
  const identity = fs.lstatSync(to, { bigint: true })
  attempt.paths.set(to, { path: to, kind: 'file', identity })
  exactOwned(attempt.paths.get(to)!)
}

function replaceOwnedFile(attempt: OwnedAttempt, file: string, bytes: Buffer): void {
  const absolute = path.resolve(file)
  const owned = attempt.paths.get(absolute)
  if (!owned || owned.kind !== 'file') fail('PORTABLE_RESTORE_INVALID')
  exactOwned(owned)
  fs.unlinkSync(absolute)
  attempt.paths.delete(absolute)
  const descriptor = fs.openSync(absolute, 'wx', 0o600)
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  attempt.paths.set(absolute, { path: absolute, kind: 'file', identity: fs.lstatSync(absolute, { bigint: true }) })
}

function writeOwnedFile(attempt: OwnedAttempt, file: string, bytes: Buffer): void {
  const absolute = path.resolve(file)
  if (fs.existsSync(absolute)) fail('PORTABLE_RESTORE_INVALID')
  mkdirOwned(attempt, path.dirname(absolute))
  const descriptor = fs.openSync(absolute, 'wx', 0o600)
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  attempt.paths.set(absolute, { path: absolute, kind: 'file', identity: fs.lstatSync(absolute, { bigint: true }) })
}

function captureGeneratedFileIfPresent(attempt: OwnedAttempt, file: string): void {
  const absolute = path.resolve(file)
  if (!fs.existsSync(absolute)) return
  if (attempt.paths.has(absolute)) fail('PORTABLE_RESTORE_INVALID')
  const identity = fs.lstatSync(absolute, { bigint: true })
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n
    || !contained(attempt.root, absolute) || normalized(fs.realpathSync.native(absolute)) !== normalized(absolute)) {
    fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  }
  attempt.paths.set(absolute, { path: absolute, kind: 'file', identity })
}

function captureGeneratedTree(attempt: OwnedAttempt, root: string): void {
  const visit = (entry: string) => {
    const absolute = path.resolve(entry)
    if (!contained(attempt.root, absolute) || attempt.paths.has(absolute)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    const identity = fs.lstatSync(absolute, { bigint: true })
    if (identity.isSymbolicLink() || normalized(fs.realpathSync.native(absolute)) !== normalized(absolute)) {
      fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    }
    const kind = identity.isDirectory() ? 'directory' : identity.isFile() && identity.nlink === 1n
      ? 'file' : fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    attempt.paths.set(absolute, { path: absolute, kind, identity })
    if (kind === 'directory') for (const name of fs.readdirSync(absolute)) visit(path.join(absolute, name))
  }
  visit(root)
}

function removeOwnedFile(attempt: OwnedAttempt, file: string): void {
  const absolute = path.resolve(file)
  const owned = attempt.paths.get(absolute)
  if (!owned) return
  if (owned.kind !== 'file') fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  exactOwned(owned)
  fs.unlinkSync(absolute)
  attempt.paths.delete(absolute)
}

function json(bytes: Buffer): unknown {
  let decoded: string
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return fail('PORTABLE_RESTORE_INVALID') }
  try { return JSON.parse(decoded) } catch { return fail('PORTABLE_RESTORE_INVALID') }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function installJournalPath(targetRoot: string): string {
  const key = createHash('sha256').update(normalized(targetRoot)).digest('hex').slice(0, 32)
  return path.join(path.dirname(targetRoot), `.portable-project-restore-${key}.json`)
}

function parseInstallJournal(bytes: Buffer, targetRoot: string): InstallJournal {
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return fail('PORTABLE_RESTORE_UNSAFE_TARGET') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  const document = value as Record<string, unknown>
  if (!exactKeys(document, [
    'version', 'targetRoot', 'archiveSha256', 'originProjectId', 'snapshotGeneration', 'transferReceiptId',
    'portableDatabaseSha256', 'targetProjectId', 'reservationToken',
  ]) || document.version !== INSTALL_JOURNAL_VERSION || document.targetRoot !== normalized(targetRoot)
    || typeof document.archiveSha256 !== 'string' || !HASH.test(document.archiveSha256)
    || typeof document.originProjectId !== 'string' || !UUID.test(document.originProjectId)
    || typeof document.snapshotGeneration !== 'string' || !document.snapshotGeneration || document.snapshotGeneration.length > 512
    || typeof document.transferReceiptId !== 'string' || !document.transferReceiptId || document.transferReceiptId.length > 512
    || typeof document.portableDatabaseSha256 !== 'string' || !HASH.test(document.portableDatabaseSha256)
    || typeof document.targetProjectId !== 'string' || !UUID.test(document.targetProjectId)
    || typeof document.reservationToken !== 'string' || !UUID.test(document.reservationToken)) {
    fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  }
  return document as unknown as InstallJournal
}

function readInstallJournal(targetRoot: string): ReadInstallJournal | null {
  const journal = installJournalPath(targetRoot)
  try { fs.lstatSync(journal) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  }
  const read = readPhysicalFile(journal)
  return { document: parseInstallJournal(read.bytes, targetRoot), path: journal, identity: read.identity }
}

function sameInstallSource(
  journal: InstallJournal,
  archiveSha256: string,
  authority: PortableTransferAuthority,
): boolean {
  return journal.archiveSha256 === archiveSha256
    && journal.originProjectId === authority.originProjectId
    && journal.snapshotGeneration === authority.snapshotGeneration
    && journal.transferReceiptId === authority.receiptId
    && journal.portableDatabaseSha256 === authority.portableDatabaseSha256
}

function sameJournal(left: InstallJournal, right: InstallJournal): boolean {
  return left.version === right.version && left.targetRoot === right.targetRoot
    && left.archiveSha256 === right.archiveSha256 && left.originProjectId === right.originProjectId
    && left.snapshotGeneration === right.snapshotGeneration && left.transferReceiptId === right.transferReceiptId
    && left.portableDatabaseSha256 === right.portableDatabaseSha256
    && left.targetProjectId === right.targetProjectId && left.reservationToken === right.reservationToken
}

function createInstallJournal(
  targetRoot: string,
  archiveSha256: string,
  authority: PortableTransferAuthority,
  targetProjectId: string,
): ReadInstallJournal {
  const journal = installJournalPath(targetRoot)
  if (activeInstallJournals.has(normalized(journal))) fail('PORTABLE_RESTORE_TARGET_EXISTS')
  const document: InstallJournal = {
    version: INSTALL_JOURNAL_VERSION,
    targetRoot: normalized(targetRoot),
    archiveSha256,
    originProjectId: authority.originProjectId,
    snapshotGeneration: authority.snapshotGeneration,
    transferReceiptId: authority.receiptId,
    portableDatabaseSha256: authority.portableDatabaseSha256,
    targetProjectId,
    reservationToken: randomUUID(),
  }
  let descriptor: number
  try { descriptor = fs.openSync(journal, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('PORTABLE_RESTORE_TARGET_EXISTS')
    throw error
  }
  try {
    fs.writeFileSync(descriptor, Buffer.from(`${JSON.stringify(document)}\n`))
    fs.fsyncSync(descriptor)
  } finally { fs.closeSync(descriptor) }
  const identity = readPhysicalFile(journal).identity
  activeInstallJournals.add(normalized(journal))
  return { document, path: journal, identity }
}

function releaseInstallJournal(journal: ReadInstallJournal, targetRoot: string, removeMarker: boolean): void {
  const marker = path.join(targetRoot, INSTALL_MARKER_NAME)
  if (removeMarker) unlinkIdentity(marker, journal.identity)
  unlinkIdentity(journal.path, journal.identity)
  activeInstallJournals.delete(normalized(journal.path))
}

function reservationOwned(journal: ReadInstallJournal, targetRoot: string): fs.BigIntStats {
  const root = fs.lstatSync(targetRoot, { bigint: true })
  if (!root.isDirectory() || root.isSymbolicLink()
    || normalized(fs.realpathSync.native(targetRoot)) !== normalized(targetRoot)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  const marker = readPhysicalFile(path.join(targetRoot, INSTALL_MARKER_NAME))
  if (!same(marker.identity, journal.identity)
    || !sameJournal(parseInstallJournal(marker.bytes, targetRoot), journal.document)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  return root
}

function cleanupInstallTemporaries(journal: ReadInstallJournal, targetRoot: string): void {
  const storage = path.join(targetRoot, CANONICAL_PROJECT_DIRECTORY)
  if (!fs.existsSync(storage)) return
  physicalDirectory(storage)
  const suffix = `.portable-restore-${journal.document.reservationToken}.tmp`
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const entry = path.join(directory, name)
      const info = fs.lstatSync(entry, { bigint: true })
      if (info.isSymbolicLink() || normalized(fs.realpathSync.native(entry)) !== normalized(entry)) {
        fail('PORTABLE_RESTORE_UNSAFE_TARGET')
      }
      if (info.isDirectory()) { visit(entry); continue }
      if (!info.isFile() || !name.startsWith('.') || !name.endsWith(suffix)) continue
      const finalName = name.slice(1, -suffix.length)
      if (!finalName) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
      const finalPath = path.join(directory, finalName)
      if (fs.existsSync(finalPath)) {
        const final = fs.lstatSync(finalPath, { bigint: true })
        if (!final.isFile() || final.isSymbolicLink() || !same(info, final)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
      }
      fs.unlinkSync(entry)
    }
  }
  visit(storage)
}

function assertFreeze(value: unknown, originProjectId: string, snapshotGeneration: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PORTABLE_RESTORE_INVALID')
  const document = value as Record<string, unknown>
  if (!exactKeys(document, [
    'version', 'originProjectId', 'snapshotGeneration', 'nonReplayable', 'requiresRuntimeFreezeGuard',
    'records', 'avatarReferenceProjections',
  ]) || document.version !== 1 || document.originProjectId !== originProjectId
    || document.snapshotGeneration !== snapshotGeneration || document.nonReplayable !== true
    || document.requiresRuntimeFreezeGuard !== true || !Array.isArray(document.records)
    || !Array.isArray(document.avatarReferenceProjections) || document.records.length > 100_000
    || document.avatarReferenceProjections.length > 100_000) fail('PORTABLE_RESTORE_INVALID')
  for (const item of document.records) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('PORTABLE_RESTORE_INVALID')
    const record = item as Record<string, unknown>
    if (!exactKeys(record, [
      'projectionId', 'table', 'recordId', 'terminalState', 'projection', 'projectionHash', 'excludedFields',
      'nonReplayable', 'originalReceiptVerified',
    ]) || typeof record.projectionId !== 'string' || !record.projectionId
      || typeof record.table !== 'string' || !record.table || typeof record.recordId !== 'string' || !record.recordId
      || typeof record.terminalState !== 'string' || !record.terminalState
      || !record.projection || typeof record.projection !== 'object' || Array.isArray(record.projection)
      || typeof record.projectionHash !== 'string' || !HASH.test(record.projectionHash)
      || !Array.isArray(record.excludedFields) || record.excludedFields.some(field => typeof field !== 'string')
      || record.nonReplayable !== true || record.originalReceiptVerified !== false) fail('PORTABLE_RESTORE_INVALID')
  }
  if (document.avatarReferenceProjections.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    fail('PORTABLE_RESTORE_INVALID')
  }
}

async function hashFile(file: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

async function hashPhysicalFile(file: string): Promise<string> {
  const before = fs.lstatSync(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()
    || normalized(fs.realpathSync.native(file)) !== normalized(file)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  const digest = await hashFile(file)
  const after = fs.lstatSync(file, { bigint: true })
  if (!after.isFile() || after.isSymbolicLink() || !same(before, after)
    || normalized(fs.realpathSync.native(file)) !== normalized(file)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  return digest
}

function restoreReceipt(
  targetRoot: string,
  authority: PortableTransferAuthority,
  targetProjectId: string,
): RestorePortableProjectReceipt {
  return {
    originProjectId: authority.originProjectId,
    targetProjectId,
    targetProjectRoot: targetRoot,
    snapshotGeneration: authority.snapshotGeneration,
    portableDatabaseSha256: authority.portableDatabaseSha256,
    requiresRuntimeFreezeGuard: true,
  }
}

async function installedReceipt(
  targetRoot: string,
  authority: PortableTransferAuthority,
  entries: readonly { path: string; sha256: string; disposition: string }[],
): Promise<RestorePortableProjectReceipt | null> {
  if (!fs.existsSync(targetRoot)) return null
  physicalDirectory(targetRoot)
  const rootNames = fs.readdirSync(targetRoot)
  if (rootNames.some(name => name !== CANONICAL_PROJECT_DIRECTORY && name !== INSTALL_MARKER_NAME)) return null
  const storage = path.join(targetRoot, CANONICAL_PROJECT_DIRECTORY)
  const projectManifestPath = path.join(storage, PROJECT_MANIFEST_NAME)
  if (!fs.existsSync(projectManifestPath)) return null
  physicalDirectory(storage)
  let targetProjectId: string
  let installedAuthority: PortableTransferAuthority
  try {
    targetProjectId = parseCanonicalProjectManifest(JSON.parse(readPhysicalFile(projectManifestPath).bytes.toString('utf8'))).projectId
    installedAuthority = parsePortableTransferAuthority(JSON.parse(readPhysicalFile(
      path.join(storage, path.posix.basename(PORTABLE_TRANSFER_AUTHORITY_PATH)),
    ).bytes.toString('utf8')))
  } catch { return null }
  if (installedAuthority.originProjectId !== authority.originProjectId
    || installedAuthority.snapshotGeneration !== authority.snapshotGeneration
    || installedAuthority.receiptId !== authority.receiptId
    || installedAuthority.portableDatabaseSha256 !== authority.portableDatabaseSha256
    || installedAuthority.targetProjectId !== targetProjectId || !UUID.test(targetProjectId)
    || targetProjectId === authority.originProjectId) return null
  for (const entry of entries) {
    if (entry.path === PORTABLE_TRANSFER_AUTHORITY_PATH) continue
    const file = path.join(storage, ...entry.path.split('/'))
    if (!fs.existsSync(file) || await hashPhysicalFile(file) !== entry.sha256) return null
  }
  const databasePath = path.join(storage, CANONICAL_PROJECT_DATABASE)
  try {
    if (!readPortableRuntimeFreeze(targetRoot).active) return null
    verifyProjectSqlite({ databasePath })
    const database = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true })
    try {
      database.pragma('foreign_keys = ON')
      assertPortableSourceSchema(database)
      verifyPortableTransferAuthority(database, installedAuthority)
    } finally { database.close() }
    const knowledgeEntry = entries.find(entry => entry.path === PORTABLE_KNOWLEDGE_SOURCE_PATH)
    if (knowledgeEntry) {
      if (knowledgeEntry.disposition !== 'knowledge-source') return null
      const snapshot = parsePortableKnowledgeSnapshot(json(readPhysicalFile(
        path.join(storage, PORTABLE_KNOWLEDGE_SOURCE_PATH),
      ).bytes))
      if (!await verifyPortableKnowledgeSnapshot(storage, snapshot)) return null
    }
  } catch { return null }
  return restoreReceipt(targetRoot, authority, targetProjectId)
}

function relativeKey(value: string): string {
  return portablePathKey(value.split(path.sep).join('/'))
}

function listPhysicalTree(root: string): { files: Set<string>; directories: Set<string> } {
  const files = new Set<string>()
  const directories = new Set<string>()
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const entry = path.join(directory, name)
      const info = fs.lstatSync(entry, { bigint: true })
      if (info.isSymbolicLink() || normalized(fs.realpathSync.native(entry)) !== normalized(entry)) {
        fail('PORTABLE_RESTORE_UNSAFE_TARGET')
      }
      const key = relativeKey(path.relative(root, entry))
      if (info.isDirectory()) { directories.add(key); visit(entry) }
      else if (info.isFile()) files.add(key)
      else fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    }
  }
  visit(root)
  return { files, directories }
}

async function installStagedProject(
  attempt: OwnedAttempt,
  storage: string,
  targetRoot: string,
  journal: ReadInstallJournal,
): Promise<void> {
  const rootIdentity = reservationOwned(journal, targetRoot)
  if (fs.readdirSync(targetRoot).some(name => name !== INSTALL_MARKER_NAME && name !== CANONICAL_PROJECT_DIRECTORY)) {
    fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  }
  const targetStorage = path.join(targetRoot, CANONICAL_PROJECT_DIRECTORY)
  if (!fs.existsSync(targetStorage)) fs.mkdirSync(targetStorage, { mode: 0o700 })
  physicalDirectory(targetStorage)

  const sources = [...attempt.paths.values()].filter(item => item.kind === 'file' && contained(storage, item.path))
  const byKey = new Map(sources.map(item => [relativeKey(path.relative(storage, item.path)), item]))
  const expectedFiles = new Set(byKey.keys())
  const expectedDirectories = new Set<string>()
  for (const source of sources) {
    let relative = path.dirname(path.relative(storage, source.path))
    while (relative !== '.') {
      expectedDirectories.add(relativeKey(relative))
      const parent = path.dirname(relative)
      if (parent === relative) break
      relative = parent
    }
  }
  const temporaryPath = (source: OwnedPath) => {
    const target = path.join(targetStorage, path.relative(storage, source.path))
    return path.join(path.dirname(target), `.${path.basename(target)}.portable-restore-${journal.document.reservationToken}.tmp`)
  }
  for (const source of sources) {
    const temporary = temporaryPath(source)
    if (!fs.existsSync(temporary)) continue
    const temporaryInfo = fs.lstatSync(temporary, { bigint: true })
    if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink()
      || normalized(fs.realpathSync.native(temporary)) !== normalized(temporary)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    const target = path.join(targetStorage, path.relative(storage, source.path))
    if (fs.existsSync(target)) {
      const targetInfo = fs.lstatSync(target, { bigint: true })
      if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || !same(temporaryInfo, targetInfo)) {
        fail('PORTABLE_RESTORE_UNSAFE_TARGET')
      }
    }
    fs.unlinkSync(temporary)
  }
  const existing = listPhysicalTree(targetStorage)
  if ([...existing.files].some(key => !expectedFiles.has(key))
    || [...existing.directories].some(key => !expectedDirectories.has(key))) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  if (existing.files.has(portablePathKey(PROJECT_MANIFEST_NAME))) fail('PORTABLE_RESTORE_UNSAFE_TARGET')

  for (const key of [...expectedDirectories].sort((left, right) => left.split('/').length - right.split('/').length)) {
    const directory = path.join(targetStorage, ...key.split('/'))
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 })
    physicalDirectory(directory)
  }
  const installFile = async (source: OwnedPath) => {
    exactOwned(source)
    const relative = path.relative(storage, source.path)
    const target = path.join(targetStorage, relative)
    if (fs.existsSync(target)) {
      if (await hashPhysicalFile(target) !== await hashPhysicalFile(source.path)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    } else {
      const temporary = temporaryPath(source)
      try { fs.copyFileSync(source.path, temporary, fs.constants.COPYFILE_EXCL) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('PORTABLE_RESTORE_UNSAFE_TARGET')
        throw error
      }
      const descriptor = fs.openSync(temporary, 'r+')
      try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
      if (await hashPhysicalFile(temporary) !== await hashPhysicalFile(source.path)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
      try { fs.linkSync(temporary, target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('PORTABLE_RESTORE_UNSAFE_TARGET')
        throw error
      }
      const temporaryInfo = fs.lstatSync(temporary, { bigint: true })
      const linked = fs.lstatSync(target, { bigint: true })
      if (!linked.isFile() || linked.isSymbolicLink() || !same(temporaryInfo, linked)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
      fs.unlinkSync(temporary)
    }
    removeOwnedFile(attempt, source.path)
  }
  for (const [key, source] of byKey) {
    if (key !== portablePathKey(PROJECT_MANIFEST_NAME)) await installFile(source)
  }
  reservationOwned(journal, targetRoot)
  const rootNow = fs.lstatSync(targetRoot, { bigint: true })
  if (!same(rootIdentity, rootNow)) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  if (fs.readdirSync(targetRoot).some(name => name !== INSTALL_MARKER_NAME && name !== CANONICAL_PROJECT_DIRECTORY)) {
    fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  }
  const finalTree = listPhysicalTree(targetStorage)
  if ([...finalTree.files].some(key => key !== portablePathKey(PROJECT_MANIFEST_NAME) && !expectedFiles.has(key))
    || [...finalTree.directories].some(key => !expectedDirectories.has(key))) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  const manifest = byKey.get(portablePathKey(PROJECT_MANIFEST_NAME))
  if (!manifest) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  await installFile(manifest)
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail('PORTABLE_RESTORE_CANCELLED')
}

function removeEmptyOwnedDirectories(attempt: OwnedAttempt, except: ReadonlySet<string>): void {
  const directories = [...attempt.paths.values()]
    .filter(item => item.kind === 'directory' && !except.has(normalized(item.path)))
    .sort((left, right) => right.path.length - left.path.length)
  for (const owned of directories) {
    exactOwned(owned)
    if (fs.readdirSync(owned.path).length === 0) {
      fs.rmdirSync(owned.path)
      attempt.paths.delete(owned.path)
    }
  }
}

export async function restorePortableProject(input: RestorePortableProjectInput): Promise<RestorePortableProjectReceipt> {
  cancelled(input.signal)
  const targetRoot = path.resolve(input.targetProjectRoot)
  const targetParent = path.dirname(targetRoot)
  if (normalized(targetRoot) === normalized(path.parse(targetRoot).root) || !fs.existsSync(targetParent)) {
    fail('PORTABLE_RESTORE_UNSAFE_TARGET')
  }
  physicalDirectory(targetParent)
  const archiveSha256 = await hashPhysicalFile(input.archivePath)
  const extracted = await extractPortableProjectArchive({ archivePath: input.archivePath, stagingParentPath: targetParent })
  if (await hashPhysicalFile(input.archivePath) !== archiveSha256) fail('PORTABLE_RESTORE_INVALID')
  let attempt: OwnedAttempt | undefined
  let heldJournalPath: string | undefined
  try {
    attempt = captureAttempt(extracted.stagingPath, extracted.manifest.entries.map(entry => entry.path))
    input.__testHooks?.afterStagingCaptured?.(attempt.root)
    exactOwned(attempt.paths.get(attempt.root)!)
    cancelled(input.signal)

    const finalPaths = new Map<string, string>()
    const authorityKey = portablePathKey(PORTABLE_TRANSFER_AUTHORITY_PATH)
    const knowledgeKey = portablePathKey(PORTABLE_KNOWLEDGE_SOURCE_PATH)
    const forbiddenKnowledgeStorage = new Set([
      'embedding-spaces.json', 'vectors.json', 'vectors.json.migrated', 'vectors.json.migration-journal.json',
    ].map(value => portablePathKey(value)))
    const reservedPrefix = `${portablePathKey(CANONICAL_PROJECT_DIRECTORY)}/`
    for (const entry of extracted.manifest.entries) {
      const archiveKey = portablePathKey(entry.path)
      const reserved = archiveKey === portablePathKey(CANONICAL_PROJECT_DIRECTORY) || archiveKey.startsWith(reservedPrefix)
      if (reserved && (archiveKey !== authorityKey || entry.path !== PORTABLE_TRANSFER_AUTHORITY_PATH)) {
        fail('PORTABLE_RESTORE_INVALID')
      }
      if (archiveKey === knowledgeKey && entry.path !== PORTABLE_KNOWLEDGE_SOURCE_PATH) fail('PORTABLE_RESTORE_INVALID')
      if (archiveKey === 'lancedb' || archiveKey.startsWith('lancedb/') || forbiddenKnowledgeStorage.has(archiveKey)) {
        fail('PORTABLE_RESTORE_INVALID')
      }
      const relative = archiveKey === authorityKey ? path.posix.basename(PORTABLE_TRANSFER_AUTHORITY_PATH) : entry.path
      const key = portablePathKey(relative)
      if (finalPaths.has(key) || [PROJECT_MANIFEST_NAME, 'project.db-wal', 'project.db-shm', 'project.db-journal'].includes(key)) {
        fail('PORTABLE_RESTORE_INVALID')
      }
      finalPaths.set(key, entry.path)
    }
    const databaseEntry = extracted.manifest.entries.find(entry => portablePathKey(entry.path) === CANONICAL_PROJECT_DATABASE)
    const freezeEntry = extracted.manifest.entries.find(entry => portablePathKey(entry.path) === FREEZE_ARCHIVE_PATH)
    const transferEntry = extracted.manifest.entries.find(entry => entry.path === PORTABLE_TRANSFER_AUTHORITY_PATH)
    const knowledgeEntry = extracted.manifest.entries.find(entry => entry.path === PORTABLE_KNOWLEDGE_SOURCE_PATH)
    if (!databaseEntry || databaseEntry.disposition !== 'portable-database'
      || !freezeEntry || freezeEntry.disposition !== 'history-projection'
      || !transferEntry || transferEntry.disposition !== 'transfer-receipt'
      || knowledgeEntry && knowledgeEntry.disposition !== 'knowledge-source') fail('PORTABLE_RESTORE_INVALID')

    const databasePath = path.join(attempt.root, CANONICAL_PROJECT_DATABASE)
    const freezePath = path.join(attempt.root, FREEZE_ARCHIVE_PATH)
    const transferPath = path.join(attempt.root, ...PORTABLE_TRANSFER_AUTHORITY_PATH.split('/'))
    const authority = parsePortableTransferAuthority(json(fs.readFileSync(transferPath)))
    let knowledgeSnapshot: PortableKnowledgeSnapshot | undefined
    if (knowledgeEntry) {
      try {
        knowledgeSnapshot = parsePortableKnowledgeSnapshot(json(fs.readFileSync(
          path.join(attempt.root, PORTABLE_KNOWLEDGE_SOURCE_PATH),
        )))
      } catch { fail('PORTABLE_RESTORE_INVALID') }
    }
    if (authority.targetProjectId !== null || authority.originProjectId !== extracted.manifest.originProjectId
      || authority.snapshotGeneration !== extracted.manifest.snapshotGeneration
      || authority.portableDatabaseSha256 !== databaseEntry.sha256
      || !extracted.manifest.transferReceiptIds.includes(authority.receiptId)
      || await hashFile(databasePath) !== authority.portableDatabaseSha256) fail('PORTABLE_RESTORE_INVALID')
    assertFreeze(json(fs.readFileSync(freezePath)), authority.originProjectId, authority.snapshotGeneration)
    verifyProjectSqlite({ databasePath })
    const database = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true })
    try {
      database.pragma('foreign_keys = ON')
      assertPortableSourceSchema(database)
      verifyPortableTransferAuthority(database, authority)
    } finally {
      database.close()
      for (const suffix of ['-wal', '-shm', '-journal']) captureGeneratedFileIfPresent(attempt, databasePath + suffix)
    }

    let journal = readInstallJournal(targetRoot)
    if (journal && activeInstallJournals.has(normalized(journal.path))) fail('PORTABLE_RESTORE_TARGET_EXISTS')
    if (journal && !sameInstallSource(journal.document, archiveSha256, authority)) fail('PORTABLE_RESTORE_TARGET_EXISTS')

    let targetExists = true
    try { fs.lstatSync(targetRoot) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') targetExists = false
      else fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    }
    if (targetExists) {
      if (journal) {
        reservationOwned(journal, targetRoot)
        cleanupInstallTemporaries(journal, targetRoot)
      }
      const installed = await installedReceipt(targetRoot, authority, extracted.manifest.entries)
      if (installed) {
        if (journal) {
          if (journal.document.targetProjectId !== installed.targetProjectId) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
          activeInstallJournals.add(normalized(journal.path))
          heldJournalPath = journal.path
          releaseInstallJournal(journal, targetRoot, true)
          heldJournalPath = undefined
        } else if (fs.existsSync(path.join(targetRoot, INSTALL_MARKER_NAME))) {
          fail('PORTABLE_RESTORE_UNSAFE_TARGET')
        }
        return installed
      }
      if (!journal) fail('PORTABLE_RESTORE_TARGET_EXISTS')
      reservationOwned(journal, targetRoot)
      activeInstallJournals.add(normalized(journal.path))
      heldJournalPath = journal.path
    } else if (journal) {
      unlinkIdentity(journal.path, journal.identity)
      journal = null
    }

    const targetProjectId = journal?.document.targetProjectId ?? (input.newProjectId ?? randomUUID)()
    if (!UUID.test(targetProjectId) || targetProjectId === authority.originProjectId) fail('PORTABLE_RESTORE_INVALID')
    const storage = path.join(attempt.root, CANONICAL_PROJECT_DIRECTORY)
    mkdirOwned(attempt, storage)
    for (const entry of extracted.manifest.entries) {
      const source = path.join(attempt.root, ...entry.path.split('/'))
      if (contained(storage, source)) continue
      moveOwnedFile(attempt, source, path.join(storage, ...entry.path.split('/')))
    }
    const mappedTransferPath = path.join(storage, 'portable-transfer-authority.json')
    replaceOwnedFile(attempt, mappedTransferPath, serializePortableTransferAuthority(
      mapPortableTransferAuthority(authority, targetProjectId),
    ))
    const projectManifest = createCanonicalProjectManifest({
      projectId: targetProjectId,
      createdAt: (input.now?.() ?? new Date()).toISOString(),
    })
    writeOwnedFile(attempt, path.join(storage, PROJECT_MANIFEST_NAME), Buffer.from(`${JSON.stringify(projectManifest, null, 2)}\n`))
    if (knowledgeSnapshot) {
      try {
        await restorePortableKnowledgeSnapshot(storage, knowledgeSnapshot)
      } catch {
        for (const name of ['lancedb', 'knowledge-copies']) {
          const generated = path.join(storage, name)
          if (fs.existsSync(generated)) captureGeneratedTree(attempt, generated)
        }
        fail('PORTABLE_RESTORE_INVALID')
      }
      for (const name of ['lancedb', 'knowledge-copies']) {
        const generated = path.join(storage, name)
        if (fs.existsSync(generated)) captureGeneratedTree(attempt, generated)
      }
    }
    try {
      if (!readPortableRuntimeFreeze(attempt.root).active) fail('PORTABLE_RESTORE_INVALID')
    } catch (error) {
      if (error instanceof ProjectRestoreServiceError) throw error
      fail('PORTABLE_RESTORE_INVALID')
    }
    for (const suffix of ['-wal', '-shm', '-journal']) removeOwnedFile(attempt, databasePath + suffix)
    removeEmptyOwnedDirectories(attempt, new Set([normalized(attempt.root), normalized(storage)]))
    const rootContents = fs.readdirSync(attempt.root)
    if (rootContents.length !== 1 || rootContents[0] !== CANONICAL_PROJECT_DIRECTORY) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    cancelled(input.signal)

    if (!journal) {
      journal = createInstallJournal(targetRoot, archiveSha256, authority, targetProjectId)
      heldJournalPath = journal.path
      input.__testHooks?.beforeInstall?.(attempt.root, targetRoot)
      cancelled(input.signal)
      try { fs.mkdirSync(targetRoot, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          releaseInstallJournal(journal, targetRoot, false)
          heldJournalPath = undefined
          fail('PORTABLE_RESTORE_TARGET_EXISTS')
        }
        throw error
      }
      try { fs.linkSync(journal.path, path.join(targetRoot, INSTALL_MARKER_NAME)) } catch {
        fail('PORTABLE_RESTORE_UNSAFE_TARGET')
      }
      reservationOwned(journal, targetRoot)
      input.__testHooks?.afterTargetReserved?.(journal.path, targetRoot)
    }
    cancelled(input.signal)
    await installStagedProject(attempt, storage, targetRoot, journal)
    const installed = await installedReceipt(targetRoot, authority, extracted.manifest.entries)
    if (!installed || installed.targetProjectId !== targetProjectId) fail('PORTABLE_RESTORE_UNSAFE_TARGET')
    input.__testHooks?.afterInstallCommitted?.(targetRoot)
    releaseInstallJournal(journal, targetRoot, true)
    heldJournalPath = undefined
    return installed
  } finally {
    if (heldJournalPath) activeInstallJournals.delete(normalized(heldJournalPath))
    cleanupAttempt(attempt)
  }
}
