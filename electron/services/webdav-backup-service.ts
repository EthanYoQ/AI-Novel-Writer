import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { normalizeWebDavEndpoint } from './cloud-credential-store'

export type WebDavBackupErrorCode =
  | 'WEBDAV_INPUT_INVALID'
  | 'WEBDAV_AUTH'
  | 'WEBDAV_NETWORK'
  | 'WEBDAV_NOT_FOUND'
  | 'WEBDAV_REMOTE_CONFLICT'
  | 'WEBDAV_REMOTE_INVALID'
  | 'WEBDAV_DAV_RESPONSE_INVALID'
  | 'WEBDAV_RESPONSE_TOO_LARGE'
  | 'WEBDAV_CANCELLED'
  | 'WEBDAV_TARGET_EXISTS'
  | 'WEBDAV_TARGET_UNSAFE'
  | 'WEBDAV_PUBLISH_FAILED'

export class WebDavBackupError extends Error {
  constructor(readonly code: WebDavBackupErrorCode) {
    super(code)
    this.name = 'WebDavBackupError'
  }
}

export interface WebDavAccount {
  endpoint: string
  username: string
  secret: string
}

export interface WebDavGeneration {
  cloudBookId: string
  generationId: string
  parentGenerationIds: string[]
  createdAt: string
  originProjectId: string
  portableSnapshotGeneration: string
  archiveSha256: string
  archiveByteSize: number
  hasSibling: boolean
  siblingGenerationIds: string[]
}

export interface AppendWebDavGenerationInput {
  account: WebDavAccount
  cloudBookId: string
  archivePath: string
  originProjectId: string
  portableSnapshotGeneration: string
  parentGenerationIds: readonly string[]
  signal?: AbortSignal
}

export interface ListWebDavGenerationsInput {
  account: WebDavAccount
  cloudBookId: string
  signal?: AbortSignal
}

export interface DownloadWebDavGenerationInput extends ListWebDavGenerationsInput {
  generationId: string
  targetArchivePath: string
}

export interface WebDavBackupServiceOptions {
  fetchImpl?: typeof fetch
  generationIdFactory?: () => string
  now?: () => Date
  timeoutMs?: number
  maxXmlBytes?: number
  maxJsonBytes?: number
  maxArchiveBytes?: number
}

interface ArchiveDescriptor {
  file: 'archive.ainovel'
  sha256: string
  byteSize: number
}

interface GenerationManifest {
  version: 1
  cloudBookId: string
  generationId: string
  parentGenerationIds: string[]
  createdAt: string
  originProjectId: string
  portableSnapshotGeneration: string
  archive: ArchiveDescriptor
}

interface CompletionDescriptor {
  version: 1
  cloudBookId: string
  generationId: string
  manifest: { file: 'manifest.json'; sha256: string; byteSize: number }
  archive: ArchiveDescriptor
  completedAt: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_XML_BYTES = 1024 * 1024
const DEFAULT_MAX_JSON_BYTES = 1024 * 1024
const DEFAULT_MAX_ARCHIVE_BYTES = 16 * 1024 ** 3
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$/u
const HASH = /^[a-f0-9]{64}$/u
const MAX_PARENTS = 256

function fail(code: WebDavBackupErrorCode): never { throw new WebDavBackupError(code) }

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeId(value: unknown): value is string { return typeof value === 'string' && SAFE_ID.test(value) }

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint >= 0x7f && codePoint <= 0x9f)) return true
  }
  return false
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
}

function parentIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PARENTS || value.some(item => !safeId(item))) return null
  return new Set(value).size === value.length ? [...value] as string[] : null
}

function archiveDescriptor(value: unknown): ArchiveDescriptor | null {
  if (!record(value) || !exactKeys(value, ['file', 'sha256', 'byteSize']) || value.file !== 'archive.ainovel'
    || typeof value.sha256 !== 'string' || !HASH.test(value.sha256) || !integer(value.byteSize)) return null
  return { file: 'archive.ainovel', sha256: value.sha256, byteSize: value.byteSize }
}

