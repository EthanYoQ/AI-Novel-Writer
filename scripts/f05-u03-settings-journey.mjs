/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { verifyWindowsPackage, verifyPackagedBetterSqliteLoad, verifyPackagedLanceLoad } from './verify-win-package.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const fixedPackage = option('package-dir')
const priorPath = option('reuse-package')
assert((fixedPackage && !priorPath) || (!fixedPackage && priorPath),
  'pass --reuse-package=<prior build receipt> or --package-dir=<win-unpacked> with hashes')
const version = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')).version
const packageDir = path.resolve(fixedPackage ?? path.join(repository, 'release', version, 'win-unpacked'))
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = file => sha256(fs.readFileSync(file))
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const prior = priorPath ? JSON.parse(fs.readFileSync(priorPath, 'utf8')) : null
if (prior) assert(prior.build?.buildSha && prior.artifact, 'prior build receipt missing attribution')
const productPaths = execFileSync('git', ['ls-files', '-z', '--', 'src', 'electron', 'public', 'build',
  'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'],
{ cwd: repository }).toString('utf8').split('\0').filter(Boolean)
let packageSource
let changedPaths = []
if (prior) {
  changedPaths = git('diff', '--name-only', `${prior.build.buildSha}..HEAD`).split('\n').filter(Boolean)
  assert(changedPaths.every(name => /^scripts\/f05-[a-z0-9-]+-journey\.mjs$/.test(name)),
    'product or unrelated tracked path changed since package build')
  assert(productPaths.every(name => fs.statSync(path.join(repository, name)).mtimeMs <= Date.parse(prior.build.completedAt) + 2_000),
    'product input modified after package build')
  assert.equal(fileHash(executablePath), prior.artifact.executableSha256)
  assert.equal(fileHash(asarPath), prior.artifact.asarSha256)
  packageSource = { mode: 'receipt', testedSha: prior.build.buildSha, receiptPath: priorPath,
    exactSourceShaVerified: true, reason: 'prior receipt and artifact hashes match' }
} else {
  const buildRef = option('package-source-sha')
  const expectedAsar = option('asar-sha256')?.toLowerCase()
  const expectedExe = option('exe-sha256')?.toLowerCase()
  assert(/^[a-f0-9]{7,40}$/i.test(buildRef ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? '')
    && /^[a-f0-9]{64}$/.test(expectedExe ?? ''),
    'fixed package requires --package-source-sha=<sha> and both artifact hashes')
  const baseSha = git('rev-parse', '--verify', `${buildRef}^{commit}`)
  changedPaths = git('diff', '--name-only', `${baseSha}..HEAD`).split('\n').filter(Boolean)
  assert.equal(git('diff', '--name-only', `${baseSha}..HEAD`, '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'), '',
  'product source changed since fixed package SHA')
  assert.equal(fileHash(executablePath), expectedExe)
  assert.equal(fileHash(asarPath), expectedAsar)
  packageSource = { mode: 'fixed-package', testedSha: baseSha, exactSourceShaVerified: true,
    note: 'Fixed V3 package hashes match and tracked product paths did not change since the declared package source SHA.' }
}
const dirtyProductPaths = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build',
  'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5').split('\n').filter(Boolean)
assert(dirtyProductPaths.every(line => /^\?\? src\/components\/(?:dialogs|editor|layout\/v2|pages\/v2|panels)\/__tests__\/__screenshots__\/$/.test(line)),
  'product source dirty beyond test screenshots')
