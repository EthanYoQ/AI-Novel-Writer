import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'

const ADAPTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PRODUCTION_BRIDGE = 'scripts/fixtures/quality-modernization-production.fixture.mjs'
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
 * 桥内结算守护的预算。必须明显短于桥测试自身的超时（桥配置里的 120_000），
 * 才有余量在进程被超时杀掉之前把 unknown 落进账本并收尾。见 createAttemptSupervisor。
 */
export const BRIDGE_SETTLEMENT_DEADLINE_MS = 480_000

/** 只测规模、不落内容：返回提示词载荷的 UTF-8 字节数，绝不含提示词原文或凭据。 */
export function measurePromptBytes(messages) {
  return Buffer.byteLength(JSON.stringify(messages ?? []), 'utf8')
}

/**
 * 桥自身的结算守护：从桥开始工作起持有一个短于桥测试超时的截止时间。
 *
 * 桥测试的 120s 超时是进程内的 JS 计时器：它不投递任何信号，也不会先运行 finally，
 * 所以「等网络流结束后再写 settle/unknown」在供应商卡住时永远等不到——账本里只剩
 * reserve+dispatch，这次发送既不 settle 也不 unknown，花费不可审计，也违反了
 * 「dispatch 之后必须 settle 或 unknown，未知不得退款」的规则。这里让桥自己持有
 * 截止时间：
 *   - terminal(): 幂等。同一 attemptId 只写一条 settle/unknown，重复调用是 no-op，
 *     因此「刚写 unknown 又想把同一次发送改写为 settle」不可能发生。
 *   - 到点: 先为所有仍未终态的尝试写 unknown（占用、不退款），再 abort 它的 fetch，
 *     让等待方以失败结束——先落账，后失败。到点之后新登记的尝试同样立即按 unknown
 *     收尾，绝不无限延长；dispatch 之前的取消仍然只走 cancel。
 *   - 计时从桥开始工作算起（不是从第一次发送算起），因为超时管的是整个测试的时长。
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
  let expired = false
  const terminal = (attemptId, type, extra = {}) => {
    if (closed.has(attemptId)) return false
    // 先写账本再记终态：写失败（例如 LEDGER_BUSY）不吞掉终态，调用方仍可重试。
    record({ type, attemptId, ...extra })
    closed.add(attemptId)
    open.delete(attemptId)
    return true
  }
  const failOpenAttempts = () => {
    for (const [attemptId, controller] of [...open]) {
      try { terminal(attemptId, 'unknown') } catch { /* 账本暂不可写也必须继续 abort，绝不回退成「未发送」 */ }
      try { controller?.abort?.(new Error('ATTEMPT_DEADLINE_EXCEEDED')) } catch { /* ignore */ }
    }
  }
  const timer = deadlineMs > 0 ? setTimeout(() => { expired = true; failOpenAttempts() }, deadlineMs) : null
  return {
    watch(attemptId, controller) {
      open.set(attemptId, controller ?? null)
      if (expired) failOpenAttempts()
    },
    terminal,
    dispose: () => { if (timer !== null) clearTimeout(timer) },
    expired: () => expired,
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
      globals: false, maxWorkers: 1, fileParallelism: false, testTimeout: 600000 },
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
    // 预算次序：桥内结算守卫(480s) < 这里的 spawnSync < 子进程 vitest testTimeout。
    // 否则子进程会在守卫到点之前被外层杀掉，unknown 终态行仍然丢失——这正是
    // 之前 180s spawnSync 配 480s 守卫留下的缺陷。
    timeout: 540000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
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
    caseId: '场景2/2',
    sceneId: '场景2',
    chapterNumber: 2,
    milestone: 'early',
    operations: Object.freeze([
      Object.freeze({ id: '长设定第二章正文', kind: 'draft' }),
    ]),
  }),
})
export function productionScenario(phase) {
  const scenario = PHASE_SCENARIOS[phase]
  if (!scenario) throw new Error('PHASE_PRODUCTION_ADAPTER_NOT_INTEGRATED')
  return scenario
}

