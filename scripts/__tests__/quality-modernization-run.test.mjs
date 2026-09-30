import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import childProcess, { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ROOT, PLANNED_CALL_ALLOCATION, CAMPAIGN_ID, campaignIdFor, hash, currentProtocolBinding, assertProtocolBinding, validateHistoricalLedgerBoundary, validateHistoricalSupersessionBoundary, validateCampaignBinding, buildFixtureExports, validatePair, selectPhase, forwardReasoningFor, assertScenarioMatchesProtocol, reconcileDispatchedAttempts, withLedgerReconciliation, updateLedger, main, inspectTarget, freezeEnvironment, fixedStartup, validateFrozenExecution, runnerAdapterHash, assertCommittedProductionFiles, assertFormalTargetCandidateClean, createShortIsolationRoot, assertOwnedIsolationRoot, validatePhysicalLedger, registeredCampaignWorktree, developmentLedgerPath } from '../quality-modernization-run.mjs'
import { COMMAND_PROBES, selectOwnerDispatch, productionBridgeHash, copyIsolatedRealModelConfig, PHASE_SCENARIOS, classifyProductionPair,
  fullExecutionSchedule, classifyFullProduction,
  adjudicateEarlyReviewReferenceNonconformance, EARLY_REVIEW_REFERENCE_ADJUDICATION_REVISION,
  readBaselineFailureEvidence, validateEarlyContextSelectionDifference,
  validateEarlyReviewChain, targetUnitsGateEvidence,
  createAttemptSupervisor, createOperationDispatchGate, createOutboundPreflightAssert,
  rejectOutsidePhysicalBoundary, assertNoOutboundPreflightFailures, fetchProviderResponse, measurePromptBytes,
  BRIDGE_SETTLEMENT_DEADLINE_MS, BRIDGE_SPAWN_TIMEOUT_MS, BRIDGE_TEST_TIMEOUT_MS,
  C16_C18_ATTEMPT_POLICY, validateCandidateContinuityResults, runProductionPhasePair, summarizeDraftReconciliation,
  continuityCaseOperations, FINALIZED_CHARACTER_OPERATION_IDS, draftCondenseFor, syntheticDraftCondensePlan } from '../quality-modernization-driver.mjs'
import { projectRecoveryCandidateSupplement, readVerifiedRecoveryCandidateSupplement,
  readVerifiedDirectPersistedDraftEvidence, recordPersistedDraftObservation,
  safeReceiptDiagnostic } from '../quality-modernization-receipt.mjs'
import Database from 'better-sqlite3'
import { POST_UI_REVIEW_POLICY, reviewedDraftSelection, validateReviewedDraft, productionScenario, scenarioAuthorSetting } from '../quality-modernization-driver.mjs'
import { countDraftUnits, draftTargetUnitRange } from '../../src/shared/draft-units'
import { freezeChapterGoals } from '../../src/shared/chapter-goal-review'
import { draftReconciliationBlock, parseDraftReconciliation } from '../../src/shared/draft-reconciliation'
import { parseReviewGenerationResult } from '../../src/shared/review-generation-report'

const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/novel-quality-modernization/semantic-source.json')))
const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')))
const semanticPath = path.join(ROOT, protocol.fixturePath)
const protocolBinding = currentProtocolBinding()

test('shared-input diagnostic registers one candidate and rejects a second physical slot', async () => {
  const phase = 'shared-input-diagnostic'
  const registration = protocol.phases[phase]
  const selected = selectPhase({ ...protocol, phases: { ...protocol.phases, [phase]: registration } }, phase, 'diagnostic')
  assert.deepEqual(selected.caseIds, ['C17-C18-shared'])
  const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', codeSha: 'a'.repeat(40),
    sourceHash: 'a'.repeat(64), driverHash: 'b'.repeat(64), parityId: 'c'.repeat(64), milestone: 'diagnostic', phase,
    caseId: selected.caseIds[0], operation: selected.operations[0].id,
    messagesSha256: registration.messagesSha256, originalMessagesSha256: registration.originalMessagesSha256, ...protocolBinding,
    actual: { attemptId: 'fresh', runId: 'fresh-run', rootActionId: 'fresh-root', projectId: 'fresh-project', epoch: 'fresh-epoch' } }
  assert.doesNotThrow(() => validateCampaignBinding(binding, { campaignMode: 'synthetic', protocol: { ...protocol, phases: { ...protocol.phases, [phase]: registration } } }))
  const directory = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/shared-input-ledger-test-'))
  const ledger = path.join(directory, 'synthetic-ledger.jsonl')
  try {
    updateLedger(ledger, { type: 'reserve', attemptId: 'candidate:first', binding }, { campaignMode: 'synthetic' })
    updateLedger(ledger, { type: 'dispatch', attemptId: 'candidate:first' }, { campaignMode: 'synthetic' })
    updateLedger(ledger, { type: 'settle', attemptId: 'candidate:first' }, { campaignMode: 'synthetic' })
    assert.throws(() => updateLedger(ledger, { type: 'reserve', attemptId: 'candidate:second',
      binding: { ...binding, actual: { ...binding.actual, attemptId: 'second' } } }, { campaignMode: 'synthetic' }),
    /SHARED_INPUT_DIAGNOSTIC_ALREADY_DISPATCHED/)
    assert.deepEqual(fs.readFileSync(ledger, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line).type), ['reserve', 'dispatch', 'settle'])
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  const { assertSharedInputDiagnostic } = await import('../quality-modernization-driver.mjs')
  const originalMessages = [{ role: 'system', content: 'original system' }, { role: 'user', content: 'original user' }]
  const prefix = '【原始系统消息原文开始】\noriginal system\n【原始系统消息原文结束】\n【原始用户消息原文开始】\n'
  const suffix = '\n【原始用户消息原文结束】\n【当前唯一输出任务】\n五列表格'
  const messages = [{ role: 'system', content: '仅提取事实' }, { role: 'user', content: prefix + originalMessages[1].content + suffix }]
  const input = { diagnosticId: 'shared-input-fact-extraction-9337909d-v1', originalMessages,
    originalMessagesSha256: hash(originalMessages), messages, messagesSha256: hash(messages),
    originalUserWrapper: { prefix, suffix }, materials: registration.materials,
    originalInvocationId: registration.originalInvocationId, originalTestedSha: registration.originalTestedSha,
    originalCaseIds: registration.originalCaseIds }
  const registered = { ...registration, originalMessagesSha256: input.originalMessagesSha256, messagesSha256: input.messagesSha256 }
  assert.equal(messages[1].content.split(originalMessages[0].content).length, 2)
  assert.equal(messages[1].content.split(originalMessages[1].content).length, 2)
  assert.notEqual(input.messagesSha256, input.originalMessagesSha256)
  const expected = { ...registration.model }
  const body = { model: expected.modelName, messages: input.messages, temperature: 0.7, max_tokens: 2672,
    enable_thinking: true, reasoning_effort: 'max', stream: true, stream_options: { include_usage: true } }
  assert.doesNotThrow(() => assertSharedInputDiagnostic(registered, input, { arm: 'candidate', model: expected, body, reserved: 0 }))
  for (const change of [
    { arm: 'baseline' }, { model: { ...expected, temperature: 0 } },
    { body: { ...body, max_tokens: 2673 } }, { body: { ...body, messages: [{ ...input.messages[0], content: 'changed' }, input.messages[1]] } },
    { reserved: 1 },
  ]) assert.throws(() => assertSharedInputDiagnostic(registered, input, { arm: 'candidate', model: expected, body, reserved: 0, ...change }), /SHARED_INPUT_DIAGNOSTIC_/)
  assert.throws(() => assertSharedInputDiagnostic(registered, { ...input, originalUserWrapper: { prefix: '', suffix: '' } },
    { arm: 'candidate', model: expected, body, reserved: 0 }), /SHARED_INPUT_DIAGNOSTIC_INPUT_MISMATCH/)
})

test('固定 max 登记只覆盖 C16、post-UI 三 selector 和 final full，原六参数与素材不动', () => {
  const registered = protocol.forwardReasoningExperiment
  assert.equal(registered.revision, 'fixed-max-natural-wire-asymmetry-v1')
  assert.equal(registered.wireParity, false)
  assert.deepEqual(registered.model, { provider: source.modelParameters.provider, protocol: source.modelParameters.protocol,
    baseUrl: `https://${source.modelParameters.endpointHost}/v1`, modelName: source.modelParameters.modelName,
    temperature: source.modelParameters.temperature, maxTokens: source.modelParameters.maxTokens })
  for (const scope of registered.scopes) {
    const effective = forwardReasoningFor(protocol, scope.phase, scope.milestone)
    assert.equal(effective.revision, 'fixed-zero-temperature-max-v1')
    assert.deepEqual(effective.model, { ...registered.model, temperature: 0 })
    assert.deepEqual(effective.scopes, registered.scopes)
  }
  assert.equal(forwardReasoningFor(protocol, 'early-budget', 'early'), null)
  assert.throws(() => forwardReasoningFor({ ...protocol, forwardReasoningExperiment: { ...registered,
    scopes: [{ ...registered.scopes[0], caseIds: ['C16-A'] }] } }, 'c16-c18', 'final'), /FORWARD_TEMPERATURE_REGISTRATION_MISMATCH/)
})

test('7203443d 历史诊断三行认证后仍占用唯一物理额度', () => {
  const registered = protocol.historicalSharedInput7203443dBoundary
  assert.equal(registered.fromEventCount, 1158)
  assert.equal(registered.eventCount, 1161)
  const item = registered.reserveAttempts[0], arm = registered.armBindings.candidate
  const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', ...arm,
    phase: 'shared-input-diagnostic', milestone: 'diagnostic', caseId: 'C17-C18-shared',
    operation: protocol.phases['shared-input-diagnostic'].operations[0].id,
    protocolRevision: registered.protocolRevision, protocolHash: registered.protocolHash,
    invocationId: item.invocationId }
  const rows = [{ type: 'reserve', attemptId: item.attemptId, binding, allocation: 'nonQualificationDiagnostic' },
    { type: 'dispatch', attemptId: item.attemptId }, { type: 'settle', attemptId: item.attemptId }]
  const raw = rows.map(JSON.stringify).join('\n') + '\n'
  const boundary = { ...registered, fromEventCount: 0, eventCount: 3, rawBytesSha256: hash(raw) }
  assert.equal(validateHistoricalSupersessionBoundary(raw, 0, boundary), 3)
  const directory = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/temperature-zero-ledger-test-'))
  const ledger = path.join(directory, 'synthetic-ledger.jsonl')
  try {
    fs.writeFileSync(ledger, raw)
    const current = { ...binding, ...protocolBinding, invocationId: 'new-invocation',
      messagesSha256: protocol.phases['shared-input-diagnostic'].messagesSha256,
      originalMessagesSha256: protocol.phases['shared-input-diagnostic'].originalMessagesSha256,
      actual: { attemptId: 'new', runId: 'new', rootActionId: 'new', projectId: 'new', epoch: 'new' } }
    assert.throws(() => updateLedger(ledger, { type: 'reserve', attemptId: 'candidate:new', binding: current },
      { campaignMode: 'synthetic', historicalSharedInput7203443dBoundary: boundary }),
    /SHARED_INPUT_DIAGNOSTIC_ALREADY_DISPATCHED/)
    assert.equal(fs.readFileSync(ledger, 'utf8'), raw)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('70407421 七次物理请求认证六次结算与末次 UNKNOWN，未知请求仍占用原 slot', () => {
  const registered = protocol.historicalC1670407421Boundary
  assert.equal(registered.fromEventCount, 1161)
  assert.equal(registered.eventCount, 1182)
  assert.deepEqual(registered.reserveAttempts.map(item => item.terminal),
    ['settle', 'settle', 'settle', 'settle', 'settle', 'settle', 'unknown'])
  const rows = registered.reserveAttempts.flatMap(item => [
    { type: 'reserve', attemptId: item.attemptId, allocation: 'c16C18Candidate', binding: {
      campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate',
      ...registered.armBindings.candidate, parityId: item.parityId,
      phase: 'c16-c18', milestone: 'final', caseId: 'C17-A', operation: protocol.phases['c16-c18'].operations[2].id,
      protocolRevision: registered.protocolRevision, protocolHash: registered.protocolHash,
      invocationId: item.invocationId } },
    { type: 'dispatch', attemptId: item.attemptId }, { type: item.terminal, attemptId: item.attemptId },
  ])
  const raw = rows.map(JSON.stringify).join('\n') + '\n'
  const boundary = { ...registered, fromEventCount: 0, eventCount: 21, rawBytesSha256: hash(raw) }
  assert.equal(validateHistoricalSupersessionBoundary(raw, 0, boundary), 21)
  assert.throws(() => validateHistoricalSupersessionBoundary(raw, 0, { ...boundary,
    reserveAttempts: registered.reserveAttempts.map((item, index) => index === 6 ? { ...item, terminal: 'settle' } : item) }),
  /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
  const directory = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/stream-history-ledger-test-'))
  const ledger = path.join(directory, 'synthetic-ledger.jsonl')
  try {
    fs.writeFileSync(ledger, raw)
    const previous = rows.at(-3).binding
    const current = { ...previous, ...protocolBinding, invocationId: 'new-invocation',
      actual: { attemptId: 'new', runId: 'new', rootActionId: 'new', projectId: 'new', epoch: 'new' } }
    updateLedger(ledger, { type: 'reserve', attemptId: 'candidate:new', binding: current },
      { campaignMode: 'synthetic', historicalC1670407421Boundary: boundary })
    assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').at(-1)).allocation,
      'failedRetryRepairReviewReserve')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('固定零温度只接受继承原 max 范围的唯一登记，旧诊断仍用 0.7', async () => {
  const zero = protocol.forwardTemperatureExperiment
  assert.deepEqual(Object.keys(zero).sort(), ['baseRevision', 'limits', 'revision', 'temperature'])
  assert.equal(zero.baseRevision, protocol.forwardReasoningExperiment.revision)
  assert.equal(zero.temperature, 0)
  assert.equal(forwardReasoningFor(protocol, 'shared-input-diagnostic', 'diagnostic'), null)
  assert.equal(forwardReasoningFor(protocol, 'early-budget', 'early'), null)
  for (const base of [undefined, { ...protocol.forwardReasoningExperiment,
    scopes: protocol.forwardReasoningExperiment.scopes.filter(scope => scope.phase !== 'c16-c18') }])
    assert.throws(() => forwardReasoningFor({ ...protocol, forwardReasoningExperiment: base }, 'c16-c18', 'final'),
      /FORWARD_TEMPERATURE_REGISTRATION_MISMATCH/)
  const { assertForwardReasoning } = await import('../quality-modernization-driver.mjs')
  const effective = forwardReasoningFor(protocol, 'c16-c18', 'final')
  const actual = { arm: 'candidate', phase: 'c16-c18', milestone: 'final', caseId: 'C16-A',
    creativeStrategy: 'auto', model: { ...effective.model, reasoningOverride: 'max' } }
  assert.throws(() => assertForwardReasoning(effective, { ...actual,
    model: { ...actual.model, temperature: 0.7 } }), /FORWARD_REASONING_CONFIG_MISMATCH/)
  const unregistered = forwardReasoningFor({ ...protocol, forwardTemperatureExperiment: undefined }, 'c16-c18', 'final')
  assert.equal(unregistered.model.temperature, 0.7)
  assert.throws(() => assertForwardReasoning(unregistered, { ...actual }), /FORWARD_REASONING_CONFIG_MISMATCH/)
  const change = value => ({ ...protocol, forwardTemperatureExperiment: { ...zero, ...value } })
  for (const value of [{ baseRevision: 'wrong' }, { temperature: 0.7 }, { extra: true }])
    assert.throws(() => forwardReasoningFor(change(value), 'c16-c18', 'final'), /FORWARD_TEMPERATURE_REGISTRATION_MISMATCH/)
  for (const model of [{ ...protocol.forwardReasoningExperiment.model, modelName: 'changed' },
    { ...protocol.forwardReasoningExperiment.model, temperature: 0 }])
    assert.throws(() => forwardReasoningFor({ ...protocol, forwardReasoningExperiment: {
      ...protocol.forwardReasoningExperiment, model } }, 'c16-c18', 'final'), /FORWARD_TEMPERATURE_REGISTRATION_MISMATCH/)
  assert.throws(() => forwardReasoningFor({ ...protocol, phases: { ...protocol.phases,
    'c16-c18': { ...protocol.phases['c16-c18'], caseIds: ['C16-A'] } } }, 'c16-c18', 'final'),
  /FORWARD_REASONING_SCOPE_MISMATCH/)
})

test('固定 max 前瞻：配置读回与每次出站严格区分 candidate wire 和 baseline 真缺席', async () => {
  const { assertForwardReasoning } = await import('../quality-modernization-driver.mjs')
  const registration = { revision: 'fixed-max-v1', scopes: [{ phase: 'c16-c18', milestone: 'final' }],
    model: { provider: 'openai', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1',
      modelName: 'deepseek-ai/DeepSeek-V4-Flash', temperature: 0.7, maxTokens: 16384 },
    reasoningOverride: 'max', creativeStrategy: 'auto', wireParity: false,
    wire: { candidate: { enable_thinking: true, reasoning_effort: 'max' },
      baseline: { enable_thinking: 'absent', reasoning_effort: 'absent' } } }
  const model = { ...registration.model, reasoningOverride: 'max' }
  const common = { arm: 'candidate', phase: 'c16-c18', milestone: 'final', model, creativeStrategy: 'auto',
    resolution: { requested: 'max', effective: 'max', status: 'mapped', source: 'model-override' } }
  const candidate = assertForwardReasoning(registration, { ...common,
    body: { enable_thinking: true, reasoning_effort: 'max', max_tokens: 4096 } })
  assert.deepEqual(candidate, { requested: 'max', effective: 'max', status: 'mapped', source: 'model-override',
    wire: { enable_thinking: { present: true, value: true }, reasoning_effort: { present: true, value: 'max' },
      thinking_budget: { present: false } } })
  const baseline = assertForwardReasoning(registration, { ...common, arm: 'baseline', resolution: null, body: { max_tokens: 4096 } })
  assert.deepEqual(baseline, { requested: 'max', effective: null, status: 'not-exposed-by-baseline', source: 'profile-readback',
    wire: { enable_thinking: { present: false }, reasoning_effort: { present: false }, thinking_budget: { present: false } } })
  for (const change of [
    { model: { ...model, reasoningOverride: 'auto' } },
    { model: { ...model, baseUrl: 'https://api.siliconflow.com/v1' } },
    { model: { ...model, modelName: 'deepseek-ai/DeepSeek-V4-Pro' } },
    { creativeStrategy: 'deep-planning' },
    { phase: 'early-context' },
  ]) assert.throws(() => assertForwardReasoning(registration, { ...common, ...change }), /FORWARD_REASONING_CONFIG_MISMATCH/)
  for (const body of [{ max_tokens: 4096 }, { enable_thinking: true, max_tokens: 4096 },
    { enable_thinking: false, reasoning_effort: 'max', max_tokens: 4096 },
    { enable_thinking: true, reasoning_effort: 'high', max_tokens: 4096 },
    { enable_thinking: true, reasoning_effort: 'max', thinking_budget: 8192, max_tokens: 4096 }])
    assert.throws(() => assertForwardReasoning(registration, { ...common, body }), /FORWARD_REASONING_WIRE_MISMATCH/)
  for (const body of [{ enable_thinking: null, max_tokens: 4096 }, { reasoning_effort: false, max_tokens: 4096 },
    { enable_thinking: false, reasoning_effort: null, max_tokens: 4096 }, { thinking_budget: null, max_tokens: 4096 }])
    assert.throws(() => assertForwardReasoning(registration, { ...common, arm: 'baseline', resolution: null, body }), /FORWARD_REASONING_WIRE_MISMATCH/)
})

test('post-UI reviewed draft policy selects every actionable item without changing earlier phases', () => {
  const report = { summary: 'review', items: [
    { severity: 'pass', category: '事实', description: '保持' },
    { severity: 'warning', category: '自然度', description: '修复重复', quote: '重复句' },
    { severity: 'error', category: '事实', description: '恢复保管事实', quote: '钥匙丢失' },
  ] }
  assert.deepEqual(reviewedDraftSelection(report), { selected: report.items.slice(1), disposition: 'revised-once' })
  assert.deepEqual(reviewedDraftSelection({ items: [report.items[0]] }), { selected: [], disposition: 'no-actionable-review' })
  const mixed = { items: [{ severity: 'unknown', category: '目标', description: '证据不足' }, report.items[1]] }
  assert.deepEqual(reviewedDraftSelection(mixed), { selected: [report.items[1]], disposition: 'revised-once' })
  assert.equal(mixed.items[0].severity, 'unknown')
  assert.deepEqual(reviewedDraftSelection({ items: [mixed.items[0]] }),
    { selected: [], disposition: 'no-actionable-review-with-unresolved-goals' })
  assert.throws(() => reviewedDraftSelection({ items: [{ severity: 'invented' }] }), /REVIEWED_DRAFT_REPORT_INVALID/)
  const selected = selectPhase(protocol, 'early-budget', 'post-ui')
  assert.deepEqual(selected.evaluationPolicy, POST_UI_REVIEW_POLICY)
  assert.equal(selected.scenarioRevision, POST_UI_SCENARIO_REVISION)
  assert.equal(selected.maximumPlannedCalls, 30, '每臂目录3、正文8、首审2、修稿1、复评1；原产品root预算可先耗尽')
  assert.deepEqual(selected.attemptPolicy.reviewRebuild, PHASE_SCENARIOS['early-budget'].attemptPolicy.reviewRebuild)
  assertScenarioMatchesProtocol(selected, productionScenario('early-budget', 'post-ui'))
  assert.deepEqual(selected.operations.map(item => item.kind), ['directory', 'draft', 'review', 'refine', 'final-review'])
  assert.equal(selectPhase(protocol, 'early-budget').evaluationPolicy, undefined)
  assert.equal(selectPhase(protocol, 'full', 'final').evaluationPolicy, undefined)
  assert.deepEqual(validateReviewedDraft({}), { valid: false, pairFailure: 'REVIEWED_DRAFT_EVIDENCE_INVALID' })
})

// v2 是语义源 scenarioAuthorSettingLines 登记附加行所用的键；v3 只改登记（attemptPolicy 增加唯一压缩），沿用同一附加行。
const MUST_SHOW_SCENARIO_REVISION = 's14b-post-ui-reviewed-budget-review-rebuild-must-show-v2'
const POST_UI_SCENARIO_REVISION = 's14b-post-ui-reviewed-budget-review-rebuild-must-show-v4'
const MUST_SHOW_LINE = '【第1章必现】林澄保管铜钥匙'
test('post-UI must-show v3 adopts author must-show unknown goals with actionable items in one revision', () => {
  assert.equal(POST_UI_REVIEW_POLICY.revision, 's14b-post-ui-reviewed-draft-must-show-unknown-v3')
  assert.equal(POST_UI_REVIEW_POLICY.selection, 'all-error-warning-and-must-show-unknown-in-report-order')
  assert.equal(POST_UI_REVIEW_POLICY.mustShowGoalId, '^ch\\d+:mustShow:\\d+$')
  assert.equal(POST_UI_REVIEW_POLICY.maxRevisions, 1)
  // 不对称必须在策略本身披露，策略原样进入协议、manifest 与每臂 receipt。
  for (const key of ['baseline', 'candidate', 'claim']) assert.ok(POST_UI_REVIEW_POLICY.armAsymmetry[key].trim())
  assert.match(POST_UI_REVIEW_POLICY.armAsymmetry.claim, /不得.*声称相对改善/u)
  const keyUnknown = { category: '本章目标', goalId: 'ch1:keyEvents:1', severity: 'unknown', description: '发现异常\n证据不足' }
  const mustShow = { category: '本章目标', goalId: 'ch1:mustShow:1', severity: 'unknown', description: '林澄保管铜钥匙\n未明示' }
  const warning = { category: '自然度', severity: 'warning', description: '修复重复', quote: '重复句' }
  const error = { category: '事实', severity: 'error', description: '恢复保管事实', quote: '钥匙丢失' }
  const coverage = { category: '本章目标', severity: 'unknown', description: '覆盖不完整' }
  const lookalike = { category: '本章目标', goalId: 'ch1:mustShowX:1', severity: 'unknown', description: '非必现目标' }
  const completed = { category: '本章目标', goalId: 'ch1:mustShow:2', severity: 'pass', description: '已明示', quote: '钥匙' }
  const report = { items: [{ severity: 'pass', category: '事实', description: '保持' }, keyUnknown, warning, mustShow, lookalike, error, coverage, completed] }
  assert.deepEqual(reviewedDraftSelection(report), { selected: [warning, mustShow, error], disposition: 'revised-once' },
    'error/warning 与 mustShow unknown 按原报告顺序共用唯一修稿；非必现 unknown 不被采纳')
  assert.deepEqual(reviewedDraftSelection({ items: [keyUnknown, mustShow, coverage] }),
    { selected: [mustShow], disposition: 'revised-once' }, '仅有必现 unknown 时同样只触发一次修稿')
  assert.equal(mustShow.severity, 'unknown', '选择不改写原 unknown')
  // baseline 2264390d 不识别标记：其报告最多只有 keyEvents unknown，按原 unknown-only 规则保留初稿。
  assert.deepEqual(reviewedDraftSelection({ items: [keyUnknown, coverage, report.items[0]] }),
    { selected: [], disposition: 'no-actionable-review-with-unresolved-goals' })
  assert.deepEqual(reviewedDraftSelection({ items: [report.items[0], completed] }), { selected: [], disposition: 'no-actionable-review' },
    '首稿自然满足必现目标时修复分支不触发')
  const post = selectPhase(protocol, 'early-budget', 'post-ui')
  assert.equal(post.scenarioRevision, POST_UI_SCENARIO_REVISION)
  assert.equal(productionScenario('early-budget', 'post-ui').scenarioRevision, POST_UI_SCENARIO_REVISION)
  assert.equal(selectPhase(protocol, 'early-budget').scenarioRevision, 's14b-post-ui-budget-syntax-repair-v1')
})

test('must-show scenario revision adds the marker only to the post-UI scene 1 world setting', () => {
  const legacy = scene => [scene.material, scene.longSetting].filter(Boolean).join('\n')
  const revisions = [null, ...Object.values(PHASE_SCENARIOS).map(item => item.scenarioRevision),
    's14b-post-ui-reviewed-budget-review-rebuild-v1']
  for (const scene of source.scenes) for (const revision of revisions)
    assert.equal(scenarioAuthorSetting(scene, revision), legacy(scene), `${scene.id}/${revision}`)
  const [scene1, ...others] = source.scenes
  assert.equal(scenarioAuthorSetting(scene1, MUST_SHOW_SCENARIO_REVISION), `${legacy(scene1)}\n${MUST_SHOW_LINE}`)
  for (const scene of others) assert.equal(scenarioAuthorSetting(scene, MUST_SHOW_SCENARIO_REVISION), legacy(scene))
  // v3 只改 attemptPolicy：作者世界设定输入与 v2 逐字相同（同一条附加行），语义源字节不因新 revision 改动。
  assert.equal(scenarioAuthorSetting(scene1, POST_UI_SCENARIO_REVISION), `${legacy(scene1)}\n${MUST_SHOW_LINE}`)
  for (const scene of others) assert.equal(scenarioAuthorSetting(scene, POST_UI_SCENARIO_REVISION), legacy(scene))
  assert.equal(scene1.scenarioAuthorSettingLines[POST_UI_SCENARIO_REVISION], undefined, 'v3 不在语义源另登记键，避免改动冻结输入')
  // 产品冻结目标只在新场景 revision 下多出 ch1:mustShow:1；其余事实、事件与字数不变。
  const goals = setting => freezeChapterGoals(1, scene1.chapters[0].requiredEvents.join('；'), [setting]).items
  assert.deepEqual(goals(legacy(scene1)).map(item => item.id), ['ch1:keyEvents:1', 'ch1:keyEvents:2'])
  assert.deepEqual(goals(scenarioAuthorSetting(scene1, MUST_SHOW_SCENARIO_REVISION)).at(-1),
    { id: 'ch1:mustShow:1', text: '林澄保管铜钥匙' })
  assert.deepEqual(scene1.chapters[0].requiredEvents, ['发现异常', '决定核查'])
  assert.equal(scene1.chapters[0].targetUnits, 900)
  assert.equal(scene1.chapters[0].oracle.item, '铜钥匙始终由林澄保管')
})

test('must-show v3 reviewed chain keeps unknown labels and rejects tampering or the superseded v2 policy', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/must-show-chain-'))
  const artifact = (name, text, extra = {}) => {
    const outputPath = path.join(dir, name)
    fs.writeFileSync(outputPath, text)
    return { ...extra, outputPath, contentHash: hash(text) }
  }
  try {
    const items = [{ category: '本章目标', goalId: 'ch1:keyEvents:1', severity: 'unknown', description: '发现异常\n证据不足' },
      { category: '事实', severity: 'error', description: '保管人错误', quote: '初稿' },
      { category: '本章目标', goalId: 'ch1:mustShow:1', severity: 'unknown', description: '林澄保管铜钥匙\n未明示' }]
    const selectedItems = items.slice(1)
    const initial = artifact('initial.txt', '初稿句子')
    const review = artifact('review.json', JSON.stringify({ items }), { reviewId: 1, sourceHash: initial.contentHash })
    const confirmationOf = values => JSON.stringify({ sourceReviewId: 1, sourceDraft: { content: '初稿句子' },
      items: values.map(item => ({ ...item, decision: 'apply', origin: 'ai', ...(item.goalId ? { findingId: `finding:${item.goalId}` } : {}) })) })
    const confirmation = artifact('confirmation.json', confirmationOf(selectedItems))
    const revision = artifact('revision.txt', '唯一修订正文。林澄保管铜钥匙。')
    const finalReview = artifact('final-review.json', JSON.stringify({ items: [{ severity: 'pass', description: '已明示' }] }),
      { sourceHash: revision.contentHash })
    const finalDraft = artifact('final.txt', '唯一修订正文。林澄保管铜钥匙。')
    const operations = productionScenario('early-budget', 'post-ui').operations.map(item => ({ operation: item.id, kind: item.kind }))
    for (const [kind, saved] of [['draft', initial], ['review', review], ['refine', revision], ['final-review', finalReview]])
      Object.assign(operations.find(item => item.kind === kind), { outputHash: saved.contentHash, outputPath: saved.outputPath })
    const result = { evaluationPolicy: POST_UI_REVIEW_POLICY, operations, saved: { contentHash: finalDraft.contentHash },
      draftObservation: { contentHash: finalDraft.contentHash }, reviewedDraft: { initial, review, confirmation, revision,
        finalReview, finalDraft, mergeHash: revision.contentHash, selectedCount: 2, selectedItemsHash: hash(selectedItems),
        disposition: 'revised-once' } }
    assert.equal(validateReviewedDraft(result).valid, true)
    // candidate（及未声明臂）采纳的必现 unknown 必须带产品 review-cycle findingId；baseline 无 review-cycle，不要求。
    const withoutFinding = JSON.stringify({ sourceReviewId: 1, sourceDraft: { content: '初稿句子' },
      items: selectedItems.map(item => ({ ...item, decision: 'apply', origin: 'ai' })) })
    for (const [arm, findingText, valid] of [['candidate', confirmationOf(selectedItems), true],
      ['candidate', withoutFinding, false], [undefined, withoutFinding, false], ['baseline', withoutFinding, true],
      ['candidate', withoutFinding.replace('"origin":"ai"}]', '"origin":"ai","findingId":" "}]'), false]]) {
      const changed = structuredClone(result)
      changed.arm = arm
      changed.reviewedDraft.confirmation = artifact('confirmation-arm.json', findingText)
      assert.equal(validateReviewedDraft(changed).valid, valid, `${arm}:${valid}`)
    }
    const rewrite = (file, text) => { fs.writeFileSync(file.outputPath, text); file.contentHash = hash(text) }
    const relabelled = confirmationOf(selectedItems.map(item => item.goalId ? { ...item, severity: 'error' } : item))
    for (const mutate of [value => { value.reviewedDraft.selectedItemsHash = hash(items.slice(1, 2)) },
      value => { value.reviewedDraft.selectedCount = 1 },
      value => { value.reviewedDraft.disposition = 'no-actionable-review-with-unresolved-goals' },
      value => { rewrite(value.reviewedDraft.confirmation, relabelled) },
      value => { rewrite(value.reviewedDraft.confirmation, confirmationOf(items.slice(1, 2))) },
      value => { value.evaluationPolicy = { revision: 's14b-post-ui-reviewed-draft-unknown-oracle-v2',
        selection: 'all-error-warning-in-report-order', confirmation: 'test-preauthorized-original-items',
        merge: 'accept-only-revision', finalReview: 'ordinary-full-review', noAction: 'retain-initial-draft',
        unknownOnly: 'retain-initial-draft-and-full-review-pending-independent-goal-proof',
        maxRevisions: 1, qualityDecision: 'independent-oracle-final-text' } }]) {
      const changed = structuredClone(result)
      changed.reviewedDraft.confirmation = artifact('confirmation.json', confirmationOf(selectedItems))
      mutate(changed)
      assert.equal(validateReviewedDraft(changed).valid, false)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('reviewed draft evidence rejects skipped issues, best-version picking and changed artifacts', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/reviewed-chain-'))
  const artifact = (name, text, extra = {}) => {
    const outputPath = path.join(dir, name)
    fs.writeFileSync(outputPath, text)
    return { ...extra, outputPath, contentHash: hash(text) }
  }
  try {
    const items = [{ category: '事实', severity: 'error', description: '保管人错误', quote: '初稿' },
      { category: '自然度', severity: 'warning', description: '重复', quote: '句子' }]
    const initial = artifact('initial.txt', '初稿句子')
    const review = artifact('review.json', JSON.stringify({ items }), { reviewId: 1, sourceHash: initial.contentHash })
    const confirmation = artifact('confirmation.json', JSON.stringify({ sourceReviewId: 1,
      sourceDraft: { content: '初稿句子' }, items: items.map(item => ({ ...item, decision: 'apply', origin: 'ai' })) }))
    const revision = artifact('revision.txt', '唯一修订正文')
    const finalReview = artifact('final-review.json', JSON.stringify({ items: [{ severity: 'error', description: '仍有事实错误' }] }),
      { sourceHash: revision.contentHash })
    const finalDraft = artifact('final.txt', '唯一修订正文')
    const operations = productionScenario('early-budget', 'post-ui').operations.map(item => ({ operation: item.id, kind: item.kind }))
    for (const [kind, saved] of [['draft', initial], ['review', review], ['refine', revision], ['final-review', finalReview]])
      Object.assign(operations.find(item => item.kind === kind), { outputHash: saved.contentHash, outputPath: saved.outputPath })
    const result = { evaluationPolicy: POST_UI_REVIEW_POLICY, operations, saved: { contentHash: finalDraft.contentHash },
      draftObservation: { contentHash: finalDraft.contentHash }, reviewedDraft: { initial, review, confirmation, revision,
        finalReview, finalDraft, mergeHash: revision.contentHash, selectedCount: 2, selectedItemsHash: hash(items), disposition: 'revised-once' } }
    assert.equal(validateReviewedDraft(result).valid, true, 'a failing final model review stays evidence, not a model quality verdict')
    const mixedReview = JSON.stringify({ items: [{ category: '目标', severity: 'unknown', description: '证据不足' }, ...items] })
    fs.writeFileSync(review.outputPath, mixedReview)
    review.contentHash = hash(mixedReview)
    operations.find(item => item.kind === 'review').outputHash = review.contentHash
    assert.equal(validateReviewedDraft(result).valid, true, 'unknown remains in the saved report while actionable items are selected')
    const passReview = artifact('pass-review.json', JSON.stringify({ items: [{ category: '事实', severity: 'pass', description: '已满足' }] }),
      { reviewId: 2, sourceHash: initial.contentHash })
    const noAction = { evaluationPolicy: POST_UI_REVIEW_POLICY,
      operations: [{ operation: operations[0].operation, kind: 'directory' },
        { operation: operations[1].operation, kind: 'draft', outputHash: initial.contentHash },
        { operation: operations[2].operation, kind: 'review', outputHash: passReview.contentHash }],
      saved: { contentHash: initial.contentHash }, draftObservation: { contentHash: initial.contentHash },
      reviewedDraft: { initial, review: passReview, finalDraft: initial, selectedCount: 0,
        selectedItemsHash: hash([]), disposition: 'no-actionable-review' } }
    assert.equal(validateReviewedDraft(noAction).valid, true)
    const unknownReview = JSON.stringify({ items: [{ category: '目标', severity: 'unknown', description: '证据不足' }] })
    fs.writeFileSync(passReview.outputPath, unknownReview)
    passReview.contentHash = hash(unknownReview)
    noAction.operations[2].outputHash = passReview.contentHash
    assert.equal(validateReviewedDraft(noAction).valid, false, 'unknown-only review cannot become ordinary no-action')
    noAction.reviewedDraft.disposition = 'no-actionable-review-with-unresolved-goals'
    assert.deepEqual(validateReviewedDraft(noAction), { valid: true,
      operations: productionScenario('early-budget', 'post-ui').operations.slice(0, 3),
      disposition: 'no-actionable-review-with-unresolved-goals' })
    const pendingPair = ['baseline', 'candidate'].map(arm => ({ ...structuredClone(noAction), arm,
      phase: 'early-budget', milestone: 'post-ui', protocolRevision: protocol.decisionRevision, status: 'passed',
      draftObservation: { chapterNumber: 1, targetUnits: 100, units: 100, persisted: true, contentHash: initial.contentHash },
      saved: { chapterNumber: 1, targetUnits: 100, units: 100, contentHash: initial.contentHash } }))
    assert.equal(classifyProductionPair(pendingPair, { mode: 'real', phase: 'early-budget' }).status,
      'pending-independent-oracle-review')
    const splitPair = pendingPair.map(value => ({ ...value, protocolRevision: 's14b-split-quality-gates-v1' }))
    assert.equal(classifyProductionPair(splitPair, { mode: 'real', phase: 'early-budget' }).status,
      'pending-independent-oracle-review', '真实 unknown 报告与有效审修链仍只到独立评审待判')
    assert.equal(classifyProductionPair([{ ...splitPair[0], reviewedDraft: null }, splitPair[1]],
      { mode: 'real', phase: 'early-budget' }).pairFailure, 'REVIEWED_DRAFT_EVIDENCE_INVALID')
    assert.equal(classifyProductionPair([splitPair[0], { ...splitPair[1], status: 'failed' }],
      { mode: 'real', phase: 'early-budget' }).status, 'failed')
    assert.equal(classifyProductionPair([{ ...splitPair[0], status: 'failed', saved: null }, splitPair[1]],
      { mode: 'real', phase: 'early-budget' }).status, 'failed')
    assert.equal(classifyProductionPair([{ ...pendingPair[0], reviewedDraft: null }, pendingPair[1]],
      { mode: 'real', phase: 'early-budget' }).pairFailure, 'REVIEWED_DRAFT_EVIDENCE_INVALID',
    'new revision must keep the completed review-chain technical gate')
    fs.writeFileSync(passReview.outputPath, JSON.stringify({ items: [{ severity: 'pass' }] }))
    assert.equal(validateReviewedDraft(noAction).valid, false, 'changed full original review must fail')
    fs.writeFileSync(passReview.outputPath, unknownReview)
    noAction.reviewedDraft.disposition = 'no-actionable-review'
    for (const mutate of [value => { value.reviewedDraft.selectedCount = 1 },
      value => { value.reviewedDraft.finalDraft = initial },
      value => { value.operations.pop() },
      value => { value.reviewedDraft.disposition = 'no-actionable-review' },
      value => { value.reviewedDraft.finalReview.sourceHash = initial.contentHash },
      value => { value.evaluationPolicy = { ...POST_UI_REVIEW_POLICY, maxRevisions: 2 } }]) {
      const changed = structuredClone(result); mutate(changed)
      assert.equal(validateReviewedDraft(changed).valid, false)
    }
    fs.writeFileSync(initial.outputPath, '合并后覆写初稿')
    assert.equal(validateReviewedDraft(result).valid, false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
fs.mkdirSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization'), { recursive: true })

test('c16-c18 keeps candidate qualification and the two allocations separate', () => {
  const scenario = PHASE_SCENARIOS['c16-c18']
  assert.ok(scenario, 'C16_C18_SCENARIO_MISSING')
  const selection = selectPhase(protocol, 'c16-c18', 'final')
  assertScenarioMatchesProtocol(selection, scenario, semanticPath)
  assert.deepEqual(selection.caseOrder, source.continuityQualificationCases.map(item => item.id))
  for (const mutate of [
    value => { value.caseOrder.reverse() },
    value => { delete value.caseOracles['C16-A'] },
    value => { value.caseOracles['C18-B'].independentReview = [] },
    value => { delete value.stopPolicy.technicalFailure },
  ]) {
    const changed = structuredClone(selection)
    mutate(changed)
    assert.throws(() => assertScenarioMatchesProtocol(changed, scenario, semanticPath), /SCENARIO_PROTOCOL_MISMATCH/)
  }
  assert.deepEqual(scenario.arms, ['candidate'])
  assert.equal(scenario.operations.length, 6)
  assert.equal(protocol.allocation.C16ExistingExtraction, 6)
  assert.equal(protocol.allocation.C17C18RestoreContinue, 4)
  // C17-B 重新定稿后处理仍计余量；新 run 省去四次对账，80 次计划分配与原预算保护不变。
  assert.equal(Object.values(protocol.allocation).reduce((a, b) => a + b, 0), 80)
  assert.equal(protocol.phases['c16-c18'].minimumCalls, 12)
  assert.match(protocol.phases['c16-c18'].scope, /新run直接首稿/)
  assert.match(protocol.phases['c16-c18'].scope, /最短12次.*既有每run\/root预算/)
  assert.deepEqual(protocol.phases['c16-c18'].operations.slice(4).map(item => [item.id, item.kind, item.caseIds, item.allocation]), [
    ['恢复副本重新定稿章节要点', 'chapter_notes', ['C17-B'], 'failedRetryRepairReviewReserve'],
    ['恢复副本重新定稿角色状态', 'character_cards', ['C17-B'], 'failedRetryRepairReviewReserve']])
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/c16-ledger-test-'))
  try {
    const file = path.join(dir, 'synthetic-ledger.jsonl')
    for (const operation of scenario.operations) {
      const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', ...protocolBinding, arm: 'candidate',
        codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
        phase: 'c16-c18', milestone: 'final', caseId: operation.caseIds.at(-1), operation: operation.id,
        actual: { attemptId: operation.id, runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch' } }
      assert.throws(() => validateCampaignBinding({ ...binding, arm: 'baseline' }, { campaignMode: 'synthetic', protocol }), /INVALID_CAMPAIGN_BINDING/)
      updateLedger(file, { type: 'reserve', attemptId: operation.id, binding }, { campaignMode: 'synthetic' })
    }
    // 新 operation 只对登记的 C17-B 有效，C16 与其他恢复案都拒绝。
    for (const caseId of ['C16-C', 'C17-A', 'C18-B']) assert.throws(() => validateCampaignBinding({ campaignId: CAMPAIGN_ID, mode: 'synthetic',
      ...protocolBinding, arm: 'candidate', codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(),
      parityId: 'c'.repeat(64), phase: 'c16-c18', milestone: 'final', caseId, operation: '恢复副本重新定稿章节要点',
      actual: { attemptId: 'x', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch' } },
    { campaignMode: 'synthetic', protocol }), /INVALID_CAMPAIGN_BINDING/)
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(rows.map(row => row.allocation), ['C16ExistingExtraction', 'C16ExistingExtraction', 'C17C18RestoreContinue', 'C17C18RestoreContinue',
      'failedRetryRepairReviewReserve', 'failedRetryRepairReviewReserve'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  // 案例到 operation 的映射只由登记 caseIds 决定：C17-B 先后处理 notes→cards 再本地续写，其余恢复案只续写。
  assert.deepEqual(Object.fromEntries(scenario.caseIds.map(caseId => [caseId, continuityCaseOperations(caseId).map(item => item.id)])), {
    'C16-A': ['定稿章节要点', '定稿角色状态'], 'C16-B': ['定稿章节要点', '定稿角色状态'], 'C16-C': ['定稿章节要点', '定稿角色状态'],
    'C17-A': ['本地恢复后续写'], 'C17-B': ['恢复副本重新定稿章节要点', '恢复副本重新定稿角色状态', '本地恢复后续写'],
    'C18-A': ['DAV选定世代恢复后续写'], 'C18-B': ['DAV选定世代恢复后续写'] })
  for (const mutate of [
    value => { value.operations[4].caseIds = ['C17-A', 'C17-B'] },
    value => { value.operations[5].kind = 'chapter_notes' },
    value => { value.operations[2].restore = 'webdav' },
    value => { value.operations.splice(4, 2) },
  ]) {
    const changed = structuredClone(selection)
    mutate(changed)
    assert.throws(() => assertScenarioMatchesProtocol(changed, scenario, semanticPath), /SCENARIO_PROTOCOL_MISMATCH/)
  }
})

test('C16 native repairs require each settled invalid artifact and keep their actual owner lineage', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/c16-repair-test-'))
  try {
    const operation = '定稿角色状态'
    const first = { attemptId: 'first', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch', purpose: 'finalized-character-state' }
    const outputPath = path.join(dir, 'artifact.txt')
    fs.writeFileSync(outputPath, '{"updates":[{"evidence":"invalid"}]}')
    const outputHash = hash(fs.readFileSync(outputPath))
    let invalid = true
    const proof = owner => {
      const attemptId = `candidate:${owner.attemptId}`
      const binding = { operation, actual: { ...owner } }
      delete binding.actual.ordinal
      return { attempt: { attemptId, binding, outputPath, visibleTextHash: outputHash },
        events: [{ type: 'reserve', attemptId, binding }, { type: 'dispatch', attemptId }, { type: 'settle', attemptId, finishReason: 'stop' }],
        finalizedCharacterInvalid: invalid, ownerArtifactHash: outputHash }
    }
    const create = () => createOperationDispatchGate({ finalizationRepair: true, readPrimaryEvidence: proof })
    const gate = create()
    gate(operation, first)
    const repair = { ...first, attemptId: 'repair1', purpose: 'finalized-character-state:repair:1' }
    assert.throws(() => gate(operation, { ...repair, rootActionId: 'other' }), /MODEL_REQUEST_REJECTED/)
    invalid = false
    assert.throws(() => gate(operation, repair), /MODEL_REQUEST_REJECTED/)
    invalid = true
    gate(operation, repair)
    assert.throws(() => gate(operation, repair), /MODEL_REQUEST_REJECTED/)
    gate(operation, { ...first, attemptId: 'repair2', purpose: 'finalized-character-state:repair:2' })
    assert.throws(() => gate(operation, { ...first, attemptId: 'repair3', purpose: 'finalized-character-state:repair:3' }), /MODEL_REQUEST_REJECTED/)
    const unchanged = createOperationDispatchGate({ readPrimaryEvidence: proof })
    unchanged(operation, first)
    assert.throws(() => unchanged(operation, repair), /MODEL_REQUEST_REJECTED/)
    // v4：C17-B 恢复副本重新定稿角色状态与 C16 同一原生 repair 登记：各自独立计数，最多两次，仍须持久失败产物。
    assert.deepEqual(FINALIZED_CHARACTER_OPERATION_IDS, ['定稿角色状态', '恢复副本重新定稿角色状态'])
    const refinalized = '恢复副本重新定稿角色状态'
    const own = (owner) => { const value = proof(owner); value.attempt.binding.operation = refinalized; return value }
    const c17b = createOperationDispatchGate({ finalizationRepair: true, readPrimaryEvidence: own })
    c17b(operation, first)
    c17b(refinalized, first)
    invalid = false
    assert.throws(() => c17b(refinalized, repair), /MODEL_REQUEST_REJECTED/)
    invalid = true
    c17b(refinalized, repair)
    c17b(refinalized, { ...first, attemptId: 'repair2', purpose: 'finalized-character-state:repair:2' })
    assert.throws(() => c17b(refinalized, { ...first, attemptId: 'repair3', purpose: 'finalized-character-state:repair:3' }), /MODEL_REQUEST_REJECTED/)
    // 首请求必须是 finalized-character-state；notes 后处理没有 repair 权。
    assert.throws(() => createOperationDispatchGate({ finalizationRepair: true, readPrimaryEvidence: own })(refinalized, repair), /MODEL_REQUEST_REJECTED/)
    const notes = createOperationDispatchGate({ finalizationRepair: true, readPrimaryEvidence: own })
    notes('恢复副本重新定稿章节要点', { ...first, purpose: 'finalized-chapter-notes' })
    assert.throws(() => notes('恢复副本重新定稿章节要点', { ...first, attemptId: 'notes2', purpose: 'finalized-chapter-notes' }), /MODEL_REQUEST_REJECTED/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// 合成篇幅文本与生产计数：与桥里完全相同的 syntheticDraftText / syntheticDraftUnitsGoal 源码。
const fixtureSource = () => fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
function syntheticLengthHelpers() {
  const fixture = fixtureSource()
  const slice = (from, to) => fixture.slice(fixture.indexOf(from), fixture.indexOf(to, fixture.indexOf(from)))
  const sandbox = {}
  vm.runInNewContext(`${slice('const syntheticDraftText =', 'const reviewedSyntheticIssues =')}
${slice('const syntheticDraftUnitsGoal =', 'const syntheticReview =')}
this.syntheticDraftText = syntheticDraftText; this.syntheticDraftUnitsGoal = syntheticDraftUnitsGoal`, sandbox)
  return sandbox
}
const C17_TARGET = source.scenes.find(scene => scene.id === '场景1').chapters[1].targetUnits
const C17_RANGE = draftTargetUnitRange(C17_TARGET)

test('C17/C18 唯一压缩只在已结算且 hash 可复核的超长首稿后登记一次', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/condense-gate-test-'))
  try {
    const policy = PHASE_SCENARIOS['c16-c18'].attemptPolicy.draftCondense
    assert.deepEqual(policy.operationIds, ['本地恢复后续写', 'DAV选定世代恢复后续写'])
    const { syntheticDraftText } = syntheticLengthHelpers()
    const overText = syntheticDraftText(countDraftUnits, C17_RANGE.maximum + 60)
    const inRangeText = syntheticDraftText(countDraftUnits, C17_TARGET)
    assert.ok(countDraftUnits(overText) > C17_RANGE.maximum && countDraftUnits(inRangeText) <= C17_RANGE.maximum)
    const operation = '本地恢复后续写'
    const first = { attemptId: 'first', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch', purpose: 'chapter-draft' }
    const outputPath = path.join(dir, 'primary.txt')
    const settled = { finish: 'stop', artifact: null, operation, recorded: null }
    const proof = owner => {
      const attemptId = `candidate:${owner.attemptId}`, text = fs.readFileSync(outputPath, 'utf8')
      const binding = { operation: settled.operation, actual: { ...owner } }
      return { attempt: { attemptId, binding, outputPath, visibleTextHash: settled.recorded ?? hash(text) },
        events: [{ type: 'reserve', attemptId, binding }, { type: 'dispatch', attemptId }, { type: 'settle', attemptId, finishReason: settled.finish }],
        ownerArtifactHash: settled.artifact ?? hash(text) }
    }
    const draftCondense = { policy, maximum: C17_RANGE.maximum, measureUnits: countDraftUnits }
    const rejections = []
    const create = (options = {}) => createOperationDispatchGate({ finalizationRepair: true, draftCondense, readPrimaryEvidence: proof,
      onReject: item => rejections.push(item), ...options })
    const condense = { ...first, attemptId: 'condense', purpose: 'chapter-draft-condense' }
    fs.writeFileSync(outputPath, overText)
    // 注册的唯一压缩：同 run/root/项目/epoch，首稿已 stop 结算且按生产计数超上限。
    const gate = create()
    gate(operation, first)
    gate(operation, condense)
    assert.throws(() => gate(operation, { ...condense, attemptId: 'condense-2' }), /MODEL_REQUEST_REJECTED/)
    assert.throws(() => gate(operation, { ...first, attemptId: 'continuation', purpose: 'chapter-draft-continuation' }), /MODEL_REQUEST_REJECTED/)
    assert.deepEqual(rejections.at(-1), { code: 'UNREGISTERED_ADDITIONAL_MODEL_REQUEST', operationId: operation,
      reason: 'duplicate-operation', beforeDispatch: true })
    // DAV 续写同样登记；两个操作各自计数，互不借用。
    const dav = create()
    dav('DAV选定世代恢复后续写', first)
    settled.operation = 'DAV选定世代恢复后续写'
    dav('DAV选定世代恢复后续写', condense)
    settled.operation = operation
    const rejected = mutate => {
      const isolated = create()
      isolated(operation, first)
      const owner = mutate() ?? condense
      assert.throws(() => isolated(operation, owner), /MODEL_REQUEST_REJECTED/)
      fs.writeFileSync(outputPath, overText); Object.assign(settled, { finish: 'stop', artifact: null, operation, recorded: null })
    }
    rejected(() => { fs.writeFileSync(outputPath, inRangeText) })
    // 首稿产物在结算后被改写：记录的 hash 与读回字节不符。
    rejected(() => { settled.recorded = hash(overText); fs.writeFileSync(outputPath, `${overText}补`) })
    rejected(() => { settled.finish = 'length' })
    rejected(() => { settled.artifact = hash('other owner artifact') })
    rejected(() => { settled.operation = 'DAV选定世代恢复后续写' })
    rejected(() => ({ ...condense, rootActionId: 'other-root' }))
    rejected(() => ({ ...condense, epoch: 'other-epoch' }))
    rejected(() => ({ ...condense, attemptId: first.attemptId }))
    rejected(() => ({ ...condense, purpose: 'chapter-draft-condense:2' }))
    // 恰在上限不越界：不许压缩（上限本身在范围内）。
    const exact = create()
    exact(operation, first)
    let atMaximum = inRangeText
    const extra = '清晨，林澄核对登记，发现日期异常。'
    while (countDraftUnits(atMaximum + extra) <= C17_RANGE.maximum) atMaximum += extra
    fs.writeFileSync(outputPath, atMaximum)
    assert.ok(countDraftUnits(atMaximum) <= C17_RANGE.maximum)
    assert.throws(() => exact(operation, condense), /MODEL_REQUEST_REJECTED/)
    fs.writeFileSync(outputPath, overText)
    // 压缩不能作为首请求，也不能用于未登记操作或未登记本策略的旧门。
    assert.throws(() => create()(operation, condense), /MODEL_REQUEST_REJECTED/)
    const notes = create()
    notes('定稿章节要点', { ...first, purpose: 'finalized-chapter-notes' })
    assert.throws(() => notes('定稿章节要点', condense), /MODEL_REQUEST_REJECTED/)
    const legacy = createOperationDispatchGate({ finalizationRepair: true, readPrimaryEvidence: proof })
    legacy(operation, first)
    assert.throws(() => legacy(operation, condense), /MODEL_REQUEST_REJECTED/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('合成 transport 可复现 C17/C18 超长→唯一压缩→在范围，以及压缩仍越界', () => {
  const { syntheticDraftText, syntheticDraftUnitsGoal } = syntheticLengthHelpers()
  const units = (plan, caseId, purpose) => countDraftUnits(syntheticDraftText(countDraftUnits,
    syntheticDraftUnitsGoal(plan, caseId, purpose, C17_TARGET, C17_RANGE.maximum)))
  for (const caseId of ['C17-A', 'C18-B']) {
    const inRange = { caseId, outcome: 'in-range' }, stillOver = { caseId, outcome: 'still-over' }
    assert.ok(units(inRange, caseId, 'chapter-draft') > C17_RANGE.maximum, `${caseId}:primary-over`)
    const condensed = units(inRange, caseId, 'chapter-draft-condense')
    assert.ok(condensed >= C17_RANGE.minimum && condensed <= C17_RANGE.maximum, `${caseId}:condense-in-range`)
    assert.ok(units(stillOver, caseId, 'chapter-draft-condense') > C17_RANGE.maximum, `${caseId}:condense-still-over`)
    // 未登记案例与未登记计划保持原合成行为：首稿在范围内，产品不会发起压缩。
    for (const plan of [null, { caseId: 'C16-A', outcome: 'in-range' }]) {
      const value = units(plan, caseId, 'chapter-draft')
      assert.ok(value >= C17_RANGE.minimum && value <= C17_RANGE.maximum)
    }
  }
  const fixture = fixtureSource()
  assert.match(fixture, /draftCondense && request\.mode === 'synthetic' && operationKind === 'draft'\s*\? syntheticDraftUnitsGoal\(request\.syntheticDraftCondense, request\.caseId, actual\.purpose, chapter\.targetUnits, draftCondense\.maximum\)/)
  assert.match(fixture, /assert\.equal\(visible\.DRAFT_CONDENSE_PURPOSE, condensePolicy\.condensePurpose, 'DRAFT_CONDENSE_PURPOSE_MISMATCH'\)/)
  assert.match(fixture, /createOperationDispatchGate\(\{ repairPolicy, draftCondense, draftRecovery, structuredRecovery,\s*finalizationRepair: continuityRun,/)
  assert.match(fixture, /draftCondense = \{ policy: condensePolicy, targetUnits, maximum: draftTargetUnitRange\(targetUnits\)\.maximum,\s*measureUnits: text => countUnits\(visible\.sanitizeDraftText\(redactVisibleCompletionText\(text\)\)\) \}/)
  // 压缩发出前先等首稿流结算，门禁才能读到 settle 与 hash。
  assert.match(fixture, /if \(\(draftRecovery \|\| condensePolicy\) && operationKind === 'draft'\) await Promise\.all\(streamSettlements\)/)
  assert.deepEqual(syntheticDraftCondensePlan({ mode: 'synthetic', development: true, phase: 'c16-c18' }),
    { syntheticDraftCondense: { caseId: 'C17-A', outcome: 'in-range' } })
})

const RECONCILE_OUTPUT = JSON.stringify({ finalState: ['核查尚未开始，原定安排仍在等待条件满足'],
  events: [{ event: '核查遇阻', conflict: true, realization: '林澄先写明新的决定与理由，再动身核查，途中受阻。' },
    { event: '承担代价', conflict: false, realization: '' }] })
function continuityResults(dir, { condensedIndex = null, primaryText, savedUnits = C17_TARGET, mode = 'synthetic',
  proposed = true, authorProtected = true, reconcile = false, reconcileOutput = RECONCILE_OUTPUT, reconcileFinish = 'stop' } = {}) {
  const write = (name, text) => { const file = path.join(dir, name); fs.writeFileSync(file, text); return { outputPath: file, visibleTextHash: hash(text) } }
  const finalizedSource = (draftId, tag) => ({ draftId, finalizationId: `finalization-${tag}`, chapterNumber: 1, contentHash: hash(`content-${tag}`) })
  const predecessor = (draftId, content) => ({ sourceId: `finalized:${draftId}`, chapterNumber: 1, version: 1, revision: draftId,
    contentHash: hash(content), persistedBytes: Buffer.byteLength(content, 'utf8'), markerHash: null, required: true })
  return PHASE_SCENARIOS['c16-c18'].caseIds.map((caseId, index) => {
    const projectId = index < 3 ? 'project-source' : `project-restored-${index}`
    const epoch = `epoch-${index}`
    // C16-B/C16-C 原项目内重新定稿，C17-B 恢复副本内重新定稿：后处理与续写都绑定替换后的新来源。
    const replacement = [1, 2, 4].includes(index) ? { before: finalizedSource(3, `before-${index}`), after: finalizedSource(10 + index, `after-${index}`),
      content: `更正定稿-${index}`, draftId: 10 + index, version: 1 } : null
    const beforePredecessors = [predecessor(3, '原定稿')]
    const readbackBefore = { predecessors: beforePredecessors, semanticHash: hash('semantic') }
    const readback = index === 4 ? { ...readbackBefore, predecessors: [predecessor(replacement.draftId, replacement.content)] } : readbackBefore
    const parityHash = hash(readback)
    const admitted = readback.predecessors[0]
    const attempts = [], ownerTerminal = []
    let draftReconciliation
    const receiptOps = continuityCaseOperations(caseId).map(operation => {
      const handle = { runId: `run-${index}-${operation.kind}`, rootActionId: `root-${index}-${operation.kind}` }
      if (operation.kind === 'draft' && reconcile) {
        // v5：登记续写的首个物理请求是唯一一次生成前定稿对账；提示与输出落盘并以 hash 绑定。
        const attemptId = `${index}-reconcile-0`, promptText = `对账提示-${index}`
        const output = write(`${attemptId}.txt`, reconcileOutput), prompt = write(`${attemptId}-prompt.txt`, promptText)
        attempts.push({ attemptId: `candidate:${attemptId}`, ...output, userPromptHash: hash(promptText), binding: { operation: operation.id, phase: 'c16-c18',
          arm: 'candidate', invocationId: 'invocation', parityId: parityHash,
          actual: { attemptId, projectId, epoch, ...handle, purpose: 'chapter-draft-reconcile' } },
          optionalMaterialEvidence: { materialDecision: { reconciliationPromptHash: hash(promptText), included: [
            { sourceId: admitted.sourceId, revision: admitted.revision, category: 'finalized-history' }] } } })
        ownerTerminal.push({ attemptId, artifactId: `artifact-${attemptId}`, textHash: output.visibleTextHash, purpose: 'chapter-draft-reconcile',
          finishReason: reconcileFinish, hasFormalEffect: false })
        const block = reconcileFinish === 'stop' ? draftReconciliationBlock('zh-CN', reconcileOutput) : ''
        const draftCount = index === condensedIndex ? 2 : 1
        draftReconciliation = { operation: operation.id, status: block ? 'injected' : 'unusable', attemptId, finishReason: reconcileFinish,
          prompt: { outputPath: prompt.outputPath, contentHash: prompt.visibleTextHash },
          output: { outputPath: output.outputPath, contentHash: output.visibleTextHash },
          conflicts: block ? parseDraftReconciliation(reconcileOutput).events.filter(item => item.conflict).length : 0,
          blockHash: block ? hash(block) : null,
          reason: block ? null : reconcileFinish !== 'stop' ? 'finish-reason-not-stop' : 'unparseable-output',
          firstDraftAttemptId: `${index}-draft-0`, injectedIntoFirstDraft: Boolean(block), authorMaterialAttempts: block ? draftCount - 1 : 0 }
      }
      const purposes = operation.kind === 'chapter_notes' ? ['finalized-chapter-notes'] : operation.kind === 'character_cards'
        ? ['finalized-character-state'] : index === condensedIndex ? ['chapter-draft', 'chapter-draft-condense'] : ['chapter-draft']
      purposes.forEach((purpose, ordinal) => {
        const attemptId = `${index}-${operation.kind}-${ordinal}`
        const output = write(`${attemptId}.txt`, ordinal === 0 && purposes.length === 2 ? primaryText : operation.kind === 'draft' ? '甲'.repeat(savedUnits) : `output ${attemptId}`)
        attempts.push({ attemptId: `candidate:${attemptId}`, ...output, finishReason: 'stop', binding: { operation: operation.id, phase: 'c16-c18',
          arm: 'candidate', invocationId: 'invocation', parityId: parityHash,
          actual: { attemptId, projectId, epoch, ...handle, purpose } },
          ...(operation.kind === 'draft' ? { optionalMaterialEvidence: { materialDecision: { included: [
            { sourceId: admitted.sourceId, revision: admitted.revision, category: 'finalized-history' }] } } } : {}) })
        ownerTerminal.push({ attemptId, artifactId: `artifact-${attemptId}`, textHash: output.visibleTextHash, purpose,
          finishReason: 'stop', hasFormalEffect: ordinal === purposes.length - 1 })
      })
      return { operation: operation.id, kind: operation.kind, handle }
    })
    const formal = attempts.filter(attempt => attempt.binding.operation === '定稿角色状态').at(-1)
    const authorProtection = { field: 'mentalState', authorValue: '谨慎', proposed, status: proposed ? 'triggered' : 'untriggered',
      formalAttemptId: formal?.binding.actual.attemptId, ownerArtifactHash: formal?.visibleTextHash,
      derivation: 'formal-owner-artifact-production-parser' }
    const source = replacement?.after ?? finalizedSource(3, `current-${index}`)
    const finalizationEvidence = { source, idempotent: true, derivedApplied: true,
      effects: [{ stepKey: 'chapter_notes' }, { stepKey: 'character_cards' }],
      notesReadback: { draftId: source.draftId, sourceFinalizationId: source.finalizationId, sourceContentHash: source.contentHash,
        sourceStatus: 'current', chapterNotesHash: hash(`notes-${index}`) },
      cardsReadback: { characterId: 'character', sourceFinalizationId: source.finalizationId },
      ...(index === 1 ? { authorProtected, authorProtection } : {}) }
    return { status: 'passed', arm: 'candidate', phase: 'c16-c18', mode, caseId, invocationId: 'invocation',
      protocolRevision: protocolBinding.protocolRevision, physicalProject: { projectId, parityHash, readback }, projectEpoch: epoch,
      operations: receiptOps, attempts, ownerTerminal, physicalModelRequests: mode === 'real' ? attempts.length : 0,
      ...(draftReconciliation ? { draftReconciliation } : {}),
      syntheticDispatches: mode === 'synthetic' ? attempts.length : 0,
      ...(index < 3 || index === 4 ? { finalizationEvidence } : {}),
      ...(index < 3 ? replacement ? { sourceReplacement: replacement } : {} : {
        draftObservation: { chapterNumber: 2, units: savedUnits, targetUnits: C17_TARGET, persisted: true, contentHash: hash('甲'.repeat(savedUnits)) },
        restoration: { originProjectId: 'project-source', targetProjectId: projectId, transferReceiptHash: hash('transfer'),
          sourceUnchanged: true, oldWorkFrozen: true, ...(index >= 5 ? { selectedGenerationId: 'generation', bindingMode: 'origin-readonly' } : {}),
          ...(index === 4 ? { sourceReplacement: replacement, predecessorsBeforeReplacement: beforePredecessors,
            parityHashBeforeReplacement: hash(readbackBefore) } : {}),
          ...(index === 6 ? { branchGenerationIds: ['a', 'b'] } : {}) } }) }
  })
}

test('C17/C18 压缩结果最多两次 attempt、正式效果只在末次，且首稿超上限须可复核', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/condense-result-test-'))
  try {
    const { syntheticDraftText } = syntheticLengthHelpers()
    const overText = syntheticDraftText(countDraftUnits, C17_RANGE.maximum + 60)
    assert.deepEqual(validateCandidateContinuityResults(continuityResults(dir), 'synthetic'), { status: 'passed' })
    for (const index of [3, 4, 5, 6]) {
      assert.deepEqual(validateCandidateContinuityResults(continuityResults(dir, { condensedIndex: index, primaryText: overText }), 'synthetic'),
        { status: 'passed' }, `case ${index}`)
    }
    const failure = (results, code) => assert.deepEqual(validateCandidateContinuityResults(results, 'synthetic'),
      { status: 'failed', candidateFailure: code })
    const condensed = () => continuityResults(dir, { condensedIndex: 3, primaryText: overText })
    // 首稿未超上限、首稿产物被改写、压缩后保存稿仍越界，都不是登记的压缩。
    failure(continuityResults(dir, { condensedIndex: 3, primaryText: syntheticDraftText(countDraftUnits, C17_TARGET) }), 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    const tampered = condensed()
    fs.appendFileSync(tampered[3].attempts.find(attempt => attempt.attemptId === 'candidate:3-draft-0').outputPath, '改')
    failure(tampered, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    failure(continuityResults(dir, { condensedIndex: 3, primaryText: overText, savedUnits: C17_RANGE.maximum + 1 }), 'DRAFT_RECOVERY_SAVED_MISMATCH')
    // 仍越界时产品按原语义暂停失败：该案不是 passed，整组不通过。
    const paused = condensed()
    paused[3].status = 'failed'
    failure(paused, 'CANDIDATE_OPERATION_MISSING')
    // 正式效果只能在末次压缩；首稿不得带效果、压缩不得缺效果。
    for (const [ordinal, value] of [[0, true], [1, false]]) {
      const changed = condensed()
      changed[3].ownerTerminal.find(item => item.attemptId === '3-draft-' + ordinal).hasFormalEffect = value
      failure(changed, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    }
    // 第二次压缩、续写冒充压缩、首请求不是 chapter-draft、提取操作多一次，都拒绝。
    const twice = condensed()
    // 新 run 的下标 0/1 分别为首稿与压缩。
    const extra = structuredClone(twice[3].attempts[1])
    extra.attemptId = 'candidate:3-draft-2'; extra.binding.actual.attemptId = '3-draft-2'
    twice[3].attempts.push(extra)
    twice[3].ownerTerminal.push({ ...twice[3].ownerTerminal[1], attemptId: '3-draft-2' })
    twice[3].syntheticDispatches = 3
    failure(twice, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    for (const [ordinal, purpose] of [[1, 'chapter-draft-continuation'], [0, 'chapter-draft-condense']]) {
      const changed = condensed()
      changed[3].attempts[ordinal].binding.actual.purpose = purpose
      changed[3].ownerTerminal[ordinal].purpose = purpose
      failure(changed, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    }
    const notes = continuityResults(dir)
    const notesExtra = structuredClone(notes[0].attempts[0])
    notesExtra.attemptId = 'candidate:0-notes-extra'; notesExtra.binding.actual.attemptId = '0-notes-extra'
    notesExtra.binding.actual.purpose = 'chapter-draft-condense'
    notes[0].attempts.splice(1, 0, notesExtra)
    notes[0].ownerTerminal.splice(1, 0, { ...notes[0].ownerTerminal[0], attemptId: '0-notes-extra', purpose: 'chapter-draft-condense' })
    notes[0].syntheticDispatches += 1
    failure(notes, 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH')
    // 压缩是普通可记账物理 attempt：调用计数必须包含它。
    const uncounted = condensed()
    uncounted[3].syntheticDispatches = 1
    failure(uncounted, 'PHYSICAL_CALL_COUNT_MISMATCH')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('C17-B 重新定稿后处理：notes/cards 绑定替换后的新 finalizationId，attempt 记账含 cards 原生 repair', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/c17b-post-process-test-'))
  try {
    const check = (results, expected, message, mode = 'synthetic') => assert.deepEqual(validateCandidateContinuityResults(results, mode), expected, message)
    const failure = code => ({ status: 'failed', candidateFailure: code })
    check(continuityResults(dir), { status: 'passed' })
    check(continuityResults(dir, { mode: 'real', proposed: false, authorProtected: false }), { status: 'pending-independent-oracle-review' }, 'real', 'real')
    // 案例 operation 与登记不符：C17-B 缺后处理即拒绝。
    const missing = continuityResults(dir)
    missing[4].operations = missing[4].operations.filter(item => item.kind === 'draft')
    check(missing, failure('CANDIDATE_OPERATION_MISMATCH'))
    // 后处理正式效果缺失、步骤不全，或来源仍是替换前的旧 finalizationId，都失败。
    for (const [mutate, code] of [
      [evidence => { evidence.derivedApplied = false }, 'FINALIZATION_EFFECT_MISSING'],
      [evidence => { evidence.effects = [{ stepKey: 'chapter_notes' }] }, 'FINALIZATION_EFFECT_MISSING'],
      [evidence => { evidence.effects.reverse() }, 'FINALIZATION_EFFECT_MISSING'],
      [evidence => { delete evidence.idempotent }, 'FINALIZATION_EFFECT_MISSING'],
      [evidence => {
        evidence.source = { draftId: 3, finalizationId: 'finalization-before-4', chapterNumber: 1, contentHash: hash('content-before-4') }
        evidence.notesReadback = { ...evidence.notesReadback, draftId: 3, sourceFinalizationId: 'finalization-before-4' }
        evidence.cardsReadback.sourceFinalizationId = 'finalization-before-4'
      }, 'FINALIZATION_SOURCE_NOT_BOUND'],
      [evidence => { evidence.notesReadback.sourceFinalizationId = 'finalization-before-4' }, 'FINALIZATION_SOURCE_NOT_BOUND'],
      [evidence => { evidence.notesReadback.draftId = 3 }, 'FINALIZATION_SOURCE_NOT_BOUND'],
      [evidence => { delete evidence.notesReadback.chapterNotesHash }, 'FINALIZATION_SOURCE_NOT_BOUND'],
      [evidence => { evidence.notesReadback.sourceStatus = 'stale' }, 'FINALIZATION_SOURCE_NOT_BOUND'],
      [evidence => { evidence.notesReadback.sourceContentHash = hash('content-before-4') }, 'FINALIZATION_SOURCE_NOT_BOUND'],
      [evidence => { evidence.cardsReadback.sourceFinalizationId = null }, 'FINALIZATION_SOURCE_NOT_BOUND'],
      [evidence => { delete evidence.source.contentHash }, 'FINALIZATION_SOURCE_NOT_BOUND'],
    ]) {
      const results = continuityResults(dir)
      mutate(results[4].finalizationEvidence)
      check(results, failure(code))
    }
    const noEvidence = continuityResults(dir)
    delete noEvidence[4].finalizationEvidence
    check(noEvidence, failure('FINALIZATION_EFFECT_MISSING'))
    // 同一规则也约束 C16-C：后处理必须绑定该案重新定稿后的来源。
    const c16c = continuityResults(dir)
    c16c[2].sourceReplacement.after = { ...c16c[2].sourceReplacement.after, finalizationId: 'other-finalization' }
    check(c16c, failure('FINALIZATION_SOURCE_NOT_BOUND'))
    const unreplaced = continuityResults(dir)
    unreplaced[4].restoration.sourceReplacement.before.finalizationId = unreplaced[4].restoration.sourceReplacement.after.finalizationId
    check(unreplaced, failure('FINALIZATION_SOURCE_NOT_BOUND'))
    // cards 原生 repair：同 operation 至多三次、repair 用途序号、只有末次带正式效果、物理计数含 repair。
    const repaired = (count, mode = 'synthetic') => {
      const results = continuityResults(dir, { mode, proposed: mode === 'synthetic', authorProtected: mode === 'synthetic' })
      const result = results[4], operation = '恢复副本重新定稿角色状态'
      const base = result.attempts.findIndex(attempt => attempt.binding.operation === operation)
      for (let ordinal = 1; ordinal < count; ordinal++) {
        const attempt = structuredClone(result.attempts[base])
        const attemptId = `4-character_cards-${ordinal}`, purpose = `finalized-character-state:repair:${ordinal}`
        const output = `repair ${ordinal}`
        fs.writeFileSync(path.join(dir, `${attemptId}.txt`), output)
        Object.assign(attempt, { attemptId: `candidate:${attemptId}`, outputPath: path.join(dir, `${attemptId}.txt`), visibleTextHash: hash(output) })
        Object.assign(attempt.binding.actual, { attemptId, purpose })
        result.attempts.splice(base + ordinal, 0, attempt)
        result.ownerTerminal.splice(base + ordinal, 0, { attemptId, artifactId: `artifact-${attemptId}`, textHash: hash(output), purpose,
          finishReason: 'stop', hasFormalEffect: true })
      }
      result.ownerTerminal.filter(item => item.attemptId.startsWith('4-character_cards-'))
        .forEach((item, index, all) => { item.hasFormalEffect = index === all.length - 1 })
      if (mode === 'real') result.physicalModelRequests = result.attempts.length
      else result.syntheticDispatches = result.attempts.length
      return results
    }
    check(repaired(2), { status: 'passed' })
    check(repaired(3), { status: 'passed' })
    check(repaired(3, 'real'), { status: 'pending-independent-oracle-review' }, 'real repairs', 'real')
    assert.equal(repaired(3, 'real')[4].attempts.length, 5, 'notes 1 + cards 3 + draft 1')
    check(repaired(4), failure('TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH'))
    const earlyEffect = repaired(2)
    earlyEffect[4].ownerTerminal.find(item => item.attemptId === '4-character_cards-0').hasFormalEffect = true
    check(earlyEffect, failure('ACTUAL_OWNER_IDENTITY_MISMATCH'))
    const badPurpose = repaired(2)
    badPurpose[4].attempts.find(attempt => attempt.attemptId === 'candidate:4-character_cards-1').binding.actual.purpose = 'finalized-character-state:repair:2'
    badPurpose[4].ownerTerminal.find(item => item.attemptId === '4-character_cards-1').purpose = 'finalized-character-state:repair:2'
    check(badPurpose, failure('ACTUAL_OWNER_IDENTITY_MISMATCH'))
    const uncounted = repaired(2)
    uncounted[4].syntheticDispatches -= 1
    check(uncounted, failure('PHYSICAL_CALL_COUNT_MISMATCH'))
    const extraNotes = continuityResults(dir)
    const notesAttempt = structuredClone(extraNotes[4].attempts[0])
    notesAttempt.attemptId = 'candidate:4-chapter_notes-extra'; notesAttempt.binding.actual.attemptId = '4-chapter_notes-extra'
    extraNotes[4].attempts.splice(1, 0, notesAttempt)
    extraNotes[4].ownerTerminal.splice(1, 0, { ...extraNotes[4].ownerTerminal[0], attemptId: '4-chapter_notes-extra', hasFormalEffect: false })
    extraNotes[4].syntheticDispatches += 1
    check(extraNotes, failure('TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH'))
    // 后处理 attempt 必须在恢复副本的项目内：派发到原项目即失败。
    const oldProject = continuityResults(dir)
    oldProject[4].attempts[0].binding.actual.projectId = 'project-source'
    check(oldProject, failure('ACTUAL_OWNER_IDENTITY_MISMATCH'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  // 桥侧接线：恢复副本重新定稿后，登记的后处理 operation 走 C16 同一 RunFinalizePostProcessCommand，
  // 其来源必须等于替换后的新来源，并按生产 IPC 回读 notes 投影与 cards provenance 落盘。
  const fixture = fixtureSource()
  assert.match(fixture, /continuityRun && \['chapter_notes', 'character_cards'\]\.includes\(operationKind\)\) \{\s*const predecessor = predecessorReadbacks\.find\(item => item\.required\)[^\n]*\n[^\n]*\n\s*if \(restorationKind\) assert\.ok\(receipt\.restoration\?\.sourceReplacement, 'RESTORED_POST_PROCESS_WITHOUT_REFINALIZE'\)\s*const readback = await invoke\('db:continuity-read-source', predecessor\.draftId/)
  // C17-B 首个 operation 是后处理：恢复类型必须取自本案唯一续写 operation，否则会整段跳过恢复（开发合成曾实测复现）。
  assert.match(fixture, /const restorationKinds = continuityRun \? \[\.\.\.new Set\(request\.operations\.flatMap\(operation => operation\.restore \? \[operation\.restore\] : \[\]\)\)\] : \[\]/)
  assert.doesNotMatch(fixture, /request\.operations\[0\]\?\.restore/)
  assert.match(fixture, /\.RunFinalizePostProcessCommand\(\{/)
  assert.match(fixture, /sourceLabel: receipt\.restoration\?\.sourceReplacement \? 'quality-c17b-refinalize' : 'quality-c16-existing'/)
  assert.match(fixture, /if \(replacement\) assert\.deepEqual\(slot\.source, replacement\.after, 'POST_PROCESS_SOURCE_NOT_REPLACEMENT'\)/)
  assert.match(fixture, /invoke\('db:continuity-list-before', chapter\.number, project\.rootPath, session\)/)
  assert.match(fixture, /projection\.sourceStatus === 'current'\s*&& projection\.source\?\.finalizationId === slot\.source\.finalizationId\s*&& projection\.source\.contentHash === slot\.source\.contentHash, 'DERIVED_NOTES_NOT_BOUND_TO_SOURCE'/)
  assert.match(fixture, /sourceFinalizationId: provenance\?\.source\?\.finalizationId \?\? null/)
  // refinalize 本身只提交定稿，harness 不重写后处理：后处理只由登记 operation 经产品命令执行。
  const refinalize = fixture.slice(fixture.indexOf('const refinalize = async'), fixture.indexOf('const prompts = await load'))
  assert.doesNotMatch(refinalize, /RunFinalizePostProcessCommand|finalization-generation/)
  const driver = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-driver.mjs'), 'utf8')
  assert.match(driver, /const operations = continuityCaseOperations\(item\.id\)/)
  assert.match(driver, /postProcess\.length !== \(item\.sourceSuffix \? 2 : 0\)/)
})

test('C16–C18 恢复案例只以授权标识调用恢复 IPC：harness 授权与选择器同一 owner，baseline 臂不经过恢复', async () => {
  const fixture = fixtureSource()
  // 行为：取夹具里真实的授权签发器源码，对真实授权 owner 生效（进程内 harness 没有 dialog，不能走选择器）。
  const sandbox = {}
  vm.runInNewContext(`${fixture.slice(fixture.indexOf('const restoreGrantIssuer ='), fixture.indexOf("test('isolated production commands"))}
this.restoreGrantIssuer = restoreGrantIssuer`, sandbox)
  const { ExternalFileGrantService } = await import('../../electron/services/external-file-grant-service.ts')
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/restore-grant-test-'))
  try {
    const service = new ExternalFileGrantService()
    const grantFor = sandbox.restoreGrantIssuer(service, 701)
    const resolve = (grantId, operation, webContentsId = 701) => service.resolveExactPath({ grantId, webContentsId, operation })
    const canonicalDir = fs.realpathSync.native(dir)
    // 导出目标是尚不存在的子项：create 授权精确解析回「规范父目录 + 子项名」，且只能用一次。
    const archive = path.join(dir, 'source.ainovel')
    const exportGrant = grantFor('create', archive)
    assert.equal(resolve(exportGrant, 'create'), path.join(canonicalDir, 'source.ainovel'))
    assert.throws(() => resolve(exportGrant, 'create'), /授权/)
    // 归档读取授权要求文件已存在：导出之前签发必失败，导出之后才成立；它不能被换成写入用途或他窗口使用。
    assert.throws(() => grantFor('read', archive), /ENOENT/)
    fs.writeFileSync(archive, 'archive bytes')
    const readGrant = grantFor('read', archive)
    assert.throws(() => resolve(readGrant, 'create'), /未授予/)
    assert.throws(() => resolve(readGrant, 'read', 702), /不属于当前窗口/)
    assert.equal(resolve(readGrant, 'read'), path.join(canonicalDir, 'source.ainovel'))
    // 恢复目标同样是尚不存在的子项；已被占用的目录不会因此被授权覆盖之外的任何位置。
    const targetRoot = path.join(dir, 'c17-a')
    assert.equal(resolve(grantFor('create', targetRoot), 'create'), path.join(canonicalDir, 'c17-a'))
    assert.equal(fs.existsSync(targetRoot), false, '签发授权不得创建目标')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  // 接线：四条生产 IPC 只携带授权标识；原始路径形状（生产控制器会拒绝）不再出现在夹具里。
  assert.match(fixture, /const \{ externalFileGrants \} = await load\('electron\/services\/external-file-grant-service\.ts'\)\s*const grantFor = restoreGrantIssuer\(externalFileGrants, sender\.id\)/)
  assert.match(fixture, /invoke\('project:archive-export', \{ projectSession: session, targetArchiveGrantId: grantFor\('create', archivePath\) \}\)/)
  assert.match(fixture, /invoke\('project:archive-restore', \{ archiveGrantId: grantFor\('read', archivePath\), targetGrantId: grantFor\('create', targetProjectRoot\) \}\)/)
  assert.match(fixture, /invoke\('cloud-backup:restore-copy', \{[^}]*targetGrantId: grantFor\('create', targetProjectRoot\)[^}]*\}\)/)
  assert.doesNotMatch(fixture, /targetArchivePath|\barchivePath,|(?<![.\w])targetProjectRoot\s*[,:]/)
  // 断言不放宽：恢复出的目标必须正是授权解析出的「规范父目录 + 子项名」，来源项目与新身份检查照旧。
  assert.match(fixture, /const grantedTargetRoot = path\.join\(fs\.realpathSync\.native\(path\.dirname\(targetProjectRoot\)\), path\.basename\(targetProjectRoot\)\)/)
  assert.match(fixture, /assert\.equal\(restored\.receipt\.targetProjectRoot, grantedTargetRoot, 'RESTORE_TARGET_MISMATCH'\)/)
  assert.match(fixture, /assert\.equal\(restored\.receipt\.originProjectId, origin\.projectId, 'RESTORE_ORIGIN_MISMATCH'\)/)
  assert.match(fixture, /assert\.equal\(path\.dirname\(targetProjectRoot\), path\.resolve\(target\.roots\.project\), 'RESTORE_OUTSIDE_TARGET_ROOT'\)/)
  assert.match(fixture, /assert\.notEqual\(project\.projectId, origin\.projectId, 'RESTORE_IDENTITY_REUSED'\)/)
  // baseline 臂不经过恢复调用：c16-c18 只对 candidate 派发 execute，桥内断言 candidate，恢复类型只在 continuityRun 内取得。
  const driver = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-driver.mjs'), 'utf8')
  assert.match(driver, /runProductionBridge\(\{ \.\.\.common, caseId: item\.id, target: executionTargets\.candidate, action: 'execute'/)
  assert.match(fixture, /if \(continuityRun\) \{\s*assert\.equal\(candidate, true, 'CANDIDATE_REQUIRED'\)/)
  assert.match(fixture, /const restorationKinds = continuityRun \? /)
})

test('C17-B 替换后前驱：readback 与 parity 记录续写实际纳入的新来源，替换前另存，且与 materialDecision 一致', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/c17b-predecessor-test-'))
  try {
    const failure = { status: 'failed', candidateFailure: 'PREDECESSOR_AFTER_REPLACEMENT_MISMATCH' }
    const check = (results, expected, message) => assert.deepEqual(validateCandidateContinuityResults(results, 'synthetic'), expected, message)
    const passing = continuityResults(dir)
    check(passing, { status: 'passed' })
    const [required] = passing[4].physicalProject.readback.predecessors
    assert.equal(required.sourceId, `finalized:${passing[4].restoration.sourceReplacement.draftId}`)
    assert.notEqual(passing[4].restoration.parityHashBeforeReplacement, passing[4].physicalProject.parityHash)
    const reparity = result => {
      result.physicalProject.parityHash = hash(result.physicalProject.readback)
      for (const attempt of result.attempts) attempt.binding.parityId = result.physicalProject.parityHash
    }
    const draftAttempt = result => result.attempts.find(attempt => attempt.binding.actual.purpose === 'chapter-draft')
    const mutations = [
      // 原缺陷：readback 仍是替换前的 finalized:3（即使 parity 自洽也拒绝）。
      result => { result.physicalProject.readback = { ...result.physicalProject.readback, predecessors: result.restoration.predecessorsBeforeReplacement }; reparity(result) },
      result => { result.physicalProject.readback.predecessors[0].revision = 3; reparity(result) },
      result => { result.physicalProject.readback.predecessors[0].version = 2; reparity(result) },
      result => { result.physicalProject.readback.predecessors[0].contentHash = hash('原定稿'); reparity(result) },
      result => { result.physicalProject.readback.predecessors[0].persistedBytes += 1; reparity(result) },
      result => { result.physicalProject.readback.predecessors.push({ ...result.physicalProject.readback.predecessors[0], sourceId: 'finalized:99' }); reparity(result) },
      // readback 被改写但 parityHash 未随之更新：parity 绑定不放宽。
      result => { result.physicalProject.readback.semanticHash = hash('other') },
      result => { delete result.restoration.predecessorsBeforeReplacement },
      result => { result.restoration.predecessorsBeforeReplacement = result.physicalProject.readback.predecessors },
      result => { result.restoration.parityHashBeforeReplacement = result.physicalProject.parityHash },
      result => { delete result.restoration.parityHashBeforeReplacement },
      // 续写 materialDecision 未纳入 readback 记录的来源或 revision。
      result => { draftAttempt(result).optionalMaterialEvidence.materialDecision.included[0].sourceId = 'finalized:3' },
      result => { draftAttempt(result).optionalMaterialEvidence.materialDecision.included[0].revision = 3 },
      result => { delete draftAttempt(result).optionalMaterialEvidence },
    ]
    for (const [index, mutate] of mutations.entries()) {
      const results = continuityResults(dir)
      mutate(results[4])
      check(results, failure, `mutation ${index}`)
    }
    // 其他恢复案同样要求 readback 必需前驱与续写实际纳入的来源一致。
    const c18 = continuityResults(dir)
    c18[5].attempts[0].optionalMaterialEvidence.materialDecision.included = []
    check(c18, failure)
    // 登记的唯一压缩 attempt 也须纳入同一来源。
    const { syntheticDraftText } = syntheticLengthHelpers()
    const condensed = continuityResults(dir, { condensedIndex: 4, primaryText: syntheticDraftText(countDraftUnits, C17_RANGE.maximum + 60) })
    check(condensed, { status: 'passed' })
    condensed[4].attempts.at(-1).optionalMaterialEvidence.materialDecision.included[0].sourceId = 'finalized:3'
    check(condensed, failure)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  // 桥侧：替换后按同一 parityPredecessors 重算 readback 与 parity，替换前原样另存，其后 dispatch 绑定新 parity。
  const fixture = fixtureSource()
  assert.match(fixture, /receipt\.restoration\.predecessorsBeforeReplacement = sourceParity\.predecessors\s*receipt\.restoration\.parityHashBeforeReplacement = request\.parityHash\s*sourceParity = \{ \.\.\.sourceParity, predecessors: parityPredecessors\(predecessorReadbacks\) \}\s*request\.parityHash = sha\(sourceParity\)\s*receipt\.physicalProject = \{ \.\.\.receipt\.physicalProject, parityHash: request\.parityHash, readback: sourceParity \}/)
  assert.match(fixture, /predecessors: parityPredecessors\(predecessorReadbacks\),\s*semanticHash: sha\(source\)/)
  assert.ok(fixture.indexOf('receipt.restoration.predecessorsBeforeReplacement') < fixture.indexOf('const physicalFetch = async'), 'PARITY_REBOUND_BEFORE_ANY_DISPATCH')
})

test('c16-c18 v7 专用定稿拒绝旧revision，保留非连续性阶段前情及更正链', () => {
  const fixture = fixtureSource()
  const start = fixture.indexOf('  const continuitySource =')
  const end = fixture.indexOf('  const scene =', start)
  const select = new Function('source', 'request', 'continuityRun', 'assert', `${fixture.slice(start, end)}\nreturn continuitySource`)
  const current = PHASE_SCENARIOS['c16-c18'].scenarioRevision
  const selected = select(source, { scenarioRevision: current }, true, assert)
  assert.equal(selected, source.continuityQualificationCases[0].finalizedSource)
  const matchStart = fixture.indexOf('            const matches = identity.characters.filter')
  const matchEnd = fixture.indexOf('            if (finalizedCharacterId)', matchStart)
  const targetId = new Function('identity', 'continuitySource', 'assert', `${fixture.slice(matchStart, matchEnd)}\nreturn matches[0].characterId`)
  const identity = { content: selected.content, characters: source.scenes[0].characters.map((name, index) => ({
    characterId: `stable-${index}`, displayNameSnapshot: name })) }
  assert.equal(targetId(identity, selected, assert), 'stable-0')
  assert.throws(() => targetId({ ...identity, characters: identity.characters.slice(1) }, selected, assert), /FINALIZATION_TARGET_CHARACTER_AMBIGUOUS/)
  for (const fact of ['同日午后', '缺少通行许可', '六枚铜币预约费已被扣除', '不予退还',
    '铜钥匙始终由林澄保管', '雨停前沈岸不知道信封内有地图', '现场核查尚未开始', '原因仍未查明']) assert.ok(selected.content.includes(fact))
  for (const revision of ['c16-c18-candidate-production-path-v6', undefined])
    assert.throws(() => select(source, { scenarioRevision: revision }, true, assert), /CONTINUITY_SOURCE_REVISION_MISMATCH/)
  assert.equal(select(source, { scenarioRevision: current }, false, assert), null)
  assert.equal(source.scenes[0].authorPredecessor, '作者提供的前情：档案员林澄在清晨发现记录上的日期与旧钟不符，决定到现场核查；尚未核查成功。')
  const byId = id => source.continuityQualificationCases.find(item => item.id === id)
  assert.equal(byId('C16-C').sourceSuffix, '林澄更正记录：核查仍未开始，原定安排等待雨停。')
  assert.equal(byId('C17-B').sourceSuffix, '恢复副本的作者更正：林澄撤回先前核查安排，等待新的通行许可。')
})

test('c16-c18 v7 场景沿用有界恢复、条件作者保护与 C17-B 重新定稿后处理；历史 v1–v6 与任何放宽都拒绝', () => {
  const selection = selectPhase(protocol, 'c16-c18', 'final')
  const scenario = PHASE_SCENARIOS['c16-c18']
  assert.equal(selection.scenarioRevision, 'c16-c18-candidate-production-path-v7')
  assert.match(selection.stopPolicy.repair, /新run不再调用或注入生成前对账/)
  assert.match(selection.stopPolicy.attemptAccounting, /历史对账仍按原登记读取/)
  assert.match(selection.caseOracles['C17-B'].automatic[0], /RunFinalizePostProcessCommand对新finalizationId重新生成/)
  assert.match(selection.caseOracles['C17-B'].automatic[1], /predecessorsBeforeReplacement/)
  assert.match(selection.stopPolicy.repair, /含C17-B恢复副本重新定稿角色状态/)
  assert.match(selection.stopPolicy.technicalFailure, /12次最小路径/)
  assert.match(selection.caseOracles['C16-B'].automatic[0], /未提议时记authorProtection=untriggered/)
  assert.match(selection.caseOracles['C16-B'].automatic[0], /合成transport必提议冲突值，仍须有候选/)
  assert.deepEqual(selection.attemptPolicy, C16_C18_ATTEMPT_POLICY)
  assert.equal(scenario.attemptPolicy, C16_C18_ATTEMPT_POLICY)
  assertScenarioMatchesProtocol(selection, scenario, semanticPath)
  assert.match(selection.stopPolicy.repair, /唯一一次chapter-draft-condense/)
  assert.match(selection.stopPolicy.repair, /不获新的重试权/)
  assert.match(selection.stopPolicy.attemptAccounting, /登记的唯一压缩/)
  for (const mutate of [
    value => { value.scenarioRevision = 'c16-c18-candidate-production-path-v1' },
    value => { value.scenarioRevision = 'c16-c18-candidate-production-path-v2' },
    value => { value.scenarioRevision = 'c16-c18-candidate-production-path-v3' },
    value => { value.scenarioRevision = 'c16-c18-candidate-production-path-v4' },
    value => { value.scenarioRevision = 'c16-c18-candidate-production-path-v5' },
    value => { value.scenarioRevision = 'c16-c18-candidate-production-path-v6' },
    value => { delete value.attemptPolicy },
    value => { value.attemptPolicy.draftReconcile = { purpose: 'chapter-draft-reconcile', maxReconcileAttempts: 1 } },
    value => { value.attemptPolicy.draftCondense.maxCondenseAttempts = 2 },
    value => { value.attemptPolicy.draftCondense.operationIds.push('定稿章节要点') },
    value => { value.attemptPolicy.draftCondense.condensePurpose = 'chapter-draft-continuation' },
    value => { value.attemptPolicy.draftCondense.formalEffect = 'any-attempt' },
    value => { value.attemptPolicy.arms.push('baseline') },
  ]) {
    const changed = structuredClone(selection)
    mutate(changed)
    assert.throws(() => assertScenarioMatchesProtocol(changed, scenario, semanticPath), /SCENARIO_PROTOCOL_MISMATCH/)
    // 生产桥入口在建任何目录前同样逐字比对。
    assert.throws(() => runProductionPhasePair({}, { phase: 'c16-c18', scenarioRevision: changed.scenarioRevision,
      attemptPolicy: changed.attemptPolicy ?? null }), /SCENARIO_PROTOCOL_MISMATCH/)
  }
  // 其他阶段的策略保持原样：early-review 仍没有额外尝试权，early-budget 仍只有原两类修复（full v2 的压缩登记见其专门测试）。
  assert.equal(PHASE_SCENARIOS['early-review'].attemptPolicy, undefined)
  assert.deepEqual(Object.keys(PHASE_SCENARIOS['early-budget'].attemptPolicy).sort(),
    ['arms', 'maxRepairAttempts', 'milestone', 'operationId', 'primaryPurpose', 'repairPurpose', 'reviewRebuild'])
})

test('C16-B 作者保护按正式产物是否提议改写而条件判定：真实未触发可过，提议无候选、证据缺失或畸形均失败，合成仍强制候选', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/author-protection-test-'))
  try {
    const check = (results, mode, expected, message) => assert.deepEqual(validateCandidateContinuityResults(results, mode), expected, message)
    const missing = { status: 'failed', candidateFailure: 'CONTINUITY_CASE_EVIDENCE_MISSING' }
    const pending = { status: 'pending-independent-oracle-review' }
    // 真实模式：模型正式输出未提议改写 mentalState → untriggered，不因缺冲突候选失败。
    check(continuityResults(dir, { mode: 'real', proposed: false, authorProtected: false }), 'real', pending)
    check(continuityResults(dir, { mode: 'real', proposed: false, authorProtected: true }), 'real', pending)
    // 真实模式：提议了不同值 → 必须存在冲突候选。
    check(continuityResults(dir, { mode: 'real', proposed: true, authorProtected: true }), 'real', pending)
    check(continuityResults(dir, { mode: 'real', proposed: true, authorProtected: false }), 'real', missing)
    // 合成模式：transport 必提议冲突值，未提议或无候选都失败。
    check(continuityResults(dir), 'synthetic', { status: 'passed' })
    check(continuityResults(dir, { proposed: false, authorProtected: true }), 'synthetic', missing)
    check(continuityResults(dir, { proposed: true, authorProtected: false }), 'synthetic', missing)
    check(continuityResults(dir, { proposed: false, authorProtected: false }), 'synthetic', missing)
    // 证据缺失或畸形一律 fail closed：真实模式也必须显式携带绑定正式 attempt 的 proposed=true/false。
    const mutations = [
      evidence => { delete evidence.authorProtection },
      evidence => { evidence.authorProtection = null },
      evidence => { delete evidence.authorProtection.proposed },
      evidence => { evidence.authorProtection.proposed = 'false' },
      evidence => { evidence.authorProtection.status = 'triggered' },
      evidence => { evidence.authorProtection.status = 'unknown' },
      evidence => { evidence.authorProtection.field = 'recentEvents' },
      evidence => { evidence.authorProtection.authorValue = '决定核查' },
      evidence => { delete evidence.authorProtection.derivation },
      evidence => { evidence.authorProtection.derivation = 'free-text' },
      evidence => { delete evidence.authorProtection.formalAttemptId },
      evidence => { evidence.authorProtection.formalAttemptId = '1-chapter_notes-0' },
      evidence => { evidence.authorProtection.ownerArtifactHash = hash('other') },
      evidence => { delete evidence.authorProtected },
      evidence => { evidence.authorProtected = 'true' },
    ]
    for (const [index, mutate] of mutations.entries()) {
      const results = continuityResults(dir, { mode: 'real', proposed: false, authorProtected: false })
      mutate(results[1].finalizationEvidence)
      check(results, 'real', missing, `mutation ${index}`)
    }
    // 绑定的必须是末次正式 attempt：cards 有一次被取代的前序 attempt 时，指向它即失败。
    const repaired = continuityResults(dir, { mode: 'real', proposed: false, authorProtected: false })
    const earlier = structuredClone(repaired[1].attempts[1])
    earlier.attemptId = 'candidate:1-character_cards-pre'; earlier.binding.actual.attemptId = '1-character_cards-pre'
    repaired[1].attempts.splice(1, 0, earlier)
    repaired[1].ownerTerminal.splice(1, 0, { ...repaired[1].ownerTerminal[1], attemptId: '1-character_cards-pre', hasFormalEffect: false })
    repaired[1].physicalModelRequests += 1
    repaired[1].attempts[2].binding.actual.purpose = 'finalized-character-state:repair:1'
    repaired[1].ownerTerminal[2].purpose = 'finalized-character-state:repair:1'
    check(repaired, 'real', pending)
    repaired[1].finalizationEvidence.authorProtection.formalAttemptId = '1-character_cards-pre'
    check(repaired, 'real', missing)
    // 正式产物文件缺失即失败（字节被改写由既有 owner 核对先行拒绝）。
    const noFile = continuityResults(dir, { mode: 'real', proposed: false, authorProtected: false })
    fs.rmSync(noFile[1].attempts.find(attempt => attempt.binding.operation === '定稿角色状态').outputPath)
    check(noFile, 'real', missing)
    const tampered = continuityResults(dir, { mode: 'real', proposed: false, authorProtected: false })
    fs.appendFileSync(tampered[1].attempts.find(attempt => attempt.binding.operation === '定稿角色状态').outputPath, '改')
    assert.equal(validateCandidateContinuityResults(tampered, 'real').status, 'failed')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  // 桥侧：proposed 只由末次正式 attempt 的 hash 可复核 owner 产物经生产解析器得出；作者值保全断言对全部模式不变。
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  assert.match(fixture, /assert\.equal\(character\?\.currentState\?\.mentalState, '谨慎', 'AUTHOR_STATE_OVERWRITTEN'\)/)
  assert.match(fixture, /const formal = receipt\.attempts\.filter\(attempt => attempt\.binding\.operation === operationId\)\.at\(-1\)/)
  assert.match(fixture, /JSON\.parse\(formalRow\.usage_receipt_json\)\.finalizationEffect/)
  assert.match(fixture, /sha\(formalText\) === formal\.visibleTextHash && sha\(fs\.readFileSync\(formal\.outputPath, 'utf8'\)\) === formal\.visibleTextHash/)
  assert.match(fixture, /parseFinalizedCharacterStateResponse\(formalText, finalizedContext\.identity\)\.updates/)
  assert.match(fixture, /if \(request\.mode === 'synthetic'\) \{\s*assert\.equal\(proposed, true, 'SYNTHETIC_AUTHOR_CONFLICT_NOT_PROPOSED'\)\s*assert\.equal\(receipt\.finalizationEvidence\.authorProtected, true, 'AUTHOR_CONFLICT_CANDIDATE_MISSING'\)/)
})

test('C16 c9b88510/d8a30c11 段（第508–579行）按 ccc70b31 规则分两段加性登记，链在其后且真实账本只读回放', () => {
  const ccc = protocol.historicalC16Ccc70b31Boundary
  const c9 = protocol.historicalC16C9b88510Boundary, d8 = protocol.historicalC16D8a30c11Boundary
  assert.deepEqual([c9.fromEventCount, c9.eventCount, c9.reserveAttempts.length], [ccc.eventCount, 546, 13])
  assert.deepEqual([d8.fromEventCount, d8.eventCount, d8.reserveAttempts.length], [c9.eventCount, 579, 11])
  assert.equal(d8.rawBytesSha256, 'a695d404f157da070db6e3fddc086dc24f9e631e4166bfd6210c0bf700fc8849')
  for (const [boundary, invocationId, codeSha] of [[c9, 'c9b88510-1c8d-4854-b589-714cf44b2d80', '4fc75f22ce309a445accebe18b0f6389eb326be6'],
    [d8, 'd8a30c11-95a7-46ad-8f22-82113fa95e8b', '5b6f0bf52125bd71cf2127e3af5dfd87af873679']]) {
    assert.equal(boundary.protocolRevision, protocolBinding.protocolRevision)
    assert.equal(boundary.protocolHash, '68722f937b83d518909a9e57cf7a5ef081e8449a56696c6a381fba17542a18e9')
    assert.notEqual(boundary.protocolHash, protocolBinding.protocolHash, '新协议字节必须与被取代的 hash 不同')
    assert.deepEqual(Object.keys(boundary.armBindings), ['candidate'])
    assert.equal(boundary.armBindings.candidate.codeSha, codeSha)
    assert.equal(boundary.armBindings.candidate.parityId, undefined)
    assert.deepEqual([...new Set(boundary.reserveAttempts.map(item => item.invocationId))], [invocationId])
    assert.ok(boundary.reserveAttempts.every(item => item.attemptId.startsWith('candidate:') && item.terminal === 'settle'
      && /^[a-f0-9]{64}$/.test(item.parityId)))
  }
  // 真实账本只读：字节不变，按当前协议全部边界链回放到第579行。
  const porcelain = spawnSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  let ledger = null
  try { ledger = path.join(registeredCampaignWorktree(porcelain.stdout), '.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl') } catch { ledger = null }
  if (ledger && fs.existsSync(ledger)) {
    const before = fs.readFileSync(ledger)
    const raw = before.toString('utf8')
    assert.equal(validateHistoricalSupersessionBoundary(raw, 507, c9), 546)
    assert.equal(validateHistoricalSupersessionBoundary(raw, 546, d8), 579)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 507, d8), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 546, { ...d8,
      armBindings: { candidate: { ...d8.armBindings.candidate, codeSha: c9.armBindings.candidate.codeSha } } }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.equal(validatePhysicalLedger(ledger), path.resolve(ledger))
    assert.ok(fs.readFileSync(ledger).equals(before), 'REAL_LEDGER_MUST_STAY_READ_ONLY')
  }
  // 合成账本：两段依次登记为历史时，其后的当前 reserve 通过；缺第二段则同一段按当前协议被拒。
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/d8a30c11-boundary-'))
  try {
    const file = path.join(dir, 'synthetic-ledger.jsonl')
    const envelope = { campaignId: CAMPAIGN_ID, mode: 'synthetic', phase: 'c16-c18', milestone: 'final', caseId: 'C16-B', operation: '定稿角色状态' }
    const old = { protocolRevision: c9.protocolRevision, protocolHash: c9.protocolHash }
    const segment = (invocationId, codeSha, ids) => {
      const armBindings = { candidate: { codeSha, sourceHash: '6'.repeat(64), driverHash: '3'.repeat(64) } }
      const attempts = ids.map(id => ({ attemptId: `candidate:${id}`, invocationId, terminal: 'settle', parityId: '9'.repeat(64) }))
      const rows = attempts.flatMap(item => [{ type: 'reserve', attemptId: item.attemptId, binding: { ...envelope, arm: 'candidate',
        ...armBindings.candidate, ...old, parityId: item.parityId, invocationId }, allocation: 'C16ExistingExtraction' },
      { type: 'dispatch', attemptId: item.attemptId }, { type: 'settle', attemptId: item.attemptId, finishReason: 'stop' }])
      return { armBindings, attempts, raw: rows.map(JSON.stringify).join('\n') + '\n' }
    }
    const first = segment('c9b88510-1c8d-4854-b589-714cf44b2d80', '4'.repeat(40), ['10af48f4-0000-4000-8000-000000000001'])
    const second = segment('d8a30c11-95a7-46ad-8f22-82113fa95e8b', '5'.repeat(40), ['740dad62-0000-4000-8000-000000000002'])
    const raw = first.raw + second.raw
    const b1 = { fromEventCount: 0, eventCount: 3, rawBytesSha256: hash(first.raw), ...old, armBindings: first.armBindings, reserveAttempts: first.attempts }
    const b2 = { fromEventCount: 3, eventCount: 6, rawBytesSha256: hash(raw), ...old, armBindings: second.armBindings, reserveAttempts: second.attempts }
    assert.equal(validateHistoricalSupersessionBoundary(raw, 0, b1), 3)
    assert.equal(validateHistoricalSupersessionBoundary(raw, 3, b2), 6)
    // 单一 armBindings 无法同时认证两次不同 candidate 代码身份，这正是分两段的原因。
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 0, { ...b1, eventCount: 6, rawBytesSha256: hash(raw),
      reserveAttempts: [...first.attempts, ...second.attempts] }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    const current = { ...envelope, arm: 'candidate', codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(),
      parityId: 'c'.repeat(64), ...currentProtocolBinding(),
      actual: { attemptId: 'a', runId: 'r', rootActionId: 'root', projectId: 'p', epoch: 'e' } }
    fs.writeFileSync(file, raw)
    assert.doesNotThrow(() => updateLedger(file, { type: 'reserve', attemptId: 'after-d8a30c11', binding: current },
      { campaignMode: 'synthetic', historicalC16C9b88510Boundary: b1, historicalC16D8a30c11Boundary: b2 }))
    fs.writeFileSync(file, raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-d8a30c11', binding: current },
      { campaignMode: 'synthetic', historicalC16C9b88510Boundary: b1 }), /PROTOCOL_DRIFT/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-d8a30c11', binding: current },
      { campaignMode: 'synthetic', historicalC16C9b88510Boundary: b1, historicalC16D8a30c11Boundary: { ...b2, fromEventCount: 0 } }),
    /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // 只改首个跨行接缝：以定位+切片代替对含换行字面量的 String.replace（语义不变）。
    const seam = '"stop"}\n{"type":"reserve"', seamAt = raw.indexOf(seam)
    assert.ok(seamAt >= 0)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw.slice(0, seamAt) + '"length"}\n{"type":"reserve"' + raw.slice(seamAt + seam.length), 3, b2),
      /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('C16–C18 ca466d9a/73b46513 段（第580–648行）按同一规则分两段加性登记，链在 d8a30c11 后且真实账本只读回放', () => {
  const d8 = protocol.historicalC16D8a30c11Boundary
  const ca = protocol.historicalC16Ca466d9aBoundary, r73 = protocol.historicalC1673b46513Boundary
  assert.deepEqual([ca.fromEventCount, ca.eventCount, ca.reserveAttempts.length], [d8.eventCount, 615, 12])
  assert.deepEqual([r73.fromEventCount, r73.eventCount, r73.reserveAttempts.length], [ca.eventCount, 648, 11])
  assert.equal(ca.rawBytesSha256, '6c9ea5ee59eaa937e0df16d806d879b0a189f60c492b58c4555c732de9b6dc8c')
  assert.equal(r73.rawBytesSha256, 'fb866f35b1071f2b9e098e080709b3c80205793616febe4267a8503404c3d953')
  for (const [boundary, invocationId, codeSha, sourceHash] of [
    [ca, 'ca466d9a-cce5-4a30-a267-2a6d4044409a', 'e797f2d2005cb3a8e95be0c691b4f5b82bb7fc3d', 'd21470d792abc43a9a561e84671c3a5100cf2ca9ac6d34b944e801be0ae593b6'],
    [r73, '73b46513-7371-4d9c-8ca1-671e3fd76349', '2275cdde02fa8cab4fe061f8cedd2b82c1f12b57', 'd352eccc645471a64e7f4e3c7080fc3d2de8f4aded4a6de6d27c7bfd67ac1f58']]) {
    assert.equal(boundary.protocolRevision, protocolBinding.protocolRevision)
    assert.equal(boundary.protocolHash, 'a0a14777420a545f1489f6a202390452d2384f2fbd48832281064d62b453990b')
    assert.notEqual(boundary.protocolHash, protocolBinding.protocolHash, '新协议字节必须与被取代的 hash 不同')
    assert.deepEqual(Object.keys(boundary.armBindings), ['candidate'])
    assert.deepEqual(boundary.armBindings.candidate, { codeSha, sourceHash,
      driverHash: '89e242c9f6e7f0da54b5aa4c297e1ec7159b636567f102f7b95609023472d9bd' })
    assert.deepEqual([...new Set(boundary.reserveAttempts.map(item => item.invocationId))], [invocationId])
    assert.ok(boundary.reserveAttempts.every(item => item.attemptId.startsWith('candidate:') && item.terminal === 'settle'
      && /^[a-f0-9]{64}$/.test(item.parityId)))
  }
  // 真实账本只读：按当前协议全部边界链回放到第648行，字节与 sha256 前后不变。
  const porcelain = spawnSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  let ledger = null
  try { ledger = path.join(registeredCampaignWorktree(porcelain.stdout), '.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl') } catch { ledger = null }
  if (ledger && fs.existsSync(ledger)) {
    const before = fs.readFileSync(ledger)
    const raw = before.toString('utf8')
    assert.equal(validateHistoricalSupersessionBoundary(raw, 579, ca), 615)
    assert.equal(validateHistoricalSupersessionBoundary(raw, 615, r73), 648)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 579, r73), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 615, { ...r73,
      armBindings: { candidate: { ...r73.armBindings.candidate, codeSha: ca.armBindings.candidate.codeSha } } }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.equal(validatePhysicalLedger(ledger), path.resolve(ledger))
    const after = fs.readFileSync(ledger)
    assert.ok(after.equals(before), 'REAL_LEDGER_MUST_STAY_READ_ONLY')
    assert.equal(hash(after), hash(before))
  }
  // 合成账本：d8a30c11 之后两段依次登记为历史时，其后的当前 reserve 通过；缺末段则该段按当前协议被拒。
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/73b46513-boundary-'))
  try {
    const file = path.join(dir, 'synthetic-ledger.jsonl')
    const envelope = { campaignId: CAMPAIGN_ID, mode: 'synthetic', phase: 'c16-c18', milestone: 'final', caseId: 'C17-B', operation: '本地恢复后续写' }
    const old = { protocolRevision: ca.protocolRevision, protocolHash: ca.protocolHash }
    const segment = (invocationId, codeSha, ids) => {
      const armBindings = { candidate: { codeSha, sourceHash: '6'.repeat(64), driverHash: '3'.repeat(64) } }
      const attempts = ids.map(id => ({ attemptId: `candidate:${id}`, invocationId, terminal: 'settle', parityId: '9'.repeat(64) }))
      const rows = attempts.flatMap(item => [{ type: 'reserve', attemptId: item.attemptId, binding: { ...envelope, arm: 'candidate',
        ...armBindings.candidate, ...old, parityId: item.parityId, invocationId }, allocation: 'C17C18RestoreContinue' },
      { type: 'dispatch', attemptId: item.attemptId }, { type: 'settle', attemptId: item.attemptId, finishReason: 'stop' }])
      return { armBindings, attempts, raw: rows.map(JSON.stringify).join('\n') + '\n' }
    }
    const first = segment('ca466d9a-cce5-4a30-a267-2a6d4044409a', 'e'.repeat(40), ['9245845b-0000-4000-8000-000000000001'])
    const second = segment('73b46513-7371-4d9c-8ca1-671e3fd76349', '2'.repeat(40), ['32063b45-0000-4000-8000-000000000002'])
    const raw = first.raw + second.raw
    const b1 = { fromEventCount: 0, eventCount: 3, rawBytesSha256: hash(first.raw), ...old, armBindings: first.armBindings, reserveAttempts: first.attempts }
    const b2 = { fromEventCount: 3, eventCount: 6, rawBytesSha256: hash(raw), ...old, armBindings: second.armBindings, reserveAttempts: second.attempts }
    const current = { ...envelope, arm: 'candidate', codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(),
      parityId: 'c'.repeat(64), ...currentProtocolBinding(),
      actual: { attemptId: 'a', runId: 'r', rootActionId: 'root', projectId: 'p', epoch: 'e' } }
    fs.writeFileSync(file, raw)
    assert.doesNotThrow(() => updateLedger(file, { type: 'reserve', attemptId: 'after-73b46513', binding: current },
      { campaignMode: 'synthetic', historicalC16Ca466d9aBoundary: b1, historicalC1673b46513Boundary: b2 }))
    fs.writeFileSync(file, raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-73b46513', binding: current },
      { campaignMode: 'synthetic', historicalC16Ca466d9aBoundary: b1 }), /PROTOCOL_DRIFT/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-73b46513', binding: current },
      { campaignMode: 'synthetic', historicalC16Ca466d9aBoundary: b1, historicalC1673b46513Boundary: { ...b2, fromEventCount: 0 } }),
    /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // 同一 armBindings 无法同时认证两个 candidate 代码身份，所以按代码身份分两段。
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 0, { ...b1, eventCount: 6, rawBytesSha256: hash(raw),
      reserveAttempts: [...first.attempts, ...second.attempts] }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    const lastTerminal = raw.lastIndexOf('"settle"')
    assert.throws(() => validateHistoricalSupersessionBoundary(raw.slice(0, lastTerminal) + '"unknown"' + raw.slice(lastTerminal + '"settle"'.length), 3, b2),
      /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  // 新协议字节 hash 与被取代的 a0a14777 不同，runner 读写两入口都按链末端取历史范围。
  const runner = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-run.mjs'), 'utf8')
  assert.match(runner, /validateHistoricalSupersessionBoundary\(raw, ca466d9a, protocol\.historicalC1673b46513Boundary\)/)
  assert.match(runner, /const superseded = index >= trustedHistoricalEvents && index < trustedC1670407421Events/)
})

test('新登记续写直接首稿，旧对账可读但当前实验拒绝额外发送', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/direct-draft-result-test-'))
  try {
    assert.equal(C16_C18_ATTEMPT_POLICY.draftReconcile, undefined)
    const current = continuityResults(dir)
    assert.deepEqual(validateCandidateContinuityResults(current, 'synthetic'), { status: 'passed' })
    assert.equal(current.reduce((sum, item) => sum + item.syntheticDispatches, 0), 12)
    assert.deepEqual(summarizeDraftReconciliation(current), [])
    const legacy = continuityResults(dir, { reconcile: true })
    assert.equal(validateCandidateContinuityResults(legacy, 'synthetic').status, 'failed')
    assert.equal(summarizeDraftReconciliation(legacy).length, 4, '历史摘要读取仍保留')
    const gate = createOperationDispatchGate({ finalizationRepair: true })
    assert.throws(() => gate('本地恢复后续写', { attemptId: 'old', runId: 'r', rootActionId: 'root', projectId: 'p', epoch: 'e',
      purpose: 'chapter-draft-reconcile' }), /MODEL_REQUEST_REJECTED/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('C16–C18 fa8806d7 段（第649–690行）按同一规则加性登记，链在 73b46513 后，真实账本只读回放到690且字节不变', () => {
  const r73 = protocol.historicalC1673b46513Boundary, fa = protocol.historicalC16Fa8806d7Boundary
  assert.deepEqual([fa.fromEventCount, fa.eventCount, fa.reserveAttempts.length], [r73.eventCount, 690, 14])
  assert.equal(fa.rawBytesSha256, '1090745ab998f81e04b5d825c1c49135814700bfbd6f4d46504b6a35f9d6ac5c')
  assert.equal(fa.protocolRevision, protocolBinding.protocolRevision)
  assert.equal(fa.protocolHash, '7a17f36a70fcc5df185528c042f536261532f524e19fa5e266f45df4505701a3')
  assert.notEqual(fa.protocolHash, protocolBinding.protocolHash, 'v5 协议字节必须与被取代的 v4 hash 不同')
  assert.deepEqual(fa.armBindings, { candidate: { codeSha: '8a07eb16b91e2d3e12338aac4619804a8e07e860',
    sourceHash: '87cdbbb212ece2cd10bca2d89270dc54c946f9f72ad44d53b95886f848575332',
    driverHash: '014f5770a78104f7ffb92dfe8cae9dba6425066eae729d0517a9daed3ff03350' } })
  assert.deepEqual([...new Set(fa.reserveAttempts.map(item => item.invocationId))], ['fa8806d7-5287-4059-82a0-c1c316396067'])
  assert.ok(fa.reserveAttempts.every(item => item.attemptId.startsWith('candidate:') && item.terminal === 'settle' && /^[a-f0-9]{64}$/.test(item.parityId)))
  const porcelain = spawnSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  let ledger = null
  try { ledger = path.join(registeredCampaignWorktree(porcelain.stdout), '.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl') } catch { ledger = null }
  if (ledger && fs.existsSync(ledger)) {
    const before = fs.readFileSync(ledger)
    const raw = before.toString('utf8')
    assert.equal(validateHistoricalSupersessionBoundary(raw, 648, fa), 690)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 615, fa), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 648, { ...fa,
      armBindings: { candidate: { ...fa.armBindings.candidate, codeSha: r73.armBindings.candidate.codeSha } } }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 648, { ...fa, protocolHash: protocolBinding.protocolHash }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // 整链回放：全部边界自冻结前缀起依次认证到链末端（现为第861行，见 1d0bdac3 段测试）。
    assert.equal(validatePhysicalLedger(ledger), path.resolve(ledger))
    const after = fs.readFileSync(ledger)
    assert.ok(after.equals(before), 'REAL_LEDGER_MUST_STAY_READ_ONLY')
    assert.equal(hash(after), hash(before))
  }
  // 合成账本：73b46513 后接 fa8806d7 段登记为历史时，其后的当前 reserve 通过；缺该段则按当前 v5 协议拒绝。
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/fa8806d7-boundary-'))
  try {
    const file = path.join(dir, 'synthetic-ledger.jsonl')
    const envelope = { campaignId: CAMPAIGN_ID, mode: 'synthetic', phase: 'c16-c18', milestone: 'final', caseId: 'C18-A', operation: 'DAV选定世代恢复后续写' }
    const segment = (invocationId, codeSha, protocolHash, ids) => {
      const armBindings = { candidate: { codeSha, sourceHash: '6'.repeat(64), driverHash: '3'.repeat(64) } }
      const attempts = ids.map(id => ({ attemptId: `candidate:${id}`, invocationId, terminal: 'settle', parityId: '9'.repeat(64) }))
      const rows = attempts.flatMap(item => [{ type: 'reserve', attemptId: item.attemptId, binding: { ...envelope, arm: 'candidate',
        ...armBindings.candidate, protocolRevision: protocolBinding.protocolRevision, protocolHash, parityId: item.parityId, invocationId },
      allocation: 'failedRetryRepairReviewReserve' },
      { type: 'dispatch', attemptId: item.attemptId }, { type: 'settle', attemptId: item.attemptId, finishReason: 'stop' }])
      return { armBindings, attempts, raw: rows.map(JSON.stringify).join('\n') + '\n' }
    }
    const first = segment('73b46513-7371-4d9c-8ca1-671e3fd76349', '2'.repeat(40), r73.protocolHash, ['32063b45-0000-4000-8000-000000000002'])
    const second = segment('fa8806d7-5287-4059-82a0-c1c316396067', '8'.repeat(40), fa.protocolHash, ['20e3ade1-0000-4000-8000-000000000003'])
    const raw = first.raw + second.raw
    const b1 = { fromEventCount: 0, eventCount: 3, rawBytesSha256: hash(first.raw), protocolRevision: r73.protocolRevision,
      protocolHash: r73.protocolHash, armBindings: first.armBindings, reserveAttempts: first.attempts }
    const b2 = { fromEventCount: 3, eventCount: 6, rawBytesSha256: hash(raw), protocolRevision: fa.protocolRevision,
      protocolHash: fa.protocolHash, armBindings: second.armBindings, reserveAttempts: second.attempts }
    const current = { ...envelope, arm: 'candidate', codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(),
      parityId: 'c'.repeat(64), ...currentProtocolBinding(),
      actual: { attemptId: 'a', runId: 'r', rootActionId: 'root', projectId: 'p', epoch: 'e' } }
    fs.writeFileSync(file, raw)
    assert.doesNotThrow(() => updateLedger(file, { type: 'reserve', attemptId: 'after-fa8806d7', binding: current },
      { campaignMode: 'synthetic', historicalC1673b46513Boundary: b1, historicalC16Fa8806d7Boundary: b2 }))
    fs.writeFileSync(file, raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-fa8806d7', binding: current },
      { campaignMode: 'synthetic', historicalC1673b46513Boundary: b1 }), /PROTOCOL_DRIFT/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-fa8806d7', binding: current },
      { campaignMode: 'synthetic', historicalC1673b46513Boundary: b1, historicalC16Fa8806d7Boundary: { ...b2, fromEventCount: 0 } }),
    /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // v4 旧协议 hash 的新 reserve（未登记为历史）一律按当前协议拒绝。
    fs.writeFileSync(file, raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'stale-v4', binding: { ...current, protocolHash: fa.protocolHash } },
      { campaignMode: 'synthetic', historicalC1673b46513Boundary: b1, historicalC16Fa8806d7Boundary: b2 }), /PROTOCOL_DRIFT/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  const runner = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-run.mjs'), 'utf8')
  assert.match(runner, /validateHistoricalSupersessionBoundary\(raw, r73b46513, protocol\.historicalC16Fa8806d7Boundary\)/)
  assert.match(runner, /validateHistoricalSupersessionBoundary\(rawLedger, trusted73b46513Events, fa8806d7Boundary\)/)
})

test('C16–C18 b42cfc55 段（第691–738行）按同一规则加性登记，链在 fa8806d7 后，真实账本只读回放到738且字节不变', () => {
  const fa = protocol.historicalC16Fa8806d7Boundary, b42 = protocol.historicalC16B42cfc55Boundary
  assert.deepEqual([b42.fromEventCount, b42.eventCount, b42.reserveAttempts.length], [fa.eventCount, 738, 16])
  assert.equal(b42.rawBytesSha256, '2aecf9a8bbfad77791eddb4a4015306a3d44967f89a41d858e2d4f8d43ea3e73')
  assert.equal(b42.protocolRevision, protocolBinding.protocolRevision)
  assert.equal(b42.protocolHash, '31f8b204806efa41bd7ebf4faf094fac6ff3e8f4df2a4136472ccee7305a2c5a')
  assert.notEqual(b42.protocolHash, protocolBinding.protocolHash, '登记本段后协议字节必然漂移，须与被取代的 v5 hash 不同')
  assert.deepEqual(b42.armBindings, { candidate: { codeSha: '2f420a38e80e8548fd2827fc39c355d0ea248738',
    sourceHash: '010c1a79aaadab14d9de0005bd7ab8e55c012ec8a5ea1edceeadc2470b22c46d',
    driverHash: 'dbc1cfd85fb54880bb9987a927f574798894e967bffb608917c147f9adbeff92' } })
  assert.deepEqual([...new Set(b42.reserveAttempts.map(item => item.invocationId))], ['b42cfc55-e214-4d51-b4c8-6b6bd2e5ea16'])
  assert.ok(b42.reserveAttempts.every(item => item.attemptId.startsWith('candidate:') && item.terminal === 'settle' && /^[a-f0-9]{64}$/.test(item.parityId)))
  const porcelain = spawnSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  let ledger = null
  try { ledger = path.join(registeredCampaignWorktree(porcelain.stdout), '.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl') } catch { ledger = null }
  if (ledger && fs.existsSync(ledger)) {
    const before = fs.readFileSync(ledger)
    const raw = before.toString('utf8')
    assert.equal(validateHistoricalSupersessionBoundary(raw, 690, b42), 738)
    // 前690行原字节仍是 fa8806d7 段认证的整本账本，本段只加性追加。
    assert.equal(hash(raw.split('\n').slice(0, 690).join('\n') + '\n'), fa.rawBytesSha256)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 648, b42), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    for (const [key, value] of [['codeSha', fa.armBindings.candidate.codeSha], ['sourceHash', fa.armBindings.candidate.sourceHash],
      ['driverHash', fa.armBindings.candidate.driverHash]])
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 690, { ...b42,
        armBindings: { candidate: { ...b42.armBindings.candidate, [key]: value } } }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/, key)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 690, { ...b42, protocolHash: protocolBinding.protocolHash }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 690, { ...b42, reserveAttempts: b42.reserveAttempts.map((item, index) =>
      index === 0 ? { ...item, terminal: 'unknown' } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 690, { ...b42, reserveAttempts: b42.reserveAttempts.map((item, index) =>
      index === 0 ? { ...item, attemptId: 'candidate:wrong' } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 690, { ...b42, reserveAttempts: b42.reserveAttempts.map((item, index) =>
      index === 0 ? { ...item, invocationId: fa.reserveAttempts[0].invocationId } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // 前缀（第1–690行）内任一字节被改，本段的整段前缀 hash 即拒绝。
    const tampered = raw.trimEnd().split('\n')
    tampered[689] = tampered[689].replace('"attemptId":"', '"attemptId":"tampered-')
    assert.throws(() => validateHistoricalSupersessionBoundary(tampered.join('\n') + '\n', 690, b42), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    // 整链回放：全部边界自冻结前缀起依次认证到链末端（现为第861行，见 1d0bdac3 段测试）。
    assert.equal(validatePhysicalLedger(ledger), path.resolve(ledger))
    const after = fs.readFileSync(ledger)
    assert.ok(after.equals(before), 'REAL_LEDGER_MUST_STAY_READ_ONLY')
    assert.equal(hash(after), hash(before))
  }
  // 合成账本：fa8806d7 后接 b42cfc55 段登记为历史时，其后的当前 reserve 通过；缺该段则按当前协议拒绝。
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/b42cfc55-boundary-'))
  try {
    const file = path.join(dir, 'synthetic-ledger.jsonl')
    const envelope = { campaignId: CAMPAIGN_ID, mode: 'synthetic', phase: 'c16-c18', milestone: 'final', caseId: 'C18-A', operation: 'DAV选定世代恢复后续写' }
    const segment = (invocationId, codeSha, protocolHash, ids) => {
      const armBindings = { candidate: { codeSha, sourceHash: '6'.repeat(64), driverHash: '3'.repeat(64) } }
      const attempts = ids.map(id => ({ attemptId: `candidate:${id}`, invocationId, terminal: 'settle', parityId: '9'.repeat(64) }))
      const rows = attempts.flatMap(item => [{ type: 'reserve', attemptId: item.attemptId, binding: { ...envelope, arm: 'candidate',
        ...armBindings.candidate, protocolRevision: protocolBinding.protocolRevision, protocolHash, parityId: item.parityId, invocationId },
      allocation: 'failedRetryRepairReviewReserve' },
      { type: 'dispatch', attemptId: item.attemptId }, { type: 'settle', attemptId: item.attemptId, finishReason: 'stop' }])
      return { armBindings, attempts, raw: rows.map(JSON.stringify).join('\n') + '\n' }
    }
    const first = segment('fa8806d7-5287-4059-82a0-c1c316396067', '8'.repeat(40), fa.protocolHash, ['20e3ade1-0000-4000-8000-000000000003'])
    const second = segment('b42cfc55-e214-4d51-b4c8-6b6bd2e5ea16', '2'.repeat(40), b42.protocolHash, ['daa24833-0000-4000-8000-000000000004'])
    const raw = first.raw + second.raw
    const b1 = { fromEventCount: 0, eventCount: 3, rawBytesSha256: hash(first.raw), protocolRevision: fa.protocolRevision,
      protocolHash: fa.protocolHash, armBindings: first.armBindings, reserveAttempts: first.attempts }
    const b2 = { fromEventCount: 3, eventCount: 6, rawBytesSha256: hash(raw), protocolRevision: b42.protocolRevision,
      protocolHash: b42.protocolHash, armBindings: second.armBindings, reserveAttempts: second.attempts }
    const current = { ...envelope, arm: 'candidate', codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(),
      parityId: 'c'.repeat(64), ...currentProtocolBinding(),
      actual: { attemptId: 'a', runId: 'r', rootActionId: 'root', projectId: 'p', epoch: 'e' } }
    fs.writeFileSync(file, raw)
    assert.doesNotThrow(() => updateLedger(file, { type: 'reserve', attemptId: 'after-b42cfc55', binding: current },
      { campaignMode: 'synthetic', historicalC16Fa8806d7Boundary: b1, historicalC16B42cfc55Boundary: b2 }))
    fs.writeFileSync(file, raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-b42cfc55', binding: current },
      { campaignMode: 'synthetic', historicalC16Fa8806d7Boundary: b1 }), /PROTOCOL_DRIFT/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-b42cfc55', binding: current },
      { campaignMode: 'synthetic', historicalC16Fa8806d7Boundary: b1, historicalC16B42cfc55Boundary: { ...b2, fromEventCount: 0 } }),
    /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-b42cfc55', binding: current },
      { campaignMode: 'synthetic', historicalC16Fa8806d7Boundary: b1,
        historicalC16B42cfc55Boundary: { ...b2, armBindings: { candidate: { ...b2.armBindings.candidate, codeSha: '1'.repeat(40) } } } }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // 新协议下旧协议 hash 的新 reserve（未登记为历史）一律按当前协议拒绝。
    fs.writeFileSync(file, raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'stale-v5', binding: { ...current, protocolHash: b42.protocolHash } },
      { campaignMode: 'synthetic', historicalC16Fa8806d7Boundary: b1, historicalC16B42cfc55Boundary: b2 }), /PROTOCOL_DRIFT/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  const runner = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-run.mjs'), 'utf8')
  assert.match(runner, /validateHistoricalSupersessionBoundary\(raw, fa8806d7, protocol\.historicalC16B42cfc55Boundary\)/)
  assert.match(runner, /validateHistoricalSupersessionBoundary\(rawLedger, trustedFa8806d7Events, b42cfc55Boundary\)/)
})

test('C16–C18 67a57c04 段（第739–774行，C17-B 失败停发）按同一规则加性登记，链在 b42cfc55 后，真实账本只读回放到774且字节不变', () => {
  const fa = protocol.historicalC16Fa8806d7Boundary, b42 = protocol.historicalC16B42cfc55Boundary, r67 = protocol.historicalC1667a57c04Boundary
  assert.deepEqual([r67.fromEventCount, r67.eventCount, r67.reserveAttempts.length], [b42.eventCount, 774, 12])
  assert.equal(r67.rawBytesSha256, '7c7fa687e2f0c097e274dc204d661f677b307a500d1c2ca26688f890c8542ff9')
  assert.equal(r67.protocolRevision, protocolBinding.protocolRevision)
  assert.equal(r67.protocolHash, '4491c88d35bf3d23d862d44825de17ad667e3b0286e8be5c245ba4f2c24cd563')
  assert.notEqual(r67.protocolHash, protocolBinding.protocolHash, '登记本段后协议字节必然漂移，须与被取代的 hash 不同')
  assert.deepEqual(r67.armBindings, { candidate: { codeSha: 'b6bef1f3584f5818e3af344da7a2f07925e9d611',
    sourceHash: '272018704d19860f3c2d72c2a1849e0ffc210b85804e0e6cdf8efcbf381b5b20',
    driverHash: 'dbc1cfd85fb54880bb9987a927f574798894e967bffb608917c147f9adbeff92' } })
  assert.deepEqual([...new Set(r67.reserveAttempts.map(item => item.invocationId))], ['67a57c04-b92f-4746-84bb-b2fbe9ee01f6'])
  // 失败终态如实登记：账本里 12 次物理请求全部 settle；边界只有身份与证据字段，没有任何可把该 invocation 改判为通过的结论字段。
  assert.deepEqual(Object.keys(r67), ['fromEventCount', 'eventCount', 'rawBytesSha256', 'protocolRevision', 'protocolHash', 'armBindings', 'reserveAttempts'])
  assert.ok(r67.reserveAttempts.every(item => item.attemptId.startsWith('candidate:') && item.terminal === 'settle' && /^[a-f0-9]{64}$/.test(item.parityId)
    && Object.keys(item).join() === 'attemptId,invocationId,terminal,parityId'))
  // 逐 attempt parityId 顺序即案序：C16-A(2)、C16-B(3)、C16-C(2)+C17-A(2)、C17-B(3)；C18 未执行。
  assert.deepEqual(r67.reserveAttempts.map(item => item.parityId.slice(0, 8)),
    ['0432aa71', '0432aa71', '712b782d', '712b782d', '712b782d', '1e180064', '1e180064', '1e180064', '1e180064', '4e5b911f', '4e5b911f', '4e5b911f'])
  const porcelain = spawnSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  let ledger = null
  try { ledger = path.join(registeredCampaignWorktree(porcelain.stdout), '.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl') } catch { ledger = null }
  if (ledger && fs.existsSync(ledger)) {
    const before = fs.readFileSync(ledger)
    const raw = before.toString('utf8')
    // 登记本段时账本恰为774行；此后若账本继续追加，本段前缀 hash 仍须成立。
    assert.equal(validateHistoricalSupersessionBoundary(raw, 738, r67), 774)
    // 前738行原字节仍是 b42cfc55 段认证的整本账本，本段只加性追加。
    assert.equal(hash(raw.split('\n').slice(0, 738).join('\n') + '\n'), b42.rawBytesSha256)
    const segment = raw.split('\n').slice(738, 774).map(line => JSON.parse(line))
    assert.equal(segment.length, 36)
    assert.ok(segment.filter(row => row.type === 'reserve').every(row => row.binding.mode === 'real' && row.binding.phase === 'c16-c18'
      && row.binding.milestone === 'final' && row.binding.arm === 'candidate'))
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 690, r67), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // driverHash 与 b42cfc55 段相同，故改用更早的 fa8806d7 段身份逐项替换（三项都须不同于本段）。
    for (const key of ['codeSha', 'sourceHash', 'driverHash']) {
      const value = fa.armBindings.candidate[key]
      assert.notEqual(value, r67.armBindings.candidate[key], key)
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 738, { ...r67,
        armBindings: { candidate: { ...r67.armBindings.candidate, [key]: value } } }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/, key)
    }
    for (const protocolHash of [protocolBinding.protocolHash, b42.protocolHash])
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 738, { ...r67, protocolHash }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 738, { ...r67, reserveAttempts: r67.reserveAttempts.map((item, index) =>
      index === 11 ? { ...item, terminal: 'unknown' } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 738, { ...r67, reserveAttempts: r67.reserveAttempts.map((item, index) =>
      index === 0 ? { ...item, attemptId: 'candidate:wrong' } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 738, { ...r67, reserveAttempts: r67.reserveAttempts.map((item, index) =>
      index === 0 ? { ...item, invocationId: b42.reserveAttempts[0].invocationId } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 738, { ...r67, reserveAttempts: r67.reserveAttempts.map((item, index) =>
      index === 9 ? { ...item, parityId: b42.reserveAttempts[0].parityId } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // 前缀（第1–738行）或本段（第739–774行）内任一字节被改，整段前缀 hash 即拒绝。
    for (const line of [737, 750, 773]) {
      const tampered = raw.trimEnd().split('\n')
      tampered[line] = tampered[line].replace('"attemptId":"', '"attemptId":"tampered-')
      assert.throws(() => validateHistoricalSupersessionBoundary(tampered.join('\n') + '\n', 738, r67), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/, String(line))
    }
    assert.throws(() => validateHistoricalSupersessionBoundary(raw.split('\n').slice(0, 773).join('\n') + '\n', 738, r67), /HISTORICAL_LEDGER_SUPERSESSION_MISSING/)
    // 整链回放：全部边界自冻结前缀起依次认证到链末端（现为第861行，见 1d0bdac3 段测试）。
    assert.equal(validatePhysicalLedger(ledger), path.resolve(ledger))
    const after = fs.readFileSync(ledger)
    assert.ok(after.equals(before), 'REAL_LEDGER_MUST_STAY_READ_ONLY')
    assert.equal(hash(after), hash(before))
  }
  // 合成账本：b42cfc55 后接 67a57c04 段登记为历史时，其后的当前 reserve 通过；缺该段则按当前协议拒绝。
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/r67a57c04-boundary-'))
  try {
    const file = path.join(dir, 'synthetic-ledger.jsonl')
    const envelope = { campaignId: CAMPAIGN_ID, mode: 'synthetic', phase: 'c16-c18', milestone: 'final', caseId: 'C17-B', operation: '本地恢复后续写' }
    const segment = (invocationId, codeSha, protocolHash, ids) => {
      const armBindings = { candidate: { codeSha, sourceHash: '6'.repeat(64), driverHash: '3'.repeat(64) } }
      const attempts = ids.map(id => ({ attemptId: `candidate:${id}`, invocationId, terminal: 'settle', parityId: '9'.repeat(64) }))
      const rows = attempts.flatMap(item => [{ type: 'reserve', attemptId: item.attemptId, binding: { ...envelope, arm: 'candidate',
        ...armBindings.candidate, protocolRevision: protocolBinding.protocolRevision, protocolHash, parityId: item.parityId, invocationId },
      allocation: 'failedRetryRepairReviewReserve' },
      { type: 'dispatch', attemptId: item.attemptId }, { type: 'settle', attemptId: item.attemptId, finishReason: 'stop' }])
      return { armBindings, attempts, raw: rows.map(JSON.stringify).join('\n') + '\n' }
    }
    const first = segment('b42cfc55-e214-4d51-b4c8-6b6bd2e5ea16', '2'.repeat(40), b42.protocolHash, ['daa24833-0000-4000-8000-000000000004'])
    const second = segment('67a57c04-b92f-4746-84bb-b2fbe9ee01f6', 'b'.repeat(40), r67.protocolHash, ['38aa4f9b-0000-4000-8000-000000000005'])
    const raw = first.raw + second.raw
    const b1 = { fromEventCount: 0, eventCount: 3, rawBytesSha256: hash(first.raw), protocolRevision: b42.protocolRevision,
      protocolHash: b42.protocolHash, armBindings: first.armBindings, reserveAttempts: first.attempts }
    const b2 = { fromEventCount: 3, eventCount: 6, rawBytesSha256: hash(raw), protocolRevision: r67.protocolRevision,
      protocolHash: r67.protocolHash, armBindings: second.armBindings, reserveAttempts: second.attempts }
    const current = { ...envelope, arm: 'candidate', codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(),
      parityId: 'c'.repeat(64), ...currentProtocolBinding(),
      actual: { attemptId: 'a', runId: 'r', rootActionId: 'root', projectId: 'p', epoch: 'e' } }
    fs.writeFileSync(file, raw)
    assert.doesNotThrow(() => updateLedger(file, { type: 'reserve', attemptId: 'after-67a57c04', binding: current },
      { campaignMode: 'synthetic', historicalC16B42cfc55Boundary: b1, historicalC1667a57c04Boundary: b2 }))
    fs.writeFileSync(file, raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-67a57c04', binding: current },
      { campaignMode: 'synthetic', historicalC16B42cfc55Boundary: b1 }), /PROTOCOL_DRIFT/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-67a57c04', binding: current },
      { campaignMode: 'synthetic', historicalC16B42cfc55Boundary: b1, historicalC1667a57c04Boundary: { ...b2, fromEventCount: 0 } }),
    /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-67a57c04', binding: current },
      { campaignMode: 'synthetic', historicalC16B42cfc55Boundary: b1,
        historicalC1667a57c04Boundary: { ...b2, armBindings: { candidate: { ...b2.armBindings.candidate, codeSha: '1'.repeat(40) } } } }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // 新协议下旧协议 hash 的新 reserve（未登记为历史）一律按当前协议拒绝。
    fs.writeFileSync(file, raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'stale-67a57c04', binding: { ...current, protocolHash: r67.protocolHash } },
      { campaignMode: 'synthetic', historicalC16B42cfc55Boundary: b1, historicalC1667a57c04Boundary: b2 }), /PROTOCOL_DRIFT/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  const runner = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-run.mjs'), 'utf8')
  assert.match(runner, /validateHistoricalSupersessionBoundary\(raw, b42cfc55, protocol\.historicalC1667a57c04Boundary\)/)
  assert.match(runner, /validateHistoricalSupersessionBoundary\(rawLedger, trustedB42cfc55Events, r67a57c04Boundary\)/)
})

test('C16–C18 2867cfa4 段（第775–828行，自动阶段七案通过）按同一规则加性登记，链在 67a57c04 后，真实账本只读回放到828且字节不变', () => {
  const fa = protocol.historicalC16Fa8806d7Boundary, b42 = protocol.historicalC16B42cfc55Boundary
  const r67 = protocol.historicalC1667a57c04Boundary, r28 = protocol.historicalC162867cfa4Boundary
  assert.deepEqual([r28.fromEventCount, r28.eventCount, r28.reserveAttempts.length], [r67.eventCount, 828, 18])
  assert.equal(r28.rawBytesSha256, '51a5ea830f44ed6149e2f282b44d6281efe70ddcf22d81f7b9cba09561a3cc2b')
  assert.equal(r28.protocolRevision, protocolBinding.protocolRevision)
  assert.equal(r28.protocolHash, '1d7c737bd956e25c855390b0976de90c95364db85a3a52e86c2c36df647a3b11')
  assert.notEqual(r28.protocolHash, protocolBinding.protocolHash, '登记本段后协议字节必然漂移，须与被取代的 hash 不同')
  assert.deepEqual(r28.armBindings, { candidate: { codeSha: '2147b95cc94300c75a2ae804554f99b82675df02',
    sourceHash: '880dc80c1aea30f37f12e2605aad47e95e3609a9c28eb6d62d638467a86c0b73',
    driverHash: 'dbc1cfd85fb54880bb9987a927f574798894e967bffb608917c147f9adbeff92' } })
  assert.deepEqual([...new Set(r28.reserveAttempts.map(item => item.invocationId))], ['2867cfa4-a10f-4912-8134-edf0f83e608e'])
  // 边界只有身份与证据字段，没有任何可把该 invocation 解读为“通过/改判”的结论字段；独立评审结论只写在 quality-protocol.md 第八节。
  assert.deepEqual(Object.keys(r28), ['fromEventCount', 'eventCount', 'rawBytesSha256', 'protocolRevision', 'protocolHash', 'armBindings', 'reserveAttempts'])
  assert.ok(r28.reserveAttempts.every(item => item.attemptId.startsWith('candidate:') && item.terminal === 'settle' && /^[a-f0-9]{64}$/.test(item.parityId)
    && Object.keys(item).join() === 'attemptId,invocationId,terminal,parityId'))
  // 逐 attempt parityId 顺序即案序：C16-A(2)、C16-B(2)、C16-C(3)+C17-A(2)、C17-B(5)、C18-A(2)+C18-B(2)。
  assert.deepEqual(r28.reserveAttempts.map(item => item.parityId.slice(0, 8)),
    ['0432aa71', '0432aa71', '712b782d', '712b782d', '1e180064', '1e180064', '1e180064', '1e180064', '1e180064',
      '4e5b911f', '4e5b911f', '4e5b911f', '4e5b911f', '4e5b911f', '1e180064', '1e180064', '1e180064', '1e180064'])
  const porcelain = spawnSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  let ledger = null
  try { ledger = path.join(registeredCampaignWorktree(porcelain.stdout), '.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl') } catch { ledger = null }
  if (ledger && fs.existsSync(ledger)) {
    const before = fs.readFileSync(ledger)
    const raw = before.toString('utf8')
    // 登记本段时账本恰为828行；此后若账本继续追加，本段前缀 hash 仍须成立。
    assert.equal(validateHistoricalSupersessionBoundary(raw, 774, r28), 828)
    // 前690/738/774行原字节仍是各前段认证的整本账本，本段只加性追加。
    for (const [count, boundary] of [[690, fa], [738, b42], [774, r67]])
      assert.equal(hash(raw.split('\n').slice(0, count).join('\n') + '\n'), boundary.rawBytesSha256, String(count))
    const segment = raw.split('\n').slice(774, 828).map(line => JSON.parse(line))
    assert.equal(segment.length, 54)
    assert.deepEqual(segment.map(row => row.type), Array.from({ length: 18 }, () => ['reserve', 'dispatch', 'settle']).flat())
    const reserves = segment.filter(row => row.type === 'reserve')
    assert.ok(reserves.every(row => row.binding.mode === 'real' && row.binding.phase === 'c16-c18'
      && row.binding.milestone === 'final' && row.binding.arm === 'candidate'))
    // 账本 reserve 的案序与 operation 序：与七案自动阶段收据 results[].attempts 的顺序一致（C17-B 含恢复副本重新定稿）。
    assert.deepEqual(reserves.map(row => `${row.binding.caseId}/${row.binding.operation}`), [
      'C16-A/定稿章节要点', 'C16-A/定稿角色状态', 'C16-B/定稿章节要点', 'C16-B/定稿角色状态',
      'C16-C/定稿章节要点', 'C16-C/定稿角色状态', 'C16-C/定稿角色状态', 'C17-A/本地恢复后续写', 'C17-A/本地恢复后续写',
      'C17-B/恢复副本重新定稿章节要点', 'C17-B/恢复副本重新定稿角色状态', 'C17-B/恢复副本重新定稿角色状态', 'C17-B/本地恢复后续写', 'C17-B/本地恢复后续写',
      'C18-A/DAV选定世代恢复后续写', 'C18-A/DAV选定世代恢复后续写', 'C18-B/DAV选定世代恢复后续写', 'C18-B/DAV选定世代恢复后续写'])
    assert.ok(segment.filter(row => row.type === 'settle').every(row => row.finishReason === 'stop'))
    // fromEventCount 必须恰为前一段的链末端；更早的起点不能替代本段。
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 738, r28), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 690, r28), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // 事件数与 attempt 数不符（多一个或少一个事件、少登记一次或多登记一次 attempt）一律拒绝。
    for (const eventCount of [825, 827, 829, 831])
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 774, { ...r28, eventCount }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/, String(eventCount))
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 774, { ...r28, reserveAttempts: r28.reserveAttempts.slice(0, 17) }),
      /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 774, { ...r28, reserveAttempts: [...r28.reserveAttempts, r28.reserveAttempts[0]] }),
      /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // 三项 candidate 身份都须不同于更早的 fa8806d7 段身份（driverHash 与 67a57c04 段相同，故不能用它替换），逐项替换即拒绝。
    for (const key of ['codeSha', 'sourceHash', 'driverHash']) {
      const value = fa.armBindings.candidate[key]
      assert.notEqual(value, r28.armBindings.candidate[key], key)
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 774, { ...r28,
        armBindings: { candidate: { ...r28.armBindings.candidate, [key]: value } } }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/, key)
    }
    for (const protocolHash of [protocolBinding.protocolHash, r67.protocolHash])
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 774, { ...r28, protocolHash }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 774, { ...r28, protocolRevision: 'other-revision' }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 774, { ...r28, reserveAttempts: r28.reserveAttempts.map((item, index) =>
      index === 17 ? { ...item, terminal: 'unknown' } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 774, { ...r28, reserveAttempts: r28.reserveAttempts.map((item, index) =>
      index === 0 ? { ...item, attemptId: 'candidate:wrong' } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // attempt 顺序即账本顺序：对调相邻两个 attemptId 即拒绝。
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 774, { ...r28, reserveAttempts: r28.reserveAttempts.map((item, index, all) =>
      index === 0 ? { ...item, attemptId: all[1].attemptId } : index === 1 ? { ...item, attemptId: all[0].attemptId } : item) }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 774, { ...r28, reserveAttempts: r28.reserveAttempts.map((item, index) =>
      index === 0 ? { ...item, invocationId: r67.reserveAttempts[0].invocationId } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // parityId 错位：C17-B 起点换成 C16-A 的 parity、C18-A 起点换成 C17-B 的 parity 均拒绝。
    for (const [index, parityId] of [[9, r28.reserveAttempts[0].parityId], [14, r28.reserveAttempts[9].parityId]])
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 774, { ...r28, reserveAttempts: r28.reserveAttempts.map((item, at) =>
        at === index ? { ...item, parityId } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/, String(index))
    // 前缀（第1–774行）或本段（第775–828行）内任一字节被改，整段前缀 hash 即拒绝。
    for (const line of [773, 774, 800, 827]) {
      const tampered = raw.trimEnd().split('\n')
      tampered[line] = tampered[line].replace('"attemptId":"', '"attemptId":"tampered-')
      assert.throws(() => validateHistoricalSupersessionBoundary(tampered.join('\n') + '\n', 774, r28), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/, String(line))
    }
    // 本段内多出一行（重复一个事件）同样使前缀 hash 漂移；少一行或缺整段则前缀不足 828 行。
    const extra = raw.trimEnd().split('\n')
    extra.splice(800, 0, extra[800])
    assert.throws(() => validateHistoricalSupersessionBoundary(extra.join('\n') + '\n', 774, r28), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw.split('\n').slice(0, 827).join('\n') + '\n', 774, r28), /HISTORICAL_LEDGER_SUPERSESSION_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw.split('\n').slice(0, 774).join('\n') + '\n', 774, r28), /HISTORICAL_LEDGER_SUPERSESSION_MISSING/)
    // 整链回放：全部边界自冻结前缀起依次认证到链末端（现为第861行，见 1d0bdac3 段测试）。
    assert.equal(validatePhysicalLedger(ledger), path.resolve(ledger))
    const after = fs.readFileSync(ledger)
    assert.ok(after.equals(before), 'REAL_LEDGER_MUST_STAY_READ_ONLY')
    assert.equal(hash(after), hash(before))
  }
  // 合成账本：67a57c04 后接 2867cfa4 段登记为历史时，其后的当前 reserve 通过；缺该段则按当前协议拒绝。
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/r2867cfa4-boundary-'))
  try {
    const file = path.join(dir, 'synthetic-ledger.jsonl')
    const envelope = { campaignId: CAMPAIGN_ID, mode: 'synthetic', phase: 'c16-c18', milestone: 'final', caseId: 'C17-B', operation: '本地恢复后续写' }
    const segment = (invocationId, codeSha, protocolHash, ids) => {
      const armBindings = { candidate: { codeSha, sourceHash: '6'.repeat(64), driverHash: '3'.repeat(64) } }
      const attempts = ids.map(id => ({ attemptId: `candidate:${id}`, invocationId, terminal: 'settle', parityId: '9'.repeat(64) }))
      const rows = attempts.flatMap(item => [{ type: 'reserve', attemptId: item.attemptId, binding: { ...envelope, arm: 'candidate',
        ...armBindings.candidate, protocolRevision: protocolBinding.protocolRevision, protocolHash, parityId: item.parityId, invocationId },
      allocation: 'failedRetryRepairReviewReserve' },
      { type: 'dispatch', attemptId: item.attemptId }, { type: 'settle', attemptId: item.attemptId, finishReason: 'stop' }])
      return { armBindings, attempts, raw: rows.map(JSON.stringify).join('\n') + '\n' }
    }
    const first = segment('67a57c04-b92f-4746-84bb-b2fbe9ee01f6', '2'.repeat(40), r67.protocolHash, ['38aa4f9b-0000-4000-8000-000000000004'])
    const second = segment('2867cfa4-a10f-4912-8134-edf0f83e608e', 'b'.repeat(40), r28.protocolHash, ['c8a69a50-0000-4000-8000-000000000005'])
    const raw = first.raw + second.raw
    const b1 = { fromEventCount: 0, eventCount: 3, rawBytesSha256: hash(first.raw), protocolRevision: r67.protocolRevision,
      protocolHash: r67.protocolHash, armBindings: first.armBindings, reserveAttempts: first.attempts }
    const b2 = { fromEventCount: 3, eventCount: 6, rawBytesSha256: hash(raw), protocolRevision: r28.protocolRevision,
      protocolHash: r28.protocolHash, armBindings: second.armBindings, reserveAttempts: second.attempts }
    const current = { ...envelope, arm: 'candidate', codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(),
      parityId: 'c'.repeat(64), ...currentProtocolBinding(),
      actual: { attemptId: 'a', runId: 'r', rootActionId: 'root', projectId: 'p', epoch: 'e' } }
    fs.writeFileSync(file, raw)
    assert.doesNotThrow(() => updateLedger(file, { type: 'reserve', attemptId: 'after-2867cfa4', binding: current },
      { campaignMode: 'synthetic', historicalC1667a57c04Boundary: b1, historicalC162867cfa4Boundary: b2 }))
    fs.writeFileSync(file, raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-2867cfa4', binding: current },
      { campaignMode: 'synthetic', historicalC1667a57c04Boundary: b1 }), /PROTOCOL_DRIFT/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-2867cfa4', binding: current },
      { campaignMode: 'synthetic', historicalC1667a57c04Boundary: b1, historicalC162867cfa4Boundary: { ...b2, fromEventCount: 0 } }),
    /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // 跳过 67a57c04 段直接登记本段：本段起点对不上链末端，拒绝。
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-2867cfa4', binding: current },
      { campaignMode: 'synthetic', historicalC162867cfa4Boundary: b2 }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-2867cfa4', binding: current },
      { campaignMode: 'synthetic', historicalC1667a57c04Boundary: b1,
        historicalC162867cfa4Boundary: { ...b2, armBindings: { candidate: { ...b2.armBindings.candidate, codeSha: '1'.repeat(40) } } } }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // 新协议下旧协议 hash 的新 reserve（未登记为历史）一律按当前协议拒绝。
    fs.writeFileSync(file, raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'stale-2867cfa4', binding: { ...current, protocolHash: r28.protocolHash } },
      { campaignMode: 'synthetic', historicalC1667a57c04Boundary: b1, historicalC162867cfa4Boundary: b2 }), /PROTOCOL_DRIFT/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  const runner = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-run.mjs'), 'utf8')
  assert.match(runner, /validateHistoricalSupersessionBoundary\(raw, r67a57c04, protocol\.historicalC162867cfa4Boundary\)/)
  assert.match(runner, /validateHistoricalSupersessionBoundary\(rawLedger, trusted67a57c04Events, r2867cfa4Boundary\)/)
})

test('S14B post-UI ba2d34ab 段（第829–843行，candidate 超长首稿的压缩被拒后失败）按同一规则加性登记，链在 2867cfa4 后，真实账本只读回放到843且字节不变', () => {
  const r28 = protocol.historicalC162867cfa4Boundary, r43 = protocol.historicalPostUiBa2d34abBoundary
  const invocationId = 'ba2d34ab-a4f6-4283-bed1-eb2bffa8b5aa', parity = '3c217fca02910eb0bc2e82d5d2e08414a75695125a38b4a1c0abf4f33c35127e'
  assert.deepEqual([r43.fromEventCount, r43.eventCount, r43.reserveAttempts.length], [r28.eventCount, 843, 5])
  assert.equal(r43.rawBytesSha256, 'baa7666b4905b268d0a96c5d4443cdd5f935f52b3b077bdeac52f86fbc89c1b5')
  assert.equal(r43.protocolRevision, protocolBinding.protocolRevision)
  assert.equal(r43.protocolHash, '7cf6e1ce4a7f91c408af3fed1369d914ff2e53a3f19501169ebf12ee2c997869')
  assert.notEqual(r43.protocolHash, protocolBinding.protocolHash, '登记本段后协议字节必然漂移，须与被取代的 hash 不同')
  // 边界记录的协议 hash 必须是候选代码 a618c122 提交里那份 protocol.json 的字节 hash（可复核时才断言）。
  const committed = spawnSync('git', ['-C', ROOT, 'show', 'a618c122d02d3abf08103620db063118e710073d:docs/research/novel-quality-modernization/protocol.json'])
  if (committed.status === 0) assert.equal(hash(committed.stdout), r43.protocolHash)
  // 两臂各自的代码/源/driver 身份；baseline 整臂一个 parity（登记在 armBindings），candidate 逐 attempt 登记 parity。
  assert.deepEqual(r43.armBindings, {
    baseline: { codeSha: '2264390d6fb8b052cc14736d544df0cc74516649',
      sourceHash: '9b0d78fc45e0ad01d4c975eb0c23d2d0f2dae0ef5c2b84d6c5e19294a31bd4e8',
      driverHash: 'dbc1cfd85fb54880bb9987a927f574798894e967bffb608917c147f9adbeff92', parityId: parity },
    candidate: { codeSha: 'a618c122d02d3abf08103620db063118e710073d',
      sourceHash: '880dc80c1aea30f37f12e2605aad47e95e3609a9c28eb6d62d638467a86c0b73',
      driverHash: 'dbc1cfd85fb54880bb9987a927f574798894e967bffb608917c147f9adbeff92' } })
  assert.deepEqual([...new Set(r43.reserveAttempts.map(item => item.invocationId))], [invocationId])
  // 边界只有身份与证据字段，不含把该 invocation 解读为“通过/改判/补采”的结论字段；失败事实只写在 quality-protocol.md。
  assert.deepEqual(Object.keys(r43), ['fromEventCount', 'eventCount', 'rawBytesSha256', 'protocolRevision', 'protocolHash', 'armBindings', 'reserveAttempts'])
  assert.deepEqual(r43.reserveAttempts, [
    { attemptId: 'baseline:0b71919f-bd4b-4631-99a4-163dcfa568fe', invocationId, terminal: 'settle' },
    { attemptId: 'baseline:10c1680b-c313-4ef7-87a2-9432e4ad1da4', invocationId, terminal: 'settle' },
    { attemptId: 'baseline:08fbd628-7ae9-4b30-a203-1833d48e9550', invocationId, terminal: 'settle' },
    { attemptId: 'candidate:5a1ec919-f31e-4979-8a02-1276639d14d8', invocationId, terminal: 'settle', parityId: parity },
    { attemptId: 'candidate:ebfb08cd-ef74-45b9-9663-83b12476a172', invocationId, terminal: 'settle', parityId: parity }])
  const porcelain = spawnSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  let ledger = null
  try { ledger = path.join(registeredCampaignWorktree(porcelain.stdout), '.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl') } catch { ledger = null }
  if (ledger && fs.existsSync(ledger)) {
    const before = fs.readFileSync(ledger)
    const raw = before.toString('utf8')
    // 登记本段时账本恰为843行；此后若账本继续追加，本段前缀 hash 仍须成立。
    assert.equal(validateHistoricalSupersessionBoundary(raw, 828, r43), 843)
    // 前828行原字节仍是 2867cfa4 段认证的整本账本，本段只加性追加。
    assert.equal(hash(raw.split('\n').slice(0, 828).join('\n') + '\n'), r28.rawBytesSha256)
    const segment = raw.split('\n').slice(828, 843).map(line => JSON.parse(line))
    assert.equal(segment.length, 15)
    assert.deepEqual(segment.map(row => row.type), Array.from({ length: 5 }, () => ['reserve', 'dispatch', 'settle']).flat())
    const reserves = segment.filter(row => row.type === 'reserve')
    assert.ok(reserves.every(row => row.binding.mode === 'real' && row.binding.phase === 'early-budget' && row.binding.milestone === 'post-ui'
      && row.binding.caseId === '场景1/1' && row.binding.invocationId === invocationId && row.binding.parityId === parity))
    // 账本 reserve 的臂序与 operation 序：candidate 首稿之后再无 reserve——登记外的压缩请求在 reserve 前被拒，不在账本里。
    assert.deepEqual(reserves.map(row => `${row.binding.arm}/${row.binding.operation}`), [
      'baseline/指定范围生成', 'baseline/900单位正文', 'baseline/成稿首审', 'candidate/指定范围生成', 'candidate/900单位正文'])
    assert.ok(segment.filter(row => row.type === 'settle').every(row => row.finishReason === 'stop'))
    // fromEventCount 必须恰为前一段的链末端；更早的起点不能替代本段。
    for (const from of [738, 774, 690]) assert.throws(() => validateHistoricalSupersessionBoundary(raw, from, r43), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/, String(from))
    // 事件数与 attempt 数不符（多一个或少一个事件、少登记一次或多登记一次 attempt）一律拒绝。
    for (const eventCount of [840, 842, 844, 846])
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, eventCount }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/, String(eventCount))
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, reserveAttempts: r43.reserveAttempts.slice(0, 4) }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, reserveAttempts: [...r43.reserveAttempts, r43.reserveAttempts[0]] }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // 缺任一臂的绑定（两臂都出现在本段）或把两臂绑定错位，一律拒绝。
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, armBindings: { baseline: r43.armBindings.baseline } }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, armBindings: { candidate: r43.armBindings.candidate } }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, armBindings: {
      baseline: { ...r43.armBindings.candidate, parityId: parity }, candidate: { ...r43.armBindings.baseline, parityId: undefined } } }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // 每臂三项身份逐项替换为另一臂的值（相同则换成全 f），均拒绝。
    for (const arm of ['baseline', 'candidate']) for (const key of ['codeSha', 'sourceHash', 'driverHash']) {
      const other = r43.armBindings[arm === 'baseline' ? 'candidate' : 'baseline'][key]
      const value = other === r43.armBindings[arm][key] ? 'f'.repeat(key === 'codeSha' ? 40 : 64) : other
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43,
        armBindings: { ...r43.armBindings, [arm]: { ...r43.armBindings[arm], [key]: value } } }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/, `${arm}:${key}`)
    }
    // candidate 身份不同于 2867cfa4 段的 candidate（codeSha 是登记上一段的提交，本段是它之后的 a618c122）。
    assert.notEqual(r28.armBindings.candidate.codeSha, r43.armBindings.candidate.codeSha)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, armBindings: { ...r43.armBindings,
      candidate: { ...r43.armBindings.candidate, codeSha: r28.armBindings.candidate.codeSha } } }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // parity：baseline 整臂值错、candidate 逐 attempt 值错、二者同时登记或都缺，均拒绝。
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, armBindings: { ...r43.armBindings,
      baseline: { ...r43.armBindings.baseline, parityId: 'f'.repeat(64) } } }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, reserveAttempts: r43.reserveAttempts.map((item, index) =>
      index === 4 ? { ...item, parityId: 'f'.repeat(64) } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, reserveAttempts: r43.reserveAttempts.map((item, index) =>
      index === 0 ? { ...item, parityId: parity } : item) }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, reserveAttempts: r43.reserveAttempts.map((item, index) =>
      index === 3 ? { attemptId: item.attemptId, invocationId: item.invocationId, terminal: item.terminal } : item) }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    for (const protocolHash of [protocolBinding.protocolHash, r28.protocolHash])
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, protocolHash }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, protocolRevision: 'other-revision' }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // 终态、attemptId、invocationId 逐项核对：任一项改 unknown、任一 attemptId 写错、换成别的 invocation 均拒绝。
    for (const index of [0, 2, 3, 4]) assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, reserveAttempts: r43.reserveAttempts.map((item, at) =>
      at === index ? { ...item, terminal: 'unknown' } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/, `terminal:${index}`)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, reserveAttempts: r43.reserveAttempts.map((item, index) =>
      index === 0 ? { ...item, attemptId: 'baseline:wrong' } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43, reserveAttempts: r43.reserveAttempts.map((item, index) =>
      index === 4 ? { ...item, invocationId: r28.reserveAttempts[0].invocationId } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // attempt 顺序即账本顺序：对调 baseline 首两项、对调 candidate 两项均拒绝。
    for (const [left, right] of [[0, 1], [3, 4]]) assert.throws(() => validateHistoricalSupersessionBoundary(raw, 828, { ...r43,
      reserveAttempts: r43.reserveAttempts.map((item, index, all) => index === left ? { ...item, attemptId: all[right].attemptId }
        : index === right ? { ...item, attemptId: all[left].attemptId } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/, `${left}<->${right}`)
    // 前缀（第1–828行）或本段（第829–843行）内任一字节被改，整段前缀 hash 即拒绝。
    for (const line of [827, 828, 834, 837, 842]) {
      const tampered = raw.trimEnd().split('\n')
      tampered[line] = tampered[line].replace('"attemptId":"', '"attemptId":"tampered-')
      assert.throws(() => validateHistoricalSupersessionBoundary(tampered.join('\n') + '\n', 828, r43), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/, String(line))
    }
    // 本段内多出一行（重复一个事件）同样使前缀 hash 漂移；少一行或缺整段则前缀不足 843 行。
    const extra = raw.trimEnd().split('\n')
    extra.splice(835, 0, extra[835])
    assert.throws(() => validateHistoricalSupersessionBoundary(extra.join('\n') + '\n', 828, r43), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw.split('\n').slice(0, 842).join('\n') + '\n', 828, r43), /HISTORICAL_LEDGER_SUPERSESSION_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw.split('\n').slice(0, 828).join('\n') + '\n', 828, r43), /HISTORICAL_LEDGER_SUPERSESSION_MISSING/)
    // 整链回放：全部边界自冻结前缀起依次认证到第843行（其后由 1d0bdac3 段加性接续）。
    assert.equal(validatePhysicalLedger(ledger), path.resolve(ledger))
    const after = fs.readFileSync(ledger)
    assert.ok(after.equals(before), 'REAL_LEDGER_MUST_STAY_READ_ONLY')
    assert.equal(hash(after), hash(before))
  }
  // 合成账本：2867cfa4 类段后接本段（两臂）登记为历史时，其后的当前 reserve 通过；缺该段则按当前协议拒绝。
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/ba2d34ab-boundary-'))
  try {
    const file = path.join(dir, 'synthetic-ledger.jsonl')
    const envelope = { campaignId: CAMPAIGN_ID, mode: 'synthetic', phase: 'early-budget', milestone: 'post-ui', caseId: '场景1/1', operation: '900单位正文' }
    const segment = (id, protocolHash, armBindings, ids) => {
      const attempts = ids.map(([attemptId, parityId]) => ({ attemptId, invocationId: id, terminal: 'settle', ...(parityId ? { parityId } : {}) }))
      const rows = attempts.flatMap(item => {
        const arm = item.attemptId.split(':')[0]
        return [{ type: 'reserve', attemptId: item.attemptId, binding: { ...envelope, arm, ...armBindings[arm], protocolRevision: protocolBinding.protocolRevision,
          protocolHash, ...(item.parityId ? { parityId: item.parityId } : {}), invocationId: id }, allocation: 'failedRetryRepairReviewReserve' },
        { type: 'dispatch', attemptId: item.attemptId }, { type: 'settle', attemptId: item.attemptId, finishReason: 'stop' }]
      })
      return { armBindings, attempts, raw: rows.map(JSON.stringify).join('\n') + '\n' }
    }
    const first = segment('2867cfa4-a10f-4912-8134-edf0f83e608e', r28.protocolHash, { candidate: { codeSha: '2'.repeat(40), sourceHash: '6'.repeat(64), driverHash: '3'.repeat(64) } },
      [['candidate:c8a69a50-0000-4000-8000-000000000005', '9'.repeat(64)]])
    const both = { baseline: { codeSha: '1'.repeat(40), sourceHash: '2'.repeat(64), driverHash: '3'.repeat(64), parityId: '4'.repeat(64) },
      candidate: { codeSha: 'b'.repeat(40), sourceHash: '6'.repeat(64), driverHash: '3'.repeat(64) } }
    const second = segment(invocationId, r43.protocolHash, both, [['baseline:0b71919f-0000-4000-8000-000000000001'],
      ['candidate:ebfb08cd-0000-4000-8000-000000000002', '5'.repeat(64)]])
    const raw = first.raw + second.raw
    const b2 = { fromEventCount: 0, eventCount: 3, rawBytesSha256: hash(first.raw), protocolRevision: r28.protocolRevision,
      protocolHash: r28.protocolHash, armBindings: first.armBindings, reserveAttempts: first.attempts }
    const b3 = { fromEventCount: 3, eventCount: 9, rawBytesSha256: hash(raw), protocolRevision: r43.protocolRevision,
      protocolHash: r43.protocolHash, armBindings: second.armBindings, reserveAttempts: second.attempts }
    const current = { ...envelope, operation: '指定范围生成', arm: 'candidate', codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(),
      parityId: 'c'.repeat(64), ...currentProtocolBinding(),
      actual: { attemptId: 'a', runId: 'r', rootActionId: 'root', projectId: 'p', epoch: 'e' } }
    fs.writeFileSync(file, raw)
    assert.doesNotThrow(() => updateLedger(file, { type: 'reserve', attemptId: 'after-ba2d34ab', binding: current },
      { campaignMode: 'synthetic', historicalC162867cfa4Boundary: b2, historicalPostUiBa2d34abBoundary: b3 }))
    fs.writeFileSync(file, raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-ba2d34ab', binding: current },
      { campaignMode: 'synthetic', historicalC162867cfa4Boundary: b2 }), /PROTOCOL_DRIFT/)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-ba2d34ab', binding: current },
      { campaignMode: 'synthetic', historicalC162867cfa4Boundary: b2, historicalPostUiBa2d34abBoundary: { ...b3, fromEventCount: 0 } }),
    /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // 跳过前一段直接登记本段：本段起点对不上链末端，拒绝。
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-ba2d34ab', binding: current },
      { campaignMode: 'synthetic', historicalPostUiBa2d34abBoundary: b3 }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // 两臂绑定错位（baseline 值写成 candidate 的）：拒绝。
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-ba2d34ab', binding: current },
      { campaignMode: 'synthetic', historicalC162867cfa4Boundary: b2, historicalPostUiBa2d34abBoundary: { ...b3,
        armBindings: { ...b3.armBindings, baseline: { ...b3.armBindings.baseline, codeSha: b3.armBindings.candidate.codeSha } } } }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // 新协议下旧协议 hash 的新 reserve（未登记为历史）一律按当前协议拒绝。
    fs.writeFileSync(file, raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'stale-ba2d34ab', binding: { ...current, protocolHash: r43.protocolHash } },
      { campaignMode: 'synthetic', historicalC162867cfa4Boundary: b2, historicalPostUiBa2d34abBoundary: b3 }), /PROTOCOL_DRIFT/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  const runner = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-run.mjs'), 'utf8')
  assert.match(runner, /validateHistoricalSupersessionBoundary\(raw, r2867cfa4, protocol\.historicalPostUiBa2d34abBoundary\)/)
  assert.match(runner, /validateHistoricalSupersessionBoundary\(rawLedger, trusted2867cfa4Events, ba2d34abBoundary\)/)
})


test('S14B post-UI 1d0bdac3 段（第844–861行，自动阶段通过、候选首稿在区间内未压缩）按同一规则加性登记，链在 ba2d34ab 后，真实账本只读回放到861且字节不变', () => {
  const r43 = protocol.historicalPostUiBa2d34abBoundary, r61 = protocol.historicalPostUi1d0bdac3Boundary
  const invocationId = '1d0bdac3-6dc9-4f75-9bb8-405716b07711', parity = '3c217fca02910eb0bc2e82d5d2e08414a75695125a38b4a1c0abf4f33c35127e'
  assert.deepEqual([r61.fromEventCount, r61.eventCount, r61.reserveAttempts.length], [r43.eventCount, 861, 6])
  assert.equal(r61.rawBytesSha256, '60610b99ef8456da2aa09a159962de9a26bbdfbbf955ae7b5a411e5b62403d22')
  assert.equal(r61.protocolRevision, protocolBinding.protocolRevision)
  assert.equal(r61.protocolHash, '08dbed9d6b5ac52cd25aef24feb0b728f4772b8f230c74cbed34f293230b5cfd')
  assert.notEqual(r61.protocolHash, protocolBinding.protocolHash, '登记本段后协议字节必然漂移，须与被取代的 hash 不同')
  // 边界记录的协议 hash 必须是候选代码 02e94787 提交里那份 protocol.json 的字节 hash（可复核时才断言）。
  const committed = spawnSync('git', ['-C', ROOT, 'show', '02e947874365a8da074bcfdefe330c64dac0f58f:docs/research/novel-quality-modernization/protocol.json'])
  if (committed.status === 0) assert.equal(hash(committed.stdout), r61.protocolHash)
  assert.deepEqual(r61.armBindings, {
    baseline: { codeSha: '2264390d6fb8b052cc14736d544df0cc74516649',
      sourceHash: '9b0d78fc45e0ad01d4c975eb0c23d2d0f2dae0ef5c2b84d6c5e19294a31bd4e8',
      driverHash: 'abf22f3ee65d1641ec79f92f0fdc48fbce14986212fdf8b3f954b075d895c4ff', parityId: parity },
    candidate: { codeSha: '02e947874365a8da074bcfdefe330c64dac0f58f',
      sourceHash: '880dc80c1aea30f37f12e2605aad47e95e3609a9c28eb6d62d638467a86c0b73',
      driverHash: 'abf22f3ee65d1641ec79f92f0fdc48fbce14986212fdf8b3f954b075d895c4ff' } })
  assert.notEqual(r61.armBindings.candidate.driverHash, r43.armBindings.candidate.driverHash, 'driver 已随场景 v3 改变')
  assert.deepEqual(Object.keys(r61), ['fromEventCount', 'eventCount', 'rawBytesSha256', 'protocolRevision', 'protocolHash', 'armBindings', 'reserveAttempts'])
  assert.deepEqual(r61.reserveAttempts, [
    { attemptId: 'baseline:0dd6810a-9f11-468b-ab41-66f54c53596a', invocationId, terminal: 'settle' },
    { attemptId: 'baseline:25a523df-ffec-4b78-a9aa-9d231293b856', invocationId, terminal: 'settle' },
    { attemptId: 'baseline:69efe42f-9629-4082-8532-44d4786ac37f', invocationId, terminal: 'settle' },
    { attemptId: 'candidate:224db6a0-309a-45b4-8db7-3f022ade47db', invocationId, terminal: 'settle', parityId: parity },
    { attemptId: 'candidate:84824103-9dd0-4e08-acf4-10c45c17b98d', invocationId, terminal: 'settle', parityId: parity },
    { attemptId: 'candidate:5c9fb356-1b89-4f6f-93e4-82a3d16ce6f0', invocationId, terminal: 'settle', parityId: parity }])
  const porcelain = spawnSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  let ledger = null
  try { ledger = path.join(registeredCampaignWorktree(porcelain.stdout), '.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl') } catch { ledger = null }
  if (ledger && fs.existsSync(ledger)) {
    const before = fs.readFileSync(ledger)
    const raw = before.toString('utf8')
    // 登记本段时账本恰为861行；此后若账本继续追加，本段前缀 hash 仍须成立。
    assert.equal(validateHistoricalSupersessionBoundary(raw, 843, r61), 861)
    assert.equal(hash(raw.split('\n').slice(0, 843).join('\n') + '\n'), r43.rawBytesSha256, '前843行原字节仍是 ba2d34ab 段认证的整本账本')
    const segment = raw.split('\n').slice(843, 861).map(line => JSON.parse(line))
    assert.deepEqual(segment.map(row => row.type), Array.from({ length: 6 }, () => ['reserve', 'dispatch', 'settle']).flat())
    const reserves = segment.filter(row => row.type === 'reserve')
    assert.ok(reserves.every(row => row.binding.mode === 'real' && row.binding.phase === 'early-budget' && row.binding.milestone === 'post-ui'
      && row.binding.caseId === '场景1/1' && row.binding.invocationId === invocationId && row.binding.parityId === parity))
    // 每臂恰三步；候选「900单位正文」只有一个 reserve：首稿在区间内，没有发起压缩。
    assert.deepEqual(reserves.map(row => `${row.binding.arm}/${row.binding.operation}`), [
      'baseline/指定范围生成', 'baseline/900单位正文', 'baseline/成稿首审', 'candidate/指定范围生成', 'candidate/900单位正文', 'candidate/成稿首审'])
    assert.ok(segment.filter(row => row.type === 'settle').every(row => row.finishReason === 'stop'))
    for (const from of [828, 774, 690]) assert.throws(() => validateHistoricalSupersessionBoundary(raw, from, r61), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/, String(from))
    for (const eventCount of [858, 860, 862, 864])
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, eventCount }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/, String(eventCount))
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, reserveAttempts: r61.reserveAttempts.slice(0, 5) }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, reserveAttempts: [...r61.reserveAttempts, r61.reserveAttempts[0]] }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // 缺任一臂的绑定、两臂绑定错位、逐项身份替换：拒绝。
    for (const only of ['baseline', 'candidate'])
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, armBindings: { [only]: r61.armBindings[only] } }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/, only)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, armBindings: {
      baseline: { ...r61.armBindings.candidate, parityId: parity }, candidate: { ...r61.armBindings.baseline, parityId: undefined } } }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    for (const arm of ['baseline', 'candidate']) for (const key of ['codeSha', 'sourceHash', 'driverHash']) {
      const other = r61.armBindings[arm === 'baseline' ? 'candidate' : 'baseline'][key]
      const value = other === r61.armBindings[arm][key] ? 'f'.repeat(key === 'codeSha' ? 40 : 64) : other
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61,
        armBindings: { ...r61.armBindings, [arm]: { ...r61.armBindings[arm], [key]: value } } }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/, `${arm}:${key}`)
    }
    // 本段 driverHash 不同于 ba2d34ab 段：旧值不能替代。
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, armBindings: { ...r61.armBindings,
      candidate: { ...r61.armBindings.candidate, driverHash: r43.armBindings.candidate.driverHash } } }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // parity：baseline 整臂值错、candidate 逐 attempt 值错、二者同时登记或都缺，均拒绝。
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, armBindings: { ...r61.armBindings,
      baseline: { ...r61.armBindings.baseline, parityId: 'f'.repeat(64) } } }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, reserveAttempts: r61.reserveAttempts.map((item, index) =>
      index === 5 ? { ...item, parityId: 'f'.repeat(64) } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, reserveAttempts: r61.reserveAttempts.map((item, index) =>
      index === 0 ? { ...item, parityId: parity } : item) }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, reserveAttempts: r61.reserveAttempts.map((item, index) =>
      index === 3 ? { attemptId: item.attemptId, invocationId: item.invocationId, terminal: item.terminal } : item) }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    for (const protocolHash of [protocolBinding.protocolHash, r43.protocolHash])
      assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, protocolHash }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, protocolRevision: 'other-revision' }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    for (const index of [0, 2, 3, 5]) assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, reserveAttempts: r61.reserveAttempts.map((item, at) =>
      at === index ? { ...item, terminal: 'unknown' } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/, `terminal:${index}`)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, reserveAttempts: r61.reserveAttempts.map((item, index) =>
      index === 0 ? { ...item, attemptId: 'baseline:wrong' } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61, reserveAttempts: r61.reserveAttempts.map((item, index) =>
      index === 5 ? { ...item, invocationId: r43.reserveAttempts[0].invocationId } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    for (const [left, right] of [[0, 1], [4, 5]]) assert.throws(() => validateHistoricalSupersessionBoundary(raw, 843, { ...r61,
      reserveAttempts: r61.reserveAttempts.map((item, index, all) => index === left ? { ...item, attemptId: all[right].attemptId }
        : index === right ? { ...item, attemptId: all[left].attemptId } : item) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/, `${left}<->${right}`)
    for (const line of [842, 843, 850, 855, 860]) {
      const tampered = raw.trimEnd().split('\n')
      tampered[line] = tampered[line].replace('"attemptId":"', '"attemptId":"tampered-')
      assert.throws(() => validateHistoricalSupersessionBoundary(tampered.join('\n') + '\n', 843, r61), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/, String(line))
    }
    const extra = raw.trimEnd().split('\n')
    extra.splice(850, 0, extra[850])
    assert.throws(() => validateHistoricalSupersessionBoundary(extra.join('\n') + '\n', 843, r61), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw.split('\n').slice(0, 860).join('\n') + '\n', 843, r61), /HISTORICAL_LEDGER_SUPERSESSION_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw.split('\n').slice(0, 843).join('\n') + '\n', 843, r61), /HISTORICAL_LEDGER_SUPERSESSION_MISSING/)
    // 整链回放：全部边界自冻结前缀起依次认证到第861行，账本字节不变。
    assert.equal(validatePhysicalLedger(ledger), path.resolve(ledger))
    const after = fs.readFileSync(ledger)
    assert.ok(after.equals(before), 'REAL_LEDGER_MUST_STAY_READ_ONLY')
    assert.equal(hash(after), hash(before))
  }
  // 合成账本：上一段后接本段（两臂）登记为历史时，其后的当前 reserve 通过；缺该段则按当前协议拒绝。
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/1d0bdac3-boundary-'))
  try {
    const file = path.join(dir, 'synthetic-ledger.jsonl')
    const envelope = { campaignId: CAMPAIGN_ID, mode: 'synthetic', phase: 'early-budget', milestone: 'post-ui', caseId: '场景1/1', operation: '900单位正文' }
    const segment = (id, protocolHash, armBindings, ids) => {
      const attempts = ids.map(([attemptId, parityId]) => ({ attemptId, invocationId: id, terminal: 'settle', ...(parityId ? { parityId } : {}) }))
      const rows = attempts.flatMap(item => {
        const arm = item.attemptId.split(':')[0]
        return [{ type: 'reserve', attemptId: item.attemptId, binding: { ...envelope, arm, ...armBindings[arm], protocolRevision: protocolBinding.protocolRevision,
          protocolHash, ...(item.parityId ? { parityId: item.parityId } : {}), invocationId: id }, allocation: 'failedRetryRepairReviewReserve' },
        { type: 'dispatch', attemptId: item.attemptId }, { type: 'settle', attemptId: item.attemptId, finishReason: 'stop' }]
      })
      return { armBindings, attempts, raw: rows.map(JSON.stringify).join('\n') + '\n' }
    }
    const first = segment('ba2d34ab-a4f6-4283-bed1-eb2bffa8b5aa', r43.protocolHash, { candidate: { codeSha: '2'.repeat(40), sourceHash: '6'.repeat(64), driverHash: '3'.repeat(64) } },
      [['candidate:ebfb08cd-0000-4000-8000-000000000005', '9'.repeat(64)]])
    const both = { baseline: { codeSha: '1'.repeat(40), sourceHash: '2'.repeat(64), driverHash: '3'.repeat(64), parityId: '4'.repeat(64) },
      candidate: { codeSha: 'b'.repeat(40), sourceHash: '6'.repeat(64), driverHash: '3'.repeat(64) } }
    const second = segment(invocationId, r61.protocolHash, both, [['baseline:0dd6810a-0000-4000-8000-000000000001'],
      ['candidate:84824103-0000-4000-8000-000000000002', '5'.repeat(64)]])
    const raw = first.raw + second.raw
    const b1 = { fromEventCount: 0, eventCount: 3, rawBytesSha256: hash(first.raw), protocolRevision: r43.protocolRevision,
      protocolHash: r43.protocolHash, armBindings: first.armBindings, reserveAttempts: first.attempts }
    const b2 = { fromEventCount: 3, eventCount: 9, rawBytesSha256: hash(raw), protocolRevision: r61.protocolRevision,
      protocolHash: r61.protocolHash, armBindings: second.armBindings, reserveAttempts: second.attempts }
    const current = { ...envelope, operation: '指定范围生成', arm: 'candidate', codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(),
      parityId: 'c'.repeat(64), ...currentProtocolBinding(),
      actual: { attemptId: 'a', runId: 'r', rootActionId: 'root', projectId: 'p', epoch: 'e' } }
    const write = (event, options) => updateLedger(file, event, { campaignMode: 'synthetic', ...options })
    fs.writeFileSync(file, raw)
    assert.doesNotThrow(() => write({ type: 'reserve', attemptId: 'after-1d0bdac3', binding: current },
      { historicalPostUiBa2d34abBoundary: b1, historicalPostUi1d0bdac3Boundary: b2 }))
    fs.writeFileSync(file, raw)
    assert.throws(() => write({ type: 'reserve', attemptId: 'after-1d0bdac3', binding: current }, { historicalPostUiBa2d34abBoundary: b1 }), /PROTOCOL_DRIFT/)
    assert.throws(() => write({ type: 'reserve', attemptId: 'after-1d0bdac3', binding: current },
      { historicalPostUiBa2d34abBoundary: b1, historicalPostUi1d0bdac3Boundary: { ...b2, fromEventCount: 0 } }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // 跳过前一段直接登记本段：本段起点对不上链末端，拒绝。
    assert.throws(() => write({ type: 'reserve', attemptId: 'after-1d0bdac3', binding: current }, { historicalPostUi1d0bdac3Boundary: b2 }),
      /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    // 两臂绑定错位（baseline 值写成 candidate 的）：拒绝。
    assert.throws(() => write({ type: 'reserve', attemptId: 'after-1d0bdac3', binding: current }, { historicalPostUiBa2d34abBoundary: b1,
      historicalPostUi1d0bdac3Boundary: { ...b2, armBindings: { ...b2.armBindings, baseline: { ...b2.armBindings.baseline, codeSha: b2.armBindings.candidate.codeSha } } } }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    // 新协议下旧协议 hash 的新 reserve（未登记为历史）一律按当前协议拒绝。
    fs.writeFileSync(file, raw)
    assert.throws(() => write({ type: 'reserve', attemptId: 'stale-1d0bdac3', binding: { ...current, protocolHash: r61.protocolHash } },
      { historicalPostUiBa2d34abBoundary: b1, historicalPostUi1d0bdac3Boundary: b2 }), /PROTOCOL_DRIFT/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  const runner = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-run.mjs'), 'utf8')
  assert.match(runner, /validateHistoricalSupersessionBoundary\(raw, ba2d34ab, protocol\.historicalPostUi1d0bdac3Boundary\)/)
  assert.match(runner, /validateHistoricalSupersessionBoundary\(rawLedger, trustedBa2d34abEvents, r1d0bdac3Boundary\)/)
})

test('v5 独立评审 oracle 前向修订：计划可由正文新决定改变，硬事实（旧钟异常、钥匙、知情、时点）不放宽；其余 oracle 不变', () => {
  const oracles = selectPhase(protocol, 'c16-c18', 'final').caseOracles
  for (const caseId of ['C17-A', 'C17-B', 'C18-A', 'C18-B']) {
    const [text] = oracles[caseId].independentReview
    assert.match(text, /计划与决定（v5前向修订）/, caseId)
    assert.match(text, /记录上的日期与旧钟不符/, caseId)
    assert.match(text, /不得把核查对象替换为另一异常/, caseId)
    assert.match(text, /铜钥匙始终由林澄保管/, caseId)
    assert.match(text, /雨停前沈岸不知道信封内有地图/, caseId)
    assert.match(text, /清晨发现与第2章同日午后/, caseId)
  }
  for (const caseId of ['C17-A', 'C18-A', 'C18-B'])
    assert.match(oracles[caseId].independentReview[0], /“原定安排等待雨停”是人物的计划而非禁令.*只有未写出新决定或理由就把原计划当作已执行或已放弃，或与所选来源状态（核查尚未开始）矛盾，才判违规/)
  assert.match(oracles['C17-B'].independentReview[0], /林澄撤回旧核查安排，等待新通行许可；旧安排不得被写作已执行事实/)
  assert.match(oracles['C17-B'].independentReview[0], /未写出许可或新决定与理由，就按已撤回的旧安排（如雨停即出发核查）行动或把旧安排写成已执行，判违规/)
  assert.match(oracles['C18-B'].independentReview[0], /不混入未选择分支“沈岸独自把草图交给另一个看守”；此案不证明外部DAV服务/)
  // C16 三案的 oracle（提取 notes/cards 的计划状态记录）保持原文。
  assert.equal(oracles['C16-C'].independentReview[0], '两名独立评审各引更正后的定稿正文、notes和cards原文：核查尚未开始、原安排待雨停；旧版本的已安排或已实施叙述不得残留为当前事实')
  assert.equal(oracles['C16-A'].independentReview[0], '两名独立评审各引定稿正文、notes和cards原文：只记录实际核查遇阻与具体代价，不把待办核查写成已完成，人物、钥匙、知情和同日午后时点一致')
  assert.equal(oracles['C16-B'].independentReview[0], '两名独立评审各引含核查安排的定稿正文、notes和cards原文：安排仍是计划，提议不冒充作者批准的角色状态；人物和知情事实准确')
})

test('C16 ccc70b31 段（第433–507行）加性登记两次 C16–C18 失败与一次 post-UI，之后严格按当前协议', () => {
  const boundary = protocol.historicalC16Ccc70b31Boundary
  assert.deepEqual([boundary.fromEventCount, boundary.eventCount, boundary.reserveAttempts.length],
    [protocol.historicalC16Ee3435ecBoundary.eventCount, 507, 25])
  assert.equal(boundary.protocolRevision, protocolBinding.protocolRevision)
  assert.equal(boundary.protocolHash, '7f4206ca8fe137d72f2cafb0c9c739147e6f295caa06c08d5a3d44a0d7167092')
  assert.notEqual(boundary.protocolHash, protocolBinding.protocolHash, '新协议字节必须与被取代的 hash 不同')
  assert.deepEqual(Object.keys(boundary.armBindings), ['baseline', 'candidate'])
  assert.equal(boundary.armBindings.candidate.codeSha, 'ccc70b314744ab7a969c1f4f068e6596a1c37a7b')
  assert.deepEqual([...new Set(boundary.reserveAttempts.map(item => item.invocationId))],
    ['9cbac025-272e-489a-986a-e3fdf2568a04', 'ae397af2-216d-4014-bb89-4b50ac72ae03', '24c90aec-80c8-411a-85b0-783c824ae7af'])
  assert.ok(boundary.reserveAttempts.every(item => item.terminal === 'settle'
    && (item.attemptId.startsWith('baseline:') ? item.parityId === undefined : /^[a-f0-9]{64}$/.test(item.parityId))))
  // 真实账本只读认证：注册的活动工作树存在时，用当前协议的全部边界链回放，不写任何一行。
  const porcelain = spawnSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  let ledger = null
  try { ledger = path.join(registeredCampaignWorktree(porcelain.stdout), '.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl') } catch { ledger = null }
  if (ledger && fs.existsSync(ledger)) {
    const before = fs.readFileSync(ledger)
    assert.equal(validatePhysicalLedger(ledger), path.resolve(ledger))
    const raw = before.toString('utf8')
    let from = validateHistoricalLedgerBoundary(raw, protocol.historicalLedgerBoundary)
    for (const name of ['historicalSupersessionBoundary', 'historicalReviewedDraftBoundary', 'historicalReviewRebuildBoundary',
      'historicalS14BSplitBoundary', 'historicalPostUi408Boundary', 'historicalC16Ee3435ecBoundary', 'historicalC16Ccc70b31Boundary',
      'historicalC16C9b88510Boundary', 'historicalC16D8a30c11Boundary', 'historicalC16Ca466d9aBoundary', 'historicalC1673b46513Boundary'])
      from = validateHistoricalSupersessionBoundary(raw, from, protocol[name])
    assert.equal(from, 648)
    assert.ok(fs.readFileSync(ledger).equals(before), 'REAL_LEDGER_MUST_STAY_READ_ONLY')
  }
  // 合成账本：登记为历史时第508行起的当前 reserve 通过；未登记则同一段按当前协议被拒。
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/ccc70b31-boundary-'))
  try {
    const file = path.join(dir, 'synthetic-ledger.jsonl')
    const envelope = { campaignId: CAMPAIGN_ID, mode: 'synthetic', phase: 'c16-c18', milestone: 'final', caseId: 'C17-A', operation: '本地恢复后续写' }
    const old = { protocolRevision: boundary.protocolRevision, protocolHash: boundary.protocolHash }
    const attempts = [['candidate:294b7c84-0000-4000-8000-000000000001', '9'], ['baseline:4f82aefe-0000-4000-8000-000000000002', null]]
      .map(([attemptId, parity]) => ({ attemptId, invocationId: '9cbac025-272e-489a-986a-e3fdf2568a04', terminal: 'settle',
        ...(parity ? { parityId: parity.repeat(64) } : {}) }))
    const armBindings = { baseline: { codeSha: '1'.repeat(40), sourceHash: '2'.repeat(64), driverHash: '3'.repeat(64), parityId: '4'.repeat(64) },
      candidate: { codeSha: '5'.repeat(40), sourceHash: '6'.repeat(64), driverHash: '3'.repeat(64) } }
    const rows = attempts.flatMap(item => {
      const arm = item.attemptId.split(':')[0]
      return [{ type: 'reserve', attemptId: item.attemptId, binding: { ...envelope, arm, ...armBindings[arm], ...old,
        ...(item.parityId ? { parityId: item.parityId } : {}), invocationId: item.invocationId }, allocation: 'C17C18RestoreContinue' },
      { type: 'dispatch', attemptId: item.attemptId }, { type: 'settle', attemptId: item.attemptId, finishReason: 'stop' }]
    })
    const raw = rows.map(JSON.stringify).join('\n') + '\n'
    const registered = { fromEventCount: 0, eventCount: 6, rawBytesSha256: hash(raw), ...old, armBindings, reserveAttempts: attempts }
    assert.equal(validateHistoricalSupersessionBoundary(raw, 0, registered), 6)
    const current = { ...envelope, arm: 'candidate', codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(),
      parityId: 'c'.repeat(64), ...currentProtocolBinding(),
      actual: { attemptId: 'a', runId: 'r', rootActionId: 'root', projectId: 'p', epoch: 'e' } }
    fs.writeFileSync(file, raw)
    assert.doesNotThrow(() => updateLedger(file, { type: 'reserve', attemptId: 'after-ccc70b31', binding: current },
      { campaignMode: 'synthetic', historicalC16Ccc70b31Boundary: registered }))
    assert.throws(() => updateLedger(file, { type: 'dispatch', attemptId: 'after-ccc70b31' }, { campaignMode: 'synthetic' }), /PROTOCOL_DRIFT/)
    // 边界内的字节、终态或身份被改，均拒绝。
    assert.throws(() => validateHistoricalSupersessionBoundary(raw.replace('"settle"', '"unknown"'), 0, registered), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 0, { ...registered,
      armBindings: { ...armBindings, candidate: { ...armBindings.candidate, codeSha: 'ccc70b314744ab7a969c1f4f068e6596a1c37a7b' } } }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 0, { ...registered, protocolHash: protocolBinding.protocolHash }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('full registers six planning calls and eighteen chapters in frozen alternating order', () => {
  const scenario = PHASE_SCENARIOS.full
  assert.ok(scenario, 'FULL_SCENARIO_MISSING')
  assertScenarioMatchesProtocol(selectPhase(protocol, 'full', 'final'), scenario)
  assert.equal(protocol.phases.full.operations.find(item => item.kind === 'directory').minimumCalls, 6)
  assert.equal(protocol.phases.full.operations.find(item => item.kind === 'draft').minimumCalls, 18)
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/full-ledger-test-'))
  try {
    const file = path.join(dir, 'synthetic-ledger.jsonl')
    for (const [index, caseId] of protocol.phases.full.caseIds.entries()) {
      for (const arm of protocol.order.armsByChapter[index].split(',')) {
        for (const operation of scenario.operations.filter(item => item.kind === 'draft' || caseId.endsWith('/1'))) {
          const attemptId = `${arm}:${caseId}:${operation.id}`
          const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', ...protocolBinding, arm,
            codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
            phase: 'full', milestone: 'final', caseId, operation: operation.id,
            ...(arm === 'candidate' ? { actual: { attemptId, runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch' } } : {}) }
          updateLedger(file, { type: 'reserve', attemptId, binding }, { campaignMode: 'synthetic' })
          updateLedger(file, { type: 'dispatch', attemptId }, { campaignMode: 'synthetic' })
          updateLedger(file, { type: 'settle', attemptId }, { campaignMode: 'synthetic' })
        }
      }
    }
    const reserves = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.type === 'reserve')
    assert.equal(reserves.filter(row => row.allocation === 'finalPlanning').length, 6)
    assert.equal(reserves.filter(row => row.allocation === 'finalChapters').length, 18)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('full classification rejects missing chapters, wrong arm predecessors, failed operations and owner drift', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/full-receipt-test-'))
  try {
    const schedule = fullExecutionSchedule(protocol.order)
    assert.deepEqual(schedule.slice(0, 6).map(step => `${step.sceneId}:${step.arm}`),
      ['场景1:baseline', '场景1:candidate', '场景2:candidate', '场景2:baseline', '场景3:baseline', '场景3:candidate'])
    assert.deepEqual(schedule.slice(6).map(step => `${step.caseId}:${step.arm}`),
      protocol.phases.full.caseIds.flatMap((caseId, index) => protocol.order.armsByChapter[index].split(',').map(arm => `${caseId}:${arm}`)))
    const results = fullReceiptKit(dir).build()
    const classify = values => classifyFullProduction(values, { mode: 'synthetic', order: protocol.order })
    assert.equal(classify(results).status, 'passed')
    for (const [arm, accepted, rejected] of [
      ['candidate', [630, 680, 1170], [629, 1171]],
      ['baseline', [720, 1080], [680, 719, 1081]],
    ]) {
      for (const [units, pairFailure] of [...accepted.map(value => [value, undefined]),
        ...rejected.map(value => [value, 'FULL_DRAFT_INVALID'])]) {
        const changed = structuredClone(results)
        const draft = changed.find(result => result.arm === arm && result.draftObservation)
        draft.draftObservation.units = units
        draft.saved.units = units
        assert.equal(classify(changed).pairFailure, pairFailure, `${arm} ${units}`)
      }
    }
    assert.equal(classify(results.slice(0, -1)).pairFailure, 'FULL_OPERATION_COVERAGE_MISMATCH')
    for (const mutate of [
      copy => { copy[8].predecessor.projectId = 'another-arm' },
      copy => { copy[8].predecessor.version++ },
      copy => { copy[8].predecessor.contentHash = 'f'.repeat(64) },
      copy => { copy[8].status = 'failed' },
      copy => { copy[8].physicalProject.projectId = 'another-project' },
      copy => { copy[7].attempts[0].binding.actual.projectId = 'another-project' },
      copy => { copy[6].attempts[0].binding.baselineIpc.projectId = 'another-project' },
      copy => { copy[6].attempts[0].binding.milestone = 'early' },
      copy => { copy[8].saved.draftId = null },
    ]) {
      const changed = structuredClone(results); mutate(changed)
      assert.equal(classify(changed).status, 'failed')
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

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
test('draft reads this arm committed blueprint into ChapterInfo before generation', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  const start = fixture.indexOf('function readCommittedDraftChapterInfo(')
  const end = fixture.indexOf('const syntheticReview =', start)
  assert.ok(start >= 0 && end > start, 'DRAFT_BLUEPRINT_READBACK_MISSING')
  const sandbox = { assert }
  vm.runInNewContext(`${fixture.slice(start, end)}\nthis.readCommittedDraftChapterInfo = readCommittedDraftChapterInfo; this.draftPromptIncludesCommittedBlueprint = draftPromptIncludesCommittedBlueprint`, sandbox)
  const row = { chapterNumber: 1, title: '旧港来信', role: '建置', purpose: '发现异常',
    keyEvents: '取出铜钥匙，辨认被雨浸湿的地图', characters: '["林澄","沈岸"]', suspenseHook: '辨认沉船邮戳', userGuidance: '' }
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE blueprints (chapter_number INTEGER PRIMARY KEY,title TEXT,role TEXT,purpose TEXT,
      key_events TEXT,characters TEXT,suspense_hook TEXT,user_guidance TEXT)`)
    db.prepare('INSERT INTO blueprints VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(row))
    const actual = sandbox.readCommittedDraftChapterInfo(db, { number: 1, targetUnits: 900 }, '/this-arm/project', '尚未实施的方案不得写为既成事实')
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), {
      projectPath: '/this-arm/project', chapterNumber: 1, title: '旧港来信', role: '建置', purpose: '发现异常',
      characters: ['林澄', '沈岸'], keyEvents: row.keyEvents, suspenseHook: row.suspenseHook,
      userGuidance: '尚未实施的方案不得写为既成事实', wordsTarget: 900,
    })
    const sent = { userGuidance: actual.userGuidance, suspenseHook: actual.suspenseHook,
      keyEvents: actual.keyEvents, characters: actual.characters, purpose: actual.purpose,
      role: actual.role, title: actual.title, chapterNumber: actual.chapterNumber }
    const oldInfo = { ...sent, keyEvents: '发现异常；决定核查', purpose: '', suspenseHook: '' }
    const authorMaterial = `作者材料中引用的完整预期 JSON：\n${JSON.stringify(sent)}`
    for (const [purpose, heading, next] of [
      ['chapter-draft', '【本章信息】', '【后续章节大纲预告】'],
      ['chapter-draft-continuation', '【本章蓝图】', '【全局写作要求】'],
      ['chapter-draft-no-progress-recovery', '【本章蓝图】', '【全局写作要求】'],
      ['chapter-draft-condense', '【本章蓝图】', '【全局写作要求】'],
    ]) {
      const prompt = info => `${authorMaterial}\n\n${heading}\n${JSON.stringify(info, null, 4)}\n\n${next}\n后续内容`
      assert.equal(sandbox.draftPromptIncludesCommittedBlueprint(prompt(oldInfo), actual, purpose), false,
        `${purpose}:旁边的完整作者材料不得替代权威 ChapterInfo`)
      assert.equal(sandbox.draftPromptIncludesCommittedBlueprint(prompt(sent), actual, purpose), true,
        `${purpose}:合法缩进与字段顺序应通过`)
      assert.equal(sandbox.draftPromptIncludesCommittedBlueprint(prompt({ ...sent, chapterNumber: '1' }), actual, purpose), false)
      assert.equal(sandbox.draftPromptIncludesCommittedBlueprint(prompt({ ...sent, characters: '林澄,沈岸' }), actual, purpose), false)
    }
    // 压缩请求不能只带蓝图后直接接待压缩正文而缺少全局写作要求；未登记用途一律拒绝。
    const condenseSent = { ...actual }
    delete condenseSent.projectPath
    delete condenseSent.wordsTarget
    const blueprintBlock = next => `前置\n【本章蓝图】\n${JSON.stringify(condenseSent)}\n\n${next}\n正文`
    assert.equal(sandbox.draftPromptIncludesCommittedBlueprint(blueprintBlock('【全局写作要求】'), actual, 'chapter-draft-condense'), true)
    assert.equal(sandbox.draftPromptIncludesCommittedBlueprint(blueprintBlock('【待压缩正文】'), actual, 'chapter-draft-condense'), false)
    assert.equal(sandbox.draftPromptIncludesCommittedBlueprint(blueprintBlock('【全局写作要求】'), actual, 'chapter-draft-rewrite'), false)
    // 产品删去空的【后续章节大纲预告】整段后，初始请求的蓝图块止于下一个标题；夹带非 JSON 文本仍拒绝。
    const initialBlock = next => `前置\n【本章信息】\n${JSON.stringify(condenseSent, null, 2)}\n\n${next}\n正文`
    assert.equal(sandbox.draftPromptIncludesCommittedBlueprint(initialBlock('【网文连载更新核心法则】'), actual, 'chapter-draft'), true)
    assert.equal(sandbox.draftPromptIncludesCommittedBlueprint(initialBlock('补充说明\n【后续章节大纲预告】'), actual, 'chapter-draft'), false)
    assert.equal(sandbox.draftPromptIncludesCommittedBlueprint(initialBlock('【网文连载更新核心法则】'), actual, 'chapter-draft-continuation'), false)
    db.prepare('INSERT INTO blueprints VALUES(?,?,?,?,?,?,?,?)').run(3, '作者预置第三章', '发展', '依据证据选择',
      '留下后果', '["林澄"]', '', '本章时点：翌日清晨')
    const preset = sandbox.readCommittedDraftChapterInfo(db, { number: 3, targetUnits: 2000 }, '/this-arm/project', '本章时点：翌日清晨')
    assert.equal(preset.keyEvents, '留下后果')
    assert.equal(preset.userGuidance, '本章时点：翌日清晨')
    assert.equal(preset.wordsTarget, 2000)
    assert.equal(sandbox.draftPromptIncludesCommittedBlueprint(
      `前置正文\n\n【本章写作方向与核心任务】\n${JSON.stringify(preset)}\n\n【后续章节大纲预告】`, preset, 'chapter-draft'), true)
    db.prepare('UPDATE blueprints SET characters=? WHERE chapter_number=1').run('{')
    assert.throws(() => sandbox.readCommittedDraftChapterInfo(db, { number: 1, targetUnits: 900 }, '/this-arm/project', ''),
      /DRAFT_COMMITTED_BLUEPRINT_INVALID/)
    db.prepare('DELETE FROM blueprints WHERE chapter_number=1').run()
    assert.throws(() => sandbox.readCommittedDraftChapterInfo(db, { number: 1, targetUnits: 900 }, '/this-arm/project', ''),
      /DRAFT_COMMITTED_BLUEPRINT_REQUIRED/)
  } finally { db.close() }
  const draftBranch = fixture.slice(fixture.indexOf("else if (operationKind === 'draft') command ="),
    fixture.indexOf('       else {', fixture.indexOf("else if (operationKind === 'draft') command =")))
  assert.match(draftBranch, /readCommittedDraftChapterInfo\(db, chapter, project\.rootPath, chapterGuidance\)/)
})
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
  assert.equal(protocol.decisionRevision, 's14b-candidate-quality-and-comparison-v2')
  assert.equal(protocol.decisionPolicy.baselineContentValidity, 'independent-from-candidate-absolute-gates')
  assert.equal(protocol.decisionPolicy.baselineTechnicalEndpoint, 'required')
  assert.equal(protocol.decisionPolicy.candidateAbsoluteResult, 'independent-oracle-only')
  assert.match(protocol.oracle.candidateReadability, /自然度.*人物动机.*节奏/)
  assert.match(protocol.oracle.candidateReadability, /证据不足.*INCONCLUSIVE/)
  assert.match(protocol.oracle.relativeComparison, /不可比.*INCONCLUSIVE/)
  assert.deepEqual(protocol.oracle.pacingReadability.appliesTo, ['post-ui', 'final'])
  assert.equal(protocol.oracle.pacingReadability.requirements.length, 4)
  assert.match(protocol.oracle.relativeComparison, /不自动否决已过绝对门的candidate/)
  assert.match(protocol.oracle.relativeComparison, /不能凭局部改善称整体non-inferior/)
  assert.match(protocol.oracle.improvement, /不可比维度不得称改善/)
  assert.equal(protocol.phases['early-budget'].scenarioRevision, 's14b-post-ui-budget-syntax-repair-v1')
  assert.deepEqual(protocol.phases['early-budget'].attemptPolicy, PHASE_SCENARIOS['early-budget'].attemptPolicy)
  assert.doesNotThrow(() => assertScenarioMatchesProtocol(selectPhase(protocol, 'early-budget', 'post-ui'), productionScenario('early-budget', 'post-ui')))
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
  assert.doesNotThrow(() => assertScenarioMatchesProtocol(selectPhase(protocol, 'full', 'final'), PHASE_SCENARIOS.full))
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

test('post-UI 指定范围只允许真实 owner 的一次结构化语法修复', () => {
  const policy = { milestone: 'post-ui', arms: ['baseline', 'candidate'], operationId: '指定范围生成',
    primaryPurpose: 'chapter-blueprint-directory', repairPurpose: 'chapter-blueprint-directory:structured-syntax-repair', maxRepairAttempts: 1 }
  const rejected = []
  const gate = createOperationDispatchGate({ repairPolicy: policy, onReject: item => rejected.push(item) })
  const owner = { attemptId: 'main', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch', purpose: policy.primaryPurpose }
  assert.doesNotThrow(() => gate(policy.operationId, owner))
  assert.throws(() => gate(policy.operationId, { ...owner, attemptId: 'repair', purpose: policy.repairPurpose }),
    error => error.code === 'OPERATION_DISPATCH_REJECTED')
  for (const actual of [undefined, { ...owner, attemptId: 'third', purpose: policy.repairPurpose },
    { ...owner, attemptId: 'other', purpose: 'chapter-blueprint-directory:automatic-retry' }])
    assert.throws(() => gate(policy.operationId, actual), error => error.code === 'OPERATION_DISPATCH_REJECTED')
  assert.equal(rejected.length, 4)
  for (const actual of [{ ...owner, attemptId: 'repair', rootActionId: 'foreign', purpose: policy.repairPurpose },
    { ...owner, attemptId: 'repair', runId: 'foreign', purpose: policy.repairPurpose }]) {
    const isolated = createOperationDispatchGate({ repairPolicy: policy })
    isolated(policy.operationId, owner)
    assert.throws(() => isolated(policy.operationId, actual), error => error.code === 'OPERATION_DISPATCH_REJECTED')
  }
  const noPolicy = createOperationDispatchGate()
  noPolicy(policy.operationId, owner)
  assert.throws(() => noPolicy(policy.operationId, { ...owner, attemptId: 'repair', purpose: policy.repairPurpose }),
    error => error.code === 'OPERATION_DISPATCH_REJECTED')
  const baseline = createOperationDispatchGate({ repairPolicy: policy })
  const ipc = { attemptId: 'ipc-main', runId: 'bridge-run', projectId: 'project', epoch: 'epoch', purpose: policy.primaryPurpose }
  baseline(policy.operationId, ipc)
  assert.throws(() => baseline(policy.operationId, { ...ipc, attemptId: 'ipc-repair', purpose: policy.repairPurpose }),
    error => error.code === 'OPERATION_DISPATCH_REJECTED')
  assert.throws(() => createOperationDispatchGate({ repairPolicy: policy })(policy.operationId),
    error => error.code === 'OPERATION_DISPATCH_REJECTED')
})

test('syntax repair gate requires settled malformed primary output, not purpose alone', () => {
  fs.mkdirSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization'), { recursive: true })
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/repair-proof-test-'))
  const policy = PHASE_SCENARIOS['early-budget'].attemptPolicy
  const primary = { attemptId: 'main', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch', purpose: policy.primaryPurpose }
  const outputPath = path.join(dir, 'primary.txt')
  const evidence = (content, terminal = 'settle', identity = primary, arm = 'candidate') => {
    fs.writeFileSync(outputPath, content)
    const attemptId = `${arm}:${identity.attemptId}`
    const binding = { operation: policy.operationId, ...(arm === 'candidate' ? { actual: identity } : { baselineIpc: identity }) }
    return { attempt: { attemptId, binding, outputPath, visibleTextHash: hash(content) },
      events: [{ type: 'reserve', attemptId, binding },
        { type: 'dispatch', attemptId }, { type: terminal, attemptId, finishReason: 'stop' }] }
  }
  const dispatch = (proof, identity = primary) => {
    const gate = createOperationDispatchGate({ repairPolicy: policy, readPrimaryEvidence: () => proof })
    gate(policy.operationId, identity)
    return () => gate(policy.operationId, { ...identity, attemptId: 'repair', purpose: policy.repairPurpose })
  }
  try {
    assert.throws(dispatch(evidence('{"blueprints":[]}')), /MODEL_REQUEST_REJECTED/, 'valid JSON cannot trigger repair')
    assert.throws(dispatch(null), /MODEL_REQUEST_REJECTED/, 'missing primary output cannot trigger repair')
    assert.throws(dispatch(evidence('{"blueprints":[', 'dispatch')), /MODEL_REQUEST_REJECTED/, 'unsettled primary cannot trigger repair')
    const forged = evidence('{"blueprints":[')
    forged.attempt.visibleTextHash = '0'.repeat(64)
    assert.throws(dispatch(forged), /MODEL_REQUEST_REJECTED/, 'unverified output hash cannot trigger repair')
    const fake = createOperationDispatchGate({ repairPolicy: policy, readPrimaryEvidence: () => evidence('{"blueprints":[') })
    fake(policy.operationId, primary)
    assert.throws(() => fake(policy.operationId, { ...primary, attemptId: 'fake', purpose: 'chapter-blueprint-directory:automatic-retry' }),
      /MODEL_REQUEST_REJECTED/, 'a different retry purpose cannot use valid syntax proof')
    const accepted = dispatch(evidence('{"blueprints":['))
    assert.doesNotThrow(accepted, 'settled malformed JSON permits one repair')
    assert.throws(accepted, /MODEL_REQUEST_REJECTED/, 'third physical request remains denied')
    const ipc = { attemptId: 'ipc-main', runId: 'bridge-run', projectId: 'project', epoch: 'epoch', purpose: policy.primaryPurpose }
    assert.doesNotThrow(dispatch(evidence('{"blueprints":[', 'settle', ipc, 'baseline'), ipc),
      'baseline IPC purpose and request identity follow the same syntax rule')

    const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
    const proofStart = fixture.indexOf('readPrimaryEvidence: first => {') + 'readPrimaryEvidence: first => {'.length
    const proofEnd = fixture.indexOf('    }, onReject:', proofStart)
    const gateCall = fixture.indexOf('      beforeOperationDispatch(operationId, actual ?? observedIpc, reviewSource)')
    const repairStart = fixture.indexOf('      const structuredSyntaxRepair =', gateCall)
    const repairEnd = fixture.indexOf('      const attemptId =', repairStart)
    const checkStart = fixture.indexOf("      if (operationKind === 'recheck' && candidate)")
    const checkEnd = fixture.indexOf("      if (candidate && request.phase === 'early-context')", checkStart)
    const reserve = fixture.indexOf("record({ type: 'reserve', attemptId, binding })", checkEnd)
    const evidenceStart = fixture.indexOf('authorityEvidence: operationKind ===') + 'authorityEvidence: '.length
    const evidenceEnd = fixture.indexOf('\n        userPromptHash,', evidenceStart)
    assert.ok(proofStart > 0 && proofEnd > proofStart && gateCall > 0 && repairStart > gateCall
      && repairEnd > repairStart && checkStart > repairEnd && checkEnd > checkStart && reserve > checkEnd
      && evidenceStart > 0 && evidenceEnd > evidenceStart)
    const readPrimaryEvidence = new Function('first', 'receipt', 'request', 'authorityFacts', 'sha', 'fs', 'target',
      `const continuityRun = false, operationKind = 'directory';\n${fixture.slice(proofStart, proofEnd)}`)
    const isStructuredSyntaxRepair = new Function('repairPolicy', 'operationId', 'actual', 'observedIpc',
      `${fixture.slice(repairStart, repairEnd)}\nreturn structuredSyntaxRepair`)
    const checkAuthority = new Function('operationKind', 'candidate', 'request', 'db', 'chapter', 'promptText',
      'preflight', 'authorityFacts', 'predecessorReadbacks', 'naturalPredecessorText', 'scene', 'structuredSyntaxRepair',
      `const fullRun = request.phase === 'full', continuityRun = false, reviewedRun = false;\n${fixture.slice(checkStart, checkEnd)}`)
    const readAuthorityEvidence = new Function('operationKind', 'candidate', 'request', 'authorityFacts', 'sha',
      'promptText', 'structuredSyntaxRepair', 'predecessorReadbacks', 'db', 'chapter',
      `const continuityRun = false, reviewedRun = false; return ${fixture.slice(evidenceStart, evidenceEnd).trim().replace(/,$/, '')}`)
    const facts = ['fact sent', 'fact absent from repair']
    const request = { phase: 'early-budget', chapterNumber: 1 }
    const ledgerPath = path.join(dir, 'ledger.jsonl')
    for (const [arm, identity] of [['baseline', ipc], ['candidate', primary]]) {
      const proof = evidence('{"blueprints":[', 'settle', identity, arm)
      proof.attempt.authorityEvidence = { factHashes: facts.map(hash), allFactsSent: false }
      fs.writeFileSync(ledgerPath, proof.events.map(event => JSON.stringify(event)).join('\n') + '\n')
      const priorReader = first => readPrimaryEvidence(first, { attempts: [proof.attempt] }, { ledgerPath }, facts,
        hash, fs, { arm })
      const withoutAncestry = createOperationDispatchGate({ repairPolicy: policy, readPrimaryEvidence: priorReader })
      withoutAncestry(policy.operationId, identity)
      assert.throws(() => withoutAncestry(policy.operationId,
        { ...identity, attemptId: 'repair', purpose: policy.repairPurpose }), /MODEL_REQUEST_REJECTED/,
      'a malformed output without a fully authorized primary cannot license repair')
      proof.attempt.authorityEvidence.allFactsSent = true
      proof.attempt.authorityEvidence.factHashes[0] = '0'.repeat(64)
      const wrongAuthority = createOperationDispatchGate({ repairPolicy: policy, readPrimaryEvidence: priorReader })
      wrongAuthority(policy.operationId, identity)
      assert.throws(() => wrongAuthority(policy.operationId,
        { ...identity, attemptId: 'repair', purpose: policy.repairPurpose }), /MODEL_REQUEST_REJECTED/)
      proof.attempt.authorityEvidence.factHashes = facts.map(hash)
      const authorized = createOperationDispatchGate({ repairPolicy: policy, readPrimaryEvidence: priorReader })
      authorized(policy.operationId, identity)
      const repairOwner = { ...identity, attemptId: 'repair', purpose: policy.repairPurpose }
      assert.doesNotThrow(() => authorized(policy.operationId, repairOwner))
      const ownerFor = value => [arm === 'candidate' ? value : null, arm === 'baseline' ? value : null]
      const primaryFlag = isStructuredSyntaxRepair(policy, policy.operationId, ...ownerFor(identity))
      const repairFlag = isStructuredSyntaxRepair(policy, policy.operationId, ...ownerFor(repairOwner))
      assert.equal(primaryFlag, false)
      assert.equal(repairFlag, true)
      const check = (promptText, structuredSyntaxRepair) => checkAuthority('directory', arm === 'candidate', request,
        null, null, promptText, createOutboundPreflightAssert([]), facts, [], () => '', {}, structuredSyntaxRepair)
      assert.throws(() => check(facts[0], primaryFlag), /OUTBOUND_ORACLE_AUTHORITY_MISSING/,
        'ordinary generation still needs every author fact')
      assert.doesNotThrow(() => check(facts.join('\n'), primaryFlag))
      assert.doesNotThrow(() => check(facts[0], repairFlag), 'authorized syntax repair is not a new author generation')
      assert.equal(readAuthorityEvidence('directory', arm === 'candidate', request, facts, hash,
        facts[0], repairFlag, [], null, null).allFactsSent, false)
      assert.equal(readAuthorityEvidence('directory', arm === 'candidate', request, facts, hash,
        facts.join('\n'), primaryFlag, [], null, null).allFactsSent, true)
    }
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(ROOT, '.runtime/.cache/novel-quality-modernization') + path.sep))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('post-UI 首审只以已结算的同稿产品解析失败许可一次重建', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/review-rebuild-proof-'))
  const policy = PHASE_SCENARIOS['early-budget'].attemptPolicy
  const review = policy.reviewRebuild
  const source = { draftId: 7, contentHash: hash('原始待审正文') }
  const owner = { attemptId: 'main', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch', purpose: review.primaryPurpose }
  const malformed = '```json\n{"items":[{"description":"提到"开船过去""}]}\n```'
  const schemaInvalid = '```json\n{"summary":"无问题","items":[{"category":"事实","severity":"pass"}]}\n```'
  const adverse = '```json\n{"summary":"不利","items":[{"category":"事实","severity":"error","description":"事实冲突","quote":"正文原句"}]}\n```'
  const unknown = '```json\n{"summary":"未知","items":[{"category":"事实","severity":"pass","description":"该项无问题"}],"goalReviews":[{"id":"ch1:keyEvents:1","status":"unknown","description":"证据不足","evidence":[]}]}\n```'
  let outputNumber = 0
  const proof = (content, { arm = 'baseline', terminal = 'settle', absent = true, sourceBinding = source } = {}) => {
    const outputPath = path.join(dir, `physical-output-${++outputNumber}.txt`)
    fs.writeFileSync(outputPath, content)
    const identity = arm === 'baseline' ? { ...owner, operationId: review.operationId } : owner
    const attemptId = `${arm}:${identity.attemptId}`
    const binding = { operation: review.operationId, reviewSource: sourceBinding,
      ...(arm === 'baseline' ? { baselineIpc: identity } : { actual: identity }) }
    return { attempt: { attemptId, binding, outputPath, visibleTextHash: hash(content) }, reviewReportAbsent: absent,
      events: [{ type: 'reserve', attemptId, binding }, { type: 'dispatch', attemptId },
        { type: terminal, attemptId, finishReason: 'stop' }] }
  }
  const run = (evidence, { arm = 'baseline', next = {}, nextSource = source } = {}) => {
    const first = arm === 'baseline' ? { ...owner, operationId: review.operationId } : owner
    const gate = createOperationDispatchGate({ repairPolicy: policy, readPrimaryEvidence: () => evidence })
    gate(review.operationId, first, source)
    return () => gate(review.operationId,
      { ...first, attemptId: 'rebuild', purpose: review.repairPurpose, ...next }, nextSource)
  }
  try {
    assert.throws(() => parseReviewGenerationResult(schemaInvalid), /invalid review contract/)
    assert.doesNotThrow(() => parseReviewGenerationResult(adverse))
    assert.doesNotThrow(() => parseReviewGenerationResult(unknown))
    const actual = proof(malformed)
    const accepted = run(actual)
    assert.doesNotThrow(accepted, 'the captured invalid fenced JSON shape can rebuild')
    assert.throws(accepted, /MODEL_REQUEST_REJECTED/, 'a second rebuild is rejected before reserve')
    assert.doesNotThrow(run(proof(malformed, { arm: 'candidate' }), { arm: 'candidate' }))
    const invalidShape = run(proof(schemaInvalid))
    assert.doesNotThrow(invalidShape, 'product-rejected schema may rebuild once')
    assert.throws(invalidShape, /MODEL_REQUEST_REJECTED/, 'a second schema rebuild is rejected before reserve')
    const savedOutput = process.env.S14B_REVIEW_INVALID_OUTPUT
    if (savedOutput) {
      const captured = fs.readFileSync(savedOutput, 'utf8')
      assert.equal(hash(captured), 'e167529f761c3a33b3ea0582268fa9d544c7965a0b7db55b73738a1fcb0da770')
      assert.throws(() => parseReviewGenerationResult(captured), /invalid review contract/)
      const capturedAttempt = run(proof(captured))
      assert.doesNotThrow(capturedAttempt, 'saved d9f755e1 response may rebuild once')
      assert.throws(capturedAttempt, /MODEL_REQUEST_REJECTED/)
    }
    for (const [label, evidence] of [
      ['valid unfavorable review', proof(adverse)],
      ['valid unknown review', proof(unknown)],
      ['thinking wrapper needs product redaction', proof('<think>analysis</think>```json\n{"items":[]}\n```')],
      ['unsettled primary', proof(malformed, { terminal: 'dispatch' })],
      ['already saved review', proof(malformed, { absent: false })],
      ['wrong source', proof(malformed, { sourceBinding: { ...source, draftId: 8 } })],
    ]) assert.throws(run(evidence), /MODEL_REQUEST_REJECTED/, label)
    const forged = proof(malformed)
    forged.attempt.visibleTextHash = '0'.repeat(64)
    assert.throws(run(forged), /MODEL_REQUEST_REJECTED/, 'changed physical output is rejected')
    for (const next of [{ purpose: 'review-chapter-retry' }, { runId: 'other' }, { rootActionId: 'other' },
      { projectId: 'other' }, { epoch: 'other' }])
      assert.throws(run(proof(malformed), { next }), /MODEL_REQUEST_REJECTED/)
    assert.throws(run(proof(malformed), { nextSource: { ...source, contentHash: hash('另一稿') } }),
      /MODEL_REQUEST_REJECTED/, 'review source cannot change')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
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
    fs.writeFileSync(path.join(source, 'models.json'), JSON.stringify(profiles[0]))
    copyIsolatedRealModelConfig({ roots: { config: source }, modelId: 'approved' }, { config: isolated })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(isolated, 'models.json'), 'utf8')), [profiles[0]])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('冻结执行验证拒绝adapter、Node版本/ABI、依赖、启动参数、native旁证篡改', { timeout: 20_000 }, () => {
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
  db.exec('CREATE TABLE generation_runs(run_id TEXT,root_action_id TEXT,binding_json TEXT); CREATE TABLE generation_attempts(attempt_id TEXT,run_id TEXT,root_action_id TEXT,attempt_json TEXT,usage_receipt_json TEXT)')
  const session = { projectId: 'project', leaseId: 'epoch' }, handle = { projectId: 'project', epoch: 'epoch', rootActionId: 'root', runId: 'run' }
  const body = { max_tokens: 4096 }
  try {
    assert.throws(() => selectOwnerDispatch(db, handle, session, body), /NON_UNIQUE/)
    db.prepare('INSERT INTO generation_runs VALUES(?,?,?)').run('run', 'root', JSON.stringify({ projectId: 'project', epoch: 'epoch' }))
    db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?)').run('attempt', 'run', 'root', JSON.stringify({ attemptId: 'attempt', status: 'dispatch-marked', requestedOutputTokens: 4096 }), JSON.stringify({ purpose: 'chapter-blueprint-directory:structured-syntax-repair' }))
    assert.equal(selectOwnerDispatch(db, handle, session, body).attemptId, 'attempt')
    assert.equal(selectOwnerDispatch(db, handle, session, body).purpose, 'chapter-blueprint-directory:structured-syntax-repair')
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

test('旧 post-UI 十二行只按精确前缀继承，边界外旧 revision 仍拒绝', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/supersession-test-'))
  const file = path.join(dir, 'synthetic-ledger.jsonl')
  const invocationId = 'f090a41e-9a4e-4868-beec-88f6fe08db82'
  const oldHash = '74c26ce61ed3cff96c811da2b537776fe4470924af3c33e52ec8db93023e1c51'
  const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'baseline', codeSha: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
    phase: 'early-budget', milestone: 'post-ui', caseId: '场景1/1', operation: '指定范围生成' }
  const old = { ...binding, protocolRevision: 'pacing-readability-v1', protocolHash: oldHash, invocationId }
  const rows = [
    { type: 'reserve', attemptId: 'frozen-old', binding, allocation: 'postUiBudget' },
    { type: 'dispatch', attemptId: 'frozen-old' },
    { type: 'settle', attemptId: 'frozen-old' },
    { type: 'reserve', attemptId: 'superseded-old', binding: old, allocation: 'failedRetryRepairReviewReserve' },
    { type: 'dispatch', attemptId: 'superseded-old' },
    { type: 'settle', attemptId: 'superseded-old' },
  ]
  const prefix = count => `${rows.slice(0, count).map(JSON.stringify).join('\n')}\n`
  const original = prefix(6)
  const options = { campaignMode: 'synthetic', historicalLedgerBoundary: {
    eventCount: 3, rawBytesSha256: hash(prefix(3)), evidenceInvocationId: invocationId,
    finalReserveAttemptIds: ['frozen-old'],
  }, historicalSupersessionBoundary: {
    fromEventCount: 3, eventCount: 6, rawBytesSha256: hash(original),
    protocolRevision: old.protocolRevision, protocolHash: oldHash,
    evidenceInvocationId: invocationId, reserveAttemptIds: ['superseded-old'],
  } }
  const current = { ...binding, ...protocolBinding, invocationId }
  const append = attemptId => updateLedger(file, { type: 'reserve', attemptId, binding: current }, options)
  try {
    fs.writeFileSync(file, original)
    assert.doesNotThrow(() => append('current'))
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 7)
    for (const mismatch of [
      { protocolHash: '0'.repeat(64) },
      { evidenceInvocationId: 'e8900180-945a-4211-b0c9-8427389c0625' },
      { reserveAttemptIds: ['another-attempt'] },
    ]) {
      assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'wrong-boundary', binding: current }, {
        ...options, historicalSupersessionBoundary: { ...options.historicalSupersessionBoundary, ...mismatch },
      }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    fs.writeFileSync(file, original.replace('superseded-old', 'tampered-old'))
    assert.throws(() => append('tampered'), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, original + JSON.stringify({ type: 'reserve', attemptId: 'unknown-revision',
      binding: { ...old, protocolRevision: 'unknown-old-v9' }, allocation: 'postUiBudget' }) + '\n')
    assert.throws(() => append('after-unknown'), /PROTOCOL_DRIFT/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('旧 reviewed-draft 段认证两次 invocation 和末项 unknown', () => {
  const attempts = [
    { attemptId: 'baseline:old-a', invocationId: '577497d2-0862-476c-9cee-839a6fce7c11', terminal: 'settle' },
    { attemptId: 'candidate:old-b', invocationId: '13f33d55-016a-4db1-9993-c62f8f122ed7', terminal: 'unknown' },
  ]
  const old = { protocolRevision: 's14b-reviewed-draft-v1', protocolHash: 'a'.repeat(64) }
  const rows = attempts.flatMap(item => [{ type: 'reserve', attemptId: item.attemptId,
    binding: { ...old, invocationId: item.invocationId } },
  { type: 'dispatch', attemptId: item.attemptId }, { type: item.terminal, attemptId: item.attemptId }])
  const raw = rows.map(JSON.stringify).join('\n') + '\n'
  const boundary = { fromEventCount: 0, eventCount: 6, rawBytesSha256: hash(raw), ...old, reserveAttempts: attempts }
  assert.equal(validateHistoricalSupersessionBoundary(raw, 0, boundary), 6)
  assert.throws(() => validateHistoricalSupersessionBoundary(raw, 0, { ...boundary,
    reserveAttempts: attempts.map(item => ({ ...item, terminal: 'settle' })) }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
  assert.throws(() => validateHistoricalSupersessionBoundary(raw, 0, { ...boundary,
    reserveAttempts: [{ ...attempts[0], invocationId: attempts[1].invocationId }, attempts[1]] }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
  assert.throws(() => validateHistoricalSupersessionBoundary(raw.replace('unknown', 'settle'), 0, boundary), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
  assert.throws(() => validateHistoricalSupersessionBoundary(raw, 0, { ...boundary,
    reserveAttempts: [...attempts, attempts[0]] }), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
})

test('S14B 新 revision 认证历史末段并在账本读写两入口拒绝漂移', () => {
  const boundary = protocol.historicalS14BSplitBoundary
  assert.equal(boundary.fromEventCount, 345)
  assert.equal(boundary.eventCount, 390)
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/split-boundary-'))
  const ledger = path.join(dir, '.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl')
  const file = path.join(dir, 'synthetic-ledger.jsonl')
  const archive = ['historicalSupersessionBoundary', 'historicalReviewedDraftBoundary',
    'historicalReviewRebuildBoundary', 'historicalS14BSplitBoundary', 'historicalPostUi408Boundary',
    'historicalC16Ee3435ecBoundary', 'historicalC16Ccc70b31Boundary', 'historicalC16C9b88510Boundary', 'historicalC16D8a30c11Boundary',
    'historicalC16Ca466d9aBoundary', 'historicalC1673b46513Boundary', 'historicalC16Fa8806d7Boundary', 'historicalC16B42cfc55Boundary',
    'historicalC1667a57c04Boundary', 'historicalC162867cfa4Boundary', 'historicalPostUiBa2d34abBoundary', 'historicalPostUi1d0bdac3Boundary',
    'historicalC16Ac3af420Boundary', 'historicalC16A9552e67Boundary', 'historicalC1663a44636Boundary', 'historicalC16A4d2b6edBoundary', 'historicalC160917fb36Boundary', 'historicalC161aa5487eBoundary', 'historicalC169337909dBoundary', 'historicalSharedInput7203443dBoundary', 'historicalC1670407421Boundary']
  const fixture = mode => {
    const binding = { campaignId: CAMPAIGN_ID, mode, arm: 'baseline', codeSha: 'a'.repeat(40),
      sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
      phase: 'early-budget', milestone: 'early', caseId: '场景1/1', operation: '指定范围生成' }
    const rows = []
    const triplet = (attemptId, extra = {}, terminal = 'settle') => rows.push(
      { type: 'reserve', attemptId, binding: { ...binding, ...extra }, allocation: 'earlyBudget' },
      { type: 'dispatch', attemptId }, { type: terminal, attemptId })
    const frozen = Array.from({ length: protocol.historicalLedgerBoundary.eventCount / 3 }, (_, index) => `frozen-${index}`)
    frozen.splice(-protocol.historicalLedgerBoundary.finalReserveAttemptIds.length,
      protocol.historicalLedgerBoundary.finalReserveAttemptIds.length,
      ...protocol.historicalLedgerBoundary.finalReserveAttemptIds)
    frozen.forEach(id => triplet(id))
    const boundaries = { historicalLedgerBoundary: { ...protocol.historicalLedgerBoundary,
      rawBytesSha256: hash(rows.map(JSON.stringify).join('\n') + '\n') } }
    for (const name of archive) {
      const original = protocol[name]
      const attempts = original.reserveAttempts ?? original.reserveAttemptIds.map(attemptId => ({
        attemptId, invocationId: original.evidenceInvocationId, terminal: 'settle' }))
      for (const item of attempts) {
        const arm = item.attemptId.split(':')[0]
        triplet(item.attemptId, { protocolRevision: original.protocolRevision,
          protocolHash: original.protocolHash, invocationId: item.invocationId,
          ...(original.armBindings ? { arm, ...original.armBindings[arm] } : {}),
          ...(item.parityId ? { parityId: item.parityId } : {}) }, item.terminal)
      }
      boundaries[name] = { ...original, rawBytesSha256: hash(rows.map(JSON.stringify).join('\n') + '\n') }
    }
    return { raw: rows.map(JSON.stringify).join('\n') + '\n', boundaries, binding }
  }
  const real = fixture('real'), synthetic = fixture('synthetic')
  const protocolBytes = Buffer.from(JSON.stringify({ ...protocol, ...real.boundaries }))
  const gitDir = spawnSync('git', ['-C', ROOT, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' })
  assert.equal(gitDir.status, 0)
  const originalSpawn = childProcess.spawnSync, originalRead = fs.readFileSync
  try {
    fs.mkdirSync(path.dirname(ledger), { recursive: true })
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir.stdout.trim()}\n`)
    fs.writeFileSync(ledger, real.raw)
    // Test-only inventory and protocol bytes; the real entry still checks the Git common dir,
    // canonical ledger path, file identity and every historical boundary.
    childProcess.spawnSync = function (command, args, options) {
      if (command === 'git' && args?.slice(-3).join(' ') === 'worktree list --porcelain')
        return { status: 0, stdout: `worktree ${dir}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/codex/program-v3-autonomous-continuation\n` }
      return originalSpawn.call(this, command, args, options)
    }
    syncBuiltinESMExports()
    fs.readFileSync = function (name, ...args) {
      if (typeof name === 'string' && path.resolve(name) === path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json'))
        return args[0] === 'utf8' ? protocolBytes.toString('utf8') : protocolBytes
      return originalRead.call(this, name, ...args)
    }
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 345, real.boundaries.historicalS14BSplitBoundary), 390)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 390, real.boundaries.historicalPostUi408Boundary), 408)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 408, real.boundaries.historicalC16Ee3435ecBoundary), 432)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 432, real.boundaries.historicalC16Ccc70b31Boundary), 507)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 507, real.boundaries.historicalC16C9b88510Boundary), 546)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 546, real.boundaries.historicalC16D8a30c11Boundary), 579)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 579, real.boundaries.historicalC16Ca466d9aBoundary), 615)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 615, real.boundaries.historicalC1673b46513Boundary), 648)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 648, real.boundaries.historicalC16Fa8806d7Boundary), 690)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 690, real.boundaries.historicalC16B42cfc55Boundary), 738)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 738, real.boundaries.historicalC1667a57c04Boundary), 774)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 774, real.boundaries.historicalC162867cfa4Boundary), 828)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 828, real.boundaries.historicalPostUiBa2d34abBoundary), 843)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 843, real.boundaries.historicalPostUi1d0bdac3Boundary), 861)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 861, real.boundaries.historicalC16Ac3af420Boundary), 909)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 909, real.boundaries.historicalC16A9552e67Boundary), 957)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 957, real.boundaries.historicalC1663a44636Boundary), 1005)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 1005, real.boundaries.historicalC16A4d2b6edBoundary), 1041)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 1041, real.boundaries.historicalC160917fb36Boundary), 1080)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 1080, real.boundaries.historicalC161aa5487eBoundary), 1122)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 1122, real.boundaries.historicalC169337909dBoundary), 1158)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 1158, real.boundaries.historicalSharedInput7203443dBoundary), 1161)
    assert.equal(validateHistoricalSupersessionBoundary(real.raw, 1161, real.boundaries.historicalC1670407421Boundary), 1182)
    assert.equal(validatePhysicalLedger(ledger), ledger)
    fs.writeFileSync(file, synthetic.raw)
    const options = { campaignMode: 'synthetic', ...synthetic.boundaries }
    assert.doesNotThrow(() => updateLedger(file, { type: 'reserve', attemptId: 'new-attempt',
      binding: { ...synthetic.binding, ...currentProtocolBinding() } }, options))
    const changed1182 = raw => raw.replace('"type":"unknown","attemptId":"candidate:44726846-b229-4dbc-96d3-568102e62c22"',
      '"type":"settle","attemptId":"candidate:44726846-b229-4dbc-96d3-568102e62c22"')
    fs.writeFileSync(ledger, changed1182(real.raw))
    assert.throws(() => validatePhysicalLedger(ledger), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, changed1182(synthetic.raw))
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'new-attempt', binding: {} }, options),
      /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(ledger, real.raw)
    fs.writeFileSync(file, synthetic.raw)
    const ac3 = real.boundaries.historicalC16Ac3af420Boundary
    const a955 = real.boundaries.historicalC16A9552e67Boundary
    const r63 = real.boundaries.historicalC1663a44636Boundary
    const a4 = real.boundaries.historicalC16A4d2b6edBoundary
    const r0917 = real.boundaries.historicalC160917fb36Boundary
    const r1aa = real.boundaries.historicalC161aa5487eBoundary
    const r933 = real.boundaries.historicalC169337909dBoundary
    assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 1080, r933), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    for (const field of ['codeSha', 'sourceHash', 'driverHash'])
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 1122, { ...r933,
        armBindings: { candidate: { ...r933.armBindings.candidate, [field]: 'f'.repeat(field === 'codeSha' ? 40 : 64) } } }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    for (const [field, value] of [['attemptId', 'candidate:wrong'], ['invocationId', '00000000-0000-4000-8000-000000000000'],
      ['terminal', 'unknown'], ['parityId', 'f'.repeat(64)]])
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 1122, { ...r933,
        reserveAttempts: r933.reserveAttempts.map((item, index) => index === 0 ? { ...item, [field]: value } : item) }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 1041, r1aa), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    for (const field of ['codeSha', 'sourceHash', 'driverHash']) {
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 1080, { ...r1aa,
        armBindings: { candidate: { ...r1aa.armBindings.candidate, [field]: 'f'.repeat(field === 'codeSha' ? 40 : 64) } } }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    for (const [field, value] of [['attemptId', 'candidate:wrong'], ['invocationId', '00000000-0000-4000-8000-000000000000'],
      ['terminal', 'unknown'], ['parityId', 'f'.repeat(64)]]) {
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 1080, { ...r1aa,
        reserveAttempts: r1aa.reserveAttempts.map((item, index) => index === 0 ? { ...item, [field]: value } : item) }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 1005, r0917), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    for (const field of ['codeSha', 'sourceHash', 'driverHash']) {
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 1041, { ...r0917,
        armBindings: { candidate: { ...r0917.armBindings.candidate, [field]: 'f'.repeat(field === 'codeSha' ? 40 : 64) } } }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    for (const [field, value] of [['attemptId', 'candidate:wrong'], ['invocationId', '00000000-0000-4000-8000-000000000000'],
      ['terminal', 'unknown'], ['parityId', 'f'.repeat(64)]]) {
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 1041, { ...r0917,
        reserveAttempts: r0917.reserveAttempts.map((item, index) => index === 0 ? { ...item, [field]: value } : item) }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 957, a4), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    for (const field of ['codeSha', 'sourceHash', 'driverHash']) {
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 1005, { ...a4,
        armBindings: { candidate: { ...a4.armBindings.candidate, [field]: 'f'.repeat(field === 'codeSha' ? 40 : 64) } } }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    for (const [field, value] of [['attemptId', 'candidate:wrong'], ['invocationId', '00000000-0000-4000-8000-000000000000'],
      ['terminal', 'unknown'], ['parityId', 'f'.repeat(64)]]) {
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 1005, { ...a4,
        reserveAttempts: a4.reserveAttempts.map((item, index) => index === 0 ? { ...item, [field]: value } : item) }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 909, r63), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    for (const field of ['codeSha', 'sourceHash', 'driverHash']) {
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 957, { ...r63,
        armBindings: { candidate: { ...r63.armBindings.candidate, [field]: 'f'.repeat(field === 'codeSha' ? 40 : 64) } } }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    for (const [field, value] of [['attemptId', 'candidate:wrong'], ['invocationId', '00000000-0000-4000-8000-000000000000'],
      ['terminal', 'unknown'], ['parityId', 'f'.repeat(64)]]) {
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 957, { ...r63,
        reserveAttempts: r63.reserveAttempts.map((item, index) => index === 0 ? { ...item, [field]: value } : item) }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 843, ac3), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 861, a955), /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/)
    for (const field of ['codeSha', 'sourceHash', 'driverHash']) {
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 909, { ...a955,
        armBindings: { candidate: { ...a955.armBindings.candidate, [field]: 'f'.repeat(field === 'codeSha' ? 40 : 64) } } }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 909, { ...a955,
      reserveAttempts: a955.reserveAttempts.map((item, index) => index === 0 ? { ...item, parityId: 'f'.repeat(64) } : item) }),
    /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    for (const field of ['codeSha', 'sourceHash', 'driverHash']) {
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 861, { ...ac3,
        armBindings: { candidate: { ...ac3.armBindings.candidate, [field]: 'f'.repeat(field === 'codeSha' ? 40 : 64) } } }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    for (const [field, value] of [['attemptId', 'candidate:wrong'], ['invocationId', '00000000-0000-4000-8000-000000000000'],
      ['terminal', 'unknown'], ['parityId', 'f'.repeat(64)]]) {
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 861, { ...ac3,
        reserveAttempts: ac3.reserveAttempts.map((item, index) => index === 0 ? { ...item, [field]: value } : item) }),
      /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    const changed909 = raw => raw.trimEnd().split('\n').map((line, index) =>
      index === 908 ? line.replace('"attemptId":"', '"attemptId":"tampered-') : line).join('\n') + '\n'
    fs.writeFileSync(ledger, changed909(real.raw))
    assert.throws(() => validatePhysicalLedger(ledger), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, changed909(synthetic.raw))
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'new-attempt', binding: {} }, options),
      /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    const changed957 = raw => raw.trimEnd().split('\n').map((line, index) =>
      index === 956 ? line.replace('"attemptId":"', '"attemptId":"tampered-') : line).join('\n') + '\n'
    fs.writeFileSync(ledger, changed957(real.raw))
    assert.throws(() => validatePhysicalLedger(ledger), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, changed957(synthetic.raw))
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'new-attempt', binding: {} }, options),
      /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    const changed1005 = raw => raw.trimEnd().split('\n').map((line, index) =>
      index === 1004 ? line.replace('"attemptId":"', '"attemptId":"tampered-') : line).join('\n') + '\n'
    fs.writeFileSync(ledger, changed1005(real.raw))
    assert.throws(() => validatePhysicalLedger(ledger), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, changed1005(synthetic.raw))
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'new-attempt', binding: {} }, options),
      /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, synthetic.raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'unregistered-63a44636',
      binding: { ...synthetic.binding, protocolRevision: r63.protocolRevision, protocolHash: r63.protocolHash } }, options),
    /PROTOCOL_DRIFT/)
    const changed1041 = raw => raw.trimEnd().split('\n').map((line, index) =>
      index === 1040 ? line.replace('"attemptId":"', '"attemptId":"tampered-') : line).join('\n') + '\n'
    fs.writeFileSync(ledger, changed1041(real.raw))
    assert.throws(() => validatePhysicalLedger(ledger), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, changed1041(synthetic.raw))
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'new-attempt', binding: {} }, options),
      /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, synthetic.raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'unregistered-a4d2b6ed',
      binding: { ...synthetic.binding, protocolRevision: a4.protocolRevision, protocolHash: a4.protocolHash } }, options),
    /PROTOCOL_DRIFT/)
    const changed1080 = raw => raw.trimEnd().split('\n').map((line, index) =>
      index === 1079 ? line.replace('"attemptId":"', '"attemptId":"tampered-') : line).join('\n') + '\n'
    fs.writeFileSync(ledger, changed1080(real.raw))
    assert.throws(() => validatePhysicalLedger(ledger), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, changed1080(synthetic.raw))
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'new-attempt', binding: {} }, options),
      /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, synthetic.raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'unregistered-0917fb36',
      binding: { ...synthetic.binding, protocolRevision: r0917.protocolRevision, protocolHash: r0917.protocolHash } }, options),
    /PROTOCOL_DRIFT/)
    const changed1122 = raw => raw.trimEnd().split('\n').map((line, index) =>
      index === 1121 ? line.replace('"attemptId":"', '"attemptId":"tampered-') : line).join('\n') + '\n'
    fs.writeFileSync(ledger, changed1122(real.raw))
    assert.throws(() => validatePhysicalLedger(ledger), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, changed1122(synthetic.raw))
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'new-attempt', binding: {} }, options),
      /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, synthetic.raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'unregistered-1aa5487e',
      binding: { ...synthetic.binding, protocolRevision: r1aa.protocolRevision, protocolHash: r1aa.protocolHash } }, options),
    /PROTOCOL_DRIFT/)
    const changed1158 = raw => raw.trimEnd().split('\n').map((line, index) =>
      index === 1157 ? line.replace('"attemptId":"', '"attemptId":"tampered-') : line).join('\n') + '\n'
    fs.writeFileSync(ledger, changed1158(real.raw))
    assert.throws(() => validatePhysicalLedger(ledger), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, changed1158(synthetic.raw))
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'new-attempt', binding: {} }, options),
      /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, synthetic.raw)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'unregistered-9337909d',
      binding: { ...synthetic.binding, protocolRevision: r933.protocolRevision, protocolHash: r933.protocolHash } }, options),
    /PROTOCOL_DRIFT/)
    fs.writeFileSync(file, synthetic.raw + JSON.stringify({ type: 'reserve', attemptId: 'unregistered-ac3',
      binding: { ...synthetic.binding, protocolRevision: ac3.protocolRevision, protocolHash: ac3.protocolHash },
      allocation: 'failedRetryRepairReviewReserve' }) + '\n')
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'new-attempt',
      binding: { ...synthetic.binding, ...currentProtocolBinding() } }, options), /PROTOCOL_DRIFT/)
    fs.writeFileSync(ledger, real.raw.split('\n').slice(0, 408).join('\n'))
    assert.throws(() => validatePhysicalLedger(ledger), /HISTORICAL_LEDGER_SUPERSESSION_MISSING/)
    const changed408 = real.raw.trimEnd().split('\n')
    changed408[407] = changed408[407].replace('"attemptId":"', '"attemptId":"tampered-')
    fs.writeFileSync(ledger, changed408.join('\n') + '\n')
    assert.throws(() => validatePhysicalLedger(ledger), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(ledger, real.raw)
    const tamper = raw => {
      const lines = raw.trimEnd().split('\n')
      lines[389] = lines[389].replace('"attemptId":"', '"attemptId":"tampered-')
      return lines.join('\n') + '\n'
    }
    fs.writeFileSync(ledger, tamper(real.raw))
    assert.throws(() => validatePhysicalLedger(ledger), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, tamper(synthetic.raw))
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'new-attempt', binding: {} }, options),
      /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    for (const [field, value] of [['codeSha', 'f'.repeat(40)], ['sourceHash', 'f'.repeat(64)],
      ['driverHash', 'f'.repeat(64)], ['parityId', 'f'.repeat(64)]]) {
      assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 390, {
        ...real.boundaries.historicalPostUi408Boundary,
        armBindings: { ...real.boundaries.historicalPostUi408Boundary.armBindings,
          baseline: { ...real.boundaries.historicalPostUi408Boundary.armBindings.baseline, [field]: value } },
      }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    }
    assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 390, {
      ...real.boundaries.historicalPostUi408Boundary,
      reserveAttempts: real.boundaries.historicalPostUi408Boundary.reserveAttempts.map((item, index) =>
        index === 0 ? { ...item, terminal: 'unknown' } : item),
    }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    assert.throws(() => validateHistoricalSupersessionBoundary(real.raw, 390, {
      ...real.boundaries.historicalPostUi408Boundary,
      reserveAttempts: real.boundaries.historicalPostUi408Boundary.reserveAttempts.map((item, index) =>
        index === 0 ? { ...item, attemptId: 'candidate:wrong' } : item),
    }), /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/)
    fs.writeFileSync(file, synthetic.raw + JSON.stringify({ type: 'reserve', attemptId: 'unregistered-old',
      binding: { ...synthetic.binding, protocolRevision: protocol.historicalPostUi408Boundary.protocolRevision,
        protocolHash: protocol.historicalPostUi408Boundary.protocolHash }, allocation: 'failedRetryRepairReviewReserve' }) + '\n')
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'new-attempt',
      binding: { ...synthetic.binding, ...currentProtocolBinding() } }, options), /PROTOCOL_DRIFT/)
  } finally {
    fs.readFileSync = originalRead
    childProcess.spawnSync = originalSpawn
    syncBuiltinESMExports()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C16 ee3435ec 单臂历史段只在登记为历史时放行，之后严格按当前协议', () => {
  const c16 = protocol.historicalC16Ee3435ecBoundary
  assert.deepEqual([c16.fromEventCount, c16.eventCount, c16.reserveAttempts.length], [408, 432, 8])
  assert.deepEqual(Object.keys(c16.armBindings), ['candidate'])
  assert.equal(c16.protocolHash, '459faac156091628a6c8d84c7e1321610af4dec06f000ade75d44510dfc74961')
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/c16-boundary-'))
  const file = path.join(dir, 'synthetic-ledger.jsonl')
  const envelope = { campaignId: CAMPAIGN_ID, mode: 'synthetic', phase: 'c16-c18', milestone: 'final', caseId: 'C16-A', operation: '定稿章节要点' }
  const twoArm = { baseline: { codeSha: '1'.repeat(40), sourceHash: '2'.repeat(64), driverHash: '3'.repeat(64), parityId: '4'.repeat(64) },
    candidate: { codeSha: '5'.repeat(40), sourceHash: '6'.repeat(64), driverHash: '3'.repeat(64), parityId: '4'.repeat(64) } }
  const oldTwoArm = { protocolRevision: 's14b-split-quality-gates-v1', protocolHash: 'a'.repeat(64) }
  const twoArmAttempts = ['baseline:0a9c1a8e-0000-4000-8000-000000000001', 'candidate:0a9c1a8e-0000-4000-8000-000000000002']
    .map(attemptId => ({ attemptId, invocationId: '0807270b-f5c5-495c-bd71-5f1d6e9a32c1', terminal: 'settle' }))
  const old = { protocolRevision: c16.protocolRevision, protocolHash: c16.protocolHash }
  const candidate = { codeSha: 'e'.repeat(40), sourceHash: 'f'.repeat(64), driverHash: 'd'.repeat(64) }
  const c16Attempts = [['9', 'settle'], ['8', 'settle'], ['8', 'unknown']].map(([parity, terminal], index) => ({
    attemptId: `candidate:1726d37a-74d1-43cb-925e-00000000000${index}`, invocationId: '97b6ccf0-63b0-454e-97f5-71e5efc7b39c',
    terminal, parityId: parity.repeat(64) }))
  const rows = []
  for (const item of twoArmAttempts) {
    const arm = item.attemptId.split(':')[0]
    rows.push({ type: 'reserve', attemptId: item.attemptId, binding: { ...envelope, arm, ...twoArm[arm], ...oldTwoArm,
      invocationId: item.invocationId }, allocation: 'C16ExistingExtraction' },
    { type: 'dispatch', attemptId: item.attemptId }, { type: item.terminal, attemptId: item.attemptId })
  }
  for (const item of c16Attempts) rows.push({ type: 'reserve', attemptId: item.attemptId, binding: { ...envelope, arm: 'candidate', ...candidate,
    parityId: item.parityId, ...old, invocationId: item.invocationId }, allocation: 'C16ExistingExtraction' },
  { type: 'dispatch', attemptId: item.attemptId }, { type: item.terminal, attemptId: item.attemptId })
  const text = list => list.map(JSON.stringify).join('\n') + '\n'
  const raw = text(rows)
  const postUi = { fromEventCount: 0, eventCount: 6, rawBytesSha256: hash(text(rows.slice(0, 6))), ...oldTwoArm,
    armBindings: twoArm, reserveAttempts: twoArmAttempts }
  const boundary = { fromEventCount: 6, eventCount: 15, rawBytesSha256: hash(raw), ...old,
    armBindings: { candidate }, reserveAttempts: c16Attempts }
  const options = { campaignMode: 'synthetic', historicalPostUi408Boundary: postUi, historicalC16Ee3435ecBoundary: boundary }
  const current = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'baseline', codeSha: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
    phase: 'early-budget', milestone: 'early', caseId: '场景1/1', operation: '指定范围生成', ...currentProtocolBinding() }
  const evidence = /HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING/, invalid = /INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY/
  try {
    // e) 既有两臂边界（armBindings 含整臂 parityId）语义不变。
    assert.equal(validateHistoricalSupersessionBoundary(raw, 0, postUi), 6)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 0, { ...postUi,
      armBindings: { ...twoArm, baseline: { ...twoArm.baseline, parityId: '0'.repeat(64) } } }), evidence)
    assert.throws(() => validateHistoricalSupersessionBoundary(raw, 0, { ...postUi,
      armBindings: { ...twoArm, baseline: { ...twoArm.baseline, parityId: undefined } } }), invalid)
    // a) 单臂边界通过，之后的新 reserve 按当前协议继续；不登记则同一段被当作当前协议 → PROTOCOL_DRIFT。
    assert.equal(validateHistoricalSupersessionBoundary(raw, 6, boundary), 15)
    fs.writeFileSync(file, raw)
    assert.doesNotThrow(() => updateLedger(file, { type: 'reserve', attemptId: 'current-after-c16', binding: current }, options))
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 16)
    assert.throws(() => updateLedger(file, { type: 'dispatch', attemptId: 'current-after-c16' },
      { ...options, historicalC16Ee3435ecBoundary: undefined }), /PROTOCOL_DRIFT/)
    fs.writeFileSync(file, raw + JSON.stringify({ type: 'reserve', attemptId: 'candidate:unregistered',
      binding: rows[6].binding, allocation: 'C16ExistingExtraction' }) + '\n')
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-unregistered', binding: current }, options), /PROTOCOL_DRIFT/)
    // b) 前缀字节漂移（仅多一个空格）。
    const drifted = raw.replace(`"attemptId":"${c16Attempts[1].attemptId}"}`, `"attemptId":"${c16Attempts[1].attemptId}" }`)
    assert.notEqual(drifted, raw)
    assert.throws(() => validateHistoricalSupersessionBoundary(drifted, 6, boundary), /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    fs.writeFileSync(file, drifted)
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: 'after-drift', binding: current }, options),
      /HISTORICAL_LEDGER_SUPERSESSION_DRIFT/)
    // c) 边界内 reserve 的 invocationId / protocolHash / codeSha / 逐 attempt parityId 不符。
    for (const changed of [
      { reserveAttempts: c16Attempts.map((item, index) => index === 1 ? { ...item, invocationId: '0807270b-f5c5-495c-bd71-5f1d6e9a32c1' } : item) },
      { protocolHash: '0'.repeat(64) },
      { armBindings: { candidate: { ...candidate, codeSha: 'ee3435ec299e6b5a9bd9dc55950c9109abe92a24' } } },
      { reserveAttempts: c16Attempts.map((item, index) => index === 0 ? { ...item, parityId: '8'.repeat(64) } : item) },
    ]) assert.throws(() => validateHistoricalSupersessionBoundary(raw, 6, { ...boundary, ...changed }), evidence)
    // d) 只登记 candidate 时，baseline reserve 或 baseline attempt 都拒绝；parityId 必须恰在一处登记。
    const baselineRows = rows.map(row => row.attemptId === c16Attempts[0].attemptId && row.type === 'reserve'
      ? { ...row, binding: { ...row.binding, arm: 'baseline' } } : row)
    assert.throws(() => validateHistoricalSupersessionBoundary(text(baselineRows), 6,
      { ...boundary, rawBytesSha256: hash(text(baselineRows)) }), evidence)
    const renamed = c16Attempts.map((item, index) => index === 0 ? { ...item, attemptId: item.attemptId.replace('candidate:', 'baseline:') } : item)
    const renamedRows = rows.map(row => row.attemptId === c16Attempts[0].attemptId
      ? { ...row, attemptId: renamed[0].attemptId, ...(row.binding ? { binding: { ...row.binding, arm: 'baseline' } } : {}) } : row)
    assert.throws(() => validateHistoricalSupersessionBoundary(text(renamedRows), 6,
      { ...boundary, rawBytesSha256: hash(text(renamedRows)), reserveAttempts: renamed }), invalid)
    for (const changed of [
      { armBindings: { candidate: { ...candidate, parityId: '9'.repeat(64) } } },
      { reserveAttempts: c16Attempts.map(value => { const item = { ...value }; delete item.parityId; return item }) },
      { armBindings: { candidate, reviewer: candidate } },
      { armBindings: {} },
      { armBindings: null },
      { armBindings: { candidate: { ...candidate, sourceHash: 'x' } } },
      { armBindings: undefined },
    ]) assert.throws(() => validateHistoricalSupersessionBoundary(raw, 6, { ...boundary, ...changed }), invalid)
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
  assert.ok(fixture.includes('BRIDGE_REVIEWED_TEST_TIMEOUT_MS : BRIDGE_TEST_TIMEOUT_MS)'), 'fixture 顶层测试必须使用同一外层预算')
})

test('bridge 在记账前按 operation 校验出站权威，且只把真实 provider 失败归入 fetchFailures', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  const recheckGate = fixture.indexOf("if (operationKind === 'recheck' && candidate)")
  const draftGate = fixture.indexOf("if (operationKind === 'draft') preflight(draftPromptIncludesCommittedBlueprint(")
  const reserve = fixture.indexOf("record({ type: 'reserve', attemptId, binding })")
  const dispatch = fixture.indexOf("record({ type: 'dispatch', attemptId })")
  assert.ok(recheckGate >= 0 && recheckGate < reserve && reserve < dispatch,
    'recheck 的确定性权威校验必须在 campaign reserve/dispatch 之前完成')
  assert.ok(draftGate >= 0 && draftGate < reserve, '正文蓝图出站校验必须先于 campaign reserve')
  assert.ok(fixture.includes('OUTBOUND_RECHECK_MERGED_DRAFT_MISSING'))
  assert.ok(fixture.includes('OUTBOUND_RECHECK_FINDING_ID_MISSING'))
  assert.ok(fixture.includes('OUTBOUND_RECHECK_TARGET_ID_MISSING'))
  assert.match(fixture, /if \(operationKind === 'recheck' && candidate\)[\s\S]*?\} else if \(!structuredSyntaxRepair\) \{[\s\S]*?OUTBOUND_REQUIRED_PREDECESSOR_MISSING/,
    '逐字前情校验只属于普通生成，不得误套到 recheck 或语法修复')
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
  assert.ok(fixture.includes('globalThis.fetch = async (...args) => davFetch ? davFetch(...args) : rejectOutsidePhysicalBoundary(receipt)'))
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
    /request\.phase === 'early-review'[\s\S]*?operationKind === 'refine'[\s\S]*?OUTBOUND_REFINE_SOURCE_DRAFT_MISSING[\s\S]*?\} else if \(!structuredSyntaxRepair\) \{[\s\S]*?OUTBOUND_ORACLE_AUTHORITY_MISSING/,
    '定向修稿应校验当前正文与已确认审稿绑定，不得要求重复发送不属于该 prompt 合同的全套世界观')
})

test('S14B reviewed refine rejects any missing registered author fact before reserve on both arms', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  const checkStart = fixture.indexOf("      if (operationKind === 'recheck' && candidate)")
  const checkEnd = fixture.indexOf("      if (candidate && request.phase === 'early-context')", checkStart)
  const reserve = fixture.indexOf("record({ type: 'reserve', attemptId, binding })", checkEnd)
  assert.ok(checkStart > 0 && checkEnd > checkStart && reserve > checkEnd)
  const check = new Function('candidate', 'db', 'chapter', 'promptText', 'authorityFacts', 'preflight',
    'request', 'structuredSyntaxRepair',
    `const operationKind = 'refine', reviewedRun = true, continuityRun = false, fullRun = false;\n${fixture.slice(checkStart, checkEnd)}`)
  const chapter = source.scenes[0].chapters[0]
  const facts = Object.values(chapter.oracle).flatMap(value => Array.isArray(value) ? value : [value])
  assert.equal(facts.length, 6)
  const draft = 'S14B source draft'
  const db = { prepare: () => ({ pluck: () => ({ get: () => draft }) }) }
  for (const candidate of [false, true]) {
    const run = promptText => check(candidate, db, chapter, promptText, facts,
      createOutboundPreflightAssert([]), { phase: 'early-budget', chapterNumber: 1 }, false)
    assert.doesNotThrow(() => run(`${draft}\n${facts.join('\n')}`))
    assert.throws(() => run(facts.join('\n')), /OUTBOUND_REFINE_SOURCE_DRAFT_MISSING/)
    for (const fact of facts) assert.throws(() => run(`${draft}\n${facts.filter(value => value !== fact).join('\n')}`),
      /OUTBOUND_ORACLE_AUTHORITY_MISSING/, `refine ${candidate ? 'candidate' : 'baseline'} must send ${fact}`)
  }
})

test('S14B reviewed refine keeps real draft intact and applies targeted quotes only to synthetic output', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
  const start = fixture.indexOf("        else if (operationKind === 'refine') {")
  const end = fixture.indexOf("        } else if (operationKind === 'recheck')", start)
  assert.ok(start >= 0 && end > start)
  const generator = new Function('request', 'db', 'reviewedSyntheticIssues', 'assert', 'REVIEW_DEFECT', 'REVIEW_FIX', 'reviewedMustShowTexts',
    `let text; const operationKind = 'refine', reviewedRun = true, chapter = { number: 1 }; if (false) {} ${fixture.slice(start, end)} } return text`)
  const generate = (...args) => generator(...args, [])
  const quote = 'synthetic quote', replacement = 'synthetic replacement'
  const issues = [{ quote, replacement }]
  const sourceDraft = '真实正文没有合成引文，原文应完整保留。'
  const db = body => ({ prepare: () => ({ pluck: () => ({ get: () => body }) }) })
  assert.equal(generate({ mode: 'real' }, db(sourceDraft), issues, assert, 'synthetic defect', 'synthetic fix'), sourceDraft)
  assert.equal(generate({ mode: 'synthetic' }, db(quote), issues, assert, 'synthetic defect', 'synthetic fix'), replacement)
  assert.throws(() => generate({ mode: 'synthetic' }, db(sourceDraft), issues, assert, 'synthetic defect', 'synthetic fix'),
    /SYNTHETIC_TARGETED_REVISION_MISSING/)
  // 只有必现 unknown 被采纳时，合成修订逐字补写目标；真实模式仍原样返回模型输出位置的正文。
  assert.equal(generator({ mode: 'synthetic' }, db(sourceDraft), issues, assert, 'd', 'f', ['林澄保管铜钥匙']),
    `${sourceDraft}\n林澄保管铜钥匙。`)
  assert.equal(generator({ mode: 'real' }, db(sourceDraft), issues, assert, 'd', 'f', ['林澄保管铜钥匙']), sourceDraft)
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
  assert.match(fixture, /authorGuidance: .*人物已经执行选择.*具体损失或牺牲已经发生.*后文不保留相反状态.*签字认责/)
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

test('post-UI pair accepts only one evidenced syntax repair per arm and retains product FAIL', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/repair-pair-test-'))
  const policy = PHASE_SCENARIOS['early-budget'].attemptPolicy
  const invocationId = '11111111-1111-4111-8111-111111111111'
  const make = arm => {
    const owner = (id, purpose, operationId) => ({ attemptId: id, runId: 'run',
      ...(arm === 'candidate' ? { rootActionId: 'root' } : {}), projectId: 'project', epoch: 'epoch',
      purpose, ...(arm === 'baseline' ? { operationId } : {}) })
    const entries = [
      [policy.operationId, 'main', policy.primaryPurpose],
      [policy.operationId, 'repair', policy.repairPurpose],
      ['900单位正文', 'draft', 'chapter-draft'],
    ]
    const attempts = entries.map(([operation, id, purpose]) => {
      const outputPath = path.join(dir, `${arm}-${id}.txt`), content = id === 'main' ? '{"blueprints":[' : `${arm}-${id}-content`
      fs.writeFileSync(outputPath, content)
      const identity = owner(`${arm}-${id}`, purpose, operation)
      return { attemptId: `${arm}:${identity.attemptId}`, outputPath, visibleTextHash: hash(content),
        binding: { invocationId, mode: 'real', arm, phase: 'early-budget', milestone: 'post-ui', caseId: '场景1/1',
          protocolRevision: 'pacing-readability-v1', protocolHash: protocolBinding.protocolHash, operation,
          ...(arm === 'candidate' ? { actual: identity } : { baselineIpc: identity }) } }
    })
    return { invocationId, mode: 'real', arm, phase: 'early-budget', milestone: 'post-ui', caseId: '场景1/1',
      protocolRevision: 'pacing-readability-v1', protocolHash: protocolBinding.protocolHash, status: 'failed',
      physicalModelRequests: attempts.length, syntheticDispatches: 0, attempts,
      projectEpoch: 'epoch', physicalProject: { projectId: 'project' },
      operations: [{ operation: policy.operationId, handle: { runId: 'run', rootActionId: 'root' } }],
      ...(arm === 'candidate' ? { ownerTerminal: attempts.map(attempt => ({
        attemptId: attempt.binding.actual.attemptId, artifactId: `artifact-${attempt.attemptId}`,
        textHash: attempt.visibleTextHash, finishReason: 'stop', purpose: attempt.binding.actual.purpose, hasFormalEffect: true })) } : {}) }
  }
  try {
    const baseline = make('baseline'), candidate = make('candidate')
    const valid = classifyProductionPair([baseline, candidate], { mode: 'real', phase: 'early-budget' })
    assert.equal(valid.pairFailure, undefined)
    assert.equal(valid.status, 'failed', 'real product failure remains FAIL')
    const validJson = structuredClone(candidate)
    fs.writeFileSync(validJson.attempts[0].outputPath, '{"blueprints":[]}')
    validJson.attempts[0].visibleTextHash = hash('{"blueprints":[]}')
    validJson.ownerTerminal[0].textHash = validJson.attempts[0].visibleTextHash
    assert.equal(classifyProductionPair([baseline, validJson], { mode: 'real', phase: 'early-budget' }).pairFailure,
      'STRUCTURED_REPAIR_PRIMARY_NOT_SYNTAX_FAILURE')
    fs.writeFileSync(candidate.attempts[0].outputPath, '{"blueprints":[')
    const wrongPurpose = structuredClone(candidate)
    wrongPurpose.attempts[1].binding.actual.purpose = 'chapter-blueprint-directory:automatic-retry'
    assert.equal(classifyProductionPair([baseline, wrongPurpose], { mode: 'real', phase: 'early-budget' }).pairFailure,
      'STRUCTURED_REPAIR_OWNER_MISMATCH')
    const noOwner = structuredClone(candidate)
    delete noOwner.attempts[1].binding.actual
    assert.equal(classifyProductionPair([baseline, noOwner], { mode: 'real', phase: 'early-budget' }).pairFailure,
      'STRUCTURED_REPAIR_OWNER_MISMATCH')
    const third = structuredClone(candidate)
    third.attempts.push(structuredClone(third.attempts[1]))
    third.physicalModelRequests++
    assert.equal(classifyProductionPair([baseline, third], { mode: 'real', phase: 'early-budget' }).pairFailure,
      'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH')
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(ROOT, '.runtime/.cache/novel-quality-modernization') + path.sep))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('post-UI pair authenticates review rebuild attempts and both retained outputs', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/review-rebuild-pair-'))
  const scenario = productionScenario('early-budget', 'post-ui')
  const reviewPolicy = scenario.attemptPolicy.reviewRebuild
  const invocationId = '11111111-1111-4111-8111-111111111111'
  const artifact = (name, content, extra = {}) => {
    const outputPath = path.join(dir, name)
    fs.writeFileSync(outputPath, content)
    return { outputPath, contentHash: hash(content), ...extra }
  }
  const capturedReview = process.env.S14B_REVIEW_INVALID_OUTPUT
    ? fs.readFileSync(process.env.S14B_REVIEW_INVALID_OUTPUT, 'utf8') : null
  if (capturedReview) assert.equal(hash(capturedReview), 'e167529f761c3a33b3ea0582268fa9d544c7965a0b7db55b73738a1fcb0da770')
  const invalidReview = capturedReview ?? '```json\n{"summary":"无问题","items":[{"category":"事实","severity":"pass"}]}\n```'
  const validReview = JSON.stringify({ summary: '无问题', items: [{ category: '事实', severity: 'pass', description: '保持' }] })
  assert.throws(() => parseReviewGenerationResult(invalidReview), /invalid review contract/)
  assert.doesNotThrow(() => parseReviewGenerationResult(validReview))
  const make = arm => {
    const initial = artifact(`${arm}-draft.txt`, '甲'.repeat(100), { draftId: 7 })
    const source = { draftId: initial.draftId, contentHash: initial.contentHash }
    const report = artifact(`${arm}-review.json`, validReview,
    { reviewId: 9, sourceHash: initial.contentHash })
    const outputs = [
      [scenario.operations[0], 'directory', 'chapter-blueprint-directory', '{"blueprints":[]}'],
      [scenario.operations[1], 'draft', 'chapter-draft', '甲'.repeat(100)],
      [scenario.operations[2], 'review', reviewPolicy.primaryPurpose, invalidReview],
      [scenario.operations[2], 'rebuild', reviewPolicy.repairPurpose, fs.readFileSync(report.outputPath, 'utf8')],
    ]
    const attempts = outputs.map(([operation, label, purpose, content]) => {
      const saved = artifact(`${arm}-${label}.txt`, content)
      const identity = { attemptId: `${arm}-${label}`, runId: `run-${operation.kind}`,
        ...(arm === 'candidate' ? { rootActionId: `root-${operation.kind}` } : {}),
        projectId: `${arm}-project`, epoch: `${arm}-epoch`, purpose,
        ...(arm === 'baseline' ? { operationId: operation.id } : {}) }
      return { attemptId: `${arm}:${identity.attemptId}`, outputPath: saved.outputPath, visibleTextHash: saved.contentHash, finishReason: 'stop',
        binding: { invocationId, mode: 'real', arm, phase: 'early-budget', milestone: 'post-ui', caseId: '场景1/1',
          protocolRevision: protocol.decisionRevision, protocolHash: protocolBinding.protocolHash,
          codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId: 'd'.repeat(64),
          operation: operation.id, ...(operation.kind === 'review' ? { reviewSource: source } : {}),
          ...(arm === 'candidate' ? { actual: identity } : { baselineIpc: identity }) } }
    })
    const operations = scenario.operations.slice(0, 3).map(operation => ({ operation: operation.id, kind: operation.kind,
      ...(arm === 'candidate' ? { handle: { runId: `run-${operation.kind}`, rootActionId: `root-${operation.kind}` } } : {}),
      ...(operation.kind === 'draft' ? { outputHash: initial.contentHash } : {}),
      ...(operation.kind === 'review' ? { outputHash: report.contentHash } : {}) }))
    return { invocationId, mode: 'real', arm, phase: 'early-budget', milestone: 'post-ui', caseId: '场景1/1',
      protocolRevision: protocol.decisionRevision, protocolHash: protocolBinding.protocolHash,
      codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64),
      status: 'passed', evaluationPolicy: POST_UI_REVIEW_POLICY,
      physicalProject: { projectId: `${arm}-project`, parityHash: 'd'.repeat(64) }, projectEpoch: `${arm}-epoch`,
      attempts, operations, physicalModelRequests: attempts.length, syntheticDispatches: 0,
      saved: { chapterNumber: 1, targetUnits: 100, units: 100, contentHash: initial.contentHash },
      draftObservation: { chapterNumber: 1, targetUnits: 100, units: 100, contentHash: initial.contentHash, persisted: true },
      reviewedDraft: { initial, review: report, finalDraft: initial, selectedCount: 0,
        selectedItemsHash: hash([]), disposition: 'no-actionable-review' },
      ...(arm === 'candidate' ? { ownerTerminal: attempts.map(attempt => ({
        attemptId: attempt.binding.actual.attemptId, artifactId: `artifact-${attempt.attemptId}`,
        textHash: attempt.visibleTextHash, finishReason: 'stop', purpose: attempt.binding.actual.purpose, hasFormalEffect: true })) } : {}) }
  }
  try {
    const baseline = make('baseline'), candidate = make('candidate')
    const classify = value => classifyProductionPair([baseline, value], { mode: 'real', phase: 'early-budget' })
    assert.equal(classify(candidate).pairFailure, undefined)
    const wrongPurpose = structuredClone(candidate)
    wrongPurpose.attempts[3].binding.actual.purpose = 'review-chapter-retry'
    assert.equal(classify(wrongPurpose).pairFailure, 'REVIEW_REBUILD_OWNER_MISMATCH')
    const otherDraft = structuredClone(candidate)
    otherDraft.attempts[3].binding.reviewSource.draftId = 8
    assert.equal(classify(otherDraft).pairFailure, 'REVIEW_REBUILD_OWNER_MISMATCH')
    const validPrimary = structuredClone(candidate)
    fs.writeFileSync(validPrimary.attempts[2].outputPath, validReview)
    validPrimary.attempts[2].visibleTextHash = hash(validReview)
    validPrimary.ownerTerminal[2].textHash = validPrimary.attempts[2].visibleTextHash
    assert.equal(classify(validPrimary).pairFailure, 'REVIEW_REBUILD_PRIMARY_NOT_SYNTAX_FAILURE')
    fs.writeFileSync(candidate.attempts[2].outputPath, invalidReview)
    const third = structuredClone(candidate)
    third.attempts.push(structuredClone(third.attempts[3]))
    third.physicalModelRequests++
    assert.equal(classify(third).pairFailure, 'ACTUAL_OWNER_ARTIFACT_MISMATCH')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---- S14B post-UI 候选臂的唯一原生压缩（场景 revision v3；评分规则/场景变更，与产品 f00b612b 的修复分开）----
const POST_UI_TARGET = 900
const POST_UI_RANGE = draftTargetUnitRange(POST_UI_TARGET)
const POST_UI_DRAFT = '900单位正文'
const postUiPolicy = () => productionScenario('early-budget', 'post-ui').attemptPolicy
const postUiEvidenceDir = prefix => fs.mkdtempSync(path.join(ROOT, `.runtime/.cache/novel-quality-modernization/${prefix}`))

test('S14B post-UI v2 登记没有 draftCondense：候选的合法压缩在 reserve 前被拒，复现 ba2d34ab', () => {
  const policy = postUiPolicy()
  const legacy = { ...policy }
  delete legacy.draftCondense
  const rejections = []
  // 旧接线：repairPolicy=post-UI attemptPolicy；draftCondense 只对 continuityRun 生效，post-UI 为 null。
  const gate = createOperationDispatchGate({ repairPolicy: legacy, draftCondense: null, readPrimaryEvidence: () => null, onReject: item => rejections.push(item) })
  const first = { attemptId: 'primary', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch', purpose: 'chapter-draft' }
  gate(POST_UI_DRAFT, first)
  assert.throws(() => gate(POST_UI_DRAFT, { ...first, attemptId: 'condense', purpose: 'chapter-draft-condense' }), /MODEL_REQUEST_REJECTED/)
  assert.deepEqual(rejections, [{ code: 'UNREGISTERED_ADDITIONAL_MODEL_REQUEST', operationId: POST_UI_DRAFT, reason: 'duplicate-operation', beforeDispatch: true }])
})

test('S14B post-UI 场景 v4 保留候选唯一压缩并登记有界恢复；early 与其它阶段的登记和 revision 不变', () => {
  const scenario = productionScenario('early-budget', 'post-ui'), policy = scenario.attemptPolicy
  assert.equal(scenario.scenarioRevision, POST_UI_SCENARIO_REVISION)
  assert.deepEqual(policy.draftCondense, { operationIds: ['900单位正文'], arms: ['candidate'], primaryPurpose: 'chapter-draft',
    condensePurpose: 'chapter-draft-condense', maxCondenseAttempts: 1,
    trigger: 'settled-stop-or-length-hash-verified-composed-units-above-draftTargetUnitRange-maximum', formalEffect: 'last-attempt-only' })
  // 其余登记（milestone、两臂、指定范围一次结构化语法修复、成稿首审一次重建）与 early 基础登记逐字相同：现有 review/refine/final-review 链不受影响。
  const rest = { ...policy }
  delete rest.draftCondense
  delete rest.draftRecovery
  delete rest.structuredRecovery
  assert.deepEqual(rest, PHASE_SCENARIOS['early-budget'].attemptPolicy)
  // 协议与 driver 一致，压缩只出现在 post-UI selection。
  const selected = selectPhase(protocol, 'early-budget', 'post-ui')
  assert.deepEqual(selected.attemptPolicy, policy)
  assertScenarioMatchesProtocol(selected, scenario)
  assert.deepEqual(selected.operations.map(item => item.id), ['指定范围生成', '900单位正文', '成稿首审', '成稿一次修稿', '成稿完整复评'])
  // 逐臂生效：candidate 取到登记，baseline 从不；基础 early 登记与其它阶段的登记取不到新压缩。
  assert.equal(draftCondenseFor(policy, 'candidate'), policy.draftCondense)
  assert.equal(draftCondenseFor(policy, 'baseline'), null)
  assert.equal(draftCondenseFor(PHASE_SCENARIOS['early-budget'].attemptPolicy, 'candidate'), null)
  assert.equal(draftCondenseFor(undefined, 'candidate'), null)
  // C16–C18 的登记本身不变：沿用 attemptPolicy.arms（仅 candidate）。
  assert.equal(C16_C18_ATTEMPT_POLICY.draftCondense.arms, undefined)
  assert.equal(draftCondenseFor(C16_C18_ATTEMPT_POLICY, 'candidate'), C16_C18_ATTEMPT_POLICY.draftCondense)
  assert.equal(draftCondenseFor(C16_C18_ATTEMPT_POLICY, 'baseline'), null)
  assert.deepEqual(C16_C18_ATTEMPT_POLICY.draftCondense.operationIds, ['本地恢复后续写', 'DAV选定世代恢复后续写'])
  // early milestone 的历史场景与 revision 不变：无压缩登记，协议与 driver 一致。
  const early = selectPhase(protocol, 'early-budget')
  assert.equal(early.scenarioRevision, 's14b-post-ui-budget-syntax-repair-v1')
  assert.equal(PHASE_SCENARIOS['early-budget'].scenarioRevision, 's14b-post-ui-budget-syntax-repair-v1')
  assert.equal(early.attemptPolicy.draftCondense, undefined)
  assert.equal(protocol.phases['early-budget'].attemptPolicy.draftCondense, undefined)
  assertScenarioMatchesProtocol(early, productionScenario('early-budget', 'early'))
  assert.equal(productionScenario('early-budget').attemptPolicy, PHASE_SCENARIOS['early-budget'].attemptPolicy)
  // 其它阶段的 revision 与登记逐字不变，且不含新压缩。
  assert.equal(PHASE_SCENARIOS['c16-c18'].scenarioRevision, 'c16-c18-candidate-production-path-v7')
  assert.equal(PHASE_SCENARIOS['c16-c18'].attemptPolicy, C16_C18_ATTEMPT_POLICY)
  assert.equal(PHASE_SCENARIOS['early-context'].scenarioRevision, 's10b-early-context-selection-difference-v3')
  assert.equal(PHASE_SCENARIOS['early-review'].scenarioRevision, 's11-early-review-per-attempt-deadline-v3')
  for (const [phase, milestone] of [['early-context', 'early'], ['early-review', 'early']]) {
    assert.equal(PHASE_SCENARIOS[phase].attemptPolicy, undefined, phase)
    assertScenarioMatchesProtocol(selectPhase(protocol, phase, milestone), productionScenario(phase, milestone))
  }
  assert.equal(protocol.phases['c16-c18'].scenarioRevision, PHASE_SCENARIOS['c16-c18'].scenarioRevision)
  assert.deepEqual(protocol.phases['c16-c18'].attemptPolicy, C16_C18_ATTEMPT_POLICY)
  // 不对称披露：candidate 含原生压缩登记、baseline 没有，不得据此单独声称相对改善（随协议、pair 与 receipt 的 evaluationPolicy 一并披露）。
  const asymmetry = POST_UI_REVIEW_POLICY.armAsymmetry.condense
  assert.match(asymmetry, /candidate.*压缩.*baseline.*(没有|无).*不得.*声称相对改善/su)
  assert.deepEqual(selected.evaluationPolicy, POST_UI_REVIEW_POLICY)
  assert.equal(selected.evaluationPolicy.armAsymmetry.condense, asymmetry)
})

test('S14B post-UI 旧 v2 revision 或缺 draftCondense 的登记不再被 driver 接受', () => {
  const current = productionScenario('early-budget', 'post-ui')
  const options = { phase: 'early-budget', milestone: 'post-ui', scenarioRevision: current.scenarioRevision, selectionDifference: null,
    attemptPolicy: current.attemptPolicy, evaluationPolicy: current.evaluationPolicy }
  const withoutCondense = { ...current.attemptPolicy }
  delete withoutCondense.draftCondense
  for (const changed of [{ scenarioRevision: MUST_SHOW_SCENARIO_REVISION }, { attemptPolicy: withoutCondense },
    { attemptPolicy: { ...current.attemptPolicy, draftCondense: { ...current.attemptPolicy.draftCondense, arms: ['baseline', 'candidate'] } } },
    { attemptPolicy: { ...current.attemptPolicy, draftCondense: { ...current.attemptPolicy.draftCondense, maxCondenseAttempts: 2 } } }])
    assert.throws(() => runProductionPhasePair({}, { ...options, ...changed }), /SCENARIO_PROTOCOL_MISMATCH/)
})

test('S14B post-UI 唯一压缩：仅候选臂、仅「900单位正文」、仅在已结算且超上限的首稿后恰好一次，其余登记不受影响', () => {
  const dir = postUiEvidenceDir('post-ui-condense-gate-')
  try {
    const policy = postUiPolicy(), condensePolicy = policy.draftCondense
    const { syntheticDraftText } = syntheticLengthHelpers()
    const overText = syntheticDraftText(countDraftUnits, POST_UI_RANGE.maximum + 90)
    const inRangeText = syntheticDraftText(countDraftUnits, POST_UI_TARGET)
    assert.ok(countDraftUnits(overText) > POST_UI_RANGE.maximum && countDraftUnits(inRangeText) <= POST_UI_RANGE.maximum)
    const first = { attemptId: 'primary', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch', purpose: 'chapter-draft' }
    const condense = { ...first, attemptId: 'condense', purpose: 'chapter-draft-condense' }
    const outputPath = path.join(dir, 'primary.txt')
    const settled = { finish: 'stop', artifact: null, operation: POST_UI_DRAFT, recorded: null }
    const proof = owner => {
      const attemptId = `candidate:${owner.attemptId}`, text = fs.readFileSync(outputPath, 'utf8')
      const binding = { operation: settled.operation, actual: { ...owner } }
      return { attempt: { attemptId, binding, outputPath, visibleTextHash: settled.recorded ?? hash(text) },
        events: [{ type: 'reserve', attemptId, binding }, { type: 'dispatch', attemptId }, { type: 'settle', attemptId, finishReason: settled.finish }],
        ownerArtifactHash: settled.artifact ?? hash(text) }
    }
    const draftCondense = { policy: condensePolicy, maximum: POST_UI_RANGE.maximum, measureUnits: countDraftUnits }
    const rejections = []
    const create = (options = {}) => createOperationDispatchGate({ repairPolicy: policy, draftCondense, readPrimaryEvidence: proof,
      onReject: item => rejections.push(item), ...options })
    const reset = () => { fs.writeFileSync(outputPath, overText); Object.assign(settled, { finish: 'stop', artifact: null, operation: POST_UI_DRAFT, recorded: null }) }
    reset()
    // (a) 候选：同 run/root/项目/epoch 的首稿已 stop 结算且按生产计数超上限，恰放行一次压缩。
    const gate = create()
    gate(POST_UI_DRAFT, first)
    assert.doesNotThrow(() => gate(POST_UI_DRAFT, condense))
    // (b) 第二次压缩、续写等其他额外请求在 reserve 前拒绝。
    assert.throws(() => gate(POST_UI_DRAFT, { ...condense, attemptId: 'condense-2' }), /MODEL_REQUEST_REJECTED/)
    assert.throws(() => gate(POST_UI_DRAFT, { ...first, attemptId: 'continuation', purpose: 'chapter-draft-continuation' }), /MODEL_REQUEST_REJECTED/)
    assert.deepEqual(rejections.at(-1), { code: 'UNREGISTERED_ADDITIONAL_MODEL_REQUEST', operationId: POST_UI_DRAFT, reason: 'duplicate-operation', beforeDispatch: true })
    // (c) baseline：fixture 对 baseline 传 draftCondense=null，超限首稿之后的压缩仍被拒（baseline 身份没有 rootActionId）。
    const ipc = { attemptId: 'ipc-primary', runId: 'bridge-run', projectId: 'project', epoch: 'epoch', purpose: 'chapter-draft' }
    const baseline = create({ draftCondense: draftCondenseFor(policy, 'baseline') })
    baseline(POST_UI_DRAFT, ipc)
    assert.throws(() => baseline(POST_UI_DRAFT, { ...ipc, attemptId: 'ipc-condense', purpose: 'chapter-draft-condense' }), /MODEL_REQUEST_REJECTED/)
    // (d) 非「900单位正文」的 operation：即使有同样的超限证据，压缩用途也被拒。
    const reviewSource = { draftId: 7, contentHash: hash(inRangeText) }
    for (const [operation, purpose] of [[policy.operationId, policy.primaryPurpose], [policy.reviewRebuild.operationId, policy.reviewRebuild.primaryPurpose],
      ['成稿一次修稿', 'review-refine'], ['成稿完整复评', 'review-chapter']]) {
      const other = create()
      settled.operation = operation
      other(operation, { ...first, purpose }, reviewSource)
      assert.throws(() => other(operation, condense, reviewSource), /MODEL_REQUEST_REJECTED/, operation)
      settled.operation = POST_UI_DRAFT
    }
    // (e) 首稿未超上限（含恰在上限）、未以 stop 结束、hash 不符、owner artifact 不符、身份错位：一律拒绝。
    const rejected = mutate => {
      const isolated = create()
      isolated(POST_UI_DRAFT, first)
      const owner = mutate() ?? condense
      assert.throws(() => isolated(POST_UI_DRAFT, owner), /MODEL_REQUEST_REJECTED/)
      reset()
    }
    rejected(() => { fs.writeFileSync(outputPath, inRangeText) })
    rejected(() => { settled.recorded = hash(overText); fs.writeFileSync(outputPath, `${overText}补`) })
    rejected(() => { settled.finish = 'length' })
    rejected(() => { settled.artifact = hash('other owner artifact') })
    rejected(() => { settled.operation = policy.operationId })
    rejected(() => ({ ...condense, rootActionId: 'other-root' }))
    rejected(() => ({ ...condense, epoch: 'other-epoch' }))
    rejected(() => ({ ...condense, attemptId: first.attemptId }))
    rejected(() => ({ ...condense, purpose: 'chapter-draft-condense:2' }))
    const exact = create()
    exact(POST_UI_DRAFT, first)
    let atMaximum = inRangeText
    const extra = '清晨，林澄核对登记，发现日期异常。'
    while (countDraftUnits(atMaximum + extra) <= POST_UI_RANGE.maximum) atMaximum += extra
    fs.writeFileSync(outputPath, atMaximum)
    assert.ok(countDraftUnits(atMaximum) <= POST_UI_RANGE.maximum)
    assert.throws(() => exact(POST_UI_DRAFT, condense), /MODEL_REQUEST_REJECTED/)
    reset()
    // 压缩不能作为首请求；登记压缩的 operation 首请求必须是 chapter-draft（其他首用途如续写不再被放行）。
    assert.throws(() => create()(POST_UI_DRAFT, condense), /MODEL_REQUEST_REJECTED/)
    assert.throws(() => create()(POST_UI_DRAFT, { ...first, purpose: 'chapter-draft-continuation' }), /MODEL_REQUEST_REJECTED/)
    // 未登记 draftCondense 的旧门仍拒绝。
    const legacy = createOperationDispatchGate({ repairPolicy: policy, readPrimaryEvidence: proof })
    legacy(POST_UI_DRAFT, first)
    assert.throws(() => legacy(POST_UI_DRAFT, condense), /MODEL_REQUEST_REJECTED/)
    // (h) 同一门里，指定范围的一次结构化语法修复与成稿首审的一次重建保持原样。
    const directory = { attemptId: 'dir', runId: 'run-dir', rootActionId: 'root-dir', projectId: 'project', epoch: 'epoch', purpose: policy.primaryPurpose }
    const directoryPath = path.join(dir, 'directory.txt')
    fs.writeFileSync(directoryPath, '{"blueprints":[')
    const directoryProof = owner => {
      const attemptId = `candidate:${owner.attemptId}`, binding = { operation: policy.operationId, actual: { ...owner } }
      return { attempt: { attemptId, binding, outputPath: directoryPath, visibleTextHash: hash('{"blueprints":[') },
        events: [{ type: 'reserve', attemptId, binding }, { type: 'dispatch', attemptId }, { type: 'settle', attemptId, finishReason: 'stop' }] }
    }
    const mixed = create({ readPrimaryEvidence: owner => owner.attemptId === 'dir' ? directoryProof(owner) : proof(owner) })
    mixed(policy.operationId, directory)
    assert.doesNotThrow(() => mixed(policy.operationId, { ...directory, attemptId: 'dir-repair', purpose: policy.repairPurpose }))
    assert.throws(() => mixed(policy.operationId, { ...directory, attemptId: 'dir-third', purpose: policy.repairPurpose }), /MODEL_REQUEST_REJECTED/)
    const reviewOwner = { ...first, attemptId: 'review', runId: 'run-review', rootActionId: 'root-review', purpose: policy.reviewRebuild.primaryPurpose }
    const rebuildGate = create({ readPrimaryEvidence: () => null })
    rebuildGate(policy.reviewRebuild.operationId, reviewOwner, reviewSource)
    assert.throws(() => rebuildGate(policy.reviewRebuild.operationId, { ...reviewOwner, attemptId: 'review-rebuild', purpose: policy.reviewRebuild.repairPurpose }, reviewSource),
      /MODEL_REQUEST_REJECTED/, '没有可核验语法失败证据时首审重建仍被拒；本切片不放宽它')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('S14B post-UI 压缩的 fixture 接线：登记只对候选臂取到，首稿证据取 owner artifact 原文 hash，并与 driver 门禁联通', () => {
  const dir = postUiEvidenceDir('post-ui-condense-wiring-')
  try {
    const fixture = fixtureSource()
    // 1) 逐臂/逐里程碑的登记选择：直接执行 fixture 里的三行选择代码。
    const selectStart = fixture.indexOf('    const policyEligible =')
    const selectEnd = fixture.indexOf('    let draftCondense = null', selectStart)
    assert.ok(selectStart > 0 && selectEnd > selectStart)
    const select = new Function('request', 'target', 'continuityRun', 'draftCondenseFor',
      `${fixture.slice(selectStart, selectEnd)}\nreturn { repairPolicy, condensePolicy }`)
    const policy = postUiPolicy()
    const pick = (request, arm, continuityRun = false) => select(request, { arm }, continuityRun, draftCondenseFor)
    const postUi = { milestone: 'post-ui', attemptPolicy: policy }
    assert.deepEqual(pick(postUi, 'candidate'), { repairPolicy: policy, condensePolicy: policy.draftCondense })
    assert.deepEqual(pick(postUi, 'baseline'), { repairPolicy: policy, condensePolicy: null }, 'baseline 保留原修复/重建登记，但从不获压缩')
    // early 里程碑：基础登记 milestone 为 post-ui，不适用；无登记的阶段也不适用。
    const early = { milestone: 'early', attemptPolicy: PHASE_SCENARIOS['early-budget'].attemptPolicy }
    for (const arm of ['baseline', 'candidate']) assert.deepEqual(pick(early, arm), { repairPolicy: null, condensePolicy: null }, arm)
    assert.deepEqual(pick({ milestone: 'early', attemptPolicy: null }, 'candidate'), { repairPolicy: null, condensePolicy: null })
    // C16–C18 保持原样：单臂 candidate，续写 run 不带 repairPolicy，压缩登记不变。
    const c16 = { milestone: 'final', attemptPolicy: C16_C18_ATTEMPT_POLICY }
    assert.deepEqual(pick(c16, 'candidate', true), { repairPolicy: null, condensePolicy: C16_C18_ATTEMPT_POLICY.draftCondense })
    assert.deepEqual(pick(c16, 'baseline', true), { repairPolicy: null, condensePolicy: null })
    // 2) 首稿证据读取：直接执行 fixture 的 readPrimaryEvidence，配合 driver 的门禁放行/拒绝唯一压缩。
    const proofStart = fixture.indexOf('readPrimaryEvidence: first => {') + 'readPrimaryEvidence: first => {'.length
    const proofEnd = fixture.indexOf('    }, onReject:', proofStart)
    assert.ok(proofStart > 0 && proofEnd > proofStart)
    const readEvidence = new Function('first', 'receipt', 'request', 'authorityFacts', 'sha', 'fs', 'target', 'operationKind', 'db', 'continuityRun',
      `const finalizedContext = null, parseFinalizedCharacterStateResponse = null;\n${fixture.slice(proofStart, proofEnd)}`)
    const { syntheticDraftText } = syntheticLengthHelpers()
    const overText = syntheticDraftText(countDraftUnits, POST_UI_RANGE.maximum + 90)
    const first = { attemptId: 'primary', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch', purpose: 'chapter-draft' }
    const attemptId = `candidate:${first.attemptId}`, binding = { operation: POST_UI_DRAFT, actual: first }
    const outputPath = path.join(dir, 'primary.txt'), ledgerPath = path.join(dir, 'ledger.jsonl')
    fs.writeFileSync(outputPath, overText)
    fs.writeFileSync(ledgerPath, [{ type: 'reserve', attemptId, binding }, { type: 'dispatch', attemptId },
      { type: 'settle', attemptId, finishReason: 'stop' }].map(row => JSON.stringify(row)).join('\n') + '\n')
    const facts = ['fact one', 'fact two']
    const attempt = { attemptId, binding, outputPath, visibleTextHash: hash(overText),
      authorityEvidence: { factHashes: facts.map(hash), allFactsSent: true } }
    let artifact = JSON.stringify({ text: overText })
    const db = { prepare: () => ({ pluck: () => ({ get: () => artifact }) }) }
    const reader = (kind, request = { attemptPolicy: policy, ledgerPath }, receipt = { attempts: [attempt] }) => first =>
      readEvidence(first, receipt, request, facts, hash, fs, { arm: 'candidate' }, kind, db, false)
    const draftCondense = { policy: policy.draftCondense, maximum: POST_UI_RANGE.maximum, measureUnits: countDraftUnits }
    const dispatch = (readPrimaryEvidence, owner = { ...first, attemptId: 'condense', purpose: 'chapter-draft-condense' }) => {
      const gate = createOperationDispatchGate({ repairPolicy: policy, draftCondense, readPrimaryEvidence })
      gate(POST_UI_DRAFT, first)
      return () => gate(POST_UI_DRAFT, owner)
    }
    const evidence = reader('draft')(first)
    assert.equal(evidence.ownerArtifactHash, hash(overText))
    assert.equal(evidence.events.length, 3)
    assert.doesNotThrow(dispatch(reader('draft')), '候选超长首稿：读到 owner artifact hash，唯一压缩放行')
    // owner artifact 与物理输出不符、缺 owner artifact、首稿事实未全发出：拒绝。
    artifact = JSON.stringify({ text: `${overText}改` })
    assert.throws(dispatch(reader('draft')), /MODEL_REQUEST_REJECTED/)
    artifact = undefined
    assert.throws(dispatch(reader('draft')), /MODEL_REQUEST_REJECTED/)
    artifact = JSON.stringify({ text: overText })
    assert.throws(dispatch(reader('draft', undefined, { attempts: [{ ...attempt, authorityEvidence: { factHashes: facts.map(hash), allFactsSent: false } }] })), /MODEL_REQUEST_REJECTED/)
    // 只有登记了压缩的 post-UI 才走 owner artifact 证据：early / v2 登记（无 draftCondense）读到的是审稿证据，压缩因此无法放行。
    const legacy = { ...policy }
    delete legacy.draftCondense
    delete legacy.draftRecovery
    assert.equal(reader('draft', { attemptPolicy: legacy, ledgerPath })(first).ownerArtifactHash, undefined)
    assert.throws(dispatch(reader('draft', { attemptPolicy: legacy, ledgerPath })), /MODEL_REQUEST_REJECTED/)
    // 非 draft operation（首审）在 post-UI 仍走原审稿证据，不因新登记改变。
    assert.equal(Object.hasOwn(reader('review')(first), 'reviewReportAbsent'), true)
    assert.equal(reader('review')(first).ownerArtifactHash, undefined)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('合成 transport 可复现 S14B post-UI 候选：超长首稿→唯一压缩→在范围，以及压缩仍越界；接线只对候选臂生效', () => {
  const { syntheticDraftText, syntheticDraftUnitsGoal } = syntheticLengthHelpers()
  const caseId = '场景1/1'
  const units = (plan, purpose) => countDraftUnits(syntheticDraftText(countDraftUnits,
    syntheticDraftUnitsGoal(plan, caseId, purpose, POST_UI_TARGET, POST_UI_RANGE.maximum)))
  const inRange = { caseId, outcome: 'in-range' }, stillOver = { caseId, outcome: 'still-over' }
  assert.ok(units(inRange, 'chapter-draft') > POST_UI_RANGE.maximum, 'primary-over')
  const condensed = units(inRange, 'chapter-draft-condense')
  assert.ok(condensed >= POST_UI_RANGE.minimum && condensed <= POST_UI_RANGE.maximum, 'condense-in-range')
  assert.ok(units(stillOver, 'chapter-draft-condense') > POST_UI_RANGE.maximum, 'condense-still-over')
  // 未登记计划保持原合成行为：首稿在范围内，产品不会发起压缩（in-range 默认路径不变）。
  for (const plan of [null, { caseId: 'C17-A', outcome: 'in-range' }]) {
    const value = units(plan, 'chapter-draft')
    assert.ok(value >= POST_UI_RANGE.minimum && value <= POST_UI_RANGE.maximum)
  }
  const fixture = fixtureSource()
  const driver = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-driver.mjs'), 'utf8')
  // 登记按臂取：baseline 不加载生产压缩常量，其 gate 的 draftCondense 恒为 null。
  assert.match(fixture, /const condensePolicy = policyEligible \? draftCondenseFor\(request\.attemptPolicy, target\.arm\) : null/)
  assert.match(fixture, /const repairPolicy = policyEligible && !continuityRun \? request\.attemptPolicy : null/)
  assert.match(fixture, /request\.attemptPolicy\?\.draftRecovery \|\| request\.attemptPolicy\?\.draftCondense/)
  assert.match(fixture, /const condensedPrimary = condensePolicy && attempt\.binding\.actual\.purpose === condensePolicy\.primaryPurpose/)
  assert.match(fixture, /assert\.equal\(terminal\.hasFormalEffect, !repairedDirectory && !supersededAttempt && !condensedPrimary\)/)
  assert.match(fixture, /if \(reviewedRun\) assert\.ok\(scenarioAuthorSettingLines\(scene, request\.scenarioRevision\)\.length, 'REVIEWED_SCENARIO_AUTHOR_LINE_MISSING'\)/)
  // 开发合成默认让 post-UI 候选走「超长→唯一压缩→在范围」；C16–C18 的默认接线原样保留（行为见 syntheticDraftCondensePlan 的独立测试）。
  const plan = syntheticDraftCondensePlan({ mode: 'synthetic', development: true, phase: 'early-budget', milestone: 'post-ui' })
  assert.deepEqual(plan, { syntheticDraftCondense: { caseId: '场景1/1', outcome: 'in-range' } })
  // 压缩最多使 candidate 的一次 operation 多一个物理 attempt：外层测试预算覆盖 8 个串行 attempt。
  assert.match(driver, /BRIDGE_REVIEWED_TEST_TIMEOUT_MS = BRIDGE_SETTLEMENT_DEADLINE_MS \* 15 \+ 120_000/)
})

/** post-UI 候选压缩的 pair 收据夹具：证据落在 dir；make 生成一臂收据，classify 走生产分类器。 */
function postUiCondensePairKit(dir) {
  const { syntheticDraftText } = syntheticLengthHelpers()
  const scenario = productionScenario('early-budget', 'post-ui'), policy = scenario.attemptPolicy
  const overText = syntheticDraftText(countDraftUnits, POST_UI_RANGE.maximum + 90)
  const condensedText = syntheticDraftText(countDraftUnits, POST_UI_TARGET)
  const invocationId = '11111111-1111-4111-8111-111111111111'
  const review = JSON.stringify({ summary: '无问题', items: [{ category: '事实', severity: 'pass', description: '保持' }] })
  const artifact = (name, content, extra = {}) => {
    const outputPath = path.join(dir, name)
    fs.writeFileSync(outputPath, content)
    return { outputPath, contentHash: hash(content), ...extra }
  }
  // finalText 是被审稿的正文（reviewedDraft.initial，即压缩稿）；condenseOutput 是最后一次 draft attempt 的物理输出（默认同 finalText）。
  // 无修稿（默认）：initial == finalDraft == saved。revisedText 给定时为有修稿形状：saved/draftObservation/finalDraft 是修稿产物，与 initial 不同。
  const items = [{ category: '事实', severity: 'error', description: '保管人错误', quote: '林澄' }]
  const finalReviewText = JSON.stringify({ summary: '已修复', items: [{ category: '事实', severity: 'pass', description: '已修复' }] })
  const make = (arm, { condense = arm === 'candidate', primaryText = overText, finalText = condensedText, condenseOutput = finalText,
    revisedText = null, tag = '' } = {}) => {
    const initial = artifact(`${arm}${tag}-final.txt`, finalText, { draftId: 7 })
    const reviewText = revisedText === null ? review : JSON.stringify({ summary: '需修复', items })
    const report = artifact(`${arm}${tag}-review.json`, reviewText, { reviewId: 9, sourceHash: initial.contentHash })
    const revision = revisedText === null ? null : artifact(`${arm}${tag}-revision.txt`, revisedText)
    const finalReview = revision && artifact(`${arm}${tag}-final-review.json`, finalReviewText, { sourceHash: revision.contentHash })
    const confirmation = revision && artifact(`${arm}${tag}-confirmation.json`, JSON.stringify({ sourceReviewId: 9,
      sourceDraft: { content: finalText }, items: items.map(item => ({ ...item, decision: 'apply', origin: 'ai' })) }))
    const finalDraft = revision ?? initial
    const source = { draftId: 7, contentHash: initial.contentHash }
    const steps = [[scenario.operations[0], 'directory', 'chapter-blueprint-directory', '{"blueprints":[]}'],
      [scenario.operations[1], 'draft', 'chapter-draft', condense ? primaryText : finalText],
      ...(condense ? [[scenario.operations[1], 'condense', 'chapter-draft-condense', condenseOutput]] : []),
      [scenario.operations[2], 'review', policy.reviewRebuild.primaryPurpose, reviewText],
      ...(revision ? [[scenario.operations[3], 'refine', 'refine-from-review', revisedText],
        [scenario.operations[4], 'final-review', 'review-chapter', finalReviewText]] : [])]
    const attempts = steps.map(([operation, label, purpose, content]) => {
      const saved = artifact(`${arm}${tag}-${label}.txt`, content)
      const identity = { attemptId: `${arm}${tag}-${label}`, runId: `run-${operation.kind}`,
        ...(arm === 'candidate' ? { rootActionId: `root-${operation.kind}` } : {}), projectId: `${arm}-project`, epoch: `${arm}-epoch`, purpose,
        ...(arm === 'baseline' ? { operationId: operation.id } : {}) }
      return { attemptId: `${arm}:${identity.attemptId}`, outputPath: saved.outputPath, visibleTextHash: saved.contentHash, finishReason: 'stop',
        binding: { invocationId, mode: 'real', arm, phase: 'early-budget', milestone: 'post-ui', caseId: '场景1/1',
          protocolRevision: protocol.decisionRevision, protocolHash: protocolBinding.protocolHash,
          codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId: 'd'.repeat(64),
          operation: operation.id, ...(operation.kind === 'review' ? { reviewSource: source } : {}),
          ...(arm === 'candidate' ? { actual: identity } : { baselineIpc: identity }) } }
    })
    const operations = scenario.operations.slice(0, revision ? 5 : 3).map(operation => ({ operation: operation.id, kind: operation.kind,
      ...(arm === 'candidate' ? { handle: { runId: `run-${operation.kind}`, rootActionId: `root-${operation.kind}` } } : {}),
      ...(operation.kind === 'draft' ? { outputHash: initial.contentHash } : {}),
      ...(operation.kind === 'review' ? { outputHash: report.contentHash } : {}),
      ...(operation.kind === 'refine' ? { outputHash: revision.contentHash } : {}),
      ...(operation.kind === 'final-review' ? { outputHash: finalReview.contentHash } : {}) }))
    const units = countDraftUnits(revisedText ?? finalText)
    const drafts = attempts.filter(attempt => attempt.binding.operation === POST_UI_DRAFT)
    return { invocationId, mode: 'real', arm, phase: 'early-budget', milestone: 'post-ui', caseId: '场景1/1',
      protocolRevision: protocol.decisionRevision, protocolHash: protocolBinding.protocolHash,
      codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64),
      status: 'passed', evaluationPolicy: POST_UI_REVIEW_POLICY,
      physicalProject: { projectId: `${arm}-project`, parityHash: 'd'.repeat(64) }, projectEpoch: `${arm}-epoch`,
      attempts, operations, physicalModelRequests: attempts.length, syntheticDispatches: 0,
      saved: { chapterNumber: 1, targetUnits: POST_UI_TARGET, units, contentHash: finalDraft.contentHash },
      draftObservation: { chapterNumber: 1, targetUnits: POST_UI_TARGET, units, contentHash: finalDraft.contentHash, persisted: true },
      reviewedDraft: { initial, review: report, finalDraft, selectedCount: revision ? 1 : 0, selectedItemsHash: hash(revision ? items : []),
        disposition: revision ? 'revised-once' : 'no-actionable-review',
        ...(revision ? { confirmation, revision, finalReview, mergeHash: revision.contentHash } : {}) },
      ...(arm === 'candidate' ? { ownerTerminal: attempts.map(attempt => ({ attemptId: attempt.binding.actual.attemptId,
        artifactId: `artifact-${attempt.attemptId}`, textHash: attempt.visibleTextHash, finishReason: 'stop', purpose: attempt.binding.actual.purpose,
        hasFormalEffect: attempt.binding.operation !== POST_UI_DRAFT || attempt === drafts.at(-1) })) } : {}) }
  }
  const baseline = make('baseline')
  const classify = (value, other = baseline) => classifyProductionPair([other, value], { mode: 'real', phase: 'early-budget' })
  return { make, classify, overText, condensedText, syntheticDraftText }
}

test('S14B post-UI pair：候选至多一次可核验压缩，末次压缩稿是被审稿（无修稿时即保存稿）；baseline 与任何未登记压缩一律拒绝', () => {
  const dir = postUiEvidenceDir('post-ui-condense-pair-')
  const { make, classify, overText, condensedText } = postUiCondensePairKit(dir)
  try {
    const candidate = make('candidate')
    assert.equal(candidate.attempts.filter(attempt => attempt.binding.operation === POST_UI_DRAFT).length, 2)
    assert.ok(countDraftUnits(overText) > POST_UI_RANGE.maximum && candidate.draftObservation.units <= POST_UI_RANGE.maximum)
    // 合法：首稿超上限→恰好一次压缩→保存的是压缩稿；两臂其余链条不变，仍只到独立评审待判。
    const valid = classify(candidate)
    assert.equal(valid.pairFailure, undefined)
    assert.equal(valid.status, 'pending-independent-oracle-review')
    // in-range 默认路径行为不变：首稿在范围内的候选只有一个 draft attempt，同样通过。
    const plain = make('candidate', { condense: false, tag: '-plain' })
    assert.equal(plain.attempts.filter(attempt => attempt.binding.operation === POST_UI_DRAFT).length, 1)
    assert.equal(classify(plain).pairFailure, undefined)
    // 压缩稿按生产清洗（主进程 draft-visible-v1 组合）从末次压缩原文得出：仅清洗可去除的尾随空行不构成不一致。
    assert.equal(classify(make('candidate', { condenseOutput: `${condensedText}\n\n\n`, tag: '-padded' })).pairFailure, undefined)
    // (b) 第三个 draft attempt；(c) baseline 出现压缩 attempt：数量校验直接拒绝。
    const third = structuredClone(candidate)
    third.attempts.splice(2, 0, { ...structuredClone(third.attempts[2]), attemptId: 'candidate:candidate-condense-2' })
    third.physicalModelRequests++
    assert.equal(classify(third).pairFailure, 'ACTUAL_OWNER_ARTIFACT_MISMATCH')
    const baselineCondensed = make('baseline', { condense: true, tag: '-condensed' })
    assert.equal(classify(candidate, baselineCondensed).pairFailure, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    // 用途或顺序不符：第二个 draft attempt 不是 chapter-draft-condense，或首个不是 chapter-draft。
    const wrongCondense = structuredClone(candidate)
    wrongCondense.attempts[2].binding.actual.purpose = 'chapter-draft-continuation'
    wrongCondense.ownerTerminal[2].purpose = 'chapter-draft-continuation'
    assert.equal(classify(wrongCondense).pairFailure, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    const wrongPrimary = structuredClone(candidate)
    wrongPrimary.attempts[1].binding.actual.purpose = 'chapter-draft-continuation'
    wrongPrimary.ownerTerminal[1].purpose = 'chapter-draft-continuation'
    assert.equal(classify(wrongPrimary).pairFailure, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    // 正式效果只在末次压缩；首稿带正式效果、压缩缺正式效果或非 stop，均拒绝。
    for (const mutate of [value => { value.ownerTerminal[1].hasFormalEffect = true },
      value => { value.ownerTerminal[2].hasFormalEffect = false },
      value => { value.ownerTerminal[1].finishReason = 'length' },
      value => { value.ownerTerminal[2].finishReason = 'length' }]) {
      const changed = structuredClone(candidate)
      mutate(changed)
      assert.equal(classify(changed).pairFailure, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    }
    // owner 终态与物理输出 hash 不符、终态缺失：拒绝。
    const wrongTerminalHash = structuredClone(candidate)
    wrongTerminalHash.ownerTerminal[2].textHash = hash('other')
    assert.equal(classify(wrongTerminalHash).pairFailure, 'ACTUAL_OWNER_ARTIFACT_MISMATCH')
    const missingTerminal = structuredClone(candidate)
    missingTerminal.ownerTerminal.pop()
    assert.equal(classify(missingTerminal).pairFailure, 'ACTUAL_OWNER_ARTIFACT_MISMATCH')
    // 压缩与首稿必须同 run/root（同一 operation 的 handle）；否则按 owner 绑定拒绝。
    const foreignRun = structuredClone(candidate)
    foreignRun.attempts[2].binding.actual.runId = 'run-other'
    assert.equal(classify(foreignRun).pairFailure, 'DRAFT_RECOVERY_OWNER_MISMATCH')
    // (e) 首稿未超上限却压缩：拒绝；首稿原文在结算后被改写：hash 不符或丢失。
    assert.equal(classify(make('candidate', { primaryText: condensedText, tag: '-inrange-primary' })).pairFailure, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    fs.writeFileSync(candidate.attempts[1].outputPath, `${overText}补`)
    assert.equal(classify(candidate).pairFailure, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    fs.rmSync(candidate.attempts[1].outputPath)
    assert.equal(classify(candidate).pairFailure, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    fs.writeFileSync(candidate.attempts[1].outputPath, overText)
    // (f) 被审稿（无修稿时即保存稿）必须等于最后一次 draft attempt 的可见输出（生产清洗后；干净输出即其物理输出 hash）：是别的正文即拒绝。
    assert.equal(classify(make('candidate', { condenseOutput: `${condensedText}\n另一稿`, tag: '-other-saved' })).pairFailure, 'DRAFT_RECOVERY_SAVED_MISMATCH')
    // (g) 压缩后仍超限：产品保留原稿并以 GENERATION_DRAFT_LENGTH_OUT_OF_RANGE 停下——收据为失败且无保存/审修链，原失败语义保留。
    const stillOver = { ...structuredClone(candidate), status: 'failed', error: 'GENERATION_DRAFT_LENGTH_OUT_OF_RANGE',
      saved: undefined, draftObservation: undefined, reviewedDraft: undefined }
    assert.deepEqual(classify(stillOver), { status: 'failed', qualityQualification: 'automatic-gate-failed', pairFailure: 'REVIEWED_DRAFT_EVIDENCE_INVALID' })
    // 即使收据谎称 passed：保存稿仍越界（压缩没有落入范围）时不能进入独立评审待判。
    const overSaved = make('candidate', { finalText: overText, condenseOutput: overText, tag: '-over-saved' })
    const overResult = classify(overSaved)
    assert.equal(overResult.status, 'failed')
    assert.ok(overResult.pairFailure)
    fs.writeFileSync(candidate.attempts[1].outputPath, overText)
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(ROOT, '.runtime/.cache/novel-quality-modernization') + path.sep))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


test('S14B post-UI pair 有修稿形状：被审稿（reviewedDraft.initial）是压缩稿，saved 是唯一修稿产物，二者不同也通过', () => {
  const dir = postUiEvidenceDir('post-ui-condense-revised-')
  const { make, classify, condensedText } = postUiCondensePairKit(dir)
  try {
    const revised = make('candidate', { revisedText: `${condensedText}
林澄保管铜钥匙。`, tag: '-revised' })
    assert.equal(revised.reviewedDraft.disposition, 'revised-once')
    assert.notEqual(revised.saved.contentHash, revised.reviewedDraft.initial.contentHash)
    assert.equal(revised.reviewedDraft.initial.contentHash, hash(condensedText))
    const result = classify(revised)
    assert.equal(result.pairFailure, undefined)
    assert.equal(result.status, 'pending-independent-oracle-review')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('S14B post-UI pair 有修稿形状：被审稿若是被压缩取代的首稿，即使修稿产物恰等于压缩输出也拒绝', () => {
  const dir = postUiEvidenceDir('post-ui-condense-reviewed-original-')
  const { make, classify, overText, condensedText } = postUiCondensePairKit(dir)
  try {
    const reviewedOriginal = make('candidate', { finalText: overText, condenseOutput: condensedText, revisedText: condensedText, tag: '-reviewed-original' })
    assert.equal(reviewedOriginal.saved.contentHash, hash(condensedText), '修稿产物恰等于压缩输出')
    assert.equal(reviewedOriginal.reviewedDraft.initial.contentHash, hash(overText), '但被审稿是未压缩的首稿')
    assert.equal(classify(reviewedOriginal).pairFailure, 'DRAFT_RECOVERY_SAVED_MISMATCH')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('S14B post-UI pair 有修稿形状：压缩是否落入范围按压缩稿判，最终稿（修稿产物）范围由原字数门另判', () => {
  const dir = postUiEvidenceDir('post-ui-condense-range-')
  const { make, classify, condensedText, syntheticDraftText } = postUiCondensePairKit(dir)
  try {
    // 修稿把最终稿推出范围：压缩本身合格，不得归因于压缩登记；仍因最终稿越界而技术门 failed。
    const longRevision = make('candidate', { revisedText: syntheticDraftText(countDraftUnits, POST_UI_RANGE.maximum + 90), tag: '-long-revision' })
    assert.ok(longRevision.draftObservation.units > POST_UI_RANGE.maximum)
    const refinedOver = classify(longRevision)
    assert.equal(refinedOver.pairFailure, undefined)
    assert.deepEqual([refinedOver.status, refinedOver.qualityQualification], ['failed', 'automatic-gate-failed'])
    // 压缩稿本身仍越界、修稿后才落入范围：压缩没有落入范围，不能因最终稿在范围内而放行。
    const overCondensed = syntheticDraftText(countDraftUnits, POST_UI_RANGE.maximum + 30)
    assert.ok(countDraftUnits(overCondensed) > POST_UI_RANGE.maximum)
    assert.equal(classify(make('candidate', { finalText: overCondensed, revisedText: condensedText, tag: '-condensed-over' })).pairFailure,
      'DRAFT_RECOVERY_SAVED_MISMATCH')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
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


// ---- S14B full 阶段候选臂的唯一原生压缩（场景 revision v2；评分规则/场景变更，与产品 f00b612b 的修复分开）----
const FULL_TARGET = 900
const FULL_RANGE = draftTargetUnitRange(FULL_TARGET)
const FULL_DRAFT = '连续章节正文'
const FULL_INVOCATION = 'd8f34844-b1dc-4864-9383-ab7b4606d0fc'
const fullPredecessorOf = result => ({ projectId: result.physicalProject.projectId, chapterNumber: result.saved.chapterNumber,
  draftId: result.saved.draftId, version: result.saved.version, contentHash: result.saved.contentHash, persistedBytes: result.saved.persistedBytes })

/**
 * full 一步（一个 operation）的收据。默认是既有形状：一个 attempt。condense={ primaryText, output, saved } 给候选章两次 draft attempt：
 * 首稿（chapter-draft）→唯一压缩（chapter-draft-condense），保存的正文是压缩输出（生产清洗后，默认同 output）；tag 区分同一目录里的变体文件。
 */
function fullStepReceipt(dir, step, index, { invocationId = FULL_INVOCATION, parityId = 'd'.repeat(64), predecessor = null, condense = null, tag = '' } = {}) {
  const projectId = `${step.sceneId}:${step.arm}`, isDraft = step.operation.kind === 'draft'
  const savedText = condense ? condense.saved ?? condense.output : isDraft ? '甲'.repeat(FULL_TARGET) : `${projectId}:${step.chapterNumber}`
  const write = (name, text) => { const file = path.join(dir, `${index}${tag}-${name}.txt`); fs.writeFileSync(file, text); return file }
  const owner = (suffix, purpose) => ({ projectId, epoch: 'epoch', runId: `run-${index}`, rootActionId: `root-${index}`,
    attemptId: `attempt-${index}${suffix}`, ...(purpose ? { purpose } : {}) })
  const bindingOf = actual => ({ ...protocolBinding, invocationId, mode: 'synthetic', arm: step.arm, phase: 'full', milestone: 'final',
    caseId: step.caseId, operation: step.operation.id, codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: 'c'.repeat(64), parityId,
    ...(step.arm === 'candidate' ? { actual } : { baselineIpc: { ...actual, operationId: step.operation.id } }) })
  const specs = condense ? [['-primary', 'chapter-draft', condense.primaryText], ['-condense', 'chapter-draft-condense', condense.output]] : [['', isDraft ? 'chapter-draft' : undefined, isDraft ? savedText : null]]
  const attempts = specs.map(([suffix, purpose, text]) => {
    const actual = owner(suffix, purpose)
    return { attemptId: `${step.arm}:${actual.attemptId}`, binding: bindingOf(actual), finishReason: 'stop',
      ...(text === null ? {} : { outputPath: write(`attempt${suffix}`, text), visibleTextHash: hash(text) }) }
  })
  const primary = attempts[0].binding.actual ?? attempts[0].binding.baselineIpc
  const outputPath = write('operation', savedText)
  const result = { ...bindingOf(primary), status: 'passed', sceneId: step.sceneId, chapterNumber: step.chapterNumber,
    projectEpoch: 'epoch', physicalProject: { projectId, parityHash: parityId },
    operations: [{ operation: step.operation.id, kind: step.operation.kind, outputPath, handle: primary }],
    attempts, physicalModelRequests: 0, syntheticDispatches: attempts.length }
  if (isDraft && step.arm === 'candidate') result.ownerTerminal = attempts.map((attempt, at) => ({ attemptId: attempt.binding.actual.attemptId,
    artifactId: `artifact-${attempt.attemptId}`, textHash: attempt.visibleTextHash, finishReason: 'stop', purpose: attempt.binding.actual.purpose,
    hasFormalEffect: at === attempts.length - 1 }))
  if (isDraft) {
    const units = condense ? countDraftUnits(savedText) : FULL_TARGET
    result.draftObservation = { chapterNumber: step.chapterNumber, targetUnits: FULL_TARGET, units, contentHash: hash(savedText), persisted: true }
    result.saved = { ...result.draftObservation, draftId: index + 1, version: 1, persistedBytes: Buffer.byteLength(savedText) }
    result.predecessor = predecessor
  }
  return result
}

/** full 全部 24 步的收据：condenseAt 指定候选章的下标与压缩内容；前驱链取每步 saved（压缩章即压缩稿）。 */
function fullReceiptKit(dir) {
  const schedule = fullExecutionSchedule(protocol.order)
  const { syntheticDraftText } = syntheticLengthHelpers()
  const overText = syntheticDraftText(countDraftUnits, FULL_RANGE.maximum + 90)
  const condensedText = syntheticDraftText(countDraftUnits, FULL_TARGET)
  const at = (caseId, arm) => schedule.findIndex(step => step.caseId === caseId && step.arm === arm && step.operation.kind === 'draft')
  const build = ({ condenseAt = null, condense = { primaryText: overText, output: condensedText }, tag = '' } = {}) => {
    const predecessors = new Map()
    return schedule.map((step, index) => {
      const key = `${step.sceneId}:${step.arm}`
      const result = fullStepReceipt(dir, step, index, { predecessor: predecessors.get(key) ?? null,
        ...(index === condenseAt ? { condense } : {}), tag })
      if (step.operation.kind === 'draft') predecessors.set(key, fullPredecessorOf(result))
      return result
    })
  }
  const classify = (values, mode = 'synthetic') => classifyFullProduction(values, { mode, order: protocol.order })
  return { schedule, overText, condensedText, at, build, classify, syntheticDraftText }
}

test('S14B full 场景 v3 保留候选唯一压缩并登记有界恢复；其余阶段的登记与 revision 不变', () => {
  const scenario = PHASE_SCENARIOS.full, policy = scenario.attemptPolicy
  assert.equal(scenario.scenarioRevision, 's14b-full-continuous-project-v3')
  const { armAsymmetry, draftRecovery, structuredRecovery, ...registered } = policy
  assert.equal(draftRecovery.maxAttempts, 8)
  assert.equal(structuredRecovery.budget, 'planBlueprintGenerationCost')
  assert.deepEqual(registered, { milestone: 'final', arms: ['baseline', 'candidate'], draftCondense: { operationIds: ['连续章节正文'], arms: ['candidate'],
    primaryPurpose: 'chapter-draft', condensePurpose: 'chapter-draft-condense', maxCondenseAttempts: 1,
    trigger: 'settled-stop-or-length-hash-verified-composed-units-above-draftTargetUnitRange-maximum', formalEffect: 'last-attempt-only' } })
  // 不对称披露：candidate 有压缩、baseline 无；两臂长度差异来自该不对称，不得据此单独声称相对改善。
  assert.match(armAsymmetry, /candidate.*压缩.*baseline.*(没有|无).*不得.*声称相对改善/su)
  // 协议与 driver 逐字一致；full 仍是唯一的 final 里程碑，operations/caseIds 不变。
  const selected = selectPhase(protocol, 'full', 'final')
  assert.equal(selected.scenarioRevision, scenario.scenarioRevision)
  assert.deepEqual(selected.attemptPolicy, policy)
  assertScenarioMatchesProtocol(selected, scenario)
  assert.deepEqual(selected.operations.map(item => [item.id, item.kind, item.allocation]),
    [['三章规划', 'directory', 'finalPlanning'], ['连续章节正文', 'draft', 'finalChapters']])
  assert.equal(protocol.phases.full.minimumCalls, 24)
  // 逐臂生效：candidate 取到登记，baseline 从不；三章规划（directory）不在登记内。
  assert.equal(draftCondenseFor(policy, 'candidate'), policy.draftCondense)
  assert.equal(draftCondenseFor(policy, 'baseline'), null)
  assert.ok(!policy.draftCondense.operationIds.includes('三章规划'))
  // 早前 early / post-UI / C16–C18 / 其它阶段的登记与 revision 逐字不变。
  assert.equal(PHASE_SCENARIOS['early-budget'].scenarioRevision, 's14b-post-ui-budget-syntax-repair-v1')
  assert.equal(PHASE_SCENARIOS['early-budget'].attemptPolicy.draftCondense, undefined)
  assert.equal(productionScenario('early-budget', 'post-ui').scenarioRevision, POST_UI_SCENARIO_REVISION)
  assert.equal(PHASE_SCENARIOS['c16-c18'].scenarioRevision, 'c16-c18-candidate-production-path-v7')
  assert.equal(PHASE_SCENARIOS['c16-c18'].attemptPolicy, C16_C18_ATTEMPT_POLICY)
  assert.equal(PHASE_SCENARIOS['early-context'].scenarioRevision, 's10b-early-context-selection-difference-v3')
  assert.equal(PHASE_SCENARIOS['early-review'].scenarioRevision, 's11-early-review-per-attempt-deadline-v3')
  for (const phase of ['early-context', 'early-review']) assert.equal(PHASE_SCENARIOS[phase].attemptPolicy, undefined, phase)
})

test('S14B full 旧 v1 revision 或缺压缩/放宽到 baseline 的登记不再被 driver 接受', () => {
  const current = PHASE_SCENARIOS.full
  const options = { phase: 'full', milestone: 'final', scenarioRevision: current.scenarioRevision, attemptPolicy: current.attemptPolicy,
    ...protocolBinding, order: protocol.order }
  const withoutCondense = { ...current.attemptPolicy }
  delete withoutCondense.draftCondense
  for (const changed of [{ scenarioRevision: 's14b-full-continuous-project-v1' }, { attemptPolicy: undefined }, { attemptPolicy: withoutCondense },
    { attemptPolicy: { ...current.attemptPolicy, arms: ['baseline', 'candidate'], draftCondense: { ...current.attemptPolicy.draftCondense, arms: ['baseline', 'candidate'] } } },
    { attemptPolicy: { ...current.attemptPolicy, draftCondense: { ...current.attemptPolicy.draftCondense, maxCondenseAttempts: 2 } } }])
    assert.throws(() => runProductionPhasePair({}, { ...options, ...changed }), /PROTOCOL_BINDING_MISMATCH/)
})

test('syntheticDraftCondensePlan：只在开发合成给出默认计划，正式合成与真实模式不受影响；full 默认落在场景1/2', () => {
  const plan = (options) => syntheticDraftCondensePlan({ mode: 'synthetic', development: true, ...options })
  assert.deepEqual(plan({ phase: 'c16-c18' }), { syntheticDraftCondense: { caseId: 'C17-A', outcome: 'in-range' } })
  assert.deepEqual(plan({ phase: 'early-budget', milestone: 'post-ui' }), { syntheticDraftCondense: { caseId: '场景1/1', outcome: 'in-range' } })
  assert.deepEqual(plan({ phase: 'full' }), { syntheticDraftCondense: { caseId: '场景1/2', outcome: 'in-range' } })
  // 显式计划原样通过（still-over 复现压缩后仍越界的原失败语义）。
  const stillOver = { caseId: '场景1/2', outcome: 'still-over' }
  for (const options of [{ phase: 'full' }, { phase: 'early-budget', milestone: 'post-ui' }, { phase: 'c16-c18' }])
    assert.deepEqual(plan({ ...options, syntheticDraftCondense: stillOver }), { syntheticDraftCondense: stillOver })
  // 其余阶段/里程碑、正式合成（无 development）与真实模式：不给计划。
  for (const options of [{ phase: 'early-budget', milestone: 'early' }, { phase: 'early-context' }, { phase: 'early-review' }, { phase: 'early-budget' }])
    assert.deepEqual(plan(options), {}, JSON.stringify(options))
  for (const options of [{ mode: 'synthetic', development: false }, { mode: 'real', development: true }, { mode: 'real', development: false }, { development: undefined }])
    for (const phase of [{ phase: 'full' }, { phase: 'c16-c18' }, { phase: 'early-budget', milestone: 'post-ui' }])
      assert.deepEqual(syntheticDraftCondensePlan({ ...options, ...phase, syntheticDraftCondense: stillOver }), {}, JSON.stringify({ ...options, ...phase }))
})

test('full 收据端到端形状：候选章 1 个 attempt 无压缩仍通过；primary+condense 通过，前驱链取压缩稿', () => {
  const dir = postUiEvidenceDir('full-condense-shape-')
  try {
    const kit = fullReceiptKit(dir)
    // (a) 既有形状：无压缩，每步恰 1 个 attempt。
    const plain = kit.build()
    assert.equal(kit.classify(plain).status, 'passed')
    assert.ok(plain.every(result => result.attempts.length === 1))
    // (b) 场景1/2 候选章：首稿超上限→唯一压缩→保存压缩稿；下一章前驱取压缩稿。
    const chapter2 = kit.at('场景1/2', 'candidate'), chapter3 = kit.at('场景1/3', 'candidate')
    const results = kit.build({ condenseAt: chapter2, tag: '-ok' })
    assert.equal(results[chapter2].attempts.length, 2)
    assert.equal(results[chapter2].saved.contentHash, hash(kit.condensedText))
    assert.notEqual(results[chapter2].saved.contentHash, hash(kit.overText))
    assert.equal(results[chapter3].predecessor.contentHash, hash(kit.condensedText), '下一章前驱是压缩稿')
    assert.ok(countDraftUnits(kit.overText) > FULL_RANGE.maximum && results[chapter2].draftObservation.units <= FULL_RANGE.maximum)
    const accepted = kit.classify(results)
    assert.equal(accepted.pairFailure, undefined)
    assert.equal(accepted.status, 'passed')
    // 生产清洗只删不增：压缩输出带尾随空行时，保存的是清洗后的压缩稿，仍通过。
    assert.equal(kit.classify(kit.build({ condenseAt: chapter2, condense: { primaryText: kit.overText, output: `${kit.condensedText}\n\n\n`, saved: kit.condensedText }, tag: '-padded' })).pairFailure, undefined)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('full 收据负例：baseline 压缩、第二次压缩、仍越界、保存的是首稿、非 stop、directory 中的压缩、前驱仍取首稿', () => {
  const dir = postUiEvidenceDir('full-condense-negative-')
  try {
    const kit = fullReceiptKit(dir)
    const chapter2 = kit.at('场景1/2', 'candidate'), chapter3 = kit.at('场景1/3', 'candidate'), baselineChapter = kit.at('场景1/2', 'baseline')
    const results = kit.build({ condenseAt: chapter2, tag: '-base' })
    const failed = (values, code) => {
      const decision = kit.classify(values)
      assert.equal(decision.status, 'failed')
      assert.equal(decision.pairFailure, code)
    }
    // baseline 出现压缩 attempt：恒拒。
    const baselineCondense = kit.build({ condenseAt: baselineChapter, tag: '-baseline' })
    assert.equal(baselineCondense[baselineChapter].attempts.length, 2)
    failed(baselineCondense, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    // 第二次压缩：三个 draft attempt。
    const second = structuredClone(results)
    second[chapter2].attempts.push({ ...structuredClone(second[chapter2].attempts[1]), attemptId: 'candidate:attempt-extra' })
    second[chapter2].syntheticDispatches = 3
    failed(second, 'ACTUAL_OWNER_ARTIFACT_MISMATCH')
    // 压缩后仍越界（保存的压缩稿仍超上限）：不算落入范围，按字数门失败。
    const overCondensed = kit.syntheticDraftText(countDraftUnits, FULL_RANGE.maximum + 30)
    failed(kit.build({ condenseAt: chapter2, condense: { primaryText: kit.overText, output: overCondensed }, tag: '-still-over' }), 'DRAFT_RECOVERY_SAVED_MISMATCH')
    // 首稿本身未超上限却压缩：拒绝。
    failed(kit.build({ condenseAt: chapter2, condense: { primaryText: kit.condensedText, output: kit.condensedText }, tag: '-primary-in-range' }), 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    // 保存的仍是被压缩取代的未压缩首稿（压缩输出在范围内，但 saved/observation/operation 输出都是首稿）。
    const savedPrimary = structuredClone(results)
    fs.writeFileSync(savedPrimary[chapter2].operations[0].outputPath, kit.overText)
    for (const target of [savedPrimary[chapter2].saved, savedPrimary[chapter2].draftObservation]) target.contentHash = hash(kit.overText)
    failed(savedPrimary, 'DRAFT_RECOVERY_SAVED_MISMATCH')
    fs.writeFileSync(savedPrimary[chapter2].operations[0].outputPath, kit.condensedText)
    // 压缩 attempt 非 stop、正式效果错位、用途错位：拒绝。
    for (const [mutate, code] of [[value => { value[chapter2].ownerTerminal[1].finishReason = 'length' }, 'DRAFT_RECOVERY_EVIDENCE_INVALID'],
      [value => { value[chapter2].ownerTerminal[0].hasFormalEffect = true }, 'DRAFT_RECOVERY_EVIDENCE_INVALID'],
      [value => { value[chapter2].ownerTerminal[1].hasFormalEffect = false }, 'DRAFT_RECOVERY_EVIDENCE_INVALID'],
      [value => { value[chapter2].attempts[1].binding.actual.purpose = 'chapter-draft-continuation'; value[chapter2].ownerTerminal[1].purpose = 'chapter-draft-continuation' }, 'DRAFT_RECOVERY_EVIDENCE_INVALID'],
      [value => { value[chapter2].ownerTerminal.pop() }, 'ACTUAL_OWNER_ARTIFACT_MISMATCH'],
      [value => { value[chapter2].ownerTerminal[1].textHash = hash('other') }, 'ACTUAL_OWNER_ARTIFACT_MISMATCH'],
      // 压缩与首稿必须同 run/root/项目/epoch。
      [value => { value[chapter2].attempts[1].binding.actual.runId = 'run-other' }, 'DRAFT_RECOVERY_OWNER_MISMATCH'],
      // 首个（primary）attempt 的 owner 绑定检查仍有效。
      [value => { value[chapter2].attempts[0].binding.actual.projectId = 'another-project' }, 'DRAFT_RECOVERY_OWNER_MISMATCH']]) {
      const changed = structuredClone(results)
      mutate(changed)
      failed(changed, code)
    }
    // 首稿原文在结算后被改写：hash 不符。
    const tampered = structuredClone(results)
    fs.writeFileSync(tampered[chapter2].attempts[0].outputPath, `${kit.overText}补`)
    failed(tampered, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
    fs.writeFileSync(tampered[chapter2].attempts[0].outputPath, kit.overText)
    // 压缩出现在 directory operation（三章规划）：登记只含「连续章节正文」。
    const directoryIndex = kit.schedule.findIndex(step => step.operation.kind === 'directory' && step.arm === 'candidate')
    const directory = structuredClone(results)
    directory[directoryIndex].attempts.push({ ...structuredClone(directory[directoryIndex].attempts[0]), attemptId: 'candidate:attempt-directory-condense' })
    directory[directoryIndex].syntheticDispatches = 2
    failed(directory, 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH')
    // 下一章前驱仍取被压缩取代的首稿：前驱链断裂。
    const stale = structuredClone(results)
    stale[chapter3].predecessor.contentHash = hash(kit.overText)
    failed(stale, 'FULL_PREDECESSOR_MISMATCH')
    // 既有 primary owner 检查（attempts[0]）保持：项目错位仍拒绝。
    const wrongOwner = structuredClone(results)
    wrongOwner[chapter2].physicalProject.projectId = 'another-project'
    assert.equal(kit.classify(wrongOwner).status, 'failed')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('full 预算：压缩 attempt 与首稿同 slot，计入失败/重试/修复余量；候选 9 章全压缩最坏 +9，不改计划分配', () => {
  const dir = postUiEvidenceDir('full-condense-budget-')
  try {
    const file = path.join(dir, 'synthetic-ledger.jsonl')
    const scenario = PHASE_SCENARIOS.full
    let ordinal = 0
    for (const [index, caseId] of protocol.phases.full.caseIds.entries()) {
      for (const arm of protocol.order.armsByChapter[index].split(',')) {
        for (const operation of scenario.operations.filter(item => item.kind === 'draft' || caseId.endsWith('/1'))) {
          // 候选每个正文章各多一次登记的压缩；baseline 与规划不多发。
          const times = arm === 'candidate' && operation.kind === 'draft' ? 2 : 1
          for (let attempt = 0; attempt < times; attempt++) {
            const attemptId = `${arm}:${caseId}:${operation.id}:${attempt}`
            const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', ...protocolBinding, arm,
              codeSha: 'a'.repeat(40), sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
              phase: 'full', milestone: 'final', caseId, operation: operation.id,
              ...(arm === 'candidate' ? { actual: { attemptId: `actual-${ordinal++}`, runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch' } } : {}) }
            updateLedger(file, { type: 'reserve', attemptId, binding }, { campaignMode: 'synthetic' })
            updateLedger(file, { type: 'dispatch', attemptId }, { campaignMode: 'synthetic' })
            updateLedger(file, { type: 'settle', attemptId }, { campaignMode: 'synthetic' })
          }
        }
      }
    }
    const reserves = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.type === 'reserve')
    const count = allocation => reserves.filter(row => row.allocation === allocation).length
    assert.equal(count('finalPlanning'), 6)
    assert.equal(count('finalChapters'), 18, '首稿仍占 finalChapters 的 18 次，压缩不挤占它')
    assert.equal(count('failedRetryRepairReviewReserve'), 9, '9 次压缩只落在失败/重试/修复余量')
    assert.equal(reserves.length, 6 + 18 + 9)
    assert.ok(reserves.filter(row => row.allocation === 'failedRetryRepairReviewReserve').every(row => row.binding.arm === 'candidate' && row.binding.operation === '连续章节正文'))
    // 计划分配未改：最坏 9 次仍不超过 22 的余量，且总计仍 80（只分类与汇报，不拒发，ADR 0019）。
    assert.ok(9 <= protocol.allocation.failedRetryRepairReviewReserve)
    assert.equal(Object.values(protocol.allocation).reduce((sum, value) => sum + value, 0), protocol.plannedCallAllocation)
    assert.equal(protocol.plannedCallAllocation, 80)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('full 压缩的 fixture 接线（行为）：登记只对候选臂取到，首稿证据取 owner artifact 原文 hash，并与 driver 门禁联通', () => {
  const dir = postUiEvidenceDir('full-condense-wiring-')
  try {
    const fixture = fixtureSource()
    const selectStart = fixture.indexOf('    const policyEligible ='), selectEnd = fixture.indexOf('    let draftCondense = null', selectStart)
    assert.ok(selectStart > 0 && selectEnd > selectStart)
    const select = new Function('request', 'target', 'continuityRun', 'draftCondenseFor',
      `${fixture.slice(selectStart, selectEnd)}\nreturn { repairPolicy, condensePolicy }`)
    const policy = PHASE_SCENARIOS.full.attemptPolicy
    const request = { phase: 'full', milestone: 'final', chapterNumber: 2, attemptPolicy: policy }
    const candidate = select(request, { arm: 'candidate' }, false, draftCondenseFor)
    assert.equal(candidate.condensePolicy, policy.draftCondense)
    assert.equal(select(request, { arm: 'baseline' }, false, draftCondenseFor).condensePolicy, null, 'baseline 恒无压缩登记')
    assert.equal(select(request, { arm: 'baseline' }, false, draftCondenseFor).repairPolicy, policy)
    // 非 final 里程碑、无登记的请求不取到压缩。
    assert.equal(select({ ...request, milestone: 'early' }, { arm: 'candidate' }, false, draftCondenseFor).condensePolicy, null)
    assert.equal(select({ ...request, attemptPolicy: undefined }, { arm: 'candidate' }, false, draftCondenseFor).condensePolicy, null)
    // fixture 交给 driver 门禁的正是这份登记：候选首稿已 stop 结算且超上限才放行唯一压缩，其余 operation 与第二次压缩被拒。
    const proofStart = fixture.indexOf('readPrimaryEvidence: first => {') + 'readPrimaryEvidence: first => {'.length
    const proofEnd = fixture.indexOf('    }, onReject:', proofStart)
    const readEvidence = new Function('first', 'receipt', 'request', 'authorityFacts', 'sha', 'fs', 'target', 'operationKind', 'db', 'continuityRun',
      `const finalizedContext = null, parseFinalizedCharacterStateResponse = null;\n${fixture.slice(proofStart, proofEnd)}`)
    const { syntheticDraftText } = syntheticLengthHelpers()
    const overText = syntheticDraftText(countDraftUnits, FULL_RANGE.maximum + 90), inRange = syntheticDraftText(countDraftUnits, FULL_TARGET)
    const first = { attemptId: 'primary', runId: 'run', rootActionId: 'root', projectId: 'project', epoch: 'epoch', purpose: 'chapter-draft' }
    const condense = { ...first, attemptId: 'condense', purpose: 'chapter-draft-condense' }
    const attemptId = `candidate:${first.attemptId}`, binding = { operation: FULL_DRAFT, actual: first }
    const outputPath = path.join(dir, 'primary.txt'), ledgerPath = path.join(dir, 'ledger.jsonl')
    const facts = ['fact one']
    const attempt = { attemptId, binding, outputPath, visibleTextHash: hash(overText), authorityEvidence: { factHashes: facts.map(hash), allFactsSent: true, predecessorSent: true } }
    let stored = JSON.stringify({ text: overText })
    const db = { prepare: () => ({ pluck: () => ({ get: () => stored }) }) }
    const write = (text, finish = 'stop') => {
      fs.writeFileSync(outputPath, text)
      stored = JSON.stringify({ text })
      fs.writeFileSync(ledgerPath, [{ type: 'reserve', attemptId, binding }, { type: 'dispatch', attemptId }, { type: 'settle', attemptId, finishReason: finish }]
        .map(row => JSON.stringify(row)).join('\n') + '\n')
      attempt.visibleTextHash = hash(text)
    }
    const reader = kind => owner => readEvidence(owner, { attempts: [attempt] }, { ...request, ledgerPath }, facts, hash, fs, { arm: 'candidate' }, kind, db, false)
    const draftCondense = { policy: candidate.condensePolicy, maximum: FULL_RANGE.maximum, measureUnits: countDraftUnits }
    const dispatch = (operation, kind, owner = condense) => {
      const gate = createOperationDispatchGate({ repairPolicy: candidate.repairPolicy, draftCondense, readPrimaryEvidence: reader(kind) })
      gate(operation, first)
      return () => gate(operation, owner)
    }
    write(overText)
    assert.doesNotThrow(dispatch(FULL_DRAFT, 'draft'), '候选超长首稿：唯一压缩放行')
    const twice = (() => { const gate = createOperationDispatchGate({ repairPolicy: candidate.repairPolicy, draftCondense, readPrimaryEvidence: reader('draft') })
      gate(FULL_DRAFT, first); gate(FULL_DRAFT, condense); return () => gate(FULL_DRAFT, { ...condense, attemptId: 'condense-2' }) })()
    assert.throws(twice, /MODEL_REQUEST_REJECTED/)
    assert.throws(dispatch('三章规划', 'directory'), /MODEL_REQUEST_REJECTED/, 'directory 没有压缩登记')
    write(inRange)
    assert.throws(dispatch(FULL_DRAFT, 'draft'), /MODEL_REQUEST_REJECTED/, '首稿在范围内不许压缩')
    write(overText, 'length')
    assert.throws(dispatch(FULL_DRAFT, 'draft'), /MODEL_REQUEST_REJECTED/, '首稿未 stop 结算不许压缩')
    write(overText)
    stored = JSON.stringify({ text: `${overText}改` })
    assert.throws(dispatch(FULL_DRAFT, 'draft'), /MODEL_REQUEST_REJECTED/, 'owner artifact 与物理输出不符')
    // 续写不在 full 登记内：触发即被拒（未登记）。
    stored = JSON.stringify({ text: overText })
    assert.throws(dispatch(FULL_DRAFT, 'draft', { ...first, attemptId: 'continuation', purpose: 'chapter-draft-continuation' }), /MODEL_REQUEST_REJECTED/)
    assert.throws(dispatch(FULL_DRAFT, 'draft', { ...first, attemptId: 'recovery', purpose: 'chapter-draft-no-progress-recovery' }), /MODEL_REQUEST_REJECTED/)
    // baseline 的门禁没有 draftCondense：即使超限也拒绝压缩。
    const baselineGate = createOperationDispatchGate({ repairPolicy: select(request, { arm: 'baseline' }, false, draftCondenseFor).repairPolicy, draftCondense: null })
    const ipc = { attemptId: 'ipc', runId: 'run', projectId: 'project', epoch: 'epoch', purpose: 'chapter-draft' }
    baselineGate(FULL_DRAFT, ipc)
    assert.throws(() => baselineGate(FULL_DRAFT, { ...ipc, attemptId: 'ipc-condense', purpose: 'chapter-draft-condense' }), /MODEL_REQUEST_REJECTED/)
    // 合成正文长度：场景1/2 默认计划下首稿超上限、压缩落入范围；still-over 仍越界（按该章自己的目标与上限）。
    const helpers = syntheticLengthHelpers()
    const chapterTarget = source.scenes.find(scene => scene.id === '场景1').chapters[1].targetUnits, range = draftTargetUnitRange(chapterTarget)
    const units = (plan, purpose) => countDraftUnits(helpers.syntheticDraftText(countDraftUnits, helpers.syntheticDraftUnitsGoal(plan, '场景1/2', purpose, chapterTarget, range.maximum), 2))
    const plan = syntheticDraftCondensePlan({ mode: 'synthetic', development: true, phase: 'full' }).syntheticDraftCondense
    assert.ok(units(plan, 'chapter-draft') > range.maximum)
    assert.ok(units(plan, 'chapter-draft-condense') >= range.minimum && units(plan, 'chapter-draft-condense') <= range.maximum)
    assert.ok(units({ ...plan, outcome: 'still-over' }, 'chapter-draft-condense') > range.maximum)
    assert.ok(units(plan, 'chapter-draft') > range.maximum && helpers.syntheticDraftUnitsGoal(plan, '场景1/3', 'chapter-draft', chapterTarget, range.maximum) === chapterTarget, '其它章不受影响')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('full 端到端（注入假桥）：开发合成默认让候选场景1/2 走「超长→唯一压缩→在范围」，driver 以压缩稿接续前驱并通过分类', () => {
  const dir = postUiEvidenceDir('full-condense-bridge-')
  try {
    const kit = fullReceiptKit(dir), scenario = PHASE_SCENARIOS.full
    const targets = Object.fromEntries(['baseline', 'candidate'].map(arm => [arm, { arm, ...protocolBinding, isolationRoot: path.join(dir, `${arm}-isolation`),
      roots: { userData: path.join(dir, `${arm}-user`), config: path.join(dir, `${arm}-config`) } }]))
    const selection = selectPhase(protocol, 'full', 'final')
    const run = (overrides = {}, bridge) => runProductionPhasePair(targets, { phase: 'full', development: true, mode: 'synthetic', milestone: 'final',
      scenarioRevision: scenario.scenarioRevision, attemptPolicy: selection.attemptPolicy, order: protocol.order, ...protocolBinding,
      semanticPath: path.join(ROOT, protocol.fixturePath), templatesPath: path.join(dir, 'templates'), ledgerPath: path.join(dir, 'ledger.jsonl'), ...overrides }, bridge)
    // 假桥：按 driver 交来的请求（默认计划、前驱、invocationId）复现 fixture 的行为，逐步返回 fixture 形状的收据。
    const fakeBridge = requests => request => {
      requests.push(request)
      if (request.action === 'prepare') return { arm: request.target.arm, sceneId: request.sceneId, physicalProject: { parityHash: hash(request.sceneId) } }
      const index = requests.filter(item => item.action === 'execute').length - 1, step = kit.schedule[index]
      assert.deepEqual([request.caseId, request.target.arm], [step.caseId, step.arm])
      const plan = request.syntheticDraftCondense
      const condensing = step.operation.kind === 'draft' && draftCondenseFor(request.attemptPolicy, request.target.arm) && plan?.caseId === request.caseId
      if (condensing && plan.outcome === 'still-over') throw Object.assign(new Error('REAL_PRODUCTION_BRIDGE_FAILED'), {})
      return fullStepReceipt(dir, step, index, { invocationId: request.invocationId, parityId: request.parityHash, predecessor: request.predecessor,
        tag: '-bridge', ...(condensing ? { condense: { primaryText: kit.overText, output: kit.condensedText } } : {}) })
    }
    const executes = requests => requests.filter(item => item.action === 'execute')
    // 开发合成默认：24 步 + 候选场景1/2 的 1 次压缩 = 25 次合成 dispatch，收据分类通过。
    const requests = []
    const result = run({}, fakeBridge(requests))
    assert.equal(result.status, 'passed')
    assert.equal(result.pairFailure, undefined)
    assert.equal(result.syntheticDispatches, 25)
    assert.equal(executes(requests).length, 24)
    assert.deepEqual(new Set(executes(requests).map(item => JSON.stringify(item.syntheticDraftCondense))), new Set([JSON.stringify({ caseId: '场景1/2', outcome: 'in-range' })]))
    assert.deepEqual(result.attemptPolicy, scenario.attemptPolicy, '登记与不对称披露随结果一起给出')
    const dispatches = result.results.map(item => [item.caseId, item.arm, item.attempts.length])
    assert.deepEqual(dispatches.filter(([, , count]) => count === 2), [['场景1/2', 'candidate', 2]])
    // 前驱链：候选场景1/3 的请求前驱是场景1/2 保存的压缩稿；baseline 不受影响。
    const chapter3 = executes(requests).find(item => item.caseId === '场景1/3' && item.target.arm === 'candidate')
    assert.equal(chapter3.predecessor.contentHash, hash(kit.condensedText))
    assert.equal(executes(requests).find(item => item.caseId === '场景1/3' && item.target.arm === 'baseline').predecessor.contentHash, hash('甲'.repeat(FULL_TARGET)))
    // 正式合成（无 development）不带计划：24 次 dispatch，无压缩。
    // 正式合成即使被传入计划也不带它（计划只属于开发合成）。
    const formal = []
    const plainResult = run({ development: false, syntheticDraftCondense: { caseId: '场景1/2', outcome: 'in-range' } }, fakeBridge(formal))
    assert.equal(plainResult.status, 'passed')
    assert.equal(plainResult.syntheticDispatches, 24)
    assert.ok(executes(formal).every(item => item.syntheticDraftCondense === undefined))
    // still-over：压缩后仍越界——产品按原失败语义失败，full 在该步停发并保留未运行列表。
    const stillOver = []
    const failedRun = run({ syntheticDraftCondense: { caseId: '场景1/2', outcome: 'still-over' } }, fakeBridge(stillOver))
    assert.equal(failedRun.status, 'failed')
    assert.equal(failedRun.results.at(-1).status, 'failed')
    assert.equal(failedRun.results.at(-1).caseId, '场景1/2')
    assert.equal(failedRun.notRun.length, kit.schedule.length - failedRun.results.length)
    assert.ok(failedRun.notRun.length > 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})


test('full continuation then condense keeps each raw candidate and binds saved/reviewable bytes and chapter 3 predecessor', () => {
  const dir = postUiEvidenceDir('full-recovery-receipt-')
  try {
    const kit = fullReceiptKit(dir), index = kit.at('场景1/2', 'candidate'), nextIndex = kit.at('场景1/3', 'candidate')
    const results = kit.build({ condenseAt: index }), result = results[index]
    const first = result.attempts[0], last = result.attempts[1]
    fs.writeFileSync(first.outputPath, '甲'.repeat(500)); first.visibleTextHash = hash('甲'.repeat(500))
    const middle = structuredClone(first)
    middle.attemptId += '-continuation'; middle.binding.actual.attemptId += '-continuation'
    middle.binding.actual.purpose = 'chapter-draft-continuation'
    middle.outputPath = path.join(dir, 'continuation.txt')
    fs.writeFileSync(middle.outputPath, '乙'.repeat(900)); middle.visibleTextHash = hash('乙'.repeat(900))
    result.attempts = [first, middle, last]
    for (const attempt of result.attempts) attempt.finishReason = 'stop'
    result.syntheticDispatches = 3
    result.ownerTerminal = result.attempts.map((attempt, at) => ({ attemptId: attempt.binding.actual.attemptId,
      artifactId: `artifact-${at}`, textHash: attempt.visibleTextHash, finishReason: 'stop', purpose: attempt.binding.actual.purpose,
      hasFormalEffect: at === 2 }))
    assert.equal(kit.classify(results).status, 'passed')
    assert.equal(fs.readFileSync(first.outputPath, 'utf8'), '甲'.repeat(500))
    const wrongSave = structuredClone(results)
    wrongSave[index].saved.contentHash = first.visibleTextHash
    assert.equal(kit.classify(wrongSave).status, 'failed')
    const wrongPredecessor = structuredClone(results)
    wrongPredecessor[nextIndex].predecessor.contentHash = first.visibleTextHash
    assert.equal(kit.classify(wrongPredecessor).pairFailure, 'FULL_PREDECESSOR_MISMATCH')
    const wrongEffect = structuredClone(results)
    wrongEffect[index].ownerTerminal[1].hasFormalEffect = true
    assert.equal(kit.classify(wrongEffect).pairFailure, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})


test('H5 length overlong primary followed directly by condense passes full/post-UI/C16 current receipts', () => {
  const dir = postUiEvidenceDir('length-condense-receipts-')
  try {
    const update = (result, operation) => {
      const first = result.attempts.find(attempt => attempt.binding.operation === operation && attempt.binding.actual?.purpose === 'chapter-draft')
      first.finishReason = 'length'
      result.ownerTerminal.find(item => item.attemptId === first.binding.actual.attemptId).finishReason = 'length'
    }
    const full = fullReceiptKit(dir), index = full.at('场景1/2', 'candidate'), values = full.build({ condenseAt: index })
    update(values[index], FULL_DRAFT)
    assert.equal(full.classify(values).status, 'passed')
    const post = postUiCondensePairKit(dir), value = post.make('candidate')
    update(value, POST_UI_DRAFT)
    assert.equal(post.classify(value).pairFailure, undefined)
    const continuity = continuityResults(dir, { condensedIndex: 3, primaryText: '甲'.repeat(1400) })
    update(continuity[3], '本地恢复后续写')
    assert.deepEqual(validateCandidateContinuityResults(continuity, 'synthetic'), { status: 'passed' })
    // A second compression still has no permission; a short length primary must continue, not condense.
    const wrong = continuityResults(dir, { condensedIndex: 3, primaryText: '甲'.repeat(500) })
    update(wrong[3], '本地恢复后续写')
    assert.equal(validateCandidateContinuityResults(wrong, 'synthetic').candidateFailure, 'DRAFT_RECOVERY_EVIDENCE_INVALID')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
