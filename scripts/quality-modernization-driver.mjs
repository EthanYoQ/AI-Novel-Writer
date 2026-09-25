import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { isExpectedReferenceEvidenceFailure, isVerifiedDirectPersistedDraftEvidence, isVerifiedRecoverySupplementEvidence,
  readVerifiedDirectPersistedDraftEvidence, readVerifiedRecoveryCandidateSupplement } from './quality-modernization-receipt.mjs'

const ADAPTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PRODUCTION_BRIDGE = 'scripts/fixtures/quality-modernization-production.fixture.mjs'
export const EARLY_REVIEW_REFERENCE_ADJUDICATION_REVISION = 's11-reference-no-actionable-review-v1'
const THIRTY_PERCENT_TOLERANCE_REVISION = 'draft-units-tolerance-30-v1'
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
export function productionBridgeHash() {
  return digest([PRODUCTION_BRIDGE, 'scripts/quality-modernization-driver.mjs'].map(file => [file, digest(fs.readFileSync(path.join(ADAPTER_ROOT, file)))]))
}
export function productionExecutionRuntime(target) {
  const require = createRequire(path.join(target.repositoryRoot, 'package.json'))
  return target.arm === 'baseline'
    ? { executable: require('electron'), electronRunAsNode: true }
    : { executable: process.execPath, electronRunAsNode: false }
}
export function selectOwnerDispatch(db, handle, session, body) {
  const rows = db.prepare("SELECT a.*,r.binding_json FROM generation_attempts a JOIN generation_runs r ON r.run_id=a.run_id WHERE json_extract(a.attempt_json,'$.status')='dispatch-marked'").all()
  if (rows.length !== 1) throw new Error('NON_UNIQUE_OWNER_DISPATCH')
  const row = rows[0], binding = JSON.parse(row.binding_json), attempt = JSON.parse(row.attempt_json)
  if (!handle || row.run_id !== handle.runId || row.root_action_id !== handle.rootActionId
    || handle.projectId !== session.projectId || handle.epoch !== session.leaseId
    || binding.projectId !== session.projectId || binding.epoch !== session.leaseId
    || attempt.attemptId !== row.attempt_id
    || attempt.requestedOutputTokens !== (body.max_tokens ?? body.max_completion_tokens)) throw new Error('OWNER_DISPATCH_IDENTITY_MISMATCH')
  return { attemptId: row.attempt_id, runId: row.run_id, rootActionId: row.root_action_id, projectId: binding.projectId, epoch: binding.epoch }
}

/**
 * 单个 attempt 的桥内结算预算。三个串行 attempt 的完整窗口必须短于父进程
 * spawn 预算，而 spawn 预算再短于 Vitest 超时，给 unknown 落账与进程收尾留出余量。
 */
export const BRIDGE_SETTLEMENT_DEADLINE_MS = 480_000
export const BRIDGE_SPAWN_TIMEOUT_MS = BRIDGE_SETTLEMENT_DEADLINE_MS * 3 + 60_000
export const BRIDGE_TEST_TIMEOUT_MS = BRIDGE_SPAWN_TIMEOUT_MS + 60_000

/** 只测规模、不落内容：返回提示词载荷的 UTF-8 字节数，绝不含提示词原文或凭据。 */
export function measurePromptBytes(messages) {
  return Buffer.byteLength(JSON.stringify(messages ?? []), 'utf8')
}

/** Deterministic outbound checks fail before campaign accounting and stay out of network diagnostics. */
export function createOutboundPreflightAssert(failures) {
  if (!Array.isArray(failures)) throw new Error('PREFLIGHT_FAILURES_REQUIRED')
  return (condition, code) => {
    if (condition) return
    failures.push(code)
    throw new Error(code)
  }
}

/** The only place where provider transport failures enter fetchFailures. */
export async function fetchProviderResponse(fetcher, url, options, failures, diagnostic = value => String(value)) {
  if (typeof fetcher !== 'function' || !Array.isArray(failures)) throw new Error('PROVIDER_FETCH_ARGUMENTS_INVALID')
  let response
  try { response = await fetcher(url, options) }
  catch (error) {
    failures.push(diagnostic(error instanceof Error ? error.message : String(error)))
    throw error
  }
  if (!response?.ok || !response.body) {
    failures.push('PROVIDER_HTTP_FAILED')
    throw new Error('PROVIDER_HTTP_FAILED')
  }
  return response
}

/**
 * 桥自身的结算守护：每个 dispatch attempt 各自持有一个短于桥测试超时的截止时间。
 *
 * 桥测试的 120s 超时是进程内的 JS 计时器：它不投递任何信号，也不会先运行 finally，
 * 所以「等网络流结束后再写 settle/unknown」在供应商卡住时永远等不到——账本里只剩
 * reserve+dispatch，这次发送既不 settle 也不 unknown，花费不可审计，也违反了
 * 「dispatch 之后必须 settle 或 unknown，未知不得退款」的规则。这里让桥自己持有
 * 截止时间：
 *   - terminal(): 幂等。同一 attemptId 只写一条 settle/unknown，重复调用是 no-op，
 *     因此「刚写 unknown 又想把同一次发送改写为 settle」不可能发生。
 *   - 到点: 先为该 attempt 写 unknown（占用、不退款），再 abort 它的 fetch，
 *     让等待方以失败结束——先落账，后失败。后续 attempt 从各自 dispatch 起获得完整预算；
 *     dispatch 之前的取消仍然只走 cancel。
 *
 * 被拒绝的方案：改用 process 信号/退出钩子收尾。测试超时是进程内计时器，不发送任何
 * 信号，SIGTERM 处理器根本不会触发；'exit' 处理器必须同步、无法等待未决的流；而工作
 * 进程被强杀（SIGKILL/terminate）时两者都不会运行。守护计时器活在同一个事件循环里：
 * await 网络时事件循环是空闲的，所以它一定会跑；正常收尾时由 dispose() 明确清除。
 */
