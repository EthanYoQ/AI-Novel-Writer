import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { R3_NATIVE_REVISION_DIAGNOSTIC as policy, productionScenario, qualificationBridgeWindows,
  assertForwardReasoning, readR3NativeSource } from '../quality-modernization-driver.mjs'
import { ROOT, CAMPAIGN_ID, currentProtocolBinding, selectPhase, forwardReasoningFor,
  forwardQualificationWindowFor, hash, updateLedger } from '../quality-modernization-run.mjs'

const phase = 'r3-native-revision-diagnostic'
const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')))

test('R3 native diagnostic isolates the exact medium profile and native deadline without changing old scopes', () => {
  assert.deepEqual(selectPhase(protocol, phase, 'diagnostic').operations, policy.operations)
  assert.deepEqual(productionScenario(phase, 'diagnostic'), policy)
  assert.throws(() => selectPhase(protocol, phase, 'final'), /MILESTONE/)
  const registration = forwardReasoningFor(protocol, phase, 'diagnostic')
  const input = { arm: 'candidate', phase, milestone: 'diagnostic', caseId: 'R3', model: policy.model,
    creativeStrategy: 'auto', resolution: { requested: 'medium', effective: 'medium', status: 'mapped', source: 'model-override' },
    body: { model: policy.model.modelName, temperature: 0, max_tokens: 16384, reasoning_effort: 'medium' } }
  assert.equal(assertForwardReasoning(registration, input).effective, 'medium')
  for (const change of [{ enable_thinking: true }, { reasoning_effort: 'high' }, { max_tokens: 8192 }])
    assert.throws(() => assertForwardReasoning(registration, { ...input, body: { ...input.body, ...change } }), /WIRE/)
  assert.throws(() => assertForwardReasoning(registration, { ...input, model: { ...policy.model, baseUrl: 'https://example.org/v1' } }), /MODEL/)
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
      phase, milestone: 'diagnostic', caseId: 'R3', operation: policy.operations[0].id, invocationId: randomUUID(),
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
