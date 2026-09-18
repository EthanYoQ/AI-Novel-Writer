import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProductionCommandProbe, runEarlyBudgetProductionPair, productionBridgeHash, productionExecutionRuntime, PRODUCTION_BRIDGE } from './quality-modernization-driver.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(ROOT, '.runtime', '.cache', 'novel-quality-modernization')
/**
 * 计划分配总额。用户于 2026-09-18 决定移除真实调用硬上限，因此它只用于
 * 协议一致性校验与汇报，不再拒绝请求。账本仍然逐条记录每次占用，
 * 花费依旧可审计；上限是决策，记账是证据。
 */
export const PLANNED_CALL_ALLOCATION = 80
export const DRIVER = 'scripts/real-provider-generation-qualification.mjs'
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
export const runnerAdapterHash = () => hash(['scripts/quality-modernization-run.mjs', 'scripts/quality-modernization-driver.mjs', PRODUCTION_BRIDGE].map(file => [file, hash(fs.readFileSync(path.join(ROOT, file)))]))
const fail = code => { throw new Error(code) }
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const inside = (root, value) => { const relative = path.relative(root, value); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) }
const real = value => fs.realpathSync(value)
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) fail('GIT_INSPECTION_FAILED')
  return result.stdout.trim()
}
export function hashSourceTree(root) {
  const files = git(root, ['ls-files', '-z', 'src', 'electron']).split('\0').filter(file => file && !/(^|\/)(__tests__|test|tests|fixtures|__fixtures__|__snapshots__)(\/|$)|\.(test|spec|stories)\./.test(file)).sort()
  return hash(files.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]))
}
export function hashExecutionTools(root) {
  const files = git(root, ['ls-files', '-z', 'scripts', 'package.json', 'pnpm-lock.yaml']).split('\0').filter(Boolean).sort()
  return hash(files.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]))
}
export function assertCommittedProductionFiles(root) {
  const files = git(root, ['ls-files', '--others', '--exclude-standard', '-z', 'src', 'electron', 'scripts']).split('\0').filter(Boolean)
  const production = files.filter(file => !/(^|\/)(__tests__|test|tests|__fixtures__|__snapshots__|__screenshots__)(\/|$)|\.(test|spec|stories)\./.test(file))
  if (production.length) fail('UNCOMMITTED_PRODUCTION_FILES')
}
export function freezeEnvironment(repositoryRoot) {
  const dependencyNames = ['esbuild', 'vitest', 'electron', 'better-sqlite3']
  return {
    executionMode: 'node-js-no-native-load',
    node: { executable: real(process.execPath), sha256: hash(fs.readFileSync(process.execPath)), version: process.version, modulesAbi: process.versions.modules },
    dependencies: dependencyNames.map(name => {
      const manifest = real(path.join(repositoryRoot, 'node_modules', name, 'package.json'))
      return { name, manifest, version: read(manifest).version, sha256: hash(fs.readFileSync(manifest)) }
    }),
    nativeQualification: 'not-exercised-by-this-probe',
  }
}
export function fixedStartup(target) {
  if (target.schemaVersion === 2) return { ...productionExecutionRuntime(target), cwd: real(target.repositoryRoot), shell: false,
    commandProbe: 'quality-production-default-commands-physical-sqlite-v2', adapterRoot: ROOT,
    bridge: PRODUCTION_BRIDGE, bridgeHash: productionBridgeHash() }
  return {
    executable: real(process.execPath), cwd: real(target.repositoryRoot), shell: false,
    argv: ['--import', pathToFileURL(path.join(target.isolationRoot, 'network-denied.mjs')).href, real(path.join(target.repositoryRoot, DRIVER)), '--dry-run'],
    commandProbe: 'quality-modernization-driver-fixed-three-tests-v1',
  }
}
export function validateFrozenExecution(target) {
  if (target.runnerAdapterHash !== runnerAdapterHash()) fail('RUNNER_ADAPTER_MISMATCH')
  if (hash(target.environment) !== hash(target.schemaVersion === 2 ? freezeProductionEnvironment(target) : freezeEnvironment(target.repositoryRoot))) fail('EXECUTION_ENVIRONMENT_MISMATCH')
  if (hash(target.startup) !== hash(fixedStartup(target))) fail('STARTUP_MISMATCH')
  if (target.schemaVersion !== 2 && (!target.nativeProfile || hash(fs.readFileSync(target.nativeProfile.path)) !== target.nativeProfile.sha256)) fail('NATIVE_PROFILE_MISMATCH')
}
export function freezeProductionEnvironment(target) {
  const runtime = productionExecutionRuntime(target)
  const script = "const D=require('better-sqlite3');const d=new D(':memory:');const result=d.prepare('SELECT 1 AS ok').get();d.close();console.log(JSON.stringify({version:process.version,modulesAbi:process.versions.modules,sqlite:result.ok}))"
  const result = spawnSync(runtime.executable, ['-e', script], { cwd: target.repositoryRoot,
    env: { ...process.env, ...(runtime.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : { ELECTRON_RUN_AS_NODE: '' }) },
    encoding: 'utf8', timeout: 15000, windowsHide: true })
  if (result.status !== 0) fail('TARGET_NATIVE_SQLITE_PROBE_FAILED')
  const actual = JSON.parse(result.stdout)
  if (actual.sqlite !== 1) fail('TARGET_NATIVE_SQLITE_PROBE_FAILED')
  const dependencies = freezeEnvironment(target.repositoryRoot).dependencies
  const sqliteManifest = dependencies.find(entry => entry.name === 'better-sqlite3').manifest
  const binary = real(path.join(path.dirname(sqliteManifest), 'build/Release/better_sqlite3.node'))
  return { executionMode: 'production-commands-registered-ipc-physical-sqlite', node: {
    executable: real(runtime.executable), sha256: hash(fs.readFileSync(runtime.executable)), version: actual.version,
    modulesAbi: actual.modulesAbi, electronRunAsNode: runtime.electronRunAsNode }, dependencies,
    sqlite: { binary, sha256: hash(fs.readFileSync(binary)), actualRead: 'SELECT 1 AS ok', result: 1 },
    qualification: 'native-sqlite-only-not-built-electron-ui' }
}
export function buildFixtureExports(source) {
  const semanticHash = hash(source)
  return Object.fromEntries(['legacy', 'canonical'].map(format => [format, {
    format, semanticHash, parametersHash: hash(source.modelParameters), semantic: structuredClone(source),
  }]))
}
export function selectPhase(protocol, phase, milestone = 'early') {
  if (!['early', 'post-ui', 'final'].includes(milestone)) fail('INVALID_MILESTONE')
  if (!Object.hasOwn(protocol.phases, phase)) fail('INVALID_PHASE')
  if ((phase === 'full') !== (milestone === 'final')) fail('PHASE_MILESTONE_MISMATCH')
  return { phase, milestone, ...protocol.phases[phase] }
}
export function validatePair(targets, observations) {
  const [a, b] = [targets.baseline, targets.candidate]
  if (!a || !b || a.arm !== 'baseline' || b.arm !== 'candidate') fail('TWO_ARMS_REQUIRED')
  if (a.codeSha === b.codeSha || observations[0].sourceHash === observations[1].sourceHash || observations[0].repositoryRoot === observations[1].repositoryRoot) fail('IDENTICAL_IMPLEMENTATIONS')
  if (b.subjectSha !== b.codeSha) fail('CANDIDATE_SUBJECT_MISMATCH')
  const roots = observations.flatMap(item => item.roots)
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    if (inside(roots[i], roots[j]) || inside(roots[j], roots[i])) fail('ROOT_INTERSECTION')
  }
  if (a.fixture.semanticHash !== b.fixture.semanticHash || a.fixture.parametersHash !== b.fixture.parametersHash) fail('FIXTURE_PARITY_FAILED')
  if (a.fixture.format !== 'legacy' || b.fixture.format !== 'canonical') fail('FIXTURE_FORMAT_MISMATCH')
  return { parityId: hash({ semantic: a.fixture.semanticHash, parameters: a.fixture.parametersHash }), qualification: 'target-identity-only' }
}
export function inspectTarget(target) {
  if (![1, 2].includes(target.schemaVersion) || !['baseline', 'candidate'].includes(target.arm)) fail('INVALID_TARGET')
  const repositoryRoot = real(target.repositoryRoot)
  if (git(repositoryRoot, ['rev-parse', 'HEAD']) !== target.codeSha) fail('TARGET_SHA_MISMATCH')
  if (git(repositoryRoot, ['diff', 'HEAD', '--name-only']).length) fail('TARGET_TRACKED_DIRTY')
  if (target.schemaVersion === 2) assertCommittedProductionFiles(repositoryRoot)
  const sourceHash = hashSourceTree(repositoryRoot)
  if (sourceHash !== target.sourceHash) fail('TARGET_SOURCE_MISMATCH')
  if (hashExecutionTools(repositoryRoot) !== target.executionToolsHash) fail('TARGET_TOOLS_MISMATCH')
  if (target.runnerAdapterHash !== runnerAdapterHash()) fail('RUNNER_ADAPTER_MISMATCH')
  validateFrozenExecution(target)
  if (target.schemaVersion === 2) {
    if (target.driver.kind !== 'production-command-physical-project-v2' || target.driver.path !== PRODUCTION_BRIDGE
      || target.driver.adapterRoot !== ROOT || target.driver.sha256 !== productionBridgeHash()) fail('DRIVER_HASH_MISMATCH')
    if (target.arm === 'candidate' && !git(repositoryRoot, ['ls-files', '--error-unmatch', PRODUCTION_BRIDGE])) fail('UNCOMMITTED_PRODUCTION_BRIDGE')
  } else if (target.driver.path !== DRIVER || target.driver.kind !== 'generation-runtime-no-network-v1') fail('UNSUPPORTED_DRIVER')
  const driver = real(path.join(target.schemaVersion === 2 ? ROOT : repositoryRoot, target.schemaVersion === 2 ? PRODUCTION_BRIDGE : DRIVER))
  if (target.schemaVersion === 1 && (!inside(repositoryRoot, driver) || hash(fs.readFileSync(driver)) !== target.driver.sha256)) fail('DRIVER_HASH_MISMATCH')
  const isolationRoot = real(target.isolationRoot)
  if (!inside(real(CACHE), isolationRoot) || isolationRoot === real(CACHE)) fail('UNOWNED_ISOLATION_ROOT')
  const roots = ['userData', 'config', 'project', 'legacySource'].map(key => real(target.roots[key]))
  for (const root of roots) if (!inside(isolationRoot, root) || root === isolationRoot) fail('ROOT_OUTSIDE_ISOLATION')
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) if (inside(roots[i], roots[j]) || inside(roots[j], roots[i])) fail('ROOT_INTERSECTION')
  const fixture = read(target.fixture.path)
  if (fixture.format !== target.fixture.format || hash(fixture.semantic) !== target.fixture.semanticHash || hash(fixture.semantic.modelParameters) !== target.fixture.parametersHash) fail('FIXTURE_BYTES_MISMATCH')
  const frozenSource = read(path.join(ROOT, 'test/fixtures/novel-quality-modernization/semantic-source.json'))
  if (hash(frozenSource) !== target.fixture.semanticHash) fail('UNREGISTERED_FIXTURE')
  return { repositoryRoot, sourceHash, roots, driver }
}

