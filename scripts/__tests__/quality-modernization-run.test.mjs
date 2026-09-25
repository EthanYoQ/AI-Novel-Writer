import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ROOT, PLANNED_CALL_ALLOCATION, CAMPAIGN_ID, campaignIdFor, hash, currentProtocolBinding, assertProtocolBinding, validateHistoricalLedgerBoundary, validateCampaignBinding, buildFixtureExports, validatePair, selectPhase, assertScenarioMatchesProtocol, reconcileDispatchedAttempts, withLedgerReconciliation, updateLedger, main, inspectTarget, freezeEnvironment, fixedStartup, validateFrozenExecution, runnerAdapterHash, assertCommittedProductionFiles, assertFormalTargetCandidateClean, createShortIsolationRoot, assertOwnedIsolationRoot, validatePhysicalLedger, registeredCampaignWorktree, developmentLedgerPath } from '../quality-modernization-run.mjs'
import { COMMAND_PROBES, selectOwnerDispatch, productionBridgeHash, copyIsolatedRealModelConfig, PHASE_SCENARIOS, classifyProductionPair,
  adjudicateEarlyReviewReferenceNonconformance, EARLY_REVIEW_REFERENCE_ADJUDICATION_REVISION,
  readBaselineFailureEvidence, validateEarlyContextSelectionDifference,
  validateEarlyReviewChain, targetUnitsGateEvidence,
  createAttemptSupervisor, createOperationDispatchGate, createOutboundPreflightAssert,
  rejectOutsidePhysicalBoundary, assertNoOutboundPreflightFailures, fetchProviderResponse, measurePromptBytes,
  BRIDGE_SETTLEMENT_DEADLINE_MS, BRIDGE_SPAWN_TIMEOUT_MS, BRIDGE_TEST_TIMEOUT_MS } from '../quality-modernization-driver.mjs'
import { projectRecoveryCandidateSupplement, readVerifiedRecoveryCandidateSupplement,
  readVerifiedDirectPersistedDraftEvidence, recordPersistedDraftObservation,
  safeReceiptDiagnostic } from '../quality-modernization-receipt.mjs'
import Database from 'better-sqlite3'
import { countDraftUnits } from '../../src/shared/draft-units'

const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/novel-quality-modernization/semantic-source.json')))
const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')))
const protocolBinding = currentProtocolBinding()

function constructReviewSourceFixture() {
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  const sourceStart = fixture.indexOf('const REVIEW_DEFECT =')
  const sourceEnd = fixture.indexOf('const syntheticReview =', sourceStart)
  assert.ok(sourceStart >= 0 && sourceEnd > sourceStart, 'REVIEW_SOURCE_HELPER_NOT_FOUND')
  const sandbox = { assert, reviewSourceText: null, reviewFix: null, reviewRevisionFixtureVerdict: null }
  vm.runInNewContext(`${fixture.slice(sourceStart, sourceEnd)}\nthis.reviewSourceText = reviewSourceText; this.reviewFix = REVIEW_FIX; this.reviewRevisionFixtureVerdict = reviewRevisionFixtureVerdict`, sandbox)
  assert.equal(typeof sandbox.reviewSourceText, 'function')
  assert.equal(typeof sandbox.reviewFix, 'string')
  assert.equal(typeof sandbox.reviewRevisionFixtureVerdict, 'function')
  const scene = source.scenes.find(value => value.id === '场景3')
  const chapter = scene?.chapters.find(value => value.number === 2)
  assert.ok(scene && chapter, 'REVIEW_SOURCE_SCENARIO_MISSING')
  return { text: sandbox.reviewSourceText(countDraftUnits, scene, chapter), reviewFix: sandbox.reviewFix,
    reviewRevisionFixtureVerdict: sandbox.reviewRevisionFixtureVerdict, chapter }
}
test('冻结规划脚本通过原Node入口执行全部合同反例', () => {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'docs/plans/novel-quality-program-v3-2026-09-13/checks/feature-union-check.test.mjs'),
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr || String(result.error || '规划合同检查失败'))
  const receipt = JSON.parse(result.stdout)
  assert.equal(receipt.status, 'PASS')
  assert.equal(receipt.scope, 'plan-contract fixtures only; product checks NOT RUN')
  assert.equal(receipt.groups, 16)
  assert.equal(receipt.actions, 153)
  assert.equal(receipt.negativeCases, 29)
})
function pair() {
  const exports = buildFixtureExports(source)
  return { targets: { baseline: { arm: 'baseline', codeSha: 'a'.repeat(40), fixture: exports.legacy }, candidate: { arm: 'candidate', codeSha: 'b'.repeat(40), subjectSha: 'b'.repeat(40), fixture: exports.canonical } }, observed: [{ sourceHash: 'a', repositoryRoot: '/甲', roots: ['/甲数据'] }, { sourceHash: 'b', repositoryRoot: '/乙', roots: ['/乙数据'] }] }
}
test('help不触文件、模型或启动目标；参数拒绝', () => {
  assert.equal(main(['help']).physicalModelRequests, 0)
  assert.throws(() => main(['full', '--execute', 'yes']), /INVALID_ARGUMENT/)
})
test('pending-independent-oracle-review使用独立进程退出码3', () => {
  const runner = pathToFileURL(path.join(ROOT, 'scripts/quality-modernization-run.mjs')).href
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `import { exitCodeForStatus } from ${JSON.stringify(runner)}; process.exitCode = exitCodeForStatus('pending-independent-oracle-review')`],
  { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  assert.equal(child.status, 3, child.stderr || String(child.error ?? ''))
})
test('三乘三两臂与原80帽含post-UI备份预留', () => {
  assert.equal(source.scenes.length, 3)
  assert.equal(source.scenes.flatMap(s => s.chapters).length * 2, 18)
  assert.equal(Object.values(protocol.allocation).reduce((a, b) => a + b, 0), protocol.plannedCallAllocation)
  for (const phase of ['early-budget', 'early-context', 'early-review']) assert.equal(selectPhase(protocol, phase, 'post-ui').milestone, 'post-ui')
  assert.equal(selectPhase(protocol, 'full', 'final').caseIds.length, 9)
  assert.equal(protocol.phases['early-budget'].operations.reduce((n, op) => n + op.minimumCalls, 0), 4)
  assert.equal(protocol.allocation.postUiBudget, 4)
  // 生产桥只接线已登记的场景；每个场景的 caseId 与 operation id 必须逐字等于协议。
  for (const phase of ['early-budget', 'early-context', 'early-review']) {
    assert.equal(PHASE_SCENARIOS[phase].caseId, protocol.phases[phase].caseIds[0])
    assert.deepEqual(PHASE_SCENARIOS[phase].operations.map(operation => operation.id),
      protocol.phases[phase].operations.map(operation => operation.id))
  }
  assert.doesNotThrow(() => assertScenarioMatchesProtocol(selectPhase(protocol, 'early-context'), PHASE_SCENARIOS['early-context']))
  assert.equal(protocol.phases['early-context'].scenarioRevision, 's10b-early-context-selection-difference-v3')
  assert.equal(protocol.phases['early-context'].scenarioRevision, source.scenes[1].contextSelection.scenarioRevision)
  const v2 = protocol.historicalIntentionToTreat.additionalFailedInvocations
    .find(item => item.invocationId === '5a7f78fd-d0db-4b63-8564-bdce426b73f0')
  assert.equal(v2?.disposition, 'observed-quality-failure-experiment-inconclusive')
  assert.match(v2?.reason ?? '', /质量失败|时点与节奏失败/u)
  assert.match(v2?.reason ?? '', /因果|归因/u)
  const optionalLine = source.scenes[1].contextSelection.optionalPredecessors[0].line
  const relevantChapters = source.scenes[1].chapters
    .filter(chapter => chapter.number <= PHASE_SCENARIOS['early-context'].chapterNumber)
  const forbiddenOptionalLineTokens = [
    ...source.scenes[1].characters,
    ...relevantChapters.flatMap(chapter => [
      ...chapter.requiredEvents,
      ...Object.values(chapter.oracle ?? {}).flatMap(value => Array.isArray(value) ? value : [value]),
    ]),
    '核查', '代价', '承担抄录代价',
  ].filter(token => typeof token === 'string' && token.length > 0)
  assert.ok(forbiddenOptionalLineTokens.includes('发现异常'))
  assert.ok(forbiddenOptionalLineTokens.includes('当天清晨'))
  for (const token of forbiddenOptionalLineTokens) assert.equal(optionalLine.includes(token), false, `optional line contains forbidden token: ${token}`)
  assert.match(optionalLine, /物理元数据/)
  assert.match(optionalLine, /不是作者事实/)
  assert.ok(optionalLine.includes(source.scenes[1].title), 'optional stimulus must pass relevance before budget selection')
  assert.equal(source.scenes[1].contextSelection.optionalPredecessors[0].chapterNumber, 1)
  const chapter = source.scenes[1].chapters[PHASE_SCENARIOS['early-context'].chapterNumber - 1]
  const authorityText = [source.scenes[1].material, source.scenes[1].longSetting, chapter.brief,
    chapter.requiredEvents, source.scenes[1].characters, source.template, `本章时点：${chapter.oracle.time}`]
    .flat().filter(Boolean).join('\n')
  for (const fact of Object.values(chapter.oracle).flatMap(value => Array.isArray(value) ? value : [value]))
    assert.ok(authorityText.includes(fact), `oracle fact lacks author authority: ${fact}`)
  assert.throws(() => assertScenarioMatchesProtocol({ ...selectPhase(protocol, 'early-context'), scenarioRevision: 'drift' }, PHASE_SCENARIOS['early-context']), /SCENARIO_PROTOCOL_MISMATCH/)
  assert.equal(PHASE_SCENARIOS['early-review'].caseId, '场景3/2')
  assert.equal(PHASE_SCENARIOS['early-review'].scenarioRevision, 's11-early-review-per-attempt-deadline-v3')
  assert.equal(protocol.phases['early-review'].scenarioRevision, 's11-early-review-per-attempt-deadline-v3')
  assert.doesNotThrow(() => assertScenarioMatchesProtocol(selectPhase(protocol, 'early-review'), PHASE_SCENARIOS['early-review']))
  assert.deepEqual(PHASE_SCENARIOS['early-review'].operations.map(item => item.kind), ['review', 'refine', 'recheck'])
  assert.equal(PHASE_SCENARIOS.full, undefined)
  assert.throws(() => selectPhase(protocol, 'full', 'early'), /MISMATCH/)
  assert.ok(source.deterministicCases.C16.length >= 10 && source.deterministicCases.C17.length >= 10)
})

test('同一预注册 operation 在第二次 provider dispatch 前 fail closed', () => {
  const rejections = []
  const beforeDispatch = createOperationDispatchGate({ onReject: rejection => rejections.push(rejection) })
  assert.doesNotThrow(() => beforeDispatch('长设定第三章正文'))
  assert.throws(() => beforeDispatch('长设定第三章正文'), error => error.code === 'OPERATION_DISPATCH_REJECTED'
    && error.message === 'MODEL_REQUEST_REJECTED')
  assert.deepEqual(rejections, [{ code: 'UNREGISTERED_ADDITIONAL_MODEL_REQUEST', operationId: '长设定第三章正文',
    reason: 'duplicate-operation', beforeDispatch: true }])
  assert.doesNotThrow(() => beforeDispatch('另一个已登记 operation'))

  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  const driver = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-driver.mjs'), 'utf8')
  assert.ok(fixture.includes('invocationId: request.invocationId'), 'request identity must reach receipt and binding')
  assert.ok(driver.includes('const common = { invocationId,'), 'pair invocation must reach every bridge request')
  assert.equal(fixture.includes('receipt.localDispatchGateRejection'), false, 'local side-channel must not alter the formal receipt')
})

