/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import * as lancedb from '@lancedb/lancedb'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = arg('package-dir')
const buildTree = arg('build-tree')
const fieldPolicy = path.join(buildTree ?? '', 'electron', 'services', 'portable-project-field-policy.json')
const testedSha = arg('tested-sha')
const expectedExe = arg('exe-sha256')
const expectedAsar = arg('asar-sha256')
const supplement = arg('supplement') === '1'
const onlyVersion = arg('only')
const finalDelta = arg('final-delta') === '1'
const sources = [
  { version: 'v1.0.0', path: arg('legacy-v100') },
  { version: 'v1.1.0', path: arg('legacy-v110') },
]
assert(packageDir && buildTree && /^[a-f0-9]{40}$/.test(testedSha ?? '')
  && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? '')
  && sources.every(source => source.path) && (!onlyVersion || sources.some(source => source.version === onlyVersion)),
  'Specify clean build tree, fixed package SHA/hashes, both historical fixture paths and a known --only version')
assert(!finalDelta || (supplement && onlyVersion === 'v1.1.0'), 'Final A11 delta requires one synthetic v1.1.0 source')
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
  mode: finalDelta ? 'synthetic-completeness-final-delta' : supplement ? 'synthetic-completeness' : 'historical-baseline',
  selectedVersions: onlyVersion ? [onlyVersion] : sources.map(source => source.version),
  testedSha, buildTree: path.resolve(buildTree),
  executionHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  driverSha256: sha256(fileURLToPath(import.meta.url)), fieldPolicySha256: sha256(fieldPolicy),
  packageHashes: { exe: sha256(exe), asar: sha256(asar) },
  historicalSources: sources.map(source => ({ version: source.version, path: source.path,
    injectedInventoryRemovedFromScratchCopy: fs.existsSync(path.join(source.path, '.vela', 'upgrade-data-inventory.json')) })),
  steps: [], exitDiagnostics: [], receiptPath }
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
old,new,policy_file=sys.argv[1:]
policy=json.load(open(policy_file,encoding='utf-8'))['tables']
def conn(p): return sqlite3.connect('file:'+p+'?mode=ro',uri=True)
a,b=conn(old),conn(new)
result={}
tables=[r[0] for r in a.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]
for table in tables:
  columns=[row[1] for row in a.execute('pragma table_info('+table+')')]
  rules=policy.get(table)
  if not rules or any(column not in rules for column in columns): raise AssertionError(table+' policy missing')
  if table=='text_metric_versions':
    if b.execute('select count(*) from text_metric_versions').fetchone()[0]: raise AssertionError('stale metric cache transferred')
    result[table]={'sourceRows':a.execute('select count(*) from text_metric_versions').fetchone()[0],'target':'rebuild'}
    continue
  if table=='import_legacy_identity_bridge':
    if b.execute('select count(*) from import_legacy_identity_bridge').fetchone()[0]: raise AssertionError('machine authority transferred')
    result[table]={'sourceRows':a.execute('select count(*) from import_legacy_identity_bridge').fetchone()[0],'target':'excluded'}
    continue
  if table=='llm_calls':
    columns=[name for name in columns if name in ('id','prompt_tokens','completion_tokens','total_tokens','duration_ms','success','created_at')]
  else: columns=[name for name in columns if rules[name] in ('D','H','P')]
  quoted=','.join('"'+column+'"' for column in columns)
  rows=lambda db: sorted([tuple(str(value) if isinstance(value,bytes) else value for value in row) for row in db.execute('select '+quoted+' from "'+table+'"')],key=str)
  left,right=rows(a),rows(b)
  if left!=right: raise AssertionError(table+' legacy rows changed')
  if table=='llm_calls':
    projected=b.execute("select model_id,model_name,purpose,error_message,success from llm_calls").fetchall()
    if any(row[:3]!=('', '旧版模型身份不可用', 'legacy') or row[3]!=( '' if row[4] else '旧版错误详情不可用') for row in projected): raise AssertionError('unsafe call history projection')
  if table=='post_process_steps':
    projected=b.execute('select error_msg,ok,attempt_count from post_process_steps').fetchall()
    if any(error!='旧版错误详情不可用' for error,ok,attempts in projected if not ok and attempts): raise AssertionError('unsafe step error projection')
  if table=='finalization_outbox':
    if any(error!='' for (error,) in b.execute('select last_error from finalization_outbox')): raise AssertionError('unsafe outbox error projection')
  for name,code in rules.items():
    if name not in [r[1] for r in a.execute('pragma table_info("'+table+'")')] or code!='X': continue
    info=next(r for r in b.execute('pragma table_info("'+table+'")') if r[1]==name)
    expected=None if not info[3] else (0 if any(t in info[2].upper() for t in ('INT','REAL','NUM','DEC','BOOL')) else '')
    if any(value!=expected for (value,) in b.execute('select "'+name+'" from "'+table+'"')): raise AssertionError(table+'.'+name+' authority transferred')
  result[table]=len(left)
