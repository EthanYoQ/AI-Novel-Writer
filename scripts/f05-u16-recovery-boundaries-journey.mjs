/* global process, Buffer */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { verifyWindowsPackage, verifyPackagedBetterSqliteLoad } from './verify-win-package.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = fileURLToPath(import.meta.url)
const helperPath = path.join(repository, 'scripts', 'f05-u16-native-picker.ps1')
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const fixedPackage = option('package-dir')
const priorPath = option('reuse-package')
if (process.argv.includes('--help')) {
  process.stdout.write('Use --package-dir=<win-unpacked> --build-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash> for isolated packaged V3 U16 recovery boundaries.\n')
  process.exit(0)
}
assert(fixedPackage || priorPath && fs.existsSync(priorPath), 'pass fixed package and hashes or --reuse-package=<verified build receipt>')
assert(!(fixedPackage && priorPath), 'choose one package mode')
const prior = fixedPackage ? null : JSON.parse(fs.readFileSync(priorPath, 'utf8'))
if (prior) {
  assert(['PASS', 'PARTIAL'].includes(prior.outcome) && prior.build?.command === 'pnpm run build:win-dir')
  assert(prior.build?.buildSha && prior.testedSha === prior.build.buildSha && prior.artifact?.asarSha256)
}
const packageDir = path.resolve(fixedPackage ?? path.join(repository, 'release', JSON.parse(fs.readFileSync(path.join(repository, 'package.json'))).version, 'win-unpacked'))
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const runId = randomUUID()
const receiptDir = path.join(repository, '.runtime', '.cache', 'f05-u16-recovery-boundaries', runId)
const scratch = path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'an', `b-${runId.slice(0, 8)}`)
const profiles = Object.fromEntries(['a', 'b'].map(name => [name, Object.fromEntries(
  ['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects', 'restored']
    .map(key => [key, path.join(scratch, name, key)]))]))
const secret = randomUUID()
const username = 'local-test'
const book = `u16b-${runId.slice(0, 8)}`
const requests = []
const files = new Map()
const collections = new Set(['/dav/'])
const steps = []
const pickerEvidence = []
let currentStep = 'setup'
const runningApps = new Set()
let currentPanel
let currentPage
const pass = (actionId, assertion, detail = {}) => steps.push({ stepId: actionId, actionId, outcome: 'PASS', assertion, ...detail })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const folded = value => path.win32.normalize(value).toLowerCase()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function provenance() {
  if (fixedPackage) {
    const buildSha = option('build-sha')
    const expectedExe = option('exe-sha256')
    const expectedAsar = option('asar-sha256')
    assert(/^[a-f0-9]{7,40}$/.test(buildSha ?? '') && /^[a-f0-9]{64}$/.test(expectedExe ?? '')
      && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''), 'fixed package requires build SHA and both hashes')
    const testedSha = git('rev-parse', '--verify', `${buildSha}^{commit}`)
    const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml',
      'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
    assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', ...productInputs), '',
      'product input changed since fixed package build')
    assert.equal(git('diff', '--name-only', '--', ...productInputs), '', 'product input has uncommitted changes')
    const dirtyProductPaths = git('status', '--porcelain', '--', ...productInputs).split('\n').filter(Boolean)
    assert(dirtyProductPaths.every(line => /^\?\? src\/components\/.+\/__tests__\/__screenshots__\/$/.test(line)),
      'fixed package has untracked product inputs')
    assert.equal(sha(executablePath), expectedExe)
    assert.equal(sha(asarPath), expectedAsar)
    return { testedSha, executionHead: git('rev-parse', 'HEAD'), dirtyProductPaths,
      changedPaths: git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean),
      sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean),
      executableSha256: expectedExe, asarSha256: expectedAsar, driverSha256: sha(scriptPath), helperSha256: sha(helperPath),
      reuseReason: 'Fixed package hashes match and product inputs are unchanged.' }
  }
  const testedSha = prior.build.buildSha
  const executionHead = git('rev-parse', 'HEAD')
  const changedPaths = git('diff', '--name-only', `${testedSha}..${executionHead}`).split('\n').filter(Boolean)
  assert(changedPaths.every(file => /^scripts\/f05-[a-z0-9-]+(?:-journey\.mjs|-picker\.ps1)$/.test(file)),
    'tracked product inputs changed since package build')
  assert.equal(sha(executablePath), prior.artifact.executableSha256)
  assert.equal(sha(asarPath), prior.artifact.asarSha256)
  const dirtyProduct = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build', 'package.json',
    'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5').split('\n').filter(Boolean)
  assert(dirtyProduct.every(line => /^\?\? src\/components\/(?:editor|layout\/v2|panels)\/__tests__\/__screenshots__\/$/.test(line)))
  return { testedSha, executionHead, changedPaths, sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean),
    dirtyProduct, buildReceipt: { path: priorPath, sha256: sha(priorPath) }, executableSha256: sha(executablePath),
    asarSha256: sha(asarPath), driverSha256: sha(scriptPath), helperSha256: sha(helperPath),
    reuseReason: 'Tracked differences are F05 drivers only; product input is clean and packaged bytes match the build receipt.' }
}

