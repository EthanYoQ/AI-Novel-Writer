/* global process */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import * as lancedb from '@lancedb/lancedb'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const macMountedApp = arg('mac-mounted-app')
const macFixtureOnly = arg('mac-fixture-only') === '1'
const macMode = Boolean(macMountedApp || macFixtureOnly)
const winInstalledApp = arg('win-installed-app')
const winUnpackedApp = arg('win-unpacked-app')
assert(!(winInstalledApp && winUnpackedApp), 'Select installed or unpacked Windows package, not both')
const winMode = Boolean(winInstalledApp || winUnpackedApp)
const nativePicker = arg('native-picker') === '1'
assert(!nativePicker || (winMode && !macMode), '--native-picker=1 requires an official Windows package mode')
assert(!winUnpackedApp || nativePicker, '--win-unpacked-app requires --native-picker=1')
const nativePickerHelper = path.join(repository, 'scripts', 'f05-u16-native-picker.ps1')
const macScratchRoot = arg('scratch-root')
const macDmg = arg('dmg')
const macMountPoint = arg('mount-point')
const macArch = arg('arch')
const macVersion = arg('mac-version') ?? arg('win-version')
const packageDir = macMode ? macMountedApp : winMode ? winInstalledApp || winUnpackedApp : arg('package-dir')
const buildTree = arg('build-tree')
const officialFixtureRoot = path.join(winUnpackedApp ? buildTree ?? '' : repository, 'scripts', 'fixtures', 's14c-official-old-sources')
const fieldPolicy = path.join(buildTree ?? '', 'electron', 'services', 'portable-project-field-policy.json')
const testedSha = arg('tested-sha')
const expectedExe = arg('exe-sha256')
const expectedAsar = arg('asar-sha256')
const supplement = arg('supplement') === '1'
const onlyVersion = arg('only')
const finalDelta = arg('final-delta') === '1'
const legacyV025 = arg('legacy-v025')
const installedRoot = arg('installer-smoke-root')
const legacyHome = arg('legacy-home')
const editSaveProof = finalDelta || Boolean(legacyV025)
const sources = legacyV025 ? [{ version: 'v0.2.5', path: legacyV025 }] : [
  { version: 'v1.0.0', path: arg('legacy-v100') },
  { version: 'v1.1.0', path: arg('legacy-v110') },
]
let unpackedProvenance
assert(!(macMode && winMode), 'Select one official package platform')
if (macMode) {
  assert(macScratchRoot && path.isAbsolute(macScratchRoot), 'macOS fixture requires an absolute --scratch-root')
  assert(['v1.0.0', 'v1.1.0'].includes(macVersion), 'Select an official --mac-version')
  if (!macFixtureOnly) {
    assert(macMountedApp && macDmg && macMountPoint && /^[a-f0-9]{40}$/.test(testedSha ?? '')
      && ['arm64', 'x64'].includes(macArch), 'Specify mounted app, DMG, mount point, tested SHA and arch')
    assert.equal(process.platform, 'darwin', 'Mounted macOS package journey requires macOS')
    assert.equal(path.resolve(macMountedApp), path.join(path.resolve(macMountPoint), path.basename(macMountedApp)))
    assert.equal(fs.realpathSync(macMountedApp), path.join(fs.realpathSync(macMountPoint), path.basename(macMountedApp)))
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), testedSha)
    assert.equal(execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim(), macArch === 'x64' ? 'x86_64' : 'arm64')
    assert(fs.statSync(macDmg).isFile(), 'Missing mounted DMG source')
  }
} else if (winMode) {
  assert.equal(process.platform, 'win32', 'Official Windows package journey requires Windows')
  assert(macScratchRoot && path.isAbsolute(macScratchRoot) && path.isAbsolute(packageDir)
    && ['v1.0.0', 'v1.1.0'].includes(macVersion)
    && /^[a-f0-9]{40}$/.test(testedSha ?? '')
    && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'Specify absolute Windows app and scratch, official Windows version, tested SHA and package hashes')
  if (winUnpackedApp) unpackedProvenance = unpackedPackageProvenance()
  else {
  assert.equal(path.basename(path.resolve(winInstalledApp)), 'installed-app', 'Expected installer installed-app directory')
  assert.equal(fs.realpathSync(winInstalledApp), path.resolve(winInstalledApp), 'Installed app directory must not be a link')
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), testedSha,
    'Execution HEAD differs from tested SHA')
  }
} else {
assert(packageDir && buildTree && /^[a-f0-9]{40}$/.test(testedSha ?? '')
  && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? '')
  && sources.every(source => source.path) && (!onlyVersion || sources.some(source => source.version === onlyVersion)),
  'Specify clean build tree, fixed package SHA/hashes, both historical fixture paths and a known --only version')
assert(!finalDelta || (supplement && onlyVersion === 'v1.1.0'), 'Final A11 delta requires one synthetic v1.1.0 source')
}
const buildGit = (...args) => execFileSync('git', args, { cwd: buildTree, encoding: 'utf8' }).trim()
if (!macMode && !winMode) {
assert.equal(buildGit('rev-parse', 'HEAD'), testedSha, 'Build tree HEAD differs from tested SHA')
assert.equal(buildGit('status', '--porcelain'), '', 'Build tree must be clean')
if (installedRoot) {
  assert(legacyV025 && legacyHome, 'Installed v0.2.5 copy requires source and isolated legacy home')
  assert.equal(path.dirname(path.resolve(installedRoot)), path.join(path.resolve(buildTree), '.runtime', '.cache'))
  assert.match(path.basename(installedRoot), /^ai-novel-installer-smoke-[a-f0-9]+$/)
  assert.equal(path.resolve(packageDir), path.join(path.resolve(installedRoot), 'installed-app'))
  assert.equal(fs.realpathSync(packageDir), path.resolve(packageDir))
} else assert.equal(path.resolve(packageDir), path.join(path.resolve(buildTree), 'release', JSON.parse(fs.readFileSync(path.join(buildTree, 'package.json'), 'utf8')).version, 'win-unpacked'))
}

