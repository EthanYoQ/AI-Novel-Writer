/* global process, Buffer */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import yauzl from 'yauzl'
import { verifyWindowsPackage, verifyPackagedBetterSqliteLoad, verifyPackagedLanceLoad } from './verify-win-package.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: node scripts/f05-u16-packaged-journey.mjs [--reuse-package=<receipt> | --package-dir=<win-unpacked> --asar-sha256=<hash> --exe-sha256=<hash> --build-sha=<sha>] [--probe-hidden-generation] (builds by default; records PARTIAL)\n')
  process.exit(0)
}
const packageVersion = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')).version
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = path.resolve(option('package-dir') ?? path.join(repository, 'release', packageVersion, 'win-unpacked'))
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
const sourceState = () => {
  const hash = createHash('sha256')
  const names = execFileSync('git', ['ls-files', '-z', '--', 'src', 'electron', 'scripts', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'],
  { cwd: repository, maxBuffer: 8 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean)
  for (const name of names) {
    hash.update(name)
    hash.update(fs.readFileSync(path.join(repository, name)))
  }
  return { head: git('rev-parse', 'HEAD'), inputSha256: hash.digest('hex'), dirtyPaths: git('status', '--porcelain').split('\n').filter(Boolean) }
}
function buildPackage() {
  const before = sourceState()
  const startedAt = Date.now()
  const cli = process.env.npm_execpath
  const result = spawnSync(cli ? (process.env.npm_node_execpath || process.execPath) : 'pnpm',
    cli ? [cli, 'run', 'build:win-dir'] : ['run', 'build:win-dir'],
    { cwd: repository, stdio: 'inherit', windowsHide: true, shell: !cli && process.platform === 'win32' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'build:win-dir failed')
  const after = sourceState()
  assert.equal(after.head, before.head, 'HEAD changed during package build')
  assert.equal(after.inputSha256, before.inputSha256, 'package input files changed during build')
  assert.equal(sha256(fileURLToPath(import.meta.url)), driverSha256, 'driver changed during build')
  for (const file of [executablePath, asarPath]) {
    const stat = fs.statSync(file)
    assert(stat.isFile(), `missing freshly built package file: ${file}`)
    if (file === asarPath) assert(stat.mtimeMs >= startedAt - 2_000, 'app.asar predates this package build')
  }
  return { command: 'pnpm run build:win-dir', buildSha: before.head,
    startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(),
    inputSha256: before.inputSha256, dirtyPathsBefore: before.dirtyPaths, dirtyPathsAfter: after.dirtyPaths }
}
function reusePackage(receiptPath) {
  const prior = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  const state = sourceState()
  assert(prior.build && prior.artifact, 'prior receipt lacks built artifact')
  const changedPaths = state.head === prior.build.buildSha ? []
    : git('diff', '--name-only', `${prior.build.buildSha}..${state.head}`).split('\n').filter(Boolean)
  assert(changedPaths.every(name => /^scripts\/f05-[a-z0-9-]+-journey\.mjs$/.test(name)),
    'product or unrelated tracked path changed since package build')
  const productPaths = execFileSync('git', ['ls-files', '-z', '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'],
  { cwd: repository }).toString('utf8').split('\0').filter(Boolean)
  const builtAt = Date.parse(prior.build.completedAt)
  assert(productPaths.every(name => fs.statSync(path.join(repository, name)).mtimeMs <= builtAt + 2_000),
    'product input modified after prior package build')
  assert.equal(sha256(executablePath), prior.artifact.executableSha256, 'packaged executable changed')
  assert.equal(sha256(asarPath), prior.artifact.asarSha256, 'packaged asar changed')
  return { ...prior.build, reusedFromReceipt: receiptPath, reuseDecision: { testedSha: prior.build.buildSha,
    currentHead: state.head, changedPaths, differences: changedPaths.join(', ') || 'none',
    reason: 'U16 package and product inputs unchanged; executable and asar hashes match prior build' },
    reusedDriverChanged: state.inputSha256 !== prior.build.inputSha256,
    dirtyPathsAfter: state.dirtyPaths }
}
function reuseFixedPackage() {
  const buildRef = option('build-sha')
  const expectedAsar = option('asar-sha256')
  const expectedExe = option('exe-sha256')
  assert(/^[a-f0-9]{7,40}$/.test(buildRef ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? '') && /^[a-f0-9]{64}$/.test(expectedExe ?? ''),
    'fixed package requires build SHA and both artifact hashes')
  const buildSha = git('rev-parse', '--verify', `${buildRef}^{commit}`)
  const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml',
    'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
  const changedPaths = git('diff', '--name-only', `${buildSha}..HEAD`, '--', ...productInputs)
  assert.equal(changedPaths, '', 'product input changed since fixed package build')
  assert.equal(git('diff', '--name-only', '--', ...productInputs), '', 'product input has uncommitted changes')
  const dirtyProductPaths = git('status', '--porcelain', '--', ...productInputs).split('\n').filter(Boolean)
  assert(dirtyProductPaths.every(line => /^\?\? src\/components\/.+\/__tests__\/__screenshots__\/$/.test(line)),
    'fixed package has untracked product inputs')
  assert.equal(sha256(asarPath), expectedAsar, 'fixed packaged asar changed')
  assert.equal(sha256(executablePath), expectedExe, 'fixed packaged executable changed')
  const dirtyPaths = sourceState().dirtyPaths
  return { buildSha, inputSha256: null, reusedFromFixedPackage: true, dirtyProductPaths,
    dirtyPathsBefore: dirtyPaths, dirtyPathsAfter: dirtyPaths }
}
const driverSha256 = sha256(fileURLToPath(import.meta.url))
const runId = randomUUID()
const root = path.join(repository, '.runtime', '.cache', 'f05-u16-packaged', runId)
const scratchRoot = path.join(process.env.LOCALAPPDATA ?? path.dirname(repository),
  'VibeCodingScratch', 'an', 'u16', runId.slice(0, 8))
const secret = `u16-local-${randomUUID()}`
const username = 'u16-test'
const profiles = ['a', 'b'].map(name => {
  const base = path.join(scratchRoot, name)
  return { name, base, canonical: path.join(base, 'canonical'), legacy: path.join(base, 'legacy'),
    userData: path.join(base, 'userData'), home: path.join(base, 'home'), appData: path.join(base, 'appData'),
    localAppData: path.join(base, 'localAppData'), projects: path.join(base, 'projects') }
})
const globalRoot = profile => {
  const generations = fs.readdirSync(path.join(profile.canonical, 'generations'))
  assert.equal(generations.length, 1, 'expected one isolated canonical app-data generation')
  return path.join(profile.canonical, 'generations', generations[0])
}
const steps = []
let currentStep = 'setup'
const cloudBookId = `u16-${runId.slice(0, 8)}`
let originProjectId
let cloudGenerationId
const updatedSecret = `u16-updated-${randomUUID()}`
let acceptedSecret = secret
const davRequests = []
const davFiles = new Map()
const davCollections = new Set(['/dav/'])
const dav = createServer(async (request, response) => {
  const authorized = request.headers.authorization === `Basic ${Buffer.from(`${username}:${acceptedSecret}`).toString('base64')}`
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const method = request.method
  const record = status => davRequests.push({ method, pathname, authorized, status })
  if (!authorized) { record(401); response.writeHead(401).end(); return }
  if (method === 'MKCOL') {
    const exists = davCollections.has(pathname)
    if (!exists) davCollections.add(pathname)
    record(exists ? 405 : 201); response.writeHead(exists ? 405 : 201).end(); return
  }
  if (method === 'PUT') {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    const exists = davFiles.has(pathname)
    if (!exists) davFiles.set(pathname, bytes)
    record(exists ? 412 : 201); response.writeHead(exists ? 412 : 201).end(); return
  }
  if (method === 'HEAD' || method === 'GET') {
    const bytes = davFiles.get(pathname)
    record(bytes ? 200 : 404)
    response.writeHead(bytes ? 200 : 404, bytes ? { 'content-length': bytes.length } : undefined)
    response.end(method === 'GET' ? bytes : undefined); return
  }
  if (method === 'PROPFIND') {
    const children = request.headers.depth === '1' ? [...davCollections].filter(candidate =>
      candidate.startsWith(pathname) && candidate !== pathname && !candidate.slice(pathname.length).replace(/\/$/, '').includes('/')) : []
    const body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[pathname, ...children].map(href =>
      `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response>`).join('')}</d:multistatus>`
    record(207); response.writeHead(207, { 'content-type': 'application/xml' }).end(body); return
  }
  record(405); response.writeHead(405).end()
})
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const pass = (stepId, actionId, assertion) => steps.push({ stepId, actionId, assertion, outcome: 'PASS' })
const archiveManifest = bytes => new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
  if (error || !zip) return reject(error ?? new Error('archive unavailable'))
  zip.once('error', reject)
  zip.once('entry', entry => {
    if (entry.fileName !== 'manifest.json') { zip.close(); reject(new Error('archive manifest missing')); return }
    zip.openReadStream(entry, async (streamError, stream) => {
      if (streamError || !stream) { zip.close(); reject(streamError ?? new Error('manifest unavailable')); return }
      try {
        const chunks = []
        for await (const chunk of stream) chunks.push(chunk)
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (readError) { reject(readError) } finally { zip.close() }
    })
  })
  zip.readEntry()
}))
const visibleGeneration = (panel, generationId) => panel.locator(`input[name="restore-generation"][value="${generationId}"]`).waitFor({ state: 'visible', timeout: 5_000 })
async function waitNotice(panel, expected, timeout = 30_000) {
  try { await panel.getByRole('status').filter({ hasText: expected }).waitFor({ timeout }) }
  catch (error) {
    const notices = await panel.locator('[role="status"], [role="alert"]').allTextContents()
    const body = await panel.locator('xpath=ancestor::body').innerText().catch(() => '')
    throw new Error(`${currentStep}: expected ${expected}; panel count ${await panel.count()}; actual notices ${JSON.stringify(notices)}; body ${body.slice(-1000)}`, { cause: error })
  }
}
async function openBackup(page, projectName) {
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
  await page.getByRole('button', { name: `打开《${projectName}》` }).click()
  await page.locator('.writer-left-rail button[title="设置"]').click()
  await page.getByRole('button', { name: '项目备份', exact: true }).click()
  await page.getByRole('heading', { name: '项目备份', exact: true }).waitFor()
  if (process.argv.includes('--probe-hidden-generation')) {
    await page.addStyleTag({ content: 'li:has(input[name="restore-generation"]) { display: none !important }' })
  }
  return page.getByTestId('project-backup-panel')
}

async function launchProfile(profile) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy, AI_NOVEL_VELA_HOME: profile.legacy,
    HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const app = await electron.launch({ executablePath, cwd: packageDir,
    args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  try {
    const page = await app.firstWindow({ timeout: 30_000 })
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    return { app, page }
  } catch (error) { await app.close(); throw error }
}

async function runProfile(profile, endpoint) {
  for (const directory of Object.values(profile).filter(value => value !== profile.name)) fs.mkdirSync(directory, { recursive: true })
  currentStep = `${profile.name}:launch`
  const { app, page } = await launchProfile(profile)
  const firstPid = app.process()?.pid
  try {
    const paths = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'),
      home: process.env.HOME, appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA }))
    for (const [key, expected] of [['userData', profile.userData], ['home', profile.home],
      ['appData', profile.appData], ['localAppData', profile.localAppData]]) assert.equal(path.resolve(paths[key]), expected)
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    steps.push({ stepId: `${profile.name}-packaged-startup`, assertion: 'isolated packaged process and ready IPC', outcome: 'PASS' })

    // Test-profile setup only. Keep the release default untouched and verify the actual rendered shell.
    await page.evaluate(() => {
      const key = 'ai-novel-writer-appearance'
      const profile = JSON.parse(localStorage.getItem(key))
      profile.shellPreference = 'writer'
      profile.revision += 1
      profile.origin = 'author'
      localStorage.setItem(key, JSON.stringify(profile))
    })
    await page.reload()
    await page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible', timeout: 30_000 })
    steps.push({ stepId: `${profile.name}-v3-shell`, assertion: 'explicit profile selection rendered V3 Writer shell', outcome: 'PASS' })

    // Setup may use IPC. The U16 action starts after V3 opens this project through its own control.
    currentStep = `${profile.name}:project-setup`
    const projectName = `U16-${profile.name}`
    const created = await invoke(page, 'project:create', { path: profile.projects, name: projectName,
      genre: 'fixture', targetAudience: 'fixture', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    if (profile.name === 'a') {
      const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
      assert.equal(opened.success, true, opened.error)
      const projectSession = { projectId: created.projectId, projectPath: created.projectPath,
        leaseId: opened.project.sessionLease }
      const seeded = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
        content: `云归档合成正文 ${runId}`, wordCount: 8 }, created.projectPath, projectSession)
      assert.equal(seeded.success, true, seeded.error)
    }
    await page.reload()
    await page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
    const panel = await openBackup(page, projectName)
    const project = await invoke(page, 'project:get-runtime-context')
    assert.equal(path.resolve(project.activeProjectPath), path.resolve(created.projectPath))
    if (profile.name === 'a') originProjectId = created.projectId

    await panel.getByLabel('WebDAV 地址').fill(endpoint)
    await panel.getByLabel('用户名').fill(username)
    await panel.getByLabel('密码或应用密钥').fill(acceptedSecret)
    await panel.getByLabel('云书标识').fill(cloudBookId)
    const before = davRequests.length
    currentStep = `${profile.name}:U16.A03-connect-and-bind`
    await panel.getByRole('button', { name: '连接并绑定' }).click()
    await panel.getByRole('status').filter({ hasText: 'WebDAV 已连接并绑定' }).waitFor({ timeout: 30_000 })
    const observed = davRequests.slice(before)
    assert(observed.some(request => request.method === 'PROPFIND' && request.pathname === '/dav/'
      && request.authorized && request.status === 207), 'missing authorized controlled WebDAV probe')
    const bindingStore = JSON.parse(fs.readFileSync(path.join(globalRoot(profile), 'cloud-backup-bindings.json'), 'utf8'))
    const binding = bindingStore.bindings.find(value => value.localProjectId === created.projectId)
    assert.equal(binding.mode, 'writable')
    assert.equal(binding.cloudBookId, cloudBookId)
    assert(await panel.getByText('可写绑定：').isVisible())
    steps.push({ stepId: `${profile.name}-U16.A03`, actionId: 'U16.A03', assertion: 'V3 settings control to authorized WebDAV probe and writable persisted binding', outcome: 'PASS' })
    if (profile.name === 'a') {
      currentStep = 'a:U16.A05-cloud-upload'
      await panel.locator('input[name="cloud-disclosure"]').check()
      await panel.getByRole('button', { name: '立即云备份' }).click()
      await waitNotice(panel, '云备份完成：', 60_000)
      const completionPath = [...davFiles.keys()].find(key => key.endsWith('/completion.json'))
      assert(completionPath, 'generation completion absent')
      const generationPath = completionPath.slice(0, -'completion.json'.length)
      const archiveBytes = davFiles.get(`${generationPath}archive.ainovel`)
      const manifestBytes = davFiles.get(`${generationPath}manifest.json`)
      assert(archiveBytes && manifestBytes, 'generation archive or manifest absent')
      const manifest = JSON.parse(manifestBytes.toString('utf8'))
      const completion = JSON.parse(davFiles.get(completionPath).toString('utf8'))
      assert.deepEqual(Object.keys(manifest).sort(), ['archive', 'cloudBookId', 'createdAt', 'generationId',
        'originProjectId', 'parentGenerationIds', 'portableSnapshotGeneration', 'version'].sort())
      assert.equal(manifest.version, 1)
      assert.equal(manifest.cloudBookId, cloudBookId)
      assert.equal(manifest.originProjectId, originProjectId)
      assert.equal(manifest.generationId, path.posix.basename(generationPath.slice(0, -1)))
      cloudGenerationId = manifest.generationId
      assert.deepEqual(Object.keys(completion).sort(), ['archive', 'cloudBookId', 'completedAt',
        'generationId', 'manifest', 'version'].sort())
      assert.equal(completion.version, 1)
      assert.equal(completion.cloudBookId, cloudBookId)
      assert.equal(completion.generationId, manifest.generationId)
      assert.deepEqual(completion.manifest, { file: 'manifest.json', sha256: createHash('sha256').update(manifestBytes).digest('hex'),
        byteSize: manifestBytes.length })
      assert.deepEqual(manifest.archive, { file: 'archive.ainovel', sha256: createHash('sha256').update(archiveBytes).digest('hex'),
        byteSize: archiveBytes.length })
      assert.deepEqual(completion.archive, manifest.archive)
      const portable = await archiveManifest(archiveBytes)
      assert.equal(portable.sourceSchemaVersion, 7)
      assert.equal(portable.originProjectId, originProjectId)
      assert.equal(portable.semanticCounts['table.drafts'], 1)
      assert.equal(portable.semanticCounts['table.review_cycle_merges'], 0)
      assert(portable.entries.some(entry => entry.path === 'project.db' && entry.disposition === 'portable-database'))
      pass('a-U16.A05', 'U16.A05', 'Writer uploaded a nonempty schema-7 archive and hash-linked immutable manifest/completion')
    }

    currentStep = `${profile.name}:U16.A06-cloud-list`
    await panel.getByRole('button', { name: '刷新云端世代' }).click()
    await panel.getByRole('status').filter({ hasText: '已读取 1 个云端世代' }).waitFor({ timeout: 30_000 })
    const listed = await invoke(page, 'cloud-backup:list', { localEndpointAccountId: binding.localEndpointAccountId, cloudBookId })
    assert.equal(listed.success, true, listed.errorCode)
    assert.equal(listed.generations.length, 1)
    const generation = listed.generations[0]
    assert.equal(generation.originProjectId, originProjectId)
    const remoteArchive = davFiles.get([...davFiles.keys()].find(key => key.endsWith('/archive.ainovel')))
    assert.equal(generation.archiveSha256, createHash('sha256').update(remoteArchive).digest('hex'))
    await visibleGeneration(panel, generation.generationId)
    if (process.argv.includes('--probe-hidden-generation')) {
      const entry = panel.locator(`input[name="restore-generation"][value="${generation.generationId}"]`)
      assert.equal(await entry.count(), 1)
      assert.equal(await entry.isVisible(), false)
    }
    pass(`${profile.name}-U16.A06`, 'U16.A06', 'V3 rendered the exact listed generation from controlled DAV')
  } finally {
    await app.close()
  }
  currentStep = `${profile.name}:restart-without-secret`
  const restarted = await launchProfile(profile)
  try {
    const page = restarted.page
    assert.notEqual(restarted.app.process()?.pid, firstPid, 'restart reused the original process')
    assert.equal(path.resolve(await restarted.app.evaluate(({ app }) => app.getPath('userData'))), profile.userData)
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    await page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible', timeout: 30_000 })
    const panel = await openBackup(page, `U16-${profile.name}`)
    await panel.getByText('可写绑定：').waitFor({ state: 'visible', timeout: 30_000 })
    const before = davRequests.length
    await panel.getByRole('button', { name: '刷新云端世代' }).click()
    await panel.getByRole('status').filter({ hasText: '已读取 1 个云端世代' }).waitFor({ timeout: 30_000 })
    assert(davRequests.slice(before).some(request => request.method === 'PROPFIND'
      && request.pathname === `/dav/books/${cloudBookId}/generations/`
      && request.authorized && request.status === 207), 'saved OS credential did not authorize restart probe')
    await visibleGeneration(panel, cloudGenerationId)
    steps.push({ stepId: `${profile.name}-restart-credential`, assertion: 'same packaged profile restarted; V3 rendered WebDAV generation without secret re-entry', outcome: 'PASS' })
    if (profile.name === 'a') {
      currentStep = 'a:U16.A04-update-credential'
      const bindingPath = path.join(globalRoot(profile), 'cloud-backup-bindings.json')
      const accountId = JSON.parse(fs.readFileSync(bindingPath, 'utf8')).bindings
        .find(value => value.localProjectId === originProjectId).localEndpointAccountId
      await panel.getByLabel('密码或应用密钥').fill(updatedSecret)
      acceptedSecret = updatedSecret
      await panel.getByRole('button', { name: '连接并绑定' }).click()
      await panel.getByRole('status').filter({ hasText: 'WebDAV 已连接并绑定' }).waitFor({ timeout: 30_000 })
      const updatedBefore = davRequests.length
      await panel.getByRole('button', { name: '刷新云端世代' }).click()
      await panel.getByRole('status').filter({ hasText: '已读取 1 个云端世代' }).waitFor({ timeout: 30_000 })
      assert(davRequests.slice(updatedBefore).some(request => request.authorized && request.status === 207))
      await visibleGeneration(panel, cloudGenerationId)
      const updatedId = JSON.parse(fs.readFileSync(bindingPath, 'utf8')).bindings
        .find(value => value.localProjectId === originProjectId).localEndpointAccountId
      assert.notEqual(updatedId, accountId, 'credential update did not rotate the account reference')
      const updatedAccounts = JSON.parse(fs.readFileSync(path.join(globalRoot(profile), 'cloud-backup-credentials.json'), 'utf8')).accounts
      assert.deepEqual(updatedAccounts.map(account => account.accountId), [updatedId],
        'unreferenced old credential survived successful update')
      pass('a-U16.A04-update', 'U16.A04', 'Writer rotated account reference and persisted OS credential; old unreferenced account removed')

      currentStep = 'a:U16.A04-clear-credential'
      await panel.getByRole('button', { name: '清除本机凭据' }).click()
      await panel.getByRole('button', { name: '确认清除本机凭据' }).click()
      await panel.getByRole('status').filter({ hasText: '本机凭据已清除' }).waitFor({ timeout: 30_000 })
      const bindings = JSON.parse(fs.readFileSync(bindingPath, 'utf8')).bindings
      assert.equal(bindings.find(value => value.localProjectId === originProjectId).mode, 'unconfigured')
      assert.equal(JSON.parse(fs.readFileSync(path.join(globalRoot(profile), 'cloud-backup-credentials.json'), 'utf8')).accounts.length, 0)
      assert([...davFiles.keys()].some(key => key.endsWith('/completion.json')), 'clear credential deleted remote generation')
      pass('a-U16.A04-clear', 'U16.A04', 'Writer cleared local credential and binding without deleting cloud generation')
    }
  } finally { await restarted.app.close() }
  const credentialDir = profile.canonical
  const files = fs.readdirSync(credentialDir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  for (const file of files) for (const value of [secret, updatedSecret]) {
    assert.equal(fs.readFileSync(path.join(file.parentPath, file.name)).includes(value), false,
      'plaintext credential in canonical profile')
  }
}

async function main() {
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(scratchRoot, { recursive: true })
  fs.writeFileSync(path.join(scratchRoot, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U16 packaged acceptance',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 48,
    retainedReason: 'F05 packaged receipt review of OS-backed credential and restart state',
    cleanupCommand: `Remove-Item -LiteralPath '${scratchRoot.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let outcome = 'FAIL'
  let failure
  let build
  try {
    currentStep = 'build:win-dir'
    const reuseArg = process.argv.find(arg => arg.startsWith('--reuse-package='))
    const fixedPackage = option('package-dir')
    assert(!(reuseArg && fixedPackage), 'choose one package reuse mode')
    build = fixedPackage ? reuseFixedPackage()
      : reuseArg ? reusePackage(reuseArg.slice('--reuse-package='.length)) : buildPackage()
    steps.push({ stepId: fixedPackage || reuseArg ? 'verified-package-reuse' : 'fresh-package-build',
      assertion: fixedPackage ? 'fixed package hashes and unchanged product inputs verified'
        : reuseArg ? 'prior build receipt, product file timestamps, HEAD and artifact hashes verified'
          : 'standard build and stable HEAD/input fingerprint', outcome: 'PASS' })
    currentStep = 'packaged-native-load'
    const verifiedPackage = verifyWindowsPackage(packageDir)
    assert(verifiedPackage.nativeBinding && verifiedPackage.betterSqliteBinding)
    assert.equal(verifyPackagedBetterSqliteLoad(packageDir), 'PACKAGED_BETTER_SQLITE3_LOAD_OK')
    assert.equal(verifyPackagedLanceLoad(packageDir), 'PACKAGED_LANCEDB_LOAD_OK')
    steps.push({ stepId: 'packaged-native-load', assertion: 'packaged better-sqlite3 and LanceDB native bindings load', outcome: 'PASS' })
    await new Promise((resolve, reject) => { dav.once('error', reject); dav.listen(0, '127.0.0.1', resolve) })
    const address = dav.address()
    assert(address && typeof address === 'object')
    const endpoint = `http://127.0.0.1:${address.port}/dav/`
    assert.notEqual(profiles[0].canonical, profiles[1].canonical)
    assert.notEqual(profiles[0].userData, profiles[1].userData)
    for (const profile of profiles) await runProfile(profile, endpoint)
    for (const actionId of ['U16.A03', 'U16.A04', 'U16.A05', 'U16.A06']) {
      assert(steps.some(step => step.actionId === actionId && step.outcome === 'PASS'), `missing ${actionId} action assertion`)
    }
    outcome = 'PARTIAL'
  } catch (error) { failure = error }
  finally { if (dav.listening) await new Promise(resolve => dav.close(() => resolve())) }
  const receipt = { outcome, qualification: 'F05_U16_NON_PICKER_A03_A04_A05_A06_ONLY',
    diagnosticProbe: process.argv.includes('--probe-hidden-generation') ? 'hidden-generation' : null,
    unverifiedActions: ['U16.A01', 'U16.A02', 'U16.A07', 'U16.A08', 'U16.A09', 'U16.A10', 'U16.A11', 'U16.A12'],
    testedSha: build?.buildSha ?? null,
    sourceDirty: build ? build.dirtyPathsBefore.length > 0 : null,
    build,
    artifact: build ? { source: build.reusedFromFixedPackage ? 'verified fixed F04 package' : build.reusedFromReceipt ? 'verified prior build:win-dir receipt' : 'fresh build:win-dir in this driver run', buildSha: build.buildSha,
      inputSha256: build.inputSha256, executablePath, executableSha256: sha256(executablePath),
      asarPath, asarSha256: sha256(asarPath) } : null,
    driver: { source: 'current worktree script', path: fileURLToPath(import.meta.url), sha256: driverSha256 },
    profiles: profiles.map(profile => ({ name: profile.name, canonical: profile.canonical, userData: profile.userData })),
    controlledWebDav: { requestCount: davRequests.length, authorizedProbeCount: davRequests.filter(request => request.authorized && request.method === 'PROPFIND' && request.status === 207).length,
      requestOutcomes: davRequests.map(({ method, pathname, authorized, status }) => ({ method, resource: path.posix.basename(pathname), authorized, status })) },
    steps, failedStep: failure ? currentStep : null,
    error: failure ? String(failure).replaceAll(secret, '[redacted]').replaceAll(updatedSecret, '[redacted]') : null }
  fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(JSON.stringify({ outcome, receipt: path.join(root, 'receipt.json'), steps: steps.length }) + '\n')
  if (failure) throw failure
}

await main()
