import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { R3_NATIVE_REVISION_DIAGNOSTIC as policy, productionScenario, qualificationBridgeWindows, createOperationDispatchGate,
  assertForwardReasoning, readR3NativeSource, streamEventStructure, r3DiagnosticInvocation, r3ModelForOperation, copyIsolatedRealModelConfig, QUALIFICATION_STAGE_MODELS } from '../quality-modernization-driver.mjs'
import { ROOT, CAMPAIGN_ID, currentProtocolBinding, selectPhase, forwardReasoningFor,
  forwardQualificationWindowFor, hash, updateLedger } from '../quality-modernization-run.mjs'

const phase = 'r3-native-revision-diagnostic'
const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')))

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

test('R3 Flash v9 preserves prior groups and closes the unused v8 third slot', () => {
  const v8 = protocol.historicalR3NativeRegistration2d67a3aa
  assert.equal(hash(v8), '4fa86ac4573c41bf4fb7a2be8c8d8220e0c2db81c614c8fe784adcda005aafe1')
  assert.deepEqual(policy.closedInvocations, [...v8.closedInvocations, ...v8.runs.map(item => item.invocationId)])
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
  assert.ok(policy.runs.every(item => !policy.closedInvocations.includes(item.invocationId)))
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
  assert.deepEqual(QUALIFICATION_STAGE_MODELS.profiles.flash.model, policy.model)
  const boundary = protocol.historicalR3Native11152245Boundary
  assert.deepEqual([boundary.fromEventCount, boundary.eventCount, boundary.reserveAttempts.length], [1650, 1668, 6])
  assert.equal(boundary.rawBytesSha256, '747454c7085bb348a9d939952ebf5b51cc7026d586d679bc85db8968537d93fd')
  assert.ok(boundary.reserveAttempts.every(item => item.terminal === 'settle' && item.invocationId !== previous.runs[2].invocationId))
  assert.deepEqual(QUALIFICATION_STAGE_MODELS, protocol.forwardStageModels)
  assert.equal(protocol.forwardStageModels.revision, 'candidate-single-official-flash-v2')
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
    updateLedger(ledger, reserve('candidate:first'), { campaignMode: 'synthetic' })
    updateLedger(ledger, { type: 'dispatch', attemptId: 'candidate:first' }, { campaignMode: 'synthetic' })
    updateLedger(ledger, { type: 'settle', attemptId: 'candidate:first', finishReason: 'stop' }, { campaignMode: 'synthetic' })
    assert.throws(() => updateLedger(ledger, reserve('restart', { invocationId: randomUUID() }), { campaignMode: 'synthetic' }), /ATTEMPT_UNAVAILABLE/)
    for (const slot of [...protocol.historicalR3NativeRegistrationD51580fc.runs, ...protocol.historicalR3NativeRegistrationAd650e85.runs, ...protocol.historicalR3NativeRegistration2d67a3aa.runs])
      assert.throws(() => updateLedger(ledger, reserve('closed-' + slot.run, { invocationId: slot.invocationId }), { campaignMode: 'synthetic' }), /ATTEMPT_UNAVAILABLE/)
    const original = fs.readFileSync(ledger, 'utf8')
    assert.equal(original.trim().split('\n').length, 3)
    assert.equal(JSON.parse(original.split('\n')[0]).allocation, 'nonQualificationDiagnostic')
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
])('R3 registered run preserves authenticated UNKNOWN in %s and caps its eight-call invocation', (boundaryKey, closedIndex) => {
  const directory = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', 'r3-replacement-' + randomUUID())
  fs.mkdirSync(directory, { recursive: true })
  try {
    const ledger = path.join(directory, 'ledger.jsonl')
    const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', ...currentProtocolBinding(),
      codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId: 'd'.repeat(64),
      phase, milestone: 'diagnostic', caseId: 'R3', operation: policy.operations[0].id, invocationId: policy.closedInvocations[closedIndex],
      stageModel: { profileId: QUALIFICATION_STAGE_MODELS.profiles.flash.profileId, configurationHash: QUALIFICATION_STAGE_MODELS.profiles.flash.configurationHash },
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

test('R3 v7 excludes the authenticated closed Flash group from its new budget without rewriting UNKNOWN', () => {
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


test('R3 three fixed GLM runs own independent state; UNKNOWN is spent and a fourth run is rejected', () => {
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