const dav = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const method = request.method
  const authorized = request.headers.authorization === `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`
  const done = status => { requests.push({ method, pathname, authorized, status }); response.writeHead(status); response.end() }
  if (!authorized) return done(401)
  if (method === 'MKCOL') { const existed = collections.has(pathname); collections.add(pathname); return done(existed ? 405 : 201) }
  if (method === 'PUT') {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const existed = files.has(pathname)
    if (!existed) files.set(pathname, Buffer.concat(chunks))
    return done(existed ? 412 : 201)
  }
  if (method === 'GET' || method === 'HEAD') {
    const bytes = files.get(pathname)
    requests.push({ method, pathname, authorized, status: bytes ? 200 : 404 })
    response.writeHead(bytes ? 200 : 404, bytes ? { 'content-length': bytes.length } : undefined)
    response.end(method === 'GET' ? bytes : undefined)
    return
  }
  if (method === 'PROPFIND') {
    const children = request.headers.depth === '1' ? [...collections].filter(candidate =>
      candidate.startsWith(pathname) && candidate !== pathname && !candidate.slice(pathname.length).replace(/\/$/, '').includes('/')) : []
    const body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[pathname, ...children].map(href =>
      `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response>`).join('')}</d:multistatus>`
    requests.push({ method, pathname, authorized, status: 207 })
    response.writeHead(207, { 'content-type': 'application/xml' }).end(body)
    return
  }
  done(405)
})

function pick(title, target) {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-Target', target, '-ExpectedExe', executablePath, '-DialogTitle', title],
  { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, `native picker ${title}: ${result.stderr || result.error || result.stdout}`)
  const evidence = JSON.parse(result.stdout.trim())
  assert.equal(evidence.typedExact, true)
  assert.equal(evidence.submitted, true)
  return evidence
}

function cancelRestorePicker() {
  const script = String.raw`param([Parameter(Mandatory=$true)][string]$ExpectedExe)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class DialogClose {
  public delegate bool EnumProc(IntPtr h, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr extra);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder b, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder b, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  public static string Class(IntPtr h){ var b=new StringBuilder(256); GetClassName(h,b,b.Capacity); return b.ToString(); }
  public static string Text(IntPtr h){ var b=new StringBuilder(256); GetWindowText(h,b,b.Capacity); return b.ToString(); }
}
'@
$found = [System.Collections.Generic.List[object]]::new()
$cb = [DialogClose+EnumProc]{ param($h,$x)
  if ([DialogClose]::Class($h) -eq '#32770' -and [DialogClose]::Text($h) -eq '选择恢复副本所在文件夹') {
    [uint32]$dialogPid = 0
    [DialogClose]::GetWindowThreadProcessId($h,[ref]$dialogPid) | Out-Null
    $proc = Get-Process -Id $dialogPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.Path -eq $ExpectedExe) { $found.Add([pscustomobject]@{h=$h;pid=$dialogPid}) }
  }
  return $true
}
for ($i=0; $i -lt 100 -and $found.Count -eq 0; $i++) { [DialogClose]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null; Start-Sleep -Milliseconds 100 }
if ($found.Count -ne 1) { throw "Expected one isolated restore dialog; found $($found.Count)" }
$h = $found[0].h
if (-not [DialogClose]::PostMessage($h,0x10,[IntPtr]::Zero,[IntPtr]::Zero)) { throw 'WM_CLOSE failed' }
for ($i=0; $i -lt 50 -and [DialogClose]::IsWindow($h); $i++) { Start-Sleep -Milliseconds 100 }
if ([DialogClose]::IsWindow($h)) { throw 'Restore dialog stayed open' }
@{ title='选择恢复副本所在文件夹'; pid=$found[0].pid; closed=$true } | ConvertTo-Json -Compress`
  const scriptFile = path.join(receiptDir, 'cancel-restore-picker.ps1')
  fs.writeFileSync(scriptFile, script)
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile,
    '-ExpectedExe', executablePath], { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  assert.equal(result.status, 0, `cancel restore picker: ${result.stderr || result.error || result.stdout}`)
  return { ...JSON.parse(result.stdout.trim()), helperSha256: sha(scriptFile) }
}

async function preflight(page, parent, copyName) {
  const evidence = { kind: 'public-ipc-preflight', title: '选择恢复副本所在文件夹', target: parent }
  pickerEvidence.push(evidence)
  const pending = invoke(page, 'dialog:select-project-restore-target', copyName)
  await sleep(100)
  evidence.helper = pick(evidence.title, parent)
  const returned = await Promise.race([pending, sleep(15_000).then(() => { throw new Error('restore target IPC timeout') })])
  evidence.returned = returned
  assert.equal(folded(returned), folded(path.join(parent, copyName)))
  assert.equal(fs.existsSync(returned), false, 'picker preflight created a copy')
}

async function launch(profile) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy, AI_NOVEL_VELA_HOME: profile.legacy,
    HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const app = await electron.launch({ executablePath, cwd: packageDir,
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
  await page.locator('.writer-shell[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
  runningApps.add(app)
  return { app, page }
}

async function close(app) { await app.close(); runningApps.delete(app) }

async function openPanel(page, name) {
  await page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
  await page.locator('.writer-left-rail button[title="欢迎页"]').click()
  const shelf = page.locator('.writer-shelf')
  await shelf.waitFor({ state: 'visible' })
  await shelf.getByRole('button', { name: `打开《${name}》` }).click()
  await page.locator('.writer-left-rail button[title="设置"]').click()
  await page.getByRole('complementary').getByRole('button', { name: '项目备份', exact: true }).click()
  await page.getByRole('heading', { name: '项目备份', exact: true }).waitFor()
  const panel = page.getByTestId('project-backup-panel')
  await panel.getByText('本地便携存档').waitFor()
  currentPanel = panel
  currentPage = page
  return panel
}

async function bind(panel, endpoint, parents = []) {
  await panel.getByLabel('WebDAV 地址').fill(endpoint)
  await panel.getByLabel('用户名').fill(username)
  await panel.getByLabel('密码或应用密钥').fill(secret)
  await panel.getByLabel('云书标识').fill(book)
  await panel.getByRole('button', { name: '连接并绑定' }).click()
  await panel.getByRole('status').filter({ hasText: 'WebDAV 已连接并绑定' }).waitFor({ timeout: 30_000 })
  if (parents.length) {
    await panel.getByRole('button', { name: '刷新云端世代' }).click()
    await panel.getByRole('status').filter({ hasText: `已读取 ${filesWithCompletion().length} 个云端世代` }).waitFor({ timeout: 30_000 })
    for (const parent of parents) await panel.locator(`input[name="restore-generation"][value="${parent}"]`)
      .locator('xpath=../..').locator('input[type="checkbox"]').check()
    await panel.getByRole('button', { name: '确认父世代并重新绑定' }).click()
    await panel.getByRole('status').filter({ hasText: '父世代已重新绑定' }).waitFor({ timeout: 30_000 })
  }
}

const filesWithCompletion = () => [...files.keys()].filter(key => key.endsWith('/completion.json'))
function bindingFor(profile, projectId) {
  const generations = fs.readdirSync(path.join(profile.canonical, 'generations'))
  assert.equal(generations.length, 1)
  const store = JSON.parse(fs.readFileSync(path.join(profile.canonical, 'generations', generations[0], 'cloud-backup-bindings.json')))
  return store.bindings.find(binding => binding.localProjectId === projectId)
}
function seedFrozenOldRun(databasePath, projectId) {
  const script = String.raw`const Database=require('./resources/app.asar/node_modules/better-sqlite3');
