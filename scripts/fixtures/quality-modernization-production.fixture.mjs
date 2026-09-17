import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { test, vi } from 'vitest'
import { updateLedger } from '../quality-modernization-run.mjs'
import { selectOwnerDispatch } from '../quality-modernization-driver.mjs'

// This adapter replaces the Electron transport, never a command/runtime/repository.
// The final provider fetch is the sole synthetic/real response switch.
const transport = vi.hoisted(() => ({ handlers: new Map(), listeners: new Map(), sender: null }))
vi.mock('electron', () => ({
  ipcMain: { handle: (name, handler) => { if (transport.handlers.has(name)) throw new Error(`DUPLICATE_IPC:${name}`); transport.handlers.set(name, handler) } },
  app: { getLocale: () => 'zh-CN', getPath: () => process.env.QUALITY_USER_DATA, isPackaged: false },
  BrowserWindow: { getAllWindows: () => transport.sender ? [{ webContents: transport.sender }] : [],
    fromWebContents: () => ({ webContents: transport.sender }) },
  dialog: {}, shell: {}, nativeImage: {},
}))
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const templateKeys = ['chapter_blueprint_chunk', 'first_chapter_draft']

test('isolated production commands persist both early-budget operations', async () => {
  const request = json(process.env.QUALITY_BRIDGE_REQUEST)
  const target = request.target
  const source = json(request.semanticPath)
  const scene = source.scenes[0]
  const load = relative => import(/* @vite-ignore */ pathToFileURL(path.join(target.repositoryRoot, relative)).href)
  const receipt = { schemaVersion: 1, arm: target.arm, mode: request.mode, action: request.action,
    qualification: request.development ? 'development-only-unfrozen' : 'frozen-target', codeSha: target.codeSha,
    runtime: { node: process.version, abi: process.versions.modules }, physicalModelRequests: 0, syntheticDispatches: 0,
    invocations: [], attempts: [], operations: [], status: 'running' }
  const candidate = target.arm === 'candidate'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('NETWORK_OUTSIDE_PHYSICAL_BOUNDARY') }
  let database, projectAccess, currentContext, currentOperation, sourceParity
  let secret = null
  const safeDiagnostic = value => request.mode === 'real'
    ? 'REAL_PROVIDER_DIAGNOSTIC_REDACTED' : String(value ?? '')
  const streamSettlements = []
  try {
    if (candidate) {
      const locator = await load('electron/services/app-data-locator.ts')
      locator.installGlobalDataLocator(target.roots.config, 'quality-isolated-generation-v1', target.roots.legacySource)
    }
    database = await load('electron/database.ts')
    ;({ projectAccess } = await load('electron/services/project-access.ts'))
    const projectFile = path.join(target.isolationRoot, 'physical-project.json')
    let project
    if (request.action === 'prepare') {
      assert.equal(fs.existsSync(projectFile), false, 'PHYSICAL_FIXTURE_ALREADY_EXISTS')
      project = projectAccess.createProject(target.roots.project, scene.title)
      if (candidate) database.createProjectDatabase(project.rootPath, Buffer.alloc(32, 7))
      database.initProjectDatabase(project.rootPath, Buffer.alloc(32, 7))
      save(projectFile, project)
    } else {
      project = json(projectFile)
      database.initProjectDatabase(project.rootPath, Buffer.alloc(32, 7))
      assert.deepEqual(projectAccess.probeExistingProject(project.rootPath), project)
    }
    const db = database.getProjectDb()
    assert.equal(db.prepare('SELECT 1').pluck().get(), 1)
    const lease = projectAccess.beginSession(project)
    const session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
    const sender = { id: 701, isDestroyed: () => false, send: (channel, ...args) => {
      for (const listener of transport.listeners.get(channel) ?? []) listener(...args)
    } }
    transport.sender = sender
    const invoke = async (channel, ...args) => {
      receipt.invocations.push(channel)
      const handler = transport.handlers.get(channel)
      if (!handler) throw new Error(`UNREGISTERED_PRODUCTION_IPC:${channel}`)
      try { return await handler({ sender }, ...args) }
      catch (error) { (receipt.ipcFailures ??= []).push({ channel, error: safeDiagnostic(error.message) }); throw error }
    }
    const api = { invoke, on: (channel, listener) => {
      if (!transport.listeners.has(channel)) transport.listeners.set(channel, new Set())
      transport.listeners.get(channel).add(listener)
      return () => transport.listeners.get(channel).delete(listener)
    } }
    vi.stubGlobal('window', { aiNovelAPI: api, velaAPI: api, addEventListener() {}, removeEventListener() {} })
    let model = { id: 'quality-preregistered-model', name: '预注册合成验证模型', ...source.modelParameters,
      apiKey: 'synthetic-quality-never-network', baseUrl: `https://${source.modelParameters.endpointHost}/v1`, purposes: ['generation'] }
    delete model.parameterStatus
    if (request.mode === 'real') {
      if (request.development || !target.modelId) throw new Error('FROZEN_SAFE_MODEL_REQUIRED')
      model = json(path.join(target.roots.config, 'models.json')).find(value => value.id === target.modelId)
      if (!model || typeof model.apiKey !== 'string' || !model.apiKey) throw new Error('SAFE_MODEL_UNAVAILABLE')
      secret = model.apiKey
      for (const key of ['provider', 'protocol', 'modelName', 'temperature', 'maxTokens']) assert.equal(model[key], source.modelParameters[key], 'MODEL_PARAMETER_MISMATCH')
      assert.equal(new URL(model.baseUrl).host, source.modelParameters.endpointHost)
    } else if (request.mode !== 'synthetic') throw new Error('INVALID_PROVIDER_MODE')
    if (request.action === 'prepare' && request.mode === 'synthetic') {
      save(path.join(target.roots.config, 'models.json'), [model])
      save(path.join(target.roots.config, 'config.json'), { defaultModelId: model.id, theme: 'dark', locale: 'zh-CN' })
    }
    const llm = (await load('electron/controllers/llm-controller.ts')).registerLLMController()
    if (candidate) (await load('electron/controllers/generation-controller.ts')).registerGenerationController(llm)
    ;(await load('electron/controllers/db-controller.ts')).registerDatabaseController()
    ;(await load('electron/controllers/fs-controller.ts')).registerFSController()
    ;(await load('electron/controllers/app-data-controller.ts')).registerAppDataController()
    ;(await load('electron/controllers/kb-controller.ts')).registerKBController()

    const config = { genre: '悬疑', targetAudience: '通用', totalChapters: 3, wordsPerChapter: 900,
      writingLanguage: 'zh-CN', creativeStrategy: 'auto', globalGuidance: source.template,
      coreOutline: scene.material, worldSetting: scene.material, protagonistProfile: scene.characters.join('\n'),
      plotStructure: 'three_act', narrativePov: 'third_limited', writingStyle: '' }
    const projectStore = (await load('src/stores/project-store.ts')).useProjectStore
    projectStore.setState({ currentProject: { id: project.projectId, path: project.rootPath, name: scene.title,
      sessionLease: lease.leaseId, novelConfig: config } })
    const llmStore = (await load('src/stores/llm-store.ts')).useLLMStore
    llmStore.setState({ defaultModelId: model.id, models: [model] })
    const prompts = await load('src/services/prompt-templates.ts')
    if (request.action === 'prepare') {
      let templates
      if (!candidate) {
        templates = templateKeys.map(key => structuredClone(prompts.getPromptTemplate(key)))
        assert.ok(templates.every(template => template?.content && template.key))
        save(request.templatesPath, { baselineSha: target.codeSha, templates })
      } else templates = json(request.templatesPath).templates
      fs.mkdirSync(path.join(target.roots.config, 'prompts'), { recursive: true })
      for (const template of templates) save(path.join(target.roots.config, 'prompts', `${template.key}.json`), template)
      const columns = { id: 'main', project_name: scene.title, genre: config.genre, target_audience: config.targetAudience,
        total_chapters: 3, words_per_chapter: 900, writing_language: 'zh-CN', global_guidance: source.template,
        core_outline: scene.material, world_setting: scene.material, protagonist_profile: config.protagonistProfile,
        premise: scene.material, worldbuilding: scene.material, characters_arch: '',
        synopsis: scene.chapters.map(chapter => `第${chapter.number}章：${chapter.brief}`).join('\n') }
      db.prepare(`INSERT INTO project_core (${Object.keys(columns).join(',')}) VALUES (${Object.keys(columns).map(() => '?').join(',')})`).run(...Object.values(columns))
      for (const chapter of scene.chapters.slice(1)) db.prepare('INSERT INTO blueprints(chapter_number,title,role,purpose,key_events,characters,user_guidance) VALUES(?,?,?,?,?,?,?)')
        .run(chapter.number, `作者预置第${chapter.number}章`, '发展', chapter.brief, chapter.requiredEvents.join('；'), JSON.stringify(scene.characters), source.template)
    }
    const core = db.prepare('SELECT project_name,genre,target_audience,total_chapters,words_per_chapter,writing_language,global_guidance,core_outline,world_setting,protagonist_profile,premise,worldbuilding,characters_arch,synopsis FROM project_core WHERE id=?').get('main')
    const physicalTemplates = []
    for (const key of templateKeys) physicalTemplates.push(await prompts.resolvePromptTemplate(key, session, 'zh-CN'))
    const expectedTemplates = json(request.templatesPath).templates
    assert.deepEqual(physicalTemplates, expectedTemplates, 'ACTUAL_TEMPLATE_PARITY_FAILED')
    receipt.promptMapping = { baselineSha: json(request.templatesPath).baselineSha,
      guidanceHash: sha(source.template), templates: physicalTemplates.map(template => ({ key: template.key,
        templateHash: sha(template), contentHash: sha(template.content) })) }
    const actualModel = (await invoke('llm:list-models')).find(value => value.id === model.id)
    assert.ok(actualModel)
    const safeModel = Object.fromEntries(['provider', 'protocol', 'modelName', 'temperature', 'maxTokens', 'baseUrl'].map(key => [key, actualModel[key]]))
    const authorBlueprints = db.prepare('SELECT chapter_number,title,role,purpose,key_events,characters,user_guidance FROM blueprints WHERE chapter_number>1 ORDER BY chapter_number').all()
    const skillBindings = await (await load('src/services/agent/writing-skill-bindings.ts')).loadWritingSkillBindings(session)
    assert.deepEqual(skillBindings.bindings, {}, 'UNREGISTERED_WRITING_SKILL')
    sourceParity = { core, authorBlueprints, model: safeModel, templates: physicalTemplates, skills: skillBindings.bindings,
      semanticHash: sha(source), guidanceHash: sha(source.template) }
    receipt.physicalProject = { path: project.rootPath, dbPath: db.name, projectId: project.projectId,
      format: candidate ? 'canonical' : 'legacy', parityHash: sha(sourceParity), readback: sourceParity }
    if (request.action === 'prepare') { receipt.status = 'prepared'; return }
    assert.equal(sha(sourceParity), request.parityHash, 'PHYSICAL_PROJECT_PARITY_CHANGED')

    const physicalFetch = async (url, options) => {
      assert.equal(new URL(String(url)).host, source.modelParameters.endpointHost, 'UNREGISTERED_PROVIDER_HOST')
      assert.equal(new URL(String(url)).pathname, '/v1/chat/completions', 'UNREGISTERED_PROVIDER_PATH')
      const body = JSON.parse(options.body)
      assert.equal(body.model, source.modelParameters.modelName)
      assert.equal(body.temperature, source.modelParameters.temperature)
      assert.ok(currentContext && currentOperation, 'PHYSICAL_REQUEST_OUTSIDE_COMMAND')
      let actual
      if (candidate) {
        actual = selectOwnerDispatch(db, currentContext.mainGenerationRunHandle, session, body)
      }
      const attemptId = `${target.arm}:${actual?.attemptId ?? randomUUID()}`
      const binding = { campaignId: 'novel-quality-program-v3-80-v1', mode: request.mode, arm: target.arm,
        codeSha: target.codeSha, sourceHash: target.sourceHash, driverHash: request.driverHash,
        parityId: request.parityHash, phase: 'early-budget', milestone: request.milestone, caseId: '场景1/1',
        operation: currentOperation, ...(actual ? { actual } : {}) }
      const record = event => updateLedger(request.ledgerPath, event, { campaignMode: request.mode })
      record({ type: 'reserve', attemptId, binding })
      record({ type: 'dispatch', attemptId })
      const requestReceipt = { attemptId, binding, requestedOutputTokens: body.max_tokens ?? body.max_completion_tokens,
        compiledPromptHash: sha(body.messages), systemPromptHash: sha(body.messages.filter(message => message.role === 'system')) }
      receipt.attempts.push(requestReceipt)
      try {
        if (request.mode === 'synthetic') receipt.syntheticDispatches++
        else receipt.physicalModelRequests++
        const text = currentOperation === 'directory' ? JSON.stringify({ blueprints: [{ chapterNumber: 1, title: '旧港异常', role: '开篇',
          purpose: scene.chapters[0].brief, keyEvents: scene.chapters[0].requiredEvents.join('；'), characters: scene.characters,
          relationships: [], suspenseHook: '记录为何与旧钟不符', userGuidance: source.template }] })
          : Array.from({ length: 22 }, (_, index) => `清晨，林澄核对第${index + 1}行登记，发现日期异常。他握紧铜钥匙，与沈岸商定雨停后到现场核查。`).join('\n')
        const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
        const response = request.mode === 'synthetic' ? new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }) : await originalFetch(url, options)
        if (!response.ok || !response.body) throw new Error('PROVIDER_HTTP_FAILED')
        const [providerBody, ledgerBody] = response.body.tee()
        streamSettlements.push((async () => {
          let finishReason = null, buffer = '', interrupted = false, malformed = false
          const reader = ledgerBody.getReader(), decoder = new TextDecoder()
          try {
            for (;;) {
              const next = await reader.read()
              if (next.done) break
              buffer += decoder.decode(next.value, { stream: true })
              const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
              for (const line of lines) {
                if (!line.startsWith('data:') || line.includes('[DONE]')) continue
                try { const event = JSON.parse(line.slice(5)); const reason = event.choices?.[0]?.finish_reason
                  if (typeof reason === 'string' && reason) finishReason = reason
                } catch { malformed = true }
              }
            }
          } catch { interrupted = true }
          finally { reader.releaseLock() }
          record({ type: finishReason && !interrupted && !malformed ? 'settle' : 'unknown', attemptId, ...(finishReason ? { finishReason } : {}) })
        })())
        if (request.mode === 'synthetic') requestReceipt.visibleTextHash = sha(text)
        return new Response(providerBody, { status: response.status, statusText: response.statusText, headers: response.headers })
      } catch (error) { record({ type: 'unknown', attemptId }); throw error }
    }
    globalThis.fetch = async (...args) => {
      try { return await physicalFetch(...args) }
      catch (error) { (receipt.fetchFailures ??= []).push(safeDiagnostic(error.message)); throw error }
    }
    const callbacks = { log(text) { (receipt.diagnostics ??= []).push(safeDiagnostic(text)) }, setProgress() {}, appendText() {}, onChunk() {} }
    for (const operation of ['directory', 'draft']) {
      currentOperation = operation
      currentContext = { runId: randomUUID(), projectPath: project.rootPath, projectSession: session, writingLanguage: 'zh-CN',
        uiLocale: 'zh-CN', generationModelId: model.id, data: { architecture: scene.material, existingBlueprints: [] }, cancelled: false }
      const params = { context: currentContext, callbacks, step: { id: operation, title: operation } }
      const command = operation === 'directory'
        ? new (await load('src/services/workflows/commands/directory.command.ts')).GenerateDirectoryCommand(
          { mode: 'append', startChapter: 1, count: 1 }, { expectedProjectPath: project.rootPath, novelConfig: config })
        : new (await load('src/services/workflows/commands/generate-draft.command.ts')).GenerateDraftCommand({
          projectPath: project.rootPath, chapterNumber: 1, title: '旧港异常', wordsTarget: 900, characters: scene.characters,
          keyEvents: scene.chapters[0].requiredEvents.join('；'), userGuidance: source.template })
      const result = await command.execute(params)
      await Promise.all(streamSettlements)
      assert.deepEqual(db.prepare('SELECT chapter_number,title,role,purpose,key_events,characters,user_guidance FROM blueprints WHERE chapter_number>1 ORDER BY chapter_number').all(), authorBlueprints, 'OUTSIDE_RANGE_REWRITTEN')
      const outputPath = path.join(target.isolationRoot, operation === 'draft' ? 'draft.txt' : 'directory.json')
      fs.writeFileSync(outputPath, typeof result === 'string' ? result : JSON.stringify(result, null, 2))
      receipt.operations.push({ operation, outputHash: sha(result), outputPath, handle: currentContext.mainGenerationRunHandle ?? null })
    }
    const draft = db.prepare('SELECT d.*,c.body AS content FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=1 ORDER BY d.version DESC').all()
    assert.equal(draft.length, 1, 'ACTUAL_DRAFT_NOT_SAVED')
    const units = (await load('src/shared/draft-units.ts')).countDraftUnits(draft[0].content)
    assert.ok(units >= 720 && units <= 1080, `TARGET_UNITS_FAILED:${units}`)
    receipt.saved = { draftId: draft[0].id, version: draft[0].version, contentHash: sha(draft[0].content), units,
      blueprintChapterNumbers: db.prepare('SELECT chapter_number FROM blueprints ORDER BY chapter_number').all().map(row => row.chapter_number) }
    if (candidate) {
      receipt.ownerTerminal = db.prepare('SELECT a.attempt_id,a.attempt_json,a.usage_receipt_json,g.artifact_json FROM generation_attempts a JOIN generation_artifacts g ON g.attempt_id=a.attempt_id ORDER BY a.rowid').all()
        .map(row => { const usage = JSON.parse(row.usage_receipt_json), artifact = JSON.parse(row.artifact_json)
          return { attemptId: row.attempt_id, status: JSON.parse(row.attempt_json).status, finishReason: usage.result?.finishReason,
            trustedUsage: usage.result?.usage?.trusted === true, artifactId: artifact.artifactId, textHash: sha(artifact.text),
            hasFormalEffect: Boolean(usage.directoryProgress || usage.draftCommit) } })
      for (const attempt of receipt.attempts) {
        const terminal = receipt.ownerTerminal.find(row => row.attemptId === attempt.binding.actual.attemptId)
        assert.ok(terminal && ['settled', 'unknown'].includes(terminal.status))
        assert.equal(terminal.finishReason, 'stop'); assert.equal(terminal.hasFormalEffect, true)
        if (request.mode === 'synthetic') assert.equal(terminal.textHash, attempt.visibleTextHash)
      }
    }
    receipt.status = 'passed'
  } catch (error) {
    receipt.status = 'failed'; receipt.error = safeDiagnostic(error.message)
    throw request.mode === 'real' ? new Error('REAL_PRODUCTION_BRIDGE_FAILED') : error
  } finally {
    await Promise.allSettled(streamSettlements)
    globalThis.fetch = originalFetch
    database?.closeProjectDatabase(); projectAccess?.invalidateCurrentSession()
    vi.unstubAllGlobals()
    const serialized = JSON.stringify(receipt, null, 2) + '\n'
    fs.writeFileSync(request.receiptPath, secret ? serialized.split(secret).join('[REDACTED]') : serialized)
  }
}, 120_000)
