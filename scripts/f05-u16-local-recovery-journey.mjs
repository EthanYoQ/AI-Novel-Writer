/* global process */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { verifyWindowsPackage, verifyPackagedBetterSqliteLoad, verifyPackagedLanceLoad } from './verify-win-package.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = fileURLToPath(import.meta.url)
const helperPath = path.join(repository, 'scripts', 'f05-u16-native-picker.ps1')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex')
const driverSha256 = hash(scriptPath)
const helperSha256 = hash(helperPath)
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const fixedPackage = option('package-dir')
const localOnly = process.argv.includes('--local-only')
const priorPath = process.argv.find(arg => arg.startsWith('--reuse-package='))?.slice('--reuse-package='.length)
assert(fixedPackage || priorPath && fs.existsSync(priorPath), 'pass --reuse-package=<receipt> or --package-dir=<win-unpacked> with hashes')
assert(!(fixedPackage && priorPath), 'choose one package mode')
const prior = fixedPackage ? null : JSON.parse(fs.readFileSync(priorPath, 'utf8'))
if (prior) assert(prior.build?.buildSha && prior.artifact, 'prior package receipt lacks build attribution')
const version = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')).version
const packageDir = path.resolve(fixedPackage ?? path.join(repository, 'release', version, 'win-unpacked'))
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const runId = randomUUID()
const receiptDir = path.join(repository, '.runtime', '.cache', 'f05-u16-local-recovery', runId)
assert(process.env.LOCALAPPDATA, 'short LOCALAPPDATA scratch required')
const scratch = path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'AI-Novel', `u16r-${runId.slice(0, 8)}`)
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects', 'exports', 'restored']
  .map(name => [name, path.join(scratch, name)]))
const name = '归档原稿'
const cloudBookId = `u16r-${runId.slice(0, 8)}`
const secret = randomUUID()
const username = 'local-test'
const steps = []
const pickerEvidence = []
const davRequests = []
const davFiles = new Map()
const davCollections = new Set(['/dav/'])
let currentStep = 'setup'
const pass = (stepId, actionId, assertion) => steps.push({ stepId, actionId, outcome: 'PASS', assertion })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const folded = value => path.win32.normalize(value).toLowerCase()

function provenance() {
  if (fixedPackage) {
    const buildRef = option('build-sha')
    const expectedAsar = option('asar-sha256')
    const expectedExe = option('exe-sha256')
    assert(/^[a-f0-9]{7,40}$/.test(buildRef ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? '')
      && /^[a-f0-9]{64}$/.test(expectedExe ?? ''), 'fixed package requires build SHA and both hashes')
    const testedSha = git('rev-parse', '--verify', `${buildRef}^{commit}`)
    const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml',
      'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
    assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', ...productInputs), '',
      'product input changed since fixed package build')
    assert.equal(git('diff', '--name-only', '--', ...productInputs), '', 'product input has uncommitted changes')
    assert.equal(hash(executablePath), expectedExe)
    assert.equal(hash(asarPath), expectedAsar)
    return { testedSha, executionHead: git('rev-parse', 'HEAD'), changedPaths: [],
      sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean),
      executableSha256: expectedExe, asarSha256: expectedAsar,
      reuseReason: 'Fixed package hashes match and product inputs are unchanged.' }
  }
  const testedSha = prior.build.buildSha
  const executionHead = git('rev-parse', 'HEAD')
  const changedPaths = git('diff', '--name-only', `${testedSha}..${executionHead}`).split('\n').filter(Boolean)
  assert(changedPaths.every(file => /^scripts\/f05-[a-z0-9-]+-journey\.mjs$/.test(file)),
    'product or unrelated tracked file changed since package build')
  const dirtyProductPaths = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5').split('\n').filter(Boolean)
  assert(dirtyProductPaths.every(line => /^\?\? src\/components\/(?:editor|layout\/v2|panels)\/__tests__\/__screenshots__\/$/.test(line)),
    'product source dirty beyond test screenshots')
  const productPaths = execFileSync('git', ['ls-files', '-z', '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'],
  { cwd: repository }).toString('utf8').split('\0').filter(Boolean)
  assert(productPaths.every(file => fs.statSync(path.join(repository, file)).mtimeMs <= Date.parse(prior.build.completedAt) + 2_000),
    'product input modified after package build')
  assert.equal(hash(executablePath), prior.artifact.executableSha256)
  assert.equal(hash(asarPath), prior.artifact.asarSha256)
  return { testedSha, executionHead, changedPaths, sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean),
    dirtyProductPaths, buildReceipt: {
    path: priorPath, sha256: hash(priorPath) }, executableSha256: hash(executablePath), asarSha256: hash(asarPath),
    reuseReason: 'Only F05 journey scripts changed; all product input mtimes predate build and packaged bytes match prior receipt.' }
}

