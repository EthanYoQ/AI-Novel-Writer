/* global process */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = option('package-dir')
const packageSourceSha = option('package-source-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
assert(packageDir && packageSourceSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const exe = path.join(packageDir, 'AI小说作家.exe')
const asar = path.join(packageDir, 'resources', 'app.asar')
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const testedSha = git('rev-parse', '--verify', `${packageSourceSha}^{commit}`)
const executionHead = git('rev-parse', 'HEAD')
const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml',
  'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
const changedPaths = git('diff', '--name-only', `${testedSha}..${executionHead}`).split('\n').filter(Boolean)
const dirtyProductPaths = git('status', '--porcelain', '--untracked-files=all', '--', ...productInputs).split('\n').filter(Boolean)
assert.equal(git('diff', '--name-only', `${testedSha}..${executionHead}`, '--', ...productInputs), '',
  'product source changed since fixed package build')
assert.deepEqual(dirtyProductPaths, [], 'product build inputs are dirty')
assert.equal(sha256(exe), expectedExe, 'executable hash changed')
assert.equal(sha256(asar), expectedAsar, 'bundle hash changed')
const runId = randomUUID()
const scratch = path.join(process.env.LOCALAPPDATA ?? repository, 'VibeCodingScratch', 'an', 'f04c', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const receiptDir = path.join(repository, '.runtime', '.cache', 'f04-v3-characters', runId)
const receiptPath = path.join(receiptDir, 'receipt.json')
const projectName = 'V3C'
const names = [`甲${runId.slice(0, 4)}`, `乙${runId.slice(0, 4)}`]
const steps = []
const pass = (name, observed) => steps.push({ name, outcome: 'PASS', observed })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })

async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy,
    AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home,
    APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const app = await electron.launch({ executablePath: exe, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  const page = await app.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(15_000)
  await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
  await page.evaluate(() => {
    const key = 'ai-novel-writer-appearance'
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...value, shellPreference: 'writer', revision: Number(value.revision ?? 0) + 1, origin: 'author' }))
  })
  await page.reload()
  await page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
  return { app, page }
}

async function addCharacter(page, name) {
  await page.getByTitle('新建角色').click()
  await page.getByText('姓名', { exact: true }).locator('xpath=..').locator('input').fill(name)
  await page.getByRole('button', { name: '保存', exact: true }).last().click()
  await page.getByText('已保存', { exact: true }).last().waitFor({ state: 'visible' })
  const row = page.locator('[data-character-id]').filter({ hasText: name })
  const id = await row.getAttribute('data-character-id')
  assert(id, `stable ID missing for ${name}`)
  return id
}