export function createProductionTargets(baselineRoot, output, { development = false, modelId } = {}) {
  const outputPath = path.resolve(output)
  if (!inside(CACHE, path.dirname(outputPath))) fail('TARGET_OUTPUT_NOT_NEW_PRIVATE_FILE')
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  if (!inside(real(CACHE), real(path.dirname(outputPath))) || fs.existsSync(outputPath)) fail('TARGET_OUTPUT_NOT_NEW_PRIVATE_FILE')
  if (!development && git(ROOT, ['diff', 'HEAD', '--name-only'])) fail('TARGET_TRACKED_DIRTY')
  if (git(baselineRoot, ['rev-parse', 'HEAD']) !== '2264390d6fb8b052cc14736d544df0cc74516649') fail('BASELINE_SHA_MISMATCH')
  if (git(baselineRoot, ['diff', 'HEAD', '--name-only'])) fail('TARGET_TRACKED_DIRTY')
  // Keep the actual project below the production Windows path limit; no bypass.
  const root = fs.mkdtempSync(path.join(CACHE, development ? 's07d-' : 's07f-'))
  const fixtureExports = buildFixtureExports(read(path.join(ROOT, 'test/fixtures/novel-quality-modernization/semantic-source.json')))
  const targets = Object.fromEntries(['baseline', 'candidate'].map(arm => {
    const repositoryRoot = real(arm === 'baseline' ? baselineRoot : ROOT), isolationRoot = path.join(root, arm === 'baseline' ? 'b' : 'c')
    const roots = Object.fromEntries(['userData', 'config', 'project', 'legacySource'].map((key, index) => [key, path.join(isolationRoot, ['u', 'c', 'p', 'l'][index])]))
    Object.values(roots).forEach(directory => fs.mkdirSync(directory, { recursive: true }))
    const fixture = fixtureExports[arm === 'baseline' ? 'legacy' : 'canonical'], fixturePath = path.join(isolationRoot, 'semantic-fixture.json')
    fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2))
    const target = { schemaVersion: 2, arm, repositoryRoot, codeSha: git(repositoryRoot, ['rev-parse', 'HEAD']),
      sourceHash: hashSourceTree(repositoryRoot), executionToolsHash: hashExecutionTools(repositoryRoot), runnerAdapterHash: runnerAdapterHash(),
      isolationRoot, roots, fixture: { path: fixturePath, format: fixture.format, semanticHash: fixture.semanticHash, parametersHash: fixture.parametersHash },
      driver: { kind: 'production-command-physical-project-v2', adapterRoot: ROOT, path: PRODUCTION_BRIDGE, sha256: productionBridgeHash() },
      ...(modelId ? { modelId } : {}), ...(development ? { developmentOnly: true } : {}) }
    if (arm === 'candidate') target.subjectSha = target.codeSha
    target.environment = freezeProductionEnvironment(target); target.startup = fixedStartup(target)
    if (!development) inspectTarget(target)
    return [arm, target]
  }))
  fs.writeFileSync(outputPath, JSON.stringify(targets, null, 2) + '\n')
  return { targets, path: outputPath, root, physicalModelRequests: 0,
    qualification: development ? 'development-only-unfrozen' : 'frozen-identity-only-not-run' }
}
export function probeTarget(target) {
  const observed = inspectTarget(target)
  const guard = path.join(target.isolationRoot, 'network-denied.mjs')
  fs.writeFileSync(guard, `import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https'; import { syncBuiltinESMExports } from 'node:module'; const deny=()=>{throw new Error('NETWORK_FORBIDDEN')}; globalThis.fetch=deny; net.Socket.prototype.connect=deny; tls.connect=deny; http.request=deny; http.get=deny; https.request=deny; https.get=deny; syncBuiltinESMExports();`)
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'ComSpec'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  Object.assign(env, { HOME: target.roots.userData, USERPROFILE: target.roots.userData, APPDATA: target.roots.userData, LOCALAPPDATA: target.roots.userData, TEMP: target.isolationRoot, TMP: target.isolationRoot, AI_NOVEL_VELA_HOME: target.roots.legacySource, AI_NOVEL_LEGACY_SOURCE_HOME: target.roots.legacySource, AI_NOVEL_APP_DATA_HOME: target.roots.config })
  const result = spawnSync(target.startup.executable, target.startup.argv, { cwd: target.startup.cwd, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  if (result.status !== 0) fail('BASELINE_RUNTIME_PROBE_FAILED')
  const receipt = JSON.parse(result.stdout)
  if (receipt.mode !== 'dry-run' || receipt.provenance.sourceSha !== target.codeSha || receipt.executionSeam !== 'generation-runtime-with-in-memory-adapter-lease') fail('PROBE_RECEIPT_MISMATCH')
  inspectTarget(target)
  const commands = runProductionCommandProbe(target, env, guard)
  inspectTarget(target)
  return { status: 'passed', evidenceLevel: 'production-generation-runtime-with-synthetic-completion', physicalModelRequests: 0, codeSha: target.codeSha, sourceHash: observed.sourceHash, driverHash: target.driver.sha256, environment: target.environment, startup: target.startup, nativeProfile: target.nativeProfile, receipt, commands, limitations: ['非桌面或IPC资格', '非预注册章节质量结果', '仅内存模拟供应商完成；未读真实模型配置'] }
}

// A single append-only campaign file; wx lock prevents concurrent reservations.
// A torn final record fails closed. Dispatched/unknown attempts never release capacity.
export function updateLedger(file, event, options = {}) {
  fs.mkdirSync(CACHE, { recursive: true })
  const parent = real(path.dirname(file))
  if (!inside(real(CACHE), parent) || fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fail('UNOWNED_LEDGER')
  const lock = `${file}.lock`
  let fd
  try { fd = fs.openSync(lock, 'wx') } catch { fail('LEDGER_BUSY') }
  try {
    const events = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    if (options.campaignMode) {
      if (!['real', 'synthetic'].includes(options.campaignMode)) fail('INVALID_CAMPAIGN_MODE')
      if (options.campaignMode === 'real' && path.resolve(file) !== path.join(CACHE, 'physical-ledger.jsonl')) fail('CAMPAIGN_LEDGER_PATH_MISMATCH')
      const protocol = read(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json'))
      const reserved = new Map(), statuses = new Map()
      const validateBinding = binding => {
        if (!binding || binding.campaignId !== protocol.id || binding.mode !== options.campaignMode
          || !['baseline', 'candidate'].includes(binding.arm) || !/^[a-f0-9]{40}$/.test(binding.codeSha)
          || ['sourceHash', 'driverHash', 'parityId'].some(key => !/^[a-f0-9]{64}$/.test(binding[key]))
          || binding.phase !== 'early-budget' || !['early', 'post-ui'].includes(binding.milestone)
          || binding.caseId !== '场景1/1' || !['directory', 'draft'].includes(binding.operation)) fail('INVALID_CAMPAIGN_BINDING')
        if (binding.arm === 'candidate' && (!binding.actual || ['attemptId', 'runId', 'rootActionId', 'projectId', 'epoch'].some(key => typeof binding.actual[key] !== 'string' || !binding.actual[key]))) fail('ACTUAL_OWNER_ATTEMPT_REQUIRED')
      }
      const allocationFor = binding => {
        const occupied = [...reserved.values()].filter(row => statuses.get(row.attemptId) !== 'cancel')
        const slot = value => `${value.milestone}:${value.phase}:${value.caseId}:${value.arm}:${value.operation}`
        const primary = binding.milestone === 'early' ? 'earlyBudget' : 'postUiBudget'
        const allocation = occupied.some(row => slot(row.binding) === slot(binding)) ? 'failedRetryRepairReviewReserve' : primary
        if (occupied.filter(row => row.allocation === allocation).length >= protocol.allocation[allocation]) fail('CAMPAIGN_ALLOCATION_EXHAUSTED')
        return allocation
      }
      for (const row of events) {
        if (row.type === 'reserve') {
          validateBinding(row.binding)
          if (row.allocation !== allocationFor(row.binding)) fail('CAMPAIGN_ALLOCATION_MISMATCH')
          reserved.set(row.attemptId, row)
        }
        statuses.set(row.attemptId, row.type)
      }
      if (event.type === 'reserve') {
        validateBinding(event.binding)
        event = { ...event, allocation: allocationFor(event.binding) }
      }
    }
    const attempts = new Map()
    for (const row of [...events, event]) {
      if (!row || !['reserve', 'dispatch', 'settle', 'unknown', 'cancel'].includes(row.type) || typeof row.attemptId !== 'string') fail('INVALID_LEDGER_EVENT')
      const previous = attempts.get(row.attemptId)
      if (row.type === 'reserve') {
        if (previous || !row.binding || !['baseline', 'candidate'].includes(row.binding.arm) || !/^[a-f0-9]{40}$/.test(row.binding.codeSha) || !/^[a-f0-9]{64}$/.test(row.binding.parityId)) fail('INVALID_RESERVATION')
      } else if (!previous || !(previous.type === 'reserve' && ['dispatch', 'cancel'].includes(row.type) || previous.type === 'dispatch' && ['settle', 'unknown'].includes(row.type))) fail('INVALID_LEDGER_TRANSITION')
      attempts.set(row.attemptId, row)
    }
    const out = fs.openSync(file, 'a')
    try { fs.writeSync(out, JSON.stringify(event) + '\n'); fs.fsyncSync(out) } finally { fs.closeSync(out) }
    return { occupied: [...attempts.values()].filter(item => item.type !== 'cancel').length, cap: null }
  } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}

export function main(argv) {
  let [command = 'help', ...rest] = argv
  if (['help', '--help', '-h'].includes(command)) return { usage: 'node scripts/quality-modernization-run.mjs <freeze-targets|development-synthetic|baseline-probe|dry-run|early-budget|early-context|early-review|full> --targets <json> [--milestone early|post-ui|final] [--mode synthetic|real]; freeze-targets/development-synthetic: --baseline-root <existing worktree> --output <new private targets.json> [--model-id <safely provisioned id>]', physicalModelRequests: 0 }
  if (command.startsWith('--')) { rest = argv; command = 'phase-options' }
  const args = {}
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]
    if (key === '--dry-run') { if (args[key]) fail('INVALID_ARGUMENT'); args[key] = true; continue }
    if (!['--targets', '--milestone', '--mode', '--baseline-root', '--output', '--model-id', '--protocol', '--phase'].includes(key) || !rest[i + 1] || args[key]) fail('INVALID_ARGUMENT')
    args[key] = rest[++i]
  }
  if (command === 'phase-options') command = args['--phase'] || fail('INVALID_PHASE')
  if (args['--protocol'] && path.resolve(args['--protocol']) !== path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')) fail('PROTOCOL_PATH_MISMATCH')
  const protocol = read(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json'))
  if (['freeze-targets', 'development-synthetic'].includes(command)) {
    if (!args['--baseline-root'] || !args['--output'] || args['--mode'] === 'real') fail('TARGET_PREPARATION_ARGUMENTS_REQUIRED')
    const prepared = createProductionTargets(args['--baseline-root'], args['--output'], { development: command === 'development-synthetic', modelId: args['--model-id'] })
    if (command === 'freeze-targets') return prepared
    const result = runEarlyBudgetProductionPair(prepared.targets, { development: true, mode: 'synthetic',
      semanticPath: path.join(ROOT, protocol.fixturePath), templatesPath: path.join(prepared.root, 'baseline-templates.json'), ledgerPath: path.join(prepared.root, 'synthetic-ledger.jsonl') })
    fs.writeFileSync(path.join(prepared.root, 'development-receipt.json'), JSON.stringify(result, null, 2))
    return { ...result, evidenceRoot: prepared.root, targetsPath: prepared.path }
  }
  if (!['baseline-probe', 'dry-run', ...Object.keys(protocol.phases)].includes(command)) fail('INVALID_COMMAND')
  if (!args['--targets']) fail('TARGETS_REQUIRED')
  const targets = read(args['--targets'])
  if (targets.baseline?.schemaVersion === 2 || targets.candidate?.schemaVersion === 2) {
    if (targets.baseline?.schemaVersion !== 2 || targets.candidate?.schemaVersion !== 2) fail('TWO_PRODUCTION_ARMS_REQUIRED')
    if (targets.baseline.developmentOnly || targets.candidate.developmentOnly) fail('DEVELOPMENT_TARGET_NOT_QUALIFIED')
    const observations = [inspectTarget(targets.baseline), inspectTarget(targets.candidate)]
    validatePair(targets, observations)
    const phase = command === 'dry-run' ? 'early-budget' : command
    const selection = selectPhase(protocol, phase, args['--milestone'] || 'early')
    if (phase !== 'early-budget') return { status: 'blocked', code: 'PHASE_PRODUCTION_ADAPTER_NOT_INTEGRATED', selection, physicalModelRequests: 0 }
    const mode = command === 'dry-run' || args['--dry-run'] ? 'synthetic' : args['--mode']
    if (!['synthetic', 'real'].includes(mode)) fail('EXPLICIT_PROVIDER_MODE_REQUIRED')
    if (mode === 'real' && (!targets.baseline.modelId || !targets.candidate.modelId)) fail('FROZEN_SAFE_MODEL_REQUIRED')
    const evidenceRoot = fs.mkdtempSync(path.join(CACHE, `s07-${mode}-`))
    const result = runEarlyBudgetProductionPair(targets, { mode, milestone: selection.milestone, semanticPath: path.join(ROOT, protocol.fixturePath),
      templatesPath: path.join(evidenceRoot, 'baseline-templates.json'), ledgerPath: mode === 'real' ? path.join(CACHE, 'physical-ledger.jsonl') : path.join(evidenceRoot, 'synthetic-ledger.jsonl') })
    inspectTarget(targets.baseline); inspectTarget(targets.candidate)
    fs.writeFileSync(path.join(evidenceRoot, 'receipt.json'), JSON.stringify(result, null, 2))
    return { ...result, selection, evidenceRoot }
  }
  if (command === 'baseline-probe') {
    if (!targets.baseline || targets.baseline.arm !== 'baseline') fail('BASELINE_REQUIRED')
    return probeTarget(targets.baseline)
  }
  const observed = [inspectTarget(targets.baseline), inspectTarget(targets.candidate)]
  const parity = validatePair(targets, observed)
  const probes = [probeTarget(targets.baseline), probeTarget(targets.candidate)]
  if (command === 'dry-run') return { status: 'passed', ...parity, probes, physicalModelRequests: 0, qualityQualification: 'not-run' }
  const selection = selectPhase(protocol, command, args['--milestone'] || (command === 'full' ? 'final' : 'early'))
  return { status: 'blocked', code: 'PRODUCTION_COMMAND_DRIVER_NOT_INTEGRATED', selection, parity, physicalModelRequests: 0, requiredOwner: 'S06A/S06B/S06C/S07/S10B/S11; 在 S14A 冻结前接入生产命令及逐物理请求账本' }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = main(process.argv.slice(2)); console.log(JSON.stringify(result, null, 2)); if (result.status === 'blocked') process.exitCode = 2; else if (result.status === 'failed') process.exitCode = 1 }
  catch (error) { console.error(JSON.stringify({ status: 'blocked', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_OR_UNAVAILABLE_INPUT', physicalModelRequests: null, note: 'Inspect the retained campaign/target receipts; no unverified zero-call claim.' })); process.exitCode = 2 }
}
