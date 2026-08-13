import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROJECT_MANIFEST_RELATIVE_PATH,
  ProjectAccessService,
  type TrustedProject,
} from '../project-access'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const temporaryRoots: string[] = []

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-project-access-'))
  temporaryRoots.push(root)
  fs.mkdirSync(path.join(root, '.vela'), { recursive: true })
  fs.writeFileSync(
    path.join(root, PROJECT_MANIFEST_RELATIVE_PATH),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'ai-novel-project',
      projectId: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-07-26T00:00:00.000Z',
    }),
    'utf8',
  )
  return root
}

function makeLegacyProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-legacy-project-'))
  temporaryRoots.push(root)
  fs.mkdirSync(path.join(root, '.vela'), { recursive: true })
  const database = new Database(path.join(root, '.vela', 'vela.db'))
  database.exec(`
    CREATE TABLE project_core (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      genre TEXT DEFAULT '',
      total_chapters INTEGER DEFAULT 100,
      character_states TEXT DEFAULT ''
    );
    CREATE TABLE blueprints (chapter_number INTEGER PRIMARY KEY);
    CREATE TABLE characters (name TEXT PRIMARY KEY);
    CREATE TABLE contents (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE drafts (id INTEGER PRIMARY KEY, chapter_number INTEGER NOT NULL, content_id INTEGER NOT NULL);
  `)
  database.close()
  return root
}

function makeUnrelatedSqliteRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-unrelated-sqlite-'))
  temporaryRoots.push(root)
  fs.mkdirSync(path.join(root, '.vela'), { recursive: true })
  const database = new Database(path.join(root, '.vela', 'vela.db'))
  database.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY, value TEXT)')
  database.close()
  return root
}

function inventory(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()
}

