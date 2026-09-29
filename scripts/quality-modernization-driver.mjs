import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { buildSync } from 'esbuild'
import { countProjectedDraftUnits, isExpectedReferenceEvidenceFailure, isVerifiedDirectPersistedDraftEvidence, isVerifiedRecoverySupplementEvidence,
  readVerifiedDirectPersistedDraftEvidence, readVerifiedRecoveryCandidateSupplement, targetUnitRange } from './quality-modernization-receipt.mjs'

const ADAPTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The gate and post-run check use the same production parser as ReviewChapterCommand.
const reviewParserBundle = buildSync({ entryPoints: [path.join(ADAPTER_ROOT, 'src/shared/review-generation-report.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { parseReviewGenerationResult } = await import(`data:text/javascript;base64,${Buffer.from(reviewParserBundle).toString('base64')}`)
// 结果侧从对账原始输出重算注入块，用的是与产品主进程复核同一份生产模块。
const reconciliationBundle = buildSync({ entryPoints: [path.join(ADAPTER_ROOT, 'src/shared/draft-reconciliation.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { draftReconciliationBlock, parseDraftReconciliation } = await import(`data:text/javascript;base64,${Buffer.from(reconciliationBundle).toString('base64')}`)
// 压缩稿（此后被审；未修稿时即保存的正文）由主进程按同一份生产清洗从末次压缩原文组合（generation-run-repository 的 draft-visible-v1 组合）。
const draftVisibleBundle = buildSync({ entryPoints: [path.join(ADAPTER_ROOT, 'src/shared/draft-visible-text.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { sanitizeDraftText } = await import(`data:text/javascript;base64,${Buffer.from(draftVisibleBundle).toString('base64')}`)
export const PRODUCTION_BRIDGE = 'scripts/fixtures/quality-modernization-production.fixture.mjs'
export const EARLY_REVIEW_REFERENCE_ADJUDICATION_REVISION = 's11-reference-no-actionable-review-v1'
export const REVIEWED_DRAFT_PROTOCOL_REVISION = 's14b-reviewed-draft-v1'
export const SPLIT_QUALITY_GATES_PROTOCOL_REVISION = 's14b-split-quality-gates-v1'
export const CANDIDATE_QUALITY_COMPARISON_PROTOCOL_REVISION = 's14b-candidate-quality-and-comparison-v2'
// 旧 v2（只采纳 error/warning）保留为历史 revision；按 v1→v2 先例不再作为可校验策略，旧目标因协议 hash 漂移拒绝。
export const POST_UI_REVIEW_POLICY = Object.freeze({ revision: 's14b-post-ui-reviewed-draft-must-show-unknown-v3',
  selection: 'all-error-warning-and-must-show-unknown-in-report-order', mustShowGoalId: '^ch\\d+:mustShow:\\d+$',
  confirmation: 'test-preauthorized-original-items',
  merge: 'accept-only-revision', finalReview: 'ordinary-full-review', noAction: 'retain-initial-draft',
  unknownOnly: 'retain-initial-draft-and-full-review-pending-independent-goal-proof',
  maxRevisions: 1, qualityDecision: 'independent-oracle-final-text',
  armAsymmetry: Object.freeze({
    baseline: 'baseline 2264390d 不识别【第N章必现】标记，只把该行当普通世界设定文本，首审不会产生 mustShow 项，其 unknown 只可能来自蓝图 keyEvents 或覆盖不完整且不被采纳；首审有 error/warning 时仍按原规则修稿一次，无 error/warning 时按 unknown-only 规则保留初稿',
    candidate: 'candidate 把该行冻结为 chN:mustShow:K 目标；首审为 unknown 时视为作者测试预授权补写，与 error/warning 按原报告顺序共用至多一次修稿和一次普通复评，不改称已确认错误',
    // 场景 v3（评分规则/场景变更）：候选臂登记产品原生的唯一压缩，baseline 没有该能力，不对称同样披露。
    condense: 'candidate（产品自 f00b612b 起）可对超出 draftTargetUnitRange 上限的首稿发一次产品原生压缩 chapter-draft-condense，并登记为「900单位正文」的正式效果；baseline 2264390d 没有该产品能力、不登记压缩，首稿超上限即按原字数门失败；两臂是否触发压缩及压缩后正文长度的差异来自该不对称，不得据此单独声称相对改善',
    claim: '两臂是否触发修复分支的差异来自上述不对称，不得据此单独声称相对改善；首稿自然满足时记录修复分支未触发' }) })
const MUST_SHOW_GOAL_ID = new RegExp(POST_UI_REVIEW_POLICY.mustShowGoalId, 'u')
// early-budget 的登记：指定范围生成的一次结构化语法修复与成稿首审的一次重建。early 场景与 post-UI 共用同一份，milestone 限定 post-ui。
const EARLY_BUDGET_ATTEMPT_POLICY = Object.freeze({ milestone: 'post-ui', arms: Object.freeze(['baseline', 'candidate']),
  operationId: '指定范围生成', primaryPurpose: 'chapter-blueprint-directory',
  repairPurpose: 'chapter-blueprint-directory:structured-syntax-repair', maxRepairAttempts: 1,
  reviewRebuild: Object.freeze({ operationId: '成稿首审', primaryPurpose: 'review-chapter',
    repairPurpose: 'review-chapter-rebuild', maxRepairAttempts: 1 }) })
/**
 * post-UI 场景 v3（评分规则/场景变更，与产品 f00b612b 的修复分开）：只为候选臂的「900单位正文」登记产品原生的唯一一次
 * 超长压缩，语义同 C16–C18 v2；early 里程碑的登记（EARLY_BUDGET_ATTEMPT_POLICY）不变。
 */
const POST_UI_ATTEMPT_POLICY = Object.freeze({ ...EARLY_BUDGET_ATTEMPT_POLICY,
  draftCondense: Object.freeze({ operationIds: Object.freeze(['900单位正文']), arms: Object.freeze(['candidate']),
    primaryPurpose: 'chapter-draft', condensePurpose: 'chapter-draft-condense', maxCondenseAttempts: 1,
    trigger: 'primary-settled-stop-hash-verified-units-above-draftTargetUnitRange-maximum',
    formalEffect: 'last-attempt-only' }) })
/**
 * full 场景 v2（评分规则/场景变更，与产品 f00b612b 的修复分开）：只为候选臂的「连续章节正文」登记产品原生的唯一一次超长压缩，
 * 语义同 post-UI v3；每章没有审修链，保存稿即压缩稿。baseline 恒无；续写与无进展恢复不登记（触发即在 reserve 前拒绝并记技术失败）。
 */
const FULL_ATTEMPT_POLICY = Object.freeze({ milestone: 'final', arms: Object.freeze(['candidate']),
  draftCondense: Object.freeze({ operationIds: Object.freeze(['连续章节正文']), arms: Object.freeze(['candidate']),
    primaryPurpose: 'chapter-draft', condensePurpose: 'chapter-draft-condense', maxCondenseAttempts: 1,
    trigger: 'primary-settled-stop-hash-verified-units-above-draftTargetUnitRange-maximum',
    formalEffect: 'last-attempt-only' }),
  armAsymmetry: 'candidate（产品自 f00b612b 起）可对超出 draftTargetUnitRange 上限的章节首稿发一次产品原生压缩 chapter-draft-condense，并登记为该章「连续章节正文」的正式效果；baseline 2264390d 没有该产品能力、不登记压缩，首稿超上限即按原字数门失败；两臂是否触发压缩及各章压缩后正文长度的差异来自该不对称，不得据此单独声称相对改善' })
const POST_UI_BUDGET = Object.freeze({ scenarioRevision: 's14b-post-ui-reviewed-budget-review-rebuild-must-show-v3',
  attemptPolicy: POST_UI_ATTEMPT_POLICY,
  evaluationPolicy: POST_UI_REVIEW_POLICY,
  operations: Object.freeze([{ id: '指定范围生成', kind: 'directory' }, { id: '900单位正文', kind: 'draft' },
    { id: '成稿首审', kind: 'review' }, { id: '成稿一次修稿', kind: 'refine' }, { id: '成稿完整复评', kind: 'final-review' }]) })
// v3 只改登记（attemptPolicy 增加唯一压缩），作者世界设定输入与 v2 逐字相同：沿用语义源里登记给 v2 的同一条附加行，不改动冻结的语义源。
const AUTHOR_SETTING_LINES_REVISION = Object.freeze({
  's14b-post-ui-reviewed-budget-review-rebuild-must-show-v3': 's14b-post-ui-reviewed-budget-review-rebuild-must-show-v2' })
/** 场景 revision 在语义源登记的作者设定附加行。 */
export const scenarioAuthorSettingLines = (scene, scenarioRevision) => scenarioRevision
  ? scene?.scenarioAuthorSettingLines?.[AUTHOR_SETTING_LINES_REVISION[scenarioRevision] ?? scenarioRevision] ?? [] : []
/** 作者世界设定：只有登记了该场景 revision 附加行的场景才追加独立行，其余 revision 字节不变。 */
export function scenarioAuthorSetting(scene, scenarioRevision) {
  return [scene?.material, scene?.longSetting, ...scenarioAuthorSettingLines(scene, scenarioRevision)].filter(Boolean).join('\n')
}
export function reviewedDraftSelection(report) {
  if (!Array.isArray(report?.items) || report.items.length === 0
    || report.items.some(item => !['pass', 'error', 'warning', 'unknown'].includes(item?.severity))) throw new Error('REVIEWED_DRAFT_REPORT_INVALID')
  const selected = report.items.filter(item => item.severity === 'error' || item.severity === 'warning'
    || item.severity === 'unknown' && typeof item.goalId === 'string' && MUST_SHOW_GOAL_ID.test(item.goalId))
  return { selected, disposition: selected.length ? 'revised-once'
    : report.items.some(item => item.severity === 'unknown')
      ? 'no-actionable-review-with-unresolved-goals' : 'no-actionable-review' }
}
/** The S14B endpoint is immutable evidence, not a second product revision workflow. */
export function validateReviewedDraft(result) {
  const fail = () => ({ valid: false, pairFailure: 'REVIEWED_DRAFT_EVIDENCE_INVALID' })
  const chain = result?.reviewedDraft
  try {
    if (stableEvidence(result.evaluationPolicy) !== stableEvidence(POST_UI_REVIEW_POLICY) || !chain) return fail()
    const readArtifact = artifact => {
      if (!artifact || !CONTENT_HASH.test(artifact.contentHash ?? '') || typeof artifact.outputPath !== 'string') throw new Error('missing artifact')
      const content = fs.readFileSync(artifact.outputPath, 'utf8')
      if (digest(content) !== artifact.contentHash) throw new Error('changed artifact')
      return content
    }
    readArtifact(chain.initial)
    const report = JSON.parse(readArtifact(chain.review)), { selected, disposition } = reviewedDraftSelection(report)
    if (chain.review.sourceHash !== chain.initial.contentHash || chain.selectedCount !== selected.length
      || chain.selectedItemsHash !== digest(selected)) return fail()
    const revised = selected.length > 0
    if (chain.disposition !== disposition) return fail()
    if (revised) {
      const confirmation = JSON.parse(readArtifact(chain.confirmation))
      if (confirmation.sourceReviewId !== chain.review.reviewId || digest(confirmation.sourceDraft?.content ?? '') !== chain.initial.contentHash
        || confirmation.items?.length !== selected.length || confirmation.items.some((item, index) =>
          item.decision !== 'apply' || item.origin !== 'ai'
          || ['category', 'severity', 'description', 'quote', 'goalId', 'stableFactKey'].some(key => item[key] !== selected[index][key])
          // 非 baseline 臂采纳的必现 unknown 只能经产品 review-cycle finding 进入 apply；baseline 无 review-cycle，不要求。
          || result.arm !== 'baseline' && selected[index].severity === 'unknown' && MUST_SHOW_GOAL_ID.test(selected[index].goalId ?? '')
            && (typeof item.findingId !== 'string' || !item.findingId.trim()))) return fail()
      readArtifact(chain.revision)
      readArtifact(chain.finalReview)
      if (chain.mergeHash !== chain.revision.contentHash || chain.finalReview.sourceHash !== chain.mergeHash
        || chain.finalDraft.contentHash !== chain.mergeHash) return fail()
    } else if (chain.confirmation || chain.revision || chain.finalReview || chain.mergeHash
      || chain.finalDraft.contentHash !== chain.initial.contentHash) return fail()
    readArtifact(chain.finalDraft)
    if (chain.finalDraft.contentHash !== result.saved?.contentHash
      || chain.finalDraft.contentHash !== result.draftObservation?.contentHash) return fail()
    const operations = POST_UI_BUDGET.operations.slice(0, revised ? 5 : 3)
    if (stableEvidence(result.operations?.map(item => [item.operation, item.kind]))
      !== stableEvidence(operations.map(item => [item.id, item.kind]))) return fail()
    for (const [kind, artifact] of [['draft', chain.initial], ['review', chain.review],
      ...(revised ? [['refine', chain.revision], ['final-review', chain.finalReview]] : [])]) {
      if (result.operations.find(item => item.kind === kind)?.outputHash !== artifact.contentHash) return fail()
    }
    return { valid: true, operations, disposition: chain.disposition }
  } catch { return fail() }
}
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
  return { attemptId: row.attempt_id, runId: row.run_id, rootActionId: row.root_action_id,
    projectId: binding.projectId, epoch: binding.epoch, purpose: JSON.parse(row.usage_receipt_json ?? '{}').purpose }
}

/**
 * 单个 attempt 的桥内结算预算。三个串行 attempt 的完整窗口必须短于父进程
 * spawn 预算，而 spawn 预算再短于 Vitest 超时，给 unknown 落账与进程收尾留出余量。
 */
export const BRIDGE_SETTLEMENT_DEADLINE_MS = 480_000
export const BRIDGE_SPAWN_TIMEOUT_MS = BRIDGE_SETTLEMENT_DEADLINE_MS * 3 + 60_000
export const BRIDGE_TEST_TIMEOUT_MS = BRIDGE_SPAWN_TIMEOUT_MS + 60_000
// post-UI 候选最多 8 个串行 attempt：指定范围 2、正文 2（含唯一压缩）、首审 2、修稿 1、复评 1。
export const BRIDGE_REVIEWED_TEST_TIMEOUT_MS = BRIDGE_SETTLEMENT_DEADLINE_MS * 8 + 120_000

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

export function rejectOutsidePhysicalBoundary(receipt) {
  createOutboundPreflightAssert(receipt.preflightFailures ??= [])(false, 'NETWORK_OUTSIDE_PHYSICAL_BOUNDARY')
}
export function assertNoOutboundPreflightFailures(receipt) {
  if (receipt.preflightFailures?.length) throw new Error('OUTBOUND_PREFLIGHT_FAILURES')
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
  const evidenceRoot = request.evidenceRoot ?? target.isolationRoot
  fs.mkdirSync(evidenceRoot, { recursive: true })
  const runtime = productionExecutionRuntime(target)
  const testTimeout = request.evaluationPolicy ? BRIDGE_REVIEWED_TEST_TIMEOUT_MS : BRIDGE_TEST_TIMEOUT_MS
  const requestFile = path.join(evidenceRoot, `${request.action}-request.json`)
  const config = path.join(target.isolationRoot, 'production-bridge.vitest.config.mjs')
  const report = path.join(evidenceRoot, `${request.action}-vitest.json`)
  request.receiptPath = path.join(evidenceRoot, `${request.action}-receipt.json`)
  fs.writeFileSync(requestFile, JSON.stringify(request, null, 2))
  fs.writeFileSync(config, `export default ${JSON.stringify({
    root: ADAPTER_ROOT,
    resolve: { alias: { vitest: path.join(target.repositoryRoot, 'node_modules/vitest/dist/index.js'),
      electron: path.join(target.repositoryRoot, 'node_modules/electron/index.js') } },
    test: { include: [PRODUCTION_BRIDGE], exclude: [], environment: 'node',
      globals: false, maxWorkers: 1, fileParallelism: false, testTimeout },
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
    timeout: testTimeout - 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  const secret = request.mode === 'real'
    ? JSON.parse(fs.readFileSync(path.join(target.roots.config, 'models.json'), 'utf8')).find(model => model.id === target.modelId)?.apiKey : null
  const redact = value => secret ? String(value ?? '').split(secret).join('[REDACTED]') : String(value ?? '')
  fs.writeFileSync(path.join(evidenceRoot, `${request.action}-stdout.log`), redact(result.stdout))
  fs.writeFileSync(path.join(evidenceRoot, `${request.action}-stderr.log`), redact(result.stderr))
  for (const file of [report, request.receiptPath]) if (secret && fs.existsSync(file)) fs.writeFileSync(file, redact(fs.readFileSync(file, 'utf8')))
  const receipt = fs.existsSync(request.receiptPath) ? JSON.parse(fs.readFileSync(request.receiptPath, 'utf8')) : null
  if (result.status !== 0 || !receipt || !['prepared', 'passed'].includes(receipt.status)) {
    throw Object.assign(new Error('PRODUCTION_BRIDGE_FAILED'), { detail: receipt?.error, receiptPath: request.receiptPath,
      exitCode: result.status, stderrPath: path.join(evidenceRoot, `${request.action}-stderr.log`) })
  }
  const testReport = JSON.parse(fs.readFileSync(report, 'utf8'))
  if (testReport.numPassedTests !== 1 || testReport.numTotalTests !== 1) throw new Error('PRODUCTION_BRIDGE_COVERAGE_MISMATCH')
  return { ...receipt, command: { executable: runtime.executable, argv, cwd: target.repositoryRoot, shell: false }, receiptPath: request.receiptPath }
}

/**
 * C17/C18 续写的唯一一次原生超长压缩（评分规则变更，随产品修复登记）：只在同一 run/root/项目/epoch
 * 的 chapter-draft 首请求已结算为 stop、且其 hash 可复核的输出按生产计数超出 draftTargetUnitRange
 * 上限时，才许可一次 chapter-draft-condense；它不是任意失败的新重试权，正式效果只能落在末次 attempt。
 */
export const C16_C18_ATTEMPT_POLICY = Object.freeze({ milestone: 'final', arms: Object.freeze(['candidate']),
  draftCondense: Object.freeze({ operationIds: Object.freeze(['本地恢复后续写', 'DAV选定世代恢复后续写']),
    primaryPurpose: 'chapter-draft', condensePurpose: 'chapter-draft-condense', maxCondenseAttempts: 1,
    trigger: 'primary-settled-stop-hash-verified-units-above-draftTargetUnitRange-maximum',
    formalEffect: 'last-attempt-only' }),
  // v5（harness 变更，随产品“生成前定稿对账”登记）：续写 run 的首个物理请求可以是唯一一次对账；
  // 它只提供依据、不带正式效果、不是压缩的首稿、不获任何重试或修复权。
  draftReconcile: Object.freeze({ operationIds: Object.freeze(['本地恢复后续写', 'DAV选定世代恢复后续写']),
    purpose: 'chapter-draft-reconcile', maxReconcileAttempts: 1, position: 'first-physical-request-of-operation-run-only',
    formalEffect: 'none', composition: 'never-composed-never-repaired-not-condense-primary',
    finishReasons: Object.freeze(['stop', 'length']),
    unusableOutput: 'recorded-as-unusable-first-draft-prompt-without-injection' }) })
/**
 * 登记的唯一压缩按臂生效：`draftCondense.arms` 缺省时沿用 attemptPolicy.arms（C16–C18 的单臂策略）；
 * post-UI v3 显式只给 candidate。未登记或该臂不在其中返回 null——baseline 因此从不获压缩许可。
 */
export const draftCondenseFor = (attemptPolicy, arm) => {
  const condense = attemptPolicy?.draftCondense
  return condense && (condense.arms ?? attemptPolicy.arms ?? []).includes(arm) ? condense : null
}
/**
 * 开发合成才登记超长首稿：默认让 C16–C18 的 C17-A、post-UI 的场景1/1、full 的场景1/2（候选的第 2 章，其后第 3 章可见
 * 前驱取压缩稿）走「超长首稿→唯一压缩→在范围」；显式 syntheticDraftCondense（如 still-over）原样通过。
 * 正式合成（无 development）与真实模式不给计划，其余阶段/里程碑也不给。
 */
export function syntheticDraftCondensePlan(options) {
  if (options?.mode !== 'synthetic' || options.development !== true) return {}
  const caseId = options.phase === 'c16-c18' ? 'C17-A'
    : options.phase === 'early-budget' && options.milestone === 'post-ui' ? '场景1/1'
      : options.phase === 'full' ? '场景1/2' : null
  return caseId ? { syntheticDraftCondense: options.syntheticDraftCondense ?? { caseId, outcome: 'in-range' } } : {}
}
// A phase scenario is the bridge-side counterpart of one preregistered protocol phase.
// The protocol stays the only authority for case ids and operation ids; this map only
// says which production commands realize them. The runner re-checks every field against
// the selected protocol phase before opening the gate, so a drift here fails closed
// instead of quietly running a different experiment.
export const PHASE_SCENARIOS = Object.freeze({
  'c16-c18': Object.freeze({
    caseId: 'C16-A', caseIds: Object.freeze(['C16-A', 'C16-B', 'C16-C', 'C17-A', 'C17-B', 'C18-A', 'C18-B']),
    sceneId: '场景1', chapterNumber: 2, milestone: 'final', arms: Object.freeze(['candidate']),
    scenarioRevision: 'c16-c18-candidate-production-path-v5',
    attemptPolicy: C16_C18_ATTEMPT_POLICY,
    // v5（用户批准的 harness 变更）：C17/C18 续写登记产品原生的唯一一次生成前定稿对账（见 attemptPolicy.draftReconcile）。
    // v4（用户批准的 harness 变更）：C17-B 恢复副本内重新定稿后按产品定稿路径紧接生产后处理，
    // notes/cards 各为独立登记 operation，与 C16 同一 RunFinalizePostProcessCommand 入口，绑定新 finalizationId。
    operations: Object.freeze([
      Object.freeze({ id: '定稿章节要点', kind: 'chapter_notes', caseIds: Object.freeze(['C16-A', 'C16-B', 'C16-C']) }),
      Object.freeze({ id: '定稿角色状态', kind: 'character_cards', caseIds: Object.freeze(['C16-A', 'C16-B', 'C16-C']) }),
      Object.freeze({ id: '本地恢复后续写', kind: 'draft', restore: 'local', caseIds: Object.freeze(['C17-A', 'C17-B']) }),
      Object.freeze({ id: 'DAV选定世代恢复后续写', kind: 'draft', restore: 'webdav', caseIds: Object.freeze(['C18-A', 'C18-B']) }),
      Object.freeze({ id: '恢复副本重新定稿章节要点', kind: 'chapter_notes', caseIds: Object.freeze(['C17-B']) }),
      Object.freeze({ id: '恢复副本重新定稿角色状态', kind: 'character_cards', caseIds: Object.freeze(['C17-B']) }),
    ]),
  }),
  full: Object.freeze({
    caseIds: Object.freeze(['场景1/1', '场景1/2', '场景1/3', '场景2/1', '场景2/2', '场景2/3', '场景3/1', '场景3/2', '场景3/3']),
    milestone: 'final', scenarioRevision: 's14b-full-continuous-project-v2',
    attemptPolicy: FULL_ATTEMPT_POLICY,
    operations: Object.freeze([
      Object.freeze({ id: '三章规划', kind: 'directory' }),
      Object.freeze({ id: '连续章节正文', kind: 'draft' }),
    ]),
  }),
  'early-budget': Object.freeze({
    caseId: '场景1/1',
    sceneId: '场景1',
    chapterNumber: 1,
    milestone: 'early',
    scenarioRevision: 's14b-post-ui-budget-syntax-repair-v1',
    attemptPolicy: EARLY_BUDGET_ATTEMPT_POLICY,
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
/**
 * 一个 c16-c18 案例实际执行的登记 operation：先该案登记的定稿后处理（notes→cards），再该案的恢复续写。
 * driver 选择与结果侧校验共用这一个函数，不按下标切片。
 */
export function continuityCaseOperations(caseId) {
  const operations = PHASE_SCENARIOS['c16-c18'].operations.filter(operation => operation.caseIds.includes(caseId))
  return [...operations.filter(operation => !operation.restore), ...operations.filter(operation => operation.restore)]
}
/** 登记为定稿角色状态的 operation（含 C17-B 重新定稿后处理）共用产品原生 repair 的门禁规则。 */
export const FINALIZED_CHARACTER_OPERATION_IDS = Object.freeze(PHASE_SCENARIOS['c16-c18'].operations
  .filter(operation => operation.kind === 'character_cards').map(operation => operation.id))
export function productionScenario(phase, milestone) {
  const scenario = PHASE_SCENARIOS[phase]
  if (!scenario) throw new Error('PHASE_PRODUCTION_ADAPTER_NOT_INTEGRATED')
  return phase === 'early-budget' && milestone === 'post-ui' ? { ...scenario, ...POST_UI_BUDGET } : scenario
}

// Keep this predicate byte-for-byte equivalent to the product's direct JSON syntax test.
const repairableDirectJsonSyntax = content => {
  const candidate = content.trim()
  if (!/^[{[]/u.test(candidate)) return false
  try { JSON.parse(candidate); return false } catch { return true }
}
const reviewParseFailure = content => {
  // The command strips thinking tags first; avoid classifying an unstripped artifact as a parse failure.
  if (/<\/?think>/iu.test(content)) return false
  try { parseReviewGenerationResult(content); return false }
  catch (error) { return error instanceof SyntaxError || error?.message === 'invalid review contract' }
}
function verifiedPrimarySyntaxFailure(first, evidence, operationId, kind = 'directory', condense = null) {
  const attempt = evidence?.attempt, rows = evidence?.events
  const identity = attempt?.binding?.actual ?? attempt?.binding?.baselineIpc
  if (!attempt || !Array.isArray(rows) || rows.length !== 3 || !identity
    || attempt.binding.operation !== operationId || attempt.attemptId !== rows[0]?.attemptId
    || !attempt.attemptId.endsWith(`:${first.attemptId}`)
    || ['attemptId', 'runId', 'rootActionId', 'projectId', 'epoch', 'purpose'].some(key => identity[key] !== first[key])
    || JSON.stringify(rows.map(row => row.type)) !== JSON.stringify(['reserve', 'dispatch', 'settle'])
    || rows[1].attemptId !== attempt.attemptId || rows[2].attemptId !== attempt.attemptId
    || rows[2].finishReason !== 'stop' || JSON.stringify(rows[0].binding) !== JSON.stringify(attempt.binding)
    || kind === 'review' && (evidence.reviewReportAbsent !== true
      || !first.reviewSource || !Number.isSafeInteger(first.reviewSource.draftId) || first.reviewSource.draftId <= 0
      || !/^[a-f0-9]{64}$/.test(first.reviewSource.contentHash ?? '')
      || JSON.stringify(attempt.binding.reviewSource) !== JSON.stringify(first.reviewSource))
    || typeof attempt.outputPath !== 'string' || !/^[a-f0-9]{64}$/.test(attempt.visibleTextHash ?? '')) return false
  try {
    const output = fs.readFileSync(attempt.outputPath, 'utf8')
    return digest(output) === attempt.visibleTextHash && (kind === 'cards'
      ? evidence.finalizedCharacterInvalid === true && evidence.ownerArtifactHash === attempt.visibleTextHash
      : kind === 'condense' ? evidence.ownerArtifactHash === attempt.visibleTextHash && typeof condense?.measureUnits === 'function'
        && Number.isSafeInteger(condense.maximum) && condense.maximum > 0 && condense.measureUnits(output) > condense.maximum
      : kind === 'review' ? reviewParseFailure(output) : repairableDirectJsonSyntax(output))
  } catch { return false }
}
/**
 * Only a settled, hash-verified parse failure — or, for a registered draft operation, a settled
 * over-length primary draft — may add one physical request. `draftCondense.measureUnits` and
 * `draftCondense.maximum` come from the production counter and draftTargetUnitRange.
 */
export function createOperationDispatchGate({ onReject, repairPolicy, readPrimaryEvidence, finalizationRepair = false, draftCondense = null,
  draftReconcile = null } = {}) {
  const dispatched = new Map()
  const reconciled = new Map()
  const reject = (operationId, reason) => {
    const rejection = Object.freeze({ code: 'UNREGISTERED_ADDITIONAL_MODEL_REQUEST',
      operationId: operationId || null, reason, beforeDispatch: true })
    onReject?.(rejection)
    throw Object.assign(new Error('MODEL_REQUEST_REJECTED'), { code: 'OPERATION_DISPATCH_REJECTED' })
  }
  const sameRun = (left, right) => left.runId === right.runId && left.rootActionId === right.rootActionId
    && left.projectId === right.projectId && left.epoch === right.epoch && left.attemptId !== right.attemptId
  return (operationId, owner, reviewSource) => {
    const first = dispatched.get(operationId)
    // 登记的生成前定稿对账：只能是该续写 operation 的第一个物理请求、最多一次；之后的首稿必须同 run/root/项目/epoch。
    const reconcileRegistered = Boolean(draftReconcile?.maxReconcileAttempts === 1 && draftReconcile.operationIds?.includes(operationId))
    if (owner?.purpose === 'chapter-draft-reconcile' || draftReconcile && owner?.purpose === draftReconcile.purpose) {
      const valid = reconcileRegistered && owner.purpose === draftReconcile.purpose && !first && !reconciled.has(operationId)
        && typeof owner.attemptId === 'string' && owner.attemptId && typeof owner.runId === 'string' && owner.runId
        && typeof owner.projectId === 'string' && owner.projectId && typeof owner.epoch === 'string' && owner.epoch
      if (!valid) reject(operationId, operationId ? 'duplicate-operation' : 'missing-operation')
      reconciled.set(operationId, { ...owner })
      return
    }
    const reconcile = reconciled.get(operationId)
    if (reconcile && !first && !sameRun(reconcile, owner ?? {})) reject(operationId, 'duplicate-operation')
    const cards = finalizationRepair && FINALIZED_CHARACTER_OPERATION_IDS.includes(operationId)
    const condensePolicy = draftCondense?.policy
    const condense = Boolean(condensePolicy?.maxCondenseAttempts === 1 && condensePolicy.operationIds?.includes(operationId))
    const review = repairPolicy?.reviewRebuild?.operationId === operationId
    const policy = review ? repairPolicy.reviewRebuild : repairPolicy
    const policyApplies = policy?.operationId === operationId && policy.maxRepairAttempts === 1
    const identity = value => value && typeof value.attemptId === 'string' && value.attemptId
      && typeof value.runId === 'string' && value.runId && typeof value.projectId === 'string' && value.projectId
      && typeof value.epoch === 'string' && value.epoch
    const hasSyntaxProof = () => {
      try { return verifiedPrimarySyntaxFailure(first, readPrimaryEvidence?.(first), operationId,
        cards ? 'cards' : condense ? 'condense' : review ? 'review' : 'directory', condense ? draftCondense : null) }
      catch { return false }
    }
    const repair = first && (policyApplies || cards || condense) && identity(first) && identity(owner)
      && (cards ? (first.ordinal ?? 0) < 2 && owner.purpose === `finalized-character-state:repair:${(first.ordinal ?? 0) + 1}`
        : condense ? first.purpose === condensePolicy.primaryPurpose && owner.purpose === condensePolicy.condensePurpose
        : first.purpose === policy.primaryPurpose && owner.purpose === policy.repairPurpose)
      && first.attemptId !== owner.attemptId && first.runId === owner.runId
      && first.rootActionId === owner.rootActionId && first.projectId === owner.projectId && first.epoch === owner.epoch
      && (!review || JSON.stringify(first.reviewSource) === JSON.stringify(reviewSource))
      && first.repairUsed !== true && hasSyntaxProof()
    if (!operationId || first && !repair || !first && (policyApplies || cards || condense)
      && (!identity(owner) || owner.purpose !== (cards ? 'finalized-character-state' : condense ? condensePolicy.primaryPurpose : policy.primaryPurpose)
        || review && (!Number.isSafeInteger(reviewSource?.draftId) || reviewSource.draftId <= 0
          || !/^[a-f0-9]{64}$/.test(reviewSource.contentHash ?? '')))) {
      reject(operationId, operationId ? 'duplicate-operation' : 'missing-operation')
    }
    if (repair && cards) dispatched.set(operationId, { ...owner, ordinal: (first.ordinal ?? 0) + 1 })
    else if (repair) first.repairUsed = true
    else dispatched.set(operationId, { ...owner, ...(review ? { reviewSource } : {}) })
  }
}

const validDraftObservation = observation => Number.isSafeInteger(observation?.chapterNumber) && observation.chapterNumber > 0
  && Number.isSafeInteger(observation?.units) && observation.units > 0
  && Number.isSafeInteger(observation?.targetUnits) && observation.targetUnits > 0
  && observation.persisted === true && /^[a-f0-9]{64}$/.test(observation.contentHash ?? '')
const withinTargetUnits = (observation, protocolRevision, arm) => {
  if (!validDraftObservation(observation)) return false
  const { minimum, maximum } = targetUnitRange(observation.targetUnits, protocolRevision, arm)
  return observation.units >= minimum && observation.units <= maximum
}
function hasReviewableDraft(result) {
  const observation = result?.draftObservation
  const output = result?.evaluationPolicy ? result.reviewedDraft?.finalDraft?.outputPath
    : result?.operations?.find(operation => operation.kind === 'draft')?.outputPath
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
  const owned = ['early-review', 'full'].includes(phase) || Boolean(scenario.evaluationPolicy)
  const invocationId = result?.invocationId
  if (typeof protocolRevision !== 'string' || !protocolRevision || !CONTENT_HASH.test(protocolHash ?? '')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocationId ?? '')
    || !result || result.mode !== mode || result.arm !== arm || result.phase !== phase
    || result.caseId !== scenario.caseId || result.protocolRevision !== protocolRevision || result.protocolHash !== protocolHash)
    return 'PAIR_BINDING_MISMATCH'
  if (!Array.isArray(result.attempts))
    return 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH'
  const policy = scenario.attemptPolicy
  const eligible = policy && result.milestone === policy.milestone && policy.arms.includes(arm)
  const repairMatches = eligible && policy.operationId ? result.attempts.filter(attempt => attempt?.binding?.operation === policy.operationId) : []
  const repairUsed = repairMatches.length === 2
  const reviewPolicy = eligible && scenario.evaluationPolicy ? policy.reviewRebuild : null
  const reviewMatches = reviewPolicy ? result.attempts.filter(attempt => attempt?.binding?.operation === reviewPolicy.operationId) : []
  const reviewUsed = reviewMatches.length === 2
  // post-UI v3 与 full v2：只有登记的臂（candidate）与 operation 可多出唯一一次压缩 attempt；baseline 与其余 operation 仍恰一次。
  const condensePolicy = eligible ? draftCondenseFor(policy, arm) : null
  const condenseMatches = condensePolicy
    ? result.attempts.filter(attempt => condensePolicy.operationIds.includes(attempt?.binding?.operation)) : []
  const condenseUsed = condenseMatches.length === 2
  if (result.attempts.length !== scenario.operations.length + Number(repairUsed) + Number(reviewUsed) + Number(condenseUsed)
    || new Set(result.attempts.map(attempt => attempt?.attemptId)).size !== result.attempts.length)
    return 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH'
  for (const operation of scenario.operations) {
    const matches = result.attempts.filter(attempt => attempt?.binding?.operation === operation.id)
    if (matches.length !== (repairUsed && operation.id === policy.operationId
      || reviewUsed && operation.id === reviewPolicy.operationId
      || condenseUsed && condensePolicy.operationIds.includes(operation.id) ? 2 : 1)) return 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH'
    for (const match of matches) {
      const binding = match.binding
      if (binding.mode !== mode || binding.arm !== arm || binding.phase !== phase || binding.caseId !== scenario.caseId
        || binding.invocationId !== invocationId
        || binding.protocolRevision !== protocolRevision || binding.protocolHash !== protocolHash
        || owned && (binding.codeSha !== result.codeSha || binding.sourceHash !== result.sourceHash
          || binding.driverHash !== result.driverHash || binding.parityId !== result.physicalProject?.parityHash))
        return 'ATTEMPT_BINDING_MISMATCH'
      if (owned && arm === 'candidate') {
        const actual = binding.actual
        const persisted = result.operations?.find(item => item.operation === operation.id)
        if (!actual || !persisted?.handle
          || `${arm}:${actual.attemptId}` !== match.attemptId || actual.runId !== persisted.handle.runId
          || actual.rootActionId !== persisted.handle.rootActionId
          || actual.projectId !== result.physicalProject?.projectId || actual.epoch !== result.projectEpoch)
          return 'ACTUAL_OWNER_ATTEMPT_MISMATCH'
      }
    }
  }
  if (eligible && policy.operationId) {
    const identity = attempt => arm === 'candidate' ? attempt.binding.actual : attempt.binding.baselineIpc
    const primary = identity(repairMatches[0])
    if (!primary || primary.purpose !== policy.primaryPurpose || !primary.attemptId
      || repairMatches[0].attemptId !== `${arm}:${primary.attemptId}`
      || repairMatches[0].binding.milestone !== policy.milestone)
      return 'STRUCTURED_REPAIR_OWNER_MISMATCH'
  }
  if (reviewPolicy) {
    const primary = arm === 'candidate' ? reviewMatches[0]?.binding?.actual : reviewMatches[0]?.binding?.baselineIpc
    if (!primary || primary.purpose !== reviewPolicy.primaryPurpose || !primary.attemptId
      || reviewMatches[0].attemptId !== `${arm}:${primary.attemptId}`)
      return 'REVIEW_REBUILD_OWNER_MISMATCH'
  }
  if (repairUsed) {
    const identity = attempt => arm === 'candidate' ? attempt.binding.actual : attempt.binding.baselineIpc
    const [primary, repair] = repairMatches.map(identity)
    const persisted = result.operations?.find(item => item.operation === policy.operationId)
    if (!repair || repair.purpose !== policy.repairPurpose
      || !primary.attemptId || !repair.attemptId || primary.attemptId === repair.attemptId
      || primary.runId !== repair.runId || primary.rootActionId !== repair.rootActionId
      || primary.projectId !== repair.projectId || primary.epoch !== repair.epoch
      || primary.projectId !== result.physicalProject?.projectId || primary.epoch !== result.projectEpoch
      || arm === 'candidate' && (!persisted?.handle || primary.runId !== persisted.handle.runId
        || primary.rootActionId !== persisted.handle.rootActionId)
      || repairMatches.some(attempt => attempt.attemptId !== `${arm}:${identity(attempt).attemptId}`
        || attempt.binding.milestone !== policy.milestone
        || arm === 'baseline' && identity(attempt).operationId !== policy.operationId))
      return 'STRUCTURED_REPAIR_OWNER_MISMATCH'
    for (const [index, attempt] of repairMatches.entries()) {
      if (!CONTENT_HASH.test(attempt.visibleTextHash ?? '') || typeof attempt.outputPath !== 'string')
        return 'PHYSICAL_OUTPUT_MISSING'
      try {
        const output = fs.readFileSync(attempt.outputPath, 'utf8')
        if (digest(output) !== attempt.visibleTextHash) return 'PHYSICAL_OUTPUT_HASH_MISMATCH'
        if (index === 0 && !repairableDirectJsonSyntax(output)) return 'STRUCTURED_REPAIR_PRIMARY_NOT_SYNTAX_FAILURE'
      }
      catch { return 'PHYSICAL_OUTPUT_MISSING' }
    }
    if (arm === 'candidate' && (result.ownerTerminal?.length !== result.attempts.length
      || repairMatches.some(attempt => {
        const terminal = result.ownerTerminal.find(item => item.attemptId === attempt.binding.actual.attemptId)
        return !terminal?.artifactId || terminal.textHash !== attempt.visibleTextHash
      }))) return 'ACTUAL_OWNER_ARTIFACT_MISMATCH'
  }
  if (reviewUsed) {
    const identity = attempt => arm === 'candidate' ? attempt.binding.actual : attempt.binding.baselineIpc
    const [primary, rebuild] = reviewMatches.map(identity)
    const persisted = result.operations?.find(item => item.operation === reviewPolicy.operationId)
    const source = reviewMatches[0].binding.reviewSource
    if (!rebuild || rebuild.purpose !== reviewPolicy.repairPurpose
      || !primary.attemptId || !rebuild.attemptId || primary.attemptId === rebuild.attemptId
      || primary.runId !== rebuild.runId || primary.rootActionId !== rebuild.rootActionId
      || primary.projectId !== rebuild.projectId || primary.epoch !== rebuild.epoch
      || primary.projectId !== result.physicalProject?.projectId || primary.epoch !== result.projectEpoch
      || !Number.isSafeInteger(source?.draftId) || source.draftId <= 0
      || source.contentHash !== result.reviewedDraft?.initial?.contentHash
      || source.draftId !== result.reviewedDraft?.initial?.draftId
      || arm === 'candidate' && (!persisted?.handle || primary.runId !== persisted.handle.runId
        || primary.rootActionId !== persisted.handle.rootActionId)
      || reviewMatches.some(attempt => attempt.attemptId !== `${arm}:${identity(attempt).attemptId}`
        || attempt.binding.milestone !== policy.milestone
        || JSON.stringify(attempt.binding.reviewSource) !== JSON.stringify(source)
        || arm === 'baseline' && identity(attempt).operationId !== reviewPolicy.operationId))
      return 'REVIEW_REBUILD_OWNER_MISMATCH'
    for (const [index, attempt] of reviewMatches.entries()) {
      if (!CONTENT_HASH.test(attempt.visibleTextHash ?? '') || typeof attempt.outputPath !== 'string')
        return 'PHYSICAL_OUTPUT_MISSING'
      try {
        const output = fs.readFileSync(attempt.outputPath, 'utf8')
        if (digest(output) !== attempt.visibleTextHash) return 'PHYSICAL_OUTPUT_HASH_MISMATCH'
        if (index === 0 && !reviewParseFailure(output)) return 'REVIEW_REBUILD_PRIMARY_NOT_SYNTAX_FAILURE'
      } catch { return 'PHYSICAL_OUTPUT_MISSING' }
    }
    if (arm === 'candidate' && (result.ownerTerminal?.length !== result.attempts.length
      || reviewMatches.some(attempt => {
        const terminal = result.ownerTerminal.find(item => item.attemptId === attempt.binding.actual.attemptId)
        return !terminal?.artifactId || terminal.textHash !== attempt.visibleTextHash
      }))) return 'ACTUAL_OWNER_ARTIFACT_MISMATCH'
  }
  if (condenseUsed) {
    // 登记的唯一压缩：首稿→压缩同 run/root/项目/epoch；首稿 stop 且 hash 可复核、按生产计数超上限；正式效果只在末次压缩，被审稿是压缩稿。
    const [primary, condense] = condenseMatches.map(attempt => attempt.binding.actual)
    if (primary?.purpose !== condensePolicy.primaryPurpose || condense?.purpose !== condensePolicy.condensePurpose
      || ['runId', 'rootActionId', 'projectId', 'epoch'].some(key => primary[key] !== condense[key]))
      return 'DRAFT_CONDENSE_OWNER_MISMATCH'
    if (result.ownerTerminal?.length !== result.attempts.length) return 'ACTUAL_OWNER_ARTIFACT_MISMATCH'
    let condensedOutput = ''
    for (const [index, attempt] of condenseMatches.entries()) {
      const terminal = result.ownerTerminal.find(item => item.attemptId === attempt.binding.actual.attemptId)
      if (!terminal?.artifactId || terminal.textHash !== attempt.visibleTextHash) return 'ACTUAL_OWNER_ARTIFACT_MISMATCH'
      if (terminal.finishReason !== 'stop' || terminal.purpose !== attempt.binding.actual.purpose
        || terminal.hasFormalEffect !== (index === 1)) return 'DRAFT_CONDENSE_OWNER_MISMATCH'
      if (!CONTENT_HASH.test(attempt.visibleTextHash ?? '') || typeof attempt.outputPath !== 'string') return 'PHYSICAL_OUTPUT_MISSING'
      try {
        const output = fs.readFileSync(attempt.outputPath, 'utf8')
        if (digest(output) !== attempt.visibleTextHash) return 'PHYSICAL_OUTPUT_HASH_MISMATCH'
        condensedOutput = output
      } catch { return 'PHYSICAL_OUTPUT_MISSING' }
    }
    // 压缩稿 = 末次压缩输出经生产清洗（主进程 draft-visible-v1 组合同一规则；干净输出即物理输出本身）。
    // 首稿是否超长按首稿物理输出判，压缩稿是否落入范围按压缩稿自身判；最终稿（有修稿时是修稿产物）的范围由原字数门另判。
    const condensed = sanitizeDraftText(condensedOutput)
    if (!verifiedCondensedDraft(condenseMatches[0], result, { ...result.draftObservation, units: countProjectedDraftUnits(condensed) }))
      return 'DRAFT_CONDENSE_NOT_REGISTERED'
    // post-UI：被审稿（reviewedDraft.initial）必须是压缩稿，而不是被压缩取代的首稿。无修稿时 initial == finalDraft == saved，同一条件
    // 即覆盖保存的正文；有修稿时 saved 是唯一修稿产物，其来源由 validateReviewedDraft 的审修链校验。
    // full：每章没有审修链，保存的正文（随后是下一章前驱）必须就是压缩稿。
    const reviewedSource = scenario.evaluationPolicy ? result.reviewedDraft?.initial?.contentHash : result.saved?.contentHash
    if (reviewedSource !== digest(condensed)) return 'DRAFT_CONDENSE_SAVED_MISMATCH'
  }
  const expectedPhysical = mode === 'real' ? result.attempts.length : 0
  const expectedSynthetic = mode === 'synthetic' ? result.attempts.length : 0
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
  const reviewed = phase === 'early-budget' && baseline.milestone === 'post-ui'
    && [REVIEWED_DRAFT_PROTOCOL_REVISION, SPLIT_QUALITY_GATES_PROTOCOL_REVISION,
      CANDIDATE_QUALITY_COMPARISON_PROTOCOL_REVISION].includes(baseline.protocolRevision)
  const scenario = productionScenario(phase, reviewed ? 'post-ui' : undefined)
  const reviewedChains = reviewed ? [baseline, candidate].map(validateReviewedDraft) : []
  if (reviewedChains.some(chain => !chain.valid)) return { status: 'failed', qualityQualification: 'automatic-gate-failed',
    pairFailure: 'REVIEWED_DRAFT_EVIDENCE_INVALID' }
  if (Array.isArray(baseline.attempts) && Array.isArray(candidate.attempts)) {
    if (baseline.invocationId !== candidate.invocationId)
      return { status: 'failed', qualityQualification: 'automatic-gate-failed', pairFailure: 'PAIR_BINDING_MISMATCH' }
    const protocolRevision = baseline.protocolRevision
    const protocolHash = baseline.protocolHash
    const baselineBindingFailure = validatePairedReceipt(baseline, { mode, arm: 'baseline', phase,
      scenario: reviewed ? { ...scenario, operations: reviewedChains[0].operations } : scenario, protocolRevision, protocolHash })
    const candidateBindingFailure = validatePairedReceipt(candidate, { mode, arm: 'candidate', phase,
      scenario: reviewed ? { ...scenario, operations: reviewedChains[1].operations } : scenario, protocolRevision, protocolHash })
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

export function fullExecutionSchedule(order) {
  const scenario = PHASE_SCENARIOS.full
  if (order?.seed !== 'program-v3-2026-09-13-fixed-v1' || order.armsByChapter?.length !== 9
    || order.armsByChapter.some((arms, index) => arms !== (index % 2 ? 'candidate,baseline' : 'baseline,candidate')))
    throw new Error('FULL_ORDER_MISMATCH')
  const chapters = scenario.caseIds.flatMap((caseId, index) => order.armsByChapter[index].split(',').map(arm => ({
    caseId, sceneId: caseId.split('/')[0], chapterNumber: Number(caseId.split('/')[1]), arm,
    operation: scenario.operations[1],
  })))
  return [...chapters.filter(step => step.chapterNumber === 1).map(step => ({ ...step, operation: scenario.operations[0] })), ...chapters]
}

export function classifyFullProduction(results, { mode, order }) {
  const schedule = fullExecutionSchedule(order)
  const fail = pairFailure => ({ status: 'failed', qualityQualification: 'automatic-gate-failed', pairFailure })
  if (results.length !== schedule.length) return fail('FULL_OPERATION_COVERAGE_MISMATCH')
  const projects = new Map(), predecessors = new Map()
  for (const [index, step] of schedule.entries()) {
    const result = results[index], key = `${step.sceneId}:${step.arm}`
    if (result?.status !== 'passed') return fail('FULL_OPERATION_FAILED')
    const mismatch = validatePairedReceipt(result, { mode, arm: step.arm, phase: 'full',
      scenario: { caseId: step.caseId, operations: [step.operation], attemptPolicy: PHASE_SCENARIOS.full.attemptPolicy },
      protocolRevision: results[0].protocolRevision, protocolHash: results[0].protocolHash })
    if (mismatch) return fail(mismatch)
    if (result.invocationId !== results[0].invocationId || result.milestone !== 'final'
      || result.chapterNumber !== step.chapterNumber || result.sceneId !== step.sceneId
      || result.operations?.length !== 1 || result.operations[0].operation !== step.operation.id)
      return fail('FULL_ORDER_MISMATCH')
    const projectId = result.physicalProject?.projectId
    if (!projectId || projects.has(key) && projects.get(key) !== projectId
      || !projects.has(key) && [...projects.values()].includes(projectId)) return fail('FULL_PROJECT_MISMATCH')
    const binding = result.attempts[0].binding
    const owner = step.arm === 'candidate' ? binding.actual : binding.baselineIpc
    if (!owner || owner.projectId !== projectId || owner.epoch !== result.projectEpoch
      || result.attempts[0].attemptId !== `${step.arm}:${owner.attemptId}`
      || binding.milestone !== 'final') return fail('FULL_OWNER_BINDING_MISMATCH')
    projects.set(key, projectId)
    if (step.operation.kind === 'directory') continue
    if (!Number.isSafeInteger(result.saved?.draftId) || result.saved.draftId <= 0
      || !Number.isSafeInteger(result.saved?.version) || result.saved.version <= 0
      || !Number.isSafeInteger(result.saved?.persistedBytes) || result.saved.persistedBytes <= 0
      || !hasReviewableDraft(result) || !savedMatchesObservation(result)
      || !withinTargetUnits(result.draftObservation, result.protocolRevision, result.arm)) return fail('FULL_DRAFT_INVALID')
    const previous = predecessors.get(key) ?? null
    if (stableEvidence(result.predecessor ?? null) !== stableEvidence(previous)) return fail('FULL_PREDECESSOR_MISMATCH')
    predecessors.set(key, { projectId, chapterNumber: result.saved.chapterNumber, draftId: result.saved.draftId,
      version: result.saved.version, contentHash: result.saved.contentHash, persistedBytes: result.saved.persistedBytes })
  }
  return { status: mode === 'synthetic' ? 'passed' : 'pending-independent-oracle-review',
    qualityQualification: mode === 'synthetic' ? 'not-run' : 'pending-independent-oracle-review',
    pendingOracleDimensions: ['required-events', 'facts', 'recap', 'style'] }
}

function runProductionFull(targets, options, bridge = runProductionBridge) {
  if (options.scenarioRevision !== PHASE_SCENARIOS.full.scenarioRevision
    || stableEvidence(options.attemptPolicy ?? null) !== stableEvidence(PHASE_SCENARIOS.full.attemptPolicy) || options.milestone !== 'final'
    || !options.protocolRevision || !CONTENT_HASH.test(options.protocolHash ?? '')
    || ['baseline', 'candidate'].some(arm => targets[arm].protocolRevision !== options.protocolRevision
      || targets[arm].protocolHash !== options.protocolHash)) throw new Error('PROTOCOL_BINDING_MISMATCH')
  const schedule = fullExecutionSchedule(options.order), invocationId = randomUUID()
  const executionTargets = new Map(), prepared = [], results = [], predecessors = new Map()
  const common = { ...options, syntheticDraftCondense: undefined, ...syntheticDraftCondensePlan(options), invocationId, driverHash: productionBridgeHash(), phase: 'full' }
  for (const [sceneIndex, sceneId] of ['场景1', '场景2', '场景3'].entries()) {
    for (const arm of ['baseline', 'candidate']) {
      const original = targets[arm], directoryId = `${invocationId.slice(0, 6)}${sceneIndex}`
      const roots = Object.fromEntries(Object.entries(original.roots).map(([name, directory]) => [name, path.join(directory, directoryId)]))
      const isolationRoot = path.join(original.isolationRoot, 'invocations', invocationId, String(sceneIndex))
      for (const directory of [isolationRoot, ...Object.values(roots)]) {
        if (fs.existsSync(directory)) throw new Error('INVOCATION_DIRECTORY_COLLISION')
        fs.mkdirSync(directory, { recursive: true })
      }
      if (options.mode === 'real') copyIsolatedRealModelConfig(original, roots)
      const target = { ...original, isolationRoot, roots, declaredIsolationRoot: original.isolationRoot, declaredRoots: original.roots }
      executionTargets.set(`${sceneId}:${arm}`, target)
      const preparation = bridge({ ...common, target, action: 'prepare', sceneId,
        chapterNumber: 1, caseId: `${sceneId}/1`, operations: [], templatesPath: `${options.templatesPath}.${sceneId}.json` })
      prepared.push(preparation)
      const peer = prepared.find(item => item.sceneId === sceneId && item.arm !== arm)
      if (peer && peer.physicalProject.parityHash !== preparation.physicalProject.parityHash) throw new Error('ACTUAL_PROJECT_PARITY_FAILED')
    }
  }
  for (const [index, step] of schedule.entries()) {
    const key = `${step.sceneId}:${step.arm}`, target = executionTargets.get(key)
    const request = { ...common, target, caseId: step.caseId, sceneId: step.sceneId,
      chapterNumber: step.chapterNumber, operations: [step.operation],
      templatesPath: `${options.templatesPath}.${step.sceneId}.json`,
      evidenceRoot: path.join(target.isolationRoot, `step-${index}`),
      predecessor: predecessors.get(key) ?? null,
      parityHash: prepared.find(item => item.sceneId === step.sceneId && item.arm === step.arm).physicalProject.parityHash }
    try {
      const result = bridge({ ...request, action: 'execute' })
      results.push(result)
      if (step.operation.kind === 'draft') predecessors.set(key, { projectId: result.physicalProject.projectId,
        chapterNumber: result.saved.chapterNumber, draftId: result.saved.draftId, version: result.saved.version,
        contentHash: result.saved.contentHash, persistedBytes: result.saved.persistedBytes })
    } catch (error) {
      const receipt = error.receiptPath && fs.existsSync(error.receiptPath) ? JSON.parse(fs.readFileSync(error.receiptPath, 'utf8')) : {}
      results.push({ ...receipt, arm: step.arm, caseId: step.caseId, status: 'failed', code: error.message, receiptPath: error.receiptPath })
      break
    }
  }
  return { ...classifyFullProduction(results, options), phase: 'full', invocationId, order: options.order,
    qualification: options.development ? 'development-only-unfrozen' : `${options.mode}-production-path-only`,
    protocolRevision: options.protocolRevision, protocolHash: options.protocolHash, scenarioRevision: options.scenarioRevision,
    attemptPolicy: options.attemptPolicy, prepared, results, notRun: schedule.slice(results.length),
    physicalModelRequests: results.reduce((sum, result) => sum + (result.physicalModelRequests ?? 0), 0),
    syntheticDispatches: results.reduce((sum, result) => sum + (result.syntheticDispatches ?? 0), 0) }
}

export function runProductionPhasePair(targets, options, bridge) {
  if (options.phase === 'full') return runProductionFull(targets, options, bridge)
  const scenario = productionScenario(options.phase, options.milestone)
  const arms = scenario.arms ?? ['baseline', 'candidate']
  if ((scenario.scenarioRevision ?? null) !== (options.scenarioRevision ?? null)
    || stableEvidence(scenario.selectionDifference ?? null) !== stableEvidence(options.selectionDifference ?? null)
    || stableEvidence(scenario.attemptPolicy ?? null) !== stableEvidence(options.attemptPolicy ?? null)
    || stableEvidence(scenario.evaluationPolicy ?? null) !== stableEvidence(options.evaluationPolicy ?? null))
    throw new Error('SCENARIO_PROTOCOL_MISMATCH')
  if (!options.protocolRevision || !/^[a-f0-9]{64}$/.test(options.protocolHash ?? '')
    || arms.some(arm => targets[arm].protocolRevision !== options.protocolRevision || targets[arm].protocolHash !== options.protocolHash)) throw new Error('PROTOCOL_BINDING_MISMATCH')
  const invocationId = randomUUID()
  const directoryId = invocationId.slice(0, 8)
  const executionTargets = Object.fromEntries(arms.map(arm => {
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
    attemptPolicy: options.attemptPolicy ?? null,
    evaluationPolicy: options.evaluationPolicy ?? null,
    ...(options.mode === 'synthetic' && options.development ? { syntheticReviewedDraftCase: options.syntheticReviewedDraftCase ?? 'multiple' } : {}),
    // 开发合成才登记超长首稿（默认章见 syntheticDraftCondensePlan）；still-over 用于复现原失败语义。
    ...syntheticDraftCondensePlan({ ...options, milestone: options.milestone ?? scenario.milestone }),
    milestone: options.milestone ?? scenario.milestone,
    phase: options.phase, caseId: scenario.caseId, sceneId: scenario.sceneId, chapterNumber: scenario.chapterNumber,
    operations: scenario.operations, semanticPath: options.semanticPath, templatesPath: options.templatesPath,
    ledgerPath: options.ledgerPath, driverHash: productionBridgeHash() }
  const prepared = arms.map(arm => runProductionBridge({ ...common, target: executionTargets[arm], action: 'prepare' }))
  const parityHash = prepared[0].physicalProject.parityHash
  if (options.phase === 'c16-c18') {
    const results = []
    const cases = JSON.parse(fs.readFileSync(options.semanticPath)).continuityQualificationCases
    if (stableEvidence(cases?.map(item => item.id)) !== stableEvidence(scenario.caseIds)) throw new Error('CONTINUITY_CASES_NOT_REGISTERED')
    for (const [index, item] of cases.entries()) {
      const operations = continuityCaseOperations(item.id)
      // 抽取案恰为 notes/cards；恢复案恰一个同 kind 续写，只有带 sourceSuffix 的恢复案（C17-B）前置重新定稿后处理 notes/cards。
      const postProcess = operations.filter(operation => !operation.restore), restore = operations.filter(operation => operation.restore)
      if ((item.kind === 'extraction' ? restore.length !== 0 || postProcess.length !== 2
        : restore.length !== 1 || restore[0].restore !== item.kind || postProcess.length !== (item.sourceSuffix ? 2 : 0))
        || postProcess.some((operation, index) => operation.kind !== ['chapter_notes', 'character_cards'][index])) throw new Error('CONTINUITY_CASES_NOT_REGISTERED')
      try {
        results.push(runProductionBridge({ ...common, caseId: item.id, target: executionTargets.candidate, action: 'execute', operations,
          parityHash, evidenceRoot: path.join(executionTargets.candidate.isolationRoot, `step-${index}`) }))
      } catch (error) {
        results.push({ ...(error.receiptPath && fs.existsSync(error.receiptPath) ? JSON.parse(fs.readFileSync(error.receiptPath)) : {}),
          status: 'failed', code: error.message, receiptPath: error.receiptPath })
        break
      }
    }
    const validation = validateCandidateContinuityResults(results, common.mode)
    return { ...validation, phase: options.phase, invocationId, parityHash, prepared, results,
      draftReconciliation: summarizeDraftReconciliation(results),
      qualification: options.development ? 'development-only-unfrozen' : `${common.mode}-production-path-only`,
      qualityQualification: common.mode === 'synthetic' ? 'not-run' : validation.status,
      formalSampleQualification: common.mode === 'synthetic' ? 'not-run' : validation.status,
      operationCounts: scenario.operations.map(operation => ({ operation: operation.id,
        logical: results.flatMap(result => result.operations ?? []).filter(item => item.operation === operation.id).length,
        physical: results.flatMap(result => result.attempts ?? []).filter(item => item.binding?.operation === operation.id && common.mode === 'real').length,
        synthetic: results.flatMap(result => result.attempts ?? []).filter(item => item.binding?.operation === operation.id && common.mode === 'synthetic').length })),
      physicalModelRequests: results.reduce((sum, result) => sum + (result.physicalModelRequests ?? 0), 0),
      syntheticDispatches: results.reduce((sum, result) => sum + (result.syntheticDispatches ?? 0), 0) }
  }
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
    ...(common.evaluationPolicy ? { evaluationPolicy: common.evaluationPolicy } : {}),
    invocationId, parityHash, prepared, results }
}

/**
 * 结果侧复核：保存的原始可见输出按 hash 读回，以 harness 同一 v3 计数（与生产 countDraftUnits 相同）
 * 超出上限。产品先清洗再计数，清洗只删不增，因此这是产品触发压缩的必要条件，不放宽任何门。
 * `condensed` 是压缩稿的观察（须落入范围）；默认取 draftObservation——C16–C18 里保存稿即压缩稿。
 * post-UI 有修稿时 draftObservation 是修稿产物，调用方须传压缩稿自己的观察。
 */
function verifiedCondensedDraft(primary, result, condensed = result?.draftObservation) {
  const observation = result?.draftObservation
  if (!CONTENT_HASH.test(primary?.visibleTextHash ?? '') || typeof primary.outputPath !== 'string'
    || !withinTargetUnits(condensed, result.protocolRevision, 'candidate')) return false
  try {
    const output = fs.readFileSync(primary.outputPath, 'utf8')
    return digest(output) === primary.visibleTextHash
      && countProjectedDraftUnits(output) > targetUnitRange(observation.targetUnits, result.protocolRevision, 'candidate').maximum
  } catch { return false }
}
/**
 * C16-B 作者保护（评分规则变更，用户批准，c16-c18 v3）：作者值始终由桥断言保全；是否出现冲突候选
 * 只在模型正式生效输出确实提议改写 mentalState 时才要求。证据须绑定末次正式 attempt 的 hash 可复核产物，
 * 字段缺失或不一致一律失败。合成模式的 transport 必定提议冲突值，因此仍强制冲突候选。
 */
function authorProtectionSatisfied(result, mode) {
  const evidence = result.finalizationEvidence, protection = evidence?.authorProtection
  const operationId = PHASE_SCENARIOS['c16-c18'].operations.find(operation => operation.kind === 'character_cards').id
  const formal = result.attempts.filter(attempt => attempt.binding?.operation === operationId).at(-1)
  const terminal = result.ownerTerminal.find(item => item.attemptId === formal?.binding?.actual?.attemptId)
  if (typeof evidence?.authorProtected !== 'boolean' || !protection || typeof protection !== 'object'
    || typeof protection.proposed !== 'boolean' || protection.status !== (protection.proposed ? 'triggered' : 'untriggered')
    || protection.field !== 'mentalState' || protection.authorValue !== '谨慎'
    || protection.derivation !== 'formal-owner-artifact-production-parser'
    || !formal || protection.formalAttemptId !== formal.binding.actual?.attemptId
    || !CONTENT_HASH.test(protection.ownerArtifactHash ?? '') || protection.ownerArtifactHash !== formal.visibleTextHash
    || terminal?.hasFormalEffect !== true || terminal.textHash !== protection.ownerArtifactHash) return false
  try { if (digest(fs.readFileSync(formal.outputPath, 'utf8')) !== protection.ownerArtifactHash) return false } catch { return false }
  if (mode === 'synthetic' && !protection.proposed) return false
  return !protection.proposed || evidence.authorProtected === true
}
/** 案例内的定稿替换：C16-B/C16-C 在原项目重新定稿，C17-B 在恢复副本内重新定稿。 */
const continuitySourceReplacement = result => result?.sourceReplacement ?? result?.restoration?.sourceReplacement ?? null
const FINALIZED_SOURCE_KEYS = ['draftId', 'finalizationId', 'chapterNumber', 'contentHash']
const sameFinalizedSource = (left, right) => FINALIZED_SOURCE_KEYS.every(key => left?.[key] !== undefined && left[key] !== null && left[key] === right?.[key])
/**
 * v4：定稿后处理（notes/cards）必须绑定该案当前定稿来源。有替换时来源即替换后的新 finalizationId；
 * notes 持久投影与 cards derived provenance 均须回读到同一来源。
 */
function finalizationEvidenceBound(result) {
  const evidence = result.finalizationEvidence, replacement = continuitySourceReplacement(result)
  if (!evidence?.idempotent || !evidence.derivedApplied || evidence.effects?.length !== 2
    || stableEvidence(evidence.effects.map(effect => effect?.stepKey)) !== stableEvidence(['chapter_notes', 'character_cards'])) return 'FINALIZATION_EFFECT_MISSING'
  if (!FINALIZED_SOURCE_KEYS.every(key => evidence.source?.[key] !== undefined && evidence.source[key] !== null)
    || evidence.notesReadback?.draftId !== evidence.source.draftId || evidence.notesReadback.sourceFinalizationId !== evidence.source.finalizationId
    || evidence.notesReadback.sourceContentHash !== evidence.source.contentHash || evidence.notesReadback.sourceStatus !== 'current'
    || !CONTENT_HASH.test(evidence.notesReadback.chapterNotesHash ?? '')
    || evidence.cardsReadback?.sourceFinalizationId !== evidence.source.finalizationId
    || replacement && (!sameFinalizedSource(evidence.source, replacement.after)
      || replacement.after.finalizationId === replacement.before?.finalizationId)) return 'FINALIZATION_SOURCE_NOT_BOUND'
  return null
}
/**
 * v4：physicalProject.readback.predecessors 是续写实际纳入的必需前驱。C17-B 恢复副本重新定稿后，readback 与 parity
 * 改为替换后的来源（替换前另存），parityHash 仍须等于 readback 的 hash，续写 materialDecision 须纳入同一来源与 revision。
 */
function admittedPredecessorBound(result) {
  const readback = result.physicalProject?.readback, required = readback?.predecessors?.filter(item => item?.required === true)
  if (!readback || required?.length !== 1 || result.physicalProject.parityHash !== digest(readback)) return false
  const [predecessor] = required, replacement = result.restoration?.sourceReplacement
  if (replacement) {
    const before = result.restoration.predecessorsBeforeReplacement?.filter(item => item?.required === true)
    if (predecessor.sourceId !== `finalized:${replacement.draftId}` || predecessor.revision !== replacement.draftId
      || predecessor.version !== replacement.version || typeof replacement.content !== 'string'
      || predecessor.contentHash !== digest(replacement.content) || predecessor.persistedBytes !== Buffer.byteLength(replacement.content, 'utf8')
      || before?.length !== 1 || before[0].sourceId === predecessor.sourceId || before[0].sourceId !== `finalized:${replacement.before?.draftId}`
      || !CONTENT_HASH.test(result.restoration.parityHashBeforeReplacement ?? '')
      || result.restoration.parityHashBeforeReplacement === result.physicalProject.parityHash) return false
  }
  const drafts = result.attempts.filter(attempt => attempt.binding?.actual?.purpose?.startsWith('chapter-draft'))
  return drafts.length > 0 && drafts.every(attempt => attempt.optionalMaterialEvidence?.materialDecision?.included?.some(item =>
    item.sourceId === predecessor.sourceId && item.revision === predecessor.revision))
}
/**
 * v5 生成前定稿对账证据（harness 变更）。结果侧从落盘的对账原始输出，用生产 draft-reconciliation 模块重算注入块：
 * 可解析且以 stop 结束 → 必须 `injected`（桥已断言首稿提示恰含该块，且去掉它后等于 materialDecision.promptHash）；
 * 否则如实记为 `unusable`（首稿按原提示发送，不得冒充对账生效）。合成 transport 必返回含冲突的合法 JSON，只接受 injected。
 * 登记续写没有对账 attempt、提示/输出落盘与 hash 不一致或任何字段不自洽，一律 fail closed。
 */
function draftReconciliationEvidenceFailure(result, operation, reconcileAttempt, draftAttempts, mode) {
  const evidence = result.draftReconciliation
  if (!reconcileAttempt || !evidence || evidence.operation !== operation.operation) return 'DRAFT_RECONCILE_EVIDENCE_MISSING'
  const actual = reconcileAttempt.binding.actual
  const terminal = result.ownerTerminal.find(item => item.attemptId === actual.attemptId)
  const decision = reconcileAttempt.optionalMaterialEvidence?.materialDecision
  const readHashed = artifact => {
    if (!artifact || typeof artifact.outputPath !== 'string' || !CONTENT_HASH.test(artifact.contentHash ?? '')) return null
    try { const text = fs.readFileSync(artifact.outputPath, 'utf8'); return digest(text) === artifact.contentHash ? text : null } catch { return null }
  }
  const prompt = readHashed(evidence.prompt), output = readHashed(evidence.output)
  if (prompt === null || output === null || evidence.attemptId !== actual.attemptId || evidence.finishReason !== terminal?.finishReason
    || evidence.prompt.contentHash !== reconcileAttempt.userPromptHash || evidence.prompt.contentHash !== decision?.reconciliationPromptHash
    || evidence.output.outputPath !== reconcileAttempt.outputPath || evidence.output.contentHash !== reconcileAttempt.visibleTextHash
    || evidence.firstDraftAttemptId !== draftAttempts[0]?.binding?.actual?.attemptId) return 'DRAFT_RECONCILE_EVIDENCE_MISMATCH'
  const block = evidence.finishReason === 'stop' ? draftReconciliationBlock('zh-CN', output) : ''
  const conflicts = block ? parseDraftReconciliation(output).events.filter(item => item.conflict).length : 0
  if (evidence.status !== (block ? 'injected' : 'unusable') || evidence.conflicts !== conflicts
    || evidence.injectedIntoFirstDraft !== Boolean(block) || evidence.blockHash !== (block ? digest(block) : null)
    || evidence.reason !== (block ? null : evidence.finishReason !== 'stop' ? 'finish-reason-not-stop' : 'unparseable-output')
    || !Number.isSafeInteger(evidence.authorMaterialAttempts)
    || evidence.authorMaterialAttempts !== (block ? draftAttempts.length - 1 : 0)) return 'DRAFT_RECONCILE_EVIDENCE_MISMATCH'
  if (mode === 'synthetic' && (evidence.status !== 'injected' || conflicts < 1)) return 'DRAFT_RECONCILE_EVIDENCE_MISMATCH'
  return null
}
/** 评审包用的对账摘要：逐续写案如实列出注入与否、冲突数、失败原因与落盘路径/hash，不含判断。 */
export function summarizeDraftReconciliation(results) {
  return (Array.isArray(results) ? results : []).flatMap(result => result?.draftReconciliation ? [{ caseId: result.caseId,
    operation: result.draftReconciliation.operation, status: result.draftReconciliation.status,
    conflicts: result.draftReconciliation.conflicts, reason: result.draftReconciliation.reason ?? null,
    prompt: result.draftReconciliation.prompt ?? null, output: result.draftReconciliation.output ?? null,
    blockHash: result.draftReconciliation.blockHash ?? null }] : [])
}
export function validateCandidateContinuityResults(results, mode) {
  const fail = code => ({ status: 'failed', candidateFailure: code })
  const condense = PHASE_SCENARIOS['c16-c18'].attemptPolicy.draftCondense
  const reconcile = PHASE_SCENARIOS['c16-c18'].attemptPolicy.draftReconcile
  if (results.length !== 7 || results.some(result => result.status !== 'passed' || result.arm !== 'candidate'
    || result.phase !== 'c16-c18' || result.mode !== mode)) return fail('CANDIDATE_OPERATION_MISSING')
  if (stableEvidence(results.map(result => result.caseId)) !== stableEvidence(PHASE_SCENARIOS['c16-c18'].caseIds)) return fail('CANDIDATE_CASE_MISMATCH')
  const source = results[0].physicalProject?.projectId
  if (!source || results.slice(0, 3).some(result => result.physicalProject?.projectId !== source)) return fail('FINALIZATION_EFFECT_MISSING')
  // 有定稿后处理 operation 的案例（C16 三案与 C17-B）逐案核对正式效果与来源绑定。
  for (const result of results.filter(item => continuityCaseOperations(item.caseId).some(operation => !operation.restore))) {
    const failure = finalizationEvidenceBound(result)
    if (failure) return fail(failure)
  }
  for (const [index, result] of results.entries()) {
    const expected = continuityCaseOperations(result.caseId)
    if (stableEvidence(result.operations?.map(item => item.operation)) !== stableEvidence(expected.map(item => item.id))) return fail('CANDIDATE_OPERATION_MISMATCH')
    if (!Array.isArray(result.attempts) || !Array.isArray(result.ownerTerminal)
      || result.ownerTerminal.length !== result.attempts.length) return fail('ACTUAL_OWNER_ARTIFACT_MISMATCH')
    for (const operation of result.operations) {
      const all = result.attempts.filter(attempt => attempt.binding?.operation === operation.operation)
      const condensable = operation.kind === 'draft' && condense.operationIds.includes(operation.operation)
      const reconcilable = operation.kind === 'draft' && reconcile.operationIds.includes(operation.operation)
      // v5：登记的唯一对账只能是该续写 operation 的第一个 attempt；其余 attempt 仍按原规则（首稿→可选唯一压缩）。
      const reconciles = all.filter(attempt => attempt.binding?.actual?.purpose === reconcile.purpose)
      if (reconciles.length > (reconcilable ? 1 : 0) || reconciles.length === 1 && all[0] !== reconciles[0])
        return fail('TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH')
      const attempts = all.slice(reconciles.length)
      if (attempts.length < 1 || attempts.length > (operation.kind === 'character_cards' ? 3 : condensable ? 2 : 1)) return fail('TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH')
      const ownerMismatch = attempt => {
        const actual = attempt.binding?.actual, terminal = result.ownerTerminal.find(item => item.attemptId === actual?.attemptId)
        return !actual || actual.projectId !== result.physicalProject.projectId || actual.epoch !== result.projectEpoch
          || actual.runId !== operation.handle?.runId || actual.rootActionId !== operation.handle?.rootActionId
          || !terminal?.artifactId || terminal.textHash !== attempt.visibleTextHash
          || attempt.binding.phase !== 'c16-c18' || attempt.binding.arm !== 'candidate'
          || attempt.binding.invocationId !== result.invocationId || attempt.binding.parityId !== result.physicalProject.parityHash
          || terminal.purpose !== actual.purpose ? null : terminal
      }
      for (const attempt of reconciles) {
        const terminal = ownerMismatch(attempt)
        // 对账不带正式效果；stop 或 length 均如实结算（length 记为不可用），其他终态按技术失败处理。
        if (!terminal || terminal.hasFormalEffect !== false || !reconcile.finishReasons.includes(terminal.finishReason))
          return fail('ACTUAL_OWNER_IDENTITY_MISMATCH')
      }
      for (const [ordinal, attempt] of attempts.entries()) {
        const actual = attempt.binding?.actual, terminal = ownerMismatch(attempt)
        if (!terminal || terminal.finishReason !== 'stop'
          || terminal.hasFormalEffect !== (ordinal === attempts.length - 1)
          || ordinal === 0 && actual.purpose !== (operation.kind === 'chapter_notes' ? 'finalized-chapter-notes'
            : operation.kind === 'character_cards' ? 'finalized-character-state' : 'chapter-draft')
          || ordinal > 0 && actual.purpose !== (condensable ? condense.condensePurpose : `finalized-character-state:repair:${ordinal}`))
          return fail('ACTUAL_OWNER_IDENTITY_MISMATCH')
      }
      // 登记的唯一压缩：首稿 hash 可复核且超出上限（生产计数），末次压缩稿才是正式保存的在范围正文。
      if (condensable && attempts.length === 2 && !verifiedCondensedDraft(attempts[0], result)) return fail('DRAFT_CONDENSE_NOT_REGISTERED')
      if (reconcilable) {
        const failure = draftReconciliationEvidenceFailure(result, operation, reconciles[0], attempts, mode)
        if (failure) return fail(failure)
      }
    }
    if (result.physicalModelRequests !== (mode === 'real' ? result.attempts.length : 0)
      || result.syntheticDispatches !== (mode === 'synthetic' ? result.attempts.length : 0)) return fail('PHYSICAL_CALL_COUNT_MISMATCH')
    if (index >= 3 && (result.restoration?.originProjectId !== source || result.restoration?.targetProjectId !== result.physicalProject.projectId
      || result.physicalProject.projectId === source || !result.restoration.transferReceiptHash
      || !result.restoration.sourceUnchanged || !result.restoration.oldWorkFrozen
      || !validDraftObservation(result.draftObservation)
      || index >= 5 && (!result.restoration.selectedGenerationId || result.restoration.bindingMode !== 'origin-readonly')))
      return fail('RESTORE_IDENTITY_MISMATCH')
    if (index >= 3 && !admittedPredecessorBound(result)) return fail('PREDECESSOR_AFTER_REPLACEMENT_MISMATCH')
  }
  if (new Set(results.slice(3).map(result => result.physicalProject.projectId)).size !== 4) return fail('RESTORE_IDENTITY_MISMATCH')
  if (!authorProtectionSatisfied(results[1], mode) || !results[1].sourceReplacement || !results[2].sourceReplacement
    || !results[4].restoration.sourceReplacement || results[6].restoration.branchGenerationIds?.length !== 2)
    return fail('CONTINUITY_CASE_EVIDENCE_MISSING')
  return { status: mode === 'real' ? 'pending-independent-oracle-review' : 'passed' }
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
