/* eslint-env node */

import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, fstatSync, ftruncateSync, lstatSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , portText, projectPath, markerPath, mode] = process.argv
const port = Number(portText)
if (!Number.isInteger(port) || !projectPath || !markerPath || (mode && !['--draft-write-proof', '--v025-save-proof', '--roster-write-proof', '--roster-read-proof'].includes(mode))) {
  throw new Error('Usage: node probe-legacy-project-open.mjs <port> <projectPath> <markerPath> [--draft-write-proof|--v025-save-proof|--roster-write-proof|--roster-read-proof]')
}
const writeProof = mode === '--draft-write-proof'
const v025SaveProof = mode === '--v025-save-proof'
const rosterWriteProof = mode === '--roster-write-proof'
const rosterReadProof = mode === '--roster-read-proof'
const rosterProof = rosterWriteProof || rosterReadProof
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'cache', 's14c-old-binaries')
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const textHash = text => createHash('sha256').update(text).digest('hex')
const within = (root, candidate) => {
  const child = relative(root, candidate)
  return child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}
let priorRosterProof
let packageProof
let markerStat
let processProof
const windowsProcess = script => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ProgressPreference='SilentlyContinue'; ${script}`, 'utf16le').toString('base64')], { encoding: 'utf8' }).trim() || 'null')
const listener = () => {
  const rows = windowsProcess(`$listeners = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' }); if ($listeners.Count -eq 1) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($listeners[0].OwningProcess)"; if ($p) { [pscustomobject]@{ pid=$p.ProcessId; executablePath=$p.ExecutablePath; commandLine=$p.CommandLine; startedAt=$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress } }`)
  return rows
}
const processAlive = pid => windowsProcess(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.ProcessId | ConvertTo-Json -Compress }`)
const samePath = (a, b) => typeof a === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase()
if (rosterProof) {
  const marker = resolve(markerPath)
  const parent = dirname(marker)
  const canonicalFixture = realpathSync(fixtureRoot)
  const actualProject = existsSync(projectPath) ? realpathSync(projectPath) : resolve(projectPath)
  if (rosterReadProof && !existsSync(marker)) throw new Error('Roster reopen proof requires the prior save receipt')
  if (!existsSync(parent) || !within(canonicalFixture, parent) || !samePath(realpathSync(parent), parent)
    || !within(canonicalFixture, marker) || samePath(marker, actualProject) || within(actualProject, marker)) {
    throw new Error('Roster proof receipt must be an isolated fixture file outside the project')
  }
  if (existsSync(marker)) {
    markerStat = lstatSync(marker)
    if (!rosterReadProof || !markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1) {
      throw new Error('Roster proof receipt already exists or is not a regular proof file')
    }
  }
  if (rosterReadProof) {
    priorRosterProof = JSON.parse(readFileSync(markerPath, 'utf8'))
    const { proofSha256, ...priorBody } = priorRosterProof
    if (priorRosterProof.verifiedBy !== 'legacy-renderer-cdp-roster-write'
      || priorRosterProof.process?.exited !== true || priorRosterProof.process?.portClosed !== true
      || proofSha256 !== textHash(JSON.stringify(priorBody))
      || resolve(priorRosterProof.projectPath) !== resolve(projectPath)) {
      throw new Error('Roster reopen proof requires the prior save receipt for this project')
    }
    delete priorRosterProof.proofSha256
  }
  const projectParent = realpathSync(dirname(resolve(projectPath)))
  if (!within(realpathSync(fixtureRoot), projectParent) || (existsSync(projectPath)
    && !within(realpathSync(fixtureRoot), realpathSync(projectPath)))) {
    throw new Error('Roster proof requires an isolated old-binary fixture project')
  }
  const exePath = process.env.AI_NOVEL_LEGACY_EXE_PATH
  if (!exePath || !existsSync(exePath) || !within(realpathSync(fixtureRoot), realpathSync(exePath))) {
    throw new Error('Roster proof requires an isolated official legacy executable')
  }
  const exeSha256 = sha256(exePath)
  const asarPath = join(dirname(exePath), 'resources', 'app.asar')
  const asarSha256 = sha256(asarPath)
  const official = {
    '2b2b93e5b0e06946715b3524e9dbd5277f3a0eb95f4009de6c16dc81609f951b': ['1.0.0', '746e621074f40ac983e2feb343c82e491da064722145670a2221279387503236'],
    '6c17e1fcc62d235feb7f5bdba5b0f355b198c5322b2f67d922874857e27f564a': ['1.1.0', '447bb76357422adc2ca967b667bfe60c3419b1ca7ea22a0d2d08105ed398a679'],
  }[exeSha256]
  if (!official || official[1] !== asarSha256 || !relative(fixtureRoot, exePath).split(sep).includes(`v${official[0]}`)) {
    throw new Error('Roster proof executable/ASAR is not the fixed official v1.0.0/v1.1.0 package')
  }
  packageProof = { version: official[0], executableSha256: exeSha256, asarSha256 }
  if (priorRosterProof && JSON.stringify(priorRosterProof.package) !== JSON.stringify(packageProof)) {
    throw new Error('Roster reopen proof package differs from the save package')
  }
  if (process.platform !== 'win32') throw new Error('Roster proof process binding requires Windows')
  const owner = listener()
  const command = owner?.commandLine || ''
  const userData = command.match(/"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=(\S+)/i)?.slice(1).find(Boolean)
  if (!owner?.pid || !samePath(owner.executablePath, realpathSync(exePath))
    || !new RegExp(`(?:^|\\s)"?--remote-debugging-port=${port}(?:"|\\s|$)`).test(command)
    || !userData || !existsSync(userData) || !within(realpathSync(fixtureRoot), realpathSync(userData))
    || samePath(userData, projectPath) || within(resolve(projectPath), resolve(userData))) {
    throw new Error('Roster proof CDP listener is not the official legacy process with isolated userData')
  }
  processProof = { pid: owner.pid, startedAt: owner.startedAt, executablePath: realpathSync(owner.executablePath), commandLine: command,
    userDataPath: realpathSync(userData), cdpPort: port }
  if (rosterReadProof && (owner.pid === priorRosterProof.process.pid
    || !samePath(processProof.executablePath, priorRosterProof.process.executablePath)
    || !samePath(processProof.userDataPath, priorRosterProof.process.userDataPath))) {
    throw new Error('Roster reopen requires a new official process with the same isolated userData')
  }
}
if (v025SaveProof) {
  const cacheRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.runtime', '.cache')
  const child = relative(cacheRoot, resolve(projectPath))
  if (isAbsolute(child) || !/^ai-novel-installer-smoke-[a-f0-9]+[\\/]/.test(child)) {
    throw new Error('v0.2.5 save proof requires an isolated installer fixture')
  }
}
if (writeProof) {
  const child = relative(fixtureRoot, resolve(projectPath))
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Draft writer proof requires an isolated old-binary fixture project')
  }
}

const deadline = Date.now() + 20_000
let page
while (Date.now() < deadline) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
    page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl)
    if (page) break
  } catch {
    // The legacy Electron debugger endpoint may not be ready yet.
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
}
if (!page) throw new Error('Legacy Electron DevTools endpoint did not expose a renderer page')
if (rosterProof) {
  const current = listener()
  if (current?.pid !== processProof.pid || current.startedAt !== processProof.startedAt) throw new Error('Roster proof CDP listener changed before renderer connection')
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolvePromise, rejectPromise) => {
  const timer = setTimeout(() => rejectPromise(new Error('Timed out connecting to legacy renderer')), 10_000)
  socket.addEventListener('open', () => {
    clearTimeout(timer)
    resolvePromise()
  }, { once: true })
  socket.addEventListener('error', () => {
    clearTimeout(timer)
    rejectPromise(new Error('Could not connect to legacy renderer'))
  }, { once: true })
})

const draftContent = writeProof ? `A11_OLD_WRITER_${randomUUID()}` : null
const globalProof = process.env.AI_NOVEL_V110_GLOBAL_PROOF === '1'
const globalRead = globalProof ? `
  const config = await window.velaAPI.invoke('config:get')
  if (config?.theme !== 'light' || config.locale !== 'zh-CN' || config.proxy?.port !== 7890) {
    throw new Error('legacy config:get did not read the v1.1 global seed')
  }
  const recent = await window.velaAPI.invoke('project:recent-list')
  if (!Array.isArray(recent) || recent.length !== 1
      || recent[0]?.path !== ${JSON.stringify(resolve(projectPath))}
      || recent[0]?.name !== '升级保留验证小说') {
    throw new Error('legacy project:recent-list did not read the v1.1 recent seed')
  }
