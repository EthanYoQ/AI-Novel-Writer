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
      globals: false, maxWorkers: 1, fileParallelism: false, testTimeout: 120000 },
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
    timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
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

export function runEarlyBudgetProductionPair(targets, options) {
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
  const common = { mode: options.mode ?? 'synthetic', development: options.development === true, milestone: options.milestone ?? 'early',
    semanticPath: options.semanticPath, templatesPath: options.templatesPath, ledgerPath: options.ledgerPath,
    driverHash: productionBridgeHash() }
  const prepared = ['baseline', 'candidate'].map(arm => runProductionBridge({ ...common, target: executionTargets[arm], action: 'prepare' }))
  const parityHash = prepared[0].physicalProject.parityHash
  if (prepared[1].physicalProject.parityHash !== parityHash) throw new Error('ACTUAL_PROJECT_PARITY_FAILED')
  const results = ['baseline', 'candidate'].map(arm => {
    try { return runProductionBridge({ ...common, target: executionTargets[arm], action: 'execute', parityHash }) }
    catch (error) { return { ...(error.receiptPath && fs.existsSync(error.receiptPath) ? JSON.parse(fs.readFileSync(error.receiptPath, 'utf8')) : {}),
      arm, status: 'failed', code: error.message, receiptPath: error.receiptPath } }
  })
  return { status: results.every(result => result.status === 'passed') ? 'passed' : 'failed', qualification: options.development ? 'development-only-unfrozen' : `${common.mode}-production-path-only`,
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
