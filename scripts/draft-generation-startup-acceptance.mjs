/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.join(repository, '.runtime/.cache/s06b-electron', randomUUID())
const roots = Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData', 'projects'].map(name => [name, path.join(root, name)]))
const hash = text => createHash('sha256').update(text).digest('hex')
const syntheticKey = 'synthetic-draft-acceptance-no-network'
const visibleText = Array.from({ length: 80 }, (_, index) => `林岚数到第${index + 1}块青石，仍能看见灯塔上的微光。`).join('\n')
const model = { id: 'synthetic-draft', name: '合成正文模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: syntheticKey, maxTokens: 4096, temperature: 0.7, purposes: ['generation'] }
const results = []
let syntheticDispatches = 0
async function invoke(page, channel, ...args) {
  return page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
}
async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy,
    AI_NOVEL_VELA_HOME: roots.legacy, HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[name]
  const app = await electron.launch({ cwd: repository, args: ['.', `--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  try {
    await app.evaluate(async (_, fixture) => {
      globalThis.__draftAcceptance = { dispatches: 0 }
      globalThis.fetch = async (url, options) => {
        if (String(url) !== 'https://api.openai.com/v1/chat/completions'
          || new Headers(options?.headers).get('Authorization') !== `Bearer ${fixture.syntheticKey}`) throw new Error('SYNTHETIC_FETCH_ONLY')
        globalThis.__draftAcceptance.dispatches++
        const chunks = [
          { choices: [{ delta: { content: fixture.visibleText }, finish_reason: 'length' }] },
          { choices: [], usage: { prompt_tokens: 40, completion_tokens: 400, total_tokens: 440 } },
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
async function close(session) {
  try {
    const count = await session.app.evaluate(() => globalThis.__draftAcceptance.dispatches)
    syntheticDispatches += count
  } finally { await session.app.close() }
}
async function prepare(page, context, chapterNumber, selectedDraftIds = []) {
  const authorInputs = [{ id: 'draft:target-units', text: '900' },
    { id: 'draft:chapter-info', text: JSON.stringify({ chapterNumber, title: '灯塔', characters: [], keyEvents: '沿岸调查' }) }]
  const promptKeys = [chapterNumber === 1 ? 'first_chapter_draft' : 'next_chapter_draft']
  const prepared = await invoke(page, 'generation:prepare-draft-context', { chapterNumber, modelId: model.id,
    promptKeys, skillStages: ['drafting'], authorInputs, query: '作者追加关键词 灯塔', selectedDraftIds }, context)
  assert.ok(prepared.knowledgeSnapshot.items.length > 0)
  assert.equal(prepared.selectedDrafts.length, selectedDraftIds.length)
  return { prepared, selection: { operation: 'chapter-draft', uiActionNonce: randomUUID(), modelId: model.id,
    chapterNumber, promptKeys, skillStages: ['drafting'], authorInputs, selectedDraftIds, selectedFinalizedDraftIds: [],
    selectedBlueprintChapterNumbers: Array.from({ length: 6 }, (_, index) => chapterNumber + index),
    output: 'visible-text', preparationId: prepared.preparationId } }
}
async function generate(page, context, selection) {
  const run = await invoke(page, 'generation:begin', selection, context)
  const generated = await invoke(page, 'generation:execute', { handle: run.handle, invocationNonce: randomUUID(),
    task: { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: '依据灯塔资料撰写合成中文正文。' }] } }, context)
  assert.equal(generated.outcome.finishReason, 'length')
  assert.equal(generated.run.artifacts[0].status, 'failed')
  assert.equal(generated.run.artifacts[0].compositionEligible, true)
  const composition = await invoke(page, 'generation:compose-visible', run.handle,
    [generated.run.artifacts[0].artifactId], hash(visibleText), 'draft-visible-v1', context)
  assert.equal(composition.text, visibleText)
  return { handle: run.handle, expectedCompositionHash: composition.textHash, chapterNumber: selection.chapterNumber, source: 'write' }
}

if (process.argv.includes('--help')) {
  process.stdout.write('Build first, then use the Electron native profile. Uses real public IPC, SQLite and LanceDB in isolated synthetic roots with zero real provider calls.\n')
} else {
  for (const [name, directory] of Object.entries(roots)) if (name !== 'canonical') fs.mkdirSync(directory, { recursive: true })
  try {
    let session = await launch(), projectPath, projectId, firstCommit, saved
    try {
      const created = await invoke(session.page, 'project:create', { path: roots.projects, name: '合成正文验收', genre: '合成测试',
        targetAudience: '合成读者', writingLanguage: 'zh-CN' }, randomUUID())
      assert.equal(created.success, true, created.error)
      projectPath = created.projectPath; projectId = created.projectId
      const opened = await invoke(session.page, 'project:open', projectPath, randomUUID())
      assert.equal(opened.success, true, opened.error)
      const context = { projectId, projectPath, leaseId: opened.project.sessionLease }
      assert.equal((await invoke(session.page, 'llm:save-model', model)).success, true)
      for (const chapterNumber of [1, 2]) assert.equal((await invoke(session.page, 'db:blueprint-upsert',
        { chapterNumber, title: '灯塔', role: '发展', purpose: '沿岸调查', keyEvents: '发现线索', characters: [] }, projectPath, context)).success, true)
      const imported = await invoke(session.page, 'kb:import-text', '灯塔位于旧城北岸，夜间仍有守塔人巡视。', '合成灯塔资料.md', projectPath, context)
      assert.equal(imported.success, true, imported.error)
      const { prepared, selection } = await prepare(session.page, context, 1)
      assert.equal(prepared.knowledgeSnapshot.items[0].documentId, imported.docId)
      firstCommit = await generate(session.page, context, selection)
      results.push({ name: 'prepare-real-knowledge-and-acknowledge-length', outcome: 'PASS', originalDocumentIdentity: true, eligibleFailedArtifact: true })
    } finally { await close(session) }
    assert.equal(syntheticDispatches, 1)

    session = await launch()
    try {
      const opened = await invoke(session.page, 'project:open', projectPath, randomUUID())
      assert.equal(opened.success, true, opened.error)
      const context = { projectId, projectPath, leaseId: opened.project.sessionLease }
      assert.notEqual(context.leaseId, firstCommit.handle.epoch)
      const recovery = await invoke(session.page, 'generation:read-context', { handle: firstCommit.handle }, context)
      assert.equal(recovery.knowledgeSnapshot.query, '作者追加关键词 灯塔')
      assert.equal(recovery.composition.text, visibleText)
      const resumed = await invoke(session.page, 'generation:resume', firstCommit.handle, context)
      assert.equal(resumed.handle.runId, firstCommit.handle.runId)
      firstCommit = { ...firstCommit, handle: resumed.handle }
      saved = await invoke(session.page, 'generation:commit-draft', firstCommit, context)
      assert.equal(saved.content, visibleText)
      assert.equal(saved.version, 1)
      results.push({ name: 'reopen-and-save-acknowledged-prose', outcome: 'PASS', sameRun: true, noNewDispatch: true })
    } finally { await close(session) }
    assert.equal(syntheticDispatches, 1)

    session = await launch()
    try {
      const opened = await invoke(session.page, 'project:open', projectPath, randomUUID())
      assert.equal(opened.success, true, opened.error)
      const context = { projectId, projectPath, leaseId: opened.project.sessionLease }
      assert.deepEqual(await invoke(session.page, 'generation:commit-draft', firstCommit, context), saved)
      assert.deepEqual((await invoke(session.page, 'generation:read-context', { handle: firstCommit.handle }, context)).savedDraft, saved)
      const { prepared, selection } = await prepare(session.page, context, 2, [saved.id])
      assert.equal(prepared.selectedDrafts[0].contentHash, saved.contentHash)
      const secondCommit = await generate(session.page, context, selection)
      const changed = await invoke(session.page, 'kb:import-text', '作者修订：灯塔位于旧城东岸。', '合成灯塔资料.md', projectPath, context)
      assert.equal(changed.success, true, changed.error)
      await assert.rejects(invoke(session.page, 'generation:commit-draft', secondCommit, context), /GENERATION_KNOWLEDGE_SOURCE_STALE/)
      assert.deepEqual(await invoke(session.page, 'generation:commit-draft', firstCommit, context), saved)
      assert.equal((await invoke(session.page, 'generation:read', secondCommit.handle, context)).candidates[0].text, visibleText)
      assert.equal((await invoke(session.page, 'db:draft-list-all', projectPath, context)).length, 1)
      results.push({ name: 'saved-receipt-replay-and-changed-knowledge-refusal', outcome: 'PASS', oneDraftVersion: true, conflictCandidatePreserved: true })
    } finally { await close(session) }
    assert.equal(syntheticDispatches, 2)
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ outcome: 'PASS', physicalModelRequests: 0, syntheticDispatches,
      scope: 'Built Electron public IPC with real SQLite and LanceDB; not a full writing UI or model-quality qualification', results }, null, 2))
    process.stdout.write(JSON.stringify({ outcome: 'PASS', scenarios: results.length, physicalModelRequests: 0, syntheticDispatches,
      evidence: path.relative(repository, path.join(root, 'evidence.json')) }) + '\n')
  } catch (error) {
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ outcome: 'FAIL', physicalModelRequests: 0, syntheticDispatches, results,
      error: error instanceof Error ? error.message : 'Unknown failure' }, null, 2))
    throw error
  }
}