export function runProductionPhasePair(targets, options) {
  const scenario = productionScenario(options.phase)
  const invocationId = randomUUID()
  const directoryId = invocationId.slice(0, 8)
  const executionTargets = Object.fromEntries(['baseline', 'candidate'].map(arm => {
    const original = targets[arm], roots = Object.fromEntries(Object.entries(original.roots).map(([key, directory]) => [key, path.join(directory, directoryId)]))
    const isolationRoot = path.join(original.isolationRoot, 'invocations', invocationId)
    for (const directory of [isolationRoot, ...Object.values(roots)]) if (fs.existsSync(directory)) throw new Error('INVOCATION_DIRECTORY_COLLISION')
    for (const directory of [isolationRoot, ...Object.values(roots)]) fs.mkdirSync(directory, { recursive: true })
    if (options.mode === 'real') {
      // The caller provisions only this isolated model store from an existing safe
      // configuration. Never discover user profiles or print/hash secret bytes.
      const models = JSON.parse(fs.readFileSync(path.join(original.roots.config, 'models.json'), 'utf8'))
      const model = models.find(value => value.id === original.modelId)
      if (!model?.apiKey) throw new Error('SAFE_MODEL_UNAVAILABLE')
      fs.writeFileSync(path.join(roots.config, 'models.json'), JSON.stringify([model]), { mode: 0o600 })
      fs.writeFileSync(path.join(roots.config, 'config.json'), JSON.stringify({ defaultModelId: model.id, locale: 'zh-CN' }))
    }
    return [arm, { ...original, isolationRoot, roots, declaredIsolationRoot: original.isolationRoot, declaredRoots: original.roots }]
  }))
  const common = { mode: options.mode ?? 'synthetic', development: options.development === true,
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
      return { ...receipt, arm, status: 'failed', code: error.message, reason: receipt.error ?? null, receiptPath: error.receiptPath }
    }
  })
  return { status: results.every(result => result.status === 'passed') ? 'passed' : 'failed', qualification: options.development ? 'development-only-unfrozen' : `${common.mode}-production-path-only`,
    phase: options.phase, caseId: scenario.caseId, operations: scenario.operations.map(operation => operation.id),
    physicalModelRequests: results.reduce((sum, result) => sum + (result.physicalModelRequests ?? 0), 0), syntheticDispatches: results.reduce((sum, result) => sum + (result.syntheticDispatches ?? 0), 0),
    invocationId, parityHash, prepared, results, qualityQualification: common.mode === 'real' ? 'pending-independent-oracle-review' : 'not-run' }
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
  const prefix = 'src/services/workflows/commands/__tests__/'
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(guard).href, path.join(target.repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run',
    ...COMMAND_PROBES.map(test => prefix + test.file), '-t', COMMAND_PROBES.map(test => test.name).join('|'),
    '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', `--outputFile=${report}`,
  ], { cwd: target.repositoryRoot, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true })
  if (result.status !== 0 || !fs.existsSync(report)) throw new Error('COMMAND_PROBE_FAILED')
  const results = JSON.parse(fs.readFileSync(report, 'utf8'))
  const passed = results.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'passed')
  if (passed.length !== 3 || COMMAND_PROBES.some(test => !passed.some(row => row.title === test.name))) throw new Error('COMMAND_PROBE_COVERAGE_MISMATCH')
  return { status: 'passed', passed: passed.length, commands: ['GenerateDirectoryCommand', 'GenerateDraftCommand', 'ReviewChapterCommand'], evidenceLevel: 'production-command-with-injected-completion-and-IPC', physicalModelRequests: 0, limitations: ['持久结果仅由测试IPC断言，非真实数据库落盘', '不替代中文18章质量、Electron或安装版资格'], report }
}
