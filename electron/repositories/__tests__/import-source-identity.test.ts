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
  it('distinguishes same-name files in different directories and survives a rename of the same file id', () => {
    const first = ImportSourceIdentityRepository.digest([{ stableFileId: 'volume-1:file-10' }], 'reference')
    const renamed = ImportSourceIdentityRepository.digest([{ stableFileId: 'volume-1:file-10' }], 'reference')
    const sameNameElsewhere = ImportSourceIdentityRepository.digest([{ stableFileId: 'volume-2:file-10' }], 'reference')
    const authorNamespace = ImportSourceIdentityRepository.digest([{ stableFileId: 'volume-1:file-10' }], 'author-manuscript')

    expect(first).toMatch(/^[a-f0-9]{64}$/u)
    expect(renamed).toBe(first)
    expect(sameNameElsewhere).not.toBe(first)
    expect(authorNamespace).not.toBe(first)
    const persisted = JSON.stringify(getProjectDb()!.prepare('SELECT * FROM import_source_identity').all())
    expect(persisted).not.toContain('volume-1')
    expect(persisted).not.toMatch(/[A-Z]:\\/u)
  })
})
