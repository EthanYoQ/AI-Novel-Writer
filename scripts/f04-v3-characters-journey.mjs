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
const ignoredScreenshotPaths = dirtyProductPaths.filter(line => /^\?\? src\/components\/(?:dialogs|editor|layout\/v2|panels|pages\/v2)\/__tests__\/__screenshots__\/.*\.png$/.test(line))
assert.equal(git('diff', '--name-only', `${testedSha}..${executionHead}`, '--', ...productInputs), '',
  'product source changed since fixed package build')
assert.deepEqual(dirtyProductPaths.filter(line => !ignoredScreenshotPaths.includes(line)), [], 'product build inputs are dirty')
assert.equal(sha256(exe), expectedExe, 'executable hash changed')
assert.equal(sha256(asar), expectedAsar, 'bundle hash changed')
const runId = randomUUID()
const scratch = path.join(process.env.LOCALAPPDATA ?? repository, 'VibeCodingScratch', 'an', 'f04c', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const receiptDir = path.join(repository, '.runtime', '.cache', 'f04-v3-characters', runId)
const receiptPath = path.join(receiptDir, 'receipt.json')
const nativePickerHelper = path.join(repository, 'scripts', 'f05-u16-native-picker.ps1')
const projectName = 'V3C'
const names = [`甲${runId.slice(0, 4)}`, `乙${runId.slice(0, 4)}`]
const backgrounds = [`北港线人 ${runId.slice(0, 8)}`, `南站警员 ${runId.slice(0, 8)}`]
const steps = []
const pass = (name, observed) => steps.push({ name, outcome: 'PASS', observed })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const pickerEvidence = []
function chooseNativeAvatar(target) {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', nativePickerHelper,
    '-Target', target, '-ExpectedExe', exe, '-DialogTitle', '选择角色头像'],
  { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, `native avatar picker: ${result.stderr || result.stdout || result.error}`)
  const evidence = JSON.parse(result.stdout.trim())
  assert.equal(evidence.dialogTitle, '选择角色头像')
  assert.equal(evidence.typedExact, true)
  assert.equal(evidence.submitted, true)
  pickerEvidence.push(evidence)
  return evidence
}

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
    let persistedAvatarPath = persistedAvatarFiles[0]
    let persistedAvatarBytes = fs.readFileSync(persistedAvatarPath)
    assert(persistedAvatarBytes.equals(Buffer.from(avatar.avatar.base64, 'base64')), 'persisted avatar bytes differ from commit response')
    await app.close()
    app = null

    app = (await launch()).app
    const editProcessPid = app.process().pid
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

    const sourceImage = path.join(scratch, 'avatar-blue.png')
    const blueBase64 = await profilePage.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 32
      const draw = canvas.getContext('2d')
      draw.fillStyle = '#1876d2'
      draw.fillRect(0, 0, 32, 32)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    fs.writeFileSync(sourceImage, Buffer.from(blueBase64, 'base64'))
    const avatarState = () => {
      const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
      try {
        const row = db.prepare('SELECT asset_revision AS revision, relative_path AS relativePath, content_hash AS contentHash FROM character_avatar_assets WHERE character_id=?').get(firstId)
        return { row, files: fs.readdirSync(avatarRoot, { recursive: true }).map(name => path.join(avatarRoot, name))
          .filter(file => fs.statSync(file).isFile()).map(file => ({ path: file, sha256: sha256(file) })).sort((a, b) => a.path.localeCompare(b.path)) }
      } finally { db.close() }
    }
    const originalAvatar = avatarState()
    const preview = profilePage.locator(`img[alt="${names[0]}头像预览"]`)
    const previewHash = async () => createHash('sha256').update(Buffer.from(await preview.evaluate(async image =>
      [...new Uint8Array(await (await fetch(image.src)).arrayBuffer())]))).digest('hex')
    assert.equal(await previewHash(), sha256(persistedAvatarPath))

    currentStep = 'u10-a01-stage-preview'
    await profilePage.getByRole('button', { name: '替换头像', exact: true }).click()
    chooseNativeAvatar(sourceImage)
    await profilePage.getByRole('button', { name: '取消头像更改', exact: true }).waitFor({ state: 'visible' })
    const stagedHash = await previewHash()
    assert.equal(stagedHash, sha256(sourceImage), 'UI preview bytes differ from native-selected file')
    assert.notEqual(stagedHash, sha256(persistedAvatarPath), 'chosen image did not replace UI preview')
    assert.deepEqual(avatarState(), originalAvatar, 'preview changed SQLite or persisted avatar bytes')
    await profilePage.screenshot({ path: path.join(receiptDir, 'v3-avatar-staged.png') })
    steps.push({ stepId: currentStep, actionId: 'U10.A01', outcome: 'PASS',
      assertion: 'Writer V3 native-selected avatar is visible only in staged preview; SQLite row and asset bytes are unchanged.',
      observed: { characterId: firstId, picker: pickerEvidence.at(-1), stagedSha256: stagedHash, originalAvatar } })

    currentStep = 'u10-a02-discard-stage'
    await profilePage.getByRole('button', { name: '取消头像更改', exact: true }).click()
    await profilePage.getByRole('button', { name: '取消头像更改', exact: true }).waitFor({ state: 'hidden' })
    assert.equal(await previewHash(), sha256(persistedAvatarPath), 'discard did not restore original UI preview')
    assert.deepEqual(avatarState(), originalAvatar, 'discard changed SQLite or persisted avatar bytes')
    await profilePage.screenshot({ path: path.join(receiptDir, 'v3-avatar-discarded.png') })
    steps.push({ stepId: currentStep, actionId: 'U10.A02', outcome: 'PASS',
      assertion: 'Discarding the selected avatar restores the original UI preview, SQLite row and asset bytes.',
      observed: { characterId: firstId, originalRevision: originalAvatar.row.revision, originalSha256: sha256(persistedAvatarPath) } })

    currentStep = 'u10-a03-save-avatar'
    await profilePage.getByRole('button', { name: '替换头像', exact: true }).click()
    chooseNativeAvatar(sourceImage)
    await profilePage.getByRole('button', { name: '取消头像更改', exact: true }).waitFor({ state: 'visible' })
    await profilePage.getByRole('button', { name: '保存', exact: true }).last().click()
    await profilePage.getByText('已保存', { exact: true }).last().waitFor({ state: 'visible' })
    const committedAvatar = avatarState()
    assert.equal(committedAvatar.row.revision, originalAvatar.row.revision + 1)
    persistedAvatarPath = path.join(projectPath, '.ai-novel', ...committedAvatar.row.relativePath.split('/'))
    persistedAvatarBytes = fs.readFileSync(persistedAvatarPath)
    assert.equal(sha256(persistedAvatarPath), committedAvatar.row.contentHash)
    assert.notEqual(committedAvatar.row.contentHash, originalAvatar.row.contentHash)
    assert.equal(await previewHash(), committedAvatar.row.contentHash)
    await profilePage.screenshot({ path: path.join(receiptDir, 'v3-avatar-saved.png') })

    currentStep = 'v3-graph-stable-id'
    await profilePage.getByText('背景故事', { exact: true }).locator('xpath=..').locator('textarea').fill(backgrounds[0])
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

    currentStep = 'u09-a08-same-name-rename'
    await profilePage.getByText('背景故事', { exact: true }).locator('xpath=..').locator('textarea').fill(backgrounds[1])
    await profilePage.getByText('姓名', { exact: true }).locator('xpath=..').locator('input').fill(names[0])
    await profilePage.getByRole('button', { name: '保存', exact: true }).last().click()
    await profilePage.getByText('已保存', { exact: true }).last().waitFor({ state: 'visible' })

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

    await app.close()
    app = null
    app = (await launch()).app
    const reopenedProcessPid = app.process().pid
    assert.notEqual(reopenedProcessPid, editProcessPid, 'avatar reopen reused Electron process')
    const identityPage = await app.firstWindow()
    const identityNotice = identityPage.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await identityNotice.isVisible()) await identityNotice.getByRole('button', { name: '知道了', exact: true }).click()
    await identityPage.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
    await identityPage.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
    await identityPage.locator('.writer-left-rail button[title="角色"]').click()
    currentStep = 'u09-a08-same-name-reopen'
    const firstSameName = identityPage.locator(`[data-character-id="${firstId}"]`)
    const secondSameName = identityPage.locator(`[data-character-id="${secondId}"]`)
    await firstSameName.waitFor({ state: 'visible' })
    await secondSameName.waitFor({ state: 'visible' })
    assert((await firstSameName.innerText()).includes(backgrounds[0]), 'first same-name card lost its source note')
    assert((await secondSameName.innerText()).includes(backgrounds[1]), 'second same-name card lost its source note')
    assert.equal(await identityPage.locator('[data-character-id]').filter({ hasText: names[0] }).count(), 2,
      'same-name cards were merged in Writer list')
    await identityPage.screenshot({ path: path.join(receiptDir, 'v3-character-same-name.png') })

    await firstSameName.click()
    await identityPage.getByRole('button', { name: '关系图谱', exact: true }).click()
    const sameNameGraph = identityPage.locator('canvas[aria-label^="角色关系图谱"]')
    await sameNameGraph.waitFor({ state: 'visible' })
    const graphLabel = await sameNameGraph.getAttribute('aria-label')
    assert(graphLabel?.includes(firstId.slice(-8)) && graphLabel.includes(secondId.slice(-8)) && graphLabel.includes('同盟'),
      'same-name graph did not expose stable-ID endpoints')
    await identityPage.screenshot({ path: path.join(receiptDir, 'v3-character-same-name-graph.png') })

    const identityOpened = await invoke(identityPage, 'project:open', projectPath, randomUUID(), projectPath)
    assert.equal(identityOpened.success, true, identityOpened.error)
    const identityContext = { projectId: identityOpened.project?.id, projectPath, leaseId: identityOpened.project?.sessionLease }
    assert(identityContext.projectId && identityContext.leaseId, 'reopened identity project session missing')
    const roster = await invoke(identityPage, 'db:character-roster-read', projectPath, identityContext)
    const byId = new Map(roster.entries.map(entry => [entry.characterId, entry]))
    assert.equal(byId.get(firstId)?.name, names[0])
    assert.equal(byId.get(secondId)?.name, names[0])
    assert.equal(byId.get(firstId)?.background, backgrounds[0])
    assert.equal(byId.get(secondId)?.background, backgrounds[1])
    assert(byId.get(firstId)?.relationships.some(item => item.targetCharacterId === secondId && item.relation === '同盟'),
      'main roster snapshot lost stable-ID relationship after same-name rename')

    const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
    let persistedCharacters
    let persistedAliases
    let persistedRelationship
    try {
      persistedCharacters = db.prepare(`SELECT character_id AS characterId,name,background,retired FROM characters
        WHERE character_id IN (?,?) ORDER BY character_id`).all(firstId, secondId)
      persistedAliases = db.prepare(`SELECT character_id AS characterId,name,source_key AS sourceKey,valid_from AS validFrom,
        valid_through AS validThrough FROM character_aliases WHERE character_id IN (?,?)
        ORDER BY character_id,valid_from`).all(firstId, secondId)
      persistedRelationship = db.prepare(`SELECT source_character_id AS sourceCharacterId,target_character_id AS targetCharacterId,
        relation FROM character_relationships WHERE source_character_id=? AND target_character_id=?`).get(firstId, secondId)
    } finally { db.close() }
    assert.equal(persistedCharacters.length, 2, 'same-name rename merged SQLite identities')
    assert.deepEqual(new Map(persistedCharacters.map(row => [row.characterId, row.background])),
      new Map([[firstId, backgrounds[0]], [secondId, backgrounds[1]]]))
    assert(persistedCharacters.every(row => row.name === names[0] && row.retired === 0), 'same-name SQLite rows were overwritten or retired')
    assert(persistedAliases.some(row => row.characterId === secondId && row.name === names[1] && row.validThrough !== null),
      'renamed identity lost its closed historical alias')
    assert(persistedAliases.some(row => row.characterId === firstId && row.name === names[0] && row.validThrough === null)
      && persistedAliases.some(row => row.characterId === secondId && row.name === names[0] && row.validThrough === null),
    'same display name did not retain two active ID-scoped aliases')
    assert.deepEqual(persistedRelationship,
      { sourceCharacterId: firstId, targetCharacterId: secondId, relation: '同盟' })
    steps.push({ stepId: currentStep, actionId: 'U09.A08', outcome: 'PASS',
      assertion: 'Writer V3 keeps two renamed same-name cards separate by stable ID/source note after restart; main IPC and SQLite retain both backgrounds, alias history and the ID-bound relationship without merge or overwrite.',
      observed: { displayName: names[0], ids: [firstId, secondId], sourceDisplay: backgrounds,
        derivedSourceRequired: false, sourceDisplayContract: 'background note or stable-ID suffix',
        mainRosterIdentityRevision: roster.identityRevision, relationship: persistedRelationship,
        activeSameNameAliases: persistedAliases.filter(row => row.name === names[0] && row.validThrough === null).length } })

    currentStep = 'u10-a03-reopen-avatar'
    await identityPage.getByRole('button', { name: '编辑模式', exact: true }).click()
    await firstSameName.click()
    await identityPage.locator(`img[alt="${names[0]}头像预览"]`).waitFor({ state: 'visible' })
    assert.equal(await identityPage.locator(`[data-character-id="${firstId}"]`).getAttribute('data-character-id'), firstId)
    assert.equal(await identityPage.locator(`img[alt="${names[0]}头像预览"]`).evaluate(async image => {
      const bytes = new Uint8Array(await (await fetch(image.src)).arrayBuffer())
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    }), committedAvatar.row.contentHash)
    assert.deepEqual(avatarState(), committedAvatar, 'fresh process changed committed avatar')
    await identityPage.screenshot({ path: path.join(receiptDir, 'v3-avatar-reopened.png') })
    steps.push({ stepId: currentStep, actionId: 'U10.A03', outcome: 'PASS',
      assertion: 'Writer V3 Save committed the native-selected avatar to a new SQLite revision and asset bytes; a fresh Electron process reopens the same stable-ID avatar.',
      observed: { characterId: firstId, picker: pickerEvidence.at(-1), editProcessPid, reopenedProcessPid, revision: committedAvatar.row.revision,
        relativePath: committedAvatar.row.relativePath, persistedSha256: committedAvatar.row.contentHash } })
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message }
  } finally {
    await app?.close().catch(() => {})
    const verifiedActions = [...new Set(steps.filter(step => step.outcome === 'PASS' && step.actionId).map(step => step.actionId))]
    const receipt = { schemaVersion: 1, qualification: 'F05_U09_A08_U10_A01_A02_A03_A07_PACKAGED_V3_CHARACTERS',
      outcome: failure ? 'FAIL' : 'PARTIAL', sliceOutcome: failure ? 'FAIL' : 'PASS', fullU10Qualification: false,
      fullU09Qualification: false, fullF05Qualification: false, evidenceLevel: 'electron', shell: 'writer-v3', testedSha, executionHead, changedPaths,
      dirtyProductPaths, ignoredScreenshotPaths, package: { directory: packageDir, executableSha256: sha256(exe), asarSha256: sha256(asar) },
      driver: { path: fileURLToPath(import.meta.url), sha256: sha256(fileURLToPath(import.meta.url)) },
      nativePickerHelper: { path: nativePickerHelper, sha256: sha256(nativePickerHelper) }, pickerEvidence,
      evidence: { receipt: path.relative(repository, receiptPath), screenshots: ['v3-character-profile.png', 'v3-avatar-staged.png', 'v3-avatar-discarded.png', 'v3-avatar-saved.png',
        'v3-avatar-reopened.png', 'v3-character-same-name.png', 'v3-character-same-name-graph.png'].filter(name => fs.existsSync(path.join(receiptDir, name))) },
      verifiedActions, unverifiedActions: ['U09.A01-U09.A07', 'U09.A09',
        ...['U10.A01', 'U10.A02', 'U10.A03', 'U10.A07'].filter(id => !verifiedActions.includes(id)),
        'U10.A04-U10.A06', 'U10.A08-U10.A12', 'F05 whole-product qualification'],
      projectPath, scratch, steps, failure }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, sliceOutcome: receipt.sliceOutcome, testedSha,
      driverSha256: receipt.driver.sha256, receipt: path.relative(repository, receiptPath), verifiedActions: receipt.verifiedActions })}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

await main()