` : ''
const draftWrite = writeProof ? `
  if (result.project.path !== ${JSON.stringify(resolve(projectPath))}) {
    throw new Error('legacy project:open returned another project before draft write')
  }
  const context = { projectId: result.project.id, projectPath: result.project.path,
    leaseId: result.project.sessionLease }
  if (!context.projectId || !context.leaseId) throw new Error('legacy project:open did not return a session lease')
  const content = ${JSON.stringify(draftContent)}
  const created = await window.velaAPI.invoke('db:draft-create',
    { chapterNumber: 43, version: 1, source: 'write', content, wordCount: content.length },
    ${JSON.stringify(resolve(projectPath))}, context)
  if (!created || !created.success || !Number.isInteger(created.id)) {
    throw new Error(created && created.error ? created.error : 'legacy draft-create failed')
  }
  const readBack = await window.velaAPI.invoke('db:draft-get-full', created.id, ${JSON.stringify(resolve(projectPath))}, context)
  if (!readBack || readBack.id !== created.id || readBack.content !== content) {
    throw new Error('legacy draft read-back differs from the committed content')
  }
  return { projectPath: result.project.path, projectName: result.project.name,
    draft: { id: created.id, chapterNumber: 43, content, readBackContent: readBack.content } }
` : ''
const rosterNames = rosterWriteProof ? [`S14C作者甲_${randomUUID()}`, `S14C作者乙_${randomUUID()}`] : priorRosterProof?.rosterNames
const rosterRelation = '作者明确设定的旧版搭档'
const rosterCreate = rosterWriteProof && !existsSync(projectPath) ? `
  const created = await window.velaAPI.invoke('project:create', {
    path: ${JSON.stringify(dirname(resolve(projectPath)))}, name: ${JSON.stringify(basename(resolve(projectPath)))},
    genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN'
  })
  if (!created?.success || created.projectPath !== ${JSON.stringify(resolve(projectPath))}) {
    throw new Error(created?.error || 'legacy project:create did not create the isolated source')
  }
