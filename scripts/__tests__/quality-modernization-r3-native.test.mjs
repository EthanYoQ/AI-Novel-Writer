import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { R3_NATIVE_REVISION_DIAGNOSTIC as policy, productionScenario, qualificationBridgeWindows, createOperationDispatchGate,
  assertForwardReasoning, readR3NativeSource, streamEventStructure, r3DiagnosticInvocation, r3ModelForOperation, copyIsolatedRealModelConfig, QUALIFICATION_STAGE_MODELS, modelConfigurationHash,
  SAVED_NATIVE_REVIEW_DIAGNOSTIC as savedPolicy, savedNativeOperations, reviewLengthRecoveryFor,
  PLANNING_NATIVE_DIAGNOSTIC as planningPolicy, planningNativeOperations, planningOutlineState, structuredRecoveryState, validatePairedReceipt } from '../quality-modernization-driver.mjs'
import { ROOT, CAMPAIGN_ID, currentProtocolBinding, selectPhase, forwardReasoningFor,
  forwardQualificationWindowFor, hash, updateLedger } from '../quality-modernization-run.mjs'

const phase = 'r3-native-revision-diagnostic'
const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')))

test('planning diagnostic uses its six-chapter scope and native 64K profile without changing formal32K', () => {
  const phase = 'planning-native-diagnostic'
  assert.deepEqual(selectPhase(protocol, phase, 'diagnostic'), { ...planningPolicy, phase })
  assert.equal(planningPolicy.formalDenominatorContribution, 0)
  assert.deepEqual(planningNativeOperations(planningPolicy.caseId, 'review').map(item => item.kind), ['outline', 'outline', 'directory', 'directory', 'draft', 'review'])
  assert.deepEqual(planningPolicy.operations.slice(0, 4).map(item => [item.range, item.targetUnits]),
    [[[1, 5], 600], [[6, 6], 600], [[1, 5], 600], [[6, 6], 600]])
  assert.ok(Object.values(planningPolicy.planningRootBudgets).every(budget => budget.maxPhysicalRequests === 32))
  assert.equal(planningPolicy.maxPhysicalRequests, Object.values(planningPolicy.physicalRequestBounds).reduce((sum, count) => sum + count, 0))
  assert.deepEqual(planningNativeOperations(planningPolicy.caseId, 'complete').map(item => item.kind), ['refine', 'final-review'])
  assert.throws(() => planningNativeOperations('R3', 'review'), /SCOPE/)
  assert.equal(forwardQualificationWindowFor(protocol, phase, 'diagnostic'), null)
  assert.equal(QUALIFICATION_STAGE_MODELS.profiles.flash.model.maxTokens, 32768)
  const model = planningPolicy.modelProfile.model
  const registration = forwardReasoningFor(protocol, phase, 'diagnostic')
  const input = { arm: 'candidate', phase, milestone: 'diagnostic', caseId: planningPolicy.caseId,
    operationId: 'planning-outline-1-5', creativeStrategy: 'auto', model,
    resolution: { requested: 'high', effective: 'high', status: 'mapped', source: 'model-override' } }
  for (const max_tokens of [1, 32768, 65536]) assert.doesNotThrow(() => assertForwardReasoning(registration, { ...input,
    body: { model: model.modelName, temperature: 0, max_tokens, thinking: { type: 'enabled' }, reasoning_effort: 'high' } }))
  assert.throws(() => assertForwardReasoning(registration, { ...input, model: { ...model, maxTokens: 32768 } }), /MODEL_MISMATCH/)
  assert.throws(() => assertForwardReasoning(registration, { ...input,
    body: { model: model.modelName, temperature: 0, max_tokens: 65537, thinking: { type: 'enabled' }, reasoning_effort: 'high' } }), /WIRE_MISMATCH/)
})

test('planning directory starts with the production 5+1 batches and rejects a six-item request', () => {
  const options = { chapterNumbers: [1, 2, 3, 4, 5, 6], decode: () => {} }
  const read = () => ({ output: '[]', finishReason: 'stop' })
  const first = { purpose: 'chapter-blueprint-directory', structuredRange: [1, 2, 3, 4, 5] }
  assert.deepEqual(structuredRecoveryState([], options, read).next, { purpose: first.purpose, range: first.structuredRange })
  assert.deepEqual(structuredRecoveryState([first], options, read).next, { purpose: first.purpose, range: [6] })
  assert.equal(structuredRecoveryState([first, { ...first, structuredRange: [6] }], options, read).complete, true)
  assert.throws(() => structuredRecoveryState([{ ...first, structuredRange: [1, 2, 3, 4, 5, 6] }], options, read), /SEQUENCE_INVALID/)
})

test('planning outline replay preserves long STOP and only retries a settled failed chapter', () => {
  const first = { attemptId: 'normal', purpose: 'plot-outline:chapter:6:normal' }
  const compact = { attemptId: 'compact', purpose: 'plot-outline:chapter:6:compact' }
  const output = `## 第6章：接续\n${'完整内容'.repeat(300)}`
  assert.equal(planningOutlineState([first], [6, 6], () => ({ output, finishReason: 'stop' })).text, output)
  assert.throws(() => planningOutlineState([first, compact], [6, 6], () => ({ output, finishReason: 'stop' })), /SEQUENCE/)
  assert.throws(() => planningOutlineState([compact], [6, 6], () => ({ output, finishReason: 'stop' })), /SEQUENCE/)
  const completed = planningOutlineState([first, compact], [6, 6], owner => ({ output,
    finishReason: owner === first ? 'length' : 'stop' }))
  assert.equal(completed.complete, true)
  assert.deepEqual(completed.artifactIds, ['compact'])
  assert.equal(planningOutlineState([first], [6, 6], () => ({ output, finishReason: 'unknown' })).cursor.reason, 'unknown-completion')
})