function unpackedPackageProvenance() {
  assert(buildTree && path.isAbsolute(buildTree), 'Unpacked native qualification requires an absolute --build-tree')
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()
  const executionHead = git(repository, 'rev-parse', 'HEAD')
  const buildTreeHead = git(buildTree, 'rev-parse', 'HEAD')
  assert.equal(git(buildTree, 'status', '--porcelain'), '', 'Build tree must be clean')
  const changedPaths = git(repository, 'diff', '--name-only', `${testedSha}..${executionHead}`).split('\n').filter(Boolean)
  const buildChangedPaths = git(buildTree, 'diff', '--name-only', `${testedSha}..${buildTreeHead}`).split('\n').filter(Boolean)
  const dirtyExecutionPaths = git(repository, 'status', '--porcelain').split('\n').filter(Boolean)
  assert([...changedPaths, ...buildChangedPaths, ...dirtyExecutionPaths.map(line => line.slice(3))]
    .every(file => file.startsWith('scripts/')), 'Only script changes may follow the unpacked package source')
  assert.equal(git(buildTree, 'diff', '--name-only', `${testedSha}..${buildTreeHead}`, '--',
    'scripts/fixtures/s14c-official-old-sources'), '', 'Official fixtures must match the package source')
  const expected = path.join(buildTree, 'release', JSON.parse(fs.readFileSync(path.join(buildTree, 'package.json'), 'utf8')).version, 'win-unpacked')
  assert.equal(fs.realpathSync.native(packageDir), fs.realpathSync.native(expected), 'Package is not the build tree win-unpacked artifact')
  return { packageSourceSha: testedSha, executionHead, buildTreeHead, buildTree: path.resolve(buildTree),
    changedPaths, buildChangedPaths, dirtyExecutionPaths }
}

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const hashText = value => createHash('sha256').update(value).digest('hex')
const exe = macMode && !macFixtureOnly ? path.join(macMountedApp, 'Contents', 'MacOS', 'AI小说作家') : path.join(packageDir ?? '', 'AI小说作家.exe')
const asar = macMode && !macFixtureOnly ? path.join(macMountedApp, 'Contents', 'Resources', 'app.asar') : path.join(packageDir ?? '', 'resources', 'app.asar')
if (macMode && !macFixtureOnly) assert(fs.statSync(exe).isFile() && fs.statSync(asar).isFile(), 'Mounted app executable or ASAR missing')
if (winMode) {
  assert(fs.statSync(exe).isFile() && fs.statSync(asar).isFile(), 'Windows app executable or ASAR missing')
  assert.equal(sha256(exe), expectedExe, `${winUnpackedApp ? 'Unpacked' : 'Installed'} app executable hash differs`)
  assert.equal(sha256(asar), expectedAsar, `${winUnpackedApp ? 'Unpacked' : 'Installed'} app ASAR hash differs`)
}
const runId = randomUUID()
const scratch = macMode || winMode ? path.resolve(macScratchRoot) : path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'AI-Novel', `a11-${runId.slice(0, 8)}`)
const receiptPath = macMode || winMode ? path.join(scratch, 'receipt.json') : path.join(repository, '.runtime', '.cache', 'f05-a11-offline-import', runId, 'receipt.json')
const receipt = macMode ? { outcome: 'FAIL', sliceOutcome: 'FAIL', qualification: 'A11_OFFLINE_LEGACY_COPY_MAC_V3',
  mode: 'official-old-app-mounted-app', testedSha, arch: macArch, steps: [], exitDiagnostics: [],
  provenance: macFixtureOnly ? null : { driverSha256: sha256(fileURLToPath(import.meta.url)),
    sourceManifestSha256: sha256(path.join(officialFixtureRoot, 'manifest.json')),
    dmgSha256: sha256(macDmg), executableSha256: sha256(exe), asarSha256: sha256(asar),
    appPathSha256: hashText(fs.realpathSync(macMountedApp)), mountPointSha256: hashText(fs.realpathSync(macMountPoint)) },
} : winMode ? { outcome: 'FAIL', sliceOutcome: 'FAIL', qualification: winUnpackedApp ? 'A11_OFFLINE_LEGACY_COPY_WIN_UNPACKED_NATIVE_V3' : 'A11_OFFLINE_LEGACY_COPY_WIN_V3',
  mode: 'official-old-app-installed-app', testedSha, steps: [], exitDiagnostics: [], receiptPath,
  provenance: { driverSha256: sha256(fileURLToPath(import.meta.url)),
    sourceManifestSha256: sha256(path.join(officialFixtureRoot, 'manifest.json')),
    executableSha256: sha256(exe), asarSha256: sha256(asar), ...unpackedProvenance },
} : { outcome: 'FAIL', sliceOutcome: 'FAIL', qualification: 'A11_OFFLINE_LEGACY_COPY_WIN_V3',
  mode: legacyV025 ? 'v025-roster-refusal-v2' : finalDelta ? 'synthetic-completeness-final-delta' : supplement ? 'synthetic-completeness' : 'historical-baseline',
  packageMode: installedRoot ? 'installed' : 'unpacked',
  selectedVersions: onlyVersion ? [onlyVersion] : sources.map(source => source.version),
  testedSha, buildTree: path.resolve(buildTree),
  executionHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  driverSha256: sha256(fileURLToPath(import.meta.url)), fieldPolicySha256: sha256(fieldPolicy),
  packageHashes: { exe: sha256(exe), asar: sha256(asar) },
  historicalSources: sources.map(source => ({ version: source.version, path: source.path,
    injectedInventoryRemovedFromScratchCopy: fs.existsSync(path.join(source.path, '.vela', 'upgrade-data-inventory.json')) })),
  steps: [], exitDiagnostics: [], receiptPath }
