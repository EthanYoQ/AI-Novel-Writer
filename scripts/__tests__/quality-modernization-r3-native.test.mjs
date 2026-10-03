import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { R3_NATIVE_REVISION_DIAGNOSTIC as policy, productionScenario, qualificationBridgeWindows,
  assertForwardReasoning, readR3NativeSource, streamEventStructure, r3DiagnosticInvocation, r3ModelForOperation, copyIsolatedRealModelConfig } from '../quality-modernization-driver.mjs'
import { ROOT, CAMPAIGN_ID, currentProtocolBinding, selectPhase, forwardReasoningFor,
  forwardQualificationWindowFor, hash, updateLedger } from '../quality-modernization-run.mjs'

const phase = 'r3-native-revision-diagnostic'
const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')))

test('R3 forward group preserves the closed registration and only changes the new semantic scope', () => {
  const previous = protocol.historicalR3NativeRegistration49e1c0ad
  assert.equal(hash(previous), '7d59b55e6aff45a7b0b9487721eeb89f26ab826d1981cf3733d9873cec11be39')
  assert.notEqual(policy.scenarioRevision, previous.scenarioRevision)
  assert.deepEqual(policy.closedInvocations, [...previous.closedInvocations, ...previous.runs.map(item => item.invocationId)])
  assert.ok(policy.runs.every(item => !policy.closedInvocations.includes(item.invocationId)))
  for (const key of ['source', 'model', 'profiles', 'operationProfiles', 'operations', 'attemptPolicy', 'evaluationPolicy', 'minPhysicalRequests', 'maxPhysicalRequests', 'maxTotalPhysicalRequests'])
    assert.deepEqual(policy[key], previous[key])
  for (const [key, value] of Object.entries(previous.acceptance)) assert.deepEqual(policy.acceptance[key], value)
  assert.equal(policy.acceptance.scope, 'new-group-only-no-historical-reclassification-or-section-5-waiver')
  assert.equal(policy.acceptance.stop, 'when-two-of-three-impossible-remaining-NOT_RUN-no-redraw')
})

test('R3 native stage profiles freeze Qwen/Qwen/Qwen and retain the native deadline', () => {
  assert.deepEqual(selectPhase(protocol, phase, 'diagnostic').operations, policy.operations)
  assert.deepEqual(productionScenario(phase, 'diagnostic'), policy)
  assert.throws(() => selectPhase(protocol, phase, 'final'), /MILESTONE/)
  const registration = forwardReasoningFor(protocol, phase, 'diagnostic')
  for (const operation of policy.operations) {
    const profile = r3ModelForOperation(operation.id), effort = profile.model.reasoningOverride
    const input = { arm: 'candidate', phase, milestone: 'diagnostic', caseId: 'R3', operationId: operation.id, model: profile.model,
      creativeStrategy: 'auto', resolution: { requested: effort, effective: effort, status: 'mapped', source: 'model-override' },
      body: { model: profile.model.modelName, temperature: 0, max_tokens: 16384, enable_thinking: true, thinking_budget: 16384 } }
    assert.equal(assertForwardReasoning(registration, input).effective, effort)
    for (const change of [{ reasoning_effort: 'medium' }, { enable_thinking: false }, { thinking_budget: 8192 }, { max_tokens: 8192 }, { model: 'deepseek-ai/DeepSeek-V4-Pro' }])
      assert.throws(() => assertForwardReasoning(registration, { ...input, body: { ...input.body, ...change } }), /WIRE/)
    assert.throws(() => assertForwardReasoning(registration, { ...input, model: { ...profile.model, modelName: 'deepseek-ai/DeepSeek-V4-Pro' } }), /MODEL/)
  }
  assert.equal(forwardQualificationWindowFor(protocol, phase, 'diagnostic'), null)
  const request = { ...policy, phase, target: { arm: 'candidate' } }
  const windows = qualificationBridgeWindows(request)
  assert.ok(windows.attemptMs > 3_600_000 && windows.spawnMs > windows.attemptMs * 8)
  assert.throws(() => qualificationBridgeWindows({ ...request, operations: policy.operations.slice(1) }), /SCOPE/)
  assert.equal(forwardReasoningFor(protocol, 'early-review', 'post-ui').model.modelName, 'deepseek-ai/DeepSeek-V4-Pro')
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
      phase, milestone: 'diagnostic', caseId: 'R3', operation: policy.operations[0].id, invocationId: r3DiagnosticInvocation(1),
      stageModel: { profileId: policy.profiles.qwen.profileId, configurationHash: policy.profiles.qwen.configurationHash },
      diagnosticInputHash: policy.source.contextSha256, diagnosticSourceHash: hash(policy.source),
      evaluationPolicyHash: hash(policy.evaluationPolicy), actual: { attemptId: 'first', runId: 'run', rootActionId: 'root',
        projectId: 'new-project', epoch: 'new-epoch', purpose: 'review-chapter' } }
    const reserve = (attemptId, extra = {}) => ({ type: 'reserve', attemptId, binding: { ...binding, ...extra } })
    assert.throws(() => updateLedger(ledger, reserve('bad', { diagnosticInputHash: '0'.repeat(64) }), { campaignMode: 'synthetic' }), /SOURCE_BINDING/)
    updateLedger(ledger, reserve('candidate:first'), { campaignMode: 'synthetic' })
    updateLedger(ledger, { type: 'dispatch', attemptId: 'candidate:first' }, { campaignMode: 'synthetic' })
    updateLedger(ledger, { type: 'settle', attemptId: 'candidate:first', finishReason: 'stop' }, { campaignMode: 'synthetic' })
    assert.throws(() => updateLedger(ledger, reserve('restart', { invocationId: randomUUID() }), { campaignMode: 'synthetic' }), /ATTEMPT_UNAVAILABLE/)
    const original = fs.readFileSync(ledger, 'utf8')
    assert.equal(original.trim().split('\n').length, 3)
    assert.equal(JSON.parse(original.split('\n')[0]).allocation, 'nonQualificationDiagnostic')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})


