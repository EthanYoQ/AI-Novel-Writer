import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLOUD_CREDENTIAL_SESSION_ONLY_WARNING,
  CloudCredentialStore,
  normalizeWebDavEndpoint,
  type SafeStorageLike,
} from '../cloud-credential-store'

const roots: string[] = []
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-cloud-credential-'))
  roots.push(directory)
  return directory
}

function safeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from([...Buffer.from(value, 'utf8')].map(byte => byte ^ 0xa5)),
    decryptString: value => Buffer.from([...value].map(byte => byte ^ 0xa5)).toString('utf8'),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    ...overrides,
  }
}

function store(directory: string, storage = safeStorage(), platform: NodeJS.Platform = 'win32') {
  return new CloudCredentialStore({
    rootPath: directory,
    safeStorage: storage,
    platform,
    idFactory: () => ACCOUNT_ID,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('normalizeWebDavEndpoint', () => {
  it.each([
    [' HTTPS://Example.COM:443/webdav ', 'https://example.com/webdav/'],
    ['https://example.com/', 'https://example.com/'],
    ['http://localhost:8080/dav', 'http://localhost:8080/dav/'],
    ['http://127.0.0.1:9000/root/', 'http://127.0.0.1:9000/root/'],
    ['http://[::1]:8080/dav', 'http://[::1]:8080/dav/'],
  ])('normalizes an admitted root URL: %s', (input, expected) => {
    expect(normalizeWebDavEndpoint(input)).toBe(expected)
  })

  it.each([
    'http://example.com/dav',
    'ftp://example.com/dav',
    'https://user:secret@example.com/dav',
    'https://example.com/dav?token=x',
    'https://example.com/dav#fragment',
    'not a URL',
  ])('rejects an unsafe endpoint: %s', input => {
    expect(() => normalizeWebDavEndpoint(input)).toThrow('CLOUD_ENDPOINT_INVALID')
  })
})

describe('CloudCredentialStore', () => {
  it('persists only encrypted secret bytes and resolves them after restart', () => {
    const directory = root()
    const first = store(directory)

    const saved = first.save({
      endpoint: 'https://dav.example.test/books',
      username: 'author',
      secret: 'never-write-this-plaintext',
    })

    expect(saved).toEqual({
      metadata: {
        accountId: ACCOUNT_ID,
        endpoint: 'https://dav.example.test/books/',
        username: 'author',
        persistence: 'os-backed',
      },
    })
    const bytes = fs.readFileSync(path.join(directory, 'cloud-backup-credentials.json'), 'utf8')
    expect(bytes).not.toContain('never-write-this-plaintext')
    expect(JSON.stringify(first.list())).not.toContain('encryptedSecret')
    expect(JSON.stringify(first.list())).not.toContain('never-write-this-plaintext')

    expect(store(directory).resolveSecret(ACCOUNT_ID)).toEqual({
      metadata: saved.metadata,
      secret: 'never-write-this-plaintext',
    })
  })

  it('rotates one account in place and persists only the replacement secret', () => {
    const directory = root()
    const credentials = store(directory)
    credentials.save({ endpoint: 'https://dav.example.test/root', username: 'old-user', secret: 'old-secret' })

    const rotated = credentials.save({
      accountId: ACCOUNT_ID,
      endpoint: 'https://dav.example.test/new-root',
      username: 'new-user',
      secret: 'new-secret',
    })

    expect(rotated.metadata).toMatchObject({
      accountId: ACCOUNT_ID,
      endpoint: 'https://dav.example.test/new-root/',
      username: 'new-user',
    })
    expect(store(directory).list()).toHaveLength(1)
    expect(store(directory).resolveSecret(ACCOUNT_ID)?.secret).toBe('new-secret')
    expect(fs.readFileSync(path.join(directory, 'cloud-backup-credentials.json'), 'utf8')).not.toContain('old-secret')
  })

  it('clears both persistent and current-session access for an account', () => {
    const directory = root()
    const credentials = store(directory)
    credentials.save({ endpoint: 'https://dav.example.test/root', username: 'author', secret: 'secret' })

    expect(credentials.clear(ACCOUNT_ID)).toBe(true)
    expect(credentials.resolveSecret(ACCOUNT_ID)).toBeNull()
    expect(store(directory).list()).toEqual([])
  })

  it('keeps a credential in this process only when OS encryption is unavailable', () => {
    const directory = root()
    const credentials = store(directory, safeStorage({ isEncryptionAvailable: () => false }))

    const saved = credentials.save({ endpoint: 'https://dav.example.test/root', username: 'author', secret: 'session-secret' })

    expect(saved.warning).toBe(CLOUD_CREDENTIAL_SESSION_ONLY_WARNING)
    expect(saved.metadata.persistence).toBe('session-only')
    expect(credentials.resolveSecret(ACCOUNT_ID)).toEqual({
      metadata: saved.metadata,
      secret: 'session-secret',
      warning: CLOUD_CREDENTIAL_SESSION_ONLY_WARNING,
    })
    expect(fs.existsSync(path.join(directory, 'cloud-backup-credentials.json'))).toBe(false)
    expect(store(directory).list()).toEqual([])
  })

  it('treats the Linux basic_text backend as session-only', () => {
    const directory = root()
    const credentials = store(directory, safeStorage({ getSelectedStorageBackend: () => 'basic_text' }), 'linux')

    const saved = credentials.save({ endpoint: 'https://dav.example.test/root', username: 'author', secret: 'session-secret' })

    expect(saved.warning).toBe(CLOUD_CREDENTIAL_SESSION_ONLY_WARNING)
    expect(fs.existsSync(path.join(directory, 'cloud-backup-credentials.json'))).toBe(false)
  })

  it('falls back to the current session when encryption throws', () => {
    const directory = root()
    const credentials = store(directory, safeStorage({
      encryptString: () => { throw new Error('keychain failed') },
    }))

    const saved = credentials.save({ endpoint: 'https://dav.example.test/root', username: 'author', secret: 'session-secret' })

    expect(saved.warning).toBe(CLOUD_CREDENTIAL_SESSION_ONLY_WARNING)
    expect(credentials.resolveSecret(ACCOUNT_ID)?.secret).toBe('session-secret')
    expect(fs.existsSync(path.join(directory, 'cloud-backup-credentials.json'))).toBe(false)
  })

  it.each([
    ['OS encryption unavailable', safeStorage({ isEncryptionAvailable: () => false })],
    ['encryption throws', safeStorage({ encryptString: () => { throw new Error('keychain failed') } })],
  ])('removes an old persistent secret before a %s rotation becomes session-only', (_label, unavailableStorage) => {
    const directory = root()
    store(directory).save({ endpoint: 'https://dav.example.test/root', username: 'author', secret: 'old-secret' })
    const sessionStore = store(directory, unavailableStorage)

    const saved = sessionStore.save({
      accountId: ACCOUNT_ID,
      endpoint: 'https://dav.example.test/root',
      username: 'author',
      secret: 'new-secret',
    })

    expect(saved.warning).toBe(CLOUD_CREDENTIAL_SESSION_ONLY_WARNING)
    expect(sessionStore.resolveSecret(ACCOUNT_ID)?.secret).toBe('new-secret')
    expect(store(directory).resolveSecret(ACCOUNT_ID)).toBeNull()
    expect(fs.readFileSync(path.join(directory, 'cloud-backup-credentials.json'), 'utf8')).not.toContain(ACCOUNT_ID)
  })

  it('does not install a session rotation when removing the old persistent secret fails', () => {
    const directory = root()
    store(directory).save({ endpoint: 'https://dav.example.test/root', username: 'author', secret: 'old-secret' })
    const sessionStore = store(directory, safeStorage({ isEncryptionAvailable: () => false }))
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('simulated replace failure') })

    expect(() => sessionStore.save({
      accountId: ACCOUNT_ID,
      endpoint: 'https://dav.example.test/root',
      username: 'author',
      secret: 'new-secret',
    })).toThrow('simulated replace failure')

    vi.restoreAllMocks()
    expect(sessionStore.resolveSecret(ACCOUNT_ID)?.secret).toBeNull()
    expect(store(directory).resolveSecret(ACCOUNT_ID)?.secret).toBe('old-secret')
  })

  it('does not disguise a persistent I/O failure as a successful session-only save', () => {
    const directory = root()
    const blockedRoot = path.join(directory, 'not-a-directory')
    fs.writeFileSync(blockedRoot, 'blocking file')
    const credentials = store(blockedRoot)

    expect(() => credentials.save({
      endpoint: 'https://dav.example.test/root',
      username: 'author',
      secret: 'must-not-be-reported-as-saved',
    })).toThrow()
  })

  it('reports an unavailable persisted secret without exposing ciphertext when decryption fails', () => {
    const directory = root()
    store(directory).save({ endpoint: 'https://dav.example.test/root', username: 'author', secret: 'persistent-secret' })
    const before = fs.readFileSync(path.join(directory, 'cloud-backup-credentials.json'))
    const restarted = store(directory, safeStorage({
      decryptString: () => { throw new Error('keychain locked') },
    }))

    const resolved = restarted.resolveSecret(ACCOUNT_ID)

    expect(resolved).toEqual({
      metadata: {
        accountId: ACCOUNT_ID,
        endpoint: 'https://dav.example.test/root/',
        username: 'author',
        persistence: 'os-backed',
      },
      secret: null,
      warning: CLOUD_CREDENTIAL_SESSION_ONLY_WARNING,
    })
    expect(fs.readFileSync(path.join(directory, 'cloud-backup-credentials.json'))).toEqual(before)
    expect(JSON.stringify(resolved)).not.toContain('encryptedSecret')
  })

  it.each([
    '{not-json',
    JSON.stringify({ version: 2, accounts: [] }),
    JSON.stringify({ version: 1, accounts: [{ accountId: ACCOUNT_ID, endpoint: 'https://dav.example.test/', username: 'author', secret: 'plaintext' }] }),
  ])('fails closed and preserves an invalid store: %s', invalid => {
    const directory = root()
    const file = path.join(directory, 'cloud-backup-credentials.json')
    fs.writeFileSync(file, invalid)
    const credentials = store(directory)

    expect(() => credentials.save({ endpoint: 'https://dav.example.test/root', username: 'author', secret: 'new-secret' }))
      .toThrow('CLOUD_CREDENTIAL_STORE_INVALID')
    expect(() => credentials.clear(ACCOUNT_ID)).toThrow('CLOUD_CREDENTIAL_STORE_INVALID')
    expect(fs.readFileSync(file, 'utf8')).toBe(invalid)
  })
})