function parseManifest(value: unknown): GenerationManifest {
  if (!record(value) || !exactKeys(value, [
    'version', 'cloudBookId', 'generationId', 'parentGenerationIds', 'createdAt',
    'originProjectId', 'portableSnapshotGeneration', 'archive',
  ]) || value.version !== 1 || !safeId(value.cloudBookId) || typeof value.generationId !== 'string'
    || !UUID.test(value.generationId) || typeof value.originProjectId !== 'string' || !UUID.test(value.originProjectId)
    || !safeId(value.portableSnapshotGeneration) || !timestamp(value.createdAt)) fail('WEBDAV_REMOTE_INVALID')
  const parents = parentIds(value.parentGenerationIds)
  const archive = archiveDescriptor(value.archive)
  if (!parents || !archive) fail('WEBDAV_REMOTE_INVALID')
  return {
    version: 1,
    cloudBookId: value.cloudBookId,
    generationId: value.generationId,
    parentGenerationIds: parents,
    createdAt: value.createdAt,
    originProjectId: value.originProjectId,
    portableSnapshotGeneration: value.portableSnapshotGeneration,
    archive,
  }
}

function parseCompletion(value: unknown): CompletionDescriptor {
  if (!record(value) || !exactKeys(value, ['version', 'cloudBookId', 'generationId', 'manifest', 'archive', 'completedAt'])
    || value.version !== 1 || !safeId(value.cloudBookId) || typeof value.generationId !== 'string'
    || !UUID.test(value.generationId) || !timestamp(value.completedAt) || !record(value.manifest)
    || !exactKeys(value.manifest, ['file', 'sha256', 'byteSize']) || value.manifest.file !== 'manifest.json'
    || typeof value.manifest.sha256 !== 'string' || !HASH.test(value.manifest.sha256)
    || !integer(value.manifest.byteSize)) fail('WEBDAV_REMOTE_INVALID')
  const archive = archiveDescriptor(value.archive)
  if (!archive) fail('WEBDAV_REMOTE_INVALID')
  return {
    version: 1,
    cloudBookId: value.cloudBookId,
    generationId: value.generationId,
    manifest: { file: 'manifest.json', sha256: value.manifest.sha256, byteSize: value.manifest.byteSize },
    archive,
    completedAt: value.completedAt,
  }
}

function json(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { return fail('WEBDAV_REMOTE_INVALID') }
}

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

async function hashFile(file: string, maximum: number): Promise<{ sha256: string; byteSize: number }> {
  const info = fs.lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) fail('WEBDAV_INPUT_INVALID')
  const digest = createHash('sha256')
  let byteSize = 0
  for await (const value of fs.createReadStream(file)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    byteSize += chunk.length
    if (byteSize > maximum) fail('WEBDAV_INPUT_INVALID')
    digest.update(chunk)
  }
  return { sha256: digest.digest('hex'), byteSize }
}

function decodeEntity(value: string): string {
  return value.replace(/&([^;]+);/gu, (_whole, entity: string) => {
    if (entity === 'amp') return '&'
    if (entity === 'lt') return '<'
    if (entity === 'gt') return '>'
    if (entity === 'quot') return '"'
    if (entity === 'apos') return "'"
    const match = /^#(x[0-9a-f]+|[0-9]+)$/iu.exec(entity)
    if (!match) return fail('WEBDAV_DAV_RESPONSE_INVALID')
    const codePoint = match[1]!.toLowerCase().startsWith('x')
      ? Number.parseInt(match[1]!.slice(1), 16)
      : Number.parseInt(match[1]!, 10)
    if (!Number.isSafeInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff
      || codePoint >= 0xd800 && codePoint <= 0xdfff) return fail('WEBDAV_DAV_RESPONSE_INVALID')
    return String.fromCodePoint(codePoint)
  })
}

