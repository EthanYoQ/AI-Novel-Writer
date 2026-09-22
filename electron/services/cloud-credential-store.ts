import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { tryReadJsonFile, writeJsonFile } from '../utils/config-utils'
import { getGlobalDataRoot } from './app-data-locator'

export const CLOUD_CREDENTIAL_SESSION_ONLY_WARNING = 'CLOUD_CREDENTIAL_SESSION_ONLY' as const

const STORE_FILE_NAME = 'cloud-backup-credentials.json'
const STORE_VERSION = 1
const MAX_ACCOUNTS = 128
const MAX_ENDPOINT_LENGTH = 2_048
const MAX_USERNAME_LENGTH = 1_024
const MAX_SECRET_BYTES = 64 * 1_024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface CloudCredentialMetadata {
  accountId: string
  endpoint: string
  username: string
  persistence: 'os-backed' | 'session-only'
}

export interface CloudCredentialSaveInput {
  accountId?: string
  endpoint: string
  username: string
  secret: string
}

export interface CloudCredentialSaveResult {
  metadata: CloudCredentialMetadata
  warning?: typeof CLOUD_CREDENTIAL_SESSION_ONLY_WARNING
}

export interface ResolvedCloudCredential {
  metadata: CloudCredentialMetadata
  secret: string | null
  warning?: typeof CLOUD_CREDENTIAL_SESSION_ONLY_WARNING
}

interface StoredCredential {
  accountId: string
  endpoint: string
  username: string
  encryptedSecretBase64: string
}

interface CredentialDocument {
  version: typeof STORE_VERSION
  accounts: StoredCredential[]
}

interface SessionCredential {
  metadata: CloudCredentialMetadata
  secret: string
}

export interface CloudCredentialStoreOptions {
  safeStorage: SafeStorageLike
  rootPath?: string
  platform?: NodeJS.Platform
  idFactory?: () => string
}

function fail(code: 'CLOUD_ENDPOINT_INVALID' | 'CLOUD_CREDENTIAL_INPUT_INVALID' | 'CLOUD_CREDENTIAL_STORE_INVALID'): never {
  throw new Error(code)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) return true
  }
  return false
}

function validBase64(value: string): boolean {
  if (!value || value.length > MAX_SECRET_BYTES * 2 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false
  try {
    return Buffer.from(value, 'base64').toString('base64') === value
  } catch {
    return false
  }
}

function validUsername(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_USERNAME_LENGTH && !containsControlCharacter(value)
}

function validSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_SECRET_BYTES
}

export function normalizeWebDavEndpoint(value: string): string {
  if (typeof value !== 'string') fail('CLOUD_ENDPOINT_INVALID')
  const candidate = value.trim()
  if (!candidate || candidate.length > MAX_ENDPOINT_LENGTH || containsControlCharacter(candidate)
    || candidate.includes('?') || candidate.includes('#')) fail('CLOUD_ENDPOINT_INVALID')

  let endpoint: URL
  try { endpoint = new URL(candidate) } catch { return fail('CLOUD_ENDPOINT_INVALID') }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail('CLOUD_ENDPOINT_INVALID')
  const hostname = endpoint.hostname.toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) fail('CLOUD_ENDPOINT_INVALID')
  endpoint.pathname = endpoint.pathname.endsWith('/') ? endpoint.pathname : `${endpoint.pathname}/`
  return endpoint.toString()
}

function parseDocument(value: unknown): CredentialDocument {
  if (!record(value) || !exactKeys(value, ['version', 'accounts'])
    || value.version !== STORE_VERSION || !Array.isArray(value.accounts)
    || value.accounts.length > MAX_ACCOUNTS) fail('CLOUD_CREDENTIAL_STORE_INVALID')
  const seen = new Set<string>()
  const accounts = value.accounts.map(item => {
    if (!record(item) || !exactKeys(item, ['accountId', 'endpoint', 'username', 'encryptedSecretBase64'])
      || typeof item.accountId !== 'string' || !UUID.test(item.accountId) || seen.has(item.accountId)
      || !validUsername(item.username) || typeof item.endpoint !== 'string'
      || typeof item.encryptedSecretBase64 !== 'string' || !validBase64(item.encryptedSecretBase64)) {
      return fail('CLOUD_CREDENTIAL_STORE_INVALID')
    }
    let endpoint: string
    try { endpoint = normalizeWebDavEndpoint(item.endpoint) } catch { return fail('CLOUD_CREDENTIAL_STORE_INVALID') }
    if (endpoint !== item.endpoint) fail('CLOUD_CREDENTIAL_STORE_INVALID')
    seen.add(item.accountId)
    return {
      accountId: item.accountId,
      endpoint,
      username: item.username,
      encryptedSecretBase64: item.encryptedSecretBase64,
    }
  })
  return { version: STORE_VERSION, accounts }
}

export class CloudCredentialStore {
  private readonly filePath: string
  private readonly safeStorage: SafeStorageLike
  private readonly platform: NodeJS.Platform
  private readonly idFactory: () => string
  private readonly session = new Map<string, SessionCredential>()