if (!macMode && !winMode) assert.deepEqual(receipt.packageHashes, { exe: expectedExe, asar: expectedAsar })
if (nativePicker) Object.assign(receipt, { mode: `official-old-app-${winUnpackedApp ? 'unpacked' : 'installed-app'}-native-picker`,
  packageMode: winUnpackedApp ? 'unpacked' : 'installed',
  nativePickerHelperSha256: sha256(nativePickerHelper), nativePickerEvidence: [],
  pickerQualification: 'Native source and target OS choices; legacy warning confirmation remains controlled' })
fs.mkdirSync(scratch, { recursive: true })
if (!macMode) {
fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: winMode ? 'codex/s14c-windows-official' : legacyV025 ? 'codex/thread-7/s14c-v025' : 'codex/thread-6/a11',
  sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
  cleanupCommand: `Remove-Item -LiteralPath '${scratch}' -Recurse -Force`,
  retainReason: 'Packaged old-project import evidence and source/target comparisons' }, null, 2))
}

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

function chooseNativeDirectory(title, target, pid) {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', nativePickerHelper,
    '-Target', target, '-ExpectedExe', exe, '-DialogTitle', title],
  { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, `native picker: ${result.stderr || result.stdout || result.error}`)
  const evidence = JSON.parse(result.stdout.trim())
  receipt.nativePickerEvidence.push(evidence)
  assert.equal(evidence.dialogTitle, title)
  assert.equal(evidence.dialogPid, pid)
  assert.equal(evidence.typedExact, true)
  assert.equal(evidence.submitted, true)
}

function verifyNativeImportGrants(calls) {
  const channels = ['dialog:select-legacy-project', 'dialog:select-project-restore-target', 'project:import-legacy-copy']
  assert.deepEqual(calls.map(call => call.channel), channels)
  const [source, target, imported] = calls
  for (const [index, choice] of [source, target].entries()) {
    assert.deepEqual(Object.keys(choice.result).sort(), ['displayName', 'grantId'])
    assert.match(choice.result.grantId, /^[a-f0-9-]{36}$/i)
    assert.equal(choice.senderId, imported.senderId)
    assert.equal(choice.result.grantId, imported.args[index])
  }
  assert.equal(imported.result.state, 'ready')
  assert.match(imported.result.projectId, /^[a-f0-9-]{36}$/i)
  return { senderId: imported.senderId, sourceOpaque: true, targetOpaque: true, consumerMatched: true,
    projectId: imported.result.projectId, targetRoot: imported.result.targetRoot }
}