test.each([
  ['historicalR3NativeD12c4111Boundary', 0],
  ['historicalR3Native49e1c0adBoundary', 3],
])('R3 registered run preserves authenticated UNKNOWN in %s and caps its eight-call invocation', (boundaryKey, closedIndex) => {
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', 'r3-replacement-' + randomUUID())
  fs.mkdirSync(directory, { recursive: true })
  try {
    const ledger = path.join(directory, 'ledger.jsonl')
    const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', ...currentProtocolBinding(),
      codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId: 'd'.repeat(64),
      phase, milestone: 'diagnostic', caseId: 'R3', operation: policy.operations[0].id, invocationId: policy.closedInvocations[closedIndex],
      stageModel: { profileId: policy.profiles.qwen.profileId, configurationHash: policy.profiles.qwen.configurationHash },
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
    const invocationId = r3DiagnosticInvocation(1)
    const reserve = (attemptId, operation, purpose, invocation = invocationId) => ({ type: 'reserve', attemptId,
      binding: { ...binding, operation, invocationId: invocation,
        stageModel: { profileId: r3ModelForOperation(operation).profileId, configurationHash: r3ModelForOperation(operation).configurationHash },
        actual: { ...binding.actual, attemptId, purpose, rootActionId: operation === policy.operations[2].id ? 'final-root' : 'root' } } })
    assert.throws(() => updateLedger(ledger, reserve('reused', policy.operations[0].id, 'review-chapter', policy.closedInvocations[closedIndex]), options), /ATTEMPT_UNAVAILABLE/)
    assert.throws(() => updateLedger(ledger, reserve('bad-boundary', policy.operations[0].id, 'review-chapter'), {
      ...options, [boundaryKey]: { ...boundary, rawBytesSha256: '0'.repeat(64) } }), /SUPERSESSION_DRIFT/)
    const schedule = [
      [0, 'review-chapter', 'stop'], [0, 'review-chapter-rebuild', 'stop'],
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


test('R3 config copy retains only the hash-bound Qwen profile and rejects a same-id Pro replacement', () => {
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


test('R3 three fixed runs own independent state; UNKNOWN is spent and a fourth run is rejected', () => {
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