function earlyReviewChain(arm) {
  const cycleId = 'cycle:' + 'c'.repeat(64)
  const rootActionId = 'root-review'
  const predecessorHash = '7'.repeat(64)
  const promptHash = '8'.repeat(64)
  const materialDecision = { version: 1, verdict: 'admitted',
    capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 100 },
    coverage: { required: 1, included: 1, complete: true },
    included: [{ sourceId: 'finalized:2', revision: 2, contentHash: predecessorHash,
      category: 'finalized-history', required: true, units: 100 }], omitted: [], promptHash }
  const result = {
    operations: [
      { operation: '审稿', kind: 'review', outputHash: '2'.repeat(64) },
      { operation: '定向修稿', kind: 'refine', outputHash: '4'.repeat(64) },
      { operation: '一次复核', kind: 'recheck', outputHash: '5'.repeat(64) },
    ],
    attempts: ['审稿', '定向修稿', '一次复核'].map((operation, index) => ({
      binding: { operation, actual: arm === 'candidate' ? { rootActionId, runId: `run-${index}` } : undefined },
      ...(arm === 'candidate' && index === 0 ? { userPromptHash: promptHash,
        authorityEvidence: { predecessorHash }, optionalMaterialEvidence: { materialDecision } } : {}),
    })),
    reviewLifecycle: {
      source: { contentHash: '1'.repeat(64) },
      review: { contentHash: '2'.repeat(64), ...(arm === 'candidate' ? { cycleId } : {}) },
      confirmation: { contentHash: '3'.repeat(64), selectedItemHash: '6'.repeat(64),
        ...(arm === 'candidate' ? { cycleId, selectedFindingIds: ['finding:one'] } : { selectedFindingIds: [] }) },
      revision: { contentHash: '4'.repeat(64) },
      merge: { mergedHash: '4'.repeat(64), ...(arm === 'candidate' ? { cycleId, disposition: 'required' } : {}) },
      recheck: { contentHash: '5'.repeat(64), ...(arm === 'candidate'
        ? { cycleId, recheckCount: 1, disposition: 'completed', statuses: { unknown: 1, unverified: 1 },
            effect: { version: 2, findingMappings: 0 } } : {}) },
    },
  }
  if (arm === 'candidate') {
    result.physicalProject = { readback: { predecessors: [{ sourceId: 'finalized:2', revision: 2,
      contentHash: predecessorHash, required: true }] } }
    result.materialDecisions = [{ operation: '审稿', receipt: structuredClone(materialDecision) }]
  }
  return result
}

function additiveEarlyReviewEvidence() {
  const invocationId = '6be2697b-e456-4f99-af73-55a1d71deff8'
  const protocolRevision = 's10b-reference-baseline-v2'
  const protocolHash = 'd'.repeat(64)
  const parityId = 'e'.repeat(64)
  const shared = { invocationId, mode: 'real', phase: 'early-review', caseId: '场景3/2',
    protocolRevision, protocolHash, syntheticDispatches: 0 }
  const binding = (arm, operation, index) => ({ campaignId: CAMPAIGN_ID, ...shared, arm,
    codeSha: (arm === 'baseline' ? 'a' : 'b').repeat(40), sourceHash: (arm === 'baseline' ? '1' : '2').repeat(64),
    driverHash: '3'.repeat(64), parityId, milestone: 'early', operation,
    ...(arm === 'candidate' ? { actual: { attemptId: `candidate-${index}`, runId: `run-${index}`,
      rootActionId: 'root-review', projectId: 'project-1', epoch: 'epoch-1' } } : {}) })
  const baselineReviewArtifactText = '```json\n' + JSON.stringify({
    items: [{ category: '剧情连贯性', severity: 'pass', description: '无可执行问题' }], summary: '未发现问题',
  }, null, 2) + '\n```'
  const baselineBinding = binding('baseline', '审稿', 0)
  const baseline = { ...shared, arm: 'baseline', status: 'failed', error: 'REAL_PROVIDER_DIAGNOSTIC_REDACTED',
    physicalModelRequests: 1, codeSha: baselineBinding.codeSha, sourceHash: baselineBinding.sourceHash,
    driverHash: baselineBinding.driverHash, physicalProject: { parityHash: parityId },
    invocations: ['llm:generate-stream', 'db:review-create', 'llm:close-execution-lease',
      'db:review-get-latest', 'db:review-get-full'],
    attempts: [{ attemptId: 'baseline:baseline-0', binding: baselineBinding }],
    operations: [{ operation: '审稿', kind: 'review', outputPath: '/evidence/1-review.json',
      returnedHash: hash(baselineReviewArtifactText), outputHash: '4'.repeat(64) }] }
  const candidate = { ...earlyReviewChain('candidate'), ...shared, arm: 'candidate', status: 'passed',
    physicalModelRequests: 3, codeSha: 'b'.repeat(40), sourceHash: '2'.repeat(64), driverHash: '3'.repeat(64),
    projectEpoch: 'epoch-1' }
  candidate.physicalProject = { ...candidate.physicalProject, projectId: 'project-1', parityHash: parityId }
  candidate.attempts.forEach((attempt, index) => {
    const actual = binding('candidate', attempt.binding.operation, index).actual
    attempt.binding = binding('candidate', attempt.binding.operation, index)
    attempt.attemptId = `candidate:${actual.attemptId}`
    candidate.operations[index].handle = { runId: actual.runId, rootActionId: actual.rootActionId }
  })
  const ledgerEvents = [baseline.attempts[0], ...candidate.attempts].flatMap(attempt => [
    { type: 'reserve', attemptId: attempt.attemptId, binding: structuredClone(attempt.binding) },
    { type: 'dispatch', attemptId: attempt.attemptId },
    { type: 'settle', attemptId: attempt.attemptId, finishReason: 'stop' },
  ])
  return { results: [baseline, candidate], baselineReviewArtifactText, ledgerEvents }
}

test('early-review 闭环要求同 root 与逐层 hash', () => {
  assert.deepEqual(validateEarlyReviewChain(earlyReviewChain('baseline'), 'baseline'), { valid: true })
  assert.deepEqual(validateEarlyReviewChain(earlyReviewChain('candidate'), 'candidate'), { valid: true })
  const splitRoot = earlyReviewChain('candidate')
  splitRoot.attempts[2].binding.actual.rootActionId = 'another-root'
  assert.deepEqual(validateEarlyReviewChain(splitRoot, 'candidate'), { valid: false, pairFailure: 'REVIEW_CHAIN_ROOT_MISMATCH' })
  const forgedMerge = earlyReviewChain('candidate')
  forgedMerge.reviewLifecycle.merge.mergedHash = '9'.repeat(64)
  assert.deepEqual(validateEarlyReviewChain(forgedMerge, 'candidate'), { valid: false, pairFailure: 'REVIEW_CHAIN_RECEIPT_INVALID' })
  const forgedResolved = earlyReviewChain('candidate')
  forgedResolved.reviewLifecycle.recheck.statuses = { resolved: 1, unverified: 1 }
  assert.deepEqual(validateEarlyReviewChain(forgedResolved, 'candidate'), { valid: false, pairFailure: 'REVIEW_CYCLE_RECEIPT_INVALID' })
  const forgedMaterialHash = earlyReviewChain('candidate')
  forgedMaterialHash.attempts[0].optionalMaterialEvidence.materialDecision.included[0].contentHash = '9'.repeat(64)
  assert.deepEqual(validateEarlyReviewChain(forgedMaterialHash, 'candidate'), { valid: false, pairFailure: 'REVIEW_MATERIAL_DECISION_MISMATCH' })
  const forgedPromptHash = earlyReviewChain('candidate')
  forgedPromptHash.attempts[0].optionalMaterialEvidence.materialDecision.promptHash = '9'.repeat(64)
  assert.deepEqual(validateEarlyReviewChain(forgedPromptHash, 'candidate'), { valid: false, pairFailure: 'REVIEW_MATERIAL_DECISION_MISMATCH' })
  const forgedDecisionCopy = earlyReviewChain('candidate')
  forgedDecisionCopy.materialDecisions[0].receipt.included[0].contentHash = '9'.repeat(64)
  assert.deepEqual(validateEarlyReviewChain(forgedDecisionCopy, 'candidate'), { valid: false, pairFailure: 'REVIEW_MATERIAL_DECISION_MISMATCH' })
})

