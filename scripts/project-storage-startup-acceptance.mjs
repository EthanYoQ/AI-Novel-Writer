/* global process */
import assert from 'node:assert/strict'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runId = randomUUID()
const root = path.join(repository, '.runtime/.cache/s04-electron', runId)
const scratchRoot = path.join(process.env.LOCALAPPDATA ?? path.dirname(repository), 'VibeCodingScratch', 'an', 'b01', runId.slice(0, 8))
const profile = (name, shortName) => Object.fromEntries([
  'legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData', 'projects',
].map(directory => [directory, path.join(scratchRoot, shortName, directory)]).concat([
  ['name', name], ['root', path.join(scratchRoot, shortName)], ['evidenceRoot', path.join(root, name)],
  ['chromiumLog', path.join(root, name, 'chromium.log')],
]))
const profiles = { A: profile('profile-a', 'a'), B: profile('profile-b', 'b') }
const archiveDirectory = path.join(scratchRoot, 'x')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function inventory(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const file = path.join(entry.parentPath, entry.name)
    return [path.relative(directory, file), hash(fs.readFileSync(file))]
  }).sort(([left], [right]) => left.localeCompare(right)))
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
    const pid = /pid=(\d+)/.exec(error instanceof Error ? error.message : '')?.[1] ?? null
    fs.writeFileSync(path.join(profile.evidenceRoot, 'electron-launch-failure.json'), JSON.stringify({
      profile: profile.name, cacheRoot: profile.root, chromiumLog: profile.chromiumLog,
      pid: pid === null ? null : Number(pid), exitCode: null, exitCodeHex: null, signal: null,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2))
    throw error
  }
  const child = app.process()
  child?.once('exit', (code, signal) => writeProcessEvidence(profile, child, code, signal))
  let page
  try {
    page = await app.firstWindow({ timeout: 30_000 })
    const electronPaths = await app.evaluate(({ app }) => ({
      homeEnv: process.env.HOME, userProfileEnv: process.env.USERPROFILE,
      appDataEnv: process.env.APPDATA, localAppDataEnv: process.env.LOCALAPPDATA,
      userData: app.getPath('userData'), logs: app.getPath('logs'),
    }))
    assert.equal(path.resolve(electronPaths.homeEnv), profile.home)
    assert.equal(path.resolve(electronPaths.userProfileEnv), profile.home)
    assert.equal(path.resolve(electronPaths.appDataEnv), profile.appData)
    assert.equal(path.resolve(electronPaths.localAppDataEnv), profile.localAppData)
    assert.equal(path.resolve(electronPaths.userData), profile.userData)
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    return { app, page, electronPaths }
  } catch (error) {
    const diagnostic = {
      profile: profile.name,
      state: page ? await invoke(page, 'startup:get-state').catch(() => null) : null,
      body: page ? await page.locator('body').innerText().catch(() => '') : '',
      process: writeProcessEvidence(profile, child),
    }
    fs.writeFileSync(path.join(profile.evidenceRoot, `startup-failure-${randomUUID()}.json`), JSON.stringify(diagnostic, null, 2))
    await app.close()
    throw error
  }
}

async function invoke(page, channel, ...args) {
  return page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
}

function assertProfilesAreIsolated() {
  for (const name of ['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData']) {
    assert.notEqual(profiles.A[name], profiles.B[name], `${name} root must differ by profile`)
    assert.equal(path.dirname(profiles.A[name]), profiles.A.root)
    assert.equal(path.dirname(profiles.B[name]), profiles.B.root)
  }
}

