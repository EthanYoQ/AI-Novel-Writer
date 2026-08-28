import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ImportSourceIdentityRepository } from '../import-source-identity-repository'
import { ImportRunRepository } from '../import-run-repository'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

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
  it('returns one stable opaque id per selected source while the collection fingerprint may change', () => {
    const secret = Buffer.alloc(32, 6)
    const sourceA = { canonicalLocation: 'C:\\library\\a.txt', fileIdentity: 'dev:1:ino:10' }
    const sourceB = { canonicalLocation: 'C:\\library\\b.txt', fileIdentity: 'dev:1:ino:20' }

    const first = ImportSourceIdentityRepository.resolveSources([sourceA], 'reference', secret)
    const extended = ImportSourceIdentityRepository.resolveSources([sourceA, sourceB], 'reference', secret)
    const onlyB = ImportSourceIdentityRepository.resolveSources([sourceB], 'reference', secret)

    expect(first.sourceIds).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/iu)])
    expect(extended.sourceIds[0]).toBe(first.sourceIds[0])
    expect(extended.sourceIds[1]).toBe(onlyB.sourceIds[0])
    expect(extended.sourceFingerprints[0]).toBe(first.sourceFingerprint)
    expect(extended.sourceFingerprints[1]).toBe(onlyB.sourceFingerprint)
    expect(extended.sourceFingerprint).not.toBe(first.sourceFingerprint)
  })

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

  it('can move only secret-keyed aliases across the inspection boundary', () => {
    const secret = Buffer.alloc(32, 11)
    const raw = [{ canonicalLocation: 'C:\\private\\drafts\\novel.txt', fileIdentity: 'dev:7:ino:99' }]

    const encoded = ImportSourceIdentityRepository.encodeSources(raw, 'reference', secret)
    const serialized = JSON.stringify(encoded)
    expect(serialized).not.toContain(raw[0].canonicalLocation)
    expect(serialized).not.toContain(raw[0].fileIdentity)
    expect(serialized).not.toContain(secret.toString('hex'))
    expect(encoded).toEqual([{
      locationAliasDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      fileAliasDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }])

    const resolved = ImportSourceIdentityRepository.resolveEncodedSources(encoded, 'reference', secret)
    expect(resolved.sourceIds).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/iu)])
  })

  it('bridges the earliest salted identity and adopts only the reauthorized same source', () => {
    const applicationSecret = Buffer.alloc(32, 12)
    const oldSalt = Buffer.alloc(32, 13)
    const raw = { canonicalLocation: 'C:\\library\\legacy.txt', fileIdentity: 'dev:9:ino:42' }
    const oldFingerprint = createHmac('sha256', oldSalt)
      .update(JSON.stringify({ purpose: 'reference', identities: [raw.fileIdentity] }), 'utf8')
      .digest('hex')
    const content = 'legacy frozen chapter'
    const contentFingerprint = createHash('sha256').update(content).digest('hex')

    ImportRunRepository.prepare({
      runId: 'old-completed-run',
      purpose: 'reference',
      sourceFingerprint: oldFingerprint,
      sourceDisplay: [{ displayName: 'legacy.txt', mediaType: 'text/plain', size: content.length }],
      locale: 'en-US',
      chapters: [{ number: 1, title: 'Legacy 1', content, contentFingerprint, contentSize: content.length }],
    })
    getProjectDb()!.prepare(`
      UPDATE import_runs SET stage = 'completed', status = 'completed', resumable = 0,
        completed_chapters = total_chapters, completed_at = datetime('now')
      WHERE id = 'old-completed-run'
    `).run()
    closeProjectDatabase()
    const offline = new Database(path.join(root, '.vela', 'vela.db'))
    offline.exec(`CREATE TABLE import_source_identity (
      id TEXT PRIMARY KEY, salt_hex TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    offline.prepare('INSERT INTO import_source_identity (id, salt_hex) VALUES (?, ?)')
      .run('main', oldSalt.toString('hex'))
    offline.close()

    initProjectDatabase(root, applicationSecret)
    const serialized = JSON.stringify(getProjectDb()!.prepare('SELECT * FROM import_legacy_identity_bridge').all())
    expect(serialized).not.toContain(oldSalt.toString('hex'))
    expect(getProjectDb()!.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'import_source_identity'`).get()).toEqual({ count: 0 })

    const resolved = ImportSourceIdentityRepository.resolveSources([raw], 'reference', applicationSecret)
    expect(resolved.legacyCollectionFingerprint).toBe(oldFingerprint)
    const parsing = ImportRunRepository.beginParsing({
      runId: 'reauthorized-run',
      purpose: 'reference',
      sourceFingerprint: resolved.sourceFingerprint,
      sourceIds: resolved.sourceIds,
      sourceFingerprints: resolved.sourceFingerprints,
      legacySourceFingerprints: resolved.legacySourceFingerprints,
      legacyCollectionFingerprint: resolved.legacyCollectionFingerprint,
      sourceDisplay: [{ displayName: 'legacy.txt', mediaType: 'text/plain', size: content.length }],
      locale: 'en-US',
    })
    ImportRunRepository.commitParsedSource(parsing.id, resolved.sourceIds[0]!, [{
      number: 1, sourceChapterNumber: 1, title: 'Legacy 1', content, contentFingerprint, contentSize: content.length,
    }])
    expect(ImportRunRepository.finalizeParsing(parsing.id)).toMatchObject({ classification: 'exact-duplicate' })
    expect(getProjectDb()!.prepare(`SELECT source_id FROM import_run_chapters
      WHERE run_id = 'old-completed-run'`).get()).toEqual({ source_id: resolved.sourceIds[0] })

    const elsewhere = ImportSourceIdentityRepository.resolveSources([{
      canonicalLocation: 'C:\\elsewhere\\legacy.txt', fileIdentity: 'dev:10:ino:42',
    }], 'reference', applicationSecret)
    expect(elsewhere.legacyCollectionFingerprint).not.toBe(oldFingerprint)
  })
})
