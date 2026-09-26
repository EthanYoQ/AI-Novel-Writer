/* global process */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const Database = createRequire(import.meta.url)('better-sqlite3')
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageArg = option('package-dir')
const packageSourceSha = option('package-source-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
assert(packageArg && packageSourceSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const packageDir = path.resolve(packageArg)
const exe = path.join(packageDir, 'AI小说作家.exe')
const asar = path.join(packageDir, 'resources', 'app.asar')
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const testedSha = git('rev-parse', '--verify', `${packageSourceSha}^{commit}`)
const executionHead = git('rev-parse', 'HEAD')
const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml',
  'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
const changedProductPaths = git('diff', '--name-only', `${testedSha}..${executionHead}`, '--', ...productInputs).split('\n').filter(Boolean)
const ignoredTestOnlyPaths = changedProductPaths.filter(file => [
  'electron/services/__tests__/project-archive-service.test.ts',
  'electron/services/__tests__/release-vector-smoke.test.ts',
].includes(file))
const dirtyProductPaths = git('status', '--porcelain', '--untracked-files=all', '--', ...productInputs).split('\n').filter(Boolean)
const ignoredScreenshotPaths = dirtyProductPaths.filter(line => /^\?\? src\/components\/(?:dialogs|editor|layout\/v2|panels|pages\/v2)\/__tests__\/__screenshots__\/.*\.png$/.test(line))
assert.deepEqual(changedProductPaths.filter(file => !ignoredTestOnlyPaths.includes(file)), [], 'product source changed since fixed package build')
assert.deepEqual(dirtyProductPaths.filter(line => !ignoredScreenshotPaths.includes(line)), [], 'product build inputs are dirty')
assert.equal(sha256(exe), expectedExe, 'executable hash changed')
assert.equal(sha256(asar), expectedAsar, 'bundle hash changed')

const runId = randomUUID()
const scratch = path.join(process.env.LOCALAPPDATA ?? repository, 'VibeCodingScratch', 'an', 'f04s', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects', 'exports', 'restored']
  .map(name => [name, path.join(scratch, name)]))
const receiptDir = path.join(repository, '.runtime', '.cache', 'f04-v3-settings-backup', runId)
const projectName = 'V3S'
const characterName = `归档角色${runId.slice(0, 4)}`
const nativePickerHelper = path.join(repository, 'scripts', 'f05-u16-native-picker.ps1')
const steps = []
const pickerEvidence = []
const processEvidence = []
const pass = (name, observed) => steps.push({ name, outcome: 'PASS', observed })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
function picker(title, target) {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', nativePickerHelper,
    '-Target', target, '-ExpectedExe', exe, '-DialogTitle', title],
  { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, `native picker ${title}: ${result.stderr || result.error || result.stdout}`)
  const evidence = JSON.parse(result.stdout.trim())
  assert.equal(evidence.dialogTitle, title)
  assert.equal(evidence.typedExact, true)
  assert.equal(evidence.submitted, true)
  pickerEvidence.push({ action: title, target, ...evidence })
}
async function choose(button, selections) {
  await button.click()
  for (const [title, target] of selections) picker(title, target)
}
function avatarState(projectPath, characterId) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    const character = db.prepare('SELECT character_id AS id, name FROM characters WHERE character_id=? AND retired=0').get(characterId)
    const avatar = db.prepare('SELECT asset_revision AS revision, relative_path AS relativePath, content_hash AS contentHash, byte_size AS byteSize, mime FROM character_avatar_assets WHERE character_id=?').get(characterId)
    assert(character && avatar, `missing character/avatar ${characterId} in ${projectPath}`)
    const file = path.join(projectPath, '.ai-novel', ...avatar.relativePath.split('/'))
    const assetSha256 = sha256(file)
    assert.equal(assetSha256, avatar.contentHash, 'avatar row does not reference its bytes')
    return { character, avatar, assetSha256, assetBytes: fs.readFileSync(file) }
  } finally { db.close() }
}
const imageHash = locator => locator.evaluate(async image => {
  if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth === 0) throw new Error('AVATAR_IMAGE_NOT_RENDERED')
  const bytes = new Uint8Array(await (await fetch(image.src)).arrayBuffer())
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
})