test('S11 离线加性裁决保留原失败并只放行完整候选进入独立内容验收', () => {
  const evidence = additiveEarlyReviewEvidence()
  const options = { mode: 'real', phase: 'early-review',
    adjudicationRevision: EARLY_REVIEW_REFERENCE_ADJUDICATION_REVISION,
    baselineReviewArtifactText: evidence.baselineReviewArtifactText, ledgerEvents: evidence.ledgerEvents }
  assert.equal(classifyProductionPair(evidence.results, options).pairFailure, 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH')
  assert.deepEqual(adjudicateEarlyReviewReferenceNonconformance(evidence.results, options), {
    invocationId: '6be2697b-e456-4f99-af73-55a1d71deff8',
    originalPairFailure: 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH',
    derivedReason: 'baseline-all-pass-review-terminal',
    baselineDisposition: 'reference-nonconforming-no-actionable-review',
    candidateTechnicalQualification: 'passed', overall: 'pending-independent-oracle',
  })
  assert.equal(adjudicateEarlyReviewReferenceNonconformance(evidence.results,
    { ...options, adjudicationRevision: 'unfrozen' }).pairFailure, 'ADJUDICATION_REVISION_MISMATCH')

  const invalidCases = [
    ['BASELINE_REVIEW_ARTIFACT_INVALID', value => { value.options.baselineReviewArtifactText += 'drift' }],
    ['BASELINE_REVIEW_ARTIFACT_INVALID', value => {
      value.options.baselineReviewArtifactText = 'not json'
      value.results[0].operations[0].returnedHash = hash('not json')
    }],
    ['BASELINE_ACTIONABLE_REVIEW_PRESENT', value => {
      value.options.baselineReviewArtifactText = JSON.stringify({ items: [{ severity: 'warning' }] })
      value.results[0].operations[0].returnedHash = hash(value.options.baselineReviewArtifactText)
    }],
    ['BASELINE_TERMINAL_TRACE_INVALID', value => { delete value.results[0].invocations }],
    ['BASELINE_TERMINAL_TRACE_INVALID', value => { value.results[0].invocations.push('db:review-get-latest') }],
    ['BASELINE_TERMINAL_TRACE_INVALID', value => { value.results[0].invocations.unshift('llm:generate-stream') }],
    ['BASELINE_TERMINAL_TRACE_INVALID', value => { value.results[0].invocations.splice(2, 0, 'db:review-create') }],
    ['LEDGER_SETTLEMENT_INVALID', value => { value.options.ledgerEvents.splice(2, 1) }],
    ['CANDIDATE_TECHNICAL_EVIDENCE_INVALID', value => { value.results[1].operations.pop() }],
  ]
  for (const [failure, mutate] of invalidCases) {
    const value = additiveEarlyReviewEvidence()
    value.options = { ...options, baselineReviewArtifactText: value.baselineReviewArtifactText,
      ledgerEvents: value.ledgerEvents }
    mutate(value)
    assert.equal(adjudicateEarlyReviewReferenceNonconformance(value.results, value.options).pairFailure, failure)
  }
})
test('同语义源双格式合同可比，改原材料与模型参数均拒绝', () => {
  const { targets, observed } = pair()
  assert.equal(validatePair(targets, observed).qualification, 'target-identity-only')
  targets.candidate.fixture.parametersHash = hash('不同参数')
  assert.throws(() => validatePair(targets, observed), /PARITY/)
  targets.candidate.fixture = buildFixtureExports({ ...source, template: '另一模板' }).canonical
  assert.throws(() => validatePair(targets, observed), /PARITY/)
})
test('不同标签、克隆源码、同路径、subject漂移不能冒充双目标', () => {
  for (const mutate of [p => p.targets.candidate.codeSha = p.targets.baseline.codeSha, p => p.observed[1].sourceHash = p.observed[0].sourceHash, p => p.observed[1].repositoryRoot = p.observed[0].repositoryRoot]) {
    const p = pair(); mutate(p); assert.throws(() => validatePair(p.targets, p.observed), /IDENTICAL/)
  }
  const p = pair(); p.targets.candidate.subjectSha = 'c'.repeat(40)
  assert.throws(() => validatePair(p.targets, p.observed), /SUBJECT/)
})
test('相交数据根拒绝，格式错误拒绝', () => {
  const p = pair(); p.observed[1].roots = [path.join('/甲数据', 'nested')]
  assert.throws(() => validatePair(p.targets, p.observed), /ROOT_INTERSECTION/)
  const q = pair(); q.targets.candidate.fixture.format = 'legacy'
  assert.throws(() => validatePair(q.targets, q.observed), /FORMAT/)
})
test('伪manifest不能跳过实际git身份检查', () => {
  assert.throws(() => inspectTarget({ schemaVersion: 1, arm: 'baseline', repositoryRoot: ROOT, codeSha: '0'.repeat(40) }), /TARGET_SHA_MISMATCH/)
})

test('S14A隔离根是短实体目录并核所有权，真实账本不能从本工作树新建', () => {
  const root = createShortIsolationRoot()
  const baseline = path.join(root, 'b')
  const project = path.join(baseline, 'p')
  const ledger = developmentLedgerPath(root, 'early-budget')
  try {
    fs.mkdirSync(project, { recursive: true })
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false)
    assert.equal(assertOwnedIsolationRoot(baseline, 'baseline'), fs.realpathSync.native(baseline))
    const owner = JSON.parse(fs.readFileSync(path.join(root, '.vibe-owner.json'), 'utf8'))
    assert.equal(owner.sourceProject, ROOT)
    assert.equal(owner.ttl, '7 days')
    assert.ok(owner.cleanupCommand.includes(root))
    const longest = Math.max(...source.scenes.map(scene => path.join(fs.realpathSync.native(project), '12345678', scene.title).length))
    if (process.platform === 'win32') assert.ok(longest <= 85, `actual project root would be ${longest} characters`)
    assert.throws(() => assertOwnedIsolationRoot(baseline, 'candidate'), /UNOWNED_ISOLATION_ROOT/)
    fs.writeFileSync(path.join(root, '.vibe-owner.json'), JSON.stringify({ ...owner, sourceProject: 'foreign' }))
    assert.throws(() => assertOwnedIsolationRoot(baseline, 'baseline'), /UNOWNED_ISOLATION_ROOT/)
    assert.throws(() => validatePhysicalLedger(path.join(root, 'physical-ledger.jsonl')), /PATH_MISMATCH/)
    const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', ...protocolBinding, arm: 'baseline', codeSha: 'a'.repeat(40),
      sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
      phase: 'early-budget', milestone: 'early', caseId: '场景1/1', operation: '指定范围生成' }
    assert.throws(() => updateLedger(path.join(root, 'synthetic-ledger.jsonl'),
      { type: 'reserve', attemptId: 'external', binding }, { campaignMode: 'synthetic' }), /UNOWNED_LEDGER/)
    assert.equal(path.dirname(ledger), path.join(ROOT, '.runtime', '.cache', 'novel-quality-modernization'))
    updateLedger(ledger, { type: 'reserve', attemptId: 'cache-owned', binding }, { campaignMode: 'synthetic' })
    updateLedger(ledger, { type: 'dispatch', attemptId: 'cache-owned' }, { campaignMode: 'synthetic' })
    updateLedger(ledger, { type: 'settle', attemptId: 'cache-owned' }, { campaignMode: 'synthetic' })
    assert.deepEqual(fs.readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line).type), ['reserve', 'dispatch', 'settle'])
    assert.equal(fs.existsSync(`${ledger}.lock`), false)
  } finally {
    if (fs.existsSync(ledger)) fs.unlinkSync(ledger)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('真实账本仅绑定登记分支的唯一工作树，拒绝重复和待修剪登记', () => {
  const branch = 'branch refs/heads/codex/program-v3-autonomous-continuation'
  const entry = `worktree C:/registered/d103\nHEAD ${'a'.repeat(40)}\n${branch}`
  assert.equal(registeredCampaignWorktree(entry), 'C:/registered/d103')
  assert.throws(() => registeredCampaignWorktree(`${entry}\n\n${entry}`), /CAMPAIGN_WORKTREE_NOT_UNIQUE/)
  assert.throws(() => registeredCampaignWorktree(`${entry}\nprunable gitdir file points to non-existent location`), /CAMPAIGN_WORKTREE_NOT_UNIQUE/)
  assert.throws(() => registeredCampaignWorktree(`worktree C:/other\nHEAD ${'b'.repeat(40)}\nbranch refs/heads/other`), /CAMPAIGN_WORKTREE_NOT_UNIQUE/)
})
test('账本未知不释放、重试新attempt、无硬上限、重复/并发/残记录拒绝', () => {
  const parent = path.join(ROOT, '.runtime/.cache/novel-quality-modernization')
  fs.mkdirSync(parent, { recursive: true })
  const dir = fs.mkdtempSync(path.join(parent, 'ledger-test-'))
  const file = path.join(dir, 'ledger.jsonl')
  const binding = { arm: 'baseline', codeSha: 'a'.repeat(40), parityId: 'b'.repeat(64) }
  try {
    updateLedger(file, { type: 'reserve', attemptId: '取消前', binding })
    updateLedger(file, { type: 'cancel', attemptId: '取消前' })
    for (let i = 0; i < PLANNED_CALL_ALLOCATION; i++) {
      updateLedger(file, { type: 'reserve', attemptId: `请求${i}`, binding })
      updateLedger(file, { type: 'dispatch', attemptId: `请求${i}` })
      updateLedger(file, { type: i === 0 ? 'unknown' : 'settle', attemptId: `请求${i}` })
    }
    // 用户于 2026-09-18 移除真实调用硬上限：超出计划额度的请求不再被拒绝，但仍然记账。
    const over = updateLedger(file, { type: 'reserve', attemptId: '超额', binding })
    assert.equal(over.cap, null)
    assert.equal(over.occupied, PLANNED_CALL_ALLOCATION + 1)
    assert.throws(() => updateLedger(file, { type: 'cancel', attemptId: '请求0' }), /TRANSITION/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: '请求0', binding }), /INVALID_RESERVATION/)
    fs.writeFileSync(`${file}.lock`, '')
    assert.throws(() => updateLedger(file, { type: 'cancel', attemptId: '不存在' }), /LEDGER_BUSY/)
    fs.unlinkSync(`${file}.lock`)
    fs.appendFileSync(file, '{')
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: '新', binding }))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
test('命令探针固定三入口；选择器不包含英文产品用例', () => {
  assert.equal(COMMAND_PROBES.length, 3)
  assert.ok(COMMAND_PROBES.every(row => !/English/.test(row.name)))
})

