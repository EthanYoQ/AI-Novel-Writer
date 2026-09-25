/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = arg('package-dir')
const buildTree = arg('build-tree')
const testedSha = arg('tested-sha')
const expectedExe = arg('exe-sha256')
const expectedAsar = arg('asar-sha256')
const sources = [
  { version: 'v1.0.0', path: arg('legacy-v100'), injectedInventory: true },
  { version: 'v1.1.0', path: arg('legacy-v110'), injectedInventory: false },
]
assert(packageDir && buildTree && /^[a-f0-9]{40}$/.test(testedSha ?? '')
  && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? '')
  && sources.every(source => source.path), 'Specify clean build tree, fixed package SHA/hashes and both historical fixture paths')
const buildGit = (...args) => execFileSync('git', args, { cwd: buildTree, encoding: 'utf8' }).trim()
assert.equal(buildGit('rev-parse', 'HEAD'), testedSha, 'Build tree HEAD differs from tested SHA')
assert.equal(buildGit('status', '--porcelain'), '', 'Build tree must be clean')
assert.equal(path.resolve(packageDir), path.join(path.resolve(buildTree), 'release', '1.1.0', 'win-unpacked'))

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const exe = path.join(packageDir, 'AI小说作家.exe')
const asar = path.join(packageDir, 'resources', 'app.asar')
const runId = randomUUID()
const scratch = path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'AI-Novel', `a11-${runId.slice(0, 8)}`)
const receiptPath = path.join(repository, '.runtime', '.cache', 'f05-a11-offline-import', runId, 'receipt.json')
const receipt = { outcome: 'FAIL', sliceOutcome: 'FAIL', qualification: 'A11_OFFLINE_LEGACY_COPY_WIN_V3',
  testedSha, buildTree: path.resolve(buildTree),
  executionHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  driverSha256: sha256(fileURLToPath(import.meta.url)), packageHashes: { exe: sha256(exe), asar: sha256(asar) },
  historicalSources: sources.map(source => ({ version: source.version, path: source.path,
    injectedInventoryRemovedFromScratchCopy: source.injectedInventory })), steps: [], receiptPath }
assert.deepEqual(receipt.packageHashes, { exe: expectedExe, asar: expectedAsar })
fs.mkdirSync(scratch, { recursive: true })
fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/thread-6/a11',
  sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
  cleanupCommand: `Remove-Item -LiteralPath '${scratch}' -Recurse -Force`,
  retainReason: 'Packaged old-project import evidence and source/target comparisons' }, null, 2))

function inventory(root) {
  const files = {}
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) files[path.relative(root, file).replaceAll('\\', '/')] = sha256(file)
      else throw new Error(`Unsafe fixture entry: ${file}`)
    }
  }
  visit(root)
  return files
}

const compareSql = `import json,sqlite3,sys
old,new=sys.argv[1:]
tables=['project_core','contents','drafts','characters','reviews','revisions']
def conn(p): return sqlite3.connect('file:'+p+'?mode=ro',uri=True)
a,b=conn(old),conn(new)
result={}
for table in tables:
  columns=[row[1] for row in a.execute('pragma table_info('+table+')')]
  quoted=','.join('"'+column+'"' for column in columns)
  rows=lambda db: sorted([tuple(str(value) if isinstance(value,bytes) else value for value in row) for row in db.execute('select '+quoted+' from '+table)],key=str)
  left,right=rows(a),rows(b)
  if left!=right: raise AssertionError(table+' legacy rows changed')
  result[table]=len(left)
print(json.dumps(result))`

