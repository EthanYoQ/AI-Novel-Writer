import fs from 'node:fs'
import path from 'node:path'

import { CANONICAL_PROJECT_DIRECTORY } from '../../src/shared/project-format'

const MAX_BYTES = 4 * 1024 * 1024
const MAX_RECORDS = 100_000
const ID = /^[\p{L}\p{N}._:@+-]{1,512}$/u
const TABLE = /^[a-z][a-z0-9_]{0,127}$/u
const HASH = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const FREEZE_FILE = 'portable-runtime-freeze.json'
const AUTHORITY_FILE = 'portable-transfer-authority.json'

export type PortableRuntimeFreezeTable =
  | 'finalization_outbox'
  | 'import_runs'
  | 'recovery_candidates'
  | 'generation_roots'
  | 'generation_runs'
  | 'generation_attempts'

export class PortableRuntimeFreezeError extends Error {
  constructor(readonly code: 'PORTABLE_RUNTIME_FREEZE_INVALID' | 'PORTABLE_RUNTIME_FROZEN') {
    super(code)
    this.name = 'PortableRuntimeFreezeError'
  }
}

export interface PortableRuntimeFreezeGuard {
  readonly active: boolean
  isFrozen(table: PortableRuntimeFreezeTable, recordId: string): boolean
  assertMutable(table: PortableRuntimeFreezeTable, recordId: string): void
}

const inactive: PortableRuntimeFreezeGuard = Object.freeze({
  active: false,
  isFrozen: () => false,
  assertMutable: () => {},
})

function fail(code: PortableRuntimeFreezeError['code']): never { throw new PortableRuntimeFreezeError(code) }

function normalized(value: string): string {
  const resolved = path.resolve(value).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function physicalDirectory(directory: string): void {
  const absolute = path.resolve(directory)
  let cursor = path.parse(absolute).root
  for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    let info: fs.Stats
    try { info = fs.lstatSync(cursor) } catch { fail('PORTABLE_RUNTIME_FREEZE_INVALID') }
    if (!info.isDirectory() || info.isSymbolicLink() || normalized(fs.realpathSync.native(cursor)) !== normalized(cursor)) {
      fail('PORTABLE_RUNTIME_FREEZE_INVALID')
    }
  }
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function regularFile(file: string, afterOpen?: (file: string) => void): Buffer | null {
  let descriptor: number
  try { descriptor = fs.openSync(file, 'r') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    fail('PORTABLE_RUNTIME_FREEZE_INVALID')
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true })
    afterOpen?.(file)
    const current = fs.lstatSync(file, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(MAX_BYTES)
      || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameFile(opened, current)
      || normalized(fs.realpathSync.native(file)) !== normalized(file)) fail('PORTABLE_RUNTIME_FREEZE_INVALID')
    const bytes = fs.readFileSync(descriptor)
    const final = fs.lstatSync(file, { bigint: true })
    const finalOpened = fs.fstatSync(descriptor, { bigint: true })
    if (bytes.length !== Number(opened.size) || !sameFile(opened, finalOpened) || !sameFile(opened, final)
      || final.isSymbolicLink() || normalized(fs.realpathSync.native(file)) !== normalized(file)) {
      fail('PORTABLE_RUNTIME_FREEZE_INVALID')
    }
    return bytes
  } catch (error) {
    if (error instanceof PortableRuntimeFreezeError) throw error
    fail('PORTABLE_RUNTIME_FREEZE_INVALID')
  } finally { fs.closeSync(descriptor) }
}

function record(value: unknown): { table: PortableRuntimeFreezeTable; recordId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PORTABLE_RUNTIME_FREEZE_INVALID')
  const item = value as Record<string, unknown>
  const keys = ['projectionId', 'table', 'recordId', 'terminalState', 'projection', 'projectionHash', 'excludedFields', 'nonReplayable', 'originalReceiptVerified']
  if (Object.keys(item).length !== keys.length || !keys.every(key => Object.hasOwn(item, key))
    || typeof item.projectionId !== 'string' || !ID.test(item.projectionId) || typeof item.table !== 'string' || !TABLE.test(item.table)
    || typeof item.recordId !== 'string' || !ID.test(item.recordId) || typeof item.terminalState !== 'string' || !ID.test(item.terminalState)
    || !item.projection || typeof item.projection !== 'object' || Array.isArray(item.projection)
    || typeof item.projectionHash !== 'string' || !HASH.test(item.projectionHash)
    || !Array.isArray(item.excludedFields) || item.excludedFields.some(field => typeof field !== 'string' || !ID.test(field))
    || item.nonReplayable !== true || item.originalReceiptVerified !== false) fail('PORTABLE_RUNTIME_FREEZE_INVALID')
  return { table: item.table as PortableRuntimeFreezeTable, recordId: item.recordId }
}

/** Reads the portable history sidecar at the project trust boundary. No marker means a normal project. */
export function readPortableRuntimeFreeze(
  projectRoot: string | null,
  /** @internal Deterministic replacement-race test seam. */
  __testHooks?: { afterOpen?(file: string): void },
): PortableRuntimeFreezeGuard {
  if (!projectRoot) return inactive
  const storageRoot = path.join(path.resolve(projectRoot), CANONICAL_PROJECT_DIRECTORY)
  try { fs.lstatSync(storageRoot) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return inactive
    fail('PORTABLE_RUNTIME_FREEZE_INVALID')
  }
  physicalDirectory(storageRoot)
  const authority = regularFile(path.join(storageRoot, AUTHORITY_FILE), __testHooks?.afterOpen)
  const bytes = regularFile(path.join(storageRoot, FREEZE_FILE), __testHooks?.afterOpen)
  if (!authority && !bytes) return inactive
  if (!bytes) fail('PORTABLE_RUNTIME_FREEZE_INVALID')
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('PORTABLE_RUNTIME_FREEZE_INVALID') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PORTABLE_RUNTIME_FREEZE_INVALID')
  const document = value as Record<string, unknown>
  const keys = ['version', 'originProjectId', 'snapshotGeneration', 'nonReplayable', 'requiresRuntimeFreezeGuard', 'records', 'avatarReferenceProjections']
  if (Object.keys(document).length !== keys.length || !keys.every(key => Object.hasOwn(document, key))
    || document.version !== 1 || typeof document.originProjectId !== 'string' || !UUID.test(document.originProjectId)
    || typeof document.snapshotGeneration !== 'string' || !ID.test(document.snapshotGeneration)
    || document.nonReplayable !== true || document.requiresRuntimeFreezeGuard !== true
    || !Array.isArray(document.records) || document.records.length > MAX_RECORDS
    || !Array.isArray(document.avatarReferenceProjections)) fail('PORTABLE_RUNTIME_FREEZE_INVALID')
  const frozen = new Set<string>()
  for (const item of document.records) {
    const parsed = record(item)
    const key = `${parsed.table}\u0000${parsed.recordId}`
    if (frozen.has(key)) fail('PORTABLE_RUNTIME_FREEZE_INVALID')
    frozen.add(key)
  }
  return Object.freeze({
    active: true,
    isFrozen: (table: PortableRuntimeFreezeTable, recordId: string) => frozen.has(`${table}\u0000${recordId}`),
    assertMutable: (table: PortableRuntimeFreezeTable, recordId: string) => {
      if (frozen.has(`${table}\u0000${recordId}`)) fail('PORTABLE_RUNTIME_FROZEN')
    },
  })
}