const runId = randomUUID()
const discoveredModelName = `u03-fixture-${runId.slice(0, 8)}`
const receiptDir = path.join(repository, '.runtime', '.cache', 'f05-u03-settings', runId)
const scratch = path.join(process.env.LOCALAPPDATA ?? path.dirname(repository), 'VibeCodingScratch', 'an', 'u03', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const steps = []
const pass = (stepId, actionId, assertion) => steps.push({ stepId, actionId, outcome: 'PASS', assertion })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
async function persisted(file, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(file) && predicate(JSON.parse(fs.readFileSync(file, 'utf8')))) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`persisted setting did not match: ${path.basename(file)}`)
}
let currentStep = 'setup'
const promptMarker = `U03 isolated writer prompt ${runId}`
const skillName = 'safe-prose'
const skillMarker = `U03_FREEZE_${runId}`
const skillFixture = `---\nname: safe-prose\ndescription: Improve concrete prose.\nversion: 1.0.0\nlanguage: zh-CN\nstage: planning\n---\n在架构阶段保持作者事实，并使用 ${skillMarker}。\n`
const incompatibleSkill = `---\nname: unsafe-skill\ndescription: Requires executable helpers.\n---\nRun the script scripts/build.js before writing.\n`
const sourceUrl = 'https://github.com/f05-u03-fixture/writing/blob/main/SKILL.md'
const incompatibleUrl = 'https://github.com/f05-u03-fixture/writing/blob/main/unsafe/SKILL.md'
const workflowModel = { id: 'u03-architecture-fixture', name: 'U03 架构隔离模型', provider: 'openai',
  protocol: 'openai', modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1',
  apiKey: 'f05-u03-offline-only', maxTokens: 4096, temperature: 0.35, purposes: ['generation'] }
const root = () => {
  const generations = fs.readdirSync(path.join(profile.canonical, 'generations'))
  assert.equal(generations.length, 1)
  return path.join(profile.canonical, 'generations', generations[0])
}
const settings = page => page.getByRole('button', { name: '关闭设置' }).locator('xpath=ancestor::div[contains(@class,"relative flex")]')
const writer = page => page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]')
async function dismissStartupNotice(page) {
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) {
    await notice.getByRole('button', { name: '知道了', exact: true }).click()
    await notice.waitFor({ state: 'detached' })
  }
}
async function openSection(page, name) {
  await settings(page).getByRole('button', { name, exact: true }).click()
  await settings(page).getByRole('heading', { name, exact: true }).waitFor()
}

function readGeneration(projectPath) {
  assert.equal(path.resolve(path.dirname(projectPath)), path.resolve(profile.projects))
  const database = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    return database.prepare('SELECT run_id, binding_json, status FROM generation_runs ORDER BY created_at_ms').all()
      .map(row => ({ runId: row.run_id, binding: JSON.parse(row.binding_json), status: row.status }))
  } finally { database.close() }
}

function readCore(projectPath) {
  assert.equal(path.resolve(path.dirname(projectPath)), path.resolve(profile.projects))
  const database = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try { return database.prepare("SELECT premise, worldbuilding FROM project_core WHERE id='main'").get() }
  finally { database.close() }
}

