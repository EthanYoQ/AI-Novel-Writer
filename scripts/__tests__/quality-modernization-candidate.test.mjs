import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { productionScenario, fullExecutionSchedule, runProductionPhasePair, executionRecordIdentity } from '../quality-modernization-driver.mjs'
import { ROOT, validatePair, candidateBatchSlots, assertCandidateSlotAvailable, aggregateCandidateJudgments, selectPhase, hash, adjudicateCandidateBatch } from '../quality-modernization-run.mjs'
import { targetUnitRange } from '../quality-modernization-receipt.mjs'

const revision = 's14b-candidate-only-three-rounds-v1'

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