const db=new Database(process.argv[1]); const id=process.argv[2];
try {
  const action={projectId:id,epoch:'source-epoch',operation:'chapter-draft',uiActionNonce:'old-action',
    frozenInputHash:'1'.repeat(64),rootActionId:'root-old',status:'active'};
  db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
    .run('root-old','root-key-old',JSON.stringify(action),JSON.stringify({maxPhysicalRequests:2,maxTokenLiability:1000,maxOutputPerRequest:500,maxActiveElapsedMs:1000}));
  db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run('run-old','root-old',
    JSON.stringify({projectId:id,epoch:'source-epoch',fingerprint:{},contextSnapshotId:'context-old',sourceManifest:{},sourceRefs:[]}),
    'running',1,'open-key-old');
  const attempt={attemptId:'attempt-unknown',reservationId:'reservation-old',rootActionId:'root-old',
    status:'unknown',reservedTokens:500,requestedOutputTokens:400};
  db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run('attempt-unknown','reservation-old',
    'run-old','root-old',JSON.stringify(attempt),JSON.stringify({digest:'2'.repeat(64)}),'invocation-old');
  process.stdout.write(JSON.stringify({oldRun:'run-old',oldAttempt:'attempt-unknown'}));
} finally { db.close() }`
  const result = spawnSync(executablePath, ['-e', script, databasePath, projectId], { cwd: packageDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  assert.equal(result.status, 0, `old run fixture seed failed: ${result.stderr || result.error || result.stdout}`)
  return JSON.parse(result.stdout.trim())
}
function finalizedChapterBody(databasePath) {
  const script = String.raw`const Database=require('./resources/app.asar/node_modules/better-sqlite3');