function trustedProject(access: ProjectAccessService, root: string): TrustedProject {
  const probed = access.probeExistingProject(root)
  if (probed.kind !== 'manifest') throw new Error('Expected a manifest project')
  return probed
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('ProjectAccessService project session seam', () => {
  it('rejects a Windows project whose derived native storage path is unsafe before creating the project root', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-storage-preflight-'))
    temporaryRoots.push(parent)
    const options = {
      homePath: path.join(os.tmpdir(), 'not-the-project-home'),
      platform: 'win32' as NodeJS.Platform,
    }
    const access = new ProjectAccessService(options)
    const projectName = 'x'.repeat(246 - parent.length - 1)
    const requestedRoot = path.join(parent, projectName)
    expect(requestedRoot.length).toBe(246)

    expect(() => access.createProject(parent, projectName)).toThrow(expect.objectContaining({
      code: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
    }))
    expect(fs.existsSync(requestedRoot)).toBe(false)
  })

  it('rejects opening an existing Windows project with an unsafe derived storage path without changing its files', () => {
    const root = makeProjectRoot()
    const before = inventory(root)
    const options = {
      homePath: path.join(os.tmpdir(), 'not-the-project-home'),
      platform: 'win32' as NodeJS.Platform,
      maxNativePathCharacters: 70,
    }
    const access = new ProjectAccessService(options)

    expect(() => access.probeExistingProject(root)).toThrow(expect.objectContaining({
      code: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
    }))
    expect(inventory(root)).toEqual(before)
  })

  it('keeps an existing project recoverable when SQLite is safe but its knowledge-base path is too deep', () => {
    const root = makeProjectRoot()
    const access = new ProjectAccessService({
      homePath: path.join(os.tmpdir(), 'not-the-project-home'),
      platform: 'win32',
      maxNativePathCharacters: 120,
    })

    expect(access.probeExistingProject(root)).toMatchObject({
      kind: 'manifest',
      projectId: '11111111-1111-4111-8111-111111111111',
      rootPath: fs.realpathSync.native(root),
    })
  })

  it('issues a new lease when the same Windows root is reopened and rejects the old lease', () => {
    const root = makeProjectRoot()
    const access = new ProjectAccessService({
      homePath: path.join(os.tmpdir(), 'not-the-project-home'),
      newLeaseId: (() => {
        let next = 0
        return () => `lease-${++next}`
      })(),
    })

    const first = access.beginSession(trustedProject(access, root))
    const reopened = access.beginSession(
      trustedProject(access, root.toLocaleUpperCase('en-US')),
    )

    expect(reopened.projectId).toBe(first.projectId)
    expect(reopened.rootPath).toBe(first.rootPath)
    expect(reopened.leaseId).not.toBe(first.leaseId)
    expect(() => access.assertCurrentSession(first)).toThrow('项目会话已失效')
    expect(access.assertCurrentSession(reopened)).toEqual(reopened)
  })

  it('captures an immutable current-lease snapshot without exposing the live lease object', () => {
    const root = makeProjectRoot()
    const access = new ProjectAccessService({
      homePath: path.join(os.tmpdir(), 'not-the-project-home'),
      newLeaseId: (() => {
        let next = 0
        return () => `lease-${++next}`
      })(),
    })

    const first = access.beginSession(trustedProject(access, root))
    const snapshot = access.captureCurrentSession()
    const reopened = access.beginSession(trustedProject(access, root))

    expect(snapshot).toEqual(first)
    expect(snapshot).not.toBe(first)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot?.leaseId).toBe('lease-1')
    expect(reopened.leaseId).toBe('lease-2')
    expect(() => access.assertCurrentSession(snapshot!)).toThrow('项目会话已失效')
  })

  it('accepts only the active lease bound to the active canonical project root', () => {
    const root = makeProjectRoot()
    const otherRoot = makeProjectRoot()
    const access = new ProjectAccessService({
      homePath: path.join(os.tmpdir(), 'not-the-project-home'),
      newLeaseId: (() => {
        let next = 0
        return () => `lease-${++next}`
      })(),
    })
    const oldLease = access.beginSession(trustedProject(access, root))
    const activeLease = access.beginSession(trustedProject(access, root))

    expect(() => access.assertCurrentProjectContext({
      projectId: oldLease.projectId,
      leaseId: oldLease.leaseId,
      projectPath: root,
    }, root)).toThrow('项目会话已失效')
    expect(access.assertCurrentProjectContext({
      projectId: activeLease.projectId,
      leaseId: activeLease.leaseId,
      projectPath: root.toLocaleUpperCase('en-US'),
    }, root)).toEqual(activeLease)
    expect(() => access.assertCurrentProjectContext({
      projectId: activeLease.projectId,
      leaseId: activeLease.leaseId,
      projectPath: otherRoot,
    }, root)).toThrow('项目会话根目录不匹配')
  })

  it('creates a stable manifest before a new directory can be probed as a project', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-project-parent-'))
    temporaryRoots.push(parent)
    const access = new ProjectAccessService({
      homePath: path.join(os.tmpdir(), 'not-the-project-home'),
    })

    const created = access.createProject(parent, '新小说')
    const manifestPath = path.join(created.rootPath, PROJECT_MANIFEST_RELATIVE_PATH)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: 'ai-novel-project',
      projectId: created.projectId,
    })
    expect(access.probeExistingProject(created.rootPath)).toEqual(created)
  })

  it('allows a new child project below the user home without ever treating the home itself as a project', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-home-parent-'))
    temporaryRoots.push(home)
    const access = new ProjectAccessService({ homePath: home })

    const created = access.createProject(home, 'home-child')

    // Windows may canonicalize a temporary parent from its short (8.3) form
    // to its long form. Project identity is the canonical root, not spelling.
    expect(access.sameCanonicalProjectRoot(created.rootPath, path.join(home, 'home-child'))).toBe(true)
    expect(() => access.probeExistingProject(home)).toThrow('用户主目录')
  })

  it('recognizes only a trusted legacy SQLite fingerprint without writing during probe, then adopts idempotently', () => {
    const root = makeLegacyProjectRoot()
    const access = new ProjectAccessService({
      homePath: path.join(os.tmpdir(), 'not-the-project-home'),
    })
    const beforeProbe = inventory(root)
    const databasePath = path.join(root, '.vela', 'vela.db')
    const beforeBytes = fs.readFileSync(databasePath)

    const legacy = access.probeExistingProject(root)

    expect(legacy).toMatchObject({
      kind: 'legacy',
      legacyFingerprint: 'vela-sqlite-v1',
      rootPath: expect.any(String),
    })
    if (legacy.kind !== 'legacy') throw new Error('Expected a legacy project probe')
    expect(inventory(root)).toEqual(beforeProbe)
    expect(fs.readFileSync(databasePath)).toEqual(beforeBytes)
    const adopted = access.adoptLegacyProject(legacy)
    expect(adopted).toMatchObject({ kind: 'manifest', rootPath: legacy.rootPath })
    expect(fs.readFileSync(databasePath)).toEqual(beforeBytes)
    expect(access.adoptLegacyProject(access.probeExistingProject(root))).toEqual(adopted)
  })

  it('rejects an unrelated SQLite file that merely uses the legacy database filename', () => {
    const root = makeUnrelatedSqliteRoot()
    const access = new ProjectAccessService({
      homePath: path.join(os.tmpdir(), 'not-the-project-home'),
    })

    expect(() => access.probeExistingProject(root)).toThrow('可信旧版指纹')
  })

  it('canonicalizes a Windows junction to the same trusted project root', () => {
    const root = makeProjectRoot()
    const junctionParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-junction-parent-'))
    temporaryRoots.push(junctionParent)
    const junction = path.join(junctionParent, 'project-link')
    fs.symlinkSync(root, junction, 'junction')
    const access = new ProjectAccessService({
      homePath: path.join(os.tmpdir(), 'not-the-project-home'),
    })

    expect(trustedProject(access, junction)).toEqual(trustedProject(access, root))
    expect(access.sameCanonicalProjectRoot(junction, root)).toBe(true)
  })

  it('rejects a project manifest reached through an internal junction that escapes the root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-escaped-root-'))
    temporaryRoots.push(root)
    const externalProject = makeProjectRoot()
    fs.symlinkSync(path.join(externalProject, '.vela'), path.join(root, '.vela'), 'junction')
    const access = new ProjectAccessService({
      homePath: path.join(os.tmpdir(), 'not-the-project-home'),
    })

    expect(() => access.probeExistingProject(root)).toThrow('项目清单越界')
  })

  it('authorizes deletion only for the active leased project root', () => {
    const root = makeProjectRoot()
    const home = makeProjectRoot()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-delete-outside-'))
    temporaryRoots.push(outside)
    const access = new ProjectAccessService({
      homePath: home,
      newLeaseId: () => 'active-lease',
    })
    const lease = access.beginSession(trustedProject(access, root))

    expect(access.authorizeDeletion(lease, root)).toEqual(lease.rootPath)
    expect(() => access.authorizeDeletion(lease, path.dirname(root)))
      .toThrow('当前项目根目录')
    expect(() => access.authorizeDeletion(lease, outside))
      .toThrow('当前项目根目录')
    expect(() => access.authorizeDeletion(lease, path.parse(root).root))
      .toThrow('磁盘根目录')
    expect(() => access.authorizeDeletion(lease, home))
      .toThrow('用户主目录')
    expect(() => access.authorizeDeletion({ ...lease, leaseId: 'old-lease' }, root))
      .toThrow('项目会话已失效')
  })

  it('rejects an ordinary directory, the user home, and a drive root as project roots', () => {
    const ordinaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-ordinary-'))
    temporaryRoots.push(ordinaryDirectory)
    const home = makeProjectRoot()
    const access = new ProjectAccessService({ homePath: home })

    expect(() => access.probeExistingProject(ordinaryDirectory))
      .toThrow('可信旧版指纹')
    expect(() => access.probeExistingProject(home))
      .toThrow('用户主目录')
    expect(() => access.probeExistingProject(path.parse(home).root))
      .toThrow('磁盘根目录')
  })
})