test('planning receipt validates two outline roots, preserved prefix and full chapter artifacts', () => {
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', `planning-outline-receipt-${randomUUID()}`)
  fs.mkdirSync(directory, { recursive: true })
  try {
    const binding = planningBinding(), operations = planningPolicy.operations.filter(item => item.kind === 'outline')
    const result = { ...binding, physicalProject: { projectId: binding.actual.projectId, parityHash: binding.parityId },
      projectEpoch: binding.actual.epoch, attempts: [], operations: [], ownerTerminal: [], physicalModelRequests: 0, syntheticDispatches: 6 }
    let prefix = '', previousSynopsis = ''
    for (const operation of operations) {
      const artifactIds = [], entries = []
      for (let chapter = operation.range[0]; chapter <= operation.range[1]; chapter++) {
        const attemptId = `chapter-${chapter}`, artifactId = `artifact-${chapter}`, output = `## 第${chapter}章：维修\n${'事实'.repeat(600)}`
        const outputPath = path.join(directory, `${attemptId}.md`)
        fs.writeFileSync(outputPath, output)
        const actual = { ...binding.actual, attemptId, runId: operation.id, rootActionId: operation.id, purpose: `plot-outline:chapter:${chapter}:normal` }
        result.attempts.push({ attemptId: `candidate:${attemptId}`, binding: { ...binding, operation: operation.id, actual },
          outputPath, visibleTextHash: hash(output), finishReason: 'stop' })
        result.ownerTerminal.push({ ...actual, artifactId, status: 'settled', finishReason: 'stop', textHash: hash(output), hasFormalEffect: false })
        artifactIds.push(artifactId); entries.push(output)
      }
      const body = [prefix, entries.join('\n\n')].filter(Boolean).join('\n\n')
      const synopsis = `# 情节大纲\n\n${body}${operation.range[1] < 6 ? '\n\n> 本大纲已覆盖至第 5 章（全书 6 章），其余章节将在后续批次继续生成。' : ''}`
      const outputPath = path.join(directory, `${operation.id}.md`)
      fs.writeFileSync(outputPath, synopsis)
      result.operations.push({ operation: operation.id, kind: operation.kind, handle: { runId: operation.id, rootActionId: operation.id }, planningOutline: {
        progress: { protocol: 'chapter-outline-v3', range: { from: operation.range[0], to: operation.range[1] }, targetUnits: 600,
          cursor: { kind: 'complete' }, confirmedPrefix: prefix, sourceExpected: { totalChapters: 6, writingLanguage: 'zh-CN', synopsis: previousSynopsis }, composition: { artifactIds } },
        savedSynopsis: { outputPath, contentHash: hash(synopsis) } } })
      prefix = body; previousSynopsis = synopsis
    }
    const options = { mode: 'synthetic', arm: 'candidate', phase: 'planning-native-diagnostic',
      scenario: { ...planningPolicy, operations, evaluationPolicy: null }, ...currentProtocolBinding() }
    assert.equal(validatePairedReceipt(result, options), null)
    for (const mutate of [value => { value.operations[1].handle.rootActionId = value.operations[0].handle.rootActionId },
      value => { value.operations[1].planningOutline.progress.confirmedPrefix = 'changed' },
      value => { value.ownerTerminal[0].hasFormalEffect = true },
      value => { value.operations[0].planningOutline.progress.composition.artifactIds.pop() },
      value => { value.attempts[0].finishReason = 'length' }]) {
      const invalid = structuredClone(result); mutate(invalid)
      assert.match(validatePairedReceipt(invalid, options), /PLANNING_/)
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('planning fixture keeps ordinary review and accepts an empty primary only through the accepted compact artifact', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  const focusStart = fixture.indexOf('reviewFocus: savedRun || planningRun ?')
  const focusEnd = fixture.indexOf('\n          })', focusStart)
  assert.ok(focusStart >= 0 && focusEnd > focusStart)
  assert.equal(new Function(`const planningRun = true, savedRun = false; return ({ ${fixture.slice(focusStart, focusEnd)} }).reviewFocus`)(), '')
  const start = fixture.indexOf('      for (const attempt of receipt.attempts)', fixture.indexOf('      assert.equal(receipt.ownerTerminal.length'))
  const end = fixture.indexOf('\n    }\n    if (restorationKind)', start)
  assert.ok(start >= 0 && end > start)
  const ledgerStart = fixture.indexOf('    const ledgerEvents =', end)
  const ledgerEnd = fixture.indexOf('    assertNoOutboundPreflightFailures', ledgerStart)
  const check = new Function('receipt', 'assert', 'sha', 'PLANNING_NATIVE_DIAGNOSTIC', 'reviewLengthRecoveryFor', `
    const planningRun = true, structuredRecovery = null, draftRecovery = null, aiReviewRun = true,
      copiedRun = false, continuityRun = false, repairPolicy = null, condensePolicy = null,
      candidate = true, request = { mode: 'synthetic', ledgerPath: 'ledger' },
      verifiedEmptyDraftAttempts = new Set(), verifiedReplacedOutlineAttempts = new Set();
    const fs = { readFileSync: name => name === 'ledger' ? receipt.attempts.flatMap(attempt =>
      ['reserve', 'dispatch', 'settle'].map(type => JSON.stringify({ type, attemptId: attempt.attemptId, binding: attempt.binding }))).join('\\n')
      : name === 'normal' ? '' : 'accepted chapter' };
    ${fixture.slice(start, end)}
    ${fixture.slice(ledgerStart, ledgerEnd)}`)
  for (const finishReason of ['stop', 'length']) {
    const attempts = ['normal', 'compact'].map((kind, index) => ({ attemptId: kind, outputPath: kind,
      binding: { operation: 'planning-outline-1-5', actual: { attemptId: kind, runId: 'run', rootActionId: 'root', purpose: `plot-outline:chapter:1:${kind}` } },
      finishReason: index ? 'stop' : finishReason, visibleTextHash: hash(index ? 'accepted chapter' : '') }))
    const receipt = { attempts, operations: [{ operation: 'planning-outline-1-5',
      planningOutline: { progress: { composition: { artifactIds: ['artifact-compact'] } } } }],
      ownerTerminal: attempts.map(attempt => ({ attemptId: attempt.attemptId, purpose: attempt.binding.actual.purpose,
        status: 'settled', finishReason: attempt.finishReason, artifactId: `artifact-${attempt.attemptId}`,
        textHash: attempt.visibleTextHash, hasFormalEffect: false, trustedUsage: true })) }
    const verify = value => check(value, assert, hash, planningPolicy, () => null)
    assert.doesNotThrow(() => verify(receipt))
    for (const mutate of [value => { value.operations[0].planningOutline.progress.composition.artifactIds = ['foreign-artifact'] },
      value => { value.ownerTerminal[1].purpose = 'plot-outline:chapter:2:compact' },
      value => { value.attempts[1].binding.operation = 'planning-outline-6' },
      value => { value.attempts[1].binding.actual.runId = 'foreign' },
      value => { value.attempts[1].binding.actual.purpose = 'plot-outline:chapter:2:compact' },
      value => { value.attempts[0].finishReason = value.ownerTerminal[0].finishReason = 'unknown' },
      value => { value.attempts.pop(); value.ownerTerminal.pop() }]) {
      const invalid = structuredClone(receipt); mutate(invalid)
      assert.throws(() => verify(invalid))
    }
  }
})

const planningBinding = () => ({ campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', ...currentProtocolBinding(),
  codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId: 'd'.repeat(64),
  phase: 'planning-native-diagnostic', milestone: 'diagnostic', caseId: planningPolicy.caseId, operation: 'planning-outline-1-5',
  invocationId: planningPolicy.invocationId, planningRange: [1, 5],
  stageModel: { profileId: planningPolicy.modelProfile.profileId, configurationHash: planningPolicy.modelProfile.configurationHash },
  diagnosticInputHash: planningPolicy.diagnosticInputHash, diagnosticSourceHash: hash(planningPolicy.sources),
  evaluationPolicyHash: hash(planningPolicy.evaluationPolicy), actual: { attemptId: 'first', runId: 'outline', rootActionId: 'outline',
    projectId: 'new-project', epoch: 'new-epoch', purpose: 'plot-outline:chapter:1:normal' } })

test('planning rejects wrong source, range, 32K binding and UNKNOWN restart before another reserve', () => {
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', `planning-scope-${randomUUID()}`)
  fs.mkdirSync(directory, { recursive: true })
  try {
    const ledger = path.join(directory, 'ledger.jsonl'), binding = planningBinding(), options = { campaignMode: 'synthetic' }
    const reserve = (id, extra = {}) => updateLedger(ledger, { type: 'reserve', attemptId: id, binding: { ...binding, ...extra } }, options)
    for (const extra of [{ planningRange: [1, 10] }, { diagnosticInputHash: '0'.repeat(64) }, { diagnosticSourceHash: '0'.repeat(64) },
      { stageModel: { profileId: binding.stageModel.profileId, configurationHash: QUALIFICATION_STAGE_MODELS.profiles.flash.configurationHash } },
      { actual: { ...binding.actual, purpose: 'plot-outline' } }]) assert.throws(() => reserve('bad', extra), /PLANNING_NATIVE/)
    reserve('first')
    updateLedger(ledger, { type: 'dispatch', attemptId: 'first' }, options)
    updateLedger(ledger, { type: 'unknown', attemptId: 'first' }, options)
    for (const extra of [{ codeSha: 'e'.repeat(40) }, { invocationId: randomUUID() },
      { actual: { ...binding.actual, attemptId: 'retry', rootActionId: 'new-root', purpose: 'plot-outline:chapter:1:compact' } }])
      assert.throws(() => reserve('retry', extra), /PLANNING_NATIVE/)
    assert.equal(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 3)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('planning ledger derives the action envelope and rejects spent or shared roots', () => {
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', `planning-bounds-${randomUUID()}`)
  fs.mkdirSync(directory, { recursive: true })
  try {
    const ledger = path.join(directory, 'ledger.jsonl'), base = planningBinding(), options = { campaignMode: 'synthetic' }
    let ordinal = 0
    for (const operation of planningPolicy.operations) {
      const count = planningPolicy.physicalRequestBounds[operation.id]
      const purposes = operation.kind === 'outline' ? Array.from({ length: operation.range[1] - operation.range[0] + 1 }, (_, index) =>
        [`plot-outline:chapter:${operation.range[0] + index}:normal`, `plot-outline:chapter:${operation.range[0] + index}:compact`]).flat()
        : operation.kind === 'directory' ? Array(count).fill('chapter-blueprint-directory')
          : operation.kind === 'draft' ? ['chapter-draft-short-outline', 'chapter-draft', ...Array(count - 2).fill('chapter-draft-continuation')]
            : operation.kind === 'refine' ? Array(count).fill('refine-from-review')
              : ['review-chapter', 'review-chapter', 'review-chapter-rebuild', 'review-chapter-rebuild']
      for (const [index, purpose] of purposes.entries()) {
        const attemptId = String(++ordinal), binding = { ...base, operation: operation.id, planningRange: operation.range ?? planningPolicy.range,
          actual: { ...base.actual, attemptId, purpose, runId: operation.id,
            rootActionId: ['review', 'refine', 'final-review'].includes(operation.kind) ? 'planning-review' : operation.id,
            ...(operation.kind === 'directory' ? { structuredRange: [operation.range[0]] } : {}) } }
        const finishReason = index === count - 1 || operation.kind === 'outline' && index % 2 === 1
          || ['review', 'final-review'].includes(operation.kind) && index === 1 ? 'stop' : 'length'
        updateLedger(ledger, { type: 'reserve', attemptId, binding }, options)
        updateLedger(ledger, { type: 'dispatch', attemptId }, options)
        updateLedger(ledger, { type: 'settle', attemptId, finishReason }, options)
      }
      assert.throws(() => updateLedger(ledger, { type: 'reserve', attemptId: 'extra', binding: { ...base, operation: operation.id,
        actual: { ...base.actual, purpose: purposes.at(-1), runId: 'new-root', rootActionId: 'new-root' } } }, options), /PLANNING_NATIVE/)
    }
    assert.equal(ordinal, planningPolicy.maxPhysicalRequests)
    const events = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(events.filter(row => row.type === 'reserve').length, planningPolicy.maxPhysicalRequests)
    assert.ok(events.filter(row => row.type === 'reserve').every(row => row.allocation === 'nonQualificationDiagnostic'))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}, 30000)

test('saved Pro registration preserves the source cases and verifies the complete model and wire', () => {
  const previous = protocol.historicalSavedNativeRegistration94e9b048
  assert.deepEqual(selectPhase(protocol, 'saved-native-review-diagnostic', 'diagnostic'), { ...savedPolicy, phase: 'saved-native-review-diagnostic' })
  assert.deepEqual(savedPolicy.sources.map(source => ({ ...source, invocationId: undefined })), previous.sources.map(source => ({ ...source, invocationId: undefined })))
  assert.ok(savedPolicy.sources.every(source => !previous.sources.some(old => old.invocationId === source.invocationId)))
  for (const key of ['diagnosticInputHash', 'operations', 'attemptPolicy', 'evaluationPolicy', 'stop', 'expectedPhysicalRequests', 'maxPhysicalRequests'])
    assert.deepEqual(savedPolicy[key], previous[key])
  assert.deepEqual(previous.modelProfile, QUALIFICATION_STAGE_MODELS.profiles.flash)
  assert.equal(savedPolicy.modelProfile.model.modelName, 'deepseek-v4-pro')
  const phase = 'saved-native-review-diagnostic', registration = forwardReasoningFor(protocol, phase, 'diagnostic')
  const model = savedPolicy.modelProfile.model
  const input = { arm: 'candidate', phase, milestone: 'diagnostic', caseId: savedPolicy.caseIds[0], operationId: 'negative-review',
    creativeStrategy: 'auto', model, resolution: { requested: 'high', effective: 'high', status: 'mapped', source: 'model-override' },
    body: { model: model.modelName, temperature: 0, max_tokens: 32768, thinking: { type: 'enabled' }, reasoning_effort: 'high' } }
  assert.doesNotThrow(() => assertForwardReasoning(registration, input))
  for (const change of [{ model: 'deepseek-flash' }, { temperature: 1 }, { max_tokens: 32769 }, { reasoning_effort: 'low' }])
    assert.throws(() => assertForwardReasoning(registration, { ...input, body: { ...input.body, ...change } }), /MISMATCH/)
  assert.throws(() => assertForwardReasoning(registration, { ...input, model: { ...model, name: 'changed' } }), /R3_NATIVE_MODEL_MISMATCH/)
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8').replaceAll('\r\n', '\n')
  const start = fixture.indexOf('    let stageModels = null'), end = fixture.indexOf("    if (request.mode === 'real')", start)
  const profileStart = fixture.indexOf('  const stageProfiles ='), profileEnd = fixture.indexOf('  const registeredWindow =', profileStart)
  const choose = new Function('target', 'configured', 'savedPolicy', 'assert', 'modelConfigurationHash', `
    const savedRun = true, planningRun = false, r3Run = false,
      SAVED_NATIVE_REVIEW_DIAGNOSTIC = savedPolicy, request = { mode: 'real' }, path = { join: () => '' },
      json = () => configured;
    let model, secrets;
    ${fixture.slice(profileStart, profileEnd)}
    ${fixture.slice(start, end)}
    return model;
  `)
  const configured = [{ ...model, apiKey: 'synthetic-never-network' }], target = { modelId: model.id, roots: { config: 'offline' } }
  assert.deepEqual(choose(target, configured, savedPolicy, assert, modelConfigurationHash), configured[0])
  assert.throws(() => choose({ ...target, modelId: previous.modelProfile.profileId }, configured, savedPolicy, assert, modelConfigurationHash), /REGISTERED_STAGE_MODEL_MISMATCH/)
  assert.throws(() => choose(target, [{ ...configured[0], name: 'changed' }], savedPolicy, assert, modelConfigurationHash), /R3_NATIVE_MODEL_MISMATCH/)
})

test('saved Pro budget excludes closed Flash identities but preserves same-group history and global replay checks', () => {
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', `saved-forward-${randomUUID()}`)
  fs.mkdirSync(directory, { recursive: true })
  try {
    const slot = savedPolicy.sources[0], profile = savedPolicy.modelProfile
    const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', ...currentProtocolBinding(),
      codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId: 'd'.repeat(64),
      phase: 'saved-native-review-diagnostic', milestone: 'diagnostic', caseId: slot.caseId, operation: 'negative-review', invocationId: slot.invocationId,
      stageModel: { profileId: profile.profileId, configurationHash: profile.configurationHash },
      diagnosticInputHash: savedPolicy.diagnosticInputHash, diagnosticSourceHash: hash(slot), evaluationPolicyHash: hash(savedPolicy.evaluationPolicy),
      actual: { attemptId: 'new', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch', purpose: 'review-chapter' } }
    const ledger = path.join(directory, 'ledger.jsonl')
    const old = protocol.historicalSavedNativeRegistration94e9b048
    const historical = (invocationId, terminal = 'settle', finishReason = 'stop') => {
      const rows = [{ type: 'reserve', attemptId: 'candidate:old', allocation: 'nonQualificationDiagnostic',
        binding: { ...binding, protocolHash: 'f'.repeat(64), invocationId } },
      { type: 'dispatch', attemptId: 'candidate:old' }, { type: terminal, attemptId: 'candidate:old', finishReason }]
      const raw = rows.map(row => JSON.stringify(row)).join('\n') + '\n'; fs.writeFileSync(ledger, raw)
      return { campaignMode: 'synthetic', historicalSavedPostUi94e9b048Boundary: { fromEventCount: 0, eventCount: 3,
        rawBytesSha256: hash(raw), protocolRevision: binding.protocolRevision, protocolHash: 'f'.repeat(64),
        reserveAttempts: [{ attemptId: 'candidate:old', invocationId, terminal }] } }
    }
    const reserve = (options, id = 'candidate:new', actual = binding.actual) => updateLedger(ledger,
      { type: 'reserve', attemptId: id, binding: { ...binding, actual } }, options)
    let options = historical(old.sources[0].invocationId)
    assert.throws(() => reserve(options, 'candidate:old'), /INVALID_RESERVATION/)
    assert.doesNotThrow(() => reserve(options))
    options = historical(slot.invocationId, 'unknown')
    assert.throws(() => reserve(options), /SAVED_NATIVE_ATTEMPT_UNAVAILABLE/)
    options = historical(slot.invocationId)
    assert.throws(() => reserve(options), /SAVED_NATIVE_ATTEMPT_UNAVAILABLE/, 'a changed protocol hash cannot refund a settled primary')
    options = historical(slot.invocationId, 'settle', 'length')
    assert.throws(() => reserve(options, 'candidate:new', { ...binding.actual, rootActionId: 'different-root' }), /SAVED_NATIVE_ATTEMPT_UNAVAILABLE/)
    assert.doesNotThrow(() => reserve(options), 'same-root registered length replacement remains available')
    options = historical(old.sources[0].invocationId)
    fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').replace('nonQualificationDiagnostic', 'changedAllocation'))
    assert.throws(() => reserve(options), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('saved native mapping permits its real bounded recovery sequences and rejects a fifth request per operation', () => {
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', `saved-recovery-${randomUUID()}`)
  fs.mkdirSync(directory, { recursive: true })
  const ledger = path.join(directory, 'ledger.jsonl'), phase = 'saved-native-review-diagnostic'
  try {
    for (const operation of savedPolicy.operations) {
      const slot = savedPolicy.sources.find(item => operation.caseIds.includes(item.caseId))
      const source = { draftId: 4, version: 1, contentHash: slot.contentSha256,
        ...(operation.kind === 'refine' ? { confirmationId: 2, confirmationHash: 'f'.repeat(64) } : {}) }
      const attempts = [], events = [], outputs = new Map()
      const gate = createOperationDispatchGate({ repairPolicy: savedPolicy.attemptPolicy,
        refinementRecovery: savedPolicy.attemptPolicy.refinementRecovery, readPrimaryEvidence: owner => {
          const attempt = attempts.find(item => item.binding.actual.attemptId === owner.attemptId)
          return { attempt, events: events.filter(item => item.attemptId === attempt.attemptId),
            ownerArtifactHash: attempt.visibleTextHash, ownerArtifactId: owner.attemptId,
            reviewReportAbsent: true, composition: { algorithm: 'visible-append-v1',
              textHash: hash([...outputs.values()].join('\n\n')), artifactIds: [...outputs.keys()] } }
        } })
      const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', ...currentProtocolBinding(),
        codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId: 'd'.repeat(64),
        phase, milestone: 'diagnostic', caseId: slot.caseId, operation: operation.id, invocationId: slot.invocationId,
        stageModel: { profileId: savedPolicy.modelProfile.profileId, configurationHash: savedPolicy.modelProfile.configurationHash },
        diagnosticInputHash: savedPolicy.diagnosticInputHash, diagnosticSourceHash: hash(slot),
        evaluationPolicyHash: hash(savedPolicy.evaluationPolicy), reviewSource: source }
      const purposes = operation.kind === 'refine' ? Array(4).fill('refine-from-review')
        : ['review-chapter', 'review-chapter', 'review-chapter-rebuild', 'review-chapter-rebuild']
      for (const [index, purpose] of purposes.entries()) {
        const actual = { attemptId: `${operation.id}-${index}`, runId: operation.id, rootActionId: operation.id,
          projectId: slot.caseId, epoch: operation.id, purpose }
        gate(operation.id, actual, source)
        const attemptId = `candidate:${actual.attemptId}`, outputPath = path.join(directory, actual.attemptId + '.txt')
        const output = operation.kind === 'refine' ? ['甲','乙','丙','丁'][index].repeat(20) : index === 1 ? '{invalid' : index === 3 ? '{}' : ''
        const finishReason = index === 3 || operation.kind !== 'refine' && index === 1 ? 'stop' : 'length'
        fs.writeFileSync(outputPath, output)
        const attempt = { attemptId, binding: { ...binding, actual }, outputPath, visibleTextHash: hash(output) }
        for (const event of [{ type: 'reserve', attemptId, binding: attempt.binding }, { type: 'dispatch', attemptId },
          { type: 'settle', attemptId, finishReason }]) {
          updateLedger(ledger, event, { campaignMode: 'synthetic' }); events.push(event)
        }
        attempts.push(attempt); outputs.set(actual.attemptId, output)
      }
      const fifth = { ...attempts.at(-1).binding.actual, attemptId: operation.id + '-5' }
      assert.throws(() => gate(operation.id, fifth, source), /MODEL_REQUEST_REJECTED/)
      assert.throws(() => updateLedger(ledger, { type: 'reserve', attemptId: fifth.attemptId,
        binding: { ...binding, actual: fifth } }, { campaignMode: 'synthetic' }), /SAVED_NATIVE_ATTEMPT_UNAVAILABLE/)
      if (operation.kind !== 'refine') assert.ok(reviewLengthRecoveryFor({ phase, arm: 'candidate' }, operation.id))
    }
    assert.equal(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 48)
    assert.deepEqual(savedNativeOperations(savedPolicy.caseIds[0], 'complete').map(item => item.id), ['negative-refine','negative-final-review'])
    assert.throws(() => savedNativeOperations(savedPolicy.caseIds[1], 'complete'), /SCOPE/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('saved native checks reject cross-case operations and spent or unknown requests across roots', () => {
  const phase = 'saved-native-review-diagnostic'
  const scenario = productionScenario(phase, 'diagnostic')
  assert.ok(scenario, 'fixed saved native checks must have a production scenario')
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', `saved-native-${randomUUID()}`)
  fs.mkdirSync(directory, { recursive: true })
  try {
    const slot = scenario.sources[0], profile = savedPolicy.modelProfile
    const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', ...currentProtocolBinding(),
      codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId: 'd'.repeat(64),
      phase, milestone: 'diagnostic', caseId: slot.caseId, operation: 'negative-review', invocationId: slot.invocationId,
      stageModel: { profileId: profile.profileId, configurationHash: profile.configurationHash },
      diagnosticInputHash: scenario.diagnosticInputHash, diagnosticSourceHash: hash(slot),
      evaluationPolicyHash: hash(scenario.evaluationPolicy), actual: { attemptId: 'first', runId: 'run', rootActionId: 'root',
        projectId: 'new-project', epoch: 'new-epoch', purpose: 'review-chapter' } }
    const ledger = path.join(directory, 'ledger.jsonl')
    const reserve = (id, extra = {}) => updateLedger(ledger, { type: 'reserve', attemptId: id,
      binding: { ...binding, ...extra } }, { campaignMode: 'synthetic' })
    for (const extra of [{ caseId: scenario.sources[1].caseId }, { invocationId: policy.runs[0].invocationId },
      { diagnosticInputHash: '0'.repeat(64) }, { operation: 'control-review' }])
      assert.throws(() => reserve('bad', extra), /SAVED_NATIVE|INVALID_CAMPAIGN/)
    assert.doesNotThrow(() => reserve('first'))
    updateLedger(ledger, { type: 'dispatch', attemptId: 'first' }, { campaignMode: 'synthetic' })
    updateLedger(ledger, { type: 'unknown', attemptId: 'first' }, { campaignMode: 'synthetic' })
    assert.throws(() => reserve('retry', { actual: { ...binding.actual, attemptId: 'retry', rootActionId: 'new-root' } }), /SAVED_NATIVE/)
    assert.equal(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 3)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

afterEach(() => {
  vi.doUnmock('../quality-modernization-driver.mjs')
  vi.restoreAllMocks()
  vi.resetModules()
})

async function historicalOpenR3Runner(openInvocations = [policy.runs[1].invocationId]) {
  const historical = structuredClone(protocol)
  const registration = historical.phases[phase]
  registration.closedInvocations = registration.closedInvocations.filter(id => !openInvocations.includes(id))
  const bytes = Buffer.from(JSON.stringify(historical))
  const originalRead = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
    if (typeof file === 'string' && path.resolve(file) === path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json'))
      return args[0] === 'utf8' ? bytes.toString('utf8') : bytes
    return originalRead(file, ...args)
  })
  vi.doMock('../quality-modernization-driver.mjs', async importOriginal => ({
    ...await importOriginal(), R3_NATIVE_REVISION_DIAGNOSTIC: registration,
  }))
  vi.resetModules()
  return import('../quality-modernization-run.mjs')
}

test('R3 review admits one same-purpose replacement only after authenticated LENGTH, including empty visible output', () => {
  const directory = path.join(ROOT, '.runtime/.cache', `r3-length-${randomUUID()}`)
  fs.mkdirSync(directory, { recursive: true })
  try {
    const operation = policy.operations[0].id, source = { draftId: 1, contentHash: 'a'.repeat(64), version: 1 }
    const first = { attemptId: 'first', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch', purpose: 'review-chapter' }
    const outputPath = path.join(directory, 'empty.txt')
    fs.writeFileSync(outputPath, '')
    const attempt = { attemptId: 'candidate:first', binding: { operation, actual: first, reviewSource: source }, outputPath, visibleTextHash: hash('') }
    let finishReason = 'length'
    const evidence = () => ({ attempt, ownerArtifactHash: hash(''), reviewReportAbsent: true,
      events: [{ type: 'reserve', attemptId: attempt.attemptId, binding: attempt.binding },
        { type: 'dispatch', attemptId: attempt.attemptId }, { type: 'settle', attemptId: attempt.attemptId, finishReason }] })
    const gate = () => createOperationDispatchGate({ repairPolicy: policy.attemptPolicy, readPrimaryEvidence: evidence })
    const admitted = gate()
    admitted(operation, first, source)
    assert.doesNotThrow(() => admitted(operation, { ...first, attemptId: 'second' }, source))
    assert.throws(() => admitted(operation, { ...first, attemptId: 'third' }, source), /MODEL_REQUEST_REJECTED/)
    for (const terminal of ['stop', 'unknown']) {
      finishReason = terminal
      const rejected = gate(); rejected(operation, first, source)
      assert.throws(() => rejected(operation, { ...first, attemptId: 'second' }, source), /MODEL_REQUEST_REJECTED/)
    }
    finishReason = 'length'
    const drift = gate(); drift(operation, first, source)
    assert.throws(() => drift(operation, { ...first, attemptId: 'second' }, { ...source, version: 2 }), /MODEL_REQUEST_REJECTED/)
    const outputs = new Map()
    const chain = createOperationDispatchGate({ repairPolicy: policy.attemptPolicy, readPrimaryEvidence: owner => {
      const prior = outputs.get(owner.attemptId), filename = path.join(directory, owner.attemptId + '.txt')
      fs.writeFileSync(filename, prior.output)
      const record = { attemptId: 'candidate:' + owner.attemptId, outputPath: filename, visibleTextHash: hash(prior.output),
        binding: { operation, actual: owner, reviewSource: source } }
      return { attempt: record, ownerArtifactHash: record.visibleTextHash, reviewReportAbsent: true,
        events: [{ type: 'reserve', attemptId: record.attemptId, binding: record.binding },
          { type: 'dispatch', attemptId: record.attemptId }, { type: 'settle', attemptId: record.attemptId, finishReason: prior.finishReason }] }
    } })
    for (const [index, [purpose, terminal, output]] of [
      ['review-chapter', 'length', ''], ['review-chapter', 'stop', '{invalid'],
      ['review-chapter-rebuild', 'length', ''], ['review-chapter-rebuild', 'stop', '{}'],
    ].entries()) {
      const owner = { ...first, attemptId: 'chain-' + index, purpose }
      assert.doesNotThrow(() => chain(operation, owner, source))
      outputs.set(owner.attemptId, { finishReason: terminal, output })
    }
    assert.throws(() => chain(operation, { ...first, attemptId: 'chain-4', purpose: 'review-chapter-rebuild' }, source), /MODEL_REQUEST_REJECTED/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('R3 Flash v9 authenticates its final history and closes all three slots without opening another group', () => {
  const v8 = protocol.historicalR3NativeRegistration2d67a3aa
  assert.equal(hash(v8), '4fa86ac4573c41bf4fb7a2be8c8d8220e0c2db81c614c8fe784adcda005aafe1')
  assert.deepEqual(policy.closedInvocations, [...v8.closedInvocations, ...v8.runs.map(item => item.invocationId), ...policy.runs.map(item => item.invocationId)])
  const v9Boundary = protocol.historicalR3NativeC907f174Boundary
  assert.deepEqual([v9Boundary.fromEventCount, v9Boundary.eventCount, v9Boundary.reserveAttempts.length], [1725, 1746, 7])
  assert.equal(v9Boundary.rawBytesSha256, 'ec2312dea6e415f1ee4db9638cab5ace127f39d62925f90f613461c373571692')
  assert.deepEqual([...new Set(v9Boundary.reserveAttempts.map(item => item.invocationId))], policy.runs.map(item => item.invocationId))
  assert.equal(v8.runs[2].invocationId, '73b0ca6a-a5bd-4493-a7b2-1e01d5eee005')
  const v8Boundary = protocol.historicalR3Native2d67a3aaBoundary
  assert.deepEqual([v8Boundary.fromEventCount, v8Boundary.eventCount, v8Boundary.reserveAttempts.length], [1704, 1725, 7])
  assert.equal(v8Boundary.rawBytesSha256, '8ecbfc167800b5f2a92f99f74f21a62755198d0bb97e8b46e6600528413d5546')
  assert.ok(v8Boundary.reserveAttempts.every(item => item.terminal === 'settle' && item.invocationId !== v8.runs[2].invocationId))
  assert.deepEqual(policy.acceptance, v8.acceptance)
  assert.equal(new Set(policy.runs.map(item => item.invocationId)).size, 3)
  assert.equal(hash(protocol.historicalR3NativeRegistration49e1c0ad), '7d59b55e6aff45a7b0b9487721eeb89f26ab826d1981cf3733d9873cec11be39')
  assert.equal(hash(protocol.historicalR3NativeRegistration6e38e5dd), 'a15f9ee248e830463d83458128232b2c131c17111d5df0cde8a8b5a28bc03387')
  const previous = protocol.historicalR3NativeRegistration11152245
  assert.equal(hash(previous), '4154cf33b1ba3ead4ea61dfcfc23b735686590bdfbf9c93ac6ad1e4f21f1ddfa')
  assert.notEqual(policy.scenarioRevision, previous.scenarioRevision)
  const flash = protocol.historicalR3NativeRegistrationD51580fc
  const glm = protocol.historicalR3NativeRegistrationAd650e85
  assert.deepEqual(v8.closedInvocations, [...glm.closedInvocations, ...glm.runs.map(item => item.invocationId)])
  assert.equal(glm.runs[2].invocationId, '66ac671a-2481-4917-8272-6a2aeef62738')
  assert.deepEqual([protocol.historicalR3NativeAd650e85Boundary.fromEventCount, protocol.historicalR3NativeAd650e85Boundary.eventCount], [1686, 1704])
  assert.ok(protocol.historicalR3NativeAd650e85Boundary.reserveAttempts.every(item => item.invocationId !== glm.runs[2].invocationId))
  assert.ok(policy.runs.every(item => policy.closedInvocations.includes(item.invocationId)))
  for (const key of ['source', 'operations', 'evaluationPolicy', 'minPhysicalRequests', 'maxPhysicalRequests', 'maxTotalPhysicalRequests'])
    assert.deepEqual(policy[key], previous[key])
  const frozen = protocol.historicalR3NativeRegistrationC9e7c71e
  assert.equal(hash(frozen), '2fe255679f107679d4ee2cbebcd85d4d40434a4eec4f13248bc8551282bbb871')
  assert.deepEqual(flash.runs, frozen.runs)
  assert.equal(policy.scenarioRevision, 'r3-native-official-flash-three-runs-v9')
  assert.ok(policy.runs.every(item => !flash.runs.some(old => old.invocationId === item.invocationId)))
  assert.deepEqual(policy.attemptPolicy, flash.attemptPolicy)
  const flashBoundary = protocol.historicalR3NativeD51580fcBoundary
  assert.deepEqual([flashBoundary.fromEventCount, flashBoundary.eventCount], [1671, 1686])
  assert.deepEqual(flashBoundary.reserveAttempts.map(item => item.terminal), ['settle','settle','settle','settle','unknown'])
  assert.equal(flashBoundary.rawBytesSha256, '846293c04c383bcef68277cc435f759a9902d6c7ee70021b842ff921bcbed730')
  assert.deepEqual(frozen.attemptPolicy, previous.attemptPolicy)
  assert.deepEqual(policy.attemptPolicy, { ...frozen.attemptPolicy,
    reviewRebuild: { ...frozen.attemptPolicy.reviewRebuild, maxLengthReplacements: 1 },
    finalReviewRebuild: { ...frozen.attemptPolicy.finalReviewRebuild, maxLengthReplacements: 1 } })
  assert.deepEqual([protocol.historicalR3NativeC9e7c71eBoundary.fromEventCount, protocol.historicalR3NativeC9e7c71eBoundary.eventCount], [1668, 1671])
  for (const [key, value] of Object.entries(previous.acceptance)) assert.deepEqual(policy.acceptance[key], value)
  assert.equal(policy.acceptance.scope, 'new-group-only-no-historical-reclassification-or-section-5-waiver')
  assert.equal(policy.acceptance.stop, 'when-two-of-three-impossible-remaining-NOT_RUN-no-redraw')
  assert.equal(policy.requiredProductSha, '69ed2a2f23699320a4758ce6e10ac893b2a84977')
  assert.equal(policy.model.modelName, 'deepseek-flash')
  assert.equal(hash(policy.model), '0eec6083f152f15548e9acf680803e79365d1d76a4763f2b1c58529451a244df')
  for (const operation of policy.operations) assert.deepEqual(r3ModelForOperation(operation.id).model, policy.model)
  assert.deepEqual(QUALIFICATION_STAGE_MODELS.profiles.flash.model, { ...policy.model, maxTokens: 32768 })
  const boundary = protocol.historicalR3Native11152245Boundary
  assert.deepEqual([boundary.fromEventCount, boundary.eventCount, boundary.reserveAttempts.length], [1650, 1668, 6])
  assert.equal(boundary.rawBytesSha256, '747454c7085bb348a9d939952ebf5b51cc7026d586d679bc85db8968537d93fd')
  assert.ok(boundary.reserveAttempts.every(item => item.terminal === 'settle' && item.invocationId !== previous.runs[2].invocationId))
  assert.deepEqual(QUALIFICATION_STAGE_MODELS, protocol.forwardStageModels)
  assert.equal(protocol.forwardStageModels.revision, 'candidate-single-official-flash-cap32-v3')
})

test('R3 native stage profiles freeze Flash for review, revision and final review and retain the native deadline', () => {
  assert.deepEqual(selectPhase(protocol, phase, 'diagnostic').operations, policy.operations)
  assert.deepEqual(productionScenario(phase, 'diagnostic'), policy)
  assert.throws(() => selectPhase(protocol, phase, 'final'), /MILESTONE/)
  const registration = forwardReasoningFor(protocol, phase, 'diagnostic')
  for (const operation of policy.operations) {
    const profile = r3ModelForOperation(operation.id), effort = profile.model.reasoningOverride
    const input = { arm: 'candidate', phase, milestone: 'diagnostic', caseId: 'R3', operationId: operation.id, model: profile.model,
      creativeStrategy: 'auto', resolution: { requested: effort, effective: effort, status: 'mapped', source: 'model-override' },
      body: { model: profile.model.modelName, temperature: 0, max_tokens: 16384, reasoning_effort: 'high', thinking: { type: 'enabled' },
        ...(operation.kind === 'refine' ? {} : { response_format: { type: 'json_object' } }) } }
    assert.equal(assertForwardReasoning(registration, input).effective, effort)
    for (const change of [{ reasoning_effort: 'medium' }, { thinking: { type: 'disabled' } }, { enable_thinking: true }, { thinking_budget: 16384 }, { max_tokens: 8192 }, { model: 'deepseek-v4-flash' }])
      assert.throws(() => assertForwardReasoning(registration, { ...input, body: { ...input.body, ...change } }), /WIRE/)
    assert.throws(() => assertForwardReasoning(registration, { ...input, model: { ...profile.model, modelName: 'deepseek-ai/DeepSeek-V4-Pro' } }), /MODEL/)
  }
  assert.equal(forwardQualificationWindowFor(protocol, phase, 'diagnostic'), null)
  const request = { ...policy, phase, target: { arm: 'candidate' } }
  const windows = qualificationBridgeWindows(request)
  assert.ok(windows.attemptMs > 3_600_000 && windows.spawnMs > windows.attemptMs * 8)
  assert.throws(() => qualificationBridgeWindows({ ...request, operations: policy.operations.slice(1) }), /SCOPE/)
  assert.equal(forwardReasoningFor(protocol, 'early-review', 'post-ui').model.modelName, 'deepseek-flash')
})

test('R3 native registration rejects altered source and cannot restart spent diagnostic slots', () => {
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', `r3-native-test-${randomUUID()}`)
  fs.mkdirSync(directory, { recursive: true })
  try {
    const input = path.join(directory, 'R3.context.json'), ledger = path.join(directory, 'ledger.jsonl')
    fs.writeFileSync(input, '{}')
    assert.throws(() => readR3NativeSource(input), /SOURCE_DRIFT/)
    const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', ...currentProtocolBinding(),
      codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId: 'd'.repeat(64),
      phase, milestone: 'diagnostic', caseId: 'R3', operation: policy.operations[0].id, invocationId: r3DiagnosticInvocation(2),
      stageModel: { profileId: policy.profiles.flash.profileId, configurationHash: policy.profiles.flash.configurationHash },
      diagnosticInputHash: policy.source.contextSha256, diagnosticSourceHash: hash(policy.source),
      evaluationPolicyHash: hash(policy.evaluationPolicy), actual: { attemptId: 'first', runId: 'run', rootActionId: 'root',
        projectId: 'new-project', epoch: 'new-epoch', purpose: 'review-chapter' } }
    const reserve = (attemptId, extra = {}) => ({ type: 'reserve', attemptId, binding: { ...binding, ...extra } })
    assert.throws(() => updateLedger(ledger, reserve('bad', { diagnosticInputHash: '0'.repeat(64) }), { campaignMode: 'synthetic' }), /SOURCE_BINDING/)
    for (const slot of policy.runs)
      assert.throws(() => updateLedger(ledger, reserve('current-closed-' + slot.run, { invocationId: slot.invocationId }),
        { campaignMode: 'synthetic' }), /^Error: R3_NATIVE_ATTEMPT_UNAVAILABLE$/)
    assert.throws(() => updateLedger(ledger, reserve('restart', { invocationId: randomUUID() }), { campaignMode: 'synthetic' }), /ATTEMPT_UNAVAILABLE/)
    for (const slot of [...protocol.historicalR3NativeRegistrationD51580fc.runs, ...protocol.historicalR3NativeRegistrationAd650e85.runs, ...protocol.historicalR3NativeRegistration2d67a3aa.runs])
      assert.throws(() => updateLedger(ledger, reserve('closed-' + slot.run, { invocationId: slot.invocationId }), { campaignMode: 'synthetic' }), /ATTEMPT_UNAVAILABLE/)
    assert.equal(fs.existsSync(ledger), false, 'closed registrations cannot append a reserve')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})


test.each([
  ['historicalR3NativeD12c4111Boundary', 0],
  ['historicalR3Native49e1c0adBoundary', 3],
  ['historicalR3Native6e38e5ddBoundary', 6],
  ['historicalR3Native11152245Boundary', 9],
  ['historicalR3NativeC9e7c71eBoundary', 12],
  ['historicalR3NativeD51580fcBoundary', 13],
  ['historicalR3NativeAd650e85Boundary', 15],
  ['historicalR3Native2d67a3aaBoundary', 18],
  ['historicalR3NativeC907f174Boundary', 21],
])('historical open R3 registration preserves authenticated UNKNOWN in %s and caps its eight-call invocation', async (boundaryKey, closedIndex) => {
  const { updateLedger, currentProtocolBinding } = await historicalOpenR3Runner()
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', 'r3-replacement-' + randomUUID())
  fs.mkdirSync(directory, { recursive: true })
  try {
    const ledger = path.join(directory, 'ledger.jsonl')
    const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', ...currentProtocolBinding(),
      codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId: 'd'.repeat(64),
      phase, milestone: 'diagnostic', caseId: 'R3', operation: policy.operations[0].id, invocationId: policy.closedInvocations[closedIndex],
      stageModel: { profileId: policy.profiles.flash.profileId, configurationHash: policy.profiles.flash.configurationHash },
      diagnosticInputHash: policy.source.contextSha256, diagnosticSourceHash: hash(policy.source),
      evaluationPolicyHash: hash(policy.evaluationPolicy), actual: { attemptId: 'old', runId: 'run', rootActionId: 'root',
        projectId: 'isolated-project', epoch: 'isolated-epoch', purpose: 'review-chapter' } }
    const oldBinding = { ...binding, codeSha: 'e'.repeat(40), protocolHash: protocol[boundaryKey].protocolHash }
    const original = [{ type: 'reserve', attemptId: 'candidate:old', binding: oldBinding, allocation: 'nonQualificationDiagnostic' },
      { type: 'dispatch', attemptId: 'candidate:old' }, { type: 'unknown', attemptId: 'candidate:old' }]
      .map(row => JSON.stringify(row) + '\n').join('')
    const boundary = { fromEventCount: 0, eventCount: 3, rawBytesSha256: hash(original),
      protocolRevision: oldBinding.protocolRevision, protocolHash: oldBinding.protocolHash,
      reserveAttempts: [{ attemptId: 'candidate:old', invocationId: policy.closedInvocations[closedIndex], terminal: 'unknown' }] }
    const options = { campaignMode: 'synthetic', [boundaryKey]: boundary }
    fs.writeFileSync(ledger, original)
    const invocationId = r3DiagnosticInvocation(2)
    const reserve = (attemptId, operation, purpose, invocation = invocationId) => ({ type: 'reserve', attemptId,
      binding: { ...binding, operation, invocationId: invocation,
        stageModel: { profileId: r3ModelForOperation(operation).profileId, configurationHash: r3ModelForOperation(operation).configurationHash },
        actual: { ...binding.actual, attemptId, purpose, rootActionId: operation === policy.operations[2].id ? 'final-root' : 'root' } } })
    assert.throws(() => updateLedger(ledger, reserve('reused', policy.operations[0].id, 'review-chapter', policy.closedInvocations[closedIndex]), options), /ATTEMPT_UNAVAILABLE/)
    assert.throws(() => updateLedger(ledger, reserve('bad-boundary', policy.operations[0].id, 'review-chapter'), {
      ...options, [boundaryKey]: { ...boundary, rawBytesSha256: '0'.repeat(64) } }), /SUPERSESSION_DRIFT/)
    const schedule = [
      [0, 'review-chapter', 'length'], [0, 'review-chapter', 'stop'],
      [1, 'refine-from-review', 'length'], [1, 'refine-from-review', 'length'],
      [1, 'refine-from-review', 'length'], [1, 'refine-from-review', 'stop'],
      [2, 'review-chapter', 'stop'], [2, 'review-chapter-rebuild', 'stop'],
    ]
    for (const [index, [operation, purpose, finishReason]] of schedule.entries()) {
      const attemptId = 'candidate:new-' + index
      updateLedger(ledger, reserve(attemptId, policy.operations[operation].id, purpose), options)
      updateLedger(ledger, { type: 'dispatch', attemptId }, options)
      updateLedger(ledger, { type: 'settle', attemptId, finishReason }, options)
    }
    assert.throws(() => updateLedger(ledger, reserve('ninth', policy.operations[2].id, 'review-chapter-rebuild'), options), /ATTEMPT_UNAVAILABLE/)
    assert.throws(() => updateLedger(ledger, reserve('third-invocation', policy.operations[0].id, 'review-chapter', randomUUID()), options), /ATTEMPT_UNAVAILABLE/)
    assert.ok(fs.readFileSync(ledger, 'utf8').startsWith(original))
    // A second UNKNOWN neither refunds this registration nor permits continuation.
    fs.writeFileSync(ledger, original)
    updateLedger(ledger, reserve('candidate:unknown', policy.operations[0].id, 'review-chapter'), options)
    updateLedger(ledger, { type: 'dispatch', attemptId: 'candidate:unknown' }, options)
    updateLedger(ledger, { type: 'unknown', attemptId: 'candidate:unknown' }, options)
    assert.throws(() => updateLedger(ledger, reserve('continue', policy.operations[0].id, 'review-chapter-rebuild'), options), /ATTEMPT_UNAVAILABLE/)
    assert.throws(() => updateLedger(ledger, reserve('restart', policy.operations[0].id, 'review-chapter', randomUUID()), options), /ATTEMPT_UNAVAILABLE/)
    assert.ok(fs.readFileSync(ledger, 'utf8').startsWith(original))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('historical open R3 registration excludes the authenticated closed Flash group without rewriting UNKNOWN', async () => {
  const { updateLedger, currentProtocolBinding } = await historicalOpenR3Runner()
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', `r3-history-${randomUUID()}`)
  fs.mkdirSync(directory, { recursive: true })
  try {
    const ledger = path.join(directory, 'ledger.jsonl'), profile = r3ModelForOperation(policy.operations[0].id)
    const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', ...currentProtocolBinding(),
      codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId: 'd'.repeat(64),
      phase, milestone: 'diagnostic', caseId: 'R3', operation: policy.operations[0].id, invocationId: protocol.historicalR3NativeRegistrationD51580fc.runs[0].invocationId,
      stageModel: { profileId: profile.profileId, configurationHash: profile.configurationHash },
      diagnosticInputHash: policy.source.contextSha256, diagnosticSourceHash: hash(policy.source), evaluationPolicyHash: hash(policy.evaluationPolicy),
      actual: { attemptId: 'old', runId: 'old-run', rootActionId: 'old-root', projectId: 'old-project', epoch: 'old-epoch', purpose: 'review-chapter' } }
    const frozen = count => {
      const reserveAttempts = []
      const rows = Array.from({ length: count }, (_, index) => {
        const attemptId = 'candidate:old-' + index
        reserveAttempts.push({ attemptId, invocationId: binding.invocationId, terminal: index === count - 1 ? 'unknown' : 'settle' })
        return [{ type: 'reserve', attemptId, binding, allocation: 'nonQualificationDiagnostic' },
          { type: 'dispatch', attemptId }, { type: index === count - 1 ? 'unknown' : 'settle', attemptId, ...(index === count - 1 ? {} : { finishReason: 'stop' }) }]
      }).flat()
      const raw = rows.map(row => JSON.stringify(row) + '\n').join('')
      fs.writeFileSync(ledger, raw)
      return { raw, options: { campaignMode: 'synthetic', historicalR3NativeD51580fcBoundary: {
        fromEventCount: 0, eventCount: rows.length, rawBytesSha256: hash(raw), protocolRevision: binding.protocolRevision,
        protocolHash: binding.protocolHash, reserveAttempts } } }
    }
    const next = { type: 'reserve', attemptId: 'candidate:new', binding: { ...binding, codeSha: 'e'.repeat(40), driverHash: 'f'.repeat(64),
      invocationId: policy.runs[1].invocationId, actual: { ...binding.actual, attemptId: 'new', runId: 'new-run', rootActionId: 'new-root', projectId: 'new-project', epoch: 'new-epoch' } } }
    const first = frozen(6)
    assert.throws(() => updateLedger(ledger, { ...next, binding: { ...next.binding, invocationId: binding.invocationId } }, first.options), /ATTEMPT_UNAVAILABLE/)
    assert.throws(() => updateLedger(ledger, next, { ...first.options, historicalR3NativeD51580fcBoundary: {
      ...first.options.historicalR3NativeD51580fcBoundary, rawBytesSha256: '0'.repeat(64) } }), /SUPERSESSION_DRIFT/)
    updateLedger(ledger, next, first.options)
    assert.ok(fs.readFileSync(ledger, 'utf8').startsWith(first.raw))
    assert.equal(fs.readFileSync(ledger, 'utf8').trimEnd().split('\n').map(JSON.parse).filter(row => row.type === 'reserve').length, 7)
    assert.equal(JSON.parse(first.raw.trimEnd().split('\n').at(-1)).type, 'unknown')
    assert.equal(policy.maxTotalPhysicalRequests, 24)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('SSE terminal shape records explicit null versus missing without leaking provider text', () => {
  const event = { id: 'secret-id', error: { message: 'secret-error' }, usage: { private: 'secret-usage' },
    choices: [{ finish_reason: null, delta: { content: 'secret-body', reasoning_content: 'secret-reasoning' } }] }
  assert.deepEqual(streamEventStructure(event), { choicesType: 'array', choicesCount: 1,
    finishType: 'null', finish: null, contentType: 'string', reasoningType: 'string', usageType: 'object', errorType: 'object' })
  assert.equal(streamEventStructure({ choices: [] }).finishType, 'undefined')
  event.choices[0].finish_reason = 'secret-unrecognized-finish'
  assert.equal(streamEventStructure(event).finish, null)
  assert.ok(!JSON.stringify(streamEventStructure(event)).includes('secret'))
  event.choices[0].finish_reason = 'stop'
  assert.equal(streamEventStructure(event).finish, 'stop')
})


test('R3 config copy retains only the hash-bound Flash profile and rejects a same-id Pro replacement', () => {
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', 'r3-profile-' + randomUUID())
  fs.mkdirSync(directory, { recursive: true })
  const source = path.join(directory, 'source'), target = path.join(directory, 'target')
  fs.mkdirSync(source); fs.mkdirSync(target)
  const models = Object.values(policy.profiles).map(profile => ({ ...profile.model, apiKey: 'synthetic-never-network' }))
  const original = { roots: { config: source }, modelId: policy.model.id, r3StageProfiles: policy.profiles }
  try {
    fs.writeFileSync(path.join(source, 'models.json'), JSON.stringify(models))
    copyIsolatedRealModelConfig(original, { config: target })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'models.json'))), models)
    models[0].modelName = 'deepseek-ai/DeepSeek-V4-Pro'
    fs.writeFileSync(path.join(source, 'models.json'), JSON.stringify(models))
    assert.throws(() => copyIsolatedRealModelConfig(original, { config: target }), /CONFIGURATION_DRIFT/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})


test('historical open R3 runs own independent state; UNKNOWN is spent and a fourth run is rejected', async () => {
  const { updateLedger, currentProtocolBinding } = await historicalOpenR3Runner(policy.runs.map(item => item.invocationId))
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', 'r3-three-' + randomUUID())
  fs.mkdirSync(directory, { recursive: true })
  const ledger = path.join(directory, 'ledger.jsonl')
  try {
    assert.equal(new Set(policy.runs.map(item => item.invocationId)).size, 3)
    for (const value of [undefined, 0, 4, '01', '1.0']) assert.throws(() => r3DiagnosticInvocation(value), /RUN_NOT_REGISTERED/)
    const profile = r3ModelForOperation(policy.operations[0].id)
    const binding = run => ({ campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', ...currentProtocolBinding(),
      codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId: 'd'.repeat(64),
      phase, milestone: 'diagnostic', caseId: 'R3', operation: policy.operations[0].id, invocationId: r3DiagnosticInvocation(run),
      stageModel: { profileId: profile.profileId, configurationHash: profile.configurationHash },
      diagnosticInputHash: policy.source.contextSha256, diagnosticSourceHash: hash(policy.source),
      evaluationPolicyHash: hash(policy.evaluationPolicy), actual: { attemptId: 'attempt-' + run, runId: 'run-' + run,
        rootActionId: 'root-' + run, projectId: 'project-' + run, epoch: 'epoch-' + run, purpose: 'review-chapter' } })
    const options = { campaignMode: 'synthetic' }
    for (const run of [1, 2, 3]) {
      const attemptId = 'candidate:run-' + run, value = binding(run)
      if (run > 1) {
        assert.throws(() => updateLedger(ledger, { type: 'reserve', attemptId,
          binding: { ...value, actual: { ...value.actual, projectId: 'project-1' } } }, options), /ISOLATION_REUSED/)
        assert.throws(() => updateLedger(ledger, { type: 'reserve', attemptId,
          binding: { ...value, codeSha: 'e'.repeat(40) } }, options), /EXECUTION_DRIFT/)
      }
      updateLedger(ledger, { type: 'reserve', attemptId, binding: value }, options)
      updateLedger(ledger, { type: 'dispatch', attemptId }, options)
      updateLedger(ledger, { type: 'unknown', attemptId }, options)
      assert.throws(() => updateLedger(ledger, { type: 'reserve', attemptId: attemptId + '-retry',
        binding: { ...value, actual: { ...value.actual, purpose: 'review-chapter-rebuild' } } }, options), /ATTEMPT_UNAVAILABLE/)
    }
    assert.throws(() => updateLedger(ledger, { type: 'reserve', attemptId: 'candidate:fourth',
      binding: { ...binding(3), invocationId: randomUUID() } }, options), /ATTEMPT_UNAVAILABLE/)
    assert.equal(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 9)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