result['avatarRows']=[{'path':p,'hash':h,'size':n} for p,h,n in b.execute('select relative_path,content_hash,byte_size from character_avatar_assets')]+[{'path':p,'hash':h,'size':n} for p,h,n in b.execute('select preserved_relative_path,content_hash,byte_size from character_avatar_unresolved where content_hash is not null')]
print(json.dumps(result))`

function comparisonDatabase(sourceCopy, root) {
  const copied = path.join(root, 'sql-read-copy')
  fs.mkdirSync(copied)
  const storage = path.join(sourceCopy, '.vela')
  for (const name of ['vela.db', 'vela.db-wal', 'vela.db-shm', 'vela.db-journal']) {
    const file = path.join(storage, name)
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(copied, name))
  }
  const snapshot = path.join(root, 'sql-comparison.db')
  // SQLite merges any committed WAL entries into this independent, read-only comparison input.
  execFileSync('python', ['-c', `import sqlite3,sys
source=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
target=sqlite3.connect(sys.argv[2])
source.backup(target)
target.close(); source.close()`, path.join(copied, 'vela.db'), snapshot])
  return snapshot
}

async function knowledgeSnapshot(storageRoot) {
  const directory = path.join(storageRoot, 'lancedb')
  if (!fs.existsSync(directory)) return { documents: [], chunks: [], tables: [] }
  const connection = await lancedb.connect(directory)
  try {
    const tables = (await connection.tableNames()).sort()
    const read = async name => {
      if (!tables.includes(name)) return []
      const table = await connection.openTable(name)
      try {
        return (await table.query().toArray()).map(row => name === 'documents'
          ? { id: row.id, fileName: row.fileName, chunkCount: row.chunkCount, corpusKind: row.corpusKind ?? null }
          : { id: row.id, docId: row.docId, text: row.text, chunkIndex: row.chunkIndex, totalChunks: row.totalChunks })
          .sort((left, right) => String(left.id).localeCompare(String(right.id)))
      } finally { table.close() }
    }
    return { documents: await read('documents'), chunks: await read('chunks'), tables }
  } finally { connection.close() }
}

const syntheticOriginal = '升级知识库完整原文：第一段是合成资料。\n\n第二段只在原始 TXT 文件中，不在旧索引片段中。\n'
const seedOutboxSql = `import hashlib,sqlite3,sys
db=sqlite3.connect(sys.argv[1])
assert db.execute("select name from sqlite_master where name='finalization_outbox'").fetchone()
assert db.execute('select count(*) from finalization_outbox').fetchone()[0]==0
draft=db.execute('select d.id,d.chapter_number,c.body from drafts d join contents c on c.id=d.content_id where d.id=73').fetchone()
assert draft and draft[1]==43
db.execute("insert into finalization_outbox(finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,content_snapshot,target_file_name,knowledge_document_id,publication_status,last_error) values(?,?,?,?,?,?,?,?,?,?,?)",
 ('a11-synthetic-pending',draft[0],draft[1],'合成待发布',hashlib.sha256(draft[2].encode()).hexdigest(),1,draft[2],'第43章 合成待发布.txt','','pending','sk-test-synthetic at C:\\\\Users\\\\fixture\\\\secret.txt'))
