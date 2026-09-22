/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageArg = process.argv.find(arg => arg.startsWith('--package-dir='))?.slice('--package-dir='.length)
const expectedAsar = process.argv.find(arg => arg.startsWith('--asar-sha256='))?.slice('--asar-sha256='.length)
assert(packageArg && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''), 'pass --package-dir=<win-unpacked> --asar-sha256=<bundle hash>')
const packageDir = path.resolve(packageArg)
const exe = path.join(packageDir, 'AI小说作家.exe')
const asar = path.join(packageDir, 'resources', 'app.asar')
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
assert.equal(sha256(asar), expectedAsar, 'bundle hash changed')

const runId = randomUUID()
const scratch = path.join(process.env.LOCALAPPDATA ?? repository, 'VibeCodingScratch', 'an', 'f04s', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const receiptDir = path.join(repository, '.runtime', '.cache', 'f04-v3-settings-backup', runId)
const projectName = 'V3S'
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
  try {
    ({ app, page } = await launch())
    currentStep = 'fixture-create'
    const project = await invoke(page, 'project:create', { path: profile.projects, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(project.success, true, project.error)
    pass('fixture-create', { projectId: project.projectId })
    await app.close()
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

    currentStep = 'masthead-backup-entry'
    await page.getByRole('button', { name: '关闭设置' }).click()
    await page.locator('.writer-topbar button[title="备份"]').click()
    await page.getByRole('heading', { name: '项目备份' }).waitFor({ state: 'visible' })
    assert.equal(await page.locator('.skin-solid-surface').count(), 1)
    pass('masthead-backup-entry', { sameSettingsSheet: true })
    await page.screenshot({ path: path.join(receiptDir, 'v3-backup-from-masthead.png') })
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message }
    await page?.screenshot({ path: path.join(receiptDir, 'failure.png') }).catch(() => {})
  } finally {
    if (app) await app.close().catch(() => {})
    const receipt = { outcome: failure ? 'FAIL' : 'PASS', asarSha256: expectedAsar, executableSha256: sha256(exe),
      driverSha256: sha256(fileURLToPath(import.meta.url)), scratch, steps, failure,
      fileAuthorizationAndRecovery: 'not exercised; browser command mapping is separate evidence' }
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(`${path.join(receiptDir, 'receipt.json')}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

await main()