if (process.argv.includes('--help')) {
  process.stdout.write('Run: pnpm build; pnpm run rebuild:electron; node scripts/project-storage-startup-acceptance.mjs. Keep rebuild:electron immediately before this real Electron check. Uses only synthetic isolated roots; no provider requests.\n')
} else {
  for (const current of Object.values(profiles)) {
    fs.mkdirSync(current.evidenceRoot, { recursive: true })
    for (const name of ['legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']) fs.mkdirSync(current[name], { recursive: true })
  }
  fs.mkdirSync(archiveDirectory, { recursive: true })
  fs.writeFileSync(path.join(scratchRoot, '.vibe-owner.json'), JSON.stringify({
    owner: 'AI Novel Program v3 B01 acceptance',
    sourceProject: repository,
    createdAt: new Date().toISOString(),
    ttlHours: 48,
    cleanupCommand: `Remove-Item -LiteralPath '${scratchRoot.replaceAll("'", "''")}' -Recurse -Force`,
  }, null, 2))
  assertProfilesAreIsolated()
  const results = []
  const invokedChannels = new Set()
  const call = async (page, channel, ...args) => {
    invokedChannels.add(channel)
    return invoke(page, channel, ...args)
  }
  // 渲染进程只能携带选择器签发的授权标识。这里只在主进程桩住 Electron 原生对话框（用后还原），
  // 让生产 chooser IPC 照常签发授权：不绕过授权服务，也不向渲染进程暴露任何路径。
  const chooseGrant = async (session, channel, args, method, dialogResult) => {
    await session.app.evaluate(({ dialog }, { method, dialogResult }) => {
      globalThis.__chooserOriginal = dialog[method]
      dialog[method] = async () => dialogResult
    }, { method, dialogResult })
    try {
      const grant = await call(session.page, channel, ...args)
      assert.equal(typeof grant?.grantId, 'string', `${channel} did not issue a grant`)
      return grant
    } finally {
      await session.app.evaluate(({ dialog }, method) => { dialog[method] = globalThis.__chooserOriginal }, method)
    }
  }
  try {
    const authorBody = '合成作者正文。\r\nLiteral C:\\fiction\\notes stays prose.'
    const authorBodySha256 = hash(Buffer.from(authorBody))
    const archivePath = path.join(archiveDirectory, 'canonical-fixture.ainovel')
    let sourceProjectPath, sourceProjectId, sourceInventory, exportReceipt

    let session = await launch(profiles.A)
    try {
      const created = await call(session.page, 'project:create', {
        parentGrantId: (await chooseProjectDirectoryGrant(session.app, session.page, profiles.A.projects)).grantId, name: 'A', genre: '合成测试', targetAudience: 'fixture', writingLanguage: 'zh-CN',
      }, randomUUID(), null)
      assert.equal(created.success, true, created.error)
      sourceProjectPath = created.projectPath
      sourceProjectId = created.projectId
      assert.equal(path.dirname(sourceProjectPath), profiles.A.projects)
      assert.equal(fs.existsSync(path.join(sourceProjectPath, '.ai-novel/project.db')), true)
      assert.equal(fs.existsSync(path.join(sourceProjectPath, '.vela')), false)

      const opened = await call(session.page, 'project:open', sourceProjectPath, randomUUID(), null)
      assert.equal(opened.success, true, opened.error)
      const sourceSession = { projectId: sourceProjectId, projectPath: sourceProjectPath, leaseId: opened.project.sessionLease }
      const draft = await call(session.page, 'db:draft-create', {
        chapterNumber: 1, version: 1, source: 'write', content: authorBody, wordCount: authorBody.length,
      }, sourceProjectPath, sourceSession)
      assert.equal(draft.success, true, draft.error)
      assert.equal((await call(session.page, 'db:draft-get-full', draft.id, sourceProjectPath, sourceSession)).content, authorBody)

      sourceInventory = inventory(sourceProjectPath)
      const exportGrant = await chooseGrant(session, 'dialog:select-project-archive-export', ['canonical-fixture'], 'showSaveDialog',
        { canceled: false, filePath: archivePath })
      assert.equal(exportGrant.displayName, path.basename(archivePath))
      const exported = await call(session.page, 'project:archive-export', {
        targetArchiveGrantId: exportGrant.grantId,
        projectSession: sourceSession,
      })
      assert.equal(exported.success, true, exported.error)
      exportReceipt = exported.receipt
      assert.equal(exportReceipt.originProjectId, sourceProjectId)
      assert.equal(exportReceipt.targetSha256, hash(fs.readFileSync(archivePath)))
      assert.deepEqual(inventory(sourceProjectPath), sourceInventory)
      results.push({ name: 'profile-a-create-open-author-body-export', outcome: 'PASS', sourceInventoryUnchanged: true, authorBodySha256 })
    } finally { await session.app.close() }
    sourceInventory = inventory(sourceProjectPath)

    session = await launch(profiles.B)
    let restoredProjectPath, restoreReceipt
    try {
      assert.deepEqual(await call(session.page, 'project:get-runtime-context'), { activeProjectPath: null, dbReady: true })
      const chooseArchive = () => chooseGrant(session, 'dialog:select-project-archive', [], 'showOpenDialog',
        { canceled: false, filePaths: [archivePath] })
      const chooseRestoreTarget = suggestedName => chooseGrant(session, 'dialog:select-project-restore-target', [suggestedName],
        'showOpenDialog', { canceled: false, filePaths: [profiles.B.projects] })
      // 选择器只会给出尚不存在的子项；目标在授权之后、恢复之前被占用，正是 no-clobber 必须拦住的竞争。
      const collisionGrant = await chooseRestoreTarget('existing-target')
      assert.equal(collisionGrant.displayName, 'existing-target')
      const collisionTarget = path.join(profiles.B.projects, collisionGrant.displayName)
      fs.mkdirSync(collisionTarget)
      fs.writeFileSync(path.join(collisionTarget, 'sentinel.txt'), 'do not replace')
      const collisionBefore = inventory(collisionTarget)
      const collision = await call(session.page, 'project:archive-restore', {
        archiveGrantId: (await chooseArchive()).grantId, targetGrantId: collisionGrant.grantId,
      })
      assert.equal(collision.success, false)
      assert.equal(collision.errorCode, 'PORTABLE_RESTORE_TARGET_EXISTS')
      assert.deepEqual(inventory(collisionTarget), collisionBefore)
      assert.deepEqual(inventory(sourceProjectPath), sourceInventory)
      results.push({ name: 'restore-target-collision', outcome: 'PASS', targetAndSourceBytesUnchanged: true })

      const restoreTarget = await chooseRestoreTarget('r')
      assert.equal(restoreTarget.displayName, 'r')
      // 授权把父目录固定为规范真实路径；恢复收据里的目标必须正是这条授权路径。
      restoredProjectPath = path.join(fs.realpathSync.native(profiles.B.projects), restoreTarget.displayName)
      const restored = await call(session.page, 'project:archive-restore', {
        archiveGrantId: (await chooseArchive()).grantId, targetGrantId: restoreTarget.grantId,
      })
      assert.equal(restored.success, true, restored.error)
      restoreReceipt = restored.receipt
      assert.equal(restoreReceipt.originProjectId, sourceProjectId)
      assert.notEqual(restoreReceipt.targetProjectId, sourceProjectId)
      assert.equal(restoreReceipt.targetProjectRoot, restoredProjectPath)
      assert.equal(restoreReceipt.portableDatabaseSha256.length, 64)
      assert.deepEqual(await call(session.page, 'project:get-runtime-context'), { activeProjectPath: null, dbReady: true })
      results.push({ name: 'profile-b-restore-new-copy', outcome: 'PASS', newProjectId: true, noAutomaticOpen: true, portableDatabaseSha256: restoreReceipt.portableDatabaseSha256 })
    } finally { await session.app.close() }

    session = await launch(profiles.B)
    try {
      assert.deepEqual(await call(session.page, 'project:get-runtime-context'), { activeProjectPath: null, dbReady: true })
      const reopened = await call(session.page, 'project:open', restoredProjectPath, randomUUID(), null)
      assert.equal(reopened.success, true, reopened.error)
      assert.equal(reopened.project.id, restoreReceipt.targetProjectId)
      const restoredSession = { projectId: restoreReceipt.targetProjectId, projectPath: restoredProjectPath, leaseId: reopened.project.sessionLease }
      const restoredDrafts = await call(session.page, 'db:draft-list', 1, restoredProjectPath, restoredSession)
      assert.equal(restoredDrafts.length, 1)
      const restoredBody = await call(session.page, 'db:draft-get-full', restoredDrafts[0].id, restoredProjectPath, restoredSession)
      assert.equal(restoredBody.content, authorBody)
      assert.equal(hash(Buffer.from(restoredBody.content)), authorBodySha256)
      results.push({ name: 'profile-b-restart-explicit-open', outcome: 'PASS', authorBodySha256, serviceEvidence: {
        archiveSha256: exportReceipt.targetSha256, portableDatabaseSha256: restoreReceipt.portableDatabaseSha256,
      } })
    } finally { await session.app.close() }

    const evidence = {
      outcome: 'PASS',
      physicalModelRequests: 0,
      modelIpcInvocations: 0,
      invokedChannels: [...invokedChannels].sort(),
      profiles: Object.fromEntries(Object.entries(profiles).map(([name, current]) => [name, {
        roots: Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData'].map(key => [key, current[key]])),
      }])),
      results,
    }
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2))
    process.stdout.write(JSON.stringify({ outcome: 'PASS', scenarios: results.length, physicalModelRequests: 0, evidence: path.relative(repository, path.join(root, 'evidence.json')) }) + '\n')
  } catch (error) {
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({
      outcome: 'FAIL', physicalModelRequests: 0, modelIpcInvocations: 0, results,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }, null, 2))
    throw error
  }
}