db.commit(); db.close()`

async function seedSupplement(sourceCopy) {
  const skill = path.join(sourceCopy, '.vela', 'skills', 'a11-style', 'SKILL.md')
  fs.mkdirSync(path.dirname(skill), { recursive: true })
  const skillBody = '---\nname: a11-style\ndescription: 合成旧版项目写作风格\nstage: drafting\n---\n\n保留角色语气，使用短段落。\n'
  fs.writeFileSync(skill, skillBody, { flag: 'wx' })
  const original = path.join(sourceCopy, '升级知识库.txt')
  fs.writeFileSync(original, syntheticOriginal, { flag: 'wx' })
  const connection = await lancedb.connect(path.join(sourceCopy, '.vela', 'lancedb'))
  try {
    const table = await connection.openTable('documents')
    try {
      const documents = await table.query().select(['id', 'fileName', 'filePath']).toArray()
      assert.deepEqual(documents.map(({ id, fileName }) => ({ id, fileName })),
        [{ id: 'upgrade-fixture-knowledge-document', fileName: '升级知识库.txt' }],
        'Synthetic original must bind to the actual old-format document')
      assert.equal(documents[0].filePath, '', 'Old document unexpectedly already has an original')
      await table.update({ where: "id = 'upgrade-fixture-knowledge-document'", values: { filePath: original } })
    } finally { table.close() }
  } finally { connection.close() }
  execFileSync('python', ['-c', seedOutboxSql, path.join(sourceCopy, '.vela', 'vela.db')])
  let avatarSha256
  if (finalDelta) {
    const avatar = path.join(sourceCopy, '.vela', 'avatars', 'a11-synthetic-orphan.png')
    fs.mkdirSync(path.dirname(avatar), { recursive: true })
    fs.writeFileSync(avatar, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNocFD4DwAEBAHg8uuA+QAAAABJRU5ErkJggg==', 'base64'), { flag: 'wx' })
    avatarSha256 = sha256(avatar)
  }
  return { skillSha256: sha256(skill), originalSha256: sha256(original),
    originalDocumentId: 'upgrade-fixture-knowledge-document', ...(avatarSha256 ? { avatarSha256 } : {}) }
}

async function verifySupplement(target, seeded) {
  const storage = path.join(target, '.ai-novel')
  const freeze = JSON.parse(fs.readFileSync(path.join(storage, 'portable-runtime-freeze.json'), 'utf8'))
  assert.equal(freeze.nonReplayable, true)
  assert(freeze.records.some(record => record.table === 'finalization_outbox'
    && record.recordId === 'a11-synthetic-pending' && record.nonReplayable === true),
  'Synthetic pending outbox lacks a frozen history record')
  assert.equal(sha256(path.join(storage, 'skills', 'a11-style', 'SKILL.md')), seeded.skillSha256)
  assert.equal(sha256(path.join(target, '升级知识库.txt')), seeded.originalSha256)
  const connection = await lancedb.connect(path.join(storage, 'lancedb'))
  try {
    const table = await connection.openTable('documents')
    try {
      const documents = await table.query().select(['id', 'filePath']).toArray()
      assert.equal(documents.find(row => row.id === seeded.originalDocumentId)?.filePath,
        `knowledge-copy:${seeded.originalDocumentId}`)
    } finally { table.close() }
  } finally { connection.close() }
  const copyPath = path.join(storage, 'knowledge-copies',
    `${createHash('sha256').update(seeded.originalDocumentId).digest('hex')}.json`)
  const copy = JSON.parse(fs.readFileSync(copyPath, 'utf8'))
  assert.equal(copy.content, syntheticOriginal)
  assert.equal(copy.indexedHash, seeded.originalSha256)
  assert.equal(copy.edited, false)
  assert.equal(copy.indexDirty, true)
  return { ...seeded, targetKnowledgeCopySha256: sha256(copyPath), knowledgeStatus: 'stale', outboxFrozen: true }
}

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

async function observeRequests(session) {
  let rendererRequests = 0
  session.page.on('request', request => { if (/^https?:/i.test(request.url())) rendererRequests += 1 })
  await session.app.evaluate(() => {
    const originalFetch = globalThis.fetch
    globalThis.__a11MainFetchCalls = 0
    globalThis.fetch = (...args) => {
      globalThis.__a11MainFetchCalls += 1
      return originalFetch(...args)
    }
  })
  return async () => {
    const mainFetchCalls = await session.app.evaluate(() => globalThis.__a11MainFetchCalls)
    const result = { mainFetchCalls, rendererRequests }
    assert.deepEqual(result, { mainFetchCalls: 0, rendererRequests: 0 }, 'Unexpected network request during A11 import or reopen')
    return result
  }
}

const editorBody = locator => locator.evaluate(element => Array.from(element.querySelectorAll('.cm-line'), line => {
  const copy = line.cloneNode(true)
  copy.querySelector('.cm-lp-paperhead')?.remove()
  return copy.textContent
}).join('\n'))

function draftBodies(target) {
  return JSON.parse(execFileSync('python', ['-c', `import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps([r[0] for r in db.execute('select body from contents')]))