const db=new Database(process.argv[1],{readonly:true});
try { const row=db.prepare("SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=1 AND d.status='finalized' ORDER BY d.version DESC LIMIT 1").get();
  process.stdout.write(JSON.stringify(row?.body ?? null)); } finally { db.close() }`
  const result = spawnSync(executablePath, ['-e', script, databasePath], { cwd: packageDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  assert.equal(result.status, 0, `finalized chapter read failed: ${result.stderr || result.error || result.stdout}`)
  return JSON.parse(result.stdout.trim())
}
function serializedDbSha(databasePath) {
  const script = String.raw`const Database=require('./resources/app.asar/node_modules/better-sqlite3');
const {createHash}=require('node:crypto'); const db=new Database(process.argv[1],{readonly:true});
try { process.stdout.write(createHash('sha256').update(db.serialize()).digest('hex')); } finally { db.close() }`
  const result = spawnSync(executablePath, ['-e', script, databasePath], { cwd: packageDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  assert.equal(result.status, 0, `serialized database snapshot failed: ${result.stderr || result.error || result.stdout}`)
  return result.stdout.trim()
}
function assertCurrentSchema(databasePath) {
  const script = String.raw`const Database=require('./resources/app.asar/node_modules/better-sqlite3');
const db=new Database(process.argv[1],{readonly:true});
try { process.stdout.write(JSON.stringify({version:db.pragma('user_version',{simple:true}),
  mergeFields:db.pragma('table_info(review_cycle_merges)').map(field=>field.name)})); } finally { db.close() }`
  const result = spawnSync(executablePath, ['-e', script, databasePath], { cwd: packageDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  assert.equal(result.status, 0, `schema read failed: ${result.stderr || result.error || result.stdout}`)
  const schema = JSON.parse(result.stdout.trim())
  assert.equal(schema.version, 7)
  assert.deepEqual(schema.mergeFields, ['cycle_id', 'body'])
}
async function upload(panel) {
  await panel.locator('input[name="cloud-disclosure"]').check()
  const before = filesWithCompletion()
  await panel.getByRole('button', { name: '立即云备份' }).click()
  await panel.getByRole('status').filter({ hasText: '云备份完成：' }).waitFor({ timeout: 60_000 })
  const added = filesWithCompletion().filter(key => !before.includes(key))
  assert.equal(added.length, 1)
  return JSON.parse(files.get(added[0].replace('completion.json', 'manifest.json')).toString('utf8'))
}

async function restoreGeneration(page, panel, generationId, parent, copyName) {
  await panel.getByRole('button', { name: '刷新云端世代' }).click()
  await panel.locator(`input[name="restore-generation"][value="${generationId}"]`).check()
  assert.equal(await panel.locator('input[name="restore-generation"]:checked').inputValue(), generationId)
  await preflight(page, parent, copyName)
  await panel.getByRole('button', { name: '恢复所选云端世代为副本' }).click()
  const evidence = { kind: 'writer-control-picker', title: '选择恢复副本所在文件夹', target: parent }
  pickerEvidence.push(evidence)
  evidence.helper = pick(evidence.title, parent)
  await panel.getByRole('status').filter({ hasText: '云端世代已恢复为新副本' }).waitFor({ timeout: 60_000 })
  const copy = path.join(parent, copyName)
  assert(fs.existsSync(path.join(copy, '.ai-novel', 'project.db')))
  return copy
}

async function main() {
  const plannedProjectRoots = [path.join(profiles.a.projects, '分叉原稿'),
    path.join(profiles.b.projects, '恢复入口'), path.join(profiles.b.restored, '恢复入口-恢复副本'),
    path.join(profiles.a.restored, '分叉原稿-恢复副本'),
    path.join(profiles.a.restored, 'x', '分叉原稿-恢复副本')]
  assert(plannedProjectRoots.every(root => root.length <= 85),
    `isolated Windows project root exceeds 85 characters: ${plannedProjectRoots.map(root => root.length).join(',')}`)
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const profile of Object.values(profiles)) for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u16-recovery-boundaries',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
    retainReason: 'Review isolated packaged Writer U16 recovery evidence',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch}' -Recurse -Force` }, null, 2))
  const source = provenance()
  let outcome = 'FAIL'
  let errorText = null
  let detail = {}
  let uiDiagnostic = null
  try {
    currentStep = 'packaged-native-load'
    assert(verifyWindowsPackage(packageDir).betterSqliteBinding)
    assert.equal(verifyPackagedBetterSqliteLoad(packageDir), 'PACKAGED_BETTER_SQLITE3_LOAD_OK')
    await new Promise((resolve, reject) => { dav.once('error', reject); dav.listen(0, '127.0.0.1', resolve) })
    const endpoint = `http://127.0.0.1:${dav.address().port}/dav/`
    currentStep = 'source-generation'
    const a = await launch(profiles.a)
    const name = '分叉原稿'
    const created = await invoke(a.page, 'project:create', { path: profiles.a.projects, name,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    const opened = await invoke(a.page, 'project:open', created.projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    const context = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
    const draft = await invoke(a.page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
      content: `分叉起点 ${runId}`, wordCount: 4 }, created.projectPath, context)
    assert.equal(draft.success, true, draft.error)
    await a.page.reload()
    await a.page.locator('[data-shell-presentation="writer"]').waitFor()
    const panelA = await openPanel(a.page, name)
    await bind(panelA, endpoint)
    const root = await upload(panelA)
    assert.deepEqual(root.parentGenerationIds, [])
    const originalDb = path.join(created.projectPath, '.ai-novel', 'project.db')
    assertCurrentSchema(originalDb)
    const originalSha = sha(originalDb)
    await close(a.app)

    currentStep = 'U16.A10-origin-readonly-restart'
    const b = await launch(profiles.b)
    const bootstrap = await invoke(b.page, 'project:create', { path: profiles.b.projects, name: '恢复入口',
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(bootstrap.success, true, bootstrap.error)
    await b.page.reload()
    await b.page.locator('.writer-shell[data-shell-presentation="writer"]').waitFor()
    const panelB = await openPanel(b.page, '恢复入口')
    await bind(panelB, endpoint)
    const copy = await restoreGeneration(b.page, panelB, root.generationId, profiles.b.restored, '恢复入口-恢复副本')
    assertCurrentSchema(path.join(copy, '.ai-novel', 'project.db'))
    assert.equal(sha(originalDb), originalSha)
    const copyOpen = await invoke(b.page, 'project:open', copy, randomUUID(), null)
    assert.equal(copyOpen.success, true, copyOpen.error)
    await close(b.app)
    const restarted = await launch(profiles.b)
    let copyPanel = await openPanel(restarted.page, name)
    await copyPanel.getByText('来源只读绑定').waitFor()
    assert.equal(bindingFor(profiles.b, copyOpen.project.id).mode, 'origin-readonly')
    assert.equal(await copyPanel.getByRole('button', { name: '立即云备份' }).isDisabled(), true)
    const remoteCount = filesWithCompletion().length
    await sleep(500)
    assert.equal(filesWithCompletion().length, remoteCount, 'restart uploaded implicitly')
    pass('U16.A10', 'Restored copy kept origin-readonly after process restart and could not upload implicitly',
      { remoteCount, originalSha256: originalSha, copyDbSha256: sha(path.join(copy, '.ai-novel', 'project.db')) })

    currentStep = 'U16.A09-sibling-branches'
    const copyReopened = await invoke(restarted.page, 'project:open', copy, randomUUID(), null)
    assert.equal(copyReopened.success, true, copyReopened.error)
    const copySession = { projectId: copyReopened.project.id, projectPath: copy,
      leaseId: copyReopened.project.sessionLease }
    const currentBody = '雨城北门铜钥匙线索浮现'
    const finalized = await invoke(restarted.page, 'db:draft-import-finalized-batch', {
      operationId: `u16-finalized-${runId}`, chapters: [{ chapterNumber: 1, title: '铜钥匙',
        content: currentBody, wordCount: [...currentBody].length }],
    }, copy, copySession)
    assert.equal(finalized.success, true, finalized.error)
    const oldRun = seedFrozenOldRun(path.join(copy, '.ai-novel', 'project.db'), copyOpen.project.id)
    await restarted.page.reload()
    await restarted.page.locator('.writer-shell[data-shell-presentation="writer"]').waitFor()
    copyPanel = await openPanel(restarted.page, name)
    await bind(copyPanel, endpoint, [root.generationId])
    const childB = await upload(copyPanel)
    assert.deepEqual(childB.parentGenerationIds, [root.generationId])
    assert.equal(finalizedChapterBody(path.join(copy, '.ai-novel', 'project.db')), currentBody)
    await close(restarted.app)
    const resumedA = await launch(profiles.a)
    const panelA2 = await openPanel(resumedA.page, name)
    await panelA2.getByRole('button', { name: '刷新云端世代' }).click()
    await panelA2.locator(`input[name="restore-generation"][value="${root.generationId}"]`)
      .locator('xpath=../..').locator('input[type="checkbox"]').check()
    await panelA2.getByRole('button', { name: '确认父世代并重新绑定' }).click()
    const childA = await upload(panelA2)
    assert.deepEqual(childA.parentGenerationIds, [root.generationId])
    assert.notEqual(childA.generationId, childB.generationId)
    assert.notEqual(finalizedChapterBody(originalDb), currentBody, 'A and B branches have indistinguishable finalized content')
    const branchHashes = Object.fromEntries([...files].filter(([key]) =>
      [childA.generationId, childB.generationId].some(id => key.includes(id))).map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]))
    await panelA2.getByRole('button', { name: '刷新云端世代' }).click()
    for (const id of [childA.generationId, childB.generationId]) {
      await panelA2.locator(`input[name="restore-generation"][value="${id}"]`).waitFor({ state: 'visible' })
    }
    await panelA2.getByText(`分支同级：${childB.generationId}`).waitFor()
    const listed = await invoke(resumedA.page, 'cloud-backup:list', {
      localEndpointAccountId: bindingFor(profiles.a, created.projectId).localEndpointAccountId, cloudBookId: book })
    assert.equal(listed.success, true, listed.errorCode)
    for (const [id, sibling] of [[childA.generationId, childB.generationId], [childB.generationId, childA.generationId]]) {
      const generation = listed.generations.find(item => item.generationId === id)
      assert(generation?.hasSibling)
      assert.deepEqual(generation.siblingGenerationIds, [sibling])
      assert(filesWithCompletion().some(key => key.includes(id)), 'sibling completion overwritten')
    }
    await panelA2.locator(`input[name="restore-generation"][value="${childB.generationId}"]`).check()
    assert.equal(await panelA2.locator('input[name="restore-generation"]:checked').inputValue(), childB.generationId)
    const originalSerializedSha = serializedDbSha(originalDb)
    const selectedBranchCopy = await restoreGeneration(resumedA.page, panelA2, childB.generationId, profiles.a.restored, `${name}-恢复副本`)
    assertCurrentSchema(path.join(selectedBranchCopy, '.ai-novel', 'project.db'))
    assert.equal(serializedDbSha(originalDb), originalSerializedSha, 'branch restore changed original database snapshot')
    assert.equal(finalizedChapterBody(path.join(selectedBranchCopy, '.ai-novel', 'project.db')), currentBody,
      'selected B branch did not restore its unique finalized chapter')
    assert.deepEqual(Object.fromEntries(Object.keys(branchHashes).map(key => [key,
      createHash('sha256').update(files.get(key)).digest('hex')])), branchHashes, 'branch bytes changed during selection or restore')
    const freezeFile = path.join(selectedBranchCopy, '.ai-novel', 'portable-runtime-freeze.json')
    const freeze = JSON.parse(fs.readFileSync(freezeFile, 'utf8'))
    assert(freeze.records.some(record => record.table === 'generation_runs' && record.recordId === oldRun.oldRun && record.nonReplayable))
    assert(freeze.records.some(record => record.table === 'generation_attempts' && record.recordId === oldRun.oldAttempt && record.nonReplayable))
    pass('U16.A09', 'V3 showed both same-parent branches, selected and restored B as a separate copy, and retained both immutable completion objects',
      { root: root.generationId, childA: childA.generationId, childB: childB.generationId,
        originalSerializedDbSha256: originalSerializedSha,
        selectedBranchCopyDbSha256: sha(path.join(selectedBranchCopy, '.ai-novel', 'project.db')) })
    currentStep = 'U16.A11-cancel-restore'
    const cancelledParent = path.join(profiles.a.restored, 'cancelled')
    fs.mkdirSync(cancelledParent, { recursive: true })
    const beforeCancelRequests = requests.length
    const beforeCancelSerializedSha = serializedDbSha(originalDb)
    await panelA2.getByRole('button', { name: '恢复所选云端世代为副本' }).click()
    const cancelled = cancelRestorePicker()
    pickerEvidence.push({ kind: 'writer-control-picker-cancel', ...cancelled })
    await panelA2.getByRole('button', { name: '恢复所选云端世代为副本' }).waitFor({ state: 'visible' })
    assert.equal(fs.existsSync(path.join(cancelledParent, `${name}-恢复副本`)), false)
    assert.equal(serializedDbSha(originalDb), beforeCancelSerializedSha, 'cancelled restore changed original database snapshot')
    assert.equal(requests.slice(beforeCancelRequests).some(request => request.method === 'GET' && request.pathname.endsWith('/archive.ainovel')), false)
    currentStep = 'U16.A11-corrupt-remote-restore'
    const archiveKey = filesWithCompletion().find(key => key.includes(childB.generationId)).replace('completion.json', 'archive.ainovel')
    const intactArchive = files.get(archiveKey)
    files.set(archiveKey, Buffer.from('intentionally corrupt isolated DAV archive'))
    const beforeErrorRequests = requests.length
    const failedParent = path.join(profiles.a.restored, 'x')
    fs.mkdirSync(failedParent, { recursive: true })
    await preflight(resumedA.page, failedParent, `${name}-恢复副本`)
    const beforeError = { originalSerialized: serializedDbSha(originalDb), branch: sha(path.join(selectedBranchCopy, '.ai-novel', 'project.db')) }
    await panelA2.getByRole('button', { name: '恢复所选云端世代为副本' }).click()
    const failedPick = { kind: 'writer-control-picker-error', title: '选择恢复副本所在文件夹', target: failedParent }
    pickerEvidence.push(failedPick)
    failedPick.helper = pick(failedPick.title, failedParent)
    await panelA2.getByRole('alert').filter({ hasText: 'CLOUD_BACKUP_REMOTE_INVALID' }).waitFor({ timeout: 60_000 })
    assert(requests.slice(beforeErrorRequests).some(request => ['HEAD', 'GET'].includes(request.method)
      && request.pathname === archiveKey && request.authorized && request.status === 200),
    'corrupt restore never checked the selected archive')
    assert.equal(fs.existsSync(path.join(failedParent, `${name}-恢复副本`)), false)
    assert.equal(serializedDbSha(originalDb), beforeError.originalSerialized, 'failed restore changed original database snapshot')
    assert.equal(sha(path.join(selectedBranchCopy, '.ai-novel', 'project.db')), beforeError.branch)
    assert.equal(path.resolve((await invoke(resumedA.page, 'project:get-runtime-context')).activeProjectPath), path.resolve(created.projectPath))
    files.set(archiveKey, intactArchive)
    pass('U16.A11', 'V3 native restore cancellation caused no download/write; altered remote archive was rejected without changing source, prior copy or active project')
    currentStep = 'U16.A12-continuity-and-continue-writing'
    const selectedOpen = await invoke(resumedA.page, 'project:open', selectedBranchCopy, randomUUID(), null)
    assert.equal(selectedOpen.success, true, selectedOpen.error)
    assert.notEqual(selectedOpen.project.id, created.projectId)
    const selectedSession = { projectId: selectedOpen.project.id, projectPath: selectedBranchCopy,
      leaseId: selectedOpen.project.sessionLease }
    const authority = await invoke(resumedA.page, 'db:draft-authority-sequence', selectedBranchCopy, selectedSession)
    assert.equal(authority.status, 'continuous')
    assert.equal(authority.lastChapterNumber, 1)
    const currentFinalized = await invoke(resumedA.page, 'db:draft-get-finalized', 1, selectedBranchCopy, selectedSession)
    assert(currentFinalized?.id)
    const currentFull = await invoke(resumedA.page, 'db:draft-get-full', currentFinalized.id, selectedBranchCopy, selectedSession)
    assert.equal(currentFull.content, currentBody)
    const initialBody = '新副本继续写作'
    const draft2 = await invoke(resumedA.page, 'db:draft-create', { chapterNumber: 2, version: 1, source: 'write',
      content: initialBody, wordCount: 7 }, selectedBranchCopy, selectedSession)
    assert.equal(draft2.success, true, draft2.error)
    await resumedA.page.reload()
    const writerShell = resumedA.page.locator('.writer-shell[data-shell-presentation="writer"][data-shell-variant="v3"]')
    await writerShell.waitFor({ state: 'visible' })
    assert.equal(await writerShell.getAttribute('data-shell-presentation'), 'writer')
    const notice = resumedA.page.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await notice.isVisible()) {
      assert.equal(await notice.count(), 1, 'unexpected overlapping startup notices')
      const acknowledge = notice.getByRole('button', { name: '知道了', exact: true })
      await acknowledge.waitFor({ state: 'visible' })
      await acknowledge.click()
      await notice.waitFor({ state: 'hidden' })
    }
    await resumedA.page.locator('.writer-left-rail button[title="欢迎页"]').click()
    const shelf = resumedA.page.locator('.writer-shelf')
    await shelf.waitFor()
    await shelf.getByRole('button', { name: `打开《${name}》` }).first().click()
    assert.equal(path.resolve((await invoke(resumedA.page, 'project:get-runtime-context')).activeProjectPath), path.resolve(selectedBranchCopy),
      'V3 shelf did not enter the selected restored branch')
    await resumedA.page.locator('.writer-project-tree [title*="点击打开 — 第2章 v1"]').click()
    const editor = resumedA.page.locator('.cm-content[contenteditable="true"]')
    await editor.waitFor({ state: 'visible' })
    const visibleBody = await editor.evaluate(element => [...element.querySelectorAll('.cm-line')].map(line => {
      const copy = line.cloneNode(true)
      copy.querySelector('.cm-lp-paperhead')?.remove()
      return copy.textContent
    }).join('\n'))
    assert.equal(visibleBody, initialBody, 'V3 editor did not display the draft body before continuation')
    const continued = ` 续写-${runId.slice(0, 8)}`
    await editor.click()
    await resumedA.page.keyboard.press('Control+End')
    await resumedA.page.keyboard.type(continued)
    await resumedA.page.locator('button[title="保存（⌘S）"]').click()
    await resumedA.page.getByText('已保存', { exact: true }).first().waitFor({ state: 'visible' })
    const savedOpen = await invoke(resumedA.page, 'project:open', selectedBranchCopy, randomUUID(), null)
    assert.equal(savedOpen.success, true, savedOpen.error)
    const savedSession = { projectId: savedOpen.project.id, projectPath: selectedBranchCopy,
      leaseId: savedOpen.project.sessionLease }
    const fullAfter = await invoke(resumedA.page, 'db:draft-get-full', draft2.id, selectedBranchCopy, savedSession)
    assert.equal(fullAfter.content, initialBody + continued, 'saved draft lost or changed the initial body')
    const freezeAfter = JSON.parse(fs.readFileSync(freezeFile, 'utf8'))
    assert.deepEqual(freezeAfter, freeze, 'continuing in restored copy changed old runtime freeze')
    assert.equal(serializedDbSha(originalDb), originalSerializedSha, 'continuing in restored copy changed original database snapshot')
    pass('U16.A12', 'Selected restored branch retained current finalized chapter and non-replayable old run/unknown attempt; V3 editor saved a new chapter in the copy while original and freeze stayed unchanged',
      { restoredProjectId: selectedOpen.project.id, finalizedDraftId: currentFinalized.id,
        continuedDraftId: draft2.id, oldRun: oldRun.oldRun, oldAttempt: oldRun.oldAttempt })
    detail = { root: root.generationId, childA: childA.generationId, childB: childB.generationId,
      originalDbSha256: originalSha, originalSerializedDbSha256: originalSerializedSha,
      copyDbSha256: sha(path.join(copy, '.ai-novel', 'project.db')) }
    await close(resumedA.app)
    outcome = 'PARTIAL'
  } catch (error) {
    errorText = String(error)
    if (currentPanel) {
      const raw = await currentPanel.locator('[role="status"], [role="alert"]').allTextContents().catch(() => [])
      const safe = value => value.replaceAll(scratch, '<isolated-scratch>')
        .replace(/http:\/\/127\.0\.0\.1:\d+\/dav\//gu, '<loopback-dav>/').slice(0, 240)
      uiDiagnostic = { panelCount: await currentPanel.count().catch(() => -1),
        panelVisible: await currentPanel.isVisible().catch(() => false),
        shell: await currentPage.locator('[data-shell-presentation]').getAttribute('data-shell-presentation').catch(() => null),
        notices: raw.slice(-8).map(safe) }
    }
    for (const app of runningApps) await close(app).catch(() => {})
  } finally {
    if (dav.listening) await new Promise(resolve => dav.close(() => resolve()))
    const receipt = { outcome, qualification: 'F05_U16_RECOVERY_BOUNDARIES_A09_A10_A11_A12',
      evidenceLevel: 'packaged-electron+controlled-service', presentation: 'writer-v3', releaseDefaultQualified: false,
      ...source, packageDir, failedStep: errorText ? currentStep : null, error: errorText, steps, detail, uiDiagnostic,
      pickerEvidence, controlledDav: { requests, fileKeys: [...files.keys()] },
      unverifiedActions: steps.length === 4 ? [] : ['U16.A09', 'U16.A10', 'U16.A11', 'U16.A12'].filter(actionId => !steps.some(step => step.actionId === actionId && step.outcome === 'PASS')) }
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome, receipt: path.join(receiptDir, 'receipt.json'),
      testedSha: source.testedSha, steps: steps.map(step => step.stepId), failedStep: receipt.failedStep })}\n`)
  }
  if (errorText) throw new Error(errorText)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