async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy,
    AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home,
    APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const app = await electron.launch({ executablePath: exe, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  processEvidence.push({ pid: app.process()?.pid, launch: new Date().toISOString() })
  const page = await app.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(15_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
  await page.evaluate(() => {
    const key = 'ai-novel-writer-appearance'
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...value, shellPreference: 'writer', revision: Number(value.revision ?? 0) + 1, origin: 'author' }))
    window.aiNovelAPI.setZoomLevel(0)
  })
  await page.reload()
  await page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
  return { app, page }
}

async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F04 V3 settings synthetic journey', sourceProject: repository,
    createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'isolated packaged settings evidence',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let app
  let page
  let failure = null
  let currentStep = 'launch'
  let sourceSnapshot
  let restoredPath
  try {
    ({ app, page } = await launch())
    currentStep = 'fixture-create'
    const project = await invoke(page, 'project:create', { path: profile.projects, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(project.success, true, project.error)
    assert(project.projectPath, 'created project path missing')
    pass('fixture-create', { projectId: project.projectId, projectPath: project.projectPath })
    await app.close()
    processEvidence.at(-1).closed = true
    app = null;

    ({ app, page } = await launch())
    const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
    currentStep = 'open-project-from-shelf'
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
    await page.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
    pass('open-project-from-shelf', { name: projectName })

    currentStep = 'rail-settings-paper'
    await page.locator('.writer-left-rail button[title="设置"]').click()
    await page.getByRole('heading', { name: 'AI 生成模型' }).waitFor({ state: 'visible' })
    const style = await page.evaluate(() => {
      const shell = document.querySelector('.v3-magazine-shell')
      const dialog = document.querySelector('.skin-solid-surface > div')
      if (!shell || !dialog) throw new Error('V3 shell or settings sheet missing')
      const sheet = getComputedStyle(dialog)
      return { viewport: [innerWidth, innerHeight], zoomLevel: window.aiNovelAPI.getZoomLevel(),
        devicePixelRatio, paper: getComputedStyle(shell).getPropertyValue('--v3-paper').trim(),
        sheetPaper: sheet.getPropertyValue('--v3-paper').trim(), background: sheet.backgroundColor,
        fontFamily: sheet.fontFamily, borderRadius: sheet.borderRadius }
    })
    assert.deepEqual(style.viewport, [1440, 900])
    assert.equal(style.zoomLevel, 0)
    assert.equal(style.sheetPaper, style.paper)
    assert(style.fontFamily.includes('Noto Sans SC'), `unexpected settings font: ${style.fontFamily}`)
    pass('rail-settings-paper', style)
    await page.screenshot({ path: path.join(receiptDir, 'v3-settings.png') })

    currentStep = 'settings-backup-section'
    await page.getByRole('button', { name: '项目备份' }).click()
    await page.getByRole('heading', { name: '项目备份' }).waitFor({ state: 'visible' })
    await page.locator('[data-testid="project-backup-panel"]').getByText('WebDAV', { exact: true }).waitFor({ state: 'visible' })
    assert(await page.getByRole('button', { name: '导出本地存档' }).isEnabled())
    assert(await page.getByRole('button', { name: '从本地存档恢复副本' }).isEnabled())
    assert(await page.getByRole('button', { name: '连接并绑定' }).isEnabled())
    assert(await page.getByRole('button', { name: '恢复所选云端世代为副本' }).isDisabled())
    pass('settings-backup-section', { localArchiveEntry: true, webDavBindingEntry: true, cloudRestoreRequiresSelection: true })
    await page.screenshot({ path: path.join(receiptDir, 'v3-backup-from-settings.png') })

    currentStep = 'v3-avatar-source'
    await page.getByRole('button', { name: '关闭设置' }).click()
    await page.locator('.writer-left-rail button[title="角色"]').click()
    await page.getByTitle('新建角色').click()
    await page.getByText('姓名', { exact: true }).locator('xpath=..').locator('input').fill(characterName)
    await page.getByRole('button', { name: '保存', exact: true }).last().click()
    await page.getByText('已保存', { exact: true }).last().waitFor({ state: 'visible' })
    const sourceCard = page.locator('[data-character-id]').filter({ hasText: characterName })
    const characterId = await sourceCard.getAttribute('data-character-id')
    assert(characterId, 'new character has no stable ID')
    const avatarFile = path.join(scratch, 'avatar-source.png')
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 32
      const context = canvas.getContext('2d')
      context.fillStyle = '#1876d2'
      context.fillRect(0, 0, 32, 32)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    fs.writeFileSync(avatarFile, Buffer.from(base64, 'base64'))
    await page.getByRole('button', { name: '选择头像', exact: true }).click()
    picker('选择角色头像', avatarFile)
    await page.getByRole('button', { name: '取消头像更改', exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '保存', exact: true }).last().click()
    await page.getByText('已保存', { exact: true }).last().waitFor({ state: 'visible' })
    sourceSnapshot = avatarState(project.projectPath, characterId)
    assert.equal(sourceSnapshot.character.name, characterName)
    await sourceCard.locator('img').waitFor({ state: 'visible' })
    assert.equal(await imageHash(sourceCard.locator('img')), sourceSnapshot.assetSha256)
    await sourceCard.click()
    assert.equal(await imageHash(page.locator(`img[alt="${characterName}头像预览"]`)), sourceSnapshot.assetSha256)
    pass('v3-avatar-source', { characterId, characterName, avatar: sourceSnapshot.avatar, assetSha256: sourceSnapshot.assetSha256 })
    await page.screenshot({ path: path.join(receiptDir, 'v3-avatar-source.png') })

    currentStep = 'masthead-backup-entry'
    await page.locator('.writer-topbar button[title="备份"]').click()
    await page.getByRole('heading', { name: '项目备份' }).waitFor({ state: 'visible' })
    assert.equal(await page.locator('.skin-solid-surface').count(), 1)
    pass('masthead-backup-entry', { sameSettingsSheet: true })
    await page.screenshot({ path: path.join(receiptDir, 'v3-backup-from-masthead.png') })

    const panel = page.getByTestId('project-backup-panel')
    currentStep = 'u10-a12-export'
    const archivePath = path.join(profile.exports, 'avatar-project.ainovel')
    await choose(panel.getByRole('button', { name: '导出本地存档' }), [['导出项目存档', archivePath]])
    const exported = panel.getByRole('status').filter({ hasText: '本地存档已导出：' })
    await exported.waitFor({ state: 'visible', timeout: 60_000 })
    assert(fs.statSync(archivePath).size > 0, 'archive empty')
    const archiveSha256 = sha256(archivePath)
    assert((await exported.innerText()).includes(archiveSha256), 'UI archive SHA differs from file')
    pass('u10-a12-export', { archivePath, archiveSha256, archiveBytes: fs.statSync(archivePath).size })

    currentStep = 'u10-a12-restore'
    assert.equal(fs.readdirSync(profile.restored).length, 0, 'restore parent not empty before UI action')
    await choose(panel.getByRole('button', { name: '从本地存档恢复副本' }), [
      ['选择项目存档', archivePath], ['选择恢复副本所在文件夹', profile.restored],
    ])
    const restored = panel.getByRole('status').filter({ hasText: '已恢复新副本' })
    await restored.waitFor({ state: 'visible', timeout: 60_000 })
    const restoreMessage = await restored.innerText()
    const restoredProjectId = restoreMessage.match(/已恢复新副本\s+([^：]+)：/)?.[1]
    assert(restoredProjectId, `missing restored project ID in UI: ${restoreMessage}`)
    assert.notEqual(restoredProjectId, project.projectId, 'restored copy reused source project ID')
    restoredPath = path.join(profile.restored, `${projectName}-恢复副本`)
    assert(restoreMessage.includes(restoredPath), 'UI restored another target path')
    assert(fs.existsSync(path.join(restoredPath, '.ai-novel', 'project.db')), 'UI did not publish restored DB')
    const copySnapshot = avatarState(restoredPath, characterId)
    assert.deepEqual(copySnapshot.character, sourceSnapshot.character, 'restored character identity changed')
    assert.deepEqual(copySnapshot.avatar, sourceSnapshot.avatar, 'restored avatar row changed')
    assert(copySnapshot.assetBytes.equals(sourceSnapshot.assetBytes), 'restored avatar bytes differ')
    assert.equal(copySnapshot.assetSha256, sourceSnapshot.assetSha256)
    const originalAfterRestore = avatarState(project.projectPath, characterId)
    assert.deepEqual(originalAfterRestore.character, sourceSnapshot.character, 'restore changed source character')
    assert.deepEqual(originalAfterRestore.avatar, sourceSnapshot.avatar, 'restore changed source avatar row')
    assert(originalAfterRestore.assetBytes.equals(sourceSnapshot.assetBytes), 'restore changed source avatar bytes')
    const recent = await invoke(page, 'project:recent-list')
    assert.equal(path.resolve(recent[0]?.path ?? ''), path.resolve(restoredPath), 'restored copy not first recent project')
    assert.equal(recent[0].projectId, restoredProjectId, 'UI restored ID differs from recent project ID')
    pass('u10-a12-restore', { restoreMessage, restoredPath, restoredProjectId, characterId,
      avatar: copySnapshot.avatar, assetSha256: copySnapshot.assetSha256, sourceUnchanged: true })
    await page.screenshot({ path: path.join(receiptDir, 'v3-backup-restored.png') })

    currentStep = 'u10-a12-reopen-v3'
    const priorPid = app.process()?.pid
    await app.close()
    processEvidence.at(-1).closed = true
    app = null
    ;({ app, page } = await launch())
    assert.notEqual(app.process()?.pid, priorPid, 'reopen reused source Electron process')
    const reopenedNotice = page.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await reopenedNotice.isVisible()) await reopenedNotice.getByRole('button', { name: '知道了', exact: true }).click()
    const reopenedRecent = await invoke(page, 'project:recent-list')
    assert.equal(path.resolve(reopenedRecent[0]?.path ?? ''), path.resolve(restoredPath), 'restored copy not persisted in recent projects')
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).first().click()
    await page.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
    assert.equal(path.resolve((await invoke(page, 'project:get-runtime-context')).activeProjectPath), path.resolve(restoredPath),
      'V3 shelf opened original instead of restored copy')
    await page.locator('.writer-left-rail button[title="角色"]').click()
    const restoredCard = page.locator(`[data-character-id="${characterId}"]`)
    await restoredCard.waitFor({ state: 'visible' })
    await restoredCard.locator('img').waitFor({ state: 'visible' })
    assert.equal(await imageHash(restoredCard.locator('img')), sourceSnapshot.assetSha256, 'reopened V3 card avatar differs')
    await restoredCard.click()
    assert.equal(await imageHash(page.locator(`img[alt="${characterName}头像预览"]`)), sourceSnapshot.assetSha256,
      'reopened V3 preview avatar differs')
    const reopenedCopy = avatarState(restoredPath, characterId)
    assert.deepEqual(reopenedCopy.avatar, sourceSnapshot.avatar, 'reopened copy avatar row changed')
    assert(reopenedCopy.assetBytes.equals(sourceSnapshot.assetBytes), 'reopened copy avatar bytes changed')
    const originalAfterReopen = avatarState(project.projectPath, characterId)
    assert.deepEqual(originalAfterReopen.avatar, sourceSnapshot.avatar, 'reopened copy changed source row')
    assert(originalAfterReopen.assetBytes.equals(sourceSnapshot.assetBytes), 'reopened copy changed source bytes')
    pass('u10-a12-reopen-v3', { pid: app.process()?.pid, previousPid: priorPid, restoredPath,
      characterId, avatarSha256: reopenedCopy.assetSha256, sourceUnchanged: true, cardAndPreviewMatch: true })
    await page.screenshot({ path: path.join(receiptDir, 'v3-avatar-restored-copy.png') })
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message }
    await page?.screenshot({ path: path.join(receiptDir, 'failure.png') }).catch(() => {})
  } finally {
    if (app) {
      try {
        await app.close()
        processEvidence.at(-1).closed = true
      } catch (error) { processEvidence.at(-1).closeError = String(error) }
    }
    const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', sliceOutcome: failure ? 'FAIL' : 'PASS',
      qualification: 'U10.A12 packaged V3 local archive/restore avatar only; whole F05 remains PARTIAL',
      packageSourceSha: testedSha, executionHead, changedProductPaths, ignoredTestOnlyPaths,
      dirtyProductPaths, ignoredScreenshotPaths, asarSha256: expectedAsar, executableSha256: expectedExe,
      nativePickerHelperSha256: sha256(nativePickerHelper), driverSha256: sha256(fileURLToPath(import.meta.url)),
      scratch, restoredPath, pickerEvidence, processEvidence, steps, failure }
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(`${path.join(receiptDir, 'receipt.json')}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

await main()