db.close()`, path.join(target, '.ai-novel', 'project.db')], { encoding: 'utf8' }))
}

async function quit(app, page, version) {
  const child = app.process()
  const events = []
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    events.push({ event: 'process-exit', code, signal })
    resolve({ code, signal })
  }))
  app.on('close', () => events.push({ event: 'app-close' }))
  page.on('close', () => events.push({ event: 'page-close' }))
  page.on('crash', () => events.push({ event: 'page-crash' }))
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__a11WindowCloseEvents = []
    const win = BrowserWindow.getAllWindows()[0]
    win?.on('close', event => globalThis.__a11WindowCloseEvents.push({ event: 'window-close', defaultPrevented: event.defaultPrevented }))
    win?.on('closed', () => globalThis.__a11WindowCloseEvents.push({ event: 'window-closed' }))
  })
  await page.evaluate(() => {
    globalThis.__a11CloseRequests = []
    window.aiNovelAPI.on('window:close-requested', ({ requestId }) => {
      globalThis.__a11CloseRequests.push({ requestId })
    })
  })
  const started = Date.now()
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); return true })
  let timer
  const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 10_000) })])
  clearTimeout(timer)
  const diagnostic = { version, elapsedMs: Date.now() - started, result, events }
  if (!result) {
    diagnostic.windowEvents = await Promise.race([
      app.evaluate(() => globalThis.__a11WindowCloseEvents ?? []).catch(error => ({ unavailable: String(error) })),
      new Promise(resolve => setTimeout(() => resolve({ unavailable: 'main process did not answer' }), 1_000)),
    ])
    diagnostic.renderer = await Promise.race([
      page.evaluate(() => ({ closeRequests: globalThis.__a11CloseRequests ?? [],
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(item => item.innerText.slice(0, 700)),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(item => item.innerText.slice(0, 500)),
        unsavedMarkers: document.querySelectorAll('[aria-label*="未保存"], [title*="未保存"], [data-dirty="true"]').length,
        workflowBlockedDialog: document.body.innerText.includes('创作任务仍在运行'),
      })).catch(error => ({ unavailable: String(error) })),
      new Promise(resolve => setTimeout(() => resolve({ unavailable: 'renderer did not answer' }), 1_000)),
    ])
  }
  receipt.exitDiagnostics.push(diagnostic)
  if (!result) throw new Error('Electron did not exit')
  assert.deepEqual(result, { code: 0, signal: null })
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
  const injected = path.join(sourceCopy, '.vela', 'upgrade-data-inventory.json')
  if (fs.existsSync(injected)) fs.unlinkSync(injected)
  const seeded = supplement ? await seedSupplement(sourceCopy) : null
  const copiedBefore = inventory(sourceCopy)
  const roots = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData']
    .map(key => [key, path.join(root, key)]))
  for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true })
  let session
  let savedBody
  try {
    session = await launch(roots)
    await home(session.page)
    let requestCounts = finalDelta ? await observeRequests(session) : null
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
    assert.deepEqual(inventory(sourceCopy), copiedBefore, 'Scratch old source changed during import')
    const oldDatabase = comparisonDatabase(sourceCopy, root)
    const { avatarRows, ...counts } = JSON.parse(execFileSync('python', ['-c', compareSql,
      oldDatabase, path.join(target, '.ai-novel', 'project.db'), fieldPolicy], { encoding: 'utf8' }))
    assert.equal(counts.project_core, 1)
    if (supplement) assert.equal(counts.finalization_outbox, 1, 'Synthetic pending outbox was lost')
    for (const table of ['blueprints', 'characters', 'contents', 'drafts', 'reviews', 'revisions',
      'summary_snapshots', 'llm_calls', 'post_process_runs', 'post_process_steps']) {
      assert(counts[table] > 0, `Historical fixture lacks ${table}`)
    }
    const rawAssets = {}
    for (const [name, digest] of Object.entries(copiedBefore)) {
      if (name.startsWith('.vela/lancedb/') || name.startsWith('.vela/vela.db')
        || name.startsWith('.vela/avatars/')
        || name === '.vela/project.json' || name === '.vela/upgrade-data-inventory.json'
        || name === '.vela/embedding-spaces.json') continue
      const targetName = name.startsWith('.vela/') ? `.ai-novel/${name.slice('.vela/'.length)}` : name
      assert.equal(sha256(path.join(target, targetName)), digest, `Author asset changed: ${name}`)
      rawAssets[name] = digest
    }
    assert(Object.keys(rawAssets).some(name => name.startsWith('.vela/prompts/')))
    assert(Object.keys(rawAssets).some(name => name.endsWith('.txt') && !name.startsWith('.vela/')))
    const sourceAvatars = Object.entries(copiedBefore).filter(([name]) => name.startsWith('.vela/avatars/'))
    assert.deepEqual([...new Set(avatarRows.map(row => row.hash))].sort(),
      [...new Set(sourceAvatars.map(([, digest]) => digest))].sort(),
      'Avatar source bytes lack a target M05 database reference')
    if (finalDelta) {
      assert.equal(avatarRows.length, 1, 'Synthetic orphan avatar lacks its M05 target row')
      assert(avatarRows[0].path.startsWith('avatars/unresolved/'))
      assert.equal(avatarRows[0].hash, seeded.avatarSha256)
    }
    for (const row of avatarRows) {
      assert(typeof row.path === 'string' && row.path.startsWith('avatars/')
        && !row.path.includes('\\') && !row.path.split('/').includes('..'), 'Unsafe target avatar reference')
      const storage = path.resolve(target, '.ai-novel')
      const file = path.resolve(storage, ...row.path.split('/'))
      const relative = path.relative(storage, file)
      assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative), 'Target avatar escaped project storage')
      assert.equal(sha256(file), row.hash, `Avatar content changed: ${row.path}`)
      assert.equal(fs.statSync(file).size, row.size, `Avatar size changed: ${row.path}`)
    }
    assert.deepEqual(inventory(sourceCopy), copiedBefore, 'Scratch old source changed')
    assert.deepEqual(inventory(source.path), originalBefore, 'Historical fixture changed')
    receipt.steps.push({ stepId: `${source.version}-import-open`, version: source.version, step: 'V3 import and open', outcome: 'PASS',
      target, copiedSourceFiles: Object.keys(copiedBefore).length, counts, rawAssets,
      avatars: avatarRows.map(({ path: relativePath, hash }) => ({ relativePath, hash })), dialogs })
    if (finalDelta) {
      await session.page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).first().click()
      const editor = session.page.locator('.cm-content[contenteditable="true"]')
      await editor.waitFor({ state: 'visible' })
      const originalBody = await editorBody(editor)
      assert(draftBodies(target).includes(originalBody), 'Opened draft differs from imported author body')
      assert(!originalBody.includes(' A11 目标补写'))
      savedBody = `${originalBody} A11 目标补写`
      await editor.click()
      await session.page.keyboard.press('Control+End')
      await session.page.keyboard.type(' A11 目标补写')
      assert.equal(await editorBody(editor), savedBody)
      await session.page.locator('[role="status"]').filter({ hasText: /^未保存$/ }).last().waitFor({ state: 'visible' })
      await session.page.locator('button[title="保存（⌘S）"]').click()
      await session.page.locator('[role="status"]').filter({ hasText: /^已保存$/ }).last().waitFor({ state: 'visible' })
      assert(draftBodies(target).includes(savedBody), 'Target draft save did not persist')
      assert.deepEqual(inventory(sourceCopy), copiedBefore)
      assert.deepEqual(inventory(source.path), originalBefore)
      receipt.steps.push({ stepId: `${source.version}-target-edit-save`, outcome: 'PASS',
        step: 'V3 edited and saved imported author body without changing either old source', savedBodySha256: createHash('sha256').update(savedBody).digest('hex') })
      const requests = await requestCounts()
      receipt.steps.push({ stepId: `${source.version}-import-zero-network`, outcome: 'PASS',
        step: 'No main fetch or renderer HTTP request during V3 import and target save', requests })
    }
    await quit(session.app, session.page, source.version)
    session = null

    const knowledge = await knowledgeSnapshot(path.join(target, '.ai-novel'))
    assert.deepEqual(knowledge, await knowledgeSnapshot(path.join(sourceCopy, '.vela')),
      'Knowledge document/chunk text or table set changed')
    assert(knowledge.documents.length > 0 && knowledge.chunks.length > 0)
    receipt.steps.push({ stepId: `${source.version}-knowledge-index`, version: source.version, step: 'Stored knowledge document and chunk text preserved',
      outcome: 'PASS', documents: knowledge.documents.length, chunks: knowledge.chunks.length, tables: knowledge.tables })

    if (seeded) {
      const proof = await verifySupplement(target, seeded)
      receipt.steps.push({ stepId: `${source.version}-synthetic-full-original-skill-outbox`, version: source.version,
        step: 'Synthetic complete original, project Skill and frozen pending outbox retained', outcome: 'PASS', proof })
    }

    session = await launch(roots)
    await home(session.page)
    requestCounts = finalDelta ? await observeRequests(session) : null
    await session.page.locator('.writer-shelf').getByRole('button', { name: '打开《升级保留验证小说》' }).click()
    await session.page.locator('.writer-project-tree').getByText('升级保留验证小说', { exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 })
    if (finalDelta) {
      await session.page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).first().click()
      const editor = session.page.locator('.cm-content[contenteditable="true"]')
      assert.equal(await editorBody(editor), savedBody)
      assert(draftBodies(target).includes(savedBody))
      receipt.steps.push({ stepId: `${source.version}-target-edit-reopen`, outcome: 'PASS',
        step: 'New V3 process read the exact edited target draft', savedBodySha256: createHash('sha256').update(savedBody).digest('hex') })
      const requests = await requestCounts()
      receipt.steps.push({ stepId: `${source.version}-reopen-zero-network`, outcome: 'PASS',
        step: 'No main fetch or renderer HTTP request while reopening imported copy', requests })
    }
    assert.deepEqual(inventory(sourceCopy), copiedBefore)
    assert.deepEqual(inventory(source.path), originalBefore)
    receipt.steps.push({ stepId: `${source.version}-reopen-unchanged`, version: source.version,
      step: 'New process opens copy; both old sources unchanged', outcome: 'PASS' })
    if (finalDelta) {
      await quit(session.app, session.page, source.version)
      session = null
      const targetBeforeOldWrite = inventory(target)
      execFileSync('python', ['-c', `import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
