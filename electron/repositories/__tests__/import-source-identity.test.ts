import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ImportSourceIdentityRepository } from '../import-source-identity-repository'

let root = ''
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-source-id-'))
  initProjectDatabase(root)
})
afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('project-scoped opaque import source identity', () => {
  it('keeps an atomic replacement at the same canonical location stable', () => {
    const secret = Buffer.alloc(32, 7)
    const before = ImportSourceIdentityRepository.digest([{
      canonicalLocation: 'C:\\library\\novel.txt', fileIdentity: 'dev:1:ino:10',
    }], 'reference', secret)
    const replacement = ImportSourceIdentityRepository.digest([{
      canonicalLocation: 'C:\\library\\novel.txt', fileIdentity: 'dev:1:ino:99',
    }], 'reference', secret)

    expect(replacement).toBe(before)
  })

  it('keeps a rename stable by linking the file identity alias to its new location', () => {
    const secret = Buffer.alloc(32, 8)
    const before = ImportSourceIdentityRepository.digest([{
      canonicalLocation: 'C:\\library\\before.txt', fileIdentity: 'dev:1:ino:10',
    }], 'reference', secret)
    const renamed = ImportSourceIdentityRepository.digest([{
      canonicalLocation: 'C:\\archive\\after.txt', fileIdentity: 'dev:1:ino:10',
    }], 'reference', secret)

    expect(renamed).toBe(before)
  })

  it('distinguishes equal names at different locations and namespaces the import purpose', () => {
    const secret = Buffer.alloc(32, 9)
    const firstSource = [{ canonicalLocation: 'C:\\one\\novel.txt', fileIdentity: 'dev:1:ino:10' }]
    const elsewhere = [{ canonicalLocation: 'C:\\two\\novel.txt', fileIdentity: 'dev:2:ino:10' }]
    const first = ImportSourceIdentityRepository.digest(firstSource, 'reference', secret)
    const sameNameElsewhere = ImportSourceIdentityRepository.digest(elsewhere, 'reference', secret)
    const authorNamespace = ImportSourceIdentityRepository.digest(firstSource, 'author-manuscript', secret)

    expect(first).toMatch(/^[a-f0-9]{64}$/u)
    expect(sameNameElsewhere).not.toBe(first)
    expect(authorNamespace).not.toBe(first)
  })

  it('persists only secret-keyed aliases and opaque random source ids', () => {
    const secret = Buffer.alloc(32, 10)
    const source = { canonicalLocation: 'C:\\private\\drafts\\novel.txt', fileIdentity: 'dev:7:ino:88' }
    ImportSourceIdentityRepository.digest([source], 'reference', secret)

    const persisted = JSON.stringify(getProjectDb()!.prepare('SELECT * FROM import_source_aliases').all())
    expect(persisted).not.toContain(source.canonicalLocation)
    expect(persisted).not.toContain(source.fileIdentity)
    expect(persisted).not.toContain(secret.toString('hex'))
    expect(getProjectDb()!.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'import_source_identity'
    `).get()).toEqual({ count: 0 })
  })
})
