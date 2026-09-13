import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProductionCommandProbe } from './quality-modernization-driver.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(ROOT, '.runtime', '.cache', 'novel-quality-modernization')
export const CAP = 80
export const DRIVER = 'scripts/real-provider-generation-qualification.mjs'
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
export const runnerAdapterHash = () => hash(['scripts/quality-modernization-run.mjs', 'scripts/quality-modernization-driver.mjs'].map(file => [file, hash(fs.readFileSync(path.join(ROOT, file)))]))
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
  return {
    executable: real(process.execPath), cwd: real(target.repositoryRoot), shell: false,
    argv: ['--import', pathToFileURL(path.join(target.isolationRoot, 'network-denied.mjs')).href, real(path.join(target.repositoryRoot, DRIVER)), '--dry-run'],
    commandProbe: 'quality-modernization-driver-fixed-three-tests-v1',
  }
}
export function validateFrozenExecution(target) {
  if (target.runnerAdapterHash !== runnerAdapterHash()) fail('RUNNER_ADAPTER_MISMATCH')
  if (hash(target.environment) !== hash(freezeEnvironment(target.repositoryRoot))) fail('EXECUTION_ENVIRONMENT_MISMATCH')
  if (hash(target.startup) !== hash(fixedStartup(target))) fail('STARTUP_MISMATCH')
  if (!target.nativeProfile || hash(fs.readFileSync(target.nativeProfile.path)) !== target.nativeProfile.sha256) fail('NATIVE_PROFILE_MISMATCH')
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
  if (target.schemaVersion !== 1 || !['baseline', 'candidate'].includes(target.arm)) fail('INVALID_TARGET')
  const repositoryRoot = real(target.repositoryRoot)
  if (git(repositoryRoot, ['rev-parse', 'HEAD']) !== target.codeSha) fail('TARGET_SHA_MISMATCH')
  if (git(repositoryRoot, ['diff', 'HEAD', '--name-only']).length) fail('TARGET_TRACKED_DIRTY')
  const sourceHash = hashSourceTree(repositoryRoot)
  if (sourceHash !== target.sourceHash) fail('TARGET_SOURCE_MISMATCH')
  if (hashExecutionTools(repositoryRoot) !== target.executionToolsHash) fail('TARGET_TOOLS_MISMATCH')
  if (target.runnerAdapterHash !== runnerAdapterHash()) fail('RUNNER_ADAPTER_MISMATCH')
  validateFrozenExecution(target)
  if (target.driver.path !== DRIVER || target.driver.kind !== 'generation-runtime-no-network-v1') fail('UNSUPPORTED_DRIVER')
  const driver = real(path.join(repositoryRoot, DRIVER))
  if (!inside(repositoryRoot, driver) || hash(fs.readFileSync(driver)) !== target.driver.sha256) fail('DRIVER_HASH_MISMATCH')
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
export function updateLedger(file, event) {
  fs.mkdirSync(CACHE, { recursive: true })
  const parent = real(path.dirname(file))
  if (!inside(real(CACHE), parent) || fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fail('UNOWNED_LEDGER')
  const lock = `${file}.lock`
  let fd
  try { fd = fs.openSync(lock, 'wx') } catch { fail('LEDGER_BUSY') }
  try {
    const events = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    const attempts = new Map()
    for (const row of [...events, event]) {
      if (!row || !['reserve', 'dispatch', 'settle', 'unknown', 'cancel'].includes(row.type) || typeof row.attemptId !== 'string') fail('INVALID_LEDGER_EVENT')
      const previous = attempts.get(row.attemptId)
      if (row.type === 'reserve') {
        if (previous || !row.binding || !['baseline', 'candidate'].includes(row.binding.arm) || !/^[a-f0-9]{40}$/.test(row.binding.codeSha) || !/^[a-f0-9]{64}$/.test(row.binding.parityId)) fail('INVALID_RESERVATION')
        if ([...attempts.values()].filter(item => item.type !== 'cancel').length >= CAP) fail('PHYSICAL_CALL_CAP_EXHAUSTED')
      } else if (!previous || !(previous.type === 'reserve' && ['dispatch', 'cancel'].includes(row.type) || previous.type === 'dispatch' && ['settle', 'unknown'].includes(row.type))) fail('INVALID_LEDGER_TRANSITION')
      attempts.set(row.attemptId, row)
    }
    const out = fs.openSync(file, 'a')
    try { fs.writeSync(out, JSON.stringify(event) + '\n'); fs.fsyncSync(out) } finally { fs.closeSync(out) }
    return { occupied: [...attempts.values()].filter(item => item.type !== 'cancel').length, cap: CAP }
  } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}

export function main(argv) {
  const [command = 'help', ...rest] = argv
  if (['help', '--help', '-h'].includes(command)) return { usage: 'node scripts/quality-modernization-run.mjs <baseline-probe|dry-run|early-budget|early-context|early-review|full> --targets <json> [--milestone early|post-ui|final]', physicalModelRequests: 0 }
  const args = {}
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--targets', '--milestone'].includes(rest[i]) || !rest[i + 1] || args[rest[i]]) fail('INVALID_ARGUMENT')
    args[rest[i]] = rest[i + 1]
  }
  const protocol = read(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json'))
  if (!['baseline-probe', 'dry-run', ...Object.keys(protocol.phases)].includes(command)) fail('INVALID_COMMAND')
  if (!args['--targets']) fail('TARGETS_REQUIRED')
  const targets = read(args['--targets'])
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
  try { const result = main(process.argv.slice(2)); console.log(JSON.stringify(result, null, 2)); if (result.status === 'blocked') process.exitCode = 2 }
  catch (error) { console.error(JSON.stringify({ status: 'blocked', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_OR_UNAVAILABLE_INPUT', physicalModelRequests: 0 })); process.exitCode = 2 }
}