  constructor(options: CloudCredentialStoreOptions) {
    this.safeStorage = options.safeStorage
    this.platform = options.platform ?? process.platform
    this.idFactory = options.idFactory ?? randomUUID
    this.filePath = path.join(options.rootPath ?? getGlobalDataRoot(), STORE_FILE_NAME)
  }

  list(): CloudCredentialMetadata[] {
    const metadata = new Map(this.loadDocument().accounts.map(account => [account.accountId, this.metadata(account)]))
    for (const [accountId, credential] of this.session) metadata.set(accountId, credential.metadata)
    return [...metadata.values()]
  }

  save(input: CloudCredentialSaveInput): CloudCredentialSaveResult {
    const endpoint = normalizeWebDavEndpoint(input.endpoint)
    if (!validUsername(input.username) || !validSecret(input.secret)) fail('CLOUD_CREDENTIAL_INPUT_INVALID')
    const accountId = input.accountId ?? this.idFactory()
    if (!UUID.test(accountId)) fail('CLOUD_CREDENTIAL_INPUT_INVALID')
    const document = this.loadDocument()

    if (!this.persistentEncryptionAvailable()) {
      return this.saveSession(document, accountId, endpoint, input.username, input.secret)
    }
    let encryptedSecretBase64: string
    try {
      encryptedSecretBase64 = this.safeStorage.encryptString(input.secret).toString('base64')
      if (!validBase64(encryptedSecretBase64)) throw new Error('encrypted secret is empty or too large')
    } catch {
      return this.saveSession(document, accountId, endpoint, input.username, input.secret)
    }

    const stored: StoredCredential = { accountId, endpoint, username: input.username, encryptedSecretBase64 }
    const accounts = document.accounts.filter(account => account.accountId !== accountId)
    if (accounts.length >= MAX_ACCOUNTS) fail('CLOUD_CREDENTIAL_INPUT_INVALID')
    accounts.push(stored)
    writeJsonFile(this.filePath, { version: STORE_VERSION, accounts } satisfies CredentialDocument)
    this.session.delete(accountId)
    return { metadata: this.metadata(stored) }
  }

  resolveSecret(accountId: string): ResolvedCloudCredential | null {
    const session = this.session.get(accountId)
    if (session) return {
      metadata: session.metadata,
      secret: session.secret,
      warning: session.metadata.persistence === 'session-only' ? CLOUD_CREDENTIAL_SESSION_ONLY_WARNING : undefined,
    }
    const stored = this.loadDocument().accounts.find(account => account.accountId === accountId)
    if (!stored) return null
    const metadata = this.metadata(stored)
    if (!this.persistentEncryptionAvailable()) {
      return { metadata, secret: null, warning: CLOUD_CREDENTIAL_SESSION_ONLY_WARNING }
    }
    try {
      const secret = this.safeStorage.decryptString(Buffer.from(stored.encryptedSecretBase64, 'base64'))
      if (!validSecret(secret)) throw new Error('decrypted secret is invalid')
      return { metadata, secret }
    } catch {
      return { metadata, secret: null, warning: CLOUD_CREDENTIAL_SESSION_ONLY_WARNING }
    }
  }

  clear(accountId: string): boolean {
    const document = this.loadDocument()
    const removedSession = this.session.delete(accountId)
    const accounts = document.accounts.filter(account => account.accountId !== accountId)
    if (accounts.length === document.accounts.length) return removedSession
    writeJsonFile(this.filePath, { version: STORE_VERSION, accounts } satisfies CredentialDocument)
    return true
  }

  private loadDocument(): CredentialDocument {
    const read = tryReadJsonFile<unknown>(this.filePath)
    if (read.status === 'missing') return { version: STORE_VERSION, accounts: [] }
    if (read.status === 'error') fail('CLOUD_CREDENTIAL_STORE_INVALID')
    return parseDocument(read.value)
  }

  private metadata(account: Pick<StoredCredential, 'accountId' | 'endpoint' | 'username'>): CloudCredentialMetadata {
    return {
      accountId: account.accountId,
      endpoint: account.endpoint,
      username: account.username,
      persistence: 'os-backed',
    }
  }

  private persistentEncryptionAvailable(): boolean {
    try {
      if (!this.safeStorage.isEncryptionAvailable()) return false
      if (this.platform !== 'linux') return true
      const backend = this.safeStorage.getSelectedStorageBackend?.()
      return backend === 'gnome_libsecret' || backend === 'kwallet' || backend === 'kwallet5' || backend === 'kwallet6'
    } catch {
      return false
    }
  }

  private saveSession(document: CredentialDocument, accountId: string, endpoint: string, username: string, secret: string): CloudCredentialSaveResult {
    const accounts = document.accounts.filter(account => account.accountId !== accountId)
    if (accounts.length !== document.accounts.length) {
      writeJsonFile(this.filePath, { version: STORE_VERSION, accounts } satisfies CredentialDocument)
    }
    const metadata: CloudCredentialMetadata = { accountId, endpoint, username, persistence: 'session-only' }
    this.session.set(accountId, { metadata, secret })
    return { metadata, warning: CLOUD_CREDENTIAL_SESSION_ONLY_WARNING }
  }
}