async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U03 packaged settings journey',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 48,
    retainedReason: 'review packaged V3 settings action receipt',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let failure
  let app
  const fixture = { requests: [], skillRequests: [], pendingResponse: null, holdGeneration: false }
  const server = createServer((request, response) => {
    if (request.method === 'GET' && ['/skill/SKILL.md', '/skill/unsafe/SKILL.md'].includes(request.url)) {
      fixture.skillRequests.push(request.url)
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(request.url === '/skill/SKILL.md' ? skillFixture : incompatibleSkill)
      return
    }
    const authorized = request.headers.authorization === 'Bearer f05-u03-offline-only'
    const observed = { method: request.method, path: request.url, authorized }
    fixture.requests.push(observed)
    if (request.method === 'GET' && request.url === '/v1/models' && authorized) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: discoveredModelName, name: 'U03 loopback model' }] }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions' && authorized) {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          observed.parameters = { model: parsed.model, max_tokens: parsed.max_tokens,
            temperature: parsed.temperature, stream: parsed.stream, reasoning_effort: parsed.reasoning_effort ?? null }
          if (parsed.stream && fixture.holdGeneration) {
            observed.promptHasFrozenSkill = parsed.messages?.some(message => message.content?.includes(skillMarker)) ?? false
            response.writeHead(200, { 'Content-Type': 'text/event-stream' })
            fixture.pendingResponse = response
            return
          }
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ choices: [{ message: { content: 'U03_OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }))
        } catch { response.writeHead(400).end() }
      })
      return
    }
    response.writeHead(404).end()
  })
  try {
    currentStep = 'packaged-native-load'
    const verified = verifyWindowsPackage(packageDir)
    assert(verified.nativeBinding && verified.betterSqliteBinding)
    assert.equal(verifyPackagedBetterSqliteLoad(packageDir), 'PACKAGED_BETTER_SQLITE3_LOAD_OK')
    assert.equal(verifyPackagedLanceLoad(packageDir), 'PACKAGED_LANCEDB_LOAD_OK')
    pass('packaged-native-load', null, 'fixed artifact hashes and packaged native bindings verified')
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`
    const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical,
      AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy, AI_NOVEL_VELA_HOME: profile.legacy,
      HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
    app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
    await app.evaluate((_, fixturePort) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (input, options) => {
        const url = new URL(String(input))
        if (url.origin === 'https://raw.githubusercontent.com') {
          if (url.pathname === '/f05-u03-fixture/writing/main/SKILL.md') {
            return originalFetch(`http://127.0.0.1:${fixturePort}/skill/SKILL.md`, options)
          }
          if (url.pathname === '/f05-u03-fixture/writing/main/unsafe/SKILL.md') {
            return originalFetch(`http://127.0.0.1:${fixturePort}/skill/unsafe/SKILL.md`, options)
          }
        }
        if (url.hostname === 'github.com' || url.hostname === 'api.github.com'
          || url.hostname === 'raw.githubusercontent.com') throw new Error('U03_GITHUB_NETWORK_REFUSED')
        if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/chat/completions') {
          return originalFetch(`http://127.0.0.1:${fixturePort}${url.pathname}`, options)
        }
        if (url.origin !== `http://127.0.0.1:${fixturePort}`) throw new Error('U03_EXTERNAL_NETWORK_REFUSED')
        return originalFetch(input, options)
      }
    }, server.address().port)
    const page = await app.firstWindow({ timeout: 30_000 })
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    await page.evaluate(() => {
      const key = 'ai-novel-writer-appearance'
      const appearance = JSON.parse(localStorage.getItem(key))
      appearance.shellPreference = 'writer'
      appearance.revision += 1
      appearance.origin = 'author'
      localStorage.setItem(key, JSON.stringify(appearance))
    })
    await page.reload()
    await writer(page).waitFor({ state: 'visible' })
    await dismissStartupNotice(page)
    const created = await invoke(page, 'project:create', { path: profile.projects, name: 'U03-settings',
      genre: 'fixture', targetAudience: 'fixture', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    await page.reload()
    await page.getByRole('button', { name: '打开《U03-settings》' }).click()
    assert.equal(path.resolve((await invoke(page, 'project:get-runtime-context')).activeProjectPath), path.resolve(created.projectPath))
    await dismissStartupNotice(page)
    pass('writer-project-entry', null, 'isolated packaged V3 Writer opened fixture project')

    currentStep = 'U03.A05-model-discovery'
    await writer(page).locator('.writer-left-rail button[title="设置"]').click()
    await settings(page).getByRole('button', { name: '添加生成模型' }).click()
    const form = settings(page).getByPlaceholder('如：DeepSeek 主力 / GPT-4o 备用').locator('xpath=ancestor::div[contains(@class,"rounded-xl p-5")]')
    await form.locator('select').first().selectOption('custom')
    await form.getByPlaceholder('https://api.openai.com').fill(endpoint)
    await form.locator('input[type="password"]').fill('f05-u03-offline-only')
    await form.getByRole('button', { name: '获取模型列表' }).click()
    await form.getByRole('combobox', { name: '端点模型列表' }).waitFor({ timeout: 5000 })
    assert.deepEqual(fixture.requests, [{ method: 'GET', path: '/v1/models', authorized: true }])
    assert.equal(await form.getByRole('combobox', { name: '端点模型列表' }).locator(`option[value="${discoveredModelName}"]`).count(), 1)
    pass('U03.A05-model-discovery', 'U03.A05', 'V3 unsaved model form fetched and displayed the controlled endpoint model list')

    currentStep = 'U03.A06-model-parameters'
    await form.getByRole('combobox', { name: '端点模型列表' }).selectOption(discoveredModelName)
    await form.getByPlaceholder('如：DeepSeek 主力 / GPT-4o 备用').fill('U03 隔离模型')
    await form.getByLabel('上下文窗口').fill('8192')
    await form.getByRole('button', { name: '高级设置' }).click()
    await form.getByLabel('温度').fill('0.35')
    await form.getByLabel('最大输出 Token').fill('1536')
    await form.getByLabel('模型推理覆盖').selectOption('low')
    const modelFile = path.join(root(), 'models.json')
    await form.getByRole('button', { name: '保存配置' }).click()
    await persisted(modelFile, models => models.some(model => model.modelName === discoveredModelName
      && model.temperature === 0.35 && model.maxTokens === 1536 && model.capabilities?.maxOutputTokens === 1536
      && model.capabilities?.contextWindowTokens === 8192 && model.reasoningOverride === 'low'))
    const savedModel = JSON.parse(fs.readFileSync(modelFile, 'utf8')).find(model => model.modelName === discoveredModelName)
    assert.equal(savedModel.baseUrl, endpoint)
    assert.equal(savedModel.apiKey, 'f05-u03-offline-only')
    await settings(page).getByText('U03 隔离模型', { exact: true }).waitFor()
    pass('U03.A06-model-parameters', 'U03.A06', 'V3 saved the selected model, temperature, context/output limits, and reasoning preference to isolated canonical models.json')
    await settings(page).getByRole('button', { name: '关闭设置' }).click()

    currentStep = 'U03.A07-request-parameters'
    const generated = await invoke(page, 'llm:generate', {
      modelId: savedModel.id, purpose: 'u03-parameter-probe', reasoningStage: 'general', creativeStrategy: 'auto',
      messages: [{ role: 'user', content: 'Reply with U03_OK.' }],
    })
    assert.equal(generated.success, true, generated.error)
    assert.equal(generated.content, 'U03_OK')
    assert.deepEqual(fixture.requests[1], { method: 'POST', path: '/v1/chat/completions', authorized: true,
      parameters: { model: discoveredModelName, max_tokens: 1536, temperature: 0.35, stream: false, reasoning_effort: null } })
    assert.equal(fixture.requests.length, 2)
    pass('U03.A07-request-parameters', 'U03.A07', 'The saved V3 model drove a main-process request whose controlled endpoint observed exact temperature/output cap and no unsupported reasoning field')

    currentStep = 'U03.A03-default-valid-section'
    await writer(page).locator('.writer-left-rail button[title="设置"]').click()
    await settings(page).getByRole('heading', { name: 'AI 生成模型' }).waitFor()
    await settings(page).getByRole('button', { name: '关闭设置' }).click()
    await dismissStartupNotice(page)
    await writer(page).locator('button[title="备份"]').click()
    await settings(page).getByRole('heading', { name: '项目备份' }).waitFor()
    pass('U03.A03-default-valid', 'U03.A03', 'Writer settings default and backup section request rendered expected tab')

    currentStep = 'U03.A08-prompt-save'
    await openSection(page, '提示词模板')
    await settings(page).getByRole('button', { name: /AI 写作助手身份/u }).first().click()
    await settings(page).getByRole('textbox', { name: '补充创作指导' }).fill(promptMarker)
    await settings(page).getByRole('button', { name: '保存到全局', exact: true }).click()
    const promptFile = path.join(root(), 'prompts', 'assistant_writing_identity.zh-CN.json')
    await persisted(promptFile, value => value.taskGuidance === promptMarker)
    pass('U03.A08', 'U03.A08', 'Writer saved prompt guidance to isolated canonical global prompt file')

    currentStep = 'U03.A04-close-reopen-persisted'
    await settings(page).getByRole('button', { name: '关闭设置' }).click()
    await writer(page).locator('.writer-left-rail button[title="设置"]').click()
    await openSection(page, '提示词模板')
    await settings(page).getByRole('button', { name: /AI 写作助手身份/u }).first().click()
    const guidance = settings(page).getByRole('textbox', { name: '补充创作指导' })
    let reopenedValue = ''
    for (let attempt = 0; attempt < 100; attempt++) {
      reopenedValue = await guidance.inputValue()
      if (reopenedValue === promptMarker) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(reopenedValue, promptMarker)
    pass('U03.A04', 'U03.A04', 'Writer closed and reopened settings with persisted prompt state')

    currentStep = 'U03.A09-skill-inspection'
    await openSection(page, '写作 Skills')
    const skillUrlInput = settings(page).getByRole('textbox', { name: 'GitHub Skill 地址' })
    await skillUrlInput.fill(incompatibleUrl)
    await settings(page).getByRole('button', { name: '只读检查' }).click()
    await settings(page).getByText('unsafe-skill', { exact: true }).waitFor()
    await settings(page).getByRole('alert').filter({ hasText: '依赖脚本' }).waitFor()
    assert.equal(await settings(page).getByRole('button', { name: '确认安装' }).isDisabled(), true)
    assert.equal(fs.existsSync(path.join(root(), 'skills', 'unsafe-skill')), false)
    await skillUrlInput.fill(sourceUrl)
    await settings(page).getByRole('button', { name: '只读检查' }).click()
    await settings(page).getByText('safe-prose', { exact: true }).first().waitFor()
    assert.equal(await settings(page).getByRole('button', { name: '确认安装' }).isEnabled(), true)
    assert.deepEqual(fixture.skillRequests, ['/skill/unsafe/SKILL.md', '/skill/SKILL.md'])
    pass('U03.A09-skill-inspection', 'U03.A09', 'V3 read-only inspection rejected a script-dependent Skill and showed a compatible prompt-only Skill without installation')

    currentStep = 'U03.A10-skill-install'
    const installedRoot = path.join(root(), 'skills', skillName)
    await settings(page).getByRole('button', { name: '确认安装' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认' }).click()
    for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(installedRoot, 'SKILL.md')); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(fs.readFileSync(path.join(installedRoot, 'SKILL.md'), 'utf8'), skillFixture)
    await settings(page).getByRole('button', { name: '卸载 safe-prose' }).waitFor()
    assert.deepEqual(fixture.skillRequests, ['/skill/unsafe/SKILL.md', '/skill/SKILL.md', '/skill/SKILL.md'])
    pass('U03.A10-skill-install', 'U03.A10', 'V3 confirmation caused a second controlled source fetch and installed exactly inspected bytes in isolated global Skill storage')

    currentStep = 'U03.A11-skill-freeze'
    await settings(page).getByRole('combobox', { name: '设定与规划 Skill' }).selectOption('user:safe-prose')
    const bindingFile = path.join(created.projectPath, '.ai-novel', 'writing-skills.json')
    await persisted(bindingFile, value => value.bindings?.planning === 'user:safe-prose')
    await settings(page).getByRole('button', { name: '关闭设置' }).click()
    const workflowModelSaved = await invoke(page, 'llm:save-model', workflowModel)
    assert.equal(workflowModelSaved.success, true, workflowModelSaved.error)
    const defaultModel = await invoke(page, 'llm:set-default-model', workflowModel.id)
    assert.equal(defaultModel.success, true, defaultModel.error)
    await page.reload()
    await page.getByRole('button', { name: '打开《U03-settings》' }).click()
    await dismissStartupNotice(page)
    assert.equal(await invoke(page, 'llm:get-default-model'), workflowModel.id)
    await page.locator('.writer-project-tree').getByText('小说配置', { exact: true }).click()
    await page.getByPlaceholder('在此输入你的创作想法，或让 AI 根据这段话一键生成全部配置...')
      .fill('潮汐城的记录员林岚要寻找失落地图，旧港的钟声与城门决定她的调查期限。')
    await page.getByRole('heading', { name: '小说配置' }).locator('xpath=../..')
      .getByRole('button', { name: '保存', exact: true }).click()
    await page.getByRole('status').filter({ hasText: /^已保存$/ }).last().waitFor()
    await page.locator('.writer-project-tree').getByText('故事架构', { exact: true }).click()
    fixture.holdGeneration = true
    await page.getByRole('button', { name: 'AI 生成架构' }).click()
    const generationDialog = page.getByRole('dialog')
    await generationDialog.getByRole('button', { name: '全选' }).click()
    for (const label of ['角色图谱', '情节大纲']) {
      await generationDialog.locator('label').filter({ hasText: label }).click()
    }
    await generationDialog.getByRole('button', { name: '确认生成（2/4）' }).click()
    let selectedRun
    for (let attempt = 0; attempt < 100 && !selectedRun; attempt++) {
      selectedRun = readGeneration(created.projectPath).find(run => run.binding.sourceManifest?.operation === 'generate-core-seed')
      if (!selectedRun) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(selectedRun?.binding.sourceManifest.modelReceipt?.modelId, workflowModel.id,
      'V3 workflow selected a different renderer-cached default model')
    for (let attempt = 0; attempt < 300 && !fixture.pendingResponse; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert(fixture.pendingResponse, 'V3 architecture workflow did not reach the controlled streaming model')
    const request = fixture.requests.at(-1)
    assert.equal(request.method, 'POST')
    assert.equal(request.path, '/v1/chat/completions')
    assert.equal(request.authorized, true)
    assert.equal(request.parameters.stream, true)
    assert.equal(request.promptHasFrozenSkill, true)
    const runBefore = readGeneration(created.projectPath).find(run => run.binding.sourceManifest?.operation === 'generate-core-seed')
    assert(runBefore, 'real generation run did not persist a frozen source binding')
    assert.deepEqual(runBefore.binding.sourceManifest.skillStages, ['planning'])
    assert.match(runBefore.binding.fingerprint.skillSnapshotHash, /^[a-f0-9]{64}$/)
    const generatedPremise = '林岚在旧港第三次钟声前核对两份潮位记录，发现地图上的入口标记被人改写。她沿着旧城墙寻找原始记录，并决定先保护见证者。'.repeat(2)
    fixture.pendingResponse.write(`data: ${JSON.stringify({ choices: [{ delta: { content: generatedPremise }, finish_reason: 'stop' }] })}\n\n`)
    fixture.pendingResponse.write('data: {"choices":[],"usage":{"prompt_tokens":400,"completion_tokens":200,"total_tokens":600}}\n\n')
    fixture.pendingResponse.end('data: [DONE]\n\n')
    fixture.pendingResponse = null
    for (let attempt = 0; attempt < 300 && !fixture.pendingResponse; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert(fixture.pendingResponse, 'second architecture step did not reach the controlled streaming model')
    const secondRequest = fixture.requests.at(-1)
    assert.equal(secondRequest.parameters.stream, true)
    assert.equal(secondRequest.promptHasFrozenSkill, true, 'second workflow step lost the start-frozen Skill text')
    const generatedWorld = '潮汐城分为上城与旧港，钟声控制城门开放。守塔人保管潮位记录，记录员掌握地图索引。外来调查者须在第三次钟声前交还通行凭证。'.repeat(3)
    fixture.pendingResponse.write(`data: ${JSON.stringify({ choices: [{ delta: { content: generatedWorld }, finish_reason: 'stop' }] })}\n\n`)
    fixture.pendingResponse.write('data: {"choices":[],"usage":{"prompt_tokens":400,"completion_tokens":200,"total_tokens":600}}\n\n')
    fixture.pendingResponse.end('data: [DONE]\n\n')
    fixture.pendingResponse = null
    let core
    for (let attempt = 0; attempt < 300; attempt++) {
      core = readCore(created.projectPath)
      if (core?.premise?.includes(generatedPremise) && core?.worldbuilding?.includes(generatedWorld)) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert(core?.premise?.includes(generatedPremise) && core?.worldbuilding?.includes(generatedWorld),
      'both real workflow results were not persisted to project core')
    const runsAfter = readGeneration(created.projectPath)
    const coreRun = runsAfter.find(run => run.runId === runBefore.runId)
    const worldRun = runsAfter.find(run => run.binding.sourceManifest?.operation === 'generate-world-building')
    assert.deepEqual(coreRun?.binding, runBefore.binding, 'first step lost its frozen source binding')
    assert.equal(worldRun?.binding.sourceManifest.modelReceipt?.modelId, workflowModel.id)
    assert.equal(worldRun?.binding.fingerprint.skillSnapshotHash, runBefore.binding.fingerprint.skillSnapshotHash)
    assert.deepEqual(worldRun?.binding.sourceManifest.skillStages, ['planning'])
    assert.equal(fs.readFileSync(path.join(installedRoot, 'SKILL.md'), 'utf8'), skillFixture)
    pass('U03.A11-skill-freeze', 'U03.A11', 'V3 stage binding launched two real architecture steps; both requests used the same start-frozen Skill text and their durable source bindings matched')

    currentStep = 'U03.A12-uninstall'
    await writer(page).locator('.writer-left-rail button[title="设置"]').click()
    await openSection(page, '写作 Skills')
    await settings(page).getByRole('combobox', { name: '修稿与定稿前润色 Skill' }).selectOption('user:safe-prose')
    await persisted(bindingFile, value => value.bindings?.refinement === 'user:safe-prose')
    await settings(page).getByRole('button', { name: '卸载 safe-prose' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认' }).click()
    await settings(page).getByRole('button', { name: '卸载 safe-prose' }).waitFor({ state: 'detached' })
    assert.equal(fs.existsSync(installedRoot), false)
    await persisted(bindingFile, value => value.bindings?.refinement === undefined && value.bindings?.planning === undefined)
    pass('U03.A12', 'U03.A12', 'Writer confirmed uninstall removed isolated Skill and current project binding')
  } catch (error) { failure = error }
  finally {
    if (fixture.pendingResponse && !fixture.pendingResponse.writableEnded) fixture.pendingResponse.end()
    try { await app?.close() }
    finally { if (server.listening) await new Promise(resolve => server.close(resolve)) }
  }
  const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'F05_U03_V3_SETTINGS_A09_A11_CONTROLLED',
    testedSha: packageSource.exactSourceShaVerified ? packageSource.testedSha : null,
    currentHead: git('rev-parse', 'HEAD'), changedPaths, packageSource,
    reuseDecision: prior ? { testedSha: packageSource.testedSha, changedPaths,
      differences: changedPaths.join(', ') || 'none',
      reason: 'product inputs predate the verified build and executable/asar hashes match the prior receipt' }
      : { testedSha: packageSource.testedSha, changedPaths,
        differences: changedPaths.join(', ') || 'none', reason: packageSource.note },
    dirtyProductPaths, sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean),
    fixture: { modelRequests: fixture.requests, skillRequests: fixture.skillRequests,
      skillSource: 'synthetic GitHub URL strictly intercepted in Electron main to isolated loopback; no external Skill source fetched' },
    artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
    driver: { path: fileURLToPath(import.meta.url), sha256: fileHash(fileURLToPath(import.meta.url)) },
    profile: { canonical: profile.canonical, userData: profile.userData, projectRoot: profile.projects },
    unverified: ['U03.A03 has no independent invalid URL deep-link consumer; existing default and backup section entries were tested',
      'U03.A05-A07 use an isolated loopback model; real external provider capability/quality is unverified',
      'U03.A07 verifies the saved V3 model through renderer IPC and main HTTP request, not a complete V3 generation workflow',
      'U03.A07 does not qualify provider-specific reasoning mappings or context-budget preflight',
      'U03.A09-A10 use a controlled loopback Skill source through exact main-process GitHub fetch interception; arbitrary public GitHub availability/trust is unverified',
      'U03.A11 tests one planning-stage architecture run, not every writing stage or model quality',
      'U03.A13-A14 outside this journey'],
    steps, failedStep: failure ? currentStep : null, error: failure ? String(failure) : null }
  assert.equal(JSON.stringify(receipt).includes('f05-u03-offline-only'), false, 'fixture credential reached receipt')
  fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(JSON.stringify({ outcome: receipt.outcome, receipt: path.join(receiptDir, 'receipt.json'), steps: steps.length }) + '\n')
  if (failure) throw failure
}

await main()