async function captureNativeImportFailure(session) {
  let timer
  try {
    return await Promise.race([
      Promise.all([
        session.app.evaluate(() => ({ dialogs: globalThis.__a11Dialogs ?? [],
          calls: (globalThis.__a11NativeCalls ?? []).map(call => ({ channel: call.channel,
            senderId: call.senderId, error: call.error, pending: !('result' in call) && !call.error,
            result: call.channel === 'project:import-legacy-copy' ? call.result
              : { selected: Boolean(call.result), grantIssued: typeof call.result?.grantId === 'string',
                  displayName: call.result?.displayName } })) })).catch(() => ({ unavailable: true })),
        session.page.evaluate(() => ({ alerts: [...document.querySelectorAll('[role="alert"], [role="alertdialog"], [role="status"]')]
          .filter(node => node.getClientRects().length).slice(0, 10).map(node => node.textContent?.slice(0, 500)),
        projectTree: document.querySelector('.writer-project-tree')?.textContent?.slice(0, 2000) ?? null }))
          .catch(() => ({ unavailable: true })),
      ]).then(([main, renderer]) => ({ main, renderer })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: true, reason: 'diagnostic-timeout' }), 3_000) }),
    ])
  } finally { clearTimeout(timer) }
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
  execFileSync(macMode ? 'python3' : 'python', ['-c', `import sqlite3,sys
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

function macStage(stage) {
  if (!macMode && !winMode) return
  receipt.lastStage = stage
  console.error(`[AI Novel A11] stage=${stage}`)
}

function v025Stage(stage) {
  if (!legacyV025) return
  receipt.lastStage = stage
  console.error(`[AI Novel A11] stage=${stage}`)
}

async function closeMacApplication(app) {
  macStage('cleanup-start')
  let timer
  try {
    await Promise.race([app.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Mac A11 application cleanup timed out (10000ms)')), 10_000)
    })])
    macStage('cleanup-complete')
  } catch (error) {
    receipt.cleanupFailure = { message: String(error), stack: error?.stack }
    macStage('cleanup-failed')
    console.error(error)
    try {
      const child = app.process()
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    } catch (terminationError) {
      receipt.cleanupFailure.terminationError = String(terminationError)
      console.error(terminationError)
    }
    if (!receipt.failure) throw error
  } finally { clearTimeout(timer) }
}

async function closeWindowsApplication(app) {
  let pid
  try {
    pid = app.process()?.pid
    assert(Number.isSafeInteger(pid) && pid > 0, 'Packaged Electron process PID is unavailable')
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, encoding: 'utf8', timeout: 10_000 })
  } catch (error) {
    receipt.cleanupFailure = { processTree: 'not-confirmed', pid: pid ?? null,
      code: error?.code ?? null, status: error?.status ?? null }
  }
  let timer
  try {
    const closed = await Promise.race([app.close().then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 2_000) })])
    if (!closed) receipt.cleanupFailure = { ...receipt.cleanupFailure, playwrightClose: 'not-confirmed', pid: pid ?? null }
  } catch {
    receipt.cleanupFailure = { ...receipt.cleanupFailure, playwrightClose: 'failed', pid: pid ?? null }
  } finally { clearTimeout(timer) }
}

function configHasBom(file) {
  try { return fs.existsSync(file) ? fs.readFileSync(file).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) : null }
  catch { return null }
}

async function launch(roots) {
  const officialWindows = roots.officialWindows === true
  macStage('launch-start')
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy, AI_NOVEL_VELA_HOME: roots.legacy,
    HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[key]
  const app = await electron.launch({ executablePath: exe, cwd: macMode ? path.dirname(exe) : packageDir,
    args: [`--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  let page
  let stage = 'electron-created'
  try {
    macStage('electron-created')
    page = await app.firstWindow({ timeout: 30_000 })
    stage = 'first-window-ready'
    macStage('first-window-ready')
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    stage = 'skin-ready'
    macStage('skin-ready')
    if (macMode || officialWindows) await page.evaluate(async () => {
      const saved = await window.aiNovelAPI.invoke('config:set', { locale: 'zh-CN' })
      if (!saved.success) throw new Error(saved.error || 'Mac A11 locale configuration failed')
      const config = await window.aiNovelAPI.invoke('config:get')
      if (config.locale !== 'zh-CN') throw new Error('Mac A11 locale configuration was not persisted')
    })
    await page.evaluate(() => {
      const key = 'ai-novel-writer-appearance'
      const value = JSON.parse(localStorage.getItem(key) ?? '{}')
      localStorage.setItem(key, JSON.stringify({ ...value, shellPreference: 'writer',
        revision: Number(value.revision ?? 0) + 1, origin: 'author' }))
    })
    macStage('shell-configured')
    await page.reload()
    if (macMode || officialWindows) await page.locator('html[lang="zh-CN"]').waitFor({ state: 'visible', timeout: 30_000 })
    macStage('launch-ready')
    return { app, page }
  } catch (error) {
    if (macMode) {
      receipt.failure = { message: String(error), stack: error?.stack }
      console.error(`[AI Novel A11] failure-stage=${receipt.lastStage}`, error)
      await closeMacApplication(app)
    } else {
      try {
        const generationsRoot = path.join(roots.canonical, 'generations')
        const generations = fs.existsSync(generationsRoot) ? fs.readdirSync(generationsRoot) : []
        const diagnostic = { stage, startupState: null, visibleAlert: null,
          legacyConfigHasBom: configHasBom(path.join(roots.legacy, 'config.json')),
          canonicalConfigHasBom: generations.length === 1
            ? configHasBom(path.join(generationsRoot, generations[0], 'config.json')) : null }
        if (page) {
          let timer
          try {
            const facts = await Promise.race([page.evaluate(async () => {
              const visibleAlert = [...document.querySelectorAll('[role="alert"]')]
                .some(element => element.getClientRects().length > 0)
              const state = await Promise.race([
                Promise.resolve().then(() => window.aiNovelAPI?.invoke('startup:get-state')).catch(() => null),
                new Promise(resolve => setTimeout(() => resolve(null), 1_000)),
              ])
              return { startupState: state?.state ?? null, visibleAlert }
            }).catch(() => null), new Promise(resolve => { timer = setTimeout(() => resolve(null), 1_500) })])
            diagnostic.startupState = facts?.startupState ?? null
            diagnostic.visibleAlert = facts?.visibleAlert ?? null
          } finally { clearTimeout(timer) }
        }
        receipt.startupDiagnostic = diagnostic
      } catch {
        receipt.startupDiagnostic = { stage, unavailable: true }
      } finally { await closeWindowsApplication(app) }
    }
    throw error
  }
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
  return JSON.parse(execFileSync(macMode ? 'python3' : 'python', ['-c', `import json,sqlite3,sys
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
  macStage('quit-start')
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__a11WindowCloseEvents = []
    const win = BrowserWindow.getAllWindows()[0]
    win?.on('close', event => globalThis.__a11WindowCloseEvents.push({ event: 'window-close', defaultPrevented: event.defaultPrevented }))
    win?.on('closed', () => globalThis.__a11WindowCloseEvents.push({ event: 'window-closed' }))
  })
  macStage('quit-main-observed')
  await page.evaluate(() => {
    globalThis.__a11CloseRequestCount = 0
    window.aiNovelAPI.on('window:close-requested', () => {
      globalThis.__a11CloseRequestCount += 1
    })
  })
  macStage('quit-renderer-observed')
  const started = Date.now()
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); return true })
  macStage('quit-requested')
  let timer
  const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 10_000) })])
  clearTimeout(timer)
  const diagnostic = { version, elapsedMs: Date.now() - started, result, events }
  if (!result) {
    diagnostic.window = await Promise.race([
      app.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows()
        const main = windows[0]
        return { events: globalThis.__a11WindowCloseEvents ?? [], count: windows.length,
          mainAlive: !!main && !main.isDestroyed(), mainVisible: !!main && main.isVisible(),
          webContentsAlive: !!main && !main.webContents.isDestroyed() }
      }).catch(() => ({ unavailable: true })),
      new Promise(resolve => setTimeout(() => resolve({ unavailable: true }), 1_000)),
    ])
    diagnostic.renderer = await Promise.race([
      page.evaluate(() => ({ closeRequestCount: globalThis.__a11CloseRequestCount ?? 0,
        approvalOrCancel: 'not-observed' })).catch(() => ({ unavailable: true })),
      new Promise(resolve => setTimeout(() => resolve({ unavailable: true }), 1_000)),
    ])
  }
  receipt.exitDiagnostics.push(diagnostic)
  if (!result) throw new Error('Electron did not exit')
  assert.deepEqual(result, { code: 0, signal: null })
  macStage('quit-complete')
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
    .map(key => [key, key === 'legacy' && legacyV025 && legacyHome ? path.resolve(legacyHome) : path.join(root, key)]))
  const globalBefore = legacyV025 && legacyHome ? inventory(legacyHome) : null
  for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true })
  let session
  let savedBody
  try {
    v025Stage('first-launch-start')
    session = await launch(roots)
    await home(session.page)
    v025Stage('first-launch-ready')
    let requestCounts = editSaveProof ? await observeRequests(session) : null
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
    v025Stage('import-start')
    await session.page.getByRole('button', { name: '导入旧项目副本' }).click()
    const target = path.join(targetParent, 's-新版副本')
    if (legacyV025) {
      const code = 'LEGACY_IMPORT_ROSTER_UNAVAILABLE'
      await session.page.locator('[role="status"]').filter({ hasText: code })
        .waitFor({ state: 'visible', timeout: 30_000 })
      const requests = await requestCounts()
      const stages = fs.readdirSync(targetParent).filter(name => name.startsWith(`.${path.basename(target)}.legacy-import-`))
      assert.equal(stages.length, 1, 'Expected one retained unpublished import staging attempt')
      assert(fs.statSync(path.join(targetParent, stages[0])).isDirectory())
      assert(!fs.existsSync(target), 'Rejected import published a target')
      const recent = await session.page.evaluate(() => window.aiNovelAPI.invoke('project:recent-list'))
      assert(!recent.some(entry => path.resolve(entry.path).toLowerCase() === path.resolve(target).toLowerCase()),
        'Rejected target entered recent projects')
      assert.equal(await session.page.locator('.writer-shelf').getByRole('button', { name: '打开《升级保留验证小说》' }).count(),
        recent.filter(entry => path.resolve(entry.path).toLowerCase() === path.resolve(source.path).toLowerCase()).length,
        'Rejected target entered shelf')
      assert.deepEqual(inventory(sourceCopy), copiedBefore, 'Scratch source changed on rejection')
      assert.deepEqual(inventory(source.path), originalBefore, 'Official source changed on rejection')
      assert.deepEqual(inventory(legacyHome), globalBefore, 'Old globals changed on rejection')
      receipt.copyImport = { revision: 'v025-roster-refusal-v2', expectedCode: code,
        source: source.path, importSource: sourceCopy, target, sourceFileCount: Object.keys(originalBefore).length,
        sourceInventorySha256: hashText(JSON.stringify(originalBefore)),
        sourceAfterSha256: hashText(JSON.stringify(inventory(source.path))),
        legacyGlobalsBeforeSha256: hashText(JSON.stringify(globalBefore)),
        legacyGlobalsAfterSha256: hashText(JSON.stringify(inventory(legacyHome))),
        sourceUnchanged: true, legacyGlobalsUnchanged: true, targetPublished: false,
        targetRecentRegistered: false, stagingRetained: true, modelRequests: requests }
      receipt.steps.push({ stepId: 'v0.2.5-roster-rejected', outcome: 'PASS', expectedCode: code,
        sourceUnchanged: true, legacyGlobalsUnchanged: true, targetPublished: false,
        targetRecentRegistered: false, stagingRetained: true, requests })
      await quit(session.app, session.page, source.version)
      session = null
      assert.deepEqual(inventory(source.path), originalBefore)
      assert.deepEqual(inventory(legacyHome), globalBefore)
      return
    }
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
    v025Stage('import-verified')
    if (editSaveProof) {
      v025Stage('save-start')
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
      v025Stage('save-verified')
      const requests = await requestCounts()
      receipt.steps.push({ stepId: `${source.version}-import-zero-network`, outcome: 'PASS',
        step: 'No main fetch or renderer HTTP request during V3 import and target save', requests })
    }
    v025Stage('first-quit-start')
    await quit(session.app, session.page, source.version)
    session = null
    v025Stage('first-quit-complete')

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

    v025Stage('reopen-start')
    session = await launch(roots)
    await home(session.page)
    v025Stage('reopen-ready')
    requestCounts = editSaveProof ? await observeRequests(session) : null
    if (legacyV025) {
      // Both the preserved old recent entry and the imported copy have the same title.
      const recent = await session.page.evaluate(() => window.aiNovelAPI.invoke('project:recent-list'))
      const index = recent.findIndex(entry => path.resolve(entry.path).toLowerCase() === path.resolve(target).toLowerCase())
      assert(index >= 0, 'Imported target missing from recent projects')
      await session.page.locator('.writer-shelf li').nth(index).getByRole('button', { name: '打开《升级保留验证小说》' }).click()
    } else await session.page.locator('.writer-shelf').getByRole('button', { name: '打开《升级保留验证小说》' }).click()
    await session.page.locator('.writer-project-tree').getByText('升级保留验证小说', { exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 })
    if (editSaveProof) {
      if (legacyV025) {
        const runtime = await session.page.evaluate(() => window.aiNovelAPI.invoke('project:get-runtime-context'))
        assert.equal(path.resolve(runtime.activeProjectPath).toLowerCase(), path.resolve(target).toLowerCase(), 'Reopened another recent project')
        assert.equal(runtime.dbReady, true)
      }
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
    v025Stage('reopen-ui-verified')
    if (legacyV025) {
      const sourceProjectId = JSON.parse(fs.readFileSync(path.join(sourceCopy, '.vela', 'project.json'), 'utf8')).projectId
      const targetProjectId = JSON.parse(fs.readFileSync(path.join(target, '.ai-novel', 'project.json'), 'utf8')).projectId
      assert.match(targetProjectId, /^[a-f0-9-]{36}$/i)
      assert.notEqual(targetProjectId, sourceProjectId)
      const globals = await session.page.evaluate(async () => ({
        recent: await window.aiNovelAPI.invoke('project:recent-list'),
        config: await window.aiNovelAPI.invoke('config:get'),
      }))
      assert(globals.recent.some(entry => path.resolve(entry.path).toLowerCase() === path.resolve(target).toLowerCase()), 'Imported copy absent from current recent projects')
      if (globalBefore) {
        assert.deepEqual(inventory(legacyHome), globalBefore, 'Old global settings or recent bytes changed')
        assert.equal(globals.config.theme, 'light')
        assert.equal(globals.config.locale, 'zh-CN')
        assert.equal(globals.config.proxy.port, 7890)
      }
      v025Stage('second-quit-start')
      await quit(session.app, session.page, source.version)
      session = null
      v025Stage('second-quit-complete')
      assert.deepEqual(inventory(source.path), originalBefore)
      assert.deepEqual(inventory(sourceCopy), copiedBefore)
      receipt.copyImport = { revision: 'v025-offline-copy-v1', sourceProjectId, targetProjectId,
        source: source.path, importSource: sourceCopy, target,
        sourceFileCount: Object.keys(originalBefore).length,
        sourceInventorySha256: hashText(JSON.stringify(originalBefore)),
        sourceAfterSha256: hashText(JSON.stringify(inventory(source.path))),
        targetInventorySha256: hashText(JSON.stringify(inventory(target))),
        savedBodySha256: hashText(savedBody), reopenedBodySha256: hashText(savedBody),
        sourceUnchanged: true, legacyGlobalsUnchanged: globalBefore ? true : null,
        targetRecentRegistered: true, settingsPreserved: globalBefore ? true : null,
        preservedTableCount: Object.values(counts).filter(value => typeof value === 'number' && value > 0).length,
        preservedAssetCount: Object.keys(rawAssets).length + avatarRows.length,
        knowledgeDocuments: knowledge.documents.length, knowledgeChunks: knowledge.chunks.length,
      }
    }
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
  } catch (error) {
    if (legacyV025) console.error(`[AI Novel A11] failure-stage=${receipt.lastStage}`)
    throw error
  } finally {
    if (session) {
      if (legacyV025) {
        v025Stage('cleanup-start')
        await closeWindowsApplication(session.app)
        v025Stage('cleanup-complete')
      } else await session.app.close()
    }
  }
}

function seedMac() {
  const fixtureRoot = officialFixtureRoot
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json'), 'utf8'))
  const entry = manifest.cases.find(item => `v${item.version}` === macVersion)
  assert.equal(manifest.kind, 's14c-official-old-app-synthetic-source')
  assert(entry, `Missing official old-app source: ${macVersion}`)
  const fixture = path.join(fixtureRoot, entry.directory)
  assert.deepEqual(inventory(fixture), entry.files, 'Official source fixture differs from reviewed manifest')
  const source = path.join(scratch, 'source')
  fs.cpSync(fixture, source, { recursive: true, errorOnExist: true, force: false })
  const files = inventory(source)
  assert.deepEqual(files, entry.files)
  const sourceProjectId = JSON.parse(fs.readFileSync(path.join(source, '.vela', 'project.json'), 'utf8')).projectId
  const databaseSnapshot = comparisonDatabase(source, scratch)
  const facts = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
tables=['project_core','contents','drafts','characters','blueprints','reviews','revisions','finalization_outbox']
rows={table:db.execute('select count(*) from '+table).fetchone()[0] for table in tables}
assert rows=={'project_core':1,'contents':4,'drafts':2,'characters':2,'blueprints':1,'reviews':1,'revisions':1,'finalization_outbox':1},rows
assert db.execute('select migration_state from character_roster_meta').fetchone()[0]=='ready'
assert db.execute('select count(*) from character_roster_operations').fetchone()[0]==1
llm=db.execute('select count(*) from llm_calls').fetchone()[0]
assert llm==0
body=db.execute('select c.body from drafts d join contents c on c.id=d.content_id where d.version=1').fetchone()[0]
print(json.dumps({'rows':rows,'llmCalls':llm,'body':body}))
db.close()`, databaseSnapshot], { encoding: 'utf8' }))
  assert.deepEqual(inventory(source), files, 'Official old-app source changed while reading facts')
  return { source, sourceProjectId, databaseSnapshot, files, inventorySha256: hashText(JSON.stringify(files)),
    proofSha256: entry.proofSha256, ...facts }
}

function inspectMacDatabases(snapshot, target) {
  const result = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `import json,sqlite3,sys
a=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
b=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True)
tables={'project_core':['id','project_name','characters_arch','core_outline','world_setting'],
 'blueprints':['chapter_number','title','key_events','characters'],
 'characters':['name','role','relationships'],
 'contents':['id','body'],'drafts':['id','chapter_number','version','content_id','word_count'],
 'reviews':['id','base_draft_id','content_id'],
 'revisions':['id','base_draft_id','content_id','merged_to_draft_id'],
 'finalization_outbox':['finalization_id','draft_id','content_hash','content_snapshot']}
rows={}
for table,columns in tables.items():
  query='select '+','.join(columns)+' from '+table+' order by rowid'
  source=list(a.execute(query)); target=list(b.execute(query))
  assert source==target,(table,source,target)
  rows[table]=len(source)
assert rows=={'project_core':1,'blueprints':1,'characters':2,'contents':4,'drafts':2,
 'reviews':1,'revisions':1,'finalization_outbox':1},rows
assert a.execute('select migration_state from character_roster_meta').fetchone()[0]=='ready'
assert b.execute('select migration_state from character_roster_meta').fetchone()[0]=='ready'
assert a.execute('select count(*) from character_roster_operations').fetchone()[0]==1
assert b.execute('select count(*) from character_roster_operations').fetchone()[0]==1
assert b.execute('pragma integrity_check').fetchone()[0]=='ok'
llm_calls=b.execute('select count(*) from llm_calls').fetchone()[0]
assert llm_calls==0,llm_calls
print(json.dumps({'rows':rows,'llmCalls':llm_calls}))
a.close(); b.close()`, snapshot, path.join(target, '.ai-novel', 'project.db')], { encoding: 'utf8' }))
  return result
}

