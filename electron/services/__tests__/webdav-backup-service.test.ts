import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  WebDavBackupService,
  type WebDavAccount,
} from '../webdav-backup-service'

const BOOK = 'cloud-book-a'
const PROJECT = '11111111-1111-4111-8111-111111111111'
const GEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GEN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const GEN_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PARENT = '99999999-9999-4999-8999-999999999999'
const servers: Server[] = []
const roots: string[] = []

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function requestBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function encodeDavHref(value: string): string {
  return value.split('/').map(segment => {
    try { return encodeURIComponent(decodeURIComponent(segment)) }
    catch { return encodeURIComponent(segment) }
  }).join('/')
}

class DavFixture {
  readonly files = new Map<string, Buffer>()
  readonly collections = new Set<string>(['/dav/'])
  readonly requests: Array<{ method: string; url: string; authorization: string; ifNoneMatch: string }> = []
  propfindBody: string | null = null
  dropAfterPutSuffix: string | null = null
  corruptDroppedPut = false
  redirectSuffix: string | null = null
  redirectLocation = ''
  slowGetSuffix: string | null = null
  private dropped = false
  private server: Server
  baseUrl = ''

  constructor() {
    this.server = createServer((request, response) => void this.handle(request, response))
    servers.push(this.server)
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/dav/`
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? ''
    const url = request.url ?? ''
    this.requests.push({
      method,
      url,
      authorization: String(request.headers.authorization ?? ''),
      ifNoneMatch: String(request.headers['if-none-match'] ?? ''),
    })
    if (this.redirectSuffix && url.endsWith(this.redirectSuffix)) {
      response.writeHead(302, { location: this.redirectLocation })
      response.end()
      return
    }
    if (method === 'MKCOL') {
      this.collections.add(url.endsWith('/') ? url : `${url}/`)
      response.writeHead(201).end()
      return
    }
    if (method === 'PUT') {
      let body = await requestBytes(request)
      if (this.dropAfterPutSuffix && url.endsWith(this.dropAfterPutSuffix) && !this.dropped) {
        this.dropped = true
        if (this.corruptDroppedPut && body.length) body = Buffer.concat([body.subarray(0, -1), Buffer.from('!')])
        this.files.set(url, body)
        request.socket.destroy()
        return
      }
      this.files.set(url, body)
      response.writeHead(201).end()
      return
    }
    if (method === 'GET' || method === 'HEAD') {
      const body = this.files.get(url)
      if (!body) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'content-length': body.length, 'content-type': 'application/octet-stream' })
      if (method === 'HEAD') { response.end(); return }
      if (this.slowGetSuffix && url.endsWith(this.slowGetSuffix)) {
        response.write(body.subarray(0, Math.max(1, Math.floor(body.length / 2))))
        setTimeout(() => response.end(body.subarray(Math.max(1, Math.floor(body.length / 2)))), 150)
        return
      }
      response.end(body)
      return
    }
    if (method === 'PROPFIND') {
      const body = this.propfindBody ?? this.multistatus(url)
      response.writeHead(207, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    response.writeHead(405).end()
  }

  private multistatus(root: string): string {
    const normalized = root.endsWith('/') ? root : `${root}/`
    const children = [...this.collections]
      .filter(candidate => candidate.startsWith(normalized) && candidate !== normalized
        && !candidate.slice(normalized.length).replace(/\/$/u, '').includes('/'))
    return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[normalized, ...children]
      .map(href => `<d:response><d:href>${encodeDavHref(href)}</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response>`)
      .join('')}</d:multistatus>`
  }
}

function workspace(): { root: string; archive: string; target: string; bytes: Buffer } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-webdav-'))
  roots.push(root)
  const archive = path.join(root, 'source.ainovel')
  const bytes = Buffer.from('合成归档\u0000正文与头像', 'utf8')
  fs.writeFileSync(archive, bytes)
  return { root, archive, target: path.join(root, 'restored.ainovel'), bytes }
}

