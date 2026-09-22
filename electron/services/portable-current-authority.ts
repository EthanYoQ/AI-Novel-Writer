import fs from 'node:fs'
import path from 'node:path'

import type Database from 'better-sqlite3'

import { readPortableRuntimeFreeze } from './portable-runtime-freeze'
import { parsePortableTransferAuthority, verifyPortableTransferAuthorityHistory } from './portable-transfer-authority'

const MAX_BYTES = 4 * 1024 * 1024
const AUTHORITY_FILE = 'portable-transfer-authority.json'

export interface PortableCurrentAuthority {
  receiptId: string
  originProjectId: string
  snapshotGeneration: string
}

export class PortableCurrentAuthorityError extends Error {
  constructor() {
    super('PORTABLE_CURRENT_AUTHORITY_INVALID')
    this.name = 'PortableCurrentAuthorityError'
  }
}

function invalid(): never { throw new PortableCurrentAuthorityError() }

function normalized(value: string): string {
  const resolved = path.resolve(value).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function readRegular(file: string, afterOpen?: (file: string) => void): Buffer {
  let descriptor: number
  try { descriptor = fs.openSync(file, 'r') } catch { invalid() }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true })
    afterOpen?.(file)
    const current = fs.lstatSync(file, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(MAX_BYTES)
      || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameFile(opened, current)
      || normalized(fs.realpathSync.native(file)) !== normalized(file)) invalid()
    const bytes = fs.readFileSync(descriptor)
    const final = fs.lstatSync(file, { bigint: true })
    const finalOpened = fs.fstatSync(descriptor, { bigint: true })
    if (bytes.length !== Number(opened.size) || !sameFile(opened, finalOpened) || !sameFile(opened, final)
      || final.isSymbolicLink() || normalized(fs.realpathSync.native(file)) !== normalized(file)) invalid()
    return bytes
  } catch (error) {
    if (error instanceof PortableCurrentAuthorityError) throw error
    invalid()
  } finally { fs.closeSync(descriptor) }
}

/** Returns only receipt identity; it never grants old execution authority or source prose. */
export function readPortableCurrentAuthority(input: {
  database: Database.Database
  projectStorageRoot: string
  projectId: string
  /** @internal deterministic replacement-race test seam. */
  __testHooks?: { afterOpen?(file: string): void }
}): PortableCurrentAuthority | null {
  const storageRoot = path.resolve(input.projectStorageRoot)
  let freeze
  try { freeze = readPortableRuntimeFreeze(path.dirname(storageRoot), input.__testHooks) } catch { invalid() }
  if (!freeze.active) return null
  const file = path.join(storageRoot, AUTHORITY_FILE)
  let parsed: unknown
  try { parsed = JSON.parse(readRegular(file, input.__testHooks?.afterOpen).toString('utf8')) } catch { invalid() }
  try {
    const authority = parsePortableTransferAuthority(parsed)
    if (authority.targetProjectId !== input.projectId) invalid()
    verifyPortableTransferAuthorityHistory(input.database, authority)
    return Object.freeze({ receiptId: authority.receiptId, originProjectId: authority.originProjectId, snapshotGeneration: authority.snapshotGeneration })
  } catch (error) {
    if (error instanceof PortableCurrentAuthorityError) throw error
    invalid()
  }
}