async function launch(roots) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy, AI_NOVEL_VELA_HOME: roots.legacy,
    HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[key]
  const app = await electron.launch({ executablePath: exe, cwd: packageDir,
    args: [`--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  const page = await app.firstWindow({ timeout: 30_000 })
  await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
  await page.evaluate(() => {
    const key = 'ai-novel-writer-appearance'
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...value, shellPreference: 'writer',
      revision: Number(value.revision ?? 0) + 1, origin: 'author' }))
  })
  await page.reload()
  return { app, page }
}

async function home(page) {
  await page.locator('.writer-shell[data-shell-presentation="writer"][data-shell-variant="v3"]')
    .waitFor({ state: 'visible', timeout: 30_000 })
  const migrationNotice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await migrationNotice.isVisible()) await migrationNotice.getByRole('button', { name: '知道了', exact: true }).click()
  if (!await page.locator('.writer-welcome').isVisible()) await page.locator('.writer-left-rail button[title="欢迎页"]').click()
  await page.locator('.writer-welcome').waitFor({ state: 'visible' })
}

async function quit(app) {
  const child = app.process()
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); return true })
  assert.deepEqual(await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Electron did not exit')), 10_000))]),
    { code: 0, signal: null })
}

async function verify(source) {
  const root = path.join(scratch, source.version)
  const sourceCopy = path.join(root, 's')
  // The existing Windows native-storage preflight permits a shorter project root
  // than our evidence directories; keep the published test project near scratch.
  const targetParent = path.join(scratch, source.version === 'v1.0.0' ? 'v10' : 'v11')
  fs.mkdirSync(targetParent, { recursive: true })
  const originalBefore = inventory(source.path)
  fs.cpSync(source.path, sourceCopy, { recursive: true, errorOnExist: true, force: false })
  if (source.injectedInventory) {
    const injected = path.join(sourceCopy, '.vela', 'upgrade-data-inventory.json')
    assert(fs.existsSync(injected), 'Expected historical test-injected inventory')
    fs.unlinkSync(injected)
  }
  const copiedBefore = inventory(sourceCopy)
  const roots = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData']
    .map(key => [key, path.join(root, key)]))
  for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true })
  let session
  try {
    session = await launch(roots)
    await home(session.page)
    await session.app.evaluate(({ dialog }, { sourceCopy, targetParent }) => {
      globalThis.__a11Dialogs = []
      dialog.showOpenDialog = async options => {
        globalThis.__a11Dialogs.push({ type: 'open', title: options.title })
        if (options.title === '选择旧版小说项目文件夹') return { canceled: false, filePaths: [sourceCopy] }
        if (options.title === '选择恢复副本所在文件夹') return { canceled: false, filePaths: [targetParent] }
        throw new Error(`Unexpected dialog: ${options.title}`)
      }
      dialog.showMessageBox = async options => {
        globalThis.__a11Dialogs.push({ type: 'confirm', message: options.message })
        if (!options.message.includes('保存并关闭旧版程序')) throw new Error('Unexpected confirmation')
        return { response: 1, checkboxChecked: false }
      }
    }, { sourceCopy, targetParent })
    await session.page.getByRole('button', { name: '导入旧项目副本' }).click()
    const target = path.join(targetParent, 's-新版副本')
    try {
      await session.page.locator('.writer-project-tree').getByText('升级保留验证小说', { exact: true })
        .waitFor({ state: 'visible', timeout: 30_000 })
    } catch (error) {
      receipt.diagnostic = { dialogs: await session.app.evaluate(() => globalThis.__a11Dialogs),
        notices: await session.page.locator('[role="status"]').allInnerTexts(),
        welcome: await session.page.locator('.writer-welcome').innerText().catch(() => null),
        targetExists: fs.existsSync(target), targetParentEntries: fs.readdirSync(targetParent) }
      throw error
    }
    assert(fs.existsSync(path.join(target, '.ai-novel', 'project.db')), 'No published target database')
    const dialogs = await session.app.evaluate(() => globalThis.__a11Dialogs)
    assert.deepEqual(dialogs.map(dialog => dialog.type), ['open', 'open', 'confirm'])
    const counts = JSON.parse(execFileSync('python', ['-c', compareSql,
      path.join(sourceCopy, '.vela', 'vela.db'), path.join(target, '.ai-novel', 'project.db')], { encoding: 'utf8' }))
    assert.equal(counts.project_core, 1)
    assert(counts.contents > 0 && counts.drafts > 0)
    assert.deepEqual(inventory(sourceCopy), copiedBefore, 'Scratch old source changed')
    assert.deepEqual(inventory(source.path), originalBefore, 'Historical fixture changed')
    receipt.steps.push({ version: source.version, step: 'V3 import and open', outcome: 'PASS',
      target, copiedSourceFiles: Object.keys(copiedBefore).length, counts, dialogs })
    await quit(session.app)
    session = null

    session = await launch(roots)
    await home(session.page)
    await session.page.locator('.writer-shelf').getByRole('button', { name: '打开《升级保留验证小说》' }).click()
    await session.page.locator('.writer-project-tree').getByText('升级保留验证小说', { exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 })
    assert.deepEqual(inventory(sourceCopy), copiedBefore)
    assert.deepEqual(inventory(source.path), originalBefore)
    receipt.steps.push({ version: source.version, step: 'New process opens copy; both old sources unchanged', outcome: 'PASS' })
  } finally { if (session) await session.app.close() }
}

try {
  for (const source of sources) await verify(source)
  receipt.outcome = 'PARTIAL'
  receipt.sliceOutcome = 'PASS'
} catch (error) {
  receipt.failure = { message: String(error), stack: error?.stack }
  console.error(error)
  process.exitCode = 1
} finally {
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ outcome: receipt.outcome, sliceOutcome: receipt.sliceOutcome, receiptPath,
    receiptSha256: sha256(receiptPath), steps: receipt.steps.length }))
}
