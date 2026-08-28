import { createHmac, randomBytes } from 'node:crypto'

import { getProjectDb } from '../database'
import type { ImportPurpose } from '../../src/shared/import-run'

export interface ImportSourceFileIdentity {
  stableFileId: string
}

function database() {
  const current = getProjectDb()
  if (!current) throw new Error('项目数据库未打开')
  return current
}

function projectSalt(): Buffer {
  const db = database()
  const existing = db.prepare('SELECT salt_hex FROM import_source_identity WHERE id = ?')
    .get('main') as { salt_hex: string } | undefined
  if (existing) return Buffer.from(existing.salt_hex, 'hex')
  const salt = randomBytes(32)
  db.prepare('INSERT INTO import_source_identity (id, salt_hex) VALUES (?, ?)')
    .run('main', salt.toString('hex'))
  return salt
}

export class ImportSourceIdentityRepository {
  static digest(sources: ImportSourceFileIdentity[], purpose: ImportPurpose): string {
    if (purpose !== 'reference' && purpose !== 'author-manuscript') throw new Error('导入用途无效')
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > 16_384) {
      throw new Error('导入来源身份无效')
    }
    const identities = sources.map(source => source.stableFileId?.trim())
    if (identities.some(identity => !identity || identity.length > 1_024)) {
      throw new Error('导入来源文件身份无效')
    }
    identities.sort((left, right) => left.localeCompare(right, 'en-US'))
    return createHmac('sha256', projectSalt())
      .update(JSON.stringify({ purpose, identities }), 'utf8')
      .digest('hex')
  }
}