function account(fixture: DavFixture): WebDavAccount {
  return { endpoint: fixture.baseUrl, username: 'writer', secret: 'loopback-secret' }
}

function appender(fixture: DavFixture, generationId: string, archivePath: string, parents = [PARENT]) {
  return new WebDavBackupService({ generationIdFactory: () => generationId, now: () => new Date('2026-09-21T00:00:00.000Z') })
    .appendGeneration({
      account: account(fixture),
      cloudBookId: BOOK,
      archivePath,
      originProjectId: PROJECT,
      portableSnapshotGeneration: 'portable-snapshot-a',
      parentGenerationIds: parents,
    })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('WebDavBackupService', () => {
  it('checks a loopback WebDAV connection without exposing credentials', async () => {
    const dav = new DavFixture(); await dav.listen()

    await expect(new WebDavBackupService().checkConnection(account(dav))).resolves.toEqual({ connected: true })
    expect(dav.requests).toHaveLength(1)
    expect(dav.requests[0]).toMatchObject({ method: 'PROPFIND', url: '/dav/' })
    expect(dav.requests[0]!.authorization).toBe(`Basic ${Buffer.from('writer:loopback-secret').toString('base64')}`)
  })

  it('keeps hostile WebDAV hrefs encoded as URI paths, not XML or HTML markup', async () => {
    const dav = new DavFixture(); await dav.listen()
    dav.collections.add('/dav/<img src=x onerror=alert(1)>/')

    const response = await fetch(dav.baseUrl, { method: 'PROPFIND' })
    const body = await response.text()

    expect(response.status).toBe(207)
    expect(body).toContain('<d:href>/dav/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E/</d:href>')
    expect(body).not.toContain('<img')

    const hostileResponse = await fetch(`${dav.baseUrl}%3Csvg%20onload%3Dalert(1)%3E/`, { method: 'PROPFIND' })
    const hostileBody = await hostileResponse.text()
    expect(hostileResponse.status).toBe(207)
    expect(hostileBody).toContain('<d:href>/dav/%3Csvg%20onload%3Dalert(1)%3E/</d:href>')
    expect(hostileBody).not.toContain('<svg')
  })

  it('appends, lists, and downloads two no-CAS sibling generations without using latest', async () => {
    const dav = new DavFixture(); await dav.listen()
    const source = workspace()

    const first = await appender(dav, GEN_A, source.archive)
    const second = await appender(dav, GEN_B, source.archive)
    const service = new WebDavBackupService()
    const listed = await service.listGenerations({ account: account(dav), cloudBookId: BOOK })

    expect(first.generationId).toBe(GEN_A)
    expect(second.generationId).toBe(GEN_B)
    expect(listed.map(item => item.generationId).sort()).toEqual([GEN_A, GEN_B])
    expect(listed.every(item => item.hasSibling)).toBe(true)
    expect(listed.find(item => item.generationId === GEN_A)?.siblingGenerationIds).toEqual([GEN_B])
    expect(dav.requests.filter(item => item.method === 'PUT').every(item => item.ifNoneMatch === '*')).toBe(true)
    expect(dav.requests.some(item => item.url.includes('latest'))).toBe(false)
    const generationPrefix = `/dav/books/${BOOK}/generations/${GEN_A}/`
    const generationPuts = dav.requests.filter(item => item.method === 'PUT' && item.url.startsWith(generationPrefix))
    expect(generationPuts.map(item => path.posix.basename(item.url))).toEqual(['archive.ainovel', 'manifest.json', 'completion.json'])

    await expect(service.downloadGeneration({
      account: account(dav), cloudBookId: BOOK, generationId: GEN_A, targetArchivePath: source.target,
    })).resolves.toMatchObject({ generationId: GEN_A, archiveSha256: sha256(source.bytes), archiveByteSize: source.bytes.length })
    expect(fs.readFileSync(source.target)).toEqual(source.bytes)
  })

  it('does not list a generation whose upload never reached completion.json', async () => {
    const dav = new DavFixture(); await dav.listen()
    const source = workspace()
    await appender(dav, GEN_A, source.archive)
    const partial = `/dav/books/${BOOK}/generations/${GEN_C}/`
    dav.collections.add(partial)
    dav.files.set(`${partial}archive.ainovel`, Buffer.from('partial'))
    dav.files.set(`${partial}manifest.json`, Buffer.from('{}'))

    const listed = await new WebDavBackupService().listGenerations({ account: account(dav), cloudBookId: BOOK })

    expect(listed.map(item => item.generationId)).toEqual([GEN_A])
  })

  it('accepts a same-origin absolute generation href inside the configured root', async () => {
    const dav = new DavFixture(); await dav.listen()
    const source = workspace()
    await appender(dav, GEN_A, source.archive)
    const href = `${dav.baseUrl}books/${BOOK}/generations/${GEN_A}/`
    dav.propfindBody = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href></d:response></d:multistatus>`

    await expect(new WebDavBackupService().listGenerations({ account: account(dav), cloudBookId: BOOK }))
      .resolves.toMatchObject([{ generationId: GEN_A }])
  })

  it('verifies an unknown PUT result by GET instead of blindly overwriting it', async () => {
    const dav = new DavFixture(); await dav.listen()
    const source = workspace()
    dav.dropAfterPutSuffix = 'archive.ainovel'

    await expect(appender(dav, GEN_A, source.archive)).resolves.toMatchObject({ generationId: GEN_A })
    const archivePath = `/dav/books/${BOOK}/generations/${GEN_A}/archive.ainovel`
    expect(dav.requests.filter(item => item.method === 'PUT' && item.url === archivePath)).toHaveLength(1)
    expect(dav.requests.some(item => item.method === 'GET' && item.url === archivePath)).toBe(true)
  })

  it('rejects an unknown PUT whose persisted bytes do not match and never writes completion', async () => {
    const dav = new DavFixture(); await dav.listen()
    const source = workspace()
    dav.dropAfterPutSuffix = 'archive.ainovel'
    dav.corruptDroppedPut = true

    await expect(appender(dav, GEN_A, source.archive)).rejects.toThrow('WEBDAV_REMOTE_CONFLICT')
    expect(dav.files.has(`/dav/books/${BOOK}/generations/${GEN_A}/completion.json`)).toBe(false)
  })

  it('rejects wrong archive hash or length and leaves no downloaded target', async () => {
    const dav = new DavFixture(); await dav.listen()
    const source = workspace()
    await appender(dav, GEN_A, source.archive)
    const remoteArchive = `/dav/books/${BOOK}/generations/${GEN_A}/archive.ainovel`
    const original = dav.files.get(remoteArchive)!
    dav.files.set(remoteArchive, Buffer.concat([original.subarray(0, -1), Buffer.from('!')]))

    await expect(new WebDavBackupService().listGenerations({ account: account(dav), cloudBookId: BOOK }))
      .resolves.toEqual([])

    await expect(new WebDavBackupService().downloadGeneration({
      account: account(dav), cloudBookId: BOOK, generationId: GEN_A, targetArchivePath: source.target,
    })).rejects.toThrow('WEBDAV_REMOTE_INVALID')
    expect(fs.existsSync(source.target)).toBe(false)

    dav.files.set(remoteArchive, Buffer.concat([original, Buffer.from('extra')]))
    await expect(new WebDavBackupService().listGenerations({ account: account(dav), cloudBookId: BOOK }))
      .resolves.toEqual([])
  })

  it('rejects redirects without forwarding Authorization to another origin', async () => {
    const sourceDav = new DavFixture(); await sourceDav.listen()
    const targetDav = new DavFixture(); await targetDav.listen()
    const source = workspace()
    await appender(sourceDav, GEN_A, source.archive)
    sourceDav.redirectSuffix = 'archive.ainovel'
    sourceDav.redirectLocation = `${targetDav.baseUrl}stolen`

    await expect(new WebDavBackupService().downloadGeneration({
      account: account(sourceDav), cloudBookId: BOOK, generationId: GEN_A, targetArchivePath: source.target,
    })).rejects.toThrow('WEBDAV_NETWORK')
    expect(targetDav.requests).toEqual([])
    expect(fs.existsSync(source.target)).toBe(false)
  })

  it.each([
    ['root escape', '/dav/books/cloud-book-a/outside/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/'],
    ['encoded traversal', '/dav/books/cloud-book-a/generations/%2e%2e/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/'],
    ['absolute URL', 'http://example.invalid/dav/books/cloud-book-a/generations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/'],
  ])('rejects a malicious PROPFIND href: %s', async (_label, href) => {
    const dav = new DavFixture(); await dav.listen()
    dav.propfindBody = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href></d:response></d:multistatus>`

    await expect(new WebDavBackupService().listGenerations({ account: account(dav), cloudBookId: BOOK }))
      .rejects.toThrow('WEBDAV_DAV_RESPONSE_INVALID')
    expect(dav.requests.filter(item => ['GET', 'HEAD', 'PUT'].includes(item.method))).toEqual([])
  })

  it('rejects a cross-origin absolute href without sending Authorization to that origin', async () => {
    const sourceDav = new DavFixture(); await sourceDav.listen()
    const targetDav = new DavFixture(); await targetDav.listen()
    const href = `${targetDav.baseUrl}books/${BOOK}/generations/${GEN_A}/`
    sourceDav.propfindBody = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href></d:response></d:multistatus>`

    await expect(new WebDavBackupService().listGenerations({ account: account(sourceDav), cloudBookId: BOOK }))
      .rejects.toThrow('WEBDAV_DAV_RESPONSE_INVALID')
    expect(targetDav.requests).toEqual([])
  })

  it.each([
    ['external entity', '<!DOCTYPE x [<!ENTITY steal SYSTEM "file:///secret">]><d:multistatus xmlns:d="DAV:">&steal;</d:multistatus>'],
    ['CDATA', '<d:multistatus xmlns:d="DAV:"><![CDATA[hidden]]></d:multistatus>'],
    ['oversized XML', `<d:multistatus xmlns:d="DAV:">${' '.repeat(4096)}</d:multistatus>`],
  ])('rejects unsafe or oversized XML: %s', async (_label, body) => {
    const dav = new DavFixture(); await dav.listen(); dav.propfindBody = body

    await expect(new WebDavBackupService({ maxXmlBytes: 1024 })
      .listGenerations({ account: account(dav), cloudBookId: BOOK }))
      .rejects.toThrow(_label === 'oversized XML' ? 'WEBDAV_RESPONSE_TOO_LARGE' : 'WEBDAV_DAV_RESPONSE_INVALID')
  })

  it('cancels a streaming download, cleans its temporary file, and never overwrites an existing target', async () => {
    const dav = new DavFixture(); await dav.listen()
    const source = workspace()
    fs.writeFileSync(source.archive, Buffer.alloc(128 * 1024, 7))
    await appender(dav, GEN_A, source.archive)
    dav.slowGetSuffix = 'archive.ainovel'
    const controller = new AbortController()
    const service = new WebDavBackupService()
    const pending = service.downloadGeneration({
      account: account(dav), cloudBookId: BOOK, generationId: GEN_A,
      targetArchivePath: source.target, signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 25)

    await expect(pending).rejects.toThrow('WEBDAV_CANCELLED')
    expect(fs.existsSync(source.target)).toBe(false)
    expect(fs.readdirSync(source.root).some(name => name.includes('.webdav-download-'))).toBe(false)

    fs.writeFileSync(source.target, 'keep-existing')
    await expect(service.downloadGeneration({
      account: account(dav), cloudBookId: BOOK, generationId: GEN_A, targetArchivePath: source.target,
    })).rejects.toThrow('WEBDAV_TARGET_EXISTS')
    expect(fs.readFileSync(source.target, 'utf8')).toBe('keep-existing')
  })
})
