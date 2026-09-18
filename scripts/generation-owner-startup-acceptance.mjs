/* global process */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.join(repository, '.runtime/.cache/s05-electron', randomUUID())
const roots = Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData', 'projects'].map(name => [name, path.join(root, name)]))
const syntheticKey = 'synthetic-owner-acceptance-no-network'
const visibleText = '  合成正文。\n保持原有空白。  '
const model = { id: 'synthetic-owner', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: syntheticKey, maxTokens: 1024, temperature: 0.7, purposes: ['generation'] }
async function invoke(page, channel, ...args) {
  return page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
}
async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy, AI_NOVEL_VELA_HOME: roots.legacy,
    HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[name]
  const app = await electron.launch({ cwd: repository, args: ['.', `--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  try {
    // The actual provider adapter runs; every fetch is intercepted before any generation request.
    await app.evaluate(async (_, fixture) => {
      globalThis.__ownerAcceptance = { dispatches: 0, requests: [] }
      globalThis.fetch = async (url, options) => {
        if (String(url) !== 'https://api.openai.com/v1/chat/completions'
          || new Headers(options?.headers).get('Authorization') !== `Bearer ${fixture.syntheticKey}`) throw new Error('SYNTHETIC_FETCH_ONLY')
        const request = JSON.parse(options.body)
        globalThis.__ownerAcceptance.dispatches++
        globalThis.__ownerAcceptance.requests.push({ maxCompletionTokens: request.max_completion_tokens, legacyMaxTokens: request.max_tokens ?? null })
        const chunks = [
          { choices: [{ delta: { reasoning_content: '合成隐藏推理', content: '<thi' } }] },
          { choices: [{ delta: { content: `nk>内部内容</think>${fixture.visibleText}` }, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } },
        ]
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
    }, { syntheticKey, visibleText })
    const page = await app.firstWindow({ timeout: 30_000 })
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), roots.userData)
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    return { app, page }
  } catch (error) { await app.close(); throw error }
}
const task = { purpose: 'draft', output: 'visible-text', messages: [{ role: 'user', content: '按合成设定撰写中文正文。' }] }
const selection = { operation: 'draft', uiActionNonce: 'synthetic-click', modelId: model.id, selectedDraftIds: [],
  selectedFinalizedDraftIds: [], promptKeys: ['first_chapter_draft'], skillStages: [], output: 'visible-text' }
const results = []
let syntheticDispatches = 0
function safeReceipt(value) {
  const json = JSON.stringify(value)
  for (const secret of [syntheticKey, roots.home, roots.canonical, '内部内容', '合成隐藏推理']) assert.equal(json.includes(secret), false)
}
async function captureDispatches(app, expected) {
  const evidence = await app.evaluate(() => globalThis.__ownerAcceptance)
  assert.equal(evidence.dispatches, expected)
  for (const request of evidence.requests) { assert.equal(request.legacyMaxTokens, null); assert.ok(request.maxCompletionTokens > 0) }
  syntheticDispatches += evidence.dispatches
}

if (process.argv.includes('--help')) {
  process.stdout.write('Build first, then use the Electron native profile. Exercises main-owned generation public IPC in isolated roots with intercepted synthetic responses and zero real model calls.\n')
} else {
  for (const [name, directory] of Object.entries(roots)) if (name !== 'canonical') fs.mkdirSync(directory, { recursive: true })
  try {
    let session = await launch(), projectPath, projectId, oldHandle, firstArtifactId, firstLedger
    try {
      const created = await invoke(session.page, 'project:create', { path: roots.projects, name: '合成生成验收', genre: '合成测试', targetAudience: '合成读者', writingLanguage: 'zh-CN' }, randomUUID())
      assert.equal(created.success, true, created.error)
      projectPath = created.projectPath; projectId = created.projectId
      const opened = await invoke(session.page, 'project:open', projectPath, randomUUID())
      assert.equal(opened.success, true, opened.error)
      const context = { projectId, projectPath, leaseId: opened.project.sessionLease }
      assert.equal((await invoke(session.page, 'llm:save-model', model)).success, true)
      await assert.rejects(invoke(session.page, 'generation:begin', { ...selection, promptKeys: [] }, context), /GENERATION_BEGIN_INVALID/)
      const run = await invoke(session.page, 'generation:begin', selection, context)
      oldHandle = run.handle
      const request = { handle: oldHandle, invocationNonce: 'synthetic-one', task }
      const generated = await invoke(session.page, 'generation:execute', request, context)
      assert.equal(generated.outcome.status, 'completed'); assert.equal(generated.outcome.content, visibleText)
      firstArtifactId = generated.run.artifacts[0].artifactId; firstLedger = generated.run.ledger
      assert.equal(firstLedger.physicalRequests, 1)
      assert.equal(firstLedger.tokenLiability, 60)
      assert.equal((await invoke(session.page, 'generation:execute', request, context)).run.artifacts[0].artifactId, firstArtifactId)
      const read = await invoke(session.page, 'generation:read', oldHandle, context)
      assert.equal(read.artifacts[0].text, visibleText); safeReceipt(read)
      assert.equal((await invoke(session.page, 'generation:list', context))[0].handle.runId, oldHandle.runId)
      await captureDispatches(session.app, 1)
      results.push({ name: 'public-owner-execute-and-idempotent-reread', outcome: 'PASS', durableTextExact: true, mainPlannerParameter: true, emptyPromptRejected: true })
    } finally { await session.app.close() }
    session = await launch()
    try {
      const opened = await invoke(session.page, 'project:open', projectPath, randomUUID())
      assert.equal(opened.success, true, opened.error)
      const context = { projectId, projectPath, leaseId: opened.project.sessionLease }
      assert.notEqual(context.leaseId, oldHandle.epoch)
      const recovered = await invoke(session.page, 'generation:read', oldHandle, context)
      assert.equal(recovered.candidates[0].text, visibleText)
      assert.equal(recovered.candidates[0].epoch, oldHandle.epoch)
      assert.equal(recovered.ledger.physicalRequests, 1)
      const resumed = await invoke(session.page, 'generation:resume', oldHandle, context)
      assert.equal(resumed.handle.runId, oldHandle.runId); assert.equal(resumed.handle.rootActionId, oldHandle.rootActionId)
      assert.equal(resumed.handle.epoch, context.leaseId); assert.equal(resumed.artifacts.length, 0)
      assert.equal(resumed.ledger.tokenLiability, firstLedger.tokenLiability)
      const second = await invoke(session.page, 'generation:execute', { handle: resumed.handle, invocationNonce: 'synthetic-two', task }, context)
      assert.equal(second.outcome.content, visibleText); assert.equal(second.run.ledger.physicalRequests, 2)
      assert.notEqual(second.run.artifacts[0].artifactId, firstArtifactId)
      assert.equal(second.run.candidates.length, 2)
      safeReceipt(second)
      results.push({ name: 'restart-candidates-and-explicit-resume', outcome: 'PASS', sameRootBudget: true, originalArtifactEpoch: true, newAttemptArtifact: true })
      await invoke(session.page, 'generation:pause', resumed.handle, context)
      const updated = await invoke(session.page, 'project:update-config', projectId, { id: projectId, sessionLease: context.leaseId,
        novelConfig: { ...opened.project.novelConfig, globalGuidance: '合成作者更新：结局必须保留原人物身份。' } }, projectPath, context)
      assert.equal(updated.success, true, updated.error)
      await assert.rejects(invoke(session.page, 'generation:resume', resumed.handle, context), /GENERATION_RECOVERY_UNAUTHORIZED/)
      assert.equal((await invoke(session.page, 'generation:read', resumed.handle, context)).candidates.length, 2)
      await captureDispatches(session.app, 1)
      results.push({ name: 'changed-author-source-refuses-resume', outcome: 'PASS', candidatesStillReadable: true, noExtraDispatch: true })
    } finally { await session.app.close() }
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ outcome: 'PASS', physicalModelRequests: 0, syntheticDispatches, results }, null, 2))
    process.stdout.write(JSON.stringify({ outcome: 'PASS', scenarios: results.length, physicalModelRequests: 0, syntheticDispatches, evidence: path.relative(repository, path.join(root, 'evidence.json')) }) + '\n')
  } catch (error) {
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ outcome: 'FAIL', physicalModelRequests: 0, syntheticDispatches, results,
      error: error instanceof Error ? error.message : 'Unknown failure' }, null, 2))
    throw error
  }
}
