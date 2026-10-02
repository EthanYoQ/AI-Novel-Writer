/* global process */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { build } from 'esbuild'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let root = path.join(repository, '.runtime/.cache/s06b-electron', randomUUID())
let roots
const hash = text => createHash('sha256').update(text).digest('hex')
const syntheticKey = 'synthetic-draft-acceptance-no-network'
const visibleText = Array.from({ length: 80 }, (_, index) => `林岚数到第${index + 1}块青石，仍能看见灯塔上的微光。`).join('\n')
const outlineText = '原目标：沿岸调查。前驱完成情况沿用原文。本章行动：林岚沿北岸数过青石并观察灯塔；结果：抵达能看见灯塔的位置。结尾保持调查状态。'
const model = { id: 'synthetic-draft', name: '合成正文模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: syntheticKey, maxTokens: 4096, temperature: 0.7, purposes: ['generation'] }
const results = []
let syntheticDispatches = 0
let productionHelpers
async function helpers() {
  if (!productionHelpers) {
    const bundled = await build({ stdin: { contents: "export { assembleChapterMaterials } from './src/services/workflows/chapter-materials.ts'; export * from './src/shared/draft-short-outline.ts'; export { countDraftUnits } from './src/shared/draft-units.ts'; export { assertProjectStoragePathSupported } from './electron/services/project-storage-preflight.ts'",
      resolveDir: repository }, bundle: true, platform: 'node', format: 'esm', write: false })
    productionHelpers = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
  }
  return productionHelpers
}
export function assertShortOutlineRecovery(recovery, expected, proseStarted) {
  assert.deepEqual(recovery.draftShortOutline, { artifactIds: [expected.artifactId], completedOutput: expected.text,
    promptHash: expected.promptHash, ...(proseStarted ? { initialDraftTask: expected.initialDraftTask } : {}) })
  assert.deepEqual(recovery.attemptedPurposes, ['chapter-draft-short-outline', ...(proseStarted ? ['chapter-draft'] : [])])
}
async function invoke(page, channel, ...args) {
  return page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
}
async function launch(responseModes = []) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy,
    AI_NOVEL_VELA_HOME: roots.legacy, HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[name]
  const app = await electron.launch({ cwd: repository, args: ['.', `--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  try {
    await app.evaluate(async (_, fixture) => {
      globalThis.__draftAcceptance = { dispatches: 0, requests: [], responseModes: fixture.responseModes }
      globalThis.fetch = async (url, options) => {
        if (String(url) !== 'https://api.openai.com/v1/chat/completions'
          || new Headers(options?.headers).get('Authorization') !== `Bearer ${fixture.syntheticKey}`) throw new Error('SYNTHETIC_FETCH_ONLY')
        globalThis.__draftAcceptance.dispatches++
        globalThis.__draftAcceptance.requests.push(JSON.parse(options.body))
        const mode = globalThis.__draftAcceptance.responseModes.shift()
        if (!mode) throw new Error('UNEXPECTED_SYNTHETIC_DISPATCH')
        const chunks = [
          { choices: [{ delta: { content: mode === 'outline' ? fixture.outlineText : fixture.visibleText }, finish_reason: mode === 'outline' ? 'stop' : 'length' }] },
          { choices: [], usage: { prompt_tokens: 40, completion_tokens: 400, total_tokens: 440 } },
        ]
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
    }, { syntheticKey, visibleText, outlineText, responseModes })
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
export async function prepare(page, context, chapterNumber, selectedDraftIds = []) {
  const { assembleChapterMaterials, draftShortOutlinePrompt, DRAFT_SHORT_OUTLINE_PURPOSE, countDraftUnits } = await helpers()
  const authorInputs = [{ id: 'draft:target-units', text: String(countDraftUnits(visibleText)) },
    { id: 'draft:chapter-info', text: JSON.stringify({ chapterNumber, title: '灯塔', characters: [], keyEvents: '沿岸调查' }) }]
  const promptKeys = [chapterNumber === 1 ? 'first_chapter_draft' : 'next_chapter_draft']
  const prepared = await invoke(page, 'generation:prepare-draft-context', { chapterNumber, modelId: model.id,
    promptKeys, skillStages: ['drafting'], authorInputs, query: '作者追加关键词 灯塔', selectedDraftIds }, context)
  assert.ok(prepared.knowledgeSnapshot.items.length > 0)
  assert.equal(prepared.selectedDrafts.length, selectedDraftIds.length)
  const materials = await assembleChapterMaterials({ identity: { projectId: context.projectId, epoch: context.leaseId },
    writingLanguage: 'zh-CN', authorProjectFacts: authorInputs.map(input => input.text), characterProfiles: '', futurePlans: '',
    references: prepared.knowledgeSnapshot.items.map(item => ({ text: item.text, rendered: `[${item.fileName}]\n${item.text}` })),
    finalized: [], candidates: prepared.selectedDrafts, relevanceTerms: ['灯塔', '沿岸调查'], budgetChars: 8_000 })
  const sourcePrompt = `依据以下材料撰写第 ${chapterNumber} 章合成中文正文。\n\n${materials.text}`
  const outlineTask = { purpose: DRAFT_SHORT_OUTLINE_PURPOSE, output: 'visible-text', reasoningStage: 'planning',
    messages: [{ role: 'user', content: draftShortOutlinePrompt('zh-CN', sourcePrompt) }] }
  return { prepared, sourcePrompt, outlineTask, selection: { operation: 'chapter-draft', uiActionNonce: randomUUID(), modelId: model.id,
    chapterNumber, promptKeys, skillStages: ['drafting'], authorInputs, selectedDraftIds, selectedFinalizedDraftIds: [],
    selectedBlueprintChapterNumbers: Array.from({ length: 6 }, (_, index) => chapterNumber + index),
    output: 'visible-text', preparationId: prepared.preparationId,
    materialDecision: { ...materials.decision, promptHash: hash(sourcePrompt), shortOutlinePromptHash: hash(outlineTask.messages[0].content) } } }
}
export async function plan(page, context, prepared) {
  const run = await invoke(page, 'generation:begin', prepared.selection, context)
  const generated = await invoke(page, 'generation:execute', { handle: run.handle, invocationNonce: randomUUID(), task: prepared.outlineTask }, context)
  assert.equal(generated.outcome.finishReason, 'stop')
  const artifact = generated.run.artifacts[0]
  assert.equal(artifact.status, 'completed')
  assert.equal(artifact.text, outlineText)
  assert.equal(artifact.compositionEligible, false)
  const { draftShortOutlineBlock } = await helpers()
  const expected = { artifactId: artifact.artifactId, text: outlineText, promptHash: prepared.selection.materialDecision.shortOutlinePromptHash,
    initialDraftTask: { purpose: 'chapter-draft', output: 'visible-text', messages: [
      { role: 'system', content: '只输出本章合成正文。' },
      { role: 'user', content: `${prepared.sourcePrompt}\n\n${draftShortOutlineBlock('zh-CN', outlineText)}` },
    ] } }
  assertShortOutlineRecovery(await invoke(page, 'generation:read-context', { handle: run.handle }, context), expected, false)
  return { handle: run.handle, expected, chapterNumber: prepared.selection.chapterNumber, outlineTask: prepared.outlineTask }
}
export async function generate(page, context, planned) {
  const generated = await invoke(page, 'generation:execute', { handle: planned.handle, invocationNonce: randomUUID(),
    task: planned.expected.initialDraftTask }, context)
  assert.equal(generated.outcome.finishReason, 'length')
  // artifacts only projects the current lease; an outline from the prior process is in recovery context.
  const proseId = generated.outcome.receipt.visibleArtifact.artifactId
  assert.notEqual(proseId, planned.expected.artifactId)
  const prose = generated.run.artifacts.find(artifact => artifact.artifactId === proseId)
  assert.equal(prose.status, 'failed')
  assert.equal(prose.compositionEligible, true)
  assert.equal(generated.run.handle.rootActionId, planned.handle.rootActionId)
  assert.equal(generated.run.ledger.physicalRequests, 2)
  const composition = await invoke(page, 'generation:compose-visible', planned.handle,
    [prose.artifactId], hash(visibleText), 'draft-visible-v1', context)
  assert.equal(composition.text, visibleText)
  assertShortOutlineRecovery(await invoke(page, 'generation:read-context', { handle: planned.handle }, context), planned.expected, true)
  return { handle: planned.handle, expectedCompositionHash: composition.textHash, chapterNumber: planned.chapterNumber, source: 'write' }
}

async function main() {
if (process.argv.includes('--help')) {
  process.stdout.write('Build first, then use the Electron native profile. Uses real public IPC, SQLite and LanceDB in isolated synthetic roots with zero real provider calls.\n')
} else {
  if (process.platform === 'win32') {
    assert.ok(process.env.LOCALAPPDATA, 'LOCALAPPDATA is required for short isolated Windows paths')
    const parent = path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'an')
    fs.mkdirSync(parent, { recursive: true })
    root = fs.mkdtempSync(path.join(parent, 'd'))
    fs.writeFileSync(path.join(root, '.vibe-owner.json'), JSON.stringify({ owner: 'thread10-draft-startup-acceptance',
      sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
      retainReason: 'Review native short-outline restart evidence; isolated synthetic data only',
      cleanupCommand: `Remove-Item -LiteralPath '${root.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  }
  roots = Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData', 'projects'].map(name => [name, path.join(root, name)]))
  const { assertProjectStoragePathSupported } = await helpers()
  assertProjectStoragePathSupported(path.join(roots.projects, '合成正文验收'))
  process.stdout.write(JSON.stringify({ event: 'startup-isolation', root, projectRootLength: path.join(roots.projects, '合成正文验收').length }) + '\n')
  for (const [name, directory] of Object.entries(roots)) if (name !== 'canonical') fs.mkdirSync(directory, { recursive: true })
  try {
    let session = await launch(['outline']), projectPath, projectId, firstPlan, firstCommit, saved
    try {
      const created = await invoke(session.page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(session.app, session.page, roots.projects)).grantId, name: '合成正文验收', genre: '合成测试',
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
      const prepared = await prepare(session.page, context, 1)
      assert.equal(prepared.prepared.knowledgeSnapshot.items[0].documentId, imported.docId)
      firstPlan = await plan(session.page, context, prepared)
      results.push({ name: 'prepare-real-knowledge-and-complete-outline', outcome: 'PASS', originalDocumentIdentity: true,
        rootActionId: firstPlan.handle.rootActionId, outlineArtifactId: firstPlan.expected.artifactId, outlinePromptHash: firstPlan.expected.promptHash })
    } finally { await close(session) }
    assert.equal(syntheticDispatches, 1)

    session = await launch(['prose'])
    try {
      const opened = await invoke(session.page, 'project:open', projectPath, randomUUID())
      assert.equal(opened.success, true, opened.error)
      const context = { projectId, projectPath, leaseId: opened.project.sessionLease }
      assert.notEqual(context.leaseId, firstPlan.handle.epoch)
      assertShortOutlineRecovery(await invoke(session.page, 'generation:read-context', { handle: firstPlan.handle }, context), firstPlan.expected, false)
      const resumed = await invoke(session.page, 'generation:resume', firstPlan.handle, context)
      assert.equal(resumed.handle.runId, firstPlan.handle.runId)
      assert.equal(resumed.handle.rootActionId, firstPlan.handle.rootActionId)
      firstPlan = { ...firstPlan, handle: resumed.handle }
      await assert.rejects(invoke(session.page, 'generation:compose-visible', firstPlan.handle,
        [firstPlan.expected.artifactId], hash(outlineText), 'draft-visible-v1', context), /GENERATION_COMPOSITION_SOURCE_INVALID/)
      await assert.rejects(invoke(session.page, 'generation:execute', { handle: firstPlan.handle, invocationNonce: randomUUID(),
        task: firstPlan.outlineTask }, context), /GENERATION_DRAFT_SHORT_OUTLINE_ALREADY_ATTEMPTED/)
      firstCommit = await generate(session.page, context, firstPlan)
      const requests = await session.app.evaluate(() => globalThis.__draftAcceptance.requests)
      assert.equal(requests.length, 1)
      assert.deepEqual(requests[0].messages, firstPlan.expected.initialDraftTask.messages)
      results.push({ name: 'reopen-before-prose-reuses-original-outline', outcome: 'PASS', sameRoot: true,
        noOutlineRedispatch: true, exactComposedPromptDispatched: true, rootPhysicalRequests: 2 })
    } finally { await close(session) }
    assert.equal(syntheticDispatches, 2)

    session = await launch()
    try {
      const opened = await invoke(session.page, 'project:open', projectPath, randomUUID())
      assert.equal(opened.success, true, opened.error)
      const context = { projectId, projectPath, leaseId: opened.project.sessionLease }
      assert.notEqual(context.leaseId, firstCommit.handle.epoch)
      const recovery = await invoke(session.page, 'generation:read-context', { handle: firstCommit.handle }, context)
      assert.equal(recovery.knowledgeSnapshot.query, '作者追加关键词 灯塔')
      assert.equal(recovery.composition.text, visibleText)
      assertShortOutlineRecovery(recovery, firstPlan.expected, true)
      const resumed = await invoke(session.page, 'generation:resume', firstCommit.handle, context)
      assert.equal(resumed.handle.runId, firstCommit.handle.runId)
      firstCommit = { ...firstCommit, handle: resumed.handle }
      await assert.rejects(invoke(session.page, 'generation:execute', { handle: resumed.handle, invocationNonce: randomUUID(),
        task: firstPlan.outlineTask }, context), /GENERATION_DRAFT_SHORT_OUTLINE_ALREADY_ATTEMPTED/)
      for (const messageIndex of [0, 1]) {
        const changed = structuredClone(firstPlan.expected.initialDraftTask)
        changed.messages[messageIndex].content += '\n改变原提示身份'
        await assert.rejects(invoke(session.page, 'generation:execute', { handle: resumed.handle, invocationNonce: randomUUID(),
          task: changed }, context), /GENERATION_MATERIAL_PROMPT_MISMATCH/)
      }
      assertShortOutlineRecovery(await invoke(session.page, 'generation:read-context', { handle: resumed.handle }, context), firstPlan.expected, true)
      saved = await invoke(session.page, 'generation:commit-draft', firstCommit, context)
      assert.equal(saved.content, visibleText)
      assert.equal(saved.version, 1)
      results.push({ name: 'reopen-after-prose-protects-identity-and-saves', outcome: 'PASS', sameRun: true,
        noNewDispatch: true, changedSystemAndUserRejected: true, originalDraftTaskHash: hash(JSON.stringify(firstPlan.expected.initialDraftTask)) })
    } finally { await close(session) }
    assert.equal(syntheticDispatches, 2)

    session = await launch(['outline', 'prose'])
    try {
      const opened = await invoke(session.page, 'project:open', projectPath, randomUUID())
      assert.equal(opened.success, true, opened.error)
      const context = { projectId, projectPath, leaseId: opened.project.sessionLease }
      assert.deepEqual(await invoke(session.page, 'generation:commit-draft', firstCommit, context), saved)
      assert.deepEqual((await invoke(session.page, 'generation:read-context', { handle: firstCommit.handle }, context)).savedDraft, saved)
      const prepared = await prepare(session.page, context, 2, [saved.id])
      assert.equal(prepared.prepared.selectedDrafts[0].contentHash, saved.contentHash)
      const secondCommit = await generate(session.page, context, await plan(session.page, context, prepared))
      const changed = await invoke(session.page, 'kb:import-text', '作者修订：灯塔位于旧城东岸。', '合成灯塔资料.md', projectPath, context)
      assert.equal(changed.success, true, changed.error)
      await assert.rejects(invoke(session.page, 'generation:commit-draft', secondCommit, context), /GENERATION_KNOWLEDGE_SOURCE_STALE/)
      assert.deepEqual(await invoke(session.page, 'generation:commit-draft', firstCommit, context), saved)
      assert.ok((await invoke(session.page, 'generation:read', secondCommit.handle, context)).candidates.some(candidate => candidate.text === visibleText))
      assert.equal((await invoke(session.page, 'db:draft-list-all', projectPath, context)).length, 1)
      results.push({ name: 'saved-receipt-replay-and-changed-knowledge-refusal', outcome: 'PASS', oneDraftVersion: true, conflictCandidatePreserved: true })
    } finally { await close(session) }
    assert.equal(syntheticDispatches, 4)
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ outcome: 'PASS', physicalModelRequests: 0, syntheticDispatches,
      scope: 'Built Electron public IPC with real SQLite and LanceDB; not a full writing UI or model-quality qualification', results }, null, 2))
    process.stdout.write(JSON.stringify({ outcome: 'PASS', scenarios: results.length, physicalModelRequests: 0, syntheticDispatches,
      root, evidence: path.join(root, 'evidence.json') }) + '\n')
  } catch (error) {
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ outcome: 'FAIL', physicalModelRequests: 0, syntheticDispatches, results,
      error: error instanceof Error ? error.message : 'Unknown failure' }, null, 2))
    throw error
  }
}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
