import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: vi.fn() } }))

import { applyM05CharacterAssets } from '../../migrations/m05-character-assets'
import { CharacterAssetService } from '../character-asset-service'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
const png = (byte = 1): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, byte)])

function fixture() {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f03-runtime-')); roots.push(storageRoot)
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE characters(character_id TEXT PRIMARY KEY,retired INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE character_identity_origins(character_id TEXT PRIMARY KEY REFERENCES characters(character_id),source_key TEXT NOT NULL UNIQUE,original_row_json TEXT NOT NULL,original_hash TEXT NOT NULL);`)
  db.prepare('INSERT INTO characters VALUES(?,0)').run('stable-a')
  db.prepare('INSERT INTO character_identity_origins VALUES(?,?,?,?)').run('stable-a', 'legacy:a', '{}', 'x')
  db.transaction(() => applyM05CharacterAssets(db))()
  const service = new CharacterAssetService({ projectId: 'project-a', sessionLease: 'lease-a', storageRoot, database: db },
    { compress: (bytes, extension) => ({ bytes, extension }) })
  return { storageRoot, db, service }
}

afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('CharacterAssetService', () => {
  it('commits, batch reads, replaces, and removes by stable character id', () => {
    const { db, service, storageRoot } = fixture()
    const first = service.commit('stable-a', png(1).toString('base64'))
    const firstPath = service.repository.read('stable-a')!.relativePath
    expect(first.assetRevision).toBe(1)
    expect(service.readMany(['stable-a'])).toEqual([first])

    const second = service.commit('stable-a', png(2).toString('base64'))
    expect(second.assetRevision).toBe(2)
    expect(fs.existsSync(path.join(storageRoot, ...firstPath.split('/')))).toBe(false)
    service.remove('stable-a')
    expect(service.readMany(['stable-a'])).toEqual([])
    expect(service.repository.read('stable-a')).toBeNull()
    db.close()
  })

  it('removes only the file proven new when the DB update fails', () => {
    const { db, service, storageRoot } = fixture()
    vi.spyOn(service.repository, 'replace').mockImplementation(() => { throw new Error('db failed') })
    expect(() => service.commit('stable-a', png().toString('base64'))).toThrow('db failed')
    const avatarRoot = path.join(storageRoot, 'avatars')
    expect(fs.existsSync(avatarRoot) ? fs.readdirSync(avatarRoot, { recursive: true }).filter(name => String(name).endsWith('.png')) : []).toEqual([])
    db.close()
  })

  it('keeps the committed replacement valid and records the old file when cleanup fails', () => {
    const { db, service, storageRoot } = fixture()
    service.commit('stable-a', png(1).toString('base64'))
    const oldPath = path.join(storageRoot, ...service.repository.read('stable-a')!.relativePath.split('/'))
    const remove = fs.rmSync
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(oldPath)) throw new Error('locked')
      return remove(target, options)
    })

    const replacement = service.commit('stable-a', png(2).toString('base64'))
    expect(replacement.assetRevision).toBe(2)
    expect(service.readMany(['stable-a'])).toEqual([replacement])
    expect(db.prepare('SELECT disposition,preserved_relative_path FROM character_avatar_unresolved').get()).toEqual({
      disposition: 'orphan', preserved_relative_path: path.relative(storageRoot, oldPath).split(path.sep).join('/'),
    })
    db.close()
  })

  it('records crash leftovers without deleting their bytes', () => {
    const { db, service, storageRoot } = fixture()
    const orphan = path.join(storageRoot, 'avatars', 'dead', `1-${'a'.repeat(64)}.png`)
    fs.mkdirSync(path.dirname(orphan), { recursive: true }); fs.writeFileSync(orphan, png())
    expect(service.recordReclaimableOrphans()).toBe(1)
    expect(fs.existsSync(orphan)).toBe(true)
    expect(db.prepare('SELECT disposition,preserved_relative_path FROM character_avatar_unresolved').get()).toEqual({
      disposition: 'orphan', preserved_relative_path: path.relative(storageRoot, orphan).split(path.sep).join('/'),
    })
    db.close()
  })

  it('rejects invalid, oversized, and path-escaping data', () => {
    const { db, service } = fixture()
    expect(() => service.commit('stable-a', Buffer.from('not-image').toString('base64'))).toThrow('IMAGE_FORMAT_INVALID')
    expect(() => service.commit('stable-a', Buffer.concat([png(), Buffer.alloc(4 * 1024 * 1024)]).toString('base64'))).toThrow('IMAGE_TOO_LARGE')
    db.prepare(`INSERT INTO character_avatar_assets VALUES(?,?,?,?,?,?,?)`).run('stable-a', 1, '../outside.png', 'a'.repeat(64), 'image/png', 32, '')
    expect(service.readMany(['stable-a'])).toEqual([])
    db.close()
  })
})