function macLlmCalls(target) {
  return Number(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `import sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(db.execute('select count(*) from llm_calls').fetchone()[0])
db.close()`, path.join(target, '.ai-novel', 'project.db')], { encoding: 'utf8' }).trim())
}

async function verifyMac() {
  const rendererErrors = []
  const officialWindows = typeof winMode !== 'undefined' && winMode
  let session
  try {
    macStage('seed-start')
    const seeded = seedMac()
    const macBody = seeded.body
    const macSavedBody = `${macBody}\nA11 ${officialWindows ? 'windows' : 'mac'} 目标保存`
    macStage('seed-ready')
    const source = seeded.source
    const targetParent = path.join(scratch, 'target')
    fs.mkdirSync(targetParent)
    const target = path.join(targetParent, 'source-新版副本')
    const roots = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData']
      .map(key => [key, path.join(scratch, 'run', key)]))
    for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true })
    roots.officialWindows = officialWindows
    session = await launch(roots)
    if (nativePicker) session.page.on('console', message => {
      if (message.type() === 'error') {
        rendererErrors.push(message.text().slice(0, 500))
        if (rendererErrors.length > 10) rendererErrors.shift()
      }
    })
    macStage('home-start')
    await home(session.page)
    macStage('home-ready')
    let requestCounts = await observeRequests(session)
    await session.app.evaluate(({ dialog, ipcMain }, { source, targetParent, nativePicker }) => {
      globalThis.__a11Dialogs = []
      const originalDialog = dialog.showOpenDialog.bind(dialog)
      dialog.showOpenDialog = async options => {
        globalThis.__a11Dialogs.push({ type: 'open', title: options.title })
        if (nativePicker) return originalDialog(options)
        if (options.title === '选择旧版小说项目文件夹') return { canceled: false, filePaths: [source] }
        if (options.title === '选择恢复副本所在文件夹') return { canceled: false, filePaths: [targetParent] }
        throw new Error(`Unexpected dialog: ${options.title}`)
      }
      dialog.showMessageBox = async options => {
        globalThis.__a11Dialogs.push({ type: 'confirm', message: options.message })
        if (!options.message.includes('保存并关闭旧版程序')) throw new Error('Unexpected confirmation')
        return { response: 1, checkboxChecked: false }
      }
      if (nativePicker) {
        globalThis.__a11NativeCalls = []
        for (const channel of ['dialog:select-legacy-project', 'dialog:select-project-restore-target', 'project:import-legacy-copy']) {
          const original = ipcMain._invokeHandlers.get(channel)
          if (!original) throw new Error(`Missing IPC handler: ${channel}`)
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, async (event, ...args) => {
            const call = { channel, senderId: event.sender.id, args }
            globalThis.__a11NativeCalls.push(call)
            try {
              call.result = await original(event, ...args)
              return call.result
            } catch (error) { call.error = String(error); throw error }
          })
        }
      }
    }, { source, targetParent, nativePicker })
    macStage('import-start')
    if (nativePicker) receipt.nativePickerProcess = { playwrightProcessPid: session.app.process().pid,
      electronMainPid: await session.app.evaluate(() => process.pid) }
    await session.page.getByRole('button', { name: '导入旧项目副本' }).click()
    if (nativePicker) {
      chooseNativeDirectory('选择旧版小说项目文件夹', source, receipt.nativePickerProcess.electronMainPid)
      chooseNativeDirectory('选择恢复副本所在文件夹', targetParent, receipt.nativePickerProcess.electronMainPid)
    }
    await session.page.locator('.writer-project-tree').getByText('p', { exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 })
    assert(fs.existsSync(path.join(target, '.ai-novel', 'project.db')), 'No published target database')
    assert.deepEqual((await session.app.evaluate(() => globalThis.__a11Dialogs)).map(item => item.type), ['open', 'open', 'confirm'])
    assert.deepEqual(inventory(source), seeded.files, 'Official old-app source changed during import')
    const targetProjectId = JSON.parse(fs.readFileSync(path.join(target, '.ai-novel', 'project.json'), 'utf8')).projectId
    if (nativePicker) {
      receipt.nativeGrants = verifyNativeImportGrants(await session.app.evaluate(() => globalThis.__a11NativeCalls))
      assert.equal(receipt.nativeGrants.projectId, targetProjectId)
      assert.equal(fs.realpathSync.native(receipt.nativeGrants.targetRoot), fs.realpathSync.native(target))
    }
    assert.match(targetProjectId, /^[a-f0-9-]{36}$/i, 'Imported project has no new identity')
    assert.notEqual(targetProjectId, seeded.sourceProjectId, 'Imported project reused legacy identity')
    assert(!path.resolve(target).startsWith(`${path.resolve(source)}${path.sep}`), 'Target overlaps source')
    macStage('import-database-check')
    const database = inspectMacDatabases(seeded.databaseSnapshot, target)
    for (const name of Object.keys(seeded.files).filter(name => !name.startsWith('.vela/lancedb/')
      && !name.endsWith('.db') && !name.endsWith('.db-shm') && !name.endsWith('.db-wal')
      && name !== '.vela/project.json')) {
      const targetName = name.startsWith('.vela/') ? `.ai-novel/${name.slice(6)}` : name
      assert.equal(sha256(path.join(target, targetName)), seeded.files[name], `Author asset changed: ${name}`)
    }
    const sourceKnowledge = await knowledgeSnapshot(path.join(source, '.vela'))
    const targetKnowledge = await knowledgeSnapshot(path.join(target, '.ai-novel'))
    assert.equal(sourceKnowledge.documents.length, 1)
    assert.equal(sourceKnowledge.chunks.length, 1)
    assert.deepEqual(targetKnowledge.documents, sourceKnowledge.documents)
    assert.deepEqual(targetKnowledge.chunks, sourceKnowledge.chunks)
    receipt.steps.push({ stepId: `${macVersion}-import-open`, outcome: 'PASS' })
    macStage('import-verified')

    macStage('editor-open')
    const draftItem = session.page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).first()
    try {
      await draftItem.click()
    } catch (error) {
      try {
        const diagnostic = await draftItem.evaluate(target => {
          const rect = target.getBoundingClientRect()
          const x = rect.left + rect.width / 2
          const y = rect.top + rect.height / 2
          const path = []
          for (let node = document.elementFromPoint(x, y); node && path.length < 6; node = node.parentElement) {
            const style = getComputedStyle(node)
            path.push({ tag: node.tagName.toLowerCase(), role: node.getAttribute('role'),
              className: (typeof node.className === 'string' ? node.className : '').slice(0, 100),
              position: style.position, zIndex: style.zIndex, pointerEvents: style.pointerEvents })
          }
          const alertdialogs = [...document.querySelectorAll('[role="alertdialog"]')]
            .filter(node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility === 'visible')
            .map(node => ({ title: node.querySelector('#alert-title')?.textContent?.trim().slice(0, 120),
              body: node.querySelector('#alert-message')?.textContent?.trim().slice(0, 400) }))
          return { point: { x, y }, hitPath: path, alertdialogs }
        }, undefined, { timeout: 3_000 })
        console.error(`[AI Novel A11] editor-open-diagnostic=${JSON.stringify(diagnostic)}`)
      } catch (diagnosticError) {
        console.error('[AI Novel A11] editor-open-diagnostic-unavailable', diagnosticError)
      }
      throw error
    }
    const editor = session.page.locator('.cm-content[contenteditable="true"]')
    await editor.waitFor({ state: 'visible' })
    const openedBody = await editorBody(editor)
    assert.equal(openedBody.replaceAll('\r\n', '\n'), macBody.replaceAll('\r\n', '\n'))
    macStage('editor-edit')
    await editor.click()
    await session.page.keyboard.press('ControlOrMeta+A')
    await session.page.keyboard.insertText(macSavedBody)
    assert.equal(await editorBody(editor), macSavedBody)
    await session.page.locator('[role="status"]').filter({ hasText: /^未保存$/ }).last().waitFor({ state: 'visible' })
    macStage('save-start')
    if (officialWindows) await session.page.keyboard.press('Control+s')
    else await session.page.locator('button[title="保存（⌘S）"]').click()
    await session.page.locator('[role="status"]').filter({ hasText: /^已保存$/ }).last().waitFor({ state: 'visible' })
    assert(draftBodies(target).includes(macSavedBody), 'Edited target body was not saved')
    assert.equal(macLlmCalls(target), 0)
    assert.deepEqual(inventory(source), seeded.files)
    const importAndSaveRequests = await requestCounts()
    receipt.steps.push({ stepId: `${macVersion}-target-edit-save`, outcome: 'PASS' })
    macStage('save-verified')
    await quit(session.app, session.page, macVersion)
    session = null

    macStage('relaunch-start')
    session = await launch(roots)
    macStage('home-start')
    await home(session.page)
    macStage('home-ready')
    requestCounts = await observeRequests(session)
    macStage('reopen-start')
    await session.page.locator('.writer-shelf').getByRole('button', { name: '打开《p》' }).click()
    await session.page.locator('.writer-project-tree').getByText('p', { exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 })
    macStage('editor-open')
    await session.page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).first().click()
    const reopenedBody = await editorBody(session.page.locator('.cm-content[contenteditable="true"]'))
    assert.equal(reopenedBody, macSavedBody)
    assert(draftBodies(target).includes(macSavedBody))
    const reopenRequests = await requestCounts()
    assert.equal(macLlmCalls(target), 0)
    assert.deepEqual(inventory(source), seeded.files)
    receipt.steps.push({ stepId: `${macVersion}-target-edit-reopen`, outcome: 'PASS' })
    macStage('reopen-verified')
    receipt[officialWindows ? 'win' : 'mac'] = { sourceVersion: macVersion, officialProofSha256: seeded.proofSha256,
      sourceInventorySha256: seeded.inventorySha256,
      targetInventorySha256: hashText(JSON.stringify(inventory(target))), sourceProjectId: seeded.sourceProjectId,
      targetProjectId, database, knowledgeDocuments: sourceKnowledge.documents.length,
      knowledgeChunks: sourceKnowledge.chunks.length,
      sourceBodySha256: hashText(macBody), savedBodySha256: hashText(macSavedBody),
      reopenedBodySha256: hashText(reopenedBody), modelCallRows: macLlmCalls(target),
      importAndSaveRequests, reopenRequests }
  } catch (error) {
    receipt.failure = { message: String(error), stack: error?.stack }
    if (nativePicker && session) receipt.nativeFailureDiagnostic = { stage: receipt.lastStage, rendererErrors,
      ...await captureNativeImportFailure(session) }
    console.error(`[AI Novel A11] failure-stage=${receipt.lastStage}`, error)
    throw error
  } finally {
    if (session) {
      if (typeof winMode !== 'undefined' && winMode) await closeWindowsApplication(session.app)
      else await closeMacApplication(session.app)
    }
  }
}

if (macFixtureOnly) {
  const fixture = seedMac()
  console.log(JSON.stringify({ kind: 'official-old-app-mac-fixture', sourceVersion: macVersion,
    rows: fixture.rows, llmCalls: fixture.llmCalls, sourceInventorySha256: fixture.inventorySha256,
    officialProofSha256: fixture.proofSha256 }))
} else try {
  if (macMode || winMode) await verifyMac()
  else {
  for (const source of sources.filter(source => !onlyVersion || source.version === onlyVersion)) await verify(source)
  }
  receipt.outcome = 'PARTIAL'
  receipt.sliceOutcome = 'PASS'
} catch (error) {
  receipt.failure = { message: String(error), stack: error?.stack }
  console.error(error)
  process.exitCode = 1
} finally {
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ outcome: receipt.outcome, sliceOutcome: receipt.sliceOutcome,
    ...(macMode ? {} : { receiptPath }), receiptSha256: sha256(receiptPath), steps: receipt.steps.length }))
}
