import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { productionScenario, fullExecutionSchedule, runProductionPhasePair, executionRecordIdentity,
  QUALIFICATION_STAGE_MODELS, qualificationModelForOperation, assertForwardReasoning, copyIsolatedRealModelConfig,
  createOperationDispatchGate, reviewLengthRecoveryFor, scenarioAuthorSetting, R3_NATIVE_REVISION_DIAGNOSTIC, modelConfigurationHash,
  selectOwnerDispatch, SAVED_NATIVE_REVIEW_DIAGNOSTIC } from '../quality-modernization-driver.mjs'
import { ROOT, validatePair, candidateBatchSlots, assertCandidateSlotAvailable, aggregateCandidateJudgments, selectPhase, hash, adjudicateCandidateBatch,
  forwardReasoningFor, forwardQualificationWindowFor, buildFixtureExports, currentProtocolBinding } from '../quality-modernization-run.mjs'
import { targetUnitRange } from '../quality-modernization-receipt.mjs'
import { buildMainGenerationPlan, MAIN_GENERATION_POLICY } from '../../electron/services/main-generation-plan'
import { resolveModelExecutionCapabilityEvidence } from '../../electron/services/model-execution-lease'
import { resolveReasoningPolicy } from '../../src/shared/reasoning-policy'
import { OpenAIProvider } from '../../electron/llm/openai-provider'

const revision = 's14b-candidate-only-three-rounds-v1'