updated=db.execute("update project_core set project_name='A11 旧源后续独立修改' where id='main'")
assert updated.rowcount==1
db.commit(); db.close()`, path.join(sourceCopy, '.vela', 'vela.db')])
      const copiedAfterOldWrite = inventory(sourceCopy)
      assert.notDeepEqual(copiedAfterOldWrite, copiedBefore)
      assert.deepEqual(inventory(target), targetBeforeOldWrite, 'Old scratch source write reached target')
      assert.deepEqual(inventory(source.path), originalBefore, 'Historical source changed during isolation check')
      receipt.steps.push({ stepId: `${source.version}-reverse-write-isolation`, outcome: 'PASS',
        step: 'Later write to isolated scratch old project leaves target and historical source unchanged' })

      session = await launch(roots)
      await home(session.page)
      requestCounts = await observeRequests(session)
      const firstTargetBefore = inventory(target)
      const firstProjectId = JSON.parse(fs.readFileSync(path.join(target, '.ai-novel', 'project.json'), 'utf8')).projectId
      await session.app.evaluate(({ dialog }, { sourceCopy, targetParent }) => {
        dialog.showOpenDialog = async options => {
          if (options.title === '选择旧版小说项目文件夹') return { canceled: false, filePaths: [sourceCopy] }
          if (options.title === '选择恢复副本所在文件夹') return { canceled: false, filePaths: [targetParent] }
          throw new Error(`Unexpected dialog: ${options.title}`)
        }
        dialog.showMessageBox = async options => {
          if (!options.message.includes('保存并关闭旧版程序')) throw new Error('Unexpected confirmation')
          return { response: 1, checkboxChecked: false }
        }
      }, { sourceCopy, targetParent })
      await session.page.getByRole('button', { name: '导入旧项目副本' }).click()
      const secondTarget = `${target}-2`
      await session.page.locator('.writer-project-tree').getByText('A11 旧源后续独立修改', { exact: true })
        .waitFor({ state: 'visible', timeout: 30_000 })
      const secondProjectId = JSON.parse(fs.readFileSync(path.join(secondTarget, '.ai-novel', 'project.json'), 'utf8')).projectId
      assert.notEqual(secondProjectId, firstProjectId, 'Repeated import reused an existing identity')
      assert.deepEqual(inventory(target), firstTargetBefore, 'Existing target was overwritten')
      assert.deepEqual(inventory(sourceCopy), copiedAfterOldWrite, 'Scratch old source changed on repeated import')
      assert.deepEqual(inventory(source.path), originalBefore, 'Historical source changed on repeated import')
      const requests = await requestCounts()
      receipt.steps.push({ stepId: `${source.version}-duplicate-no-overwrite`, outcome: 'PASS',
        step: 'V3 entry allocated a distinct second target without changing the first target or either old source',
        firstTarget: target, secondTarget, firstProjectId, secondProjectId,
        firstTargetSha256: createHash('sha256').update(JSON.stringify(firstTargetBefore)).digest('hex'),
        secondTargetSha256: createHash('sha256').update(JSON.stringify(inventory(secondTarget))).digest('hex'), requests })
    }
  } finally { if (session) await session.app.close() }
}

try {
  for (const source of sources.filter(source => !onlyVersion || source.version === onlyVersion)) await verify(source)
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
