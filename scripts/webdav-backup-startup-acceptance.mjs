/* global process */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runId = randomUUID()
const root = path.join(repository, '.runtime/.cache/s04-electron', runId)
const scratchRoot = path.join(process.env.LOCALAPPDATA ?? path.dirname(repository), 'VibeCodingScratch', 'an', 'b02', runId.slice(0, 8))
const profile = (name, shortName) => Object.fromEntries([
  'legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData', 'projects',
].map(directory => [directory, path.join(scratchRoot, shortName, directory)]).concat([
  ['name', name], ['root', path.join(scratchRoot, shortName)], ['evidenceRoot', path.join(root, name)],
  ['chromiumLog', path.join(root, name, 'chromium.log')],
]))
const profiles = { A: profile('profile-a', 'a'), B: profile('profile-b', 'b') }
const secret = `b02-loopback-secret-${runId}`
const username = 'b02-writer'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const unresolvedReliability = [
  'import hook timeout',
  'project-clear two case timeout',
  'vector native 0xC0000409',
  'full mcp-manager GLOBAL_MIGRATION_IO_FAILED',
]

async function bytes(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

class LoopbackWebDav {
  files = new Map()
  collections = new Set(['/dav/'])
  requests = []
  rejectedOverwrites = 0
  server = createServer((request, response) => void this.handle(request, response).catch(error => {
    response.writeHead(500).end(error instanceof Error ? error.message : String(error))
  }))
  endpoint = ''

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address()
    assert(address && typeof address === 'object')
    this.endpoint = `http://127.0.0.1:${address.port}/dav/`
  }

  close() {
    return new Promise(resolve => this.server.close(() => resolve()))
  }

  async handle(request, response) {
    const method = request.method ?? ''
    const url = request.url ?? ''
    const parsed = new URL(url, 'http://127.0.0.1')
    const pathname = parsed.pathname
    const authorization = String(request.headers.authorization ?? '')
    const ifNoneMatch = String(request.headers['if-none-match'] ?? '')
    const record = { method, url, authorized: authorization === this.authorization, ifNoneMatch, status: 0 }
    this.requests.push(record)
    const finish = (status, body) => {
      record.status = status
      const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body)
      response.writeHead(status, payload ? { 'content-length': payload.length } : undefined)
      response.end(method === 'HEAD' ? undefined : payload)
    }
    if (!record.authorized) { finish(401); return }
    if (parsed.search || !pathname.startsWith('/dav/')) { finish(404); return }
    if (method === 'MKCOL') {
      if (ifNoneMatch !== '*') { finish(428); return }
      const collection = pathname.endsWith('/') ? pathname : `${pathname}/`
      if (this.collections.has(collection)) { finish(405); return }
      const parent = `${path.posix.dirname(collection.slice(0, -1))}/`
      if (!this.collections.has(parent)) { finish(409); return }
      this.collections.add(collection); finish(201); return
    }
    if (method === 'PUT') {
      const body = await bytes(request)
      if (ifNoneMatch !== '*') { finish(428); return }
      const parent = pathname.slice(0, pathname.lastIndexOf('/') + 1)
      if (!this.collections.has(parent)) { finish(409); return }
      if (this.files.has(pathname)) { this.rejectedOverwrites += 1; finish(412); return }
      this.files.set(pathname, body); finish(201); return
    }
    if (method === 'GET' || method === 'HEAD') {
      const body = this.files.get(pathname)
      if (!body) { finish(404); return }
      response.setHeader('content-type', 'application/octet-stream')
      finish(200, body); return
    }
    if (method === 'PROPFIND') {
      const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`
      const children = [...this.collections].filter(candidate => candidate.startsWith(normalized)
        && candidate !== normalized && !candidate.slice(normalized.length).replace(/\/$/u, '').includes('/'))
      const body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[normalized, ...children]
        .map(href => `<d:response><d:href>${xml(href)}</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response>`)
        .join('')}</d:multistatus>`
      response.setHeader('content-type', 'application/xml')
      finish(207, body); return
    }
    finish(405)
  }

  get authorization() {
    return `Basic ${Buffer.from(`${username}:${secret}`, 'utf8').toString('base64')}`
  }
}