async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F04 V3 characters synthetic journey', sourceProject: repository,
    createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'isolated V3 packaged role evidence',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let app
  let currentStep = 'launch'
  let failure = null
  let projectPath
  try {
    app = (await launch()).app
    const page = await app.firstWindow()
    currentStep = 'fixture-project'
    const created = await invoke(page, 'project:create', { path: profile.projects, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    projectPath = created.projectPath
    await app.close()
    app = null

    app = (await launch()).app
    const rolePage = await app.firstWindow()
    const notice = rolePage.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
    await rolePage.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
    await rolePage.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
    currentStep = 'v3-role-entry'
    await rolePage.locator('.writer-left-rail button[title="角色"]').click()
    await rolePage.getByTitle('新建角色').waitFor({ state: 'visible' })
    assert.equal(await rolePage.locator('[data-shell-variant="v3"]').count(), 1)
    const [firstId, secondId] = [await addCharacter(rolePage, names[0]), await addCharacter(rolePage, names[1])]
    assert.notEqual(firstId, secondId)
    pass('v3-role-entry', { names, ids: [firstId, secondId] })

    currentStep = 'fixture-avatar'
    const avatarBase64 = await rolePage.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 32
      const draw = canvas.getContext('2d')
      draw.fillStyle = '#a8842f'
      draw.fillRect(0, 0, 32, 32)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    const opened = await invoke(rolePage, 'project:open', projectPath, randomUUID(), projectPath)
    assert.equal(opened.success, true, opened.error)
    const context = { projectId: created.projectId, projectPath, leaseId: opened.project?.sessionLease }
    assert(context.leaseId, 'project session lease missing')
    const avatar = await invoke(rolePage, 'character-avatar:commit', firstId, avatarBase64, context)
    assert.equal(avatar.success, true, JSON.stringify(avatar.error))
    const avatarRoot = path.join(projectPath, '.ai-novel', 'avatars')
    const persistedAvatarFiles = fs.readdirSync(avatarRoot, { recursive: true })
      .map(name => path.join(avatarRoot, name)).filter(file => fs.statSync(file).isFile())
    assert.equal(persistedAvatarFiles.length, 1, 'expected one persisted avatar asset')
    const persistedAvatarPath = persistedAvatarFiles[0]
    const persistedAvatarBytes = fs.readFileSync(persistedAvatarPath)
    assert(persistedAvatarBytes.equals(Buffer.from(avatar.avatar.base64, 'base64')), 'persisted avatar bytes differ from commit response')
    await app.close()
    app = null

    app = (await launch()).app
    const profilePage = await app.firstWindow()
    const reopenedNotice = profilePage.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await reopenedNotice.isVisible()) await reopenedNotice.getByRole('button', { name: '知道了', exact: true }).click()
    await profilePage.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
    await profilePage.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
    await profilePage.locator('.writer-left-rail button[title="角色"]').click()
    const characterCard = profilePage.locator(`[data-character-id="${firstId}"]`)
    await characterCard.waitFor({ state: 'visible' })
    currentStep = 'u10-a07-writer-card-avatar-reopen'
    await characterCard.locator(`img[alt="${names[0]}头像"]`).waitFor({ state: 'visible' })
    await characterCard.evaluate((card, characterId) => {
      const image = card.querySelector('img')
      if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth !== 32
        || card.getAttribute('data-character-id') !== characterId) throw new Error('WRITER_CARD_AVATAR_NOT_RENDERED')
    }, firstId)
    await characterCard.click()
    await profilePage.waitForFunction(name => {
      const image = document.querySelector(`img[alt="${name}头像预览"]`)
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 32
    }, names[0])
    assert.equal(await profilePage.locator('.writer-editor-content .skin-workspace-page:not([hidden]) .max-w-2xl')
      .evaluate(node => getComputedStyle(node).borderTopWidth), '3px')
    await profilePage.screenshot({ path: path.join(receiptDir, 'v3-character-profile.png') })

    currentStep = 'v3-graph-stable-id'
    const relationship = profilePage.getByText('关系网', { exact: true }).locator('xpath=..').locator('textarea')
    await relationship.fill(`${names[1]}：同盟`)
    await profilePage.getByRole('button', { name: '保存', exact: true }).last().click()
    await profilePage.getByText('已保存', { exact: true }).last().waitFor({ state: 'visible' })
    await profilePage.getByRole('button', { name: '关系图谱', exact: true }).click()
    const graph = profilePage.locator('canvas[aria-label^="角色关系图谱"]')
    await graph.waitFor({ state: 'visible' })
    assert((await graph.getAttribute('aria-label'))?.includes('同盟'), 'relationship missing from graph projection')
    await profilePage.screenshot({ path: path.join(receiptDir, 'v3-character-graph.png') })
    await profilePage.locator(`button[data-graph-character-id="${secondId}"]`).click()
    await profilePage.getByText(`${names[1]} — 编辑档案`, { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await profilePage.locator(`[data-character-id="${secondId}"]`).getAttribute('aria-pressed'), 'true')
    pass('v3-graph-stable-id', { sourceId: firstId, targetId: secondId, relation: '同盟' })
    await profilePage.screenshot({ path: path.join(receiptDir, 'v3-character-graph-open.png') })

    currentStep = 'u10-a07-writer-card-avatar-reopen'
    const reopened = await invoke(profilePage, 'project:open', projectPath, randomUUID(), projectPath)
    assert.equal(reopened.success, true, reopened.error)
    const reopenedContext = { projectId: created.projectId, projectPath, leaseId: reopened.project?.sessionLease }
    assert(reopenedContext.leaseId, 'reopened project session lease missing')
    const batch = await invoke(profilePage, 'character-avatar:read-batch', [firstId], reopenedContext)
    assert.equal(batch.success, true, JSON.stringify(batch.error))
    assert.equal(batch.avatars.length, 1)
    assert.equal(batch.avatars[0].characterId, firstId)
    assert(Buffer.from(batch.avatars[0].base64, 'base64').equals(persistedAvatarBytes), 'read-batch bytes differ from persisted asset')
    steps.push({ stepId: currentStep, actionId: 'U10.A07', outcome: 'PASS',
      assertion: 'Writer V3 character card renders the stable-ID avatar after process restart; main read-batch returns the persisted file bytes.',
      observed: { characterId: firstId, avatarWidth: 32, assetRevision: batch.avatars[0].assetRevision,
        persistedAsset: path.relative(projectPath, persistedAvatarPath).split(path.sep).join('/'),
        persistedByteSize: persistedAvatarBytes.length, persistedSha256: sha256(persistedAvatarPath) } })
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message }
  } finally {
    await app?.close().catch(() => {})
    const receipt = { schemaVersion: 1, qualification: 'F05_U10_A07_PACKAGED_V3_CHARACTER_CARD_AVATAR',
      outcome: failure ? 'FAIL' : 'PARTIAL', sliceOutcome: failure ? 'FAIL' : 'PASS', fullU10Qualification: false,
      fullF05Qualification: false, evidenceLevel: 'electron', shell: 'writer-v3', testedSha, executionHead, changedPaths,
      dirtyProductPaths, package: { directory: packageDir, executableSha256: sha256(exe), asarSha256: sha256(asar) },
      driver: { path: fileURLToPath(import.meta.url), sha256: sha256(fileURLToPath(import.meta.url)) },
      evidence: { receipt: path.relative(repository, receiptPath), screenshots: ['v3-character-profile.png'] },
      verifiedActions: failure ? [] : ['U10.A07'], unverifiedActions: ['U10.A01-U10.A06', 'U10.A08', 'F05 whole-product qualification'],
      projectPath, scratch, steps, failure }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, sliceOutcome: receipt.sliceOutcome, testedSha,
      driverSha256: receipt.driver.sha256, receipt: path.relative(repository, receiptPath), verifiedActions: receipt.verifiedActions })}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

await main()
