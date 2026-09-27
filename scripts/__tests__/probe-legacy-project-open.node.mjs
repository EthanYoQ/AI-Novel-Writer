import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

const script = resolve('scripts/probe-legacy-project-open.mjs')
const fixtureRoot = resolve('.runtime/cache/s14c-old-binaries')
mkdirSync(join(fixtureRoot, 'v1.1.0'), { recursive: true })
const legacyExe = join(fixtureRoot, 'v1.1.0/unpacked-a11/app/AI小说作家.exe')
const hash = input => createHash('sha256').update(input).digest('hex')

test('roster proof refuses a project outside the isolated old-binary fixture', () => {
  const result = spawnSync(process.execPath, [script, '1', resolve('package.json'), join(fixtureRoot, 'v1.1.0/missing-proof.json'), '--roster-write-proof'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Roster proof requires an isolated old-binary fixture project/)
})

test('reopen proof refuses a missing prior save receipt before contacting the app', () => {
  const fixture = resolve('.runtime/cache/s14c-old-binaries/v1.1.0/roster-probe-test/project')
  const marker = resolve('.runtime/cache/s14c-old-binaries/v1.1.0/roster-probe-test/missing.json')
  const result = spawnSync(process.execPath, [script, '1', fixture, marker, '--roster-read-proof'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Roster reopen proof requires the prior save receipt/)
})

test('complete-source write rejects a receipt inside the project before CDP', () => {
  const root = mkdtempSync(join(fixtureRoot, 'complete-guard-test-'))
  try {
    const project = join(root, 'p')
    mkdirSync(project)
    const result = spawnSync(process.execPath, [script, '1', project, join(project, 'proof.json'), '--complete-source-write-proof'], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /proof receipt must be an isolated fixture file outside the project/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('complete-source reopen requires its own saved receipt before CDP', () => {
  const root = mkdtempSync(join(fixtureRoot, 'complete-reopen-test-'))
  try {
    const result = spawnSync(process.execPath, [script, '1', join(root, 'p'), join(root, 'missing.json'), '--complete-source-read-proof'], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /reopen proof requires the prior save receipt/i)
    const marker = join(root, 'roster.json')
    const rosterReceipt = JSON.stringify({ verifiedBy: 'legacy-renderer-cdp-roster-write', projectPath: join(root, 'p') })
    writeFileSync(marker, rosterReceipt)
    const wrongMode = spawnSync(process.execPath, [script, '1', join(root, 'p'), marker, '--complete-source-read-proof'], { encoding: 'utf8' })
    assert.notEqual(wrongMode.status, 0)
    assert.match(wrongMode.stderr, /requires the prior save receipt for this project/i)
    assert.equal(readFileSync(marker, 'utf8'), rosterReceipt)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('complete-source reopen rejects missing or changed published manuscript before CDP', () => {
  const root = mkdtempSync(join(fixtureRoot, 'complete-asset-test-'))
  try {
    const project = join(root, 'p')
    mkdirSync(project)
    const title = '作者蓝图'
    const revision = '作者修稿正文'
    const manuscript = `第1章 ${title}.txt`
    const contents = `第1章 ${title}\n\n${revision}`
    const file = join(project, manuscript)
    writeFileSync(file, contents)
    const body = { verifiedBy: 'legacy-renderer-cdp-complete-source-write', projectPath: project,
      process: { exited: true, portClosed: true }, completeSourceSeed: { blueprint: { title }, revision },
      sourceIdentity: { draftIds: [1, 2] }, completeSource: {},
      publishedManuscript: { path: manuscript, sha256: hash(contents) } }
    const marker = join(root, 'receipt.json')
    const receipt = JSON.stringify({ ...body, proofSha256: hash(JSON.stringify(body)) })
    writeFileSync(marker, receipt)
    for (const changed of ['tampered', null]) {
      if (changed === null) rmSync(file)
      else writeFileSync(file, changed)
      const result = spawnSync(process.execPath, [script, '1', project, marker, '--complete-source-read-proof'], { encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /complete source published manuscript differs/i)
      assert.equal(readFileSync(marker, 'utf8'), receipt)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('roster proof refuses outside, project-internal, and unrelated existing receipt paths before CDP', () => {
  const root = mkdtempSync(join(fixtureRoot, 'roster-guard-test-'))
  try {
    const project = join(root, 'project')
    const inside = join(project, 'receipt.json')
    mkdirSync(project)
    const alias = join(root, 'project-alias')
    symlinkSync(project, alias, 'junction')
    const unrelated = join(root, 'unrelated.json')
    writeFileSync(unrelated, 'keep this file')
    for (const marker of [resolve('package.json'), inside, unrelated]) {
      const before = existsSync(marker) ? readFileSync(marker) : null
      const result = spawnSync(process.execPath, [script, '1', project, marker, '--roster-write-proof'], {
        encoding: 'utf8', env: { ...process.env, AI_NOVEL_LEGACY_EXE_PATH: legacyExe },
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Roster proof receipt/)
      if (before) assert.deepEqual(readFileSync(marker), before)
    }
    const viaAlias = spawnSync(process.execPath, [script, '1', alias, inside, '--roster-write-proof'], {
      encoding: 'utf8', env: { ...process.env, AI_NOVEL_LEGACY_EXE_PATH: legacyExe },
    })
    assert.match(viaAlias.stderr, /Roster proof receipt/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('roster proof refuses a CDP port owned by a different process', { skip: process.platform !== 'win32' || !existsSync(legacyExe) }, async () => {
  const root = mkdtempSync(join(fixtureRoot, 'roster-process-test-'))
  const server = createServer()
  try {
    await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
    const port = server.address().port
    const result = spawnSync(process.execPath, [script, String(port), join(root, 'project'), join(root, 'receipt.json'), '--roster-write-proof'], {
      encoding: 'utf8', env: { ...process.env, AI_NOVEL_LEGACY_EXE_PATH: legacyExe }, timeout: 15_000,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Roster proof CDP listener is not the official legacy process/)
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('renderer reload in the same official process cannot count as a roster restart', { skip: process.platform !== 'win32' || !existsSync(legacyExe), timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(fixtureRoot, 't-'))
  writeFileSync(join(root, '.vibe-owner.json'), JSON.stringify({ owner: 'probe-legacy-project-open.node.mjs', sourceProject: resolve(),
    createdAt: new Date().toISOString(), ttlUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    reason: 'Isolated same-process reload fixture retained after a recursive cleanup approval block',
    cleanupCommand: 'Remove-Item -LiteralPath <this exact verified fixture path> -Recurse -Force' }))
  const userData = join(root, 'u')
  mkdirSync(userData)
  const project = join(root, 'p')
  const marker = join(root, 'proof.json')
  const reservation = createServer()
  await new Promise(resolvePromise => reservation.listen(0, '127.0.0.1', resolvePromise))
  const port = reservation.address().port
  await new Promise(resolvePromise => reservation.close(resolvePromise))
  const child = spawn(legacyExe, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, AI_NOVEL_VELA_HOME: join(root, 'h'), APPDATA: join(root, 'a'), LOCALAPPDATA: join(root, 'l') },
  })
  try {
    let target
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        target = (await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())).find(page => page.type === 'page')
        if (target) break
      } catch { /* still starting */ }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    assert.ok(target, 'official renderer CDP page must start')
    const cdp = async (method, params = {}) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl)
      await new Promise(resolvePromise => socket.addEventListener('open', resolvePromise, { once: true }))
      const response = await new Promise(resolvePromise => {
        socket.addEventListener('message', event => {
          const message = JSON.parse(String(event.data))
          if (message.id === 1) resolvePromise(message)
        })
        socket.send(JSON.stringify({ id: 1, method, params }))
      })
      socket.close()
      return response
    }
    const before = (await cdp('Runtime.evaluate', { expression: 'performance.timeOrigin', returnByValue: true })).result.result.value
    await cdp('Page.reload')
    let after = before
    for (let attempt = 0; attempt < 50 && after === before; attempt++) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
      try { after = (await cdp('Runtime.evaluate', { expression: 'performance.timeOrigin', returnByValue: true })).result.result.value } catch { /* reloading */ }
    }
    assert.notEqual(after, before, 'renderer time origin must change without a process restart')
    const body = { verifiedBy: 'legacy-renderer-cdp-roster-write', projectPath: project,
      package: { version: '1.1.0', executableSha256: hash(readFileSync(legacyExe)), asarSha256: hash(readFileSync(join(dirname(legacyExe), 'resources/app.asar'))) },
      process: { pid: child.pid, exited: true, portClosed: true, executablePath: legacyExe, userDataPath: userData } }
    writeFileSync(marker, JSON.stringify({ ...body, proofSha256: hash(JSON.stringify(body)) }))
    const result = spawnSync(process.execPath, [script, String(port), project, marker, '--roster-read-proof'], {
      encoding: 'utf8', env: { ...process.env, AI_NOVEL_LEGACY_EXE_PATH: legacyExe }, timeout: 15_000,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Roster reopen requires a new official process/)
  } finally {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }
})