function generationHrefs(xml: string, generationsUrl: URL): string[] {
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<![^-]/iu.test(xml)) fail('WEBDAV_DAV_RESPONSE_INVALID')
  const responsePattern = /<(?:[A-Za-z_][\w.-]*:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?response\s*>/giu
  const openingCount = [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?response\b/giu)].length
  const responses = [...xml.matchAll(responsePattern)]
  if (responses.length !== openingCount || responses.length === 0) fail('WEBDAV_DAV_RESPONSE_INVALID')
  let rootPath: string
  try { rootPath = decodeURIComponent(generationsUrl.pathname) } catch { return fail('WEBDAV_DAV_RESPONSE_INVALID') }
  if (!rootPath.endsWith('/')) rootPath += '/'
  const generations: string[] = []
  for (const response of responses) {
    const hrefs = [...response[1]!.matchAll(/<(?:[A-Za-z_][\w.-]*:)?href\b[^>]*>([^<]*)<\/(?:[A-Za-z_][\w.-]*:)?href\s*>/giu)]
    if (hrefs.length !== 1) fail('WEBDAV_DAV_RESPONSE_INVALID')
    const href = decodeEntity(hrefs[0]![1]!.trim())
    if (!href || href.startsWith('//')) fail('WEBDAV_DAV_RESPONSE_INVALID')
    let candidate: URL
    try { candidate = new URL(href, generationsUrl) } catch { return fail('WEBDAV_DAV_RESPONSE_INVALID') }
    if (candidate.origin !== generationsUrl.origin || candidate.username || candidate.password || candidate.search || candidate.hash) {
      fail('WEBDAV_DAV_RESPONSE_INVALID')
    }
    let decoded: string
    try { decoded = decodeURIComponent(candidate.pathname) } catch { return fail('WEBDAV_DAV_RESPONSE_INVALID') }
    if (containsControlCharacter(decoded) || decoded.includes('\\')) fail('WEBDAV_DAV_RESPONSE_INVALID')
    if (decoded === rootPath || decoded === rootPath.slice(0, -1)) continue
    if (!decoded.startsWith(rootPath)) fail('WEBDAV_DAV_RESPONSE_INVALID')
    const relative = decoded.slice(rootPath.length).replace(/\/$/u, '')
    if (!UUID.test(relative) || relative.includes('/')) fail('WEBDAV_DAV_RESPONSE_INVALID')
    generations.push(relative)
  }
  return [...new Set(generations)]
}

function responseFailure(response: Response): never {
  response.body?.cancel().catch(() => {})
  if (response.status === 401 || response.status === 403) fail('WEBDAV_AUTH')
  if (response.status === 404) fail('WEBDAV_NOT_FOUND')
  fail('WEBDAV_NETWORK')
}

export class WebDavBackupService {
  private readonly fetchImpl: typeof fetch
  private readonly generationIdFactory: () => string
  private readonly now: () => Date
  private readonly timeoutMs: number
  private readonly maxXmlBytes: number
  private readonly maxJsonBytes: number
  private readonly maxArchiveBytes: number