function writeProcessEvidence(profile, child, code = child?.exitCode ?? null, signal = null) {
  const exitCode = typeof code === 'number' ? code : null
  const evidence = {
    profile: profile.name,
    cacheRoot: profile.root,
    chromiumLog: profile.chromiumLog,
    pid: child?.pid ?? null,
    exitCode,
    exitCodeHex: exitCode === null ? null : `0x${(exitCode >>> 0).toString(16).toUpperCase()}`,
    signal,
  }
  fs.writeFileSync(path.join(profile.evidenceRoot, `electron-process-${evidence.pid ?? 'unknown'}.json`), JSON.stringify(evidence, null, 2))
  return evidence
}

async function invoke(page, channel, ...args) {
  return page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
}

async function launch(profile) {
  const env = {
    ...process.env,
    AI_NOVEL_APP_DATA_HOME: profile.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy,
    AI_NOVEL_VELA_HOME: profile.legacy,
    HOME: profile.home,
    USERPROFILE: profile.home,
    APPDATA: profile.appData,
    LOCALAPPDATA: profile.localAppData,
    CHROME_LOG_FILE: profile.chromiumLog,
    ELECTRON_ENABLE_LOGGING: '1',
  }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[name]
  let app
  try {
    app = await electron.launch({ cwd: repository, args: ['.', `--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  } catch (error) {
    fs.writeFileSync(path.join(profile.evidenceRoot, 'electron-launch-failure.json'), JSON.stringify({
      profile: profile.name,
      error: error instanceof Error ? error.message : String(error),
      knownReliabilityIssueNotAutomaticallyClosed: 'vector native 0xC0000409',
    }, null, 2))
    throw error
  }
  const child = app.process()
  child?.once('exit', (code, signal) => writeProcessEvidence(profile, child, code, signal))
  let page
  try {
    page = await app.firstWindow({ timeout: 30_000 })
    const electronPaths = await app.evaluate(({ app }) => ({
      homeEnv: process.env.HOME,
      appDataEnv: process.env.APPDATA,
      localAppDataEnv: process.env.LOCALAPPDATA,
      userData: app.getPath('userData'),
    }))
    assert.equal(path.resolve(electronPaths.homeEnv), profile.home)
    assert.equal(path.resolve(electronPaths.appDataEnv), profile.appData)
    assert.equal(path.resolve(electronPaths.localAppDataEnv), profile.localAppData)
    assert.equal(path.resolve(electronPaths.userData), profile.userData)
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    return { app, page }
  } catch (error) {
    fs.writeFileSync(path.join(profile.evidenceRoot, `startup-failure-${randomUUID()}.json`), JSON.stringify({
      profile: profile.name,
      state: page ? await invoke(page, 'startup:get-state').catch(() => null) : null,
      body: page ? await page.locator('body').innerText().catch(() => '') : '',
      process: writeProcessEvidence(profile, child),
    }, null, 2))
    await app.close()
    throw error
  }
}

function filesNamed(directory, name) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name === name)
    .map(entry => path.join(entry.parentPath, entry.name))
}

function assertEncryptedCredential(profile, expectedAccounts) {
  const matches = filesNamed(profile.canonical, 'cloud-backup-credentials.json')
  assert.equal(matches.length, 1, `expected one credential store for ${profile.name}`)
  const raw = fs.readFileSync(matches[0], 'utf8')
  assert.equal(raw.includes(secret), false, 'credential store must not contain plaintext secret')
  const document = JSON.parse(raw)
  assert.equal(document.accounts.length, expectedAccounts)
  if (expectedAccounts) assert.equal(typeof document.accounts[0].encryptedSecretBase64, 'string')
  return path.relative(profile.canonical, matches[0])
}

function assertNoPlaintextSecret(directory) {
  const needle = Buffer.from(secret)
  const files = fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  for (const entry of files) {
    assert.equal(fs.readFileSync(path.join(entry.parentPath, entry.name)).indexOf(needle), -1,
      `plaintext secret found in ${path.join(entry.parentPath, entry.name)}`)
  }
  return files.length
}

function assertProfilesAreIsolated() {
  for (const name of ['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData']) {
    assert.notEqual(profiles.A[name], profiles.B[name], `${name} root must differ by profile`)
    assert.equal(path.dirname(profiles.A[name]), profiles.A.root)
    assert.equal(path.dirname(profiles.B[name]), profiles.B.root)
  }
}

async function main() {
  const dav = new LoopbackWebDav()
  const results = []
  const invokedChannels = new Set()
  const call = async (page, channel, ...args) => {
    invokedChannels.add(channel)
    return invoke(page, channel, ...args)
  }
  let outcome = 'FAIL'
  let error
  try {
    for (const current of Object.values(profiles)) {
      fs.mkdirSync(current.evidenceRoot, { recursive: true })
      for (const name of ['legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']) fs.mkdirSync(current[name], { recursive: true })
    }
    fs.writeFileSync(path.join(scratchRoot, '.vibe-owner.json'), JSON.stringify({
      owner: 'AI Novel Program v3 B02 native acceptance',
      sourceProject: repository,
      createdAt: new Date().toISOString(),
      ttlHours: 48,
      cleanupCommand: `Remove-Item -LiteralPath '${scratchRoot.replaceAll("'", "''")}' -Recurse -Force`,
    }, null, 2))
    assertProfilesAreIsolated()
    await dav.listen()
    const fixtureRejections = {
      outsideRoot: (await fetch(new URL('/outside', dav.endpoint), {
        method: 'PROPFIND', headers: { Authorization: dav.authorization },
      })).status,
      missingMkcolParent: (await fetch(new URL('missing/child/', dav.endpoint), {
        method: 'MKCOL', headers: { Authorization: dav.authorization, 'If-None-Match': '*' },
      })).status,
      missingPutParent: (await fetch(new URL('missing/file', dav.endpoint), {
        method: 'PUT', headers: { Authorization: dav.authorization, 'If-None-Match': '*' }, body: 'orphan',
      })).status,
    }
    assert.deepEqual(fixtureRejections, { outsideRoot: 404, missingMkcolParent: 409, missingPutParent: 409 })

    const authorBody = 'B02 合成作者正文。\r\n云端恢复必须逐字保持。'
    const authorBodySha256 = hash(Buffer.from(authorBody))
    let sourceProjectPath, sourceProjectId, sourceSession, restoredProjectPath, restoredProjectId
    let accountA, accountB, cloudBookId, gen1, gen2, gen3

    let session = await launch(profiles.A)
    try {
      const created = await call(session.page, 'project:create', {
        path: profiles.A.projects,
        name: 'B02-A',
        genre: '合成测试',
        targetAudience: 'fixture',
        writingLanguage: 'zh-CN',
      }, randomUUID(), null)
      assert.equal(created.success, true, created.error)
      sourceProjectPath = created.projectPath
      sourceProjectId = created.projectId
      const opened = await call(session.page, 'project:open', sourceProjectPath, randomUUID(), null)
      assert.equal(opened.success, true, opened.error)
      sourceSession = { projectId: sourceProjectId, projectPath: sourceProjectPath, leaseId: opened.project.sessionLease }
      const draft = await call(session.page, 'db:draft-create', {
        chapterNumber: 1,
        version: 1,
        source: 'write',
        content: authorBody,
        wordCount: authorBody.length,
      }, sourceProjectPath, sourceSession)
      assert.equal(draft.success, true, draft.error)

      const connected = await call(session.page, 'cloud-backup:connect', { endpoint: dav.endpoint, username, secret })
      assert.equal(connected.success, true, connected.errorCode)
      assert.equal(connected.account.persistence, 'os-backed')
      accountA = connected.account.accountId
      const configured = await call(session.page, 'cloud-backup:confirm-binding', {
        projectSession: sourceSession,
        localEndpointAccountId: accountA,
        lastSelectedParentGenerationIds: [],
        expectedRevision: null,
      })
      assert.equal(configured.success, true, configured.errorCode)
      cloudBookId = configured.binding.cloudBookId
      const backup = await call(session.page, 'cloud-backup:backup', {
        operationId: randomUUID(), projectSession: sourceSession, disclosureConfirmed: true,
      })
      assert.equal(backup.success, true, backup.errorCode)
      assert.equal(backup.bindingSaved, true)
      gen1 = backup.generation.generationId
      assert.deepEqual(backup.generation.parentGenerationIds, [])
      results.push({ name: 'profile-a-create-connect-backup-gen1', outcome: 'PASS', authorBodySha256, persistence: 'os-backed' })
    } finally { await session.app.close() }
    const aCredentialFile = assertEncryptedCredential(profiles.A, 1)
    const aPersistentFileCount = assertNoPlaintextSecret(profiles.A.root)

    session = await launch(profiles.B)
    try {
      const connected = await call(session.page, 'cloud-backup:connect', { endpoint: dav.endpoint, username, secret })
      assert.equal(connected.success, true, connected.errorCode)
      assert.equal(connected.account.persistence, 'os-backed')
      accountB = connected.account.accountId
      const listed = await call(session.page, 'cloud-backup:list', { localEndpointAccountId: accountB, cloudBookId })
      assert.equal(listed.success, true, listed.errorCode)
      assert.deepEqual(listed.generations.map(item => item.generationId), [gen1])

      restoredProjectPath = path.join(profiles.B.projects, 'restored')
      const restored = await call(session.page, 'cloud-backup:restore-copy', {
        operationId: randomUUID(),
        localEndpointAccountId: accountB,
        cloudBookId,
        generationId: gen1,
        targetProjectRoot: restoredProjectPath,
      })
      assert.equal(restored.success, true, restored.errorCode)
      assert.equal(restored.bindingSaved, true)
      assert.equal(restored.binding.mode, 'origin-readonly')
      restoredProjectId = restored.receipt.targetProjectId
      assert.notEqual(restoredProjectId, sourceProjectId)
      assert.deepEqual(await call(session.page, 'project:get-runtime-context'), { activeProjectPath: null, dbReady: true })

      const opened = await call(session.page, 'project:open', restoredProjectPath, randomUUID(), null)
      assert.equal(opened.success, true, opened.error)
      const restoredSession = { projectId: restoredProjectId, projectPath: restoredProjectPath, leaseId: opened.project.sessionLease }
      const drafts = await call(session.page, 'db:draft-list', 1, restoredProjectPath, restoredSession)
      assert.equal(drafts.length, 1)
      const restoredDraft = await call(session.page, 'db:draft-get-full', drafts[0].id, restoredProjectPath, restoredSession)
      assert.equal(restoredDraft.content, authorBody)
      const readonlyView = await call(session.page, 'cloud-backup:view', restoredSession)
      assert.equal(readonlyView.success, true, readonlyView.errorCode)
      assert.equal(readonlyView.binding.mode, 'origin-readonly')
      assert.deepEqual(readonlyView.binding.lastSelectedParentGenerationIds, [gen1])

      const rebound = await call(session.page, 'cloud-backup:confirm-binding', {
        projectSession: restoredSession,
        localEndpointAccountId: accountB,
        cloudBookId,
        lastSelectedParentGenerationIds: [gen1],
        expectedRevision: readonlyView.binding.revision,
      })
      assert.equal(rebound.success, true, rebound.errorCode)
      assert.equal(rebound.binding.mode, 'writable')
      const backup = await call(session.page, 'cloud-backup:backup', {
        operationId: randomUUID(), projectSession: restoredSession, disclosureConfirmed: true,
      })
      assert.equal(backup.success, true, backup.errorCode)
      gen2 = backup.generation.generationId
      assert.deepEqual(backup.generation.parentGenerationIds, [gen1])
      results.push({ name: 'profile-b-restore-origin-readonly-explicit-rebind-gen2', outcome: 'PASS', restoredBodySha256: hash(Buffer.from(restoredDraft.content)) })
    } finally { await session.app.close() }
    const bCredentialFile = assertEncryptedCredential(profiles.B, 1)
    const bPersistentFileCount = assertNoPlaintextSecret(profiles.B.root)

    session = await launch(profiles.A)
    try {
      const reopened = await call(session.page, 'project:open', sourceProjectPath, randomUUID(), null)
      assert.equal(reopened.success, true, reopened.error)
      sourceSession = { projectId: sourceProjectId, projectPath: sourceProjectPath, leaseId: reopened.project.sessionLease }
      const view = await call(session.page, 'cloud-backup:view', sourceSession)
      assert.equal(view.success, true, view.errorCode)
      assert.equal(view.state, 'configured')
      assert.equal(view.account.persistence, 'os-backed')
      assert.equal(view.account.accountId, accountA)
      assert.deepEqual(view.binding.lastSelectedParentGenerationIds, [gen1])
      const before = await call(session.page, 'cloud-backup:list', { localEndpointAccountId: accountA, cloudBookId })
      assert.equal(before.success, true, before.errorCode)
      assert.deepEqual(new Set(before.generations.map(item => item.generationId)), new Set([gen1, gen2]))
      const backup = await call(session.page, 'cloud-backup:backup', {
        operationId: randomUUID(), projectSession: sourceSession, disclosureConfirmed: true,
      })
      assert.equal(backup.success, true, backup.errorCode)
      gen3 = backup.generation.generationId
      assert.deepEqual(backup.generation.parentGenerationIds, [gen1])
      const finalList = await call(session.page, 'cloud-backup:list', { localEndpointAccountId: accountA, cloudBookId })
      assert.equal(finalList.success, true, finalList.errorCode)
      assert.deepEqual(new Set(finalList.generations.map(item => item.generationId)), new Set([gen1, gen2, gen3]))
      const second = finalList.generations.find(item => item.generationId === gen2)
      const third = finalList.generations.find(item => item.generationId === gen3)
      assert.deepEqual(second.parentGenerationIds, [gen1])
      assert.deepEqual(third.parentGenerationIds, [gen1])
      assert.equal(second.hasSibling, true)
      assert.equal(third.hasSibling, true)
      assert(second.siblingGenerationIds.includes(gen3))
      assert(third.siblingGenerationIds.includes(gen2))
      results.push({ name: 'profile-a-os-secret-restart-gen3-sibling', outcome: 'PASS', parents: [gen1], siblings: [gen2, gen3] })
    } finally { await session.app.close() }

    const archiveUrl = new URL(`books/${cloudBookId}/generations/${gen1}/archive.ainovel`, dav.endpoint)
    const archiveBeforeProbe = Buffer.from(dav.files.get(archiveUrl.pathname))
    const overwrite = await fetch(archiveUrl, {
      method: 'PUT',
      headers: { Authorization: dav.authorization, 'If-None-Match': '*', 'Content-Length': '9' },
      body: 'overwrite',
    })
    assert.equal(overwrite.status, 412)
    assert.deepEqual(dav.files.get(archiveUrl.pathname), archiveBeforeProbe)

    session = await launch(profiles.B)
    try {
      const reopened = await call(session.page, 'project:open', restoredProjectPath, randomUUID(), null)
      assert.equal(reopened.success, true, reopened.error)
      const restoredSession = { projectId: restoredProjectId, projectPath: restoredProjectPath, leaseId: reopened.project.sessionLease }
      const before = await call(session.page, 'cloud-backup:view', restoredSession)
      assert.equal(before.success, true, before.errorCode)
      assert.equal(before.state, 'configured')
      const remoteBefore = new Map(dav.files)
      const cleared = await call(session.page, 'cloud-backup:clear-credential', accountB)
      assert.equal(cleared.success, true, cleared.errorCode)
      assert.equal(cleared.affectedBindings, 1)
      const after = await call(session.page, 'cloud-backup:view', restoredSession)
      assert.equal(after.success, true, after.errorCode)
      assert.equal(after.state, 'unconfigured')
      assert.equal(after.binding.mode, 'unconfigured')
      assert.equal(after.account, null)
      assert.deepEqual(dav.files, remoteBefore)
      results.push({ name: 'profile-b-clear-credential-keeps-remote-generations', outcome: 'PASS', remoteFilesUnchanged: true })
    } finally { await session.app.close() }
    assertEncryptedCredential(profiles.B, 0)
    assertNoPlaintextSecret(profiles.B.root)

    assert.equal(dav.requests.filter(request => request.method === 'PUT').every(request => request.ifNoneMatch === '*'), true)
    assert.equal(dav.requests.filter(request => request.method === 'MKCOL').every(request => request.ifNoneMatch === '*'), true)
    assert.equal(dav.requests.every(request => request.authorized), true)
    assert.equal(dav.rejectedOverwrites, 1)
    const observedMethods = [...new Set(dav.requests.map(request => request.method))].sort()
    assert.deepEqual(observedMethods, ['GET', 'HEAD', 'MKCOL', 'PROPFIND', 'PUT'])
    const generationObjectLayout = Object.fromEntries([gen1, gen2, gen3].map(generationId => {
      const prefix = `/dav/books/${cloudBookId}/generations/${generationId}/`
      const objects = [...dav.files.keys()].filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length)).sort()
      assert.deepEqual(objects, ['archive.ainovel', 'completion.json', 'manifest.json'])
      return [generationId, objects]
    }))
    assert.equal([...dav.files.keys()].every(file => /^\/dav\/books\/[^/]+\/generations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(archive\.ainovel|manifest\.json|completion\.json)$/u.test(file)), true)
    assert.equal([...dav.collections].every(collection => collection.startsWith('/dav/')), true)
    outcome = 'PASS'
    const evidence = {
      outcome,
      qualification: 'B02_PRODUCT_ACCEPTANCE',
      physicalModelRequests: 0,
      modelIpcInvocations: 0,
      invokedChannels: [...invokedChannels].sort(),
      profiles: {
        A: { roots: { canonical: profiles.A.canonical, userData: profiles.A.userData }, credentialFile: aCredentialFile,
          credentialPersistence: 'os-backed', plaintextSecretAbsent: true, persistentFilesScanned: aPersistentFileCount },
        B: { roots: { canonical: profiles.B.canonical, userData: profiles.B.userData }, credentialFile: bCredentialFile,
          credentialPersistence: 'os-backed', plaintextSecretAbsent: true, persistentFilesScanned: bPersistentFileCount,
          credentialAccountsAfterClear: 0 },
      },
      webDav: {
        endpointOrigin: new URL(dav.endpoint).origin,
        generationIds: [gen1, gen2, gen3],
        putCount: dav.requests.filter(request => request.method === 'PUT').length,
        everyPutUsedIfNoneMatch: true,
        rejectedOverwriteProbe: dav.rejectedOverwrites,
        remoteFileCount: dav.files.size,
        observedMethods,
        allObjectsInsideDavRoot: true,
        generationObjectLayout,
        fixtureRejections,
      },
      results,
      unresolvedReliabilityNotClosedByThisRun: unresolvedReliability,
    }
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2))
    process.stdout.write(JSON.stringify({ outcome, scenarios: results.length, physicalModelRequests: 0, evidence: path.relative(repository, path.join(root, 'evidence.json')) }) + '\n')
  } catch (caught) {
    error = caught
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({
      outcome,
      qualification: 'B02_PRODUCT_ACCEPTANCE',
      physicalModelRequests: 0,
      modelIpcInvocations: 0,
      results,
      unresolvedReliabilityNotClosedByThisRun: unresolvedReliability,
      error: caught instanceof Error ? caught.stack ?? caught.message : String(caught),
    }, null, 2))
  } finally {
    await dav.close().catch(() => {})
  }
  if (error) throw error
}

if (process.argv.includes('--help')) {
  process.stdout.write('Run: pnpm build; pnpm run rebuild:electron; node scripts/webdav-backup-startup-acceptance.mjs. Keep rebuild:electron immediately before this real Electron check. Uses only synthetic isolated roots and a controlled 127.0.0.1 WebDAV; no provider or model requests.\n')
} else {
  await main()
}