test('formal review admits the native same-purpose replacement after settled empty LENGTH', () => {
  const directory = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/formal-review-length-'))
  try {
    const scenario = productionScenario('full', 'final', revision), operation = scenario.attemptPolicy.reviewRebuild.operationId
    const source = { draftId: 1, version: 1, contentHash: 'a'.repeat(64) }
    const first = { attemptId: 'first', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch', purpose: 'review-chapter' }
    const outputPath = path.join(directory, 'empty.txt'); fs.writeFileSync(outputPath, '')
    const attempt = { attemptId: 'candidate:first', outputPath, visibleTextHash: hash(''), binding: { operation, actual: first, reviewSource: source } }
    const evidence = {
      attempt, ownerArtifactHash: hash(''), reviewReportAbsent: true,
      events: [{ type: 'reserve', attemptId: attempt.attemptId, binding: attempt.binding },
        { type: 'dispatch', attemptId: attempt.attemptId }, { type: 'settle', attemptId: attempt.attemptId, finishReason: 'length' }],
    }
    const create = (proof = evidence) => createOperationDispatchGate({ repairPolicy: scenario.attemptPolicy, readPrimaryEvidence: () => proof })
    const gate = create()
    gate(operation, first, source)
    assert.doesNotThrow(() => gate(operation, { ...first, attemptId: 'replacement' }, source))
    assert.throws(() => gate(operation, { ...first, attemptId: 'third' }, source), /MODEL_REQUEST_REJECTED/)
    for (const proof of [{ ...evidence, events: evidence.events.slice(0, 2) },
      { ...evidence, events: evidence.events.map(row => row.type === 'settle' ? { ...row, finishReason: 'unknown' } : row) },
      { ...evidence, ownerArtifactHash: hash('wrong') }, { ...evidence, reviewReportAbsent: false }]) {
      const rejected = create(proof); rejected(operation, first, source)
      assert.throws(() => rejected(operation, { ...first, attemptId: 'replacement' }, source), /MODEL_REQUEST_REJECTED/)
    }
    const drift = create(); drift(operation, first, source)
    assert.throws(() => drift(operation, { ...first, attemptId: 'replacement' }, { ...source, version: 2 }), /MODEL_REQUEST_REJECTED/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('forward formal review recovery preserves old scenarios, author input and every planned budget', () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')))
  for (const [phase, milestone, minimum, maximum] of [['c16-c18', 'final', 20, 84], ['full', 'final', 30, 180],
    ['early-budget', 'post-ui', 4, 20], ['early-context', 'post-ui', 3, 17], ['early-review', 'post-ui', 1, 8]]) {
    const scenario = selectPhase(protocol, phase, milestone), old = productionScenario(phase, milestone)
    assert.deepEqual([scenario.minimumCalls, scenario.maximumPlannedCalls], [minimum, maximum])
    assert.equal(scenario.evaluationPolicy.physicalRequests.manuscriptMaximum, 8)
    const receipt = { ...scenario, arm: 'candidate', protocolRevision: revision }
    for (const operation of scenario.operations.filter(item => ['review', 'final-review'].includes(item.kind))) {
      assert.equal(reviewLengthRecoveryFor(receipt, operation.id)?.maxLengthReplacements, 1)
      assert.equal(reviewLengthRecoveryFor({ ...receipt, scenarioRevision: scenario.scenarioRevision.replace(/v2$/, 'v1') }, operation.id), null)
      assert.equal(reviewLengthRecoveryFor({ ...receipt, arm: 'baseline' }, operation.id), null)
    }
    for (const policy of [old.attemptPolicy, old.attemptPolicy.reviewRebuild, old.attemptPolicy.finalReviewRebuild].filter(Boolean))
      assert.equal(policy.maxLengthReplacements, undefined)
    const scene = { material: '原作者设定', scenarioAuthorSettingLines: { 's14b-post-ui-reviewed-budget-review-rebuild-must-show-v2': ['【第1章必现】原作者目标'] } }
    assert.equal(scenarioAuthorSetting(scene, scenario.scenarioRevision), scenarioAuthorSetting(scene, scenario.scenarioRevision.replace(/v2$/, 'v1')))
  }
})

test('formal operations use one official Flash profile and native wire without changing windows', () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')))
  assert.deepEqual(protocol.forwardStageModels, QUALIFICATION_STAGE_MODELS)
  const provider = new OpenAIProvider(), messages = [{ role: 'user', content: 'offline parameter preview' }]
  for (const { phase, milestone } of QUALIFICATION_STAGE_MODELS.scopes) {
    const scenario = selectPhase(protocol, phase, milestone), registration = forwardReasoningFor(protocol, phase, milestone)
    assert.equal(forwardQualificationWindowFor(protocol, phase, milestone).revision, 'native-budget-aligned-qualification-window-v5')
    for (const operation of scenario.operations) {
      const profile = qualificationModelForOperation(phase, milestone, operation.id)
      const review = ['review', 'refine', 'final-review'].includes(operation.kind)
      assert.equal(profile, QUALIFICATION_STAGE_MODELS.profiles.flash)
      const model = { ...profile.model, apiKey: 'synthetic-never-network' }
      const capabilityEvidence = resolveModelExecutionCapabilityEvidence(model)
      const plan = buildMainGenerationPlan(model, { capabilityEvidence }, { purpose: review ? 'review-chapter' : 'chapter-draft',
        output: review ? 'structured-data' : 'visible-text', messages, reasoningStage: review ? 'review' : 'general' },
      { policy: MAIN_GENERATION_POLICY.budget, attempts: [] }, 'auto')
      const body = provider.buildRequestBody(model, messages, plan.options, true)
      const resolution = resolveReasoningPolicy({ model, creativeStrategy: 'auto', stage: 'general' })
      const input = { arm: 'candidate', phase, milestone, caseId: scenario.caseIds[0], operationId: operation.id,
        model, body, resolution, creativeStrategy: 'auto' }
      assert.equal(assertForwardReasoning(registration, input).effective, 'high')
      assert.equal(body.model, profile.model.modelName)
      assert.equal(body.max_tokens, 32768)
      assert.equal(body.temperature, 0)
      assert.deepEqual(body.thinking, { type: 'enabled' })
      assert.equal(body.reasoning_effort, 'high')
      assert.equal(body.enable_thinking, undefined)
      assert.equal(body.thinking_budget, undefined)
      assert.throws(() => assertForwardReasoning(registration, { ...input,
        model: { ...model, modelName: 'Qwen/Qwen3.8-27B' } }), /CONFIGURATION_DRIFT/)
      assert.throws(() => assertForwardReasoning(registration, { ...input,
        body: { ...body, reasoning_effort: 'medium' } }), /WIRE_MISMATCH/)
    }
    assert.throws(() => qualificationModelForOperation(phase, milestone, 'unregistered'), /OPERATION_MODEL_MISSING/)
  }
  assert.throws(() => forwardReasoningFor({ ...protocol, forwardStageModels: undefined }, 'full', 'final'), /REGISTRATION_MISMATCH/)
})

test.each([
  ['chapter-draft-short-outline', 'planning', 500, 32768],
  ['chapter-draft', 'drafting', 900, 32768],
  ['chapter-draft-short-outline', 'planning', 500, 3000],
  ['chapter-draft', 'drafting', 900, 3000],
])('formal task output budgets admit %s at %s with %i units and a %i-token owner budget', (purpose, reasoningStage, requestedUnits, maxOutputPerRequest) => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')))
  const registration = forwardReasoningFor(protocol, 'full', 'final')
  const model = { ...QUALIFICATION_STAGE_MODELS.profiles.flash.model, apiKey: 'synthetic-never-network' }
  const task = { purpose, reasoningStage, output: 'visible-text', messages: [{ role: 'user', content: 'offline task budget preview' }],
    budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits, segmentable: false } }
  const plan = buildMainGenerationPlan(model, { capabilityEvidence: resolveModelExecutionCapabilityEvidence(model) }, task,
    { policy: { ...MAIN_GENERATION_POLICY.budget, maxOutputPerRequest }, attempts: [] }, 'auto')
  const body = new OpenAIProvider().buildRequestBody(model, task.messages, plan.options, true)
  const input = { arm: 'candidate', phase: 'full', milestone: 'final', caseId: '场景1/1', operationId: '连续章节正文',
    model, body, creativeStrategy: 'auto', resolution: resolveReasoningPolicy({ model, creativeStrategy: 'auto', stage: reasoningStage }) }
  assert.ok(plan.budgetDecision.requestedOutputTokens > 0 && plan.budgetDecision.requestedOutputTokens < model.maxTokens)
  assert.equal(plan.requestedOutputTokens, maxOutputPerRequest)
  assert.equal(body.max_tokens, plan.requestedOutputTokens)
  assert.equal(assertForwardReasoning(registration, input).effective, 'high')
  const completionBody = { ...body, max_tokens: undefined, max_completion_tokens: plan.requestedOutputTokens }
  assert.equal(assertForwardReasoning(registration, { ...input, body: completionBody }).effective, 'high')
  for (const max_tokens of [undefined, null, 0, -1, 1.5, String(plan.requestedOutputTokens), NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1, model.maxTokens + 1])
    assert.throws(() => assertForwardReasoning(registration, { ...input, body: { ...body, max_tokens } }), /R3_NATIVE_WIRE_MISMATCH/)
  assert.throws(() => assertForwardReasoning(registration, { ...input, model: { ...model, maxTokens: model.maxTokens - 1 } }),
    /QUALIFICATION_MODEL_CONFIGURATION_DRIFT/)
  const handle = { runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch' }
  const session = { projectId: handle.projectId, leaseId: handle.epoch }
  const row = { attempt_id: 'attempt', run_id: handle.runId, root_action_id: handle.rootActionId,
    binding_json: JSON.stringify(handle), usage_receipt_json: JSON.stringify({ purpose }),
    attempt_json: JSON.stringify({ attemptId: 'attempt', requestedOutputTokens: plan.requestedOutputTokens }) }
  const db = { prepare: () => ({ all: () => [row] }) }
  for (const wire of [body, completionBody])
    assert.deepEqual(selectOwnerDispatch(db, handle, session, wire), { ...handle, attemptId: 'attempt', purpose })
  assert.throws(() => selectOwnerDispatch(db, handle, session, { ...body, max_tokens: plan.requestedOutputTokens - 1 }),
    /OWNER_DISPATCH_IDENTITY_MISMATCH/)
})

test('formal config copying binds one shared profile and rejects drift before any request', () => {
  const root = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/stage-profiles-'))
  const destination = path.join(root, 'copy'); fs.mkdirSync(destination)
  const models = Object.values(QUALIFICATION_STAGE_MODELS.profiles).map(profile => ({ ...profile.model, apiKey: 'synthetic-never-network' }))
  const target = { roots: { config: root }, modelId: models[0].id, stageModels: QUALIFICATION_STAGE_MODELS }
  try {
    fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify(models))
    copyIsolatedRealModelConfig(target, { config: destination }, hash(QUALIFICATION_STAGE_MODELS.profiles))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, 'models.json'))), models)
    models[0].reasoningOverride = 'low'
    fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify(models))
    assert.throws(() => copyIsolatedRealModelConfig(target, { config: destination }, hash(QUALIFICATION_STAGE_MODELS.profiles)), /CONFIGURATION_DRIFT/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('candidate qualification freezes and schedules only its own implementation', () => {
  const candidate = { arm: 'candidate', codeSha: 'a'.repeat(40), subjectSha: 'a'.repeat(40),
    protocolRevision: revision, fixture: { format: 'canonical', semanticHash: 's', parametersHash: 'p' } }
  assert.doesNotThrow(() => validatePair({ candidate }, [{ roots: ['/candidate'] }]))
  assert.throws(() => validatePair({ candidate: { ...candidate, subjectSha: 'b'.repeat(40) } }, [{ roots: [] }]), /SUBJECT/)
  const order = { seed: 'program-v3-2026-09-13-fixed-v1', armsByChapter: Array(9).fill('candidate') }
  const steps = fullExecutionSchedule(order, revision)
  assert.equal(steps.length, 12)
  assert.equal(steps.filter(step => step.operation.kind === 'directory').length, 3)
  assert.ok(steps.every(step => step.arm === 'candidate'))
  assert.deepEqual(targetUnitRange(900, revision, 'candidate'), { minimum: 630, maximum: 1170 })
})

test('candidate qualification has native templates and a registered short outline for each draft path', () => {
  for (const [phase, milestone] of [['c16-c18', 'final'], ['full', 'final'], ['early-budget', 'post-ui'], ['early-context', 'post-ui'], ['early-review', 'post-ui']]) {
    const scenario = productionScenario(phase, milestone, revision)
    assert.deepEqual(scenario.arms, ['candidate'])
    assert.equal(scenario.templateSource, 'candidate-native')
    assert.equal(scenario.attemptPolicy.shortOutline.purpose, 'chapter-draft-short-outline')
    assert.deepEqual(scenario.attemptPolicy.shortOutline.operationIds,
      scenario.operations.filter(operation => operation.kind === 'draft').map(operation => operation.id))
  }
  assert.equal(productionScenario('full', 'final').templateSource, undefined)
})

test('fixed candidate batch keeps 30 case slots and cannot redraw a sent slot', () => {
  const slots = candidateBatchSlots()
  assert.equal(slots.length, 30)
  assert.equal(slots.filter(slot => slot.phase === 'c16-c18' && slot.caseId.startsWith('C16')).length, 9)
  assert.equal(slots.filter(slot => slot.phase === 'full').length, 9)
  assert.equal(new Set(slots.map(slot => `${slot.round}:${slot.slot}`)).size, 30)
  const binding = { sampling: { batchId: 'batch', round: 1, slot: slots[0].slot }, invocationId: 'first',
    codeSha: 'sha', sourceHash: 'source', protocolHash: 'protocol', driverHash: 'driver' }
  const rows = [{ binding }]
  assert.doesNotThrow(() => assertCandidateSlotAvailable(rows, binding))
  assert.throws(() => assertCandidateSlotAvailable(rows, { ...binding, invocationId: 'second' }), /SLOT_ALREADY_SENT/)
  assert.throws(() => assertCandidateSlotAvailable(rows, { ...binding, sourceHash: 'changed' }), /BATCH_DRIFT/)
  assert.doesNotThrow(() => assertCandidateSlotAvailable(rows, { ...binding, invocationId: 'second', sampling: { ...binding.sampling, round: 2 } }))
})

test('batch success preserves each failure and enforces both subgroup and silent-error limits', () => {
  const decisions = candidateBatchSlots().map(slot => ({ ...slot, technical: 'passed', integrity: 'passed',
    outcome: 'success', silentHardConstraint: false, silentOther: false, unresolvedCritical: false }))
  const change = (slots, caseId, round, fields) => slots.map(slot => slot.caseId === caseId && slot.round === round ? { ...slot, ...fields } : slot)
  let allowed = change(decisions, 'C17-A', 1, { outcome: 'failure', silentOther: true })
  allowed = change(allowed, 'C18-A', 2, { outcome: 'failure' })
  allowed = change(allowed, '场景1/1', 1, { outcome: 'failure' })
  allowed = change(allowed, 'C16-A', 1, { outcome: 'minor-omission' })
  const verdict = aggregateCandidateJudgments(allowed)
  assert.equal(verdict.status, 'passed')
  assert.equal(verdict.writing.success, 18)
  assert.equal(verdict.extraction.success, 8)
  assert.equal(allowed.filter(slot => slot.outcome === 'failure').length, 3)
  assert.equal(aggregateCandidateJudgments(change(allowed, 'C17-B', 3, { outcome: 'failure' })).status, 'failed')
  assert.equal(aggregateCandidateJudgments(change(allowed, 'C18-B', 3, { silentHardConstraint: true })).status, 'failed')
  assert.equal(aggregateCandidateJudgments(change(allowed, 'C16-B', 1, { integrity: 'failed' })).status, 'failed')
  assert.equal(aggregateCandidateJudgments(change(allowed, 'C17-B', 3, { unresolvedCritical: true })).status, 'inconclusive')
  assert.throws(() => aggregateCandidateJudgments(allowed.slice(1)), /DENOMINATOR/)
})

test('candidate round resumes unsent cases, retains failed cases and never replays interrupted sends', () => {
  const root = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/candidate-resume-test-'))
  try {
    const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')))
    const scenario = selectPhase(protocol, 'c16-c18', 'final')
    const target = { arm: 'candidate', protocolRevision: revision, protocolHash: 'a'.repeat(64),
      isolationRoot: path.join(root, 'c'), roots: { project: path.join(root, 'p') } }
    const options = { ...scenario, phase: 'c16-c18', mode: 'synthetic', development: true,
      protocolRevision: revision, protocolHash: target.protocolHash, invocationId: randomUUID(),
      semanticPath: path.join(ROOT, protocol.fixturePath), ledgerPath: path.join(root, 'synthetic-ledger.jsonl'),
      executionRecordPath: path.join(root, 'execution.json'), templatesPath: path.join(root, 'templates.json') }
    const sent = []
    const bridge = request => request.action === 'prepare' ? { physicalProject: { projectId: 'project', parityHash: 'b'.repeat(64) } }
      : (sent.push(request.caseId), { status: 'failed', code: 'MODEL_TIMEOUT', mode: 'synthetic',
        physicalProject: { projectId: 'project' }, syntheticDispatches: 1, physicalModelRequests: 0 })
    const first = runProductionPhasePair({ candidate: target }, options, bridge)
    assert.equal(first.results.length, 7)
    assert.equal(sent.length, 7)
    const record = JSON.parse(fs.readFileSync(options.executionRecordPath))
    delete record.results['C16-A']; delete record.results['C18-B']
    fs.writeFileSync(options.executionRecordPath, JSON.stringify(record))
    fs.writeFileSync(options.ledgerPath, JSON.stringify({ type: 'reserve', attemptId: 'sent', binding: {
      invocationId: options.invocationId, caseId: 'C16-A', operation: scenario.operations[0].id } }) + '\n')
    const resumed = runProductionPhasePair({ candidate: target }, options, bridge)
    assert.equal(sent.length, 8)
    assert.equal(sent.at(-1), 'C18-B')
    assert.equal(resumed.results[0].code, 'SENT_STEP_OUTCOME_UNKNOWN')
    assert.equal(resumed.results.length, 7)
    assert.ok(resumed.caseOutcomes.every(item => item.status === 'failed'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('adjudication binds all terminal states to the batch and only arbitrates disputed fields', () => {
  const root = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/candidate-adjudication-test-'))
  try {
    const protocolBytes = fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json'))
    const protocol = JSON.parse(protocolBytes), batchPath = path.join(root, 'batch.json'), reviewsPath = path.join(root, 'reviews.json')
    const batch = { batchId: randomUUID(), protocolHash: hash(protocolBytes), protocolRevision: revision,
      subjectSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), modelConfigurationHash: 'c'.repeat(64),
      slots: candidateBatchSlots(), samplingPolicy: protocol.candidateOnlyQualification.sampling,
      executions: [{ phase: 'c16-c18', round: 1 }, { phase: 'c16-c18', round: 2 }, { phase: 'c16-c18', round: 3 },
        { phase: 'full', round: 1 }].map(item => ({ ...item, invocationId: randomUUID() })) }
    fs.writeFileSync(batchPath, JSON.stringify(batch))
    const batchHash = hash(fs.readFileSync(batchPath)), records = [], cases = []
    const schedule = fullExecutionSchedule(protocol.candidateOnlyQualification.order, revision)
    for (const execution of batch.executions) {
      const sampling = { batchId: batch.batchId, batchPath: fs.realpathSync(batchPath), batchHash,
        modelConfigurationHash: batch.modelConfigurationHash, round: execution.round }
      const record = { identity: executionRecordIdentity({ ...execution, protocolHash: batch.protocolHash, sampling, mode: 'real' }), results: {} }
      for (const slot of batch.slots.filter(item => item.phase === execution.phase && item.round === execution.round)) {
        const result = { status: slot.phase === 'full' ? 'not-run' : 'failed', code: 'SENT_STEP_OUTCOME_UNKNOWN',
          caseId: slot.caseId, phase: slot.phase, mode: 'real', arm: 'candidate', invocationId: execution.invocationId,
          protocolHash: batch.protocolHash, protocolRevision: revision, codeSha: batch.subjectSha, sourceHash: batch.sourceHash,
          sampling: { ...sampling, slot: slot.slot } }
        const key = slot.phase === 'c16-c18' ? slot.caseId : String(schedule.findIndex(item => item.caseId === slot.caseId && item.operation.kind === 'draft'))
        record.results[key] = result
        cases.push({ ...slot, outcome: 'failure', integrity: 'passed', firstDraft: 'fail', autonomousDetection: 'insufficient',
          severeFalsePositive: false, revisionIntroducedDefect: false, finalQuality: 'fail', silentHardConstraint: true,
          silentOther: false, unresolvedCritical: false, evidenceHash: hash(result), evidence: 'fixture terminal receipt' })
      }
      const file = `${batchPath}.${execution.phase}.round-${execution.round}.execution.json`
      fs.writeFileSync(file, JSON.stringify(record)); records.push({ file, record })
    }
    const reviews = { batchId: batch.batchId, batchHash, reviewers: [{ id: 'one', cases }, { id: 'two', cases: structuredClone(cases) }] }
    fs.writeFileSync(reviewsPath, JSON.stringify(reviews))
    assert.equal(adjudicateCandidateBatch(batchPath, reviewsPath).decisions.length, 30)
    const { file, record } = records[0], result = record.results['C16-A']
    const tamper = (object, key, value) => {
      const original = object[key]; object[key] = value; fs.writeFileSync(file, JSON.stringify(record))
      assert.throws(() => adjudicateCandidateBatch(batchPath, reviewsPath), /CANDIDATE_BATCH_DRIFT/)
      object[key] = original; fs.writeFileSync(file, JSON.stringify(record))
    }
    tamper(record, 'identity', 'wrong-identity')
    for (const key of ['invocationId', 'sourceHash', 'codeSha']) tamper(result, key, 'wrong-value')
    for (const key of ['slot', 'batchHash', 'modelConfigurationHash']) tamper(result.sampling, key, 'wrong-value')
    const disputed = reviews.reviewers[1].cases.find(item => item.caseId === 'C17-A' && item.round === 1)
    disputed.firstDraft = 'pass'
    reviews.arbitrations = [{ ...disputed, silentHardConstraint: false }]
    fs.writeFileSync(reviewsPath, JSON.stringify(reviews))
    const decision = adjudicateCandidateBatch(batchPath, reviewsPath).decisions.find(item => item.caseId === 'C17-A' && item.round === 1)
    assert.equal(decision.firstDraft, 'pass')
    assert.equal(decision.silentHardConstraint, true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('freeze consumer copies saved Pro and formal or R3 Flash sources and rejects drift', () => {
  const directory = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/single-model-freeze-'))
  const profile = QUALIFICATION_STAGE_MODELS.profiles.flash
  const sourceRoot = path.join(directory, 'source')
  fs.mkdirSync(path.join(sourceRoot, 'c', 'c'), { recursive: true })
  const modelFile = path.join(sourceRoot, 'c', 'c', 'models.json')
  const model = { ...profile.model, apiKey: 'synthetic-never-network' }
  const source = { sourceRoot, profileId: profile.profileId, configurationHash: profile.configurationHash }
  const runner = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-run.mjs'), 'utf8').replaceAll('\r\n', '\n')
  const start = runner.indexOf('export function createProductionTargets(')
  const body = runner.slice(start, runner.indexOf('export function probeTarget(', start)).replace('export function', 'function')
  const inspected = []
  const dependencies = { fs, path, ROOT, CACHE: directory, QUALIFICATION_STAGE_MODELS, R3_NATIVE_REVISION_DIAGNOSTIC, SAVED_NATIVE_REVIEW_DIAGNOSTIC,
    CANDIDATE_ONLY_PROTOCOL_REVISION: revision, PRODUCTION_BRIDGE: 'scripts/fixtures/quality-modernization-production.fixture.mjs',
    fail: code => { throw new Error(code) }, git: (_root, args) => args[0] === 'rev-parse' ? 'a'.repeat(40) : '',
    inside: (root, target) => !path.relative(root, target).startsWith('..') && !path.isAbsolute(path.relative(root, target)),
    real: fs.realpathSync, native: () => '/offline', process: { platform: 'linux' }, read: file => JSON.parse(fs.readFileSync(file)),
    assertFormalTargetCandidateClean() {}, createShortIsolationRoot: () => fs.mkdtempSync(path.join(directory, 'target-')),
    buildFixtureExports, currentProtocolBinding, hashSourceTree: () => 'b'.repeat(64), hashExecutionTools: () => 'c'.repeat(64),
    runnerAdapterHash: () => 'd'.repeat(64), productionBridgeHash: () => 'e'.repeat(64), modelConfigurationHash,
    freezeProductionEnvironment: () => ({}), fixedStartup: () => ({}),
    inspectTarget(target) {
      inspected.push(target)
    } }
  const freeze = new Function(...Object.keys(dependencies), body + '\nreturn createProductionTargets')(...Object.values(dependencies))
  try {
    for (const phase of ['full', 'r3-native-revision-diagnostic', 'saved-native-review-diagnostic']) {
      const phaseProfile = phase === 'full' ? profile : phase === 'saved-native-review-diagnostic'
        ? SAVED_NATIVE_REVIEW_DIAGNOSTIC.modelProfile : R3_NATIVE_REVISION_DIAGNOSTIC.profiles.flash
      const phaseModel = { ...phaseProfile.model, apiKey: 'synthetic-never-network' }
      fs.writeFileSync(modelFile, JSON.stringify([phaseModel]))
      const phaseSource = { sourceRoot, profileId: phaseProfile.profileId, configurationHash: phaseProfile.configurationHash }
      const output = path.join(directory, phase + '.json')
      const result = freeze(undefined, output, { phase, modelSources: { [phaseProfile.profileId]: phaseSource } })
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(inspected.at(-1).roots.config, 'models.json'))), [phaseModel])
      assert.equal(result.physicalModelRequests, 0)
      assert.equal(Object.keys(result.targets).length, 1)
      assert.equal(result.targets.candidate.modelId, phaseProfile.profileId)
      if (phase === 'full') assert.equal(result.targets.candidate.modelId, 'e764a293-6736-4d9e-97d1-f56b452c086c')
      const target = result.targets.candidate
      if (phase === 'saved-native-review-diagnostic') {
        assert.equal(target.stageModels, undefined)
        assert.deepEqual(target.modelSources, { [phaseProfile.profileId]: phaseSource })
        const destination = path.join(directory, 'saved-copy'); fs.mkdirSync(destination)
        copyIsolatedRealModelConfig(target, { config: destination }, phaseProfile.configurationHash)
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, 'models.json'))), [phaseModel])
        fs.writeFileSync(path.join(target.roots.config, 'models.json'), JSON.stringify([{ ...phaseModel, name: 'changed' }]))
        assert.throws(() => copyIsolatedRealModelConfig(target, { config: destination }, phaseProfile.configurationHash), /CONFIGURATION_DRIFT/)
        for (const change of [{ profileId: profile.profileId }, { configurationHash: profile.configurationHash }])
          assert.throws(() => freeze(undefined, path.join(directory, randomUUID() + '.json'),
            { phase, modelSources: { [phaseProfile.profileId]: { ...phaseSource, ...change } } }), /MODEL_MISMATCH/)
        fs.writeFileSync(modelFile, JSON.stringify([{ ...phaseModel, capabilities: { ...phaseModel.capabilities, contextWindowTokens: 999999 } }]))
        assert.throws(() => freeze(undefined, path.join(directory, randomUUID() + '.json'),
          { phase, modelSources: { [phaseProfile.profileId]: phaseSource } }), /MODEL_MISMATCH/)
      }
    }
    assert.equal(inspected.length, 3)
    assert.throws(() => freeze(undefined, path.join(directory, 'old-formal-source.json'),
      { phase: 'full', modelSources: { [profile.profileId]: { ...source,
        configurationHash: R3_NATIVE_REVISION_DIAGNOSTIC.profiles.flash.configurationHash } } }), /MODEL_MISMATCH/)
    for (const change of [{ profileId: 'unregistered' }, { configurationHash: '0'.repeat(64) }, { sourceRoot: 'relative-root' }])
      assert.throws(() => freeze(undefined, path.join(directory, randomUUID() + '.json'),
        { phase: 'full', modelSources: { [profile.profileId]: { ...source, ...change } } }), /MODEL_MISMATCH/)
    fs.writeFileSync(modelFile, JSON.stringify([{ ...model, apiKey: '' }]))
    assert.throws(() => freeze(undefined, path.join(directory, 'missing-key.json'),
      { phase: 'full', modelSources: { [profile.profileId]: source } }), /MODEL_MISMATCH/)
    fs.writeFileSync(modelFile, JSON.stringify([{ ...model, modelName: 'Qwen/Qwen3.8-27B' }]))
    assert.throws(() => freeze(undefined, path.join(directory, 'mixed.json'),
      { phase: 'full', modelSources: { [profile.profileId]: source } }), /MODEL_MISMATCH/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
