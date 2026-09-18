/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.join(repository, '.runtime/.cache/s04-electron', randomUUID())
const roots = Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData', 'projects'].map(name => [name, path.join(root, name)]))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function inventory(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const file = path.join(entry.parentPath, entry.name)
    return [path.relative(directory, file), hash(fs.readFileSync(file))]
  }).sort(([left], [right]) => left.localeCompare(right)))
}
async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy, AI_NOVEL_VELA_HOME: roots.legacy,
    HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[name]
  const app = await electron.launch({ cwd: repository, args: ['.', `--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  let page
  try {
    page = await app.firstWindow({ timeout: 30_000 })
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), roots.userData)
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    return { app, page }
  } catch (error) {
    if (page) {
      const diagnostic = { state: await invoke(page, 'startup:get-state').catch(() => null), body: await page.locator('body').innerText().catch(() => '') }
      fs.writeFileSync(path.join(root, `startup-failure-${randomUUID()}.json`), JSON.stringify(diagnostic, null, 2))
    }
    await app.close(); throw error
  }
}
async function invoke(page, channel, ...args) {
  return page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
}

if (process.argv.includes('--help')) {
  process.stdout.write('Build first, then use the Electron native profile. Exercises public IPC in a real Electron process with only synthetic isolated roots; no provider requests.\n')
} else {
  for (const [name, directory] of Object.entries(roots)) if (name !== 'canonical') fs.mkdirSync(directory, { recursive: true })
  const results = []
  try {
    let session = await launch(), projectPath, projectId, identity
    const guidance = '合成作者原文。\r\nLiteral C:\\fiction\\notes stays prose.'
    try {
      const created = await invoke(session.page, 'project:create', { path: roots.projects, name: 'Canonical fixture', genre: '合成测试', targetAudience: 'fixture', writingLanguage: 'zh-CN' }, randomUUID())
      assert.equal(created.success, true, created.error)
      projectPath = created.projectPath; projectId = created.projectId
      assert.equal(path.dirname(projectPath), roots.projects)
      identity = JSON.parse(fs.readFileSync(path.join(projectPath, '.ai-novel/project.json'), 'utf8'))
      assert.equal(identity.projectId, projectId); assert.equal(identity.storageFormat, 'ai-novel'); assert.equal(identity.storageVersion, 1)
      assert.equal(fs.existsSync(path.join(projectPath, '.ai-novel/project.db')), true)
      assert.equal(fs.existsSync(path.join(projectPath, '.vela')), false)
      const opened = await invoke(session.page, 'project:open', projectPath, randomUUID())
      assert.equal(opened.success, true, opened.error)
      const context = { projectId, projectPath, leaseId: opened.project.sessionLease }
      const saved = await invoke(session.page, 'project:update-config', projectId, { id: projectId, sessionLease: context.leaseId, novelConfig: { ...opened.project.novelConfig, globalGuidance: guidance } }, projectPath, context)
      assert.equal(saved.success, true, saved.error)
      results.push({ name: 'create-and-save', outcome: 'PASS', canonicalOnly: true, publicIpc: true })
    } finally { await session.app.close() }
    session = await launch()
    try {
      const reopened = await invoke(session.page, 'project:open', projectPath, randomUUID())
      assert.equal(reopened.success, true, reopened.error)
      assert.equal(reopened.project.id, projectId)
      assert.equal(reopened.project.novelConfig.globalGuidance, guidance)
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(projectPath, '.ai-novel/project.json'), 'utf8')), identity)
      assert.equal(fs.existsSync(path.join(projectPath, '.vela')), false)
      results.push({ name: 'restart-and-reopen', outcome: 'PASS', sameIdentity: true, authorTextBytesPreserved: true })

      const oldProject = path.join(roots.projects, 'legacy-fixture'), oldStorage = path.join(oldProject, '.vela')
      fs.mkdirSync(oldStorage, { recursive: true })
      fs.writeFileSync(path.join(oldStorage, 'project.json'), JSON.stringify({ schemaVersion: 1, kind: 'ai-novel-project', projectId: randomUUID(), createdAt: new Date().toISOString() }))
      fs.writeFileSync(path.join(oldStorage, 'sentinel'), 'Synthetic legacy author bytes')
      const before = inventory(oldProject)
      const rejected = await invoke(session.page, 'project:open', oldProject, randomUUID())
      assert.equal(rejected.success, false)
      assert.equal(rejected.errorCode, 'PROJECT_ROOT_REQUIRED')
      assert.match(rejected.error, /尚未具备安全迁移条件/)
      assert.deepEqual(inventory(oldProject), before)
      assert.equal(fs.existsSync(path.join(oldProject, '.ai-novel')), false)
      results.push({ name: 'unqualified-legacy-open', outcome: 'PASS', originalBytesPreserved: true, noAutomaticMigration: true })
    } finally { await session.app.close() }
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ outcome: 'PASS', physicalModelRequests: 0, results }, null, 2))
    process.stdout.write(JSON.stringify({ outcome: 'PASS', scenarios: results.length, physicalModelRequests: 0, evidence: path.relative(repository, path.join(root, 'evidence.json')) }) + '\n')
  } catch (error) {
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ outcome: 'FAIL', physicalModelRequests: 0, results, error: error instanceof Error ? error.message : 'Unknown failure' }, null, 2))
    throw error
  }
}
