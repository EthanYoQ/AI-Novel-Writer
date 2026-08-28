import { createHmac, randomUUID } from 'node:crypto'

import { getProjectDb } from '../database'
import type { ImportPurpose, ImportSourceFileIdentity } from '../../src/shared/import-run'
import { MAX_IMPORT_SOURCE_FILES } from '../../src/shared/import-limits'

interface SourceAliasRow {
  alias_digest: string
  source_id: string
}

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
  static digest(
    sources: ImportSourceFileIdentity[],
    purpose: ImportPurpose,
    applicationSecret: Buffer,
  ): string {
    if (purpose !== 'reference' && purpose !== 'author-manuscript') throw new Error('导入用途无效')
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_IMPORT_SOURCE_FILES) {
      throw new Error('导入来源身份无效')
    }
    const secret = requireSecret(applicationSecret)
    const normalized = sources.map(source => ({
      location: normalizedLocation(source.canonicalLocation),
      file: normalizedFileIdentity(source.fileIdentity),
    }))
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
      const sourceIds = normalized.map(source => {
        const locationAlias = aliasDigest(secret, 'location', source.location)
        const fileAlias = source.file ? aliasDigest(secret, 'file', source.file) : undefined
        const locationRow = findAlias.get(locationAlias) as SourceAliasRow | undefined
        const fileRow = fileAlias ? findAlias.get(fileAlias) as SourceAliasRow | undefined : undefined
        // Location is primary so replacing a file in place preserves source
        // identity. The file alias links a later rename to the same opaque id.
        const sourceId = locationRow?.source_id ?? fileRow?.source_id ?? randomUUID()
        upsertAlias.run(locationAlias, 'location', sourceId)
        if (fileAlias) upsertAlias.run(fileAlias, 'file', sourceId)
        return sourceId
      })
      sourceIds.sort((left, right) => left.localeCompare(right, 'en-US'))
      return createHmac('sha256', secret)
        .update(JSON.stringify({ version: 1, purpose, sourceIds }), 'utf8')
        .digest('hex')
    })()
  }
}