` : ''
const rosterWrite = rosterWriteProof ? `
  const context = { projectId: result.project.id, projectPath: result.project.path,
    leaseId: result.project.sessionLease }
  if (!context.projectId || !context.leaseId) throw new Error('legacy project:open did not return a roster session lease')
  const before = await window.velaAPI.invoke('db:character-roster-read', result.project.path, context)
  if (!before || !Array.isArray(before.entries) || before.entries.length !== 0 || before.status !== 'empty') {
    throw new Error('legacy roster source is not empty; refusing to overwrite existing cards')
  }
  const names = ${JSON.stringify(rosterNames)}
  const blank = { gender: '', age: '', appearance: '', personality: '', background: '',
    abilities: '', motivation: '', arc: '', notes: '' }
  const operationId = ${JSON.stringify(randomUUID())}
  const saved = await window.velaAPI.invoke('db:character-roster-commit', {
    operationId, expectedRevision: before.revision, schemaVersion: 1, intent: 'manual_edit',
    entries: [
      { ...blank, name: names[0], role: 'protagonist', relationships: [{ target: names[1], relation: ${JSON.stringify(rosterRelation)} }] },
      { ...blank, name: names[1], role: 'supporting', relationships: [] },
    ],
  }, result.project.path, context)
  if (saved?.success !== true || saved.receipt?.operationId !== operationId || saved.receipt.idempotent !== false) {
    throw new Error(saved?.error || 'legacy roster manual_edit did not return a fresh save receipt')
  }
  const after = await window.velaAPI.invoke('db:character-roster-read', result.project.path, context)
  if (after?.status !== 'ready' || !Array.isArray(after.entries) || after.entries.length !== 2
      || !names.every(name => after.entries.some(entry => entry.name === name))
      || !after.entries.find(entry => entry.name === names[0])?.relationships?.some(relation =>
        relation.target === names[1] && relation.relation === ${JSON.stringify(rosterRelation)})) {
    throw new Error('legacy roster immediate read-back differs from the saved cards and relation')
  }
  return { projectPath: result.project.path, projectName: result.project.name,
    rendererTimeOrigin: performance.timeOrigin, rosterNames: names,
    rosterRelation: ${JSON.stringify(rosterRelation)}, saveReceipt: {
      operationId: saved.receipt.operationId, payloadHash: saved.receipt.payloadHash,
      revision: saved.receipt.revision, idempotent: saved.receipt.idempotent,
    }, savedRoster: { revision: after.revision, factHash: after.factHash, entries: after.entries } }