test('真实隔离配置只复制指定生成模型，不继承默认 embedding 模型', () => {
  const root = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/real-config-test-'))
  const source = path.join(root, 'source'), isolated = path.join(root, 'isolated')
  fs.mkdirSync(source); fs.mkdirSync(isolated)
  const profiles = [{ id: 'approved', apiKey: 'test-only-secret' }, { id: 'other', apiKey: 'other-test-secret' }]
  const sourceConfig = { defaultModelId: 'approved', locale: 'en-US' }
  fs.writeFileSync(path.join(source, 'models.json'), JSON.stringify(profiles))
  fs.writeFileSync(path.join(source, 'config.json'), JSON.stringify(sourceConfig))
  try {
    copyIsolatedRealModelConfig({ roots: { config: source }, modelId: 'approved' }, { config: isolated })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(isolated, 'models.json'), 'utf8')), [profiles[0]])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(isolated, 'config.json'), 'utf8')), { locale: 'zh-CN' })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source, 'config.json'), 'utf8')), sourceConfig)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('冻结执行验证拒绝adapter、Node版本/ABI、依赖、启动参数、native旁证篡改', () => {
  const parent = path.join(ROOT, '.runtime/.cache/novel-quality-modernization')
  fs.mkdirSync(parent, { recursive: true })
  const dir = fs.mkdtempSync(path.join(parent, 'environment-test-'))
  const receipt = path.join(dir, 'profile.json')
  fs.writeFileSync(receipt, JSON.stringify({ scope: '合成环境合同测试，非native资格' }))
  const target = { repositoryRoot: ROOT, isolationRoot: dir, runnerAdapterHash: runnerAdapterHash(), environment: freezeEnvironment(ROOT), nativeProfile: { path: receipt, sha256: hash(fs.readFileSync(receipt)), evidenceOnly: true } }
  target.startup = fixedStartup(target)
  try {
    assert.doesNotThrow(() => validateFrozenExecution(target))
    for (const [mutate, code] of [
      [t => t.runnerAdapterHash = '0'.repeat(64), /RUNNER_ADAPTER_MISMATCH/],
      [t => t.environment.node.version = 'v0.0.0', /EXECUTION_ENVIRONMENT_MISMATCH/],
      [t => t.environment.node.modulesAbi = '0', /EXECUTION_ENVIRONMENT_MISMATCH/],
      [t => t.environment.dependencies[0].version = '0', /EXECUTION_ENVIRONMENT_MISMATCH/],
      [t => t.startup.argv.push('--execute'), /STARTUP_MISMATCH/],
      [t => t.startup.shell = true, /STARTUP_MISMATCH/],
      [t => t.nativeProfile.sha256 = '0'.repeat(64), /NATIVE_PROFILE_MISMATCH/],
    ]) {
      const changed = structuredClone(target); mutate(changed)
      assert.throws(() => validateFrozenExecution(changed), code)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('实际SQLite唯一dispatch须匹配原handle、项目epoch与实际输出上限', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE generation_runs(run_id TEXT,root_action_id TEXT,binding_json TEXT); CREATE TABLE generation_attempts(attempt_id TEXT,run_id TEXT,root_action_id TEXT,attempt_json TEXT)')
  const session = { projectId: 'project', leaseId: 'epoch' }, handle = { projectId: 'project', epoch: 'epoch', rootActionId: 'root', runId: 'run' }
  const body = { max_tokens: 4096 }
  try {
    assert.throws(() => selectOwnerDispatch(db, handle, session, body), /NON_UNIQUE/)
    db.prepare('INSERT INTO generation_runs VALUES(?,?,?)').run('run', 'root', JSON.stringify({ projectId: 'project', epoch: 'epoch' }))
    db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?)').run('attempt', 'run', 'root', JSON.stringify({ attemptId: 'attempt', status: 'dispatch-marked', requestedOutputTokens: 4096 }))
    assert.equal(selectOwnerDispatch(db, handle, session, body).attemptId, 'attempt')
    for (const delta of [{ rootActionId: 'foreign' }, { runId: 'foreign' }, { projectId: 'foreign' }, { epoch: 'old' }]) assert.throws(() => selectOwnerDispatch(db, { ...handle, ...delta }, session, body), /IDENTITY/)
    assert.throws(() => selectOwnerDispatch(db, handle, session, { max_tokens: 4095 }), /IDENTITY/)
    assert.throws(() => selectOwnerDispatch(db, undefined, session, body), /IDENTITY/)
    db.exec("UPDATE generation_attempts SET attempt_json=json_set(attempt_json,'$.status','unknown')")
    assert.throws(() => selectOwnerDispatch(db, handle, session, body), /NON_UNIQUE/)
    db.exec("UPDATE generation_attempts SET attempt_json=json_set(attempt_json,'$.status','dispatch-marked'); INSERT INTO generation_attempts SELECT * FROM generation_attempts")
    assert.throws(() => selectOwnerDispatch(db, handle, session, body), /NON_UNIQUE/)
  } finally { db.close() }
})

test('campaign保留后续阶段计划分配，unknown与修复超出原22仍继续记账且不能换账', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/campaign-test-'))
  const file = path.join(dir, 'synthetic-ledger.jsonl')
  const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', ...protocolBinding, arm: 'baseline', codeSha: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64), phase: 'early-budget', milestone: 'early', caseId: '场景1/1', operation: '指定范围生成' }
  const record = event => updateLedger(file, event, { campaignMode: 'synthetic' })
  const issue = (id, value = binding) => { record({ type: 'reserve', attemptId: id, binding: value }); record({ type: 'dispatch', attemptId: id }); record({ type: 'unknown', attemptId: id }) }
  try {
    issue('first')
    for (let i = 0; i < 22; i++) issue(`repair${i}`)
    issue('beyond-planned-repair')
    issue('still-available-primary-draft', { ...binding, operation: '900单位正文' })
    issue('still-available-post-ui', { ...binding, milestone: 'post-ui' })
    assert.throws(() => updateLedger(path.join(dir, 'other-real.jsonl'), { type: 'reserve', attemptId: 'new', binding: { ...binding, mode: 'real' } }, { campaignMode: 'real' }), /PATH_MISMATCH/)
    assert.throws(() => record({ type: 'cancel', attemptId: 'first' }), /TRANSITION/)
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(rows.filter(row => row.allocation === 'failedRetryRepairReviewReserve').length, 23)
    assert.equal(rows.find(row => row.attemptId === 'still-available-primary-draft')?.allocation, 'earlyBudget')
    assert.equal(rows.find(row => row.attemptId === 'still-available-post-ui')?.allocation, 'postUiBudget')
    rows[0].allocation = 'postUiBudget'; fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n')
    assert.throws(() => record({ type: 'reserve', attemptId: 'tampered', binding }), /ALLOCATION_MISMATCH/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('early-context 按协议取 caseId/operation，额度走 earlyContext/postUiContext', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/context-campaign-test-'))
  const file = path.join(dir, 'synthetic-ledger.jsonl')
  const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', ...protocolBinding, arm: 'baseline', codeSha: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
    phase: 'early-context', milestone: 'early', caseId: '场景2/3', operation: '长设定第三章正文' }
  const actual = { attemptId: 'attempt-1', runId: 'run-1', rootActionId: 'root-1', projectId: 'project-1', epoch: 'epoch-1' }
  const record = event => updateLedger(file, event, { campaignMode: 'synthetic' })
  const issue = (id, value = binding) => { record({ type: 'reserve', attemptId: id, binding: value }); record({ type: 'dispatch', attemptId: id }); record({ type: 'settle', attemptId: id }); return value }
  try {
    issue('ctx-baseline')
    issue('ctx-candidate', { ...binding, arm: 'candidate', actual })
    // 两个不同臂的槽位吃满 earlyContext 的协议分配额（2）；同槽重试只吃失败/修复余量。
    issue('ctx-retry', binding)
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.type === 'reserve')
    assert.deepEqual(rows.map(row => row.allocation), ['earlyContext', 'earlyContext', 'failedRetryRepairReviewReserve'])
    // post-UI 重跑属于另一个桶（协议 postUiContext: 2），不与 early 混用。
    issue('ctx-post-ui', { ...binding, milestone: 'post-ui' })
    const postUi = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).find(row => row.attemptId === 'ctx-post-ui')
    assert.equal(postUi.allocation, 'postUiContext')
    // 错 caseId、错 operation、未登记阶段（full 只有 caseIds）一律拒绝。
    assert.throws(() => record({ type: 'reserve', attemptId: 'wrong-case', binding: { ...binding, caseId: '场景1/1' } }), /INVALID_CAMPAIGN_BINDING/)
    assert.throws(() => record({ type: 'reserve', attemptId: 'wrong-op', binding: { ...binding, operation: 'directory' } }), /INVALID_CAMPAIGN_BINDING/)
    assert.throws(() => record({ type: 'reserve', attemptId: 'wrong-phase', binding: { ...binding, phase: 'full', caseId: '场景2/3' } }), /INVALID_CAMPAIGN_BINDING/)
    assert.throws(() => record({ type: 'reserve', attemptId: 'wrong-early-budget-op', binding: { ...binding, phase: 'early-budget', caseId: '场景1/1', operation: '长设定第三章正文' } }), /INVALID_CAMPAIGN_BINDING/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('campaign id 按 ADR 0019 取代协议 id，账本与 bridge 取同一个常量', () => {
  // 2f259cd 把 bridge 一侧的字符串改成 ...-uncapped-v1，却把协议 id 留在 ...-80-v1：
  // 于是早门在第一次发送前就以 INVALID_CAMPAIGN_BINDING 阻断。取代关系只能写一处。
  assert.equal(protocol.id, 'novel-quality-program-v3-80-v1')
  assert.equal(CAMPAIGN_ID, 'novel-quality-program-v3-uncapped-v1')
  assert.equal(CAMPAIGN_ID, campaignIdFor(protocol.id))
  assert.equal(campaignIdFor('未登记协议'), '未登记协议')
  const target = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  assert.ok(target.includes('campaignId: CAMPAIGN_ID'), 'bridge 必须共用 CAMPAIGN_ID')
  assert.ok(!/novel-quality-program-v3-(?:80|uncapped)-v1'/.test(target), 'bridge 不再硬编码 campaign id')
})

test('协议revision和hash绑定新目标与新reserve，历史账本仅按冻结前缀兼容', () => {
  assert.equal(protocolBinding.protocolRevision, protocol.decisionRevision)
  assert.doesNotThrow(() => assertProtocolBinding(protocolBinding))
  assert.throws(() => assertProtocolBinding({ ...protocolBinding, protocolHash: '0'.repeat(64) }), /PROTOCOL_DRIFT/)
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/protocol-ledger-test-'))
  const file = path.join(dir, 'synthetic-ledger.jsonl')
  const legacyBinding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'baseline', codeSha: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
    phase: 'early-context', milestone: 'early', caseId: '场景2/3', operation: '长设定第三章正文' }
  const frozenOldSelection = { ...legacyBinding, arm: 'candidate', caseId: '场景2/2', operation: '长设定第二章正文' }
  const actual = { attemptId: 'attempt-2', runId: 'run-2', rootActionId: 'root-2', projectId: 'project-2', epoch: 'epoch-2' }
  try {
    assert.doesNotThrow(() => validateCampaignBinding(frozenOldSelection,
      { campaignMode: 'synthetic', protocol, historical: true }))
    assert.throws(() => validateCampaignBinding(frozenOldSelection,
      { campaignMode: 'synthetic', protocol }), /INVALID_CAMPAIGN_BINDING|PROTOCOL_DRIFT/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'missing-binding',
      binding: { ...legacyBinding, arm: 'candidate', actual } }, { campaignMode: 'synthetic' }), /PROTOCOL_DRIFT/)
    assert.doesNotThrow(() => updateLedger(file, { type: 'reserve', attemptId: 'bound-v2',
      binding: { ...legacyBinding, ...protocolBinding, arm: 'candidate', actual } }, { campaignMode: 'synthetic' }))
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(rows[0].binding.protocolHash, protocolBinding.protocolHash)
    rows[0].binding.protocolHash = '4d94afc7771835da40a3b2ef09017a7356815b95e37a6b6436ba768bc060ded4'
    fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n')
    assert.throws(() => updateLedger(file, { type: 'dispatch', attemptId: 'bound-v2' }, { campaignMode: 'synthetic' }), /PROTOCOL_DRIFT/)
    const historicalRows = [
      { type: 'reserve', attemptId: 'historical-v1', binding: legacyBinding, allocation: 'earlyContext' },
      { type: 'dispatch', attemptId: 'historical-v1' },
      { type: 'settle', attemptId: 'historical-v1' },
    ]
    const raw = `${historicalRows.map(JSON.stringify).join('\n')}\n`
    const boundary = { eventCount: 3, rawBytesSha256: hash(raw), evidenceInvocationId: 'e8900180-945a-4211-b0c9-8427389c0625', finalReserveAttemptIds: ['historical-v1'] }
    assert.equal(validateHistoricalLedgerBoundary(raw, boundary), 3)
    assert.throws(() => validateHistoricalLedgerBoundary(raw.replace('earlyContext', 'earlyReview'), boundary), /BOUNDARY_DRIFT/)
    assert.throws(() => validateHistoricalLedgerBoundary(raw.replaceAll('\n', '\r\n'), boundary), /BOUNDARY_DRIFT/)
    const firstLineEnd = raw.indexOf('\n') + 1
    assert.throws(() => validateHistoricalLedgerBoundary(raw.slice(0, firstLineEnd) + '\n' + raw.slice(firstLineEnd), boundary), /BOUNDARY_DRIFT/)
    assert.throws(() => validateHistoricalLedgerBoundary(raw, { ...boundary, finalReserveAttemptIds: ['missing'] }), /EVIDENCE_MISSING/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('冻结旧selection与旧allocation经boundary回放，新reserve仍按当前协议完整校验', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/historical-replay-test-'))
  const file = path.join(dir, 'synthetic-ledger.jsonl')
  const oldBinding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'baseline', codeSha: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
    phase: 'early-context', milestone: 'early', caseId: '场景2/2', operation: '长设定第二章正文' }
  const historicalRows = [
    { type: 'reserve', attemptId: 'old-v2', binding: oldBinding, allocation: 'failedRetryRepairReviewReserve' },
    { type: 'dispatch', attemptId: 'old-v2' },
    { type: 'settle', attemptId: 'old-v2' },
  ]
  const raw = `${historicalRows.map(JSON.stringify).join('\n')}\n`
  const boundary = { eventCount: historicalRows.length, rawBytesSha256: hash(raw),
    evidenceInvocationId: '5a7f78fd-d0db-4b63-8564-bdce426b73f0', finalReserveAttemptIds: ['old-v2'] }
  const currentBinding = { ...oldBinding, ...protocolBinding, caseId: '场景2/3', operation: '长设定第三章正文' }
  const options = { campaignMode: 'synthetic', historicalLedgerBoundary: boundary }
  try {
    fs.writeFileSync(file, raw)
    assert.doesNotThrow(() => updateLedger(file,
      { type: 'reserve', attemptId: 'current-v3', binding: currentBinding }, options))
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(rows.at(-1).allocation, 'earlyContext')
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'wrong-current',
      binding: { ...currentBinding, caseId: '场景2/2' } }, options), /INVALID_CAMPAIGN_BINDING/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'candidate-without-owner',
      binding: { ...currentBinding, arm: 'candidate' } }, options), /ACTUAL_OWNER_ATTEMPT_REQUIRED/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('超时守护为每个 dispatch 独立计时：先写 unknown 再 abort，且后续 attempt 不继承残余预算', async () => {
  // 桥测试的 120s 超时是进程内计时器：不投信号、不跑 finally。供应商卡住时，
  // 「等流结束再写终态」永远等不到，账本只剩 reserve+dispatch。守护必须自己到点收尾。
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/guard-test-'))
  const file = path.join(dir, 'synthetic-ledger.jsonl')
  const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', ...protocolBinding, arm: 'baseline', codeSha: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
    phase: 'early-context', milestone: 'early', caseId: '场景2/3', operation: '长设定第三章正文' }
  try {
    const record = event => updateLedger(file, event, { campaignMode: 'synthetic' })
    const supervisor = createAttemptSupervisor({ record, deadlineMs: 80 })
    const first = new AbortController()
    const second = new AbortController()
    // 取消发生在 dispatch 之前的预留：它必须保持「未发送」，不被守护伪造成已发送。
    record({ type: 'reserve', attemptId: 'cancelled-before-dispatch', binding })
    record({ type: 'cancel', attemptId: 'cancelled-before-dispatch' })
    record({ type: 'reserve', attemptId: 'first', binding })
    record({ type: 'dispatch', attemptId: 'first' })
    supervisor.watch('first', first)
    assert.equal(supervisor.openAttempts(), 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    record({ type: 'reserve', attemptId: 'second', binding })
    record({ type: 'dispatch', attemptId: 'second' })
    supervisor.watch('second', second)
    await new Promise(resolve => setTimeout(resolve, 50))
    let rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(rows.filter(row => row.attemptId === 'first').map(row => row.type), ['reserve', 'dispatch', 'unknown'])
    assert.equal(rows.find(row => row.attemptId === 'first' && row.type === 'unknown')?.reasonCode,
      'BRIDGE_SETTLEMENT_DEADLINE_EXCEEDED')
    assert.equal(first.signal.aborted, true)
    assert.equal(second.signal.aborted, false, '后登记的 attempt 必须获得完整独立预算')
    assert.equal(supervisor.expired('first'), true)
    assert.equal(supervisor.expired('second'), false)
    assert.equal(supervisor.openAttempts(), 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(rows.filter(row => row.attemptId === 'second').map(row => row.type), ['reserve', 'dispatch', 'unknown'])
    assert.equal(second.signal.aborted, true)
    assert.equal(supervisor.openAttempts(), 0)
    // 幂等：晚到的终态不能改写同一次发送，也不能再多落一行。
    const before = fs.readFileSync(file, 'utf8')
    assert.equal(supervisor.terminal('first', 'settle', { finishReason: 'stop' }), false)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    // dispatch 过的发送只能是 settle/unknown：不能取消释放，也不能重开同一 attempt。
    assert.throws(() => record({ type: 'cancel', attemptId: 'first' }), /TRANSITION/)
    assert.throws(() => record({ type: 'reserve', attemptId: 'first', binding }), /INVALID_RESERVATION/)
    assert.deepEqual(rows.filter(row => row.attemptId === 'cancelled-before-dispatch').map(row => row.type), ['reserve', 'cancel'])
    supervisor.dispose()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('请求规模证据只存字节数、取自真正出站的请求体，且守护确实接在桥里', () => {
  // 纯数字、可 grep：字节数必须等于该载荷的 JSON 序列化长度，多字节按真实 UTF-8 计。
  const payload = [{ role: 'user', content: '雨停后到现场核查' }]
  assert.equal(measurePromptBytes(payload), Buffer.byteLength(JSON.stringify(payload), 'utf8'))
  assert.ok(measurePromptBytes([{ role: 'user', content: 'a' }]) > measurePromptBytes([{ role: 'user', content: '' }]))
  assert.equal(measurePromptBytes(undefined), Buffer.byteLength('[]', 'utf8'))
  const fixturePath = path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs')
  const fixture = fs.readFileSync(fixturePath, 'utf8')
  // 规模取自真正出站的请求体（compiled prompt 的字节数），不是模板、哈希或预算估算。
  assert.ok(/composedPromptBytes:\s*measurePromptBytes\(body\.messages\)/.test(fixture), '收据必须记录出站提示词字节数')
  assert.ok(fixture.includes('receipt.composedPromptBytes = receipt.attempts.reduce'), '每臂必须有一个可比较的合计字节数')
  assert.ok(fixture.includes('requestSizes'), '每臂必须保留逐次发送的规模明细')
  // 守护必须真的接在桥里，且失败路径也走它；否则超时仍会丢掉终态。
  assert.ok(fixture.includes('createAttemptSupervisor({ record })'), '桥必须拥有自己的结算守护')
  assert.ok(fixture.includes('supervisor.watch(attemptId, controller)'), '每次发送都必须登记进守护')
  assert.ok(/supervisor\.terminal\(attemptId, 'unknown'\)/.test(fixture), '失败路径也必须经守护写终态')
  assert.ok(!/record\(\{ type: 'unknown', attemptId \}\)/.test(fixture), '不存在绕过守护的裸 unknown 写入')
  // early-review 有三次串行发送；外层预算必须覆盖三个完整 attempt，并保证 attempt 守护
  // 先收口，父进程 spawn 与 Vitest 依次兜底。
  assert.ok(BRIDGE_SETTLEMENT_DEADLINE_MS * 3 < BRIDGE_SPAWN_TIMEOUT_MS)
  assert.ok(BRIDGE_SPAWN_TIMEOUT_MS < BRIDGE_TEST_TIMEOUT_MS)
  assert.ok(fixture.includes('}, BRIDGE_TEST_TIMEOUT_MS)'), 'fixture 顶层测试必须使用同一外层预算')
})

test('bridge 在记账前按 operation 校验出站权威，且只把真实 provider 失败归入 fetchFailures', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  const recheckGate = fixture.indexOf("if (operationKind === 'recheck' && candidate)")
  const reserve = fixture.indexOf("record({ type: 'reserve', attemptId, binding })")
  const dispatch = fixture.indexOf("record({ type: 'dispatch', attemptId })")
  assert.ok(recheckGate >= 0 && recheckGate < reserve && reserve < dispatch,
    'recheck 的确定性权威校验必须在 campaign reserve/dispatch 之前完成')
  assert.ok(fixture.includes('OUTBOUND_RECHECK_MERGED_DRAFT_MISSING'))
  assert.ok(fixture.includes('OUTBOUND_RECHECK_FINDING_ID_MISSING'))
  assert.ok(fixture.includes('OUTBOUND_RECHECK_TARGET_ID_MISSING'))
  assert.match(fixture, /if \(operationKind === 'recheck' && candidate\)[\s\S]*?\} else \{[\s\S]*?OUTBOUND_REQUIRED_PREDECESSOR_MISSING/,
    '逐字前情校验只属于普通 review/refine，不得误套到 recheck')
  assert.ok(fixture.includes('createOutboundPreflightAssert(receipt.preflightFailures ??= [])'))
  assert.ok(fixture.includes('fetchProviderResponse(originalFetch'))
  assert.ok(fixture.includes('globalThis.fetch = physicalFetch'), '全局 fetch 不得再把本地 preflight 失败混入 fetchFailures')
})

test('外围请求即使被调用方捕获，prepare 与 execute 也不能通过', async () => {
  const receipt = { preflightFailures: [], physicalModelRequests: 0, syntheticDispatches: 0 }
  try { await Promise.resolve().then(() => rejectOutsidePhysicalBoundary(receipt)) } catch { /* 产品可回退 FTS */ }
  assert.deepEqual(receipt.preflightFailures, ['NETWORK_OUTSIDE_PHYSICAL_BOUNDARY'])
  assert.throws(() => assertNoOutboundPreflightFailures(receipt), /OUTBOUND_PREFLIGHT_FAILURES/)
  assert.equal(receipt.physicalModelRequests, 0)
  assert.equal(receipt.syntheticDispatches, 0)
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  assert.ok(fixture.includes('globalThis.fetch = async () => rejectOutsidePhysicalBoundary(receipt)'))
  assert.match(fixture, /if \(request\.action === 'prepare'\) \{ assertNoOutboundPreflightFailures\(receipt\); receipt\.status = 'prepared'/)
  assert.match(fixture, /assertNoOutboundPreflightFailures\(receipt\)\s+receipt\.status = 'passed'/)
})

test('early-review 从生产定稿历史发送必需前章，而不是借当前正文复述蒙混通过', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  assert.match(fixture,
    /request\.phase === 'early-review'[\s\S]*?invoke\('db:draft-authority-sequence', project\.rootPath, session\)[\s\S]*?invoke\('db:draft-import-finalized-batch',[\s\S]*?expectedAuthorityFingerprint[\s\S]*?project\.rootPath, session\)/,
    'early-review 的前章来源必须经原子定稿导入生产 IPC 进入 review history')
  assert.equal(fixture.includes("invoke('db:draft-update-status'"), false,
    'fixture 不得绕过原子定稿合同直接切换 draft status')
  assert.match(fixture,
    /requiredPredecessor[\s\S]*?materialDecision\.included\.some[\s\S]*?required === true/,
    'early-review 必须校验必需前章已进入材料准入收据')
  assert.ok(fixture.includes('REVIEW_PROMPT_PRIVATE_FIXTURE_LEAK'), '真实出站 prompt 必须拒绝夹具元话语和私有修法泄露')
  assert.match(fixture,
    /request\.phase === 'early-review' && operationKind === 'refine'[\s\S]*?OUTBOUND_REFINE_SOURCE_DRAFT_MISSING[\s\S]*?\} else \{[\s\S]*?OUTBOUND_ORACLE_AUTHORITY_MISSING/,
    '定向修稿应校验当前正文与已确认审稿绑定，不得要求重复发送不属于该 prompt 合同的全套世界观')
})

test('early-review 提供已实现代价验收标准且正文不泄露固定修法', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  const { text, reviewFix, reviewRevisionFixtureVerdict, chapter } = constructReviewSourceFixture()
  assert.ok(countDraftUnits(text) >= 2_400 && countDraftUnits(text) <= 3_600)
  assert.equal(text.split('许遥把三种处置都抄进未决栏').length - 1, 1, '自然行为链 defect 必须恰好出现一次')
  assert.equal(text.includes(reviewFix), false, '待审正文不能泄露私有 REVIEW_FIX')
  for (const phrase of [
    '作者提供的前情', '眼下仍在第二章', '知识边界栏', '尚未实施的方案不得写为既成事实',
    '不能提前写成', '没有为了让叙述更完整', '既定历史', '证据锚点', '验收标准',
  ]) assert.equal(text.includes(phrase), false, `待审正文含元评审旁白：${phrase}`)
  for (const fixedAnswerFragment of ['名字随即被划去', '已到账的收据编号'])
    assert.equal(text.includes(fixedAnswerFragment), false, `待审正文泄露固定修法：${fixedAnswerFragment}`)
  for (const fact of Object.values(chapter.oracle).flatMap(value => Array.isArray(value) ? value : [value])
    .filter(fact => fact !== chapter.oracle.knowledge && fact !== chapter.oracle.planning))
    assert.ok(text.includes(fact), `review source 缺少 oracle 事实：${fact}`)
  assert.ok(text.includes('周砚只说旧设备清单记过一面备用镜，自己从未见过实物'))
  assert.ok(text.includes('把便签别进未办夹，昨夜日志仍停在原来的最后一行'))
  assert.match(fixture, /authorGuidance: '.*人物已经执行选择.*具体损失或牺牲已经发生.*后文不保留相反状态.*签字认责/)
  assert.match(fixture, /reviewFocus: '.*严格只输出模板约定的 JSON 根对象.*具体损失已经发生.*后文没有反证.*签字认责/)

  const validAlternatives = [
    reviewFix,
    '许遥拆下自己的应急电源接上除湿器，电量当场耗尽；返程班车开走后，她在档案室守了一整夜，次日排班记录因此标为缺席。',
  ]
  for (const sample of validAlternatives) assert.equal(reviewRevisionFixtureVerdict(sample).valid, true, `有效修订被拒绝：${sample}`)
  for (const sample of [
    '许遥决定承担代价。',
    '许遥在处置单上签字承担责任。',
    '许遥保证负责，将放弃休息，以后补偿。',
    '许遥留下看守，随后仍按原定时间离开。',
    '许遥已经签字，但后文签名栏空白，这里还没人落笔。',
  ]) assert.equal(reviewRevisionFixtureVerdict(sample).valid, false, `无效修订被放行：${sample}`)
})

test('recovery supplement 只投影真实 baseline 的单次 draft 失败', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  const gateStart = fixture.indexOf("const canProjectRecoveryCandidate = request.mode === 'real'")
  const queryStart = fixture.indexOf("recoveryRows = database.getProjectDb().prepare('SELECT * FROM recovery_candidates').all()")
  assert.ok(gateStart >= 0 && gateStart < queryStart, '必须先完成窄资格判定，再读取 recovery candidates')
  const gate = fixture.slice(gateStart, queryStart)
  for (const condition of [
    '!candidate',
    "request.action === 'execute'",
    'request.operations.length === 1',
    "request.operations[0]?.kind === 'draft'",
    'receipt.operations.length === 0',
    'receipt.attempts.length === 1',
    'Boolean(localDispatchGateRejection)',
  ]) assert.ok(gate.includes(condition), `recovery supplement 缺少资格条件：${condition}`)
  assert.doesNotMatch(gate, /kind === 'review'|kind === 'recheck'/,
    'baseline review/recheck duplicate-dispatch 不得被 recovery supplement 遮蔽')
})

test('preflight 失败不记 reserve/dispatch，provider 失败才记 fetchFailure 与 dispatch unknown', async () => {
  const preflightFailures = [], fetchFailures = [], ledger = []
  const preflight = createOutboundPreflightAssert(preflightFailures)
  assert.throws(() => {
    preflight(false, 'OUTBOUND_RECHECK_MERGED_DRAFT_MISSING')
    ledger.push('reserve', 'dispatch')
  }, /OUTBOUND_RECHECK_MERGED_DRAFT_MISSING/)
  assert.deepEqual(preflightFailures, ['OUTBOUND_RECHECK_MERGED_DRAFT_MISSING'])
  assert.deepEqual(fetchFailures, [])
  assert.deepEqual(ledger, [])

  ledger.push('reserve', 'dispatch')
  const supervisor = createAttemptSupervisor({ record: event => ledger.push(event.type), deadlineMs: 0 })
  supervisor.watch('provider-attempt', new AbortController())
  await assert.rejects(fetchProviderResponse(async () => { throw new Error('NETWORK_DOWN') }, 'https://provider.invalid', {},
    fetchFailures, value => value), /NETWORK_DOWN/)
  supervisor.terminal('provider-attempt', 'unknown')
  supervisor.dispose()
  assert.deepEqual(preflightFailures, ['OUTBOUND_RECHECK_MERGED_DRAFT_MISSING'])
  assert.deepEqual(fetchFailures, ['NETWORK_DOWN'])
  assert.deepEqual(ledger, ['reserve', 'dispatch', 'unknown'])
})

function s10bSelectionEvidence(arm) {
  const invocationId = '33333333-3333-4333-8333-333333333333'
  const registered = [{ sourceId: 'candidate:1', revision: 2, contentHash: 'a'.repeat(64),
    persistedContentHash: 'b'.repeat(64), persistedBytes: 3840, markerHash: 'b'.repeat(64) }]
  const sent = arm === 'baseline' ? [{ ...registered[0] }] : []
  const optionalMaterialEvidence = { registered, sent, sentSourceIds: sent.map(item => item.sourceId),
    ...(arm === 'candidate' ? { materialDecision: {
      version: 1, verdict: 'admitted', promptHash: 'c'.repeat(64),
      capacity: { maxInputUnits: 18000, methodVersion: 'utf8-bytes-v1', admittedUnits: 100 },
      coverage: { required: 1, included: 1, complete: true },
      included: [{ sourceId: 'author:required', revision: 1, contentHash: 'd'.repeat(64), category: 'author', required: true, units: 100 }],
      omitted: [{ sourceId: 'candidate:1', revision: 2, contentHash: 'a'.repeat(64), category: 'finalized-history', required: false, reason: 'budget' }],
    } } : {}) }
  return {
    invocationId, mode: 'real', arm, phase: 'early-context', caseId: '场景2/3', chapterNumber: 2,
    protocolRevision: 's10b-reference-baseline-v2', protocolHash: 'e'.repeat(64),
    physicalModelRequests: 1, syntheticDispatches: 0,
    physicalProject: { parityHash: 'f'.repeat(64) },
    promptMapping: { baselineSha: 'e'.repeat(40), guidanceHash: 'f'.repeat(64), templates: [] },
    attempts: [{ attemptId: `${arm}:attempt`, userPromptHash: arm === 'candidate' ? 'c'.repeat(64) : null,
      binding: { invocationId, mode: 'real', arm, phase: 'early-context', caseId: '场景2/3', protocolRevision: 's10b-reference-baseline-v2', protocolHash: 'e'.repeat(64), operation: '长设定第三章正文' },
      compiledPromptHash: (arm === 'baseline' ? '1' : '2').repeat(64),
      composedPromptBytes: arm === 'baseline' ? 24000 : 20000, optionalMaterialEvidence }],
  }
}

function verifiedBaselineProjection(root, baseline, units, { fixture = false } = {}) {
  const isolationRoot = path.join(root, 'verified-baseline')
  const projectRoot = path.join(isolationRoot, 'project')
  const databaseDirectory = path.join(projectRoot, '.vela')
  fs.mkdirSync(databaseDirectory, { recursive: true })
  const databasePath = path.join(databaseDirectory, 'vela.db')
  const operation = '长设定第三章正文', projectId = 'project', runId = 'run'
  const binding = baseline.attempts[0].binding
  Object.assign(binding, { driverHash: 'd'.repeat(64), sourceHash: 's'.repeat(64),
    codeSha: 'a'.repeat(40), parityId: baseline.physicalProject.parityHash })
  const request = { invocationId: baseline.invocationId, mode: 'real', action: 'execute', phase: baseline.phase,
    caseId: baseline.caseId, chapterNumber: baseline.chapterNumber, driverHash: binding.driverHash,
    ledgerPath: path.join(isolationRoot, 'ledger.jsonl'), receiptPath: path.join(isolationRoot, 'execute-receipt.json'),
    operations: [{ id: operation, kind: 'draft' }], target: { arm: 'baseline', codeSha: binding.codeSha,
      isolationRoot, roots: { project: projectRoot } } }
  const receipt = { ...structuredClone(baseline), status: 'failed', operations: [],
    physicalProject: { ...baseline.physicalProject, projectId, dbPath: databasePath } }
  delete receipt.draftObservation
  delete receipt.gateFailure
  delete receipt.saved
  const text = '甲'.repeat(units), sourceSnapshot = JSON.stringify({ chapterNumber: baseline.chapterNumber, title: '章节' })
  const row = { candidate_id: 'candidate', run_id: runId, step_id: operation, project_id: projectId,
    chapter_number: baseline.chapterNumber, chapter_title: '章节', source_snapshot: sourceSnapshot,
    source_hash: hash(sourceSnapshot), visible_text: text, content_hash: hash(text), status: 'pending' }
  const database = new Database(databasePath)
  database.exec(`CREATE TABLE recovery_candidates (
    candidate_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, project_id TEXT NOT NULL,
    chapter_number INTEGER NOT NULL, chapter_title TEXT NOT NULL, source_snapshot TEXT NOT NULL,
    source_hash TEXT NOT NULL, visible_text TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL
  )`)
  database.prepare(`INSERT INTO recovery_candidates (
    candidate_id, run_id, step_id, project_id, chapter_number, chapter_title,
    source_snapshot, source_hash, visible_text, content_hash, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.candidate_id, row.run_id, row.step_id, row.project_id,
    row.chapter_number, row.chapter_title, row.source_snapshot, row.source_hash, row.visible_text, row.content_hash, row.status)
  database.close()
  const requestBytes = JSON.stringify(request), receiptBytes = JSON.stringify(receipt)
  const ledgerBytes = [{ type: 'reserve', attemptId: receipt.attempts[0].attemptId, binding },
    { type: 'dispatch', attemptId: receipt.attempts[0].attemptId },
    { type: 'settle', attemptId: receipt.attempts[0].attemptId, finishReason: 'stop' }]
    .map(item => JSON.stringify(item)).join('\n') + '\n'
  fs.writeFileSync(path.join(isolationRoot, 'execute-request.json'), requestBytes)
  fs.writeFileSync(request.receiptPath, receiptBytes)
  fs.writeFileSync(request.ledgerPath, ledgerBytes)
  const projected = projectRecoveryCandidateSupplement({ request, requestBytes, receipt, receiptBytes, ledgerBytes,
    recoveryRows: [row], targetUnits: 2000, isolationRoot,
    localDispatchGateRejection: { code: 'UNREGISTERED_ADDITIONAL_MODEL_REQUEST', operationId: operation,
      reason: 'duplicate-operation', beforeDispatch: true, operation, runId, projectId, chapterNumber: baseline.chapterNumber } })
  if (fixture) return { receipt, receiptPath: request.receiptPath, supplementPath: projected.supplementPath, databasePath }
  return readVerifiedRecoveryCandidateSupplement({ receiptPath: request.receiptPath })
}

function verifiedDirectBaselineProjection(root, baseline, units, { fixture = false } = {}) {
  const isolationRoot = path.join(root, 'verified-direct-baseline')
  const projectRoot = path.join(root, 'direct-projects'), projectPath = path.join(projectRoot, 'novel')
  const databasePath = path.join(projectPath, '.vela', 'vela.db')
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  fs.mkdirSync(isolationRoot, { recursive: true })
  const operation = '长设定第三章正文', projectId = 'project'
  const binding = baseline.attempts[0].binding
  Object.assign(binding, { campaignId: CAMPAIGN_ID, driverHash: 'd'.repeat(64), sourceHash: 's'.repeat(64),
    codeSha: 'a'.repeat(40), parityId: baseline.physicalProject.parityHash, milestone: 'early' })
  const receiptPath = path.join(isolationRoot, 'execute-receipt.json'), ledgerPath = path.join(root, 'direct-ledger.jsonl')
  const request = { invocationId: baseline.invocationId, mode: 'real', action: 'execute', phase: baseline.phase,
    milestone: binding.milestone, caseId: baseline.caseId, chapterNumber: baseline.chapterNumber,
    protocolRevision: baseline.protocolRevision, protocolHash: baseline.protocolHash,
    parityHash: binding.parityId, driverHash: binding.driverHash, ledgerPath, receiptPath,
    operations: [{ id: operation, kind: 'draft' }], target: { arm: 'baseline', codeSha: binding.codeSha,
      sourceHash: binding.sourceHash, protocolRevision: binding.protocolRevision, protocolHash: binding.protocolHash,
      isolationRoot, roots: { project: projectRoot }, driver: { sha256: binding.driverHash } } }
  const text = '甲'.repeat(units), contentHash = hash(text), outputPath = path.join(isolationRoot, 'draft.txt')
  const receipt = { ...structuredClone(baseline), action: 'execute', codeSha: binding.codeSha, status: 'failed',
    operations: [{ operation, kind: 'draft', outputHash: contentHash, outputPath }],
    draftObservation: { chapterNumber: baseline.chapterNumber, targetUnits: 2000, units, contentHash, persisted: true },
    gateFailure: { code: 'TARGET_UNITS_FAILED', actualUnits: units, targetUnits: 2000 },
    physicalProject: { ...baseline.physicalProject, path: projectPath, dbPath: databasePath, projectId } }
  delete receipt.saved
  const database = new Database(databasePath)
  database.exec(`CREATE TABLE contents (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE drafts (id INTEGER PRIMARY KEY, chapter_number INTEGER NOT NULL, version INTEGER NOT NULL,
      status TEXT, source TEXT, content_id INTEGER NOT NULL, word_count INTEGER);`)
  database.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(1, text)
  database.prepare(`INSERT INTO drafts (id, chapter_number, version, status, source, content_id, word_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(1, baseline.chapterNumber, 1, 'draft', 'write', 1, units)
  database.close()
  const ledger = [{ type: 'reserve', attemptId: receipt.attempts[0].attemptId, binding },
    { type: 'dispatch', attemptId: receipt.attempts[0].attemptId },
    { type: 'settle', attemptId: receipt.attempts[0].attemptId, finishReason: 'stop' }]
  fs.writeFileSync(outputPath, text)
  fs.writeFileSync(path.join(isolationRoot, 'execute-request.json'), JSON.stringify(request))
  fs.writeFileSync(receiptPath, JSON.stringify(receipt))
  fs.writeFileSync(path.join(isolationRoot, 'physical-project.json'),
    JSON.stringify({ kind: 'manifest', projectId, rootPath: projectPath }))
  fs.writeFileSync(ledgerPath, ledger.map(row => JSON.stringify(row)).join('\n') + '\n')
  if (fixture) return { receipt, receiptPath, requestPath: path.join(isolationRoot, 'execute-request.json'),
    manifestPath: path.join(isolationRoot, 'physical-project.json'), databasePath }
  return readVerifiedDirectPersistedDraftEvidence({ receiptPath })
}

test('baseline evidence reader selects one verifier and only downgrades expected validation failures', () => {
  const roots = []
  const makeBaseline = () => ({ ...s10bSelectionEvidence('baseline'), status: 'failed' })
  const root = label => {
    const value = fs.mkdtempSync(path.join(ROOT, `.runtime/.cache/novel-quality-modernization/${label}-`))
    roots.push(value)
    return value
  }
  try {
    const missingDirect = verifiedDirectBaselineProjection(root('direct-missing'), makeBaseline(), 2401, { fixture: true })
    fs.rmSync(missingDirect.manifestPath)
    assert.deepEqual(readBaselineFailureEvidence(missingDirect.receipt, missingDirect.receiptPath), {})

    const malformedDirect = verifiedDirectBaselineProjection(root('direct-json'), makeBaseline(), 2401, { fixture: true })
    fs.writeFileSync(malformedDirect.requestPath, '{')
    assert.throws(() => readBaselineFailureEvidence(malformedDirect.receipt, malformedDirect.receiptPath), SyntaxError)

    const sqliteDirect = verifiedDirectBaselineProjection(root('direct-sqlite'), makeBaseline(), 2401, { fixture: true })
    const directDatabase = new Database(sqliteDirect.databasePath)
    directDatabase.exec('DROP TABLE drafts')
    directDatabase.close()
    assert.throws(() => readBaselineFailureEvidence(sqliteDirect.receipt, sqliteDirect.receiptPath), /no such table: drafts/)

    const missingRecovery = verifiedBaselineProjection(root('recovery-missing'), makeBaseline(), 2401, { fixture: true })
    fs.rmSync(missingRecovery.supplementPath)
    assert.deepEqual(readBaselineFailureEvidence(missingRecovery.receipt, missingRecovery.receiptPath), {})

    const malformedRecovery = verifiedBaselineProjection(root('recovery-json'), makeBaseline(), 2401, { fixture: true })
    fs.writeFileSync(malformedRecovery.supplementPath, '{')
    assert.throws(() => readBaselineFailureEvidence(malformedRecovery.receipt, malformedRecovery.receiptPath), SyntaxError)

    const sqliteRecovery = verifiedBaselineProjection(root('recovery-sqlite'), makeBaseline(), 2401, { fixture: true })
    const recoveryDatabase = new Database(sqliteRecovery.databasePath)
    recoveryDatabase.exec('DROP TABLE recovery_candidates')
    recoveryDatabase.close()
    assert.throws(() => readBaselineFailureEvidence(sqliteRecovery.receipt, sqliteRecovery.receiptPath),
      /RECOVERY_DATABASE_READ_FAILED/)

    assert.deepEqual(readBaselineFailureEvidence({ status: 'failed', operations: [], attempts: [] }, 'unused'), {},
      'ordinary provider failures without a persisted-evidence shape keep their normal classification')
  } finally {
    for (const value of roots) fs.rmSync(value, { recursive: true, force: true })
  }
})

test('early-context 实际选择差异缺证据时逐项 fail closed', () => {
  const make = arm => ({ arm, ...structuredClone(s10bSelectionEvidence(arm)) })
  const valid = validateEarlyContextSelectionDifference(make('baseline'), make('candidate'))
  assert.equal(valid.valid, true)
  assert.deepEqual(valid.provenBaselineSourceIds, ['candidate:1'])
  const cases = [
    ['PROMPT_SELECTION_NOT_DIFFERENT', (baseline, candidate) => { candidate.attempts[0].compiledPromptHash = baseline.attempts[0].compiledPromptHash }],
    ['PROMPT_SELECTION_NOT_DIFFERENT', (baseline, candidate) => { candidate.attempts[0].composedPromptBytes = baseline.attempts[0].composedPromptBytes }],
    ['MATERIAL_DECISION_PROMPT_HASH_MISMATCH', (_baseline, candidate) => { candidate.attempts[0].optionalMaterialEvidence.materialDecision.promptHash = '9'.repeat(64) }],
    ['CANDIDATE_BUDGET_OMISSION_MISSING', (_baseline, candidate) => { candidate.attempts[0].optionalMaterialEvidence.materialDecision.omitted = [] }],
    ['CANDIDATE_BUDGET_IDENTITY_MISMATCH', (_baseline, candidate) => { candidate.attempts[0].optionalMaterialEvidence.materialDecision.omitted[0].revision = 9 }],
    ['CANDIDATE_BUDGET_IDENTITY_MISMATCH', (_baseline, candidate) => { candidate.attempts[0].optionalMaterialEvidence.materialDecision.omitted[0].contentHash = '9'.repeat(64) }],
    ['MATERIAL_DECISION_DUPLICATE_SOURCE', (_baseline, candidate) => { candidate.attempts[0].optionalMaterialEvidence.materialDecision.omitted.push(structuredClone(candidate.attempts[0].optionalMaterialEvidence.materialDecision.omitted[0])) }],
    ['CANDIDATE_REQUIRED_COVERAGE_INCOMPLETE', (_baseline, candidate) => { candidate.attempts[0].optionalMaterialEvidence.materialDecision.coverage.complete = false }],
    ['CANDIDATE_OMITTED_SOURCE_SENT', (_baseline, candidate) => {
      candidate.attempts[0].optionalMaterialEvidence.sent = [structuredClone(candidate.attempts[0].optionalMaterialEvidence.registered[0])]
      candidate.attempts[0].optionalMaterialEvidence.sentSourceIds = ['candidate:1']
    }],
    ['SENT_SOURCE_EVIDENCE_INVALID', (_baseline, candidate) => {
      candidate.attempts[0].optionalMaterialEvidence.sent = [structuredClone(candidate.attempts[0].optionalMaterialEvidence.registered[0])]
      candidate.attempts[0].optionalMaterialEvidence.sent[0].markerHash = '9'.repeat(64)
      candidate.attempts[0].optionalMaterialEvidence.sentSourceIds = ['candidate:1']
    }],
    ['SENT_SOURCE_EVIDENCE_INVALID', baseline => {
      baseline.attempts[0].optionalMaterialEvidence.sent[0].markerHash = '9'.repeat(64)
    }],
    ['ACTUAL_PROJECT_PARITY_FAILED', (_baseline, candidate) => { candidate.physicalProject.parityHash = '9'.repeat(64) }],
    ['MATERIAL_DECISION_EVIDENCE_MISSING', (_baseline, candidate) => { candidate.attempts[0].optionalMaterialEvidence.materialDecision.capacity = null }],
  ]
  for (const [failure, mutate] of cases) {
    const baseline = make('baseline'), candidate = make('candidate')
    mutate(baseline, candidate)
    assert.deepEqual(validateEarlyContextSelectionDifference(baseline, candidate), { valid: false, pairFailure: failure })
  }
})

test('paired classifier rejects synthetic-as-real and duplicate target attempts', () => {
  const baseline = { ...s10bSelectionEvidence('baseline'), status: 'passed' }
  const candidate = { ...s10bSelectionEvidence('candidate'), status: 'passed' }
  candidate.mode = 'synthetic'
  candidate.attempts[0].binding.mode = 'synthetic'
  candidate.physicalModelRequests = 0
  candidate.syntheticDispatches = 1
  const syntheticAsReal = classifyProductionPair([baseline, candidate], { mode: 'real', phase: 'early-context' })
  assert.equal(syntheticAsReal.pairFailure, 'PAIR_BINDING_MISMATCH')

  const duplicate = { ...s10bSelectionEvidence('candidate'), status: 'passed' }
  duplicate.attempts.push(structuredClone(duplicate.attempts[0]))
  const duplicateAttempt = classifyProductionPair([baseline, duplicate], { mode: 'real', phase: 'early-context' })
  assert.equal(duplicateAttempt.pairFailure, 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH')

  const otherInvocation = { ...s10bSelectionEvidence('candidate'), invocationId: '44444444-4444-4444-8444-444444444444' }
  otherInvocation.attempts[0].binding.invocationId = otherInvocation.invocationId
  assert.equal(classifyProductionPair([baseline, otherInvocation], { mode: 'real', phase: 'early-context' }).pairFailure,
    'PAIR_BINDING_MISMATCH')
})

test('真实桥只公开本地字数门失败，并在失败收据保留持久化观察而非 saved', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/receipt-test-'))
  const file = path.join(dir, 'receipt.json')
  const receipt = { status: 'running' }
  try {
    try {
      recordPersistedDraftObservation(receipt, { chapterNumber: 2, targetUnits: 2000,
        units: 2769, contentHash: 'a'.repeat(64) })
      receipt.saved = { shouldNotExist: true }
    } catch (error) {
      receipt.status = 'failed'
      receipt.gateFailure = targetUnitsGateEvidence(error)
      receipt.error = safeReceiptDiagnostic(error, 'real')
    }
    fs.writeFileSync(file, JSON.stringify(receipt))
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(stored.draftObservation, { chapterNumber: 2, targetUnits: 2000,
      units: 2769, contentHash: 'a'.repeat(64), persisted: true })
    assert.equal('saved' in stored, false)
    assert.equal(stored.error, 'TARGET_UNITS_FAILED:2769/2000')
    assert.deepEqual(stored.gateFailure, { code: 'TARGET_UNITS_FAILED', actualUnits: 2769, targetUnits: 2000 })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }

  for (const unsafe of [new Error('TARGET_UNITS_FAILED:2769/2000'),
    'TARGET_UNITS_FAILED:2769/2000', 'sk-secret', 'C:\\private\\key']) {
    assert.equal(safeReceiptDiagnostic(unsafe, 'real'), 'REAL_PROVIDER_DIAGNOSTIC_REDACTED')
  }
  assert.equal(safeReceiptDiagnostic(new Error('PROVIDER_HTTP_FAILED'), 'real'), 'PROVIDER_HTTP_FAILED')
  assert.equal(safeReceiptDiagnostic(new Error('GENERATION_REVIEW_REVISION_NOOP'), 'real'), 'GENERATION_REVIEW_REVISION_NOOP')
  assert.equal(safeReceiptDiagnostic(new Error('SK_SECRET'), 'real'), 'REAL_PROVIDER_DIAGNOSTIC_REDACTED')
  assert.equal(safeReceiptDiagnostic(new Error('synthetic detail'), 'synthetic'), 'synthetic detail')

  for (const units of [1600, 2400]) {
    const boundaryReceipt = {}
    assert.doesNotThrow(() => recordPersistedDraftObservation(boundaryReceipt, {
      chapterNumber: 2, targetUnits: 2000, units, contentHash: 'b'.repeat(64) }))
    assert.equal(boundaryReceipt.draftObservation.units, units)
  }
  for (const units of [1599, 2401, Number.NaN]) {
    const outOfRangeReceipt = {}
    assert.throws(() => recordPersistedDraftObservation(outOfRangeReceipt, {
      chapterNumber: 2, targetUnits: 2000, units, contentHash: 'c'.repeat(64) }))
    assert.equal(outOfRangeReceipt.draftObservation.persisted, true)
  }

  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  const observation = fixture.indexOf('recordPersistedDraftObservation(receipt,')
  const saved = fixture.indexOf('receipt.saved =')
  assert.ok(observation >= 0 && observation < saved, 'fixture 必须在 saved 前执行共享字数门')
  assert.ok(fixture.includes("receipt.error = safeDiagnostic(error)"), '顶层 catch 必须保留错误身份，不能先降为字符串')
})

test('S10B只把有可评审产物的baseline字数不合格降为reference-nonconforming', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/pair-decision-test-'))
  const make = (arm, units, status = 'passed') => {
    const content = (arm === 'baseline' ? '甲' : '乙').repeat(units)
    const outputPath = path.join(dir, `${arm}-${units}.txt`)
    fs.writeFileSync(outputPath, content)
    const contentHash = hash(content)
    return { arm, status, ...structuredClone(s10bSelectionEvidence(arm)), draftObservation: { chapterNumber: 2, targetUnits: 2000, units, contentHash, persisted: true },
      operations: [{ kind: 'draft', outputPath }], ...(status === 'passed' ? { saved: { chapterNumber: 2, contentHash, units, targetUnits: 2000 } } : {}) }
  }
  try {
    const candidate = make('candidate', 2000)
    const failedBaseline = make('baseline', 2769, 'failed')
    const overBaseline = { ...failedBaseline, ...verifiedDirectBaselineProjection(dir, failedBaseline, 2769) }
    const pending = classifyProductionPair([overBaseline, candidate], { mode: 'real', phase: 'early-context' })
    assert.equal(pending.status, 'pending-independent-oracle-review')
    assert.equal(pending.baselineDisposition, 'reference-nonconforming')
    assert.deepEqual(pending.pendingOracleDimensions, ['required-events', 'facts', 'recap', 'style'])

    const withoutVerifiedDirectEvidence = { ...overBaseline }
    delete withoutVerifiedDirectEvidence.directPersistedEvidence
    assert.equal(classifyProductionPair([withoutVerifiedDirectEvidence, candidate], { mode: 'real', phase: 'early-context' }).baselineDisposition,
      'invalid-reference')
    const forgedDirectEvidence = { ...overBaseline,
      directPersistedEvidence: structuredClone(overBaseline.directPersistedEvidence) }
    assert.equal(classifyProductionPair([forgedDirectEvidence, candidate], { mode: 'real', phase: 'early-context' }).baselineDisposition,
      'invalid-reference')

    const recoveryBaseline = make('baseline', 2769, 'failed')
    const recovered = { ...recoveryBaseline, ...verifiedBaselineProjection(dir, recoveryBaseline, 2769) }
    assert.equal(classifyProductionPair([recovered, candidate], { mode: 'real', phase: 'early-context' }).baselineDisposition,
      'reference-nonconforming')

    const conformingBaseline = make('baseline', 2000)
    const overCandidate = { ...make('candidate', 2401, 'failed'),
      gateFailure: { code: 'TARGET_UNITS_FAILED', actualUnits: 2401, targetUnits: 2000 },
      directPersistedEvidence: overBaseline.directPersistedEvidence }
    assert.equal(classifyProductionPair([conformingBaseline, overCandidate], { mode: 'real', phase: 'early-context' }).status, 'failed')

    const providerFailure = { arm: 'baseline', status: 'failed', error: 'REAL_PROVIDER_DIAGNOSTIC_REDACTED' }
    const invalidReference = classifyProductionPair([providerFailure, candidate], { mode: 'real', phase: 'early-context' })
    assert.equal(invalidReference.status, 'failed')
    assert.equal(invalidReference.baselineDisposition, 'invalid-reference')

    for (const baselineFailure of [
      { arm: 'baseline', status: 'failed', ipcFailures: [{ channel: 'db:draft-create' }] },
      { arm: 'baseline', status: 'failed', gateFailure: { code: 'TARGET_UNITS_FAILED', actualUnits: 2769, targetUnits: 2000 } },
    ]) assert.equal(classifyProductionPair([baselineFailure, candidate], { mode: 'real', phase: 'early-context' }).status, 'failed')

    for (const malformed of [[candidate], [candidate, candidate], [conformingBaseline, conformingBaseline]]) {
      const result = classifyProductionPair(malformed, { mode: 'real', phase: 'early-context' })
      assert.equal(result.status, 'failed')
      assert.equal(result.pairFailure, 'INVALID_PAIR_RESULTS')
    }

    for (const observation of [
      { ...conformingBaseline.draftObservation, units: 0 },
      { ...conformingBaseline.draftObservation, units: -1 },
      { ...conformingBaseline.draftObservation, units: Number.NaN },
      { ...conformingBaseline.draftObservation, targetUnits: 0 },
      { ...conformingBaseline.draftObservation, contentHash: '0'.repeat(64) },
    ]) {
      const invalid = { ...conformingBaseline, draftObservation: observation }
      assert.equal(classifyProductionPair([invalid, candidate], { mode: 'real', phase: 'early-context' }).baselineDisposition, 'invalid-reference')
    }
    const inconsistentSaved = { ...conformingBaseline, saved: { ...conformingBaseline.saved, units: 1999 } }
    assert.equal(classifyProductionPair([inconsistentSaved, candidate], { mode: 'real', phase: 'early-context' }).baselineDisposition, 'invalid-reference')
    const inconsistentFailure = { ...overBaseline,
      gateFailure: { code: 'TARGET_UNITS_FAILED', actualUnits: 2770, targetUnits: 2000 } }
    assert.equal(classifyProductionPair([inconsistentFailure, candidate], { mode: 'real', phase: 'early-context' }).baselineDisposition, 'invalid-reference')
    const passedOverrange = make('baseline', 2769)
    assert.equal(classifyProductionPair([passedOverrange, candidate], { mode: 'real', phase: 'early-context' }).baselineDisposition, 'invalid-reference')

    const noArtifactBaseline = { ...conformingBaseline, operations: [] }
    assert.equal(classifyProductionPair([noArtifactBaseline, candidate], { mode: 'real', phase: 'early-budget' }).status, 'failed')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('调用方对账为悬空派发补写 unknown，且重复对账不写第二行', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/reconcile-test-'))
  const file = path.join(dir, 'physical-ledger.jsonl')
  // 活动账本会按选定阶段校验绑定，所以这里用 early-context 的登记值。
  const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', ...protocolBinding, arm: 'baseline', codeSha: 'a'.repeat(40),
    sourceHash: 'c'.repeat(64), driverHash: 'd'.repeat(64), parityId: 'b'.repeat(64),
    phase: 'early-context', milestone: 'early', caseId: '场景2/3', operation: '长设定第三章正文' }
  try {
    // 模拟子进程被超时杀死：reserve 与 dispatch 落盘，之后没有任何终态行。
    updateLedger(file, { type: 'reserve', attemptId: '被杀', binding }, { campaignMode: 'synthetic' })
    updateLedger(file, { type: 'dispatch', attemptId: '被杀' }, { campaignMode: 'synthetic' })
    const first = reconcileDispatchedAttempts(file, 'synthetic')
    assert.deepEqual(first, { reconciled: 1, dangling: 1 })
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.deepEqual(rows.map(row => row.type), ['reserve', 'dispatch', 'unknown'])
    // 幂等：没有悬空派发时不再写，已有的 unknown 不被改写。
    assert.deepEqual(reconcileDispatchedAttempts(file, 'synthetic'), { reconciled: 0, dangling: 0 })
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 3)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('调用方在桥返回失败对象时也结算悬空派发', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/reconcile-return-test-'))
  const file = path.join(dir, 'synthetic-ledger.jsonl')
  const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', ...protocolBinding, arm: 'baseline', codeSha: 'a'.repeat(40),
    sourceHash: 'c'.repeat(64), driverHash: 'd'.repeat(64), parityId: 'b'.repeat(64),
    phase: 'early-context', milestone: 'early', caseId: '场景2/3', operation: '长设定第三章正文' }
  try {
    const result = withLedgerReconciliation(file, 'synthetic', () => {
      updateLedger(file, { type: 'reserve', attemptId: '返回失败', binding }, { campaignMode: 'synthetic' })
      updateLedger(file, { type: 'dispatch', attemptId: '返回失败' }, { campaignMode: 'synthetic' })
      return { status: 'failed' }
    })
    assert.deepEqual(result, { status: 'failed' })
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.deepEqual(rows.map(row => row.type), ['reserve', 'dispatch', 'unknown'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('development manifest拒绝formal，协议别名不接受不存在的旧路径', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/manifest-test-'))
  const target = path.join(dir, 'targets.json')
  try {
    fs.writeFileSync(target, JSON.stringify({ baseline: { schemaVersion: 2, developmentOnly: true }, candidate: { schemaVersion: 2, developmentOnly: true } }))
    assert.throws(() => main(['dry-run', '--targets', target]), /DEVELOPMENT_TARGET_NOT_QUALIFIED/)
    assert.throws(() => main(['--phase', 'early-budget', '--protocol', 'test/fixtures/novel-quality-modernization/protocol.json', '--dry-run', '--targets', target]), /PROTOCOL_PATH_MISMATCH/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('formal冻结拒绝未跟踪生产源码或实际bridge，保留未跟踪截图', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/untracked-test-'))
  try {
    assert.equal(spawnSync('git', ['init', dir], { windowsHide: true }).status, 0)
    fs.mkdirSync(path.join(dir, 'src/__tests__/__screenshots__'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src/__tests__/__screenshots__/owned.png'), 'synthetic')
    assert.doesNotThrow(() => assertCommittedProductionFiles(dir))
    fs.writeFileSync(path.join(dir, 'src/planner.ts'), 'export const limit = 1')
    assert.throws(() => assertCommittedProductionFiles(dir), /UNCOMMITTED_PRODUCTION_FILES/)
    fs.unlinkSync(path.join(dir, 'src/planner.ts'))
    fs.mkdirSync(path.join(dir, 'scripts/fixtures'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'scripts/fixtures/production.fixture.mjs'), 'export const adapter = 1')
    assert.throws(() => assertCommittedProductionFiles(dir), /UNCOMMITTED_PRODUCTION_FILES/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('formal freeze只接受已提交且tracked clean的协议revision', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/formal-clean-test-'))
  const protocolPath = path.join(dir, 'docs/research/novel-quality-modernization/protocol.json')
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true })
  try {
    fs.mkdirSync(path.dirname(protocolPath), { recursive: true })
    fs.writeFileSync(protocolPath, '{"decisionRevision":"v1"}\n')
    assert.equal(git('init').status, 0)
    assert.equal(git('config', 'user.email', 'quality-test@example.invalid').status, 0)
    assert.equal(git('config', 'user.name', 'Quality Test').status, 0)
    assert.equal(git('add', 'docs/research/novel-quality-modernization/protocol.json').status, 0)
    assert.equal(git('commit', '-m', 'freeze protocol').status, 0)
    assert.doesNotThrow(() => assertFormalTargetCandidateClean(dir))
    fs.writeFileSync(protocolPath, '{"decisionRevision":"v2-uncommitted"}\n')
    assert.throws(() => assertFormalTargetCandidateClean(dir), /TARGET_TRACKED_DIRTY/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