  constructor(options: WebDavBackupServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.generationIdFactory = options.generationIdFactory ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.timeoutMs = this.positive(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    this.maxXmlBytes = this.positive(options.maxXmlBytes, DEFAULT_MAX_XML_BYTES)
    this.maxJsonBytes = this.positive(options.maxJsonBytes, DEFAULT_MAX_JSON_BYTES)
    this.maxArchiveBytes = this.positive(options.maxArchiveBytes, DEFAULT_MAX_ARCHIVE_BYTES)
  }

  async checkConnection(account: WebDavAccount, signal?: AbortSignal): Promise<{ connected: true }> {
    const endpoint = this.account(account)
    const response = await this.request(account, endpoint, {
      method: 'PROPFIND', headers: { Depth: '0', Accept: 'application/xml' },
    }, signal)
    if (response.status !== 207 && !response.ok) responseFailure(response)
    await this.readBytes(response, this.maxXmlBytes, signal)
    return { connected: true }
  }

  async appendGeneration(input: AppendWebDavGenerationInput): Promise<WebDavGeneration> {
    const endpoint = this.account(input.account)
    this.validBook(input.cloudBookId)
    if (!UUID.test(input.originProjectId) || !safeId(input.portableSnapshotGeneration)) fail('WEBDAV_INPUT_INVALID')
    const parents = [...new Set(input.parentGenerationIds)]
    if (parents.length > MAX_PARENTS || parents.some(parent => !safeId(parent))) fail('WEBDAV_INPUT_INVALID')
    const generationId = this.generationIdFactory()
    if (!UUID.test(generationId)) fail('WEBDAV_INPUT_INVALID')
    const createdAt = this.now().toISOString()
    const localArchive = await hashFile(input.archivePath, this.maxArchiveBytes)
    const locations = this.locations(endpoint, input.cloudBookId, generationId)
    for (const collection of locations.collections) await this.ensureCollection(input.account, collection, input.signal)
    const manifest: GenerationManifest = {
      version: 1,
      cloudBookId: input.cloudBookId,
      generationId,
      parentGenerationIds: parents,
      createdAt,
      originProjectId: input.originProjectId,
      portableSnapshotGeneration: input.portableSnapshotGeneration,
      archive: { file: 'archive.ainovel', ...localArchive },
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
    if (manifestBytes.length > this.maxJsonBytes) fail('WEBDAV_INPUT_INVALID')
    await this.putFile(input.account, locations.archive, input.archivePath, localArchive, input.signal)
    await this.putBytes(input.account, locations.manifest, manifestBytes, input.signal)
    const completion: CompletionDescriptor = {
      version: 1,
      cloudBookId: input.cloudBookId,
      generationId,
      manifest: { file: 'manifest.json', sha256: sha256(manifestBytes), byteSize: manifestBytes.length },
      archive: manifest.archive,
      completedAt: this.now().toISOString(),
    }
    const completionBytes = Buffer.from(JSON.stringify(completion), 'utf8')
    if (completionBytes.length > this.maxJsonBytes) fail('WEBDAV_INPUT_INVALID')
    await this.putBytes(input.account, locations.completion, completionBytes, input.signal)
    return this.publicGeneration(manifest, [])
  }

  async listGenerations(input: ListWebDavGenerationsInput): Promise<WebDavGeneration[]> {
    const endpoint = this.account(input.account)
    this.validBook(input.cloudBookId)
    const generationsUrl = this.locations(endpoint, input.cloudBookId).generations
    const response = await this.request(input.account, generationsUrl, {
      method: 'PROPFIND', headers: { Depth: '1', Accept: 'application/xml' },
    }, input.signal)
    if (response.status !== 207) responseFailure(response)
    const xmlBytes = await this.readBytes(response, this.maxXmlBytes, input.signal)
    let xmlText: string
    try { xmlText = new TextDecoder('utf-8', { fatal: true }).decode(xmlBytes) }
    catch { return fail('WEBDAV_DAV_RESPONSE_INVALID') }
    const generationIds = generationHrefs(xmlText, generationsUrl)
    const manifests: GenerationManifest[] = []
    for (const generationId of generationIds) {
      try {
        const manifest = await this.inspectGeneration(input.account, input.cloudBookId, generationId, input.signal, true)
        manifests.push(manifest)
      } catch (error) {
        if (error instanceof WebDavBackupError
          && ['WEBDAV_NOT_FOUND', 'WEBDAV_REMOTE_INVALID'].includes(error.code)) continue
        throw error
      }
    }
    const siblingGroups = new Map<string, string[]>()
    for (const manifest of manifests) {
      const key = JSON.stringify(manifest.parentGenerationIds)
      const group = siblingGroups.get(key) ?? []
      group.push(manifest.generationId)
      siblingGroups.set(key, group)
    }
    return manifests.map(manifest => this.publicGeneration(
      manifest,
      siblingGroups.get(JSON.stringify(manifest.parentGenerationIds))!.filter(id => id !== manifest.generationId),
    ))
  }

  async downloadGeneration(input: DownloadWebDavGenerationInput): Promise<{
    generationId: string; targetArchivePath: string; archiveSha256: string; archiveByteSize: number
  }> {
    const endpoint = this.account(input.account)
    this.validBook(input.cloudBookId)
    if (!UUID.test(input.generationId)) fail('WEBDAV_INPUT_INVALID')
    const target = path.resolve(input.targetArchivePath)
    const parent = path.dirname(target)
    const parentInfo = fs.lstatSync(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail('WEBDAV_TARGET_UNSAFE')
    if (fs.existsSync(target)) fail('WEBDAV_TARGET_EXISTS')
    const manifest = await this.inspectGeneration(input.account, input.cloudBookId, input.generationId, input.signal)
    const location = this.locations(endpoint, input.cloudBookId, input.generationId).archive
    const temporary = path.join(parent, `.${path.basename(target)}.webdav-download-${randomUUID()}.tmp`)
    let handle: fs.promises.FileHandle | undefined
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600)
      const response = await this.request(input.account, location, { method: 'GET' }, input.signal)
      if (!response.ok) responseFailure(response)
      const declared = this.contentLength(response)
      if (declared !== null && declared !== manifest.archive.byteSize) fail('WEBDAV_REMOTE_INVALID')
      const reader = response.body?.getReader()
      if (!reader) fail('WEBDAV_REMOTE_INVALID')
      const digest = createHash('sha256')
      let written = 0
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          const chunk = Buffer.from(next.value)
          written += chunk.length
          if (written > manifest.archive.byteSize || written > this.maxArchiveBytes) fail('WEBDAV_REMOTE_INVALID')
          digest.update(chunk)
          await handle.write(chunk)
        }
      } catch (error) {
        if (input.signal?.aborted) fail('WEBDAV_CANCELLED')
        if (error instanceof WebDavBackupError) throw error
        fail('WEBDAV_NETWORK')
      }
      if (written !== manifest.archive.byteSize || digest.digest('hex') !== manifest.archive.sha256) {
        fail('WEBDAV_REMOTE_INVALID')
      }
      await handle.sync(); await handle.close(); handle = undefined
      try { fs.linkSync(temporary, target) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('WEBDAV_TARGET_EXISTS')
        fail('WEBDAV_PUBLISH_FAILED')
      }
      fs.unlinkSync(temporary)
      return { generationId: input.generationId, targetArchivePath: target,
        archiveSha256: manifest.archive.sha256, archiveByteSize: manifest.archive.byteSize }
    } finally {
      if (handle) await handle.close().catch(() => {})
      try { fs.unlinkSync(temporary) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { /* Preserve the operation error. */ }
      }
    }
  }

  private positive(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback
  }

  private account(account: WebDavAccount): URL {
    if (!account || typeof account.username !== 'string' || typeof account.secret !== 'string'
      || !account.username || !account.secret
      || containsControlCharacter(account.username) || containsControlCharacter(account.secret)) {
      fail('WEBDAV_INPUT_INVALID')
    }
    try { return new URL(normalizeWebDavEndpoint(account.endpoint)) }
    catch { return fail('WEBDAV_INPUT_INVALID') }
  }

  private validBook(cloudBookId: string): void { if (!safeId(cloudBookId)) fail('WEBDAV_INPUT_INVALID') }

  private locations(endpoint: URL, cloudBookId: string, generationId?: string): {
    collections: URL[]; generations: URL; archive: URL; manifest: URL; completion: URL
  } {
    const relative = (segments: readonly string[], directory = false) => new URL(
      segments.map(encodeURIComponent).join('/') + (directory ? '/' : ''), endpoint,
    )
    const books = relative(['books'], true)
    const book = relative(['books', cloudBookId], true)
    const generations = relative(['books', cloudBookId, 'generations'], true)
    const generation = relative(['books', cloudBookId, 'generations', generationId ?? '00000000-0000-4000-8000-000000000000'], true)
    return {
      collections: generationId ? [books, book, generations, generation] : [books, book, generations],
      generations,
      archive: new URL('archive.ainovel', generation),
      manifest: new URL('manifest.json', generation),
      completion: new URL('completion.json', generation),
    }
  }

  private async request(account: WebDavAccount, url: URL, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const endpoint = this.account(account)
    if (url.origin !== endpoint.origin || !url.pathname.startsWith(endpoint.pathname)) fail('WEBDAV_INPUT_INVALID')
    if (signal?.aborted) fail('WEBDAV_CANCELLED')
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      return await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: requestSignal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${account.username}:${account.secret}`, 'utf8').toString('base64')}`,
          ...init.headers,
        },
      })
    } catch {
      if (signal?.aborted) fail('WEBDAV_CANCELLED')
      fail('WEBDAV_NETWORK')
    }
  }

  private async ensureCollection(account: WebDavAccount, url: URL, signal?: AbortSignal): Promise<void> {
    const response = await this.request(account, url, { method: 'MKCOL', headers: { 'If-None-Match': '*' } }, signal)
    if (![201, 405].includes(response.status)) responseFailure(response)
    await response.body?.cancel().catch(() => {})
  }

  private async putBytes(account: WebDavAccount, url: URL, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    const expected = { sha256: sha256(bytes), byteSize: bytes.length }
    if (await this.existingMatches(account, url, expected, signal)) return
    let uncertain = false
    try {
      const response = await this.request(account, url, {
        method: 'PUT', body: bytes as unknown as BodyInit,
        headers: { 'If-None-Match': '*', 'Content-Length': String(bytes.length) },
      }, signal)
      if (!response.ok) {
        if (response.status === 409 || response.status === 412 || response.status === 408 || response.status >= 500) uncertain = true
        else responseFailure(response)
      }
      await response.body?.cancel().catch(() => {})
    } catch (error) {
      if (error instanceof WebDavBackupError && error.code === 'WEBDAV_NETWORK' && !signal?.aborted) uncertain = true
      else throw error
    }
    if (!await this.existingMatches(account, url, expected, signal, false)) {
      fail(uncertain ? 'WEBDAV_REMOTE_CONFLICT' : 'WEBDAV_REMOTE_INVALID')
    }
  }

  private async putFile(account: WebDavAccount, url: URL, file: string,
    expected: { sha256: string; byteSize: number }, signal?: AbortSignal): Promise<void> {
    if (await this.existingMatches(account, url, expected, signal)) return
    let uncertain = false
    const body = fs.createReadStream(file)
    try {
      const response = await this.request(account, url, {
        method: 'PUT', body: body as unknown as BodyInit,
        headers: { 'If-None-Match': '*', 'Content-Length': String(expected.byteSize) },
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }, signal)
      if (!response.ok) {
        if (response.status === 409 || response.status === 412 || response.status === 408 || response.status >= 500) uncertain = true
        else responseFailure(response)
      }
      await response.body?.cancel().catch(() => {})
    } catch (error) {
      if (error instanceof WebDavBackupError && error.code === 'WEBDAV_NETWORK' && !signal?.aborted) uncertain = true
      else throw error
    } finally { body.destroy() }
    if (!await this.existingMatches(account, url, expected, signal, false)) {
      fail(uncertain ? 'WEBDAV_REMOTE_CONFLICT' : 'WEBDAV_REMOTE_INVALID')
    }
  }

  private async existingMatches(account: WebDavAccount, url: URL, expected: { sha256: string; byteSize: number },
    signal?: AbortSignal, allowMissing = true): Promise<boolean> {
    const response = await this.request(account, url, { method: 'GET' }, signal)
    if (response.status === 404 && allowMissing) { await response.body?.cancel().catch(() => {}); return false }
    if (!response.ok) responseFailure(response)
    const actual = await this.hashResponse(response, Math.min(this.maxArchiveBytes, Math.max(expected.byteSize, 1)), signal)
    if (actual.byteSize === expected.byteSize && actual.sha256 === expected.sha256) return true
    if (allowMissing) fail('WEBDAV_REMOTE_CONFLICT')
    return false
  }

  private async inspectGeneration(account: WebDavAccount, cloudBookId: string, generationId: string,
    signal?: AbortSignal, verifyArchiveContent = false): Promise<GenerationManifest> {
    const endpoint = this.account(account)
    const locations = this.locations(endpoint, cloudBookId, generationId)
    const completionResponse = await this.request(account, locations.completion, { method: 'GET' }, signal)
    if (!completionResponse.ok) responseFailure(completionResponse)
    const completion = parseCompletion(json(await this.readBytes(completionResponse, this.maxJsonBytes, signal)))
    if (completion.cloudBookId !== cloudBookId || completion.generationId !== generationId
      || completion.archive.byteSize > this.maxArchiveBytes) fail('WEBDAV_REMOTE_INVALID')
    const manifestResponse = await this.request(account, locations.manifest, { method: 'GET' }, signal)
    if (!manifestResponse.ok) responseFailure(manifestResponse)
    const manifestBytes = await this.readBytes(manifestResponse, this.maxJsonBytes, signal)
    if (manifestBytes.length !== completion.manifest.byteSize || sha256(manifestBytes) !== completion.manifest.sha256) {
      fail('WEBDAV_REMOTE_INVALID')
    }
    const manifest = parseManifest(json(manifestBytes))
    if (manifest.cloudBookId !== cloudBookId || manifest.generationId !== generationId
      || JSON.stringify(manifest.archive) !== JSON.stringify(completion.archive)) fail('WEBDAV_REMOTE_INVALID')
    const archiveResponse = await this.request(account, locations.archive,
      { method: verifyArchiveContent ? 'GET' : 'HEAD' }, signal)
    if (!archiveResponse.ok) responseFailure(archiveResponse)
    if (verifyArchiveContent) {
      const declared = this.contentLength(archiveResponse)
      if (declared !== null && declared !== manifest.archive.byteSize) {
        await archiveResponse.body?.cancel().catch(() => {})
        fail('WEBDAV_REMOTE_INVALID')
      }
      const actual = await this.hashResponse(
        archiveResponse,
        Math.min(this.maxArchiveBytes, Math.max(manifest.archive.byteSize, 1)),
        signal,
      )
      if (actual.byteSize !== manifest.archive.byteSize || actual.sha256 !== manifest.archive.sha256) {
        fail('WEBDAV_REMOTE_INVALID')
      }
    } else {
      const length = this.contentLength(archiveResponse)
      await archiveResponse.body?.cancel().catch(() => {})
      if (length !== manifest.archive.byteSize) fail('WEBDAV_REMOTE_INVALID')
    }
    return manifest
  }

  private publicGeneration(manifest: GenerationManifest, siblings: string[]): WebDavGeneration {
    return {
      cloudBookId: manifest.cloudBookId,
      generationId: manifest.generationId,
      parentGenerationIds: [...manifest.parentGenerationIds],
      createdAt: manifest.createdAt,
      originProjectId: manifest.originProjectId,
      portableSnapshotGeneration: manifest.portableSnapshotGeneration,
      archiveSha256: manifest.archive.sha256,
      archiveByteSize: manifest.archive.byteSize,
      hasSibling: siblings.length > 0,
      siblingGenerationIds: [...siblings],
    }
  }

  private contentLength(response: Response): number | null {
    const raw = response.headers.get('content-length')
    if (raw === null) return null
    const value = Number(raw)
    return integer(value) ? value : fail('WEBDAV_REMOTE_INVALID')
  }

  private async readBytes(response: Response, maximum: number, signal?: AbortSignal): Promise<Buffer> {
    const declared = this.contentLength(response)
    if (declared !== null && declared > maximum) fail('WEBDAV_RESPONSE_TOO_LARGE')
    const reader = response.body?.getReader()
    if (!reader) return Buffer.alloc(0)
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        const chunk = Buffer.from(next.value)
        total += chunk.length
        if (total > maximum) { await reader.cancel(); fail('WEBDAV_RESPONSE_TOO_LARGE') }
        chunks.push(chunk)
      }
    } catch (error) {
      if (signal?.aborted) fail('WEBDAV_CANCELLED')
      if (error instanceof WebDavBackupError) throw error
      fail('WEBDAV_NETWORK')
    }
    if (declared !== null && total !== declared) fail('WEBDAV_REMOTE_INVALID')
    return Buffer.concat(chunks, total)
  }

  private async hashResponse(response: Response, maximum: number, signal?: AbortSignal): Promise<{ sha256: string; byteSize: number }> {
    const declared = this.contentLength(response)
    if (declared !== null && declared > maximum) fail('WEBDAV_RESPONSE_TOO_LARGE')
    const reader = response.body?.getReader()
    if (!reader) fail('WEBDAV_REMOTE_INVALID')
    const digest = createHash('sha256')
    let total = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        const chunk = Buffer.from(next.value)
        total += chunk.length
        if (total > maximum) { await reader.cancel(); fail('WEBDAV_RESPONSE_TOO_LARGE') }
        digest.update(chunk)
      }
    } catch (error) {
      if (signal?.aborted) fail('WEBDAV_CANCELLED')
      if (error instanceof WebDavBackupError) throw error
      fail('WEBDAV_NETWORK')
    }
    if (declared !== null && total !== declared) fail('WEBDAV_REMOTE_INVALID')
    return { sha256: digest.digest('hex'), byteSize: total }
  }
}
