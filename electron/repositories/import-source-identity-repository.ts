import { createHmac, randomUUID } from 'node:crypto'

import { getProjectDb } from '../database'
import type { ImportPurpose, ImportSourceFileIdentity } from '../../src/shared/import-run'
import { MAX_IMPORT_SOURCE_FILES } from '../../src/shared/import-limits'

interface SourceAliasRow {
  alias_digest: string
  source_id: string
}

export interface EncodedImportSourceIdentity {
  locationAliasDigest: string
  fileAliasDigest?: string
}

const SHA256 = /^[a-f0-9]{64}$/u

function database() {
  const current = getProjectDb()
  if (!current) throw new Error('项目数据库未打开')
  return current
}

function requireSecret(secret: Buffer): Buffer {
  if (!Buffer.isBuffer(secret) || secret.byteLength < 32) throw new Error('导入来源应用密钥无效')
  return secret
}

function normalizedLocation(value: string): string {
  const location = value?.trim().normalize('NFC')
  if (!location || location.length > 32_000 || location.includes('\0')) throw new Error('导入来源位置身份无效')
  return process.platform === 'win32' ? location.toLocaleLowerCase('en-US') : location
}

function normalizedFileIdentity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const identity = value.trim()
  if (!identity || identity.length > 1_024 || identity.includes('\0')) throw new Error('导入来源文件身份无效')
  return identity
}

function aliasDigest(secret: Buffer, kind: 'location' | 'file', value: string): string {
  return createHmac('sha256', secret).update(`import-source-alias:v1:${kind}:${value}`, 'utf8').digest('hex')
}

export class ImportSourceIdentityRepository {
  static encodeSources(
    sources: ImportSourceFileIdentity[],
    purpose: ImportPurpose,
    applicationSecret: Buffer,
  ): EncodedImportSourceIdentity[] {
    if (purpose !== 'reference' && purpose !== 'author-manuscript') throw new Error('导入用途无效')
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_IMPORT_SOURCE_FILES) {
      throw new Error('导入来源身份无效')
    }
    const secret = requireSecret(applicationSecret)
    return sources.map(source => {
      const location = normalizedLocation(source.canonicalLocation)
      const file = normalizedFileIdentity(source.fileIdentity)
      return {
        locationAliasDigest: aliasDigest(secret, 'location', location),
        ...(file ? { fileAliasDigest: aliasDigest(secret, 'file', file) } : {}),
      }
    })
  }

  static resolveEncodedSources(
    sources: EncodedImportSourceIdentity[],
    purpose: ImportPurpose,
    applicationSecret: Buffer,
  ): { sourceIds: string[]; sourceFingerprint: string; sourceFingerprints: string[] } {
    if (purpose !== 'reference' && purpose !== 'author-manuscript') throw new Error('导入用途无效')
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_IMPORT_SOURCE_FILES) {
      throw new Error('导入来源身份无效')
    }
    for (const source of sources) {
      if (!SHA256.test(source.locationAliasDigest) || (source.fileAliasDigest && !SHA256.test(source.fileAliasDigest))) {
        throw new Error('导入来源别名无效')
      }
    }
    const secret = requireSecret(applicationSecret)
    const db = database()

    return db.transaction(() => {
      const findAlias = db.prepare(`
        SELECT alias_digest, source_id FROM import_source_aliases WHERE alias_digest = ?
      `)
      const upsertAlias = db.prepare(`
        INSERT INTO import_source_aliases (alias_digest, alias_kind, source_id)
        VALUES (?, ?, ?)
        ON CONFLICT(alias_digest) DO UPDATE SET alias_kind = excluded.alias_kind, source_id = excluded.source_id
      `)
      const sourceIds = sources.map(source => {
        const locationRow = findAlias.get(source.locationAliasDigest) as SourceAliasRow | undefined
        const fileRow = source.fileAliasDigest
          ? findAlias.get(source.fileAliasDigest) as SourceAliasRow | undefined
          : undefined
        // Location is primary so replacing a file in place preserves source
        // identity. The file alias links a later rename to the same opaque id.
        const sourceId = locationRow?.source_id ?? fileRow?.source_id ?? randomUUID()
        upsertAlias.run(source.locationAliasDigest, 'location', sourceId)
        if (source.fileAliasDigest) upsertAlias.run(source.fileAliasDigest, 'file', sourceId)
        return sourceId
      })
      const sortedSourceIds = [...sourceIds].sort((left, right) => left.localeCompare(right, 'en-US'))
      const fingerprint = (ids: string[]) => createHmac('sha256', secret)
        .update(JSON.stringify({ version: 1, purpose, sourceIds: [...ids].sort((left, right) => left.localeCompare(right, 'en-US')) }), 'utf8')
        .digest('hex')
      return {
        sourceIds,
        sourceFingerprint: fingerprint(sortedSourceIds),
        sourceFingerprints: sourceIds.map(sourceId => fingerprint([sourceId])),
      }
    })()
  }

  static resolveSources(
    sources: ImportSourceFileIdentity[],
    purpose: ImportPurpose,
    applicationSecret: Buffer,
  ): { sourceIds: string[]; sourceFingerprint: string; sourceFingerprints: string[] } {
    return this.resolveEncodedSources(
      this.encodeSources(sources, purpose, applicationSecret),
      purpose,
      applicationSecret,
    )
  }

  static digest(
    sources: ImportSourceFileIdentity[],
    purpose: ImportPurpose,
    applicationSecret: Buffer,
  ): string {
    return this.resolveSources(sources, purpose, applicationSecret).sourceFingerprint
  }
}