const dav = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const method = request.method
  const authorized = request.headers.authorization === `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`
  const record = status => davRequests.push({ method, pathname, authorized, status })
  if (!authorized) { record(401); response.writeHead(401).end(); return }
  if (method === 'MKCOL') {
    const exists = davCollections.has(pathname)
    davCollections.add(pathname)
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

function picker(title, target) {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-Target', target, '-ExpectedExe', executablePath, '-DialogTitle', title],
  { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, `native picker ${title}: ${result.stderr || result.error || result.stdout}`)
  const evidence = JSON.parse(result.stdout.trim())
  assert.equal(evidence.typedExact, true)
  assert.equal(evidence.submitted, true)
  return evidence
}

async function preflight(page, channel, args, selection, expectedResult) {
  const evidence = { kind: 'public-ipc-preflight', channel, title: selection.title, target: selection.target }
  pickerEvidence.push(evidence)
  const pending = invoke(page, channel, ...args).then(result => ({ result }), error => ({ error: String(error) }))
  await new Promise(resolve => setTimeout(resolve, 100))
  const helper = picker(selection.title, selection.target)
  evidence.helper = helper
  let timer
  const outcome = await Promise.race([pending, new Promise(resolve => {
    timer = setTimeout(() => resolve({ error: 'IPC_TIMEOUT_15000' }), 15_000)
  })])
  clearTimeout(timer)
  evidence.ipcResult = outcome.result ?? null
  evidence.error = outcome.error ?? null
  assert.equal(outcome.error, undefined, `public ${channel} IPC failed: ${outcome.error}`)
  assert.equal(folded(outcome.result), folded(expectedResult), `public ${channel} IPC returned unexpected path`)
  return evidence
}

async function choose(button, selections) {
  await button.click()
  return selections.map(selection => {
    const evidence = { kind: 'writer-control-picker', title: selection.title, target: selection.target }
    pickerEvidence.push(evidence)
    evidence.helper = picker(selection.title, selection.target)
    return evidence
  })
}

async function main() {
  const source = provenance()
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u16-local-recovery',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
    retainReason: 'Review F05 packaged local and cloud restore evidence',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch}' -Recurse -Force` }, null, 2))
  let app
  let panel
  try {
    currentStep = 'packaged-native-load'
    assert(verifyWindowsPackage(packageDir).betterSqliteBinding)
    assert.equal(verifyPackagedBetterSqliteLoad(packageDir), 'PACKAGED_BETTER_SQLITE3_LOAD_OK')
    assert.equal(verifyPackagedLanceLoad(packageDir), 'PACKAGED_LANCEDB_LOAD_OK')
    if (!localOnly) await new Promise((resolve, reject) => { dav.once('error', reject); dav.listen(0, '127.0.0.1', resolve) })
    const endpoint = dav.listening ? `http://127.0.0.1:${dav.address().port}/dav/` : null
    const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical,
      AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy, AI_NOVEL_VELA_HOME: profile.legacy,
      HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
    app = await electron.launch({ executablePath, cwd: packageDir,
      args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
    const page = await app.firstWindow({ timeout: 30_000 })
    page.setDefaultTimeout(15_000)
    await page.locator('.app-skin-root').waitFor({ state: 'visible' })
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), profile.userData)
    await page.evaluate(() => {
      const key = 'ai-novel-writer-appearance'
      const appearance = JSON.parse(localStorage.getItem(key))
      localStorage.setItem(key, JSON.stringify({ ...appearance, shellPreference: 'writer', revision: appearance.revision + 1, origin: 'author' }))
    })
    await page.reload()
    await page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
    const created = await invoke(page, 'project:create', { path: profile.projects, name,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    const context = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
    const draftContent = `隔离原稿 ${runId}`
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
      content: draftContent, wordCount: 4 }, created.projectPath, context)
    assert.equal(draft.success, true, draft.error)
    await page.reload()
    await page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
    currentStep = 'v3-backup-entry'
    const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
    await page.getByRole('button', { name: `打开《${name}》` }).click()
    assert.equal(path.resolve((await invoke(page, 'project:get-runtime-context')).activeProjectPath), path.resolve(created.projectPath))
    await page.locator('.writer-left-rail button[title="设置"]').click()
    await page.getByRole('button', { name: '项目备份', exact: true }).click()
    await page.getByRole('heading', { name: '项目备份', exact: true }).waitFor()
    panel = page.getByTestId('project-backup-panel')
    await panel.getByText('本地便携存档').waitFor()
    currentStep = 'U16.A01'
    const localArchive = path.join(profile.exports, 'local.ainovel')
    await preflight(page, 'dialog:select-project-archive-export', [name],
      { title: '导出项目存档', target: localArchive }, localArchive)
    assert.equal(fs.existsSync(localArchive), false, 'picker preflight wrote an archive')
    await choose(panel.getByRole('button', { name: '导出本地存档' }), [
      { title: '导出项目存档', target: localArchive },
    ])
    await panel.getByRole('status').filter({ hasText: '本地存档已导出：' }).waitFor({ timeout: 60_000 })
    assert(fs.statSync(localArchive).size > 0)
    const localSha256 = hash(localArchive)
    assert.match(await panel.getByRole('status').last().innerText(), new RegExp(localSha256))
    const originalDb = path.join(created.projectPath, '.ai-novel', 'project.db')
    const originalSha256 = hash(originalDb)
    pass('v3-local-export', 'U16.A01', 'Public picker IPC preflight matched isolated target; V3 native Save selection created archive and UI receipt hash matches bytes')

    currentStep = 'U16.A02'
    const localParent = path.join(profile.restored, 'local')
    fs.mkdirSync(localParent, { recursive: true })
    await preflight(page, 'dialog:select-project-archive', [],
      { title: '选择项目存档', target: localArchive }, localArchive)
    await preflight(page, 'dialog:select-project-restore-target', [`${name}-恢复副本`],
      { title: '选择恢复副本所在文件夹', target: localParent },
      path.join(localParent, `${name}-恢复副本`))
    assert.equal(fs.existsSync(path.join(localParent, `${name}-恢复副本`)), false, 'folder preflight created copy')
    await choose(panel.getByRole('button', { name: '从本地存档恢复副本' }), [
      { title: '选择项目存档', target: localArchive },
      { title: '选择恢复副本所在文件夹', target: localParent },
    ])
    await panel.getByRole('status').filter({ hasText: '已恢复新副本' }).waitFor({ timeout: 60_000 })
    const localCopy = path.join(localParent, `${name}-恢复副本`)
    assert(fs.existsSync(path.join(localCopy, '.ai-novel', 'project.db')))
    assert.equal(hash(originalDb), originalSha256, 'local restore changed original project database')

    if (localOnly) {
      currentStep = 'U16.A02-reopen-copy'
      const firstPid = app.process()?.pid
      await app.close()
      app = await electron.launch({ executablePath, cwd: packageDir,
        args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
      assert.notEqual(app.process()?.pid, firstPid, 'reopen reused the original process')
      const reopenedPage = await app.firstWindow({ timeout: 30_000 })
      await reopenedPage.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
      assert.equal((await invoke(reopenedPage, 'startup:get-state')).state, 'ready')
      const reopened = await invoke(reopenedPage, 'project:open', localCopy, randomUUID(), null)
      assert.equal(reopened.success, true, reopened.error)
      assert.notEqual(reopened.project.id, created.projectId, 'restored copy reused origin project ID')
      assert.equal(folded((await invoke(reopenedPage, 'project:get-runtime-context')).activeProjectPath), folded(localCopy))
      const copySession = { projectId: reopened.project.id, projectPath: localCopy, leaseId: reopened.project.sessionLease }
      const copyDrafts = await invoke(reopenedPage, 'db:draft-list', 1, localCopy, copySession)
      assert.equal(copyDrafts.length, 1)
      const copyDraft = await invoke(reopenedPage, 'db:draft-get-full', copyDrafts[0].id, localCopy, copySession)
      assert.equal(copyDraft.content, draftContent)
      assert.equal(hash(originalDb), originalSha256, 'reopening copy changed origin project database')
      pass('v3-local-restore-copy-reopen', 'U16.A02', 'V3 native OpenFile/OpenDirectory restored distinct copy; new process read exact draft and origin DB stayed byte-identical')
      const reopenedPid = app.process()?.pid
      await app.close()
      app = null
      assert.equal(hash(scriptPath), driverSha256)
      assert.equal(hash(helperPath), helperSha256)
      assert.equal(provenance().asarSha256, source.asarSha256)
      const receipt = { outcome: 'PARTIAL', qualification: 'F05_U16_A01_A02_PACKAGED_V3_ONLY', evidenceLevel: 'packaged-electron', presentation: 'writer-v3',
        ...source, driverSha256, helperSha256, packageDir, localSha256, originalSha256,
        originProjectId: created.projectId, restoredProjectId: reopened.project.id,
        sourceDraftSha256: bytesHash(Buffer.from(draftContent)), restoredDraftSha256: bytesHash(Buffer.from(copyDraft.content)), firstPid, reopenedPid,
        pickerEvidence, steps, unverifiedActions: ['U16.A03', 'U16.A04', 'U16.A05', 'U16.A06',
          'U16.A07', 'U16.A08', 'U16.A09', 'U16.A10', 'U16.A11', 'U16.A12'] }
      fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
      process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, receipt: path.join(receiptDir, 'receipt.json') })}\n`)
      return
    }
    pass('writer-local-restore-copy', 'U16.A02', 'Public OpenFile/OpenDirectory preflights matched isolated paths; Writer selection restored a separate local copy without original DB changes')

    if (process.argv.includes('--diagnose-after-local-restore')) {
      currentStep = 'diagnostic-post-local-restore-archive'
      assert.equal(await page.locator('[data-shell-presentation]').getAttribute('data-shell-presentation'), 'writer')
      const generations = fs.readdirSync(path.join(profile.canonical, 'generations'))
      assert.equal(generations.length, 1)
      const stagingParent = path.join(profile.canonical, 'generations', generations[0], 'cloud-backup-staging', `diagnostic-${runId}`)
      fs.mkdirSync(stagingParent, { recursive: true })
      const targetArchivePath = path.join(stagingParent, 'backup.ainovel')
      assert.equal(fs.existsSync(targetArchivePath), false)
      const beforeSha256 = hash(originalDb)
      const reopened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
      assert.equal(reopened.success, true, reopened.error)
      const projectSession = { projectId: reopened.project.id, projectPath: created.projectPath, leaseId: reopened.project.sessionLease }
      const exported = await invoke(page, 'project:archive-export', { targetArchivePath, projectSession })
      const diagnostic = { publicIpcSuccess: exported.success, errorCode: exported.errorCode ?? null,
        error: exported.success ? null : String(exported.error).replaceAll(scratch, '<isolated-scratch>').slice(0, 300),
        targetArchiveCreated: fs.existsSync(targetArchivePath),
        targetArchiveSha256: fs.existsSync(targetArchivePath) ? hash(targetArchivePath) : null,
        beforeSha256, afterSha256: hash(originalDb), contextLeaseRefreshedAfterWriterRestore: true }
      await app.close()
      app = null
      const receipt = { outcome: 'DIAGNOSTIC', qualification: 'POST_LOCAL_RESTORE_STAGING_ARCHIVE_ONLY',
        ...source, driverSha256, helperSha256, testedSha: source.testedSha, packageDir,
        diagnostic, steps, pickerEvidence, unverifiedActions: ['U16.A07', 'U16.A08', 'U16.A09', 'U16.A10', 'U16.A11', 'U16.A12'] }
      fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
      process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, receipt: path.join(receiptDir, 'receipt.json'), diagnostic })}\n`)
      return
    }

    currentStep = 'cloud-setup'
    await panel.getByLabel('WebDAV 地址').fill(endpoint)
    await panel.getByLabel('用户名').fill(username)
    await panel.getByLabel('密码或应用密钥').fill(secret)
    await panel.getByLabel('云书标识').fill(cloudBookId)
    await panel.getByRole('button', { name: '连接并绑定' }).click()
    await panel.getByRole('status').filter({ hasText: 'WebDAV 已连接并绑定' }).waitFor({ timeout: 30_000 })
    await panel.locator('input[name="cloud-disclosure"]').check()
    await panel.getByRole('button', { name: '立即云备份' }).click()
    await panel.getByRole('status').filter({ hasText: '云备份完成：' }).waitFor({ timeout: 60_000 })
    currentStep = 'U16.A07-select-generation'
    await panel.getByRole('button', { name: '刷新云端世代' }).click()
    await panel.getByRole('status').filter({ hasText: '已读取 1 个云端世代' }).waitFor({ timeout: 30_000 })
    const completionPath = [...davFiles.keys()].find(key => key.endsWith('/completion.json'))
    assert(completionPath)
    const generationPath = completionPath.slice(0, -'completion.json'.length)
    const remoteArchive = davFiles.get(`${generationPath}archive.ainovel`)
    const manifestBytes = davFiles.get(`${generationPath}manifest.json`)
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    const completion = JSON.parse(davFiles.get(completionPath).toString('utf8'))
    assert.equal(manifest.archive.sha256, bytesHash(remoteArchive))
    assert.equal(manifest.archive.byteSize, remoteArchive.length)
    assert.equal(completion.manifest.sha256, bytesHash(manifestBytes))
    assert.equal(completion.archive.sha256, manifest.archive.sha256)
    assert.equal(completion.archive.byteSize, manifest.archive.byteSize)
    const generationId = manifest.generationId
    assert.equal(completion.generationId, generationId)
    const generationChoice = panel.locator(`input[name="restore-generation"][value="${generationId}"]`)
    await generationChoice.waitFor({ state: 'visible' })
    await generationChoice.check()
    assert.equal(await panel.locator('input[name="restore-generation"]:checked').inputValue(), generationId)

    currentStep = 'U16.A08-cloud-restore'
    const cloudParent = path.join(profile.restored, 'cloud')
    fs.mkdirSync(cloudParent, { recursive: true })
    await preflight(page, 'dialog:select-project-restore-target', [`${name}-恢复副本`],
      { title: '选择恢复副本所在文件夹', target: cloudParent },
      path.join(cloudParent, `${name}-恢复副本`))
    assert.equal(fs.existsSync(path.join(cloudParent, `${name}-恢复副本`)), false, 'cloud folder preflight created copy')
    const beforeCloudRestoreSha256 = hash(originalDb)
    const requestsBefore = davRequests.length
    await choose(panel.getByRole('button', { name: '恢复所选云端世代为副本' }), [
      { title: '选择恢复副本所在文件夹', target: cloudParent },
    ])
    await panel.getByRole('status').filter({ hasText: '云端世代已恢复为新副本' }).waitFor({ timeout: 60_000 })
    const cloudCopy = path.join(cloudParent, `${name}-恢复副本`)
    assert(fs.existsSync(path.join(cloudCopy, '.ai-novel', 'project.db')))
    assert.equal(hash(originalDb), beforeCloudRestoreSha256, 'cloud restore changed original project database')
    for (const file of ['completion.json', 'manifest.json', 'archive.ainovel']) {
      assert(davRequests.slice(requestsBefore).some(request => request.method === 'GET'
        && request.pathname === `${generationPath}${file}` && request.authorized && request.status === 200),
      `missing authorized download of ${file}`)
    }
    pass('v3-select-download-generation', 'U16.A07', 'V3 selected visible exact generation; controlled DAV served matching completion, manifest and archive')

    currentStep = 'U16.A08-reopen-copy'
    const firstPid = app.process()?.pid
    await app.close()
    app = await electron.launch({ executablePath, cwd: packageDir,
      args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
    assert.notEqual(app.process()?.pid, firstPid, 'cloud copy reopen reused the original process')
    const reopenedPage = await app.firstWindow({ timeout: 30_000 })
    await reopenedPage.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
    assert.equal((await invoke(reopenedPage, 'startup:get-state')).state, 'ready')
    const reopened = await invoke(reopenedPage, 'project:open', cloudCopy, randomUUID(), null)
    assert.equal(reopened.success, true, reopened.error)
    assert.notEqual(reopened.project.id, created.projectId, 'cloud copy reused origin project ID')
    assert.equal(folded((await invoke(reopenedPage, 'project:get-runtime-context')).activeProjectPath), folded(cloudCopy))
    const copySession = { projectId: reopened.project.id, projectPath: cloudCopy, leaseId: reopened.project.sessionLease }
    const copyDrafts = await invoke(reopenedPage, 'db:draft-list', 1, cloudCopy, copySession)
    assert.equal(copyDrafts.length, 1)
    const copyDraft = await invoke(reopenedPage, 'db:draft-get-full', copyDrafts[0].id, cloudCopy, copySession)
    assert.equal(copyDraft.content, draftContent)
    assert.equal(hash(originalDb), beforeCloudRestoreSha256, 'reopening cloud copy changed origin database')
    pass('v3-cloud-restore-copy-reopen', 'U16.A08', 'V3 native target restored distinct cloud copy; new process read exact draft without changing origin DB')
    const reopenedPid = app.process()?.pid
    await app.close()
    app = null
    assert.equal(hash(scriptPath), driverSha256)
    assert.equal(hash(helperPath), helperSha256)
    assert.deepEqual(provenance().executableSha256, source.executableSha256)
    const receipt = { outcome: 'PARTIAL', qualification: 'F05_U16_A07_A08_PACKAGED_V3_ONLY', evidenceLevel: 'packaged-electron', presentation: 'writer-v3',
      ...source, driverSha256, helperSha256, packageDir, releaseDefaultQualified: false, physicalModelRequests: 0,
      setupActionIds: ['U16.A01', 'U16.A02'], qualifiedActionIds: ['U16.A07', 'U16.A08'],
      localSha256, originalSha256, beforeCloudRestoreSha256, generationId, remoteArchiveSha256: bytesHash(remoteArchive),
      remoteManifestSha256: bytesHash(manifestBytes), sourceDraftSha256: bytesHash(Buffer.from(draftContent)),
      restoredDraftSha256: bytesHash(Buffer.from(copyDraft.content)), originProjectId: created.projectId,
      restoredProjectId: reopened.project.id, firstPid, reopenedPid,
      pickerEvidence,
      controlledDav: { requestCount: davRequests.length, downloadRequests: davRequests.filter(request => request.method === 'GET' && request.status === 200).length },
      steps, unverifiedActions: ['U16.A03', 'U16.A04', 'U16.A05', 'U16.A06', 'U16.A09', 'U16.A10', 'U16.A11', 'U16.A12'] }
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, receipt: path.join(receiptDir, 'receipt.json'),
      testedSha: source.testedSha, executionHead: source.executionHead, steps: steps.map(step => step.stepId) })}\n`)
  } catch (error) {
    const notices = panel ? await panel.locator('[role="status"], [role="alert"]').allTextContents().catch(() => []) : []
    const scratchPattern = new RegExp(scratch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu')
    const safeNotice = value => value.replace(scratchPattern, '<isolated-scratch>')
      .replace(/http:\/\/127\.0\.0\.1:\d+\/dav\//gu, '<loopback-dav>/').slice(0, 300)
    const cloudDiagnostic = {
      notices: notices.slice(-8).map(safeNotice),
      davRequests: davRequests.slice(-40).map(({ method, pathname, authorized, status }) => ({ method, pathname, authorized, status })),
      davFileKeys: [...davFiles.keys()].slice(-20),
    }
    if (app) await app.close().catch(() => {})
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify({ outcome: 'FAIL', ...source,
      driverSha256, helperSha256, failedStep: currentStep, steps, pickerEvidence, cloudDiagnostic, error: String(error) }, null, 2))
    throw error
  } finally { if (dav.listening) await new Promise(resolve => dav.close(() => resolve())) }
}

if (process.argv.includes('--help')) process.stdout.write('Use --reuse-package=<prior built receipt>; runs isolated packaged Writer local/cloud recovery.\n')
else main().catch(error => { console.error(error); process.exitCode = 1 })