export function createAttemptSupervisor({ record, deadlineMs = BRIDGE_SETTLEMENT_DEADLINE_MS } = {}) {
  if (typeof record !== 'function') throw new Error('SUPERVISOR_RECORD_REQUIRED')
  const open = new Map()
  const closed = new Set()
  const timers = new Map()
  const expired = new Set()
  const terminal = (attemptId, type, extra = {}) => {
    if (closed.has(attemptId)) return false
    // 先写账本再记终态：写失败（例如 LEDGER_BUSY）不吞掉终态，调用方仍可重试。
    record({ type, attemptId, ...extra })
    closed.add(attemptId)
    open.delete(attemptId)
    const timer = timers.get(attemptId)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(attemptId)
    return true
  }
  const expireAttempt = attemptId => {
    const controller = open.get(attemptId)
    if (!open.has(attemptId)) return
    expired.add(attemptId)
    try { terminal(attemptId, 'unknown', { reasonCode: 'BRIDGE_SETTLEMENT_DEADLINE_EXCEEDED' }) } catch { /* 账本暂不可写也必须继续 abort */ }
    try { controller?.abort?.(new Error('ATTEMPT_DEADLINE_EXCEEDED')) } catch { /* ignore */ }
  }
  return {
    watch(attemptId, controller) {
      open.set(attemptId, controller ?? null)
      if (deadlineMs > 0) timers.set(attemptId, setTimeout(() => expireAttempt(attemptId), deadlineMs))
    },
    terminal,
    dispose: () => { for (const timer of timers.values()) clearTimeout(timer); timers.clear() },
    expired: attemptId => attemptId ? expired.has(attemptId) : expired.size > 0,
    openAttempts: () => open.size,
  }
}
export function runProductionBridge(request) {
  const target = request.target
  const runtime = productionExecutionRuntime(target)
  const requestFile = path.join(target.isolationRoot, `${request.action}-request.json`)
  const config = path.join(target.isolationRoot, 'production-bridge.vitest.config.mjs')
  const report = path.join(target.isolationRoot, `${request.action}-vitest.json`)
  request.receiptPath = path.join(target.isolationRoot, `${request.action}-receipt.json`)
  fs.writeFileSync(requestFile, JSON.stringify(request, null, 2))
  fs.writeFileSync(config, `export default ${JSON.stringify({
    root: ADAPTER_ROOT,
    resolve: { alias: { vitest: path.join(target.repositoryRoot, 'node_modules/vitest/dist/index.js'),
      electron: path.join(target.repositoryRoot, 'node_modules/electron/index.js') } },
    test: { include: [PRODUCTION_BRIDGE], exclude: [], environment: 'node',
      globals: false, maxWorkers: 1, fileParallelism: false, testTimeout: BRIDGE_TEST_TIMEOUT_MS },
  })}\n`)
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'ComSpec'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  Object.assign(env, { QUALITY_BRIDGE_REQUEST: requestFile, QUALITY_USER_DATA: target.roots.userData,
    HOME: target.roots.userData, USERPROFILE: target.roots.userData, APPDATA: target.roots.userData, LOCALAPPDATA: target.roots.userData,
    TEMP: target.isolationRoot, TMP: target.isolationRoot, AI_NOVEL_APP_DATA_HOME: target.roots.config,
    AI_NOVEL_LEGACY_SOURCE_HOME: target.roots.legacySource,
    AI_NOVEL_VELA_HOME: target.arm === 'baseline' ? target.roots.config : target.roots.legacySource,
    ...(runtime.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) })
  const guard = path.join(target.isolationRoot, 'network-denied.mjs')
  if (request.mode === 'synthetic') fs.writeFileSync(guard, "import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https'; import {syncBuiltinESMExports} from 'node:module'; const deny=()=>{throw new Error('NETWORK_FORBIDDEN')};globalThis.fetch=deny;net.Socket.prototype.connect=deny;tls.connect=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;syncBuiltinESMExports();")
  const argv = [...(request.mode === 'synthetic' ? ['--import', pathToFileURL(guard).href] : []), path.join(target.repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    '--reporter=json', `--outputFile=${report}`]
  const result = spawnSync(runtime.executable, argv, { cwd: target.repositoryRoot, env, encoding: 'utf8',
    // 三次串行 operation 各自拥有 480s；先由 attempt 守护收口，再由父进程 spawn、最后 Vitest 兜底。
    timeout: BRIDGE_SPAWN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  const secret = request.mode === 'real'
    ? JSON.parse(fs.readFileSync(path.join(target.roots.config, 'models.json'), 'utf8')).find(model => model.id === target.modelId)?.apiKey : null
  const redact = value => secret ? String(value ?? '').split(secret).join('[REDACTED]') : String(value ?? '')
  fs.writeFileSync(path.join(target.isolationRoot, `${request.action}-stdout.log`), redact(result.stdout))
  fs.writeFileSync(path.join(target.isolationRoot, `${request.action}-stderr.log`), redact(result.stderr))
  for (const file of [report, request.receiptPath]) if (secret && fs.existsSync(file)) fs.writeFileSync(file, redact(fs.readFileSync(file, 'utf8')))
  const receipt = fs.existsSync(request.receiptPath) ? JSON.parse(fs.readFileSync(request.receiptPath, 'utf8')) : null
  if (result.status !== 0 || !receipt || !['prepared', 'passed'].includes(receipt.status)) {
    throw Object.assign(new Error('PRODUCTION_BRIDGE_FAILED'), { detail: receipt?.error, receiptPath: request.receiptPath,
      exitCode: result.status, stderrPath: path.join(target.isolationRoot, `${request.action}-stderr.log`) })
  }
  const testReport = JSON.parse(fs.readFileSync(report, 'utf8'))
  if (testReport.numPassedTests !== 1 || testReport.numTotalTests !== 1) throw new Error('PRODUCTION_BRIDGE_COVERAGE_MISMATCH')
  return { ...receipt, command: { executable: runtime.executable, argv, cwd: target.repositoryRoot, shell: false }, receiptPath: request.receiptPath }
}

// A phase scenario is the bridge-side counterpart of one preregistered protocol phase.
// The protocol stays the only authority for case ids and operation ids; this map only
// says which production commands realize them. The runner re-checks every field against
// the selected protocol phase before opening the gate, so a drift here fails closed
// instead of quietly running a different experiment.
export const PHASE_SCENARIOS = Object.freeze({
  'early-budget': Object.freeze({
    caseId: '场景1/1',
    sceneId: '场景1',
    chapterNumber: 1,
    milestone: 'early',
    operations: Object.freeze([
      Object.freeze({ id: '指定范围生成', kind: 'directory' }),
      Object.freeze({ id: '900单位正文', kind: 'draft' }),
    ]),
  }),
  'early-context': Object.freeze({
    caseId: '场景2/3',
    sceneId: '场景2',
    chapterNumber: 3,
    milestone: 'early',
    scenarioRevision: 's10b-early-context-selection-difference-v3',
    selectionDifference: Object.freeze({
      requireDifferentPromptHash: true,
      requireDifferentPromptBytes: true,
      requireCandidateBudgetOmission: true,
      requireCandidateRequiredCoverage: true,
      requireBaselineSentCandidateOmission: true,
      requirePhysicalProjectParity: true,
    }),
    operations: Object.freeze([
      Object.freeze({ id: '长设定第三章正文', kind: 'draft' }),
    ]),
  }),
  'early-review': Object.freeze({
    caseId: '场景3/2',
    sceneId: '场景3',
    chapterNumber: 2,
    milestone: 'early',
    scenarioRevision: 's11-early-review-per-attempt-deadline-v3',
    operations: Object.freeze([
      Object.freeze({ id: '审稿', kind: 'review' }),
      Object.freeze({ id: '定向修稿', kind: 'refine' }),
      Object.freeze({ id: '一次复核', kind: 'recheck' }),
    ]),
  }),
})
export function productionScenario(phase) {
  const scenario = PHASE_SCENARIOS[phase]
  if (!scenario) throw new Error('PHASE_PRODUCTION_ADAPTER_NOT_INTEGRATED')
  return scenario
}

/** One registered operation may cross the provider boundary at most once. */
export function createOperationDispatchGate({ onReject } = {}) {
  const dispatched = new Set()
  return operationId => {
    if (!operationId || dispatched.has(operationId)) {
      const rejection = Object.freeze({ code: 'UNREGISTERED_ADDITIONAL_MODEL_REQUEST',
        operationId: operationId || null, reason: operationId ? 'duplicate-operation' : 'missing-operation', beforeDispatch: true })
      onReject?.(rejection)
      throw Object.assign(new Error('MODEL_REQUEST_REJECTED'), { code: 'OPERATION_DISPATCH_REJECTED' })
    }
    dispatched.add(operationId)
  }
}

const validDraftObservation = observation => Number.isSafeInteger(observation?.chapterNumber) && observation.chapterNumber > 0
  && Number.isSafeInteger(observation?.units) && observation.units > 0
  && Number.isSafeInteger(observation?.targetUnits) && observation.targetUnits > 0
  && observation.persisted === true && /^[a-f0-9]{64}$/.test(observation.contentHash ?? '')
const withinTargetUnits = (observation, protocolRevision, arm) => {
  const tolerance = protocolRevision === THIRTY_PERCENT_TOLERANCE_REVISION && arm !== 'baseline' ? 0.3 : 0.2
  return validDraftObservation(observation)
    && observation.units >= Math.floor(observation.targetUnits * (1 - tolerance))
    && observation.units <= Math.ceil(observation.targetUnits * (1 + tolerance))
}
function hasReviewableDraft(result) {
  const observation = result?.draftObservation
  const output = result?.operations?.find(operation => operation.kind === 'draft')?.outputPath
  if (!validDraftObservation(observation) || typeof output !== 'string') return false
  try { return digest(fs.readFileSync(output, 'utf8')) === observation.contentHash } catch { return false }
}
const savedMatchesObservation = result => result?.saved?.chapterNumber === result?.draftObservation?.chapterNumber
  && result.saved.targetUnits === result.draftObservation.targetUnits && result.saved.units === result.draftObservation.units
  && result.saved.contentHash === result.draftObservation.contentHash
const stableEvidence = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item)
const CONTENT_HASH = /^[a-f0-9]{64}$/
const MATERIAL_METHOD = 'utf8-bytes-v1'
const MATERIAL_CATEGORIES = new Set(['author', 'finalized-history', 'future-plan', 'derived-locator', 'reference'])
const sourceIdentity = item => JSON.stringify([item?.sourceId, item?.revision, item?.contentHash])
const sourceIdentityWithReason = item => JSON.stringify([item?.sourceId, item?.revision, item?.contentHash, item?.reason])
const validCount = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum
function validatePairedReceipt(result, { mode, arm, phase, scenario, protocolRevision, protocolHash }) {
  const invocationId = result?.invocationId
  if (typeof protocolRevision !== 'string' || !protocolRevision || !CONTENT_HASH.test(protocolHash ?? '')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocationId ?? '')
    || !result || result.mode !== mode || result.arm !== arm || result.phase !== phase
    || result.caseId !== scenario.caseId || result.protocolRevision !== protocolRevision || result.protocolHash !== protocolHash)
    return 'PAIR_BINDING_MISMATCH'
  if (!Array.isArray(result.attempts) || result.attempts.length !== scenario.operations.length)
    return 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH'
  for (const operation of scenario.operations) {
    const matches = result.attempts.filter(attempt => attempt?.binding?.operation === operation.id)
    if (matches.length !== 1) return 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH'
    const binding = matches[0].binding
    if (binding.mode !== mode || binding.arm !== arm || binding.phase !== phase || binding.caseId !== scenario.caseId
      || binding.invocationId !== invocationId
      || binding.protocolRevision !== protocolRevision || binding.protocolHash !== protocolHash
      || phase === 'early-review' && (binding.codeSha !== result.codeSha || binding.sourceHash !== result.sourceHash
        || binding.driverHash !== result.driverHash || binding.parityId !== result.physicalProject?.parityHash))
      return 'ATTEMPT_BINDING_MISMATCH'
    if (phase === 'early-review' && arm === 'candidate') {
      const actual = binding.actual
      const persisted = result.operations?.find(item => item.operation === operation.id)
      if (!actual || !persisted?.handle
        || `${arm}:${actual.attemptId}` !== matches[0].attemptId || actual.runId !== persisted.handle.runId
        || actual.rootActionId !== persisted.handle.rootActionId
        || actual.projectId !== result.physicalProject?.projectId || actual.epoch !== result.projectEpoch)
        return 'ACTUAL_OWNER_ATTEMPT_MISMATCH'
    }
  }
  const expectedPhysical = mode === 'real' ? scenario.operations.length : 0
  const expectedSynthetic = mode === 'synthetic' ? scenario.operations.length : 0
  if (result.physicalModelRequests !== expectedPhysical || result.syntheticDispatches !== expectedSynthetic)
    return 'PHYSICAL_CALL_COUNT_MISMATCH'
  return null
}

export function validateEarlyReviewChain(result, arm) {
  const fail = pairFailure => ({ valid: false, pairFailure })
  const lifecycle = result?.reviewLifecycle
  if (!lifecycle || !Array.isArray(result.operations) || result.operations.length !== 3
    || stableEvidence(result.operations.map(item => [item.operation, item.kind])) !== stableEvidence([
      ['审稿', 'review'], ['定向修稿', 'refine'], ['一次复核', 'recheck'],
    ])) return fail('REVIEW_CHAIN_OPERATION_MISMATCH')
  const hashes = [lifecycle.source?.contentHash, lifecycle.review?.contentHash,
    lifecycle.confirmation?.contentHash, lifecycle.confirmation?.selectedItemHash,
    lifecycle.revision?.contentHash, lifecycle.merge?.mergedHash,
    lifecycle.recheck?.contentHash]
  if (hashes.some(value => !CONTENT_HASH.test(value ?? ''))
    || lifecycle.review.contentHash !== result.operations[0]?.outputHash
    || lifecycle.revision.contentHash !== result.operations[1]?.outputHash
    || lifecycle.recheck.contentHash !== result.operations[2]?.outputHash
    || lifecycle.revision.contentHash !== lifecycle.merge.mergedHash) return fail('REVIEW_CHAIN_RECEIPT_INVALID')
  if (arm === 'candidate') {
    const roots = result.attempts.map(attempt => attempt.binding?.actual?.rootActionId)
    if (roots.some(root => typeof root !== 'string' || !root) || new Set(roots).size !== 1)
      return fail('REVIEW_CHAIN_ROOT_MISMATCH')
    if (!Array.isArray(lifecycle.confirmation.selectedFindingIds)
      || lifecycle.confirmation.selectedFindingIds.length !== 1
      || lifecycle.confirmation.selectedFindingIds.some(id => typeof id !== 'string' || !id)
      || !lifecycle.review.cycleId || lifecycle.review.cycleId !== lifecycle.confirmation.cycleId
      || lifecycle.review.cycleId !== lifecycle.merge.cycleId || lifecycle.review.cycleId !== lifecycle.recheck.cycleId
      || lifecycle.merge.disposition !== 'required' || lifecycle.recheck.recheckCount !== 1
      || lifecycle.recheck.disposition !== 'completed'
      || lifecycle.recheck.effect?.version !== 2 || lifecycle.recheck.effect.findingMappings !== 0
      || !lifecycle.recheck.statuses || Object.values(lifecycle.recheck.statuses)
        .some(value => !Number.isSafeInteger(value) || value < 0)
      || (lifecycle.recheck.statuses.resolved ?? 0) !== 0
      || !Number.isSafeInteger(lifecycle.recheck.statuses.unknown) || lifecycle.recheck.statuses.unknown < 1
      || Object.values(lifecycle.recheck.statuses).reduce((sum, value) => sum + value, 0) < 1)
      return fail('REVIEW_CYCLE_RECEIPT_INVALID')
    const reviewAttempt = result.attempts.find(attempt => attempt.binding?.operation === '审稿')
    const decision = reviewAttempt?.optionalMaterialEvidence?.materialDecision
    const decisionFailure = validateMaterialDecision(decision, [])
    if (decisionFailure) return fail('REVIEW_MATERIAL_DECISION_INVALID')
    const predecessors = result.physicalProject?.readback?.predecessors
    const requiredPredecessors = Array.isArray(predecessors) ? predecessors.filter(item => item?.required === true) : []
    const predecessor = requiredPredecessors[0]
    const included = decision.included.filter(item => item.required === true)
    const recorded = Array.isArray(result.materialDecisions)
      ? result.materialDecisions.filter(item => item?.operation === '审稿') : []
    if (requiredPredecessors.length !== 1 || included.length !== 1 || decision.omitted.length !== 0
      || decision.coverage.required !== 1 || decision.coverage.included !== 1 || decision.coverage.complete !== true
      || included[0].sourceId !== predecessor.sourceId || included[0].revision !== predecessor.revision
      || included[0].contentHash !== predecessor.contentHash || included[0].category !== 'finalized-history'
      || reviewAttempt.authorityEvidence?.predecessorHash !== predecessor.contentHash
      || reviewAttempt.userPromptHash !== decision.promptHash
      || recorded.length !== 1 || stableEvidence(recorded[0].receipt) !== stableEvidence(decision))
      return fail('REVIEW_MATERIAL_DECISION_MISMATCH')
  }
  return { valid: true }
}
function validateMaterialDecision(decision, registered) {
  if (!decision || decision.version !== 1 || decision.verdict !== 'admitted' || !CONTENT_HASH.test(decision.promptHash ?? '')
    || !decision.capacity || !validCount(decision.capacity.maxInputUnits, 1)
    || decision.capacity.methodVersion !== MATERIAL_METHOD || !validCount(decision.capacity.admittedUnits)
    || decision.capacity.admittedUnits > decision.capacity.maxInputUnits
    || !decision.coverage || !validCount(decision.coverage.required)
    || !validCount(decision.coverage.included) || decision.coverage.included > decision.coverage.required
    || typeof decision.coverage.complete !== 'boolean'
    || !Array.isArray(decision.included) || !Array.isArray(decision.omitted)) return 'MATERIAL_DECISION_RECEIPT_INVALID'
  const validateSource = (item, { included }) => Boolean(item && typeof item.sourceId === 'string' && item.sourceId.trim()
    && validCount(item.revision) && CONTENT_HASH.test(item.contentHash ?? '') && typeof item.category === 'string'
    && MATERIAL_CATEGORIES.has(item.category) && typeof item.required === 'boolean'
    && (!included || validCount(item.units, 1)) && (included ? true : typeof item.reason === 'string' && item.reason.trim()))
  if (decision.included.some(item => !validateSource(item, { included: true }))
    || decision.omitted.some(item => !validateSource(item, { included: false }))) return 'MATERIAL_DECISION_RECEIPT_INVALID'
  const includedKeys = new Set(decision.included.map(sourceIdentity))
  const omittedKeys = new Set(decision.omitted.map(sourceIdentityWithReason))
  if (includedKeys.size !== decision.included.length || omittedKeys.size !== decision.omitted.length
    || decision.included.some(item => decision.omitted.some(omitted => sourceIdentity(item) === sourceIdentity(omitted))))
    return 'MATERIAL_DECISION_DUPLICATE_SOURCE'
  const requiredKeys = new Set([...decision.included, ...decision.omitted].filter(item => item.required).map(sourceIdentity))
  const coveredRequired = decision.included.filter(item => item.required).length
  if (requiredKeys.size !== decision.coverage.required || coveredRequired !== decision.coverage.included
    || decision.included.reduce((sum, item) => sum + item.units, 0) !== decision.capacity.admittedUnits)
    return 'MATERIAL_DECISION_COVERAGE_MISMATCH'
  const registeredByKey = new Map(registered.map(item => [sourceIdentity(item), item]))
  for (const item of decision.omitted.filter(item => item.reason === 'budget')) {
    if (item.required || !registeredByKey.has(sourceIdentity(item))) return 'CANDIDATE_BUDGET_IDENTITY_MISMATCH'
  }
  return null
}
function validateSentEvidence(optional, registered) {
  if (!Array.isArray(optional?.sent) || !Array.isArray(optional.sentSourceIds)
    || optional.sentSourceIds.length !== optional.sent.length) return 'SENT_SOURCE_EVIDENCE_INVALID'
  const registeredByKey = new Map(registered.map(item => [sourceIdentity(item), item]))
  const sentKeys = new Set()
  for (const item of optional.sent) {
    const registeredItem = registeredByKey.get(sourceIdentity(item))
    if (!item || typeof item.sourceId !== 'string' || !validCount(item.revision) || !CONTENT_HASH.test(item.contentHash ?? '')
      || !CONTENT_HASH.test(item.persistedContentHash ?? '') || !validCount(item.persistedBytes, 1) || !CONTENT_HASH.test(item.markerHash ?? '')
      || !registeredItem || item.persistedContentHash !== registeredItem.persistedContentHash
      || item.persistedBytes !== registeredItem.persistedBytes || item.markerHash !== registeredItem.markerHash
      || sentKeys.has(sourceIdentity(item))) return 'SENT_SOURCE_EVIDENCE_INVALID'
    sentKeys.add(sourceIdentity(item))
  }
  if (stableEvidence(optional.sentSourceIds) !== stableEvidence(optional.sent.map(item => item.sourceId)))
    return 'SENT_SOURCE_EVIDENCE_INVALID'
  return { sentKeys }
}
export function validateEarlyContextSelectionDifference(baseline, candidate) {
  const baselineAttempt = baseline?.attempts?.find(attempt => attempt.binding?.operation === '长设定第三章正文')
  const candidateAttempt = candidate?.attempts?.find(attempt => attempt.binding?.operation === '长设定第三章正文')
  const fail = pairFailure => ({ valid: false, pairFailure })
  if (!baselineAttempt || !candidateAttempt
    || !/^[a-f0-9]{64}$/.test(baselineAttempt.compiledPromptHash ?? '')
    || !/^[a-f0-9]{64}$/.test(candidateAttempt.compiledPromptHash ?? '')
    || !Number.isSafeInteger(baselineAttempt.composedPromptBytes) || baselineAttempt.composedPromptBytes < 1
    || !Number.isSafeInteger(candidateAttempt.composedPromptBytes) || candidateAttempt.composedPromptBytes < 1)
    return fail('PROMPT_SELECTION_EVIDENCE_MISSING')
  if (baselineAttempt.compiledPromptHash === candidateAttempt.compiledPromptHash
    || baselineAttempt.composedPromptBytes === candidateAttempt.composedPromptBytes)
    return fail('PROMPT_SELECTION_NOT_DIFFERENT')
  if (!/^[a-f0-9]{64}$/.test(baseline?.physicalProject?.parityHash ?? '')
    || baseline.physicalProject.parityHash !== candidate?.physicalProject?.parityHash)
    return fail('ACTUAL_PROJECT_PARITY_FAILED')
  if (stableEvidence(baseline.promptMapping) !== stableEvidence(candidate.promptMapping))
    return fail('ACTUAL_TEMPLATE_PARITY_FAILED')
  const baselineOptional = baselineAttempt.optionalMaterialEvidence
  const candidateOptional = candidateAttempt.optionalMaterialEvidence
  if (!Array.isArray(baselineOptional?.registered) || baselineOptional.registered.length < 1
    || stableEvidence(baselineOptional.registered) !== stableEvidence(candidateOptional?.registered))
    return fail('OPTIONAL_MATERIAL_PARITY_FAILED')
  const validateRegistered = registered => {
    const keys = new Set()
    for (const item of registered) {
      if (!item || typeof item.sourceId !== 'string' || !item.sourceId.trim() || !validCount(item.revision)
        || !CONTENT_HASH.test(item.contentHash ?? '') || !CONTENT_HASH.test(item.persistedContentHash ?? '') || !validCount(item.persistedBytes, 1)
        || !CONTENT_HASH.test(item.markerHash ?? '') || keys.has(sourceIdentity(item))) return false
      keys.add(sourceIdentity(item))
    }
    return true
  }
  if (!validateRegistered(baselineOptional.registered)) return fail('REGISTERED_SOURCE_EVIDENCE_INVALID')
  const baselineSent = validateSentEvidence(baselineOptional, baselineOptional.registered)
  const candidateSent = validateSentEvidence(candidateOptional, candidateOptional.registered)
  if (!baselineSent || !candidateSent || !baselineSent.sentKeys || !candidateSent.sentKeys || baselineSent.sentKeys.size < 1) return fail('SENT_SOURCE_EVIDENCE_INVALID')
  const decision = candidateOptional?.materialDecision
  const decisionFailure = validateMaterialDecision(decision, candidateOptional.registered)
  if (decisionFailure) return fail(decisionFailure === 'MATERIAL_DECISION_RECEIPT_INVALID' ? 'MATERIAL_DECISION_EVIDENCE_MISSING' : decisionFailure)
  if (!CONTENT_HASH.test(candidateAttempt.userPromptHash ?? '') || candidateAttempt.userPromptHash !== decision.promptHash)
    return fail('MATERIAL_DECISION_PROMPT_HASH_MISMATCH')
  if (decision.coverage.complete !== (decision.coverage.included === decision.coverage.required)
    || !decision.included.some(item => item.required === true)) return fail('CANDIDATE_REQUIRED_COVERAGE_INCOMPLETE')
  const budgetOmissions = decision.omitted.filter(item => item.reason === 'budget' && item.required === false)
  if (budgetOmissions.length < 1) return fail('CANDIDATE_BUDGET_OMISSION_MISSING')
  const candidateBudgetSourceIds = [...new Set(budgetOmissions.map(item => item.sourceId))].sort()
  const provenBaselineSourceIds = budgetOmissions.filter(item => baselineSent.sentKeys.has(sourceIdentity(item)))
    .map(item => item.sourceId).filter((sourceId, index, values) => values.indexOf(sourceId) === index).sort()
  if (provenBaselineSourceIds.length < 1) return fail('BASELINE_OMITTED_SOURCE_NOT_SENT')
  if (budgetOmissions.some(item => candidateSent.sentKeys.has(sourceIdentity(item))))
    return fail('CANDIDATE_OMITTED_SOURCE_SENT')
  return { valid: true, baselinePromptHash: baselineAttempt.compiledPromptHash,
    candidatePromptHash: candidateAttempt.compiledPromptHash,
    baselinePromptBytes: baselineAttempt.composedPromptBytes, candidatePromptBytes: candidateAttempt.composedPromptBytes,
    candidateBudgetSourceIds, provenBaselineSourceIds,
    candidateRequiredCoverage: decision.coverage }
}
export function targetUnitsGateEvidence(error) {
  return error?.code === 'TARGET_UNITS_FAILED' && Number.isSafeInteger(error.actualUnits) && error.actualUnits > 0
    && Number.isSafeInteger(error.targetUnits) && error.targetUnits > 0
    ? { code: error.code, actualUnits: error.actualUnits, targetUnits: error.targetUnits } : null
}
function isReferenceTargetUnitsFailure(result) {
  const failure = result?.gateFailure, observation = result?.draftObservation
  const supplement = result?.supplementEvidence, direct = result?.directPersistedEvidence
  const directVerified = isVerifiedDirectPersistedDraftEvidence(direct)
    && direct?.identity?.invocationId === result.invocationId && direct.identity.arm === 'baseline'
    && direct.identity.chapterNumber === observation?.chapterNumber && direct.identity.units === observation?.units
    && direct.identity.targetUnits === observation?.targetUnits && direct.identity.contentHash === observation?.contentHash
  const recoveryVerified = isVerifiedRecoverySupplementEvidence(supplement)
    && CONTENT_HASH.test(supplement?.sha256 ?? '') && CONTENT_HASH.test(supplement?.originalReceiptSha256 ?? '')
    && supplement?.identity?.invocationId === result.invocationId && supplement.identity.arm === 'baseline'
  return result?.arm === 'baseline' && result.status === 'failed' && failure?.code === 'TARGET_UNITS_FAILED'
    && failure.actualUnits === observation?.units && failure.targetUnits === observation?.targetUnits
    && !withinTargetUnits(observation, result.protocolRevision, result.arm) && hasReviewableDraft(result)
    && (directVerified || recoveryVerified)
}
export function classifyProductionPair(results, { mode, phase }) {
  const baselineRows = Array.isArray(results) ? results.filter(result => result?.arm === 'baseline') : []
  const candidateRows = Array.isArray(results) ? results.filter(result => result?.arm === 'candidate') : []
  if (results?.length !== 2 || baselineRows.length !== 1 || candidateRows.length !== 1) {
    return { status: 'failed', qualityQualification: 'automatic-gate-failed', pairFailure: 'INVALID_PAIR_RESULTS' }
  }
  const baseline = baselineRows[0], candidate = candidateRows[0]
  const scenario = productionScenario(phase)
  if (Array.isArray(baseline.attempts) && Array.isArray(candidate.attempts)) {
    if (baseline.invocationId !== candidate.invocationId)
      return { status: 'failed', qualityQualification: 'automatic-gate-failed', pairFailure: 'PAIR_BINDING_MISMATCH' }
    const protocolRevision = baseline.protocolRevision
    const protocolHash = baseline.protocolHash
    const baselineBindingFailure = validatePairedReceipt(baseline, { mode, arm: 'baseline', phase, scenario, protocolRevision, protocolHash })
    const candidateBindingFailure = validatePairedReceipt(candidate, { mode, arm: 'candidate', phase, scenario, protocolRevision, protocolHash })
    if (baselineBindingFailure || candidateBindingFailure)
      return { status: 'failed', qualityQualification: 'automatic-gate-failed', pairFailure: baselineBindingFailure ?? candidateBindingFailure }
  }
  const selectionDifference = phase === 'early-context'
    ? validateEarlyContextSelectionDifference(baseline, candidate) : null
  const earlyReview = phase === 'early-review'
    ? { baseline: validateEarlyReviewChain(baseline, 'baseline'), candidate: validateEarlyReviewChain(candidate, 'candidate') }
    : null
  if (earlyReview && (!earlyReview.baseline.valid || !earlyReview.candidate.valid)) {
    return { status: 'failed', qualityQualification: 'automatic-gate-failed',
      pairFailure: earlyReview.baseline.pairFailure ?? earlyReview.candidate.pairFailure }
  }
  if (mode !== 'real') {
    if (selectionDifference && !selectionDifference.valid) return { status: 'failed', qualityQualification: 'automatic-gate-failed',
      pairFailure: selectionDifference.pairFailure }
    return { status: results.every(result => result.status === 'passed') ? 'passed' : 'failed',
      qualityQualification: 'not-run', ...(selectionDifference ? { selectionDifference } : {}),
      ...(earlyReview ? { earlyReview } : {}) }
  }
  if (phase === 'early-review') return {
    status: results.every(result => result.status === 'passed') ? 'pending-independent-oracle-review' : 'failed',
    qualityQualification: results.every(result => result.status === 'passed')
      ? 'pending-independent-oracle-review' : 'automatic-gate-failed',
    earlyReview,
    pendingOracleDimensions: ['targeted-finding-correctness', 'facts', 'required-events', 'style'],
  }
  if (phase !== 'early-context') {
    const automated = results.every(result => result.status === 'passed' && withinTargetUnits(result.draftObservation, result.protocolRevision, result.arm)
      && hasReviewableDraft(result) && savedMatchesObservation(result))
    return { status: automated ? 'pending-independent-oracle-review' : 'failed',
      qualityQualification: automated ? 'pending-independent-oracle-review' : 'automatic-gate-failed' }
  }
  const candidateConforming = candidate?.status === 'passed' && withinTargetUnits(candidate.draftObservation, candidate.protocolRevision, candidate.arm)
    && hasReviewableDraft(candidate) && savedMatchesObservation(candidate)
  const baselineDisposition = baseline?.status === 'passed' && withinTargetUnits(baseline.draftObservation, baseline.protocolRevision, baseline.arm)
    && hasReviewableDraft(baseline) && savedMatchesObservation(baseline)
    ? 'conforming-reference' : isReferenceTargetUnitsFailure(baseline) ? 'reference-nonconforming' : 'invalid-reference'
  if (!candidateConforming || baselineDisposition === 'invalid-reference') return { status: 'failed', qualityQualification: 'automatic-gate-failed', baselineDisposition }
  if (selectionDifference && !selectionDifference.valid) return { status: 'failed', qualityQualification: 'automatic-gate-failed',
    baselineDisposition, pairFailure: selectionDifference.pairFailure }
  return { status: 'pending-independent-oracle-review', qualityQualification: 'pending-independent-oracle-review', baselineDisposition,
    ...(selectionDifference ? { selectionDifference } : {}),
    pendingOracleDimensions: ['required-events', 'facts', 'recap', 'style'] }
}

export function adjudicateEarlyReviewReferenceNonconformance(results, {
  mode, phase, adjudicationRevision, baselineReviewArtifactText, ledgerEvents,
} = {}) {
  if (mode !== 'real' || phase !== 'early-review')
    return { overall: 'failed', originalPairFailure: null, pairFailure: 'ADJUDICATION_SCOPE_MISMATCH' }
  const original = classifyProductionPair(results, { mode, phase })
  const fail = pairFailure => ({ overall: 'failed', originalPairFailure: original.pairFailure ?? null, pairFailure })
  if (adjudicationRevision !== EARLY_REVIEW_REFERENCE_ADJUDICATION_REVISION) return fail('ADJUDICATION_REVISION_MISMATCH')
  if (original.pairFailure !== 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH') return fail('ORIGINAL_PAIR_FAILURE_MISMATCH')
  const baseline = results?.find(result => result?.arm === 'baseline')
  const candidate = results?.find(result => result?.arm === 'candidate')
  const baselineAttempt = baseline?.attempts?.[0]
  const baselineOperation = baseline?.operations?.[0]
  if (!baseline || !candidate || baseline.status !== 'failed' || baseline.error !== 'REAL_PROVIDER_DIAGNOSTIC_REDACTED'
    || baseline.mode !== mode || baseline.phase !== phase || baseline.physicalModelRequests !== 1 || baseline.syntheticDispatches !== 0
    || baseline.attempts?.length !== 1 || baseline.operations?.length !== 1
    || baselineAttempt?.binding?.operation !== '审稿' || baselineOperation?.operation !== '审稿'
    || baselineOperation.kind !== 'review' || !baselineAttempt.attemptId
    || baselineAttempt.binding.arm !== 'baseline' || baselineAttempt.binding.invocationId !== baseline.invocationId
    || baselineAttempt.binding.protocolRevision !== baseline.protocolRevision
    || baselineAttempt.binding.protocolHash !== baseline.protocolHash
    || baselineAttempt.binding.mode !== mode || baselineAttempt.binding.phase !== phase
    || baselineAttempt.binding.caseId !== baseline.caseId || baselineAttempt.binding.milestone !== 'early'
    || baselineAttempt.binding.codeSha !== baseline.codeSha || baselineAttempt.binding.sourceHash !== baseline.sourceHash
    || baselineAttempt.binding.driverHash !== baseline.driverHash
    || baselineAttempt.binding.parityId !== baseline.physicalProject?.parityHash)
    return fail('BASELINE_REVIEW_EVIDENCE_INVALID')
  if (typeof baselineReviewArtifactText !== 'string' || !baselineReviewArtifactText
    || !CONTENT_HASH.test(baselineOperation.returnedHash ?? '') || !CONTENT_HASH.test(baselineOperation.outputHash ?? '')
    || digest(baselineReviewArtifactText) !== baselineOperation.returnedHash
    || typeof baselineOperation.outputPath !== 'string' || !baselineOperation.outputPath)
    return fail('BASELINE_REVIEW_ARTIFACT_INVALID')
  let reviewArtifact
  try {
    const match = baselineReviewArtifactText.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    reviewArtifact = JSON.parse(match ? match[1] : baselineReviewArtifactText)
  } catch { return fail('BASELINE_REVIEW_ARTIFACT_INVALID') }
  if (!Array.isArray(reviewArtifact?.items) || reviewArtifact.items.length < 1
    || reviewArtifact.items.some(item => item?.severity !== 'pass'))
    return fail('BASELINE_ACTIONABLE_REVIEW_PRESENT')
  if (!Array.isArray(baseline.invocations) || baseline.invocations.at(-1) !== 'db:review-get-full'
    || baseline.invocations.filter(channel => channel === 'llm:generate-stream').length !== 1
    || baseline.invocations.filter(channel => channel === 'db:review-create').length !== 1)
    return fail('BASELINE_TERMINAL_TRACE_INVALID')

  const scenario = productionScenario(phase)
  if (baseline.invocationId !== candidate.invocationId || baseline.protocolRevision !== candidate.protocolRevision
    || baseline.protocolHash !== candidate.protocolHash
    || baseline.physicalProject?.parityHash !== candidate.physicalProject?.parityHash || candidate.status !== 'passed'
    || validatePairedReceipt(candidate, { mode, arm: 'candidate', phase, scenario,
      protocolRevision: baseline.protocolRevision, protocolHash: baseline.protocolHash }))
    return fail('CANDIDATE_TECHNICAL_EVIDENCE_INVALID')
  const candidateChain = validateEarlyReviewChain(candidate, 'candidate')
  if (!candidateChain.valid) return fail(candidateChain.pairFailure)

  const attempts = [baselineAttempt, ...candidate.attempts]
  const expectedAttemptIds = new Set(attempts.map(attempt => attempt.attemptId))
  const invocationReserves = Array.isArray(ledgerEvents)
    ? ledgerEvents.filter(event => event?.type === 'reserve' && event.binding?.invocationId === baseline.invocationId) : []
  if (expectedAttemptIds.size !== 4 || invocationReserves.length !== 4
    || invocationReserves.some(event => !expectedAttemptIds.has(event.attemptId))) return fail('LEDGER_BINDING_INVALID')
  for (const attempt of attempts) {
    const rows = ledgerEvents.filter(event => event?.attemptId === attempt.attemptId)
    if (stableEvidence(rows.map(row => row.type)) !== stableEvidence(['reserve', 'dispatch', 'settle'])
      || rows[2]?.finishReason !== 'stop'
      || stableEvidence(rows[0]?.binding) !== stableEvidence(attempt.binding))
      return fail('LEDGER_SETTLEMENT_INVALID')
  }
  return { invocationId: baseline.invocationId, originalPairFailure: original.pairFailure,
    derivedReason: 'baseline-all-pass-review-terminal',
    baselineDisposition: 'reference-nonconforming-no-actionable-review',
    candidateTechnicalQualification: 'passed', overall: 'pending-independent-oracle' }
}

export function readBaselineFailureEvidence(receipt, receiptPath) {
  const directShape = receipt?.operations?.length === 1 && receipt.draftObservation?.persisted === true
    && receipt.gateFailure?.code === 'TARGET_UNITS_FAILED'
  const recoveryShape = receipt?.operations?.length === 0 && receipt.attempts?.length === 1
    && receipt.draftObservation === undefined && receipt.gateFailure === undefined
  const verifier = directShape ? readVerifiedDirectPersistedDraftEvidence
    : recoveryShape ? readVerifiedRecoveryCandidateSupplement : null
  if (!verifier || typeof receiptPath !== 'string' || !receiptPath) return {}
  try { return verifier({ receiptPath }) }
  catch (error) {
    if (isExpectedReferenceEvidenceFailure(error)) return {}
    throw error
  }
}

export function copyIsolatedRealModelConfig(original, roots) {
  // Copy only the approved generation profile; a default model would also start an unregistered embedding request.
  const models = JSON.parse(fs.readFileSync(path.join(original.roots.config, 'models.json'), 'utf8'))
  const model = models.find(value => value.id === original.modelId)
  if (!model?.apiKey) throw new Error('SAFE_MODEL_UNAVAILABLE')
  fs.writeFileSync(path.join(roots.config, 'models.json'), JSON.stringify([model]), { mode: 0o600 })
  fs.writeFileSync(path.join(roots.config, 'config.json'), JSON.stringify({ locale: 'zh-CN' }))
}

export function runProductionPhasePair(targets, options) {
  const scenario = productionScenario(options.phase)
  if ((scenario.scenarioRevision ?? null) !== (options.scenarioRevision ?? null)
    || stableEvidence(scenario.selectionDifference ?? null) !== stableEvidence(options.selectionDifference ?? null))
    throw new Error('SCENARIO_PROTOCOL_MISMATCH')
  if (!options.protocolRevision || !/^[a-f0-9]{64}$/.test(options.protocolHash ?? '')
    || ['baseline', 'candidate'].some(arm => targets[arm].protocolRevision !== options.protocolRevision || targets[arm].protocolHash !== options.protocolHash)) throw new Error('PROTOCOL_BINDING_MISMATCH')
  const invocationId = randomUUID()
  const directoryId = invocationId.slice(0, 8)
  const executionTargets = Object.fromEntries(['baseline', 'candidate'].map(arm => {
    const original = targets[arm], roots = Object.fromEntries(Object.entries(original.roots).map(([key, directory]) => [key, path.join(directory, directoryId)]))
    const isolationRoot = path.join(original.isolationRoot, 'invocations', invocationId)
    for (const directory of [isolationRoot, ...Object.values(roots)]) if (fs.existsSync(directory)) throw new Error('INVOCATION_DIRECTORY_COLLISION')
    for (const directory of [isolationRoot, ...Object.values(roots)]) fs.mkdirSync(directory, { recursive: true })
    if (options.mode === 'real') copyIsolatedRealModelConfig(original, roots)
    return [arm, { ...original, isolationRoot, roots, declaredIsolationRoot: original.isolationRoot, declaredRoots: original.roots }]
  }))
  const common = { invocationId, mode: options.mode ?? 'synthetic', development: options.development === true,
    protocolRevision: options.protocolRevision, protocolHash: options.protocolHash,
    scenarioRevision: options.scenarioRevision ?? null, selectionDifference: options.selectionDifference ?? null,
    milestone: options.milestone ?? scenario.milestone,
    phase: options.phase, caseId: scenario.caseId, sceneId: scenario.sceneId, chapterNumber: scenario.chapterNumber,
    operations: scenario.operations, semanticPath: options.semanticPath, templatesPath: options.templatesPath,
    ledgerPath: options.ledgerPath, driverHash: productionBridgeHash() }
  const prepared = ['baseline', 'candidate'].map(arm => runProductionBridge({ ...common, target: executionTargets[arm], action: 'prepare' }))
  const parityHash = prepared[0].physicalProject.parityHash
  if (prepared[1].physicalProject.parityHash !== parityHash) throw new Error('ACTUAL_PROJECT_PARITY_FAILED')
  const results = ['baseline', 'candidate'].map(arm => {
    try { return runProductionBridge({ ...common, target: executionTargets[arm], action: 'execute', parityHash }) }
    catch (error) {
      // A bridge refusal is a recorded outcome, not a harness crash: keep the receipt's
      // own reason (for example a chapter-material capacity conflict) next to the code.
      const receipt = error.receiptPath && fs.existsSync(error.receiptPath) ? JSON.parse(fs.readFileSync(error.receiptPath, 'utf8')) : {}
      let recoveryProjection = {}
      if (arm === 'baseline') recoveryProjection = readBaselineFailureEvidence(receipt, error.receiptPath)
      return { ...receipt, ...recoveryProjection, arm, status: 'failed', code: error.message,
        reason: receipt.error ?? null, receiptPath: error.receiptPath }
    }
  })
  const decision = classifyProductionPair(results, { mode: common.mode, phase: options.phase })
  return { ...decision, qualification: options.development ? 'development-only-unfrozen' : `${common.mode}-production-path-only`,
    phase: options.phase, caseId: scenario.caseId, operations: scenario.operations.map(operation => operation.id),
    physicalModelRequests: results.reduce((sum, result) => sum + (result.physicalModelRequests ?? 0), 0), syntheticDispatches: results.reduce((sum, result) => sum + (result.syntheticDispatches ?? 0), 0),
    protocolRevision: common.protocolRevision, protocolHash: common.protocolHash,
    scenarioRevision: common.scenarioRevision, selectionDifferencePolicy: common.selectionDifference,
    invocationId, parityHash, prepared, results }
}

// Existing command tests already inject the physical completion/IPC boundaries.
// Their product text is Chinese; selection deliberately excludes language cases.
export const COMMAND_PROBES = Object.freeze([
  { file: 'directory.command.test.ts', name: 'commits append generation as an exact replace-range operation' },
  { file: 'generate-draft.command.test.ts', name: 'accepts exactly 80% of the target without requesting a continuation' },
  { file: 'refine-draft.command.test.ts', name: 'uses finalized continuity as the only established-history source in the review request' },
])
export function runProductionCommandProbe(target, env, guard) {
  const report = path.join(target.isolationRoot, 'command-probe-vitest.json')
  if (fs.existsSync(report)) fs.unlinkSync(report)
  const probes = COMMAND_PROBES.map(test => test.file === 'generate-draft.command.test.ts' && target.arm !== 'baseline'
    ? { ...test, name: 'accepts exactly 70% of the target without requesting a continuation' } : test)
  const prefix = 'src/services/workflows/commands/__tests__/'
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(guard).href, path.join(target.repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run',
    ...probes.map(test => prefix + test.file), '-t', probes.map(test => test.name).join('|'),
    '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', `--outputFile=${report}`,
  ], { cwd: target.repositoryRoot, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true })
  if (result.status !== 0 || !fs.existsSync(report)) throw new Error('COMMAND_PROBE_FAILED')
  const results = JSON.parse(fs.readFileSync(report, 'utf8'))
  const passed = results.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'passed')
  if (passed.length !== 3 || probes.some(test => !passed.some(row => row.title === test.name))) throw new Error('COMMAND_PROBE_COVERAGE_MISMATCH')
  return { status: 'passed', passed: passed.length, commands: ['GenerateDirectoryCommand', 'GenerateDraftCommand', 'ReviewChapterCommand'], evidenceLevel: 'production-command-with-injected-completion-and-IPC', physicalModelRequests: 0, limitations: ['持久结果仅由测试IPC断言，非真实数据库落盘', '不替代中文18章质量、Electron或安装版资格'], report }
}