` : ''
const rosterRead = rosterReadProof ? `
  const context = { projectId: result.project.id, projectPath: result.project.path,
    leaseId: result.project.sessionLease }
  if (!context.projectId || !context.leaseId) throw new Error('legacy project:open did not return a roster session lease')
  const names = ${JSON.stringify(rosterNames)}
  const after = await window.velaAPI.invoke('db:character-roster-read', result.project.path, context)
  if (after?.status !== 'ready' || !Array.isArray(after.entries) || after.entries.length !== 2
      || !names.every(name => after.entries.some(entry => entry.name === name))
      || !after.entries.find(entry => entry.name === names[0])?.relationships?.some(relation =>
        relation.target === names[1] && relation.relation === ${JSON.stringify(priorRosterProof.rosterRelation)})) {
    throw new Error('legacy roster reopen read-back differs from the saved cards and relation')
  }
  return { projectPath: result.project.path, projectName: result.project.name,
    rendererTimeOrigin: performance.timeOrigin,
    reopenedRoster: { revision: after.revision, factHash: after.factHash, entries: after.entries } }
` : ''
const expression = `(async () => {
  if (!window.velaAPI || typeof window.velaAPI.invoke !== 'function') {
    throw new Error('legacy preload API is unavailable')
  }
  ${globalRead}
  ${rosterCreate}
  const result = await window.velaAPI.invoke('project:open', ${JSON.stringify(resolve(projectPath))})
  if (!result || !result.success || !result.project) {
    throw new Error(result && result.error ? result.error : 'legacy project:open failed')
  }
  ${draftWrite}
  ${rosterWrite}
  ${rosterRead}
  ${v025SaveProof ? `
  const before = await window.velaAPI.invoke('db:draft-get-full', 71)
  if (before?.id !== 71 || before.status !== 'draft' || before.chapterNumber !== 7 || before.version !== 1) {
    throw new Error('v0.2.5 editable fixture draft is missing')
  }
  const saved = await window.velaAPI.invoke('db:draft-update-content', before.id, before.content, before.wordCount)
  if (saved?.success !== true) throw new Error('v0.2.5 draft save failed')
  const after = await window.velaAPI.invoke('db:draft-get-full', before.id)
  if (JSON.stringify({ ...after, updatedAt: before.updatedAt }) !== JSON.stringify(before)
      || after.updatedAt === before.updatedAt) throw new Error('v0.2.5 saved draft read-back differs')
  return { projectPath: result.project.path, projectName: result.project.name, draft: { before, after } }
  ` : ''}
  return { projectPath: result.project.path, projectName: result.project.name${globalProof ? ', globalSeedRead: true' : ''} }
})()`

const response = await new Promise((resolvePromise, rejectPromise) => {
  const requestId = 1
  const timer = setTimeout(() => rejectPromise(new Error('Legacy project:open IPC timed out')), 20_000)
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id !== requestId) return
    clearTimeout(timer)
    resolvePromise(message)
  })
  socket.send(JSON.stringify({
    id: requestId,
    method: 'Runtime.evaluate',
    params: {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
  }))
})
socket.close()

if (response.error) throw new Error(response.error.message || 'Legacy renderer evaluation failed')
if (response.result?.exceptionDetails) {
  throw new Error(response.result.exceptionDetails.exception?.description || 'Legacy project:open threw')
}
const proof = response.result?.result?.value
if (!proof?.projectPath || resolve(proof.projectPath) !== resolve(projectPath)) {
  throw new Error('Legacy application opened a different project than requested')
}
if (globalProof && proof.globalSeedRead !== true) {
  throw new Error('Legacy application did not confirm the v1.1 global seed')
}
if (writeProof && (!Number.isInteger(proof.draft?.id) || proof.draft.content !== draftContent
  || proof.draft.readBackContent !== draftContent)) {
  throw new Error('Legacy application did not return exact draft write/read proof')
}
if (rosterWriteProof && (!Array.isArray(proof.rosterNames) || proof.rosterNames.length !== 2
  || !proof.saveReceipt?.operationId || proof.savedRoster?.entries?.length !== 2)) {
  throw new Error('Legacy application did not return exact roster save proof')
}
if (rosterReadProof && (proof.rendererTimeOrigin === priorRosterProof.rendererTimeOrigin
  || proof.reopenedRoster?.factHash !== priorRosterProof.savedRoster?.factHash
  || JSON.stringify(proof.reopenedRoster?.entries) !== JSON.stringify(priorRosterProof.savedRoster?.entries))) {
  throw new Error('Legacy roster reopen did not prove a fresh renderer and identical saved facts')
}
if (rosterProof) {
  const current = listener()
  if (current?.pid !== processProof.pid || current.startedAt !== processProof.startedAt) throw new Error('Roster proof CDP listener changed during renderer evaluation')
}

function sourceHashes(root) {
  const database = join(root, '.vela', 'vela.db')
  if (!existsSync(database)) throw new Error('Legacy source database is missing')
  const files = []
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Legacy source asset symlink is not allowed')
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && !/^vela\.db(?:-wal|-shm)?$/.test(entry.name)) {
        files.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: sha256(path) })
      }
    }
  }
  walk(root)
  files.sort((a, b) => a.path.localeCompare(b.path))
  const wal = `${database}-wal`
  return {
    databaseSha256: sha256(database),
    ...(existsSync(wal) ? { walSha256: sha256(wal) } : {}),
    assetManifestSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    assets: files,
  }
}

if (rosterWriteProof) {
  const current = listener()
  if (current?.pid !== processProof.pid || current.startedAt !== processProof.startedAt) throw new Error('Roster save process changed before close')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`Stop-Process -Id ${processProof.pid} -Force -ErrorAction Stop`, 'utf16le').toString('base64')])
  const exitDeadline = Date.now() + 10_000
  while (Date.now() < exitDeadline && (processAlive(processProof.pid) || listener())) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  if (processAlive(processProof.pid) || listener()) throw new Error('Roster save process or CDP port remained open')
  processProof.exited = true
  processProof.portClosed = true
}
const receiptBody = {
  ...(rosterReadProof ? {
    ...priorRosterProof,
    reopened: { ...proof, process: processProof, source: sourceHashes(resolve(projectPath)) },
  } : {
    ...proof,
    ...(rosterProof ? { package: packageProof, process: processProof, source: sourceHashes(resolve(projectPath)) } : {}),
  }),
  verifiedBy: rosterWriteProof ? 'legacy-renderer-cdp-roster-write'
    : rosterReadProof ? 'legacy-renderer-cdp-roster-reopen'
      : v025SaveProof ? 'legacy-renderer-cdp-v025-save' : writeProof ? 'legacy-renderer-cdp-draft-write' : 'legacy-renderer-cdp-project-open',
  verifiedAt: new Date().toISOString(),
  ...(rosterProof ? { probeSha256: sha256(fileURLToPath(import.meta.url)) } : {}),
}
const receipt = `${JSON.stringify({ ...receiptBody, ...(rosterProof ? { proofSha256: textHash(JSON.stringify(receiptBody)) } : {}) }, null, 2)}\n`
if (rosterReadProof) {
  const handle = openSync(markerPath, 'r+')
  try {
    const current = fstatSync(handle)
    if (current.dev !== markerStat.dev || current.ino !== markerStat.ino || !current.isFile() || current.nlink !== 1) {
      throw new Error('Roster proof receipt changed before read-back update')
    }
    ftruncateSync(handle, 0)
    writeFileSync(handle, receipt, 'utf8')
  } finally { closeSync(handle) }
} else {
  writeFileSync(markerPath, receipt, rosterWriteProof ? { encoding: 'utf8', flag: 'wx' } : 'utf8')
}
