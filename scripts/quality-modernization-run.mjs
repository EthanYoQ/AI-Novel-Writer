import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import os from 'node:os'
import { runProductionCommandProbe, runProductionPhasePair, runProductionBridge, copyIsolatedRealModelConfig,
  assertSharedInputDiagnostic, BOUNDED_REVISION_DIAGNOSTIC, AI_REVIEW_FINAL_MANUSCRIPT_POLICY, POST_UI_AI_REVIEW_SCENARIOS, readBoundedRevisionSource,
  productionBridgeHash, productionExecutionRuntime, productionScenario, PRODUCTION_BRIDGE, PHASE_SCENARIOS } from './quality-modernization-driver.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(ROOT, '.runtime', '.cache', 'novel-quality-modernization')
const isolationParent = () => path.join(process.env.LOCALAPPDATA || (process.platform === 'win32' ? fail('LOCALAPPDATA_REQUIRED') : os.tmpdir()), 'VibeCodingScratch', 'an', 'a')
/**
 * 计划分配总额。用户于 2026-09-18 决定移除真实调用硬上限，因此它只用于
 * 协议一致性校验与汇报，不再拒绝请求。账本仍然逐条记录每次占用，
 * 花费依旧可审计；上限是决策，记账是证据。
 */
export const PLANNED_CALL_ALLOCATION = 80
export const DRIVER = 'scripts/real-provider-generation-qualification.mjs'
export const PROTOCOL_PATH = path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')
/**
 * 账本 campaign 身份。ADR 0019（2026-09-18 用户决定）把 campaign id 从预注册协议里的
 * `novel-quality-program-v3-80-v1` 改为 `...-uncapped-v1`，好让「80 帽时期」与现在的收据
 * 不会混成同一 campaign；协议字节本身保持预注册原样（不改写）。这里把这个取代关系显式写下来：
 * 账本与 bridge 都取同一个常量，不再各自硬编码一个字符串——2f259cd 只改了 bridge 一侧，
 * 于是早门在第一次发送前就以 INVALID_CAMPAIGN_BINDING 阻断（0 真实调用，未被发现）。
 */
const CAMPAIGN_ID_SUPERSESSION = { 'novel-quality-program-v3-80-v1': 'novel-quality-program-v3-uncapped-v1' }
export const campaignIdFor = protocolId => CAMPAIGN_ID_SUPERSESSION[protocolId] ?? protocolId
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
export function currentProtocolBinding() {
  const bytes = fs.readFileSync(PROTOCOL_PATH)
  const protocol = JSON.parse(bytes)
  if (typeof protocol.decisionRevision !== 'string' || !protocol.decisionRevision) fail('INVALID_PROTOCOL_REVISION')
  return { protocolRevision: protocol.decisionRevision, protocolHash: hash(bytes) }
}
export function assertProtocolBinding(value) {
  const current = currentProtocolBinding()
  if (value?.protocolRevision !== current.protocolRevision || value?.protocolHash !== current.protocolHash) fail('PROTOCOL_DRIFT')
  return current
}
export function validateHistoricalLedgerBoundary(raw, boundary) {
  if (!boundary || !Number.isSafeInteger(boundary.eventCount) || boundary.eventCount <= 0
    || !/^[a-f0-9]{64}$/.test(boundary.rawBytesSha256)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(boundary.evidenceInvocationId)
    || !Array.isArray(boundary.finalReserveAttemptIds) || boundary.finalReserveAttemptIds.length === 0) fail('INVALID_HISTORICAL_LEDGER_BOUNDARY')
  let prefixEnd = 0
  for (let index = 0; index < boundary.eventCount; index++) {
    prefixEnd = raw.indexOf('\n', prefixEnd)
    if (prefixEnd < 0) fail('HISTORICAL_LEDGER_BOUNDARY_MISSING')
    prefixEnd++
  }
  const prefix = raw.slice(0, prefixEnd)
  if (hash(prefix) !== boundary.rawBytesSha256) fail('HISTORICAL_LEDGER_BOUNDARY_DRIFT')
  const rows = prefix.slice(0, -1).split('\n').map(line => JSON.parse(line))
  const reserves = new Set(rows.filter(row => row?.type === 'reserve').map(row => row.attemptId))
  if (boundary.finalReserveAttemptIds.some(attemptId => typeof attemptId !== 'string' || !reserves.has(attemptId))) fail('HISTORICAL_LEDGER_EVIDENCE_MISSING')
  return boundary.eventCount
}
export function validateHistoricalSupersessionBoundary(raw, fromEventCount, boundary) {
  const attempts = boundary?.reserveAttempts ?? boundary?.reserveAttemptIds?.map(attemptId => ({ attemptId,
    invocationId: boundary.evidenceInvocationId, terminal: 'settle' }))
  // armBindings 只登记实际出现的臂；每臂 codeSha/sourceHash/driverHash 必填。parityId 是项目级
  // parity（按 case 不同），因此要么整臂一个值写在 armBindings，要么逐 attempt 写在 reserveAttempts，二者恰选其一。
  const armBindings = boundary?.armBindings
  const armOf = item => armBindings?.[item.attemptId.split(':')[0]]
  if (!boundary || boundary.fromEventCount !== fromEventCount
    || !Number.isSafeInteger(boundary.eventCount) || boundary.eventCount <= fromEventCount
    || !/^[a-f0-9]{64}$/.test(boundary.rawBytesSha256)
    || typeof boundary.protocolRevision !== 'string' || !boundary.protocolRevision
    || !/^[a-f0-9]{64}$/.test(boundary.protocolHash)
    || !Array.isArray(attempts) || attempts.length === 0
    || new Set(attempts.map(item => item.attemptId)).size !== attempts.length
    || attempts.some(item => typeof item.attemptId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.invocationId)
      || !['settle', 'unknown'].includes(item.terminal))
    || armBindings !== undefined && (!armBindings || typeof armBindings !== 'object' || Object.keys(armBindings).length === 0
      || Object.entries(armBindings).some(([arm, binding]) => !['baseline', 'candidate'].includes(arm)
        || !binding || !/^[a-f0-9]{40}$/.test(binding.codeSha)
        || ['sourceHash', 'driverHash'].some(key => !/^[a-f0-9]{64}$/.test(binding[key]))
        || binding.parityId !== undefined && !/^[a-f0-9]{64}$/.test(binding.parityId))
      || attempts.some(item => !Object.hasOwn(armBindings, item.attemptId.split(':')[0])
        || (armOf(item).parityId === undefined) === (item.parityId === undefined)))
    || attempts.some(item => item.parityId !== undefined && (!armBindings || !/^[a-f0-9]{64}$/.test(item.parityId)))
    || boundary.eventCount !== fromEventCount + attempts.length * 3) fail('INVALID_HISTORICAL_LEDGER_SUPERSESSION_BOUNDARY')
  let prefixEnd = 0
  for (let index = 0; index < boundary.eventCount; index++) {
    prefixEnd = raw.indexOf('\n', prefixEnd)
    if (prefixEnd < 0) fail('HISTORICAL_LEDGER_SUPERSESSION_MISSING')
    prefixEnd++
  }
  const prefix = raw.slice(0, prefixEnd)
  if (hash(prefix) !== boundary.rawBytesSha256) fail('HISTORICAL_LEDGER_SUPERSESSION_DRIFT')
  const rows = prefix.slice(0, -1).split('\n').slice(fromEventCount).map(line => JSON.parse(line))
  for (const [index, { attemptId, invocationId, terminal, parityId }] of attempts.entries()) {
    const [reserve, dispatch, outcome] = rows.slice(index * 3, index * 3 + 3)
    if (reserve?.type !== 'reserve' || reserve.attemptId !== attemptId
      || reserve.binding?.protocolRevision !== boundary.protocolRevision
      || reserve.binding?.protocolHash !== boundary.protocolHash
      || reserve.binding?.invocationId !== invocationId
      || dispatch?.type !== 'dispatch' || dispatch.attemptId !== attemptId
      || outcome?.type !== terminal || outcome.attemptId !== attemptId
      || armBindings && (reserve.binding?.arm !== attemptId.split(':')[0]
        || !['baseline', 'candidate'].includes(reserve.binding.arm) || !Object.hasOwn(armBindings, reserve.binding.arm)
        || ['codeSha', 'sourceHash', 'driverHash'].some(key =>
          reserve.binding[key] !== armBindings[reserve.binding.arm][key])
        || reserve.binding.parityId !== (parityId ?? armBindings[reserve.binding.arm].parityId))) fail('HISTORICAL_LEDGER_SUPERSESSION_EVIDENCE_MISSING')
  }
  return boundary.eventCount
}
export function validateCampaignBinding(binding, { campaignMode, protocol, historical = false }) {
  if (!binding || binding.campaignId !== CAMPAIGN_ID || binding.mode !== campaignMode
    || !['baseline', 'candidate'].includes(binding.arm) || !/^[a-f0-9]{40}$/.test(binding.codeSha)
    || ['sourceHash', 'driverHash', 'parityId'].some(key => !/^[a-f0-9]{64}$/.test(binding[key]))
    || !['early', 'post-ui', 'final', 'diagnostic'].includes(binding.milestone)) fail('INVALID_CAMPAIGN_BINDING')
  // The frozen prefix is authenticated byte-for-byte by its boundary hash. Its old
  // protocol selection and allocation are historical evidence, not input to the
  // current revision, so only the stable envelope is rechecked here.
  if (historical) return
  assertProtocolBinding(binding)
  const registeredPhase = protocol.phases[binding.phase]
  const phase = registeredPhase && { ...registeredPhase,
    ...(binding.milestone === 'post-ui' ? registeredPhase.postUiAiReview ?? registeredPhase.postUi ?? {} : {}) }
  if (!phase || !Array.isArray(phase.operations) || !Array.isArray(phase.caseIds)
    || !phase.caseIds.includes(binding.caseId)
    || !phase.operations.some(operation => operation.id === binding.operation && (!operation.caseIds || operation.caseIds.includes(binding.caseId)))) fail('INVALID_CAMPAIGN_BINDING')
  if ((['full', 'c16-c18'].includes(binding.phase)) !== (binding.milestone === 'final')
    || (['shared-input-diagnostic', 'bounded-revision-diagnostic'].includes(binding.phase)) !== (binding.milestone === 'diagnostic')
    || binding.phase === 'shared-input-diagnostic' && (binding.arm !== 'candidate'
      || phase.nonQualification !== true || phase.maxPhysicalRequests !== 1
      || binding.messagesSha256 !== phase.messagesSha256 || binding.originalMessagesSha256 !== phase.originalMessagesSha256)
    || binding.phase === 'bounded-revision-diagnostic' && (!isDeepStrictEqual(phase, BOUNDED_REVISION_DIAGNOSTIC)
      || binding.diagnosticSourceHash !== hash(phase.source) || !/^[a-f0-9]{64}$/u.test(binding.diagnosticInputHash ?? '')
      || binding.actual?.projectId === phase.source.projectId || binding.actual?.epoch === phase.source.epoch
      || !(phase.operations.find(item => item.id === binding.operation)?.kind === 'refine'
        ? binding.actual?.purpose === 'refine-from-review'
        : ['review-chapter', 'review-chapter-rebuild'].includes(binding.actual?.purpose)))
    || phase.arms && !phase.arms.includes(binding.arm)
    || phase.evaluationPolicy?.revision === AI_REVIEW_FINAL_MANUSCRIPT_POLICY.revision && ['review', 'refine', 'final-review'].includes(phase.operations.find(item => item.id === binding.operation)?.kind)
      && (binding.evaluationPolicyHash !== hash(phase.evaluationPolicy)
        || !(phase.operations.find(item => item.id === binding.operation).kind === 'refine'
          ? (binding.actual ?? binding.baselineIpc)?.purpose === 'refine-from-review'
          : ['review-chapter', 'review-chapter-rebuild'].includes((binding.actual ?? binding.baselineIpc)?.purpose)))
    || binding.phase === 'full' && !phase.operations.some(operation => operation.id === binding.operation
      && (operation.kind !== 'directory' || binding.caseId.endsWith('/1')))) fail('INVALID_CAMPAIGN_BINDING')
  if (binding.arm === 'candidate' && (!binding.actual || ['attemptId', 'runId', 'rootActionId', 'projectId', 'epoch']
    .some(key => typeof binding.actual[key] !== 'string' || !binding.actual[key]))) fail('ACTUAL_OWNER_ATTEMPT_REQUIRED')
}
export const runnerAdapterHash = () => hash(['scripts/quality-modernization-run.mjs', 'scripts/quality-modernization-driver.mjs', PRODUCTION_BRIDGE].map(file => [file, hash(fs.readFileSync(path.join(ROOT, file)))]))
const fail = code => { throw new Error(code) }
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
export const CAMPAIGN_ID = campaignIdFor(read(PROTOCOL_PATH).id)
const inside = (root, value) => { const relative = path.relative(root, value); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) }
const real = value => fs.realpathSync(value)
const native = value => fs.realpathSync.native(value)
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
export function createShortIsolationRoot() {
  const parent = isolationParent()
  fs.mkdirSync(parent, { recursive: true })
  if (!samePath(native(parent), path.resolve(parent)) || fs.lstatSync(parent).isSymbolicLink()) fail('UNOWNED_ISOLATION_PARENT')
  const root = fs.mkdtempSync(path.join(parent, 'q'))
  const createdAt = new Date(), expiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000)
  fs.writeFileSync(path.join(root, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel S14A quality runner', sourceProject: ROOT,
    isolationRoot: root, createdAt: createdAt.toISOString(), ttl: '7 days', expiresAt: expiresAt.toISOString(),
    retentionReason: 'S14A physical project and qualification evidence',
    cleanupCommand: `Remove-Item -LiteralPath '${root.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  return root
}
export function assertOwnedIsolationRoot(isolationRoot, arm) {
  const root = path.dirname(isolationRoot), parent = isolationParent()
  if (!samePath(native(parent), path.resolve(parent)) || !samePath(native(root), path.join(native(parent), path.basename(root)))
    || !samePath(native(isolationRoot), path.join(native(root), arm === 'baseline' ? 'b' : 'c'))
    || !inside(native(parent), native(root)) || root === parent) fail('UNOWNED_ISOLATION_ROOT')
  const ownerFile = path.join(root, '.vibe-owner.json')
  if (!fs.lstatSync(ownerFile).isFile() || fs.lstatSync(ownerFile).isSymbolicLink()) fail('UNOWNED_ISOLATION_ROOT')
  const owner = read(ownerFile)
  if (owner.owner !== 'AI Novel S14A quality runner' || owner.sourceProject !== ROOT
    || typeof owner.isolationRoot !== 'string' || !samePath(owner.isolationRoot, root)
    || !Number.isFinite(Date.parse(owner.createdAt)) || !Number.isFinite(Date.parse(owner.expiresAt))
    || owner.ttl !== '7 days') fail('UNOWNED_ISOLATION_ROOT')
  return native(isolationRoot)
}
export function validatePhysicalLedger(file) {
  if (!file || !path.isAbsolute(file)) fail('CAMPAIGN_LEDGER_PATH_MISMATCH')
  const ledger = path.resolve(file), parent = path.dirname(ledger)
  const ownerRoot = path.resolve(parent, '../../..')
  if (!samePath(ledger, path.join(ownerRoot, '.runtime', '.cache', 'novel-quality-modernization', 'physical-ledger.jsonl'))
    || !fs.existsSync(ledger) || !samePath(native(parent), parent) || !samePath(native(ledger), ledger)) fail('CAMPAIGN_LEDGER_PATH_MISMATCH')
  const stat = fs.lstatSync(ledger)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('CAMPAIGN_LEDGER_IDENTITY_MISMATCH')
  if (!samePath(native(path.resolve(ownerRoot, git(ownerRoot, ['rev-parse', '--git-common-dir']))),
    native(path.resolve(ROOT, git(ROOT, ['rev-parse', '--git-common-dir']))))
    || !samePath(native(registeredCampaignWorktree(git(ROOT, ['worktree', 'list', '--porcelain']))), native(ownerRoot))) fail('CAMPAIGN_LEDGER_IDENTITY_MISMATCH')
  const raw = fs.readFileSync(ledger, 'utf8'), protocol = read(PROTOCOL_PATH)
  const historical = validateHistoricalLedgerBoundary(raw, protocol.historicalLedgerBoundary)
  const superseded = validateHistoricalSupersessionBoundary(raw, historical, protocol.historicalSupersessionBoundary)
  const reviewed = validateHistoricalSupersessionBoundary(raw, superseded, protocol.historicalReviewedDraftBoundary)
  const rebuilt = validateHistoricalSupersessionBoundary(raw, reviewed, protocol.historicalReviewRebuildBoundary)
  const split = validateHistoricalSupersessionBoundary(raw, rebuilt, protocol.historicalS14BSplitBoundary)
  const postUi = validateHistoricalSupersessionBoundary(raw, split, protocol.historicalPostUi408Boundary)
  const c16 = validateHistoricalSupersessionBoundary(raw, postUi, protocol.historicalC16Ee3435ecBoundary)
  const ccc70b31 = validateHistoricalSupersessionBoundary(raw, c16, protocol.historicalC16Ccc70b31Boundary)
  const c9b88510 = validateHistoricalSupersessionBoundary(raw, ccc70b31, protocol.historicalC16C9b88510Boundary)
  const d8a30c11 = validateHistoricalSupersessionBoundary(raw, c9b88510, protocol.historicalC16D8a30c11Boundary)
  const ca466d9a = validateHistoricalSupersessionBoundary(raw, d8a30c11, protocol.historicalC16Ca466d9aBoundary)
  const r73b46513 = validateHistoricalSupersessionBoundary(raw, ca466d9a, protocol.historicalC1673b46513Boundary)
  const fa8806d7 = validateHistoricalSupersessionBoundary(raw, r73b46513, protocol.historicalC16Fa8806d7Boundary)
  const b42cfc55 = validateHistoricalSupersessionBoundary(raw, fa8806d7, protocol.historicalC16B42cfc55Boundary)
  const r67a57c04 = validateHistoricalSupersessionBoundary(raw, b42cfc55, protocol.historicalC1667a57c04Boundary)
  const r2867cfa4 = validateHistoricalSupersessionBoundary(raw, r67a57c04, protocol.historicalC162867cfa4Boundary)
  const ba2d34ab = validateHistoricalSupersessionBoundary(raw, r2867cfa4, protocol.historicalPostUiBa2d34abBoundary)
  const r1d0bdac3 = validateHistoricalSupersessionBoundary(raw, ba2d34ab, protocol.historicalPostUi1d0bdac3Boundary)
  const ac3af420 = validateHistoricalSupersessionBoundary(raw, r1d0bdac3, protocol.historicalC16Ac3af420Boundary)
  const a9552e67 = validateHistoricalSupersessionBoundary(raw, ac3af420, protocol.historicalC16A9552e67Boundary)
  const r63a44636 = validateHistoricalSupersessionBoundary(raw, a9552e67, protocol.historicalC1663a44636Boundary)
  const a4d2b6ed = validateHistoricalSupersessionBoundary(raw, r63a44636, protocol.historicalC16A4d2b6edBoundary)
  const r0917fb36 = validateHistoricalSupersessionBoundary(raw, a4d2b6ed, protocol.historicalC160917fb36Boundary)
  const r1aa5487e = validateHistoricalSupersessionBoundary(raw, r0917fb36, protocol.historicalC161aa5487eBoundary)
  const r9337909d = validateHistoricalSupersessionBoundary(raw, r1aa5487e, protocol.historicalC169337909dBoundary)
  const sharedInput7203443d = validateHistoricalSupersessionBoundary(raw, r9337909d, protocol.historicalSharedInput7203443dBoundary)
  const c1670407421 = validateHistoricalSupersessionBoundary(raw, sharedInput7203443d, protocol.historicalC1670407421Boundary)
  const d712808c = validateHistoricalSupersessionBoundary(raw, c1670407421, protocol.historicalC16D712808cBoundary)
  const r625bfda8 = validateHistoricalSupersessionBoundary(raw, d712808c, protocol.historicalC16625bfda8Boundary)
  const d515b666 = validateHistoricalSupersessionBoundary(raw, r625bfda8, protocol.historicalC16D515b666Boundary)
  const a763f510 = validateHistoricalSupersessionBoundary(raw, d515b666, protocol.historicalC16A763f510Boundary)
  validateHistoricalSupersessionBoundary(raw, a763f510, protocol.historicalBoundedRevisionE41a3f0aBoundary)
  return ledger
}
export function registeredCampaignWorktree(porcelain) {
  const matches = porcelain.split(/\r?\n\r?\n/u).map(block => block.split(/\r?\n/u))
    .filter(lines => lines.includes('branch refs/heads/codex/program-v3-autonomous-continuation'))
  const registered = matches[0]?.filter(line => line.startsWith('worktree '))
  if (matches.length !== 1 || registered?.length !== 1 || matches[0].some(line => line.startsWith('prunable'))) fail('CAMPAIGN_WORKTREE_NOT_UNIQUE')
  return registered[0].slice('worktree '.length)
}
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
export function assertFormalTargetCandidateClean(root) {
  if (git(root, ['diff', 'HEAD', '--name-only'])) fail('TARGET_TRACKED_DIRTY')
  assertCommittedProductionFiles(root)
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
/**
 * 对账：任何已经 dispatch 但没有终态行的 attempt，补写 unknown。
 *
 * 子进程可能被 vitest 超时、spawnSync 超时或硬崩溃杀死，三种情况都不会执行桥内的
 * 结算路径；但调用方进程仍然活着。这是唯一能覆盖全部死法的地方，也是账本
 * 「每次真实发送都有终态」这条不变量的兜底。unknown 是真话：已发出、未观测到结果，
 * 按设计不得退款。并发下若终态已写入，转移非法，视为已结算。
 */
export function reconcileDispatchedAttempts(file, campaignMode) {
  if (!fs.existsSync(file)) return { reconciled: 0, dangling: 0 }
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const terminal = new Set(rows.filter(row => ['settle', 'unknown', 'cancel'].includes(row.type)).map(row => row.attemptId))
  const dangling = [...new Set(rows.filter(row => row.type === 'dispatch' && !terminal.has(row.attemptId)).map(row => row.attemptId))]
  let reconciled = 0
  for (const attemptId of dangling) {
    try { updateLedger(file, { type: 'unknown', attemptId }, { campaignMode }); reconciled += 1 }
    catch (error) { if (!/INVALID_LEDGER_TRANSITION/u.test(String(error.message))) throw error }
  }
  return { reconciled, dangling: dangling.length }
}

/** 成对执行失败时先对账再抛出，保证失败路径也不留下悬空派发。 */
export function withLedgerReconciliation(ledgerPath, campaignMode, run) {
  try { return run() } finally { reconcileDispatchedAttempts(ledgerPath, campaignMode) }
}

export function selectPhase(protocol, phase, milestone = 'early') {
  if (!['early', 'post-ui', 'final', 'diagnostic'].includes(milestone)) fail('INVALID_MILESTONE')
  if (!Object.hasOwn(protocol.phases, phase)) fail('INVALID_PHASE')
  if (phase === 'bounded-revision-diagnostic' && !isDeepStrictEqual(protocol.phases[phase], BOUNDED_REVISION_DIAGNOSTIC))
    fail('BOUNDED_REVISION_REGISTRATION_MISMATCH')
  if (phase === 'c16-c18' && !isDeepStrictEqual(protocol.phases[phase].evaluationPolicy, AI_REVIEW_FINAL_MANUSCRIPT_POLICY))
    fail('AI_MANUSCRIPT_REGISTRATION_MISMATCH')
  if (milestone === 'post-ui' && POST_UI_AI_REVIEW_SCENARIOS[phase]
    && !isDeepStrictEqual(protocol.phases[phase].postUiAiReview, POST_UI_AI_REVIEW_SCENARIOS[phase])) fail('AI_MANUSCRIPT_REGISTRATION_MISMATCH')
  if ((['full', 'c16-c18'].includes(phase)) !== (milestone === 'final')
    || (['shared-input-diagnostic', 'bounded-revision-diagnostic'].includes(phase)) !== (milestone === 'diagnostic')) fail('PHASE_MILESTONE_MISMATCH')
  return { phase, milestone, ...protocol.phases[phase],
    ...(milestone === 'post-ui' ? protocol.phases[phase].postUiAiReview ?? protocol.phases[phase].postUi ?? {} : {}) }
}
export function forwardReasoningFor(protocol, phase, milestone) {
  const registration = protocol.forwardReasoningExperiment
  const zero = protocol.forwardTemperatureExperiment
  const high = protocol.forwardHighReasoningExperiment
  if ((zero !== undefined || high !== undefined) && (!registration || !zero || typeof zero !== 'object'
    || hash(registration) !== '2600c33e729b32d5d604645cfa833608f15dce588fea055788ad82f6d3ea6fc0'
    || !isDeepStrictEqual(Object.keys(zero).sort(), ['baseRevision', 'limits', 'revision', 'temperature'])
    || zero.revision !== 'fixed-zero-temperature-max-v1' || zero.baseRevision !== registration.revision
    || zero.temperature !== 0 || hash(zero) !== '2bce7d852a0fb355e693db1b95812fda70d81eae0472b31bf9b17489e78e71a6')) fail('FORWARD_TEMPERATURE_REGISTRATION_MISMATCH')
  if (high !== undefined && (!high || hash(high) !== '39d2606076046d2e5307abf9be392abf0a4c4c46dbe9c235851de95016fbbf95'
    || !isDeepStrictEqual(Object.keys(high).sort(), ['baseRevision', 'limits', 'reasoningOverride', 'revision'])
    || high.revision !== 'fixed-high-zero-temperature-v1' || high.baseRevision !== zero.revision
    || high.reasoningOverride !== 'high')) fail('FORWARD_HIGH_REGISTRATION_MISMATCH')
  const bounded = phase === 'bounded-revision-diagnostic'
  if (bounded && (!high || !protocol.forwardQualificationWindowExperiment)) fail('BOUNDED_REVISION_REGISTRATION_MISMATCH')
  const scope = bounded ? { phase, milestone, caseIds: selectPhase(protocol, phase, milestone).caseIds }
    : registration?.scopes?.find(item => item.phase === phase && item.milestone === milestone)
  if (!scope) return null
  if (!isDeepStrictEqual(scope.caseIds, selectPhase(protocol, phase, milestone).caseIds)) fail('FORWARD_REASONING_SCOPE_MISMATCH')
  if (zero === undefined) return registration
  const effective = { ...registration, ...(bounded ? { scopes: [scope] } : {}), revision: zero.revision,
    model: { ...registration.model, temperature: zero.temperature }, limits: zero.limits }
  return high === undefined ? effective : { ...effective, revision: high.revision, reasoningOverride: high.reasoningOverride,
    wire: { ...effective.wire, candidate: { ...effective.wire.candidate, reasoning_effort: high.reasoningOverride } }, limits: high.limits }
}
export function forwardQualificationWindowFor(protocol, phase, milestone) {
  const registration = protocol.forwardQualificationWindowExperiment
  const reasoning = forwardReasoningFor(protocol, phase, milestone)
  if (registration === undefined) return null
  if (!protocol.forwardHighReasoningExperiment || !protocol.forwardTemperatureExperiment
    || !isDeepStrictEqual(Object.keys(registration ?? {}).sort(), ['baseHash', 'limits', 'revision', 'scopes'])
    || registration.revision !== 'native-budget-aligned-qualification-window-v1'
    || registration.baseHash !== hash(protocol.forwardHighReasoningExperiment)
    || hash(registration) !== '60ea01b953c801ab0457dcab1c17401a535a888fd4a94316903d6fafcd9af075'
    || !isDeepStrictEqual(registration.scopes, protocol.forwardReasoningExperiment.scopes))
    fail('FORWARD_QUALIFICATION_WINDOW_REGISTRATION_MISMATCH')
  for (const scope of registration.scopes)
    if (!isDeepStrictEqual(scope.caseIds, selectPhase(protocol, scope.phase, scope.milestone).caseIds))
      fail('FORWARD_QUALIFICATION_WINDOW_REGISTRATION_MISMATCH')
  const scope = registration.scopes.find(item => item.phase === phase && item.milestone === milestone)
  if (!scope && phase !== 'bounded-revision-diagnostic') return null
  if (reasoning?.revision !== protocol.forwardHighReasoningExperiment.revision)
    fail('FORWARD_QUALIFICATION_WINDOW_REGISTRATION_MISMATCH')
  return registration
}
/**
 * 生产桥只是协议的执行者：场景登记的 caseId 与 operation id 必须逐字等于该阶段的
 * 预注册内容。不一致时阻断，而不是跑一个不是预注册的实验。
 */
export function assertScenarioMatchesProtocol(selection, scenario, semanticPath) {
  if (!scenario || !isDeepStrictEqual(selection.caseIds, scenario.caseIds ?? [scenario.caseId])
    || !Array.isArray(selection.operations) || selection.operations.length !== scenario.operations.length
    || selection.operations.some((operation, index) => operation.id !== scenario.operations[index].id)
    || (selection.scenarioRevision ?? null) !== (scenario.scenarioRevision ?? null)
    || !isDeepStrictEqual(selection.selectionDifference ?? null, scenario.selectionDifference ?? null)
    || !isDeepStrictEqual(selection.attemptPolicy ?? null, scenario.attemptPolicy ?? null)
    || !isDeepStrictEqual(selection.evaluationPolicy ?? null, scenario.evaluationPolicy ?? null)) fail('SCENARIO_PROTOCOL_MISMATCH')
  if (!isDeepStrictEqual(selection.arms ?? null, scenario.arms ?? null)) fail('SCENARIO_PROTOCOL_MISMATCH')
  if (selection.phase === 'c16-c18') {
    const order = semanticPath && read(semanticPath).continuityQualificationCases?.map(item => item.id)
    const oracles = selection.caseOracles
    // v4 起每个 operation 的 kind、restore 与 caseIds 也逐字对齐：哪一案执行哪些后处理/续写只由协议决定。
    if (selection.operations.some((operation, index) => operation.kind !== scenario.operations[index].kind
      || (operation.restore ?? null) !== (scenario.operations[index].restore ?? null)
      || !isDeepStrictEqual(operation.caseIds, [...(scenario.operations[index].caseIds ?? [])]))
      || !isDeepStrictEqual(selection.caseOrder, selection.caseIds) || !isDeepStrictEqual(selection.caseOrder, order)
      || !isDeepStrictEqual(Object.keys(oracles ?? {}), selection.caseOrder)
      || selection.caseOrder.some(id => ['automatic', 'independentReview'].some(key =>
        !Array.isArray(oracles[id]?.[key]) || oracles[id][key].length === 0
        || oracles[id][key].some(value => typeof value !== 'string' || !value.trim())))
      || ['technicalFailure', 'semanticFailureOrUnknown', 'attemptAccounting', 'repair']
        .some(key => typeof selection.stopPolicy?.[key] !== 'string' || !selection.stopPolicy[key].trim())) fail('SCENARIO_PROTOCOL_MISMATCH')
  }
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
  if (target.schemaVersion === 2) assertProtocolBinding(target)
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
  if (target.schemaVersion === 2) assertOwnedIsolationRoot(isolationRoot, target.arm)
  else if (!inside(real(CACHE), isolationRoot) || isolationRoot === real(CACHE)) fail('UNOWNED_ISOLATION_ROOT')
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
  if (!development) assertFormalTargetCandidateClean(ROOT)
  if (git(baselineRoot, ['rev-parse', 'HEAD']) !== '2264390d6fb8b052cc14736d544df0cc74516649') fail('BASELINE_SHA_MISMATCH')
  if (git(baselineRoot, ['diff', 'HEAD', '--name-only'])) fail('TARGET_TRACKED_DIRTY')
  // Keep the actual project below the production Windows path limit; no bypass.
  const root = createShortIsolationRoot()
  const semanticSource = read(path.join(ROOT, 'test/fixtures/novel-quality-modernization/semantic-source.json'))
  const fixtureExports = buildFixtureExports(semanticSource)
  const protocolBinding = currentProtocolBinding()
  const targets = Object.fromEntries(['baseline', 'candidate'].map(arm => {
    const repositoryRoot = real(arm === 'baseline' ? baselineRoot : ROOT), isolationRoot = path.join(root, arm === 'baseline' ? 'b' : 'c')
    const roots = Object.fromEntries(['userData', 'config', 'project', 'legacySource'].map((key, index) => [key, path.join(isolationRoot, ['u', 'c', 'p', 'l'][index])]))
    Object.values(roots).forEach(directory => fs.mkdirSync(directory, { recursive: true }))
    const longestProjectRoot = Math.max(...semanticSource.scenes.map(scene => path.join(native(roots.project), '12345678', scene.title).length))
    if (process.platform === 'win32' && longestProjectRoot > 85) fail('PHYSICAL_PROJECT_PATH_TOO_LONG')
    const fixture = fixtureExports[arm === 'baseline' ? 'legacy' : 'canonical'], fixturePath = path.join(isolationRoot, 'semantic-fixture.json')
    fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2))
    const target = { schemaVersion: 2, arm, repositoryRoot, codeSha: git(repositoryRoot, ['rev-parse', 'HEAD']), ...protocolBinding,
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
  if (options.campaignMode === 'real') validatePhysicalLedger(file)
  else fs.mkdirSync(CACHE, { recursive: true })
  const parent = real(path.dirname(file))
  if (options.campaignMode !== 'real' && (!inside(real(CACHE), parent) || fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())) fail('UNOWNED_LEDGER')
  const lock = `${file}.lock`
  let fd
  try { fd = fs.openSync(lock, 'wx') } catch { fail('LEDGER_BUSY') }
  try {
    const rawLedger = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const events = rawLedger.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
    if (options.campaignMode) {
      if (!['real', 'synthetic'].includes(options.campaignMode)) fail('INVALID_CAMPAIGN_MODE')
      const protocol = read(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json'))
      const reserved = new Map(), statuses = new Map()
      const historicalBoundary = options.campaignMode === 'real'
        ? protocol.historicalLedgerBoundary : options.historicalLedgerBoundary
      const trustedHistoricalEvents = historicalBoundary
        ? validateHistoricalLedgerBoundary(rawLedger, historicalBoundary) : 0
      const supersessionBoundary = options.campaignMode === 'real'
        ? protocol.historicalSupersessionBoundary : options.historicalSupersessionBoundary
      const trustedSupersessionEvents = supersessionBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedHistoricalEvents, supersessionBoundary)
        : trustedHistoricalEvents
      const reviewedBoundary = options.campaignMode === 'real'
        ? protocol.historicalReviewedDraftBoundary : options.historicalReviewedDraftBoundary
      const trustedReviewedEvents = reviewedBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedSupersessionEvents, reviewedBoundary)
        : trustedSupersessionEvents
      const rebuildBoundary = options.campaignMode === 'real'
        ? protocol.historicalReviewRebuildBoundary : options.historicalReviewRebuildBoundary
      const trustedRebuildEvents = rebuildBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedReviewedEvents, rebuildBoundary)
        : trustedReviewedEvents
      const splitBoundary = options.campaignMode === 'real'
        ? protocol.historicalS14BSplitBoundary : options.historicalS14BSplitBoundary
      const trustedSplitEvents = splitBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedRebuildEvents, splitBoundary)
        : trustedRebuildEvents
      const postUiBoundary = options.campaignMode === 'real'
        ? protocol.historicalPostUi408Boundary : options.historicalPostUi408Boundary
      const trustedPostUiEvents = postUiBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedSplitEvents, postUiBoundary)
        : trustedSplitEvents
      const c16Boundary = options.campaignMode === 'real'
        ? protocol.historicalC16Ee3435ecBoundary : options.historicalC16Ee3435ecBoundary
      const trustedC16Events = c16Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedPostUiEvents, c16Boundary)
        : trustedPostUiEvents
      // 第433–507行：旧协议 hash 下两次 C16–C18 失败与一次 post-UI 执行；加性认证，不改判。
      const ccc70b31Boundary = options.campaignMode === 'real'
        ? protocol.historicalC16Ccc70b31Boundary : options.historicalC16Ccc70b31Boundary
      const trustedCcc70b31Events = ccc70b31Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedC16Events, ccc70b31Boundary)
        : trustedC16Events
      // 第508–579行：旧协议 hash `68722f93…` 下 C16–C18 真实 invocation c9b88510 与 d8a30c11。两次 candidate 代码
      // 身份不同，按同一 armBindings 规则各登记一段（507→546、546→579）；只加性认证，不改判。
      const c9b88510Boundary = options.campaignMode === 'real'
        ? protocol.historicalC16C9b88510Boundary : options.historicalC16C9b88510Boundary
      const trustedC9b88510Events = c9b88510Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedCcc70b31Events, c9b88510Boundary)
        : trustedCcc70b31Events
      const d8a30c11Boundary = options.campaignMode === 'real'
        ? protocol.historicalC16D8a30c11Boundary : options.historicalC16D8a30c11Boundary
      const trustedD8a30c11Events = d8a30c11Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedC9b88510Events, d8a30c11Boundary)
        : trustedC9b88510Events
      // 第580–648行：协议 hash `a0a14777…` 下 C16–C18 真实 invocation ca466d9a（code e797f2d2，FINALIZATION_EFFECT_MISSING）
      // 与 73b46513（code 2275cdde，C17-B 独立评审 FAIL）。按同一 armBindings 规则各登记一段（579→615、615→648）；只加性认证，不改判。
      const ca466d9aBoundary = options.campaignMode === 'real'
        ? protocol.historicalC16Ca466d9aBoundary : options.historicalC16Ca466d9aBoundary
      const trustedCa466d9aEvents = ca466d9aBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedD8a30c11Events, ca466d9aBoundary)
        : trustedD8a30c11Events
      const r73b46513Boundary = options.campaignMode === 'real'
        ? protocol.historicalC1673b46513Boundary : options.historicalC1673b46513Boundary
      const trusted73b46513Events = r73b46513Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedCa466d9aEvents, r73b46513Boundary)
        : trustedCa466d9aEvents
      // 第649–690行：协议 hash `7a17f36a…`（场景 v4）下 C16–C18 真实 invocation fa8806d7（code 8a07eb16，独立评审 R1/R2 FAIL）。
      // 按同一 armBindings 规则登记一段（648→690）；只加性认证，不改判。
      const fa8806d7Boundary = options.campaignMode === 'real'
        ? protocol.historicalC16Fa8806d7Boundary : options.historicalC16Fa8806d7Boundary
      const trustedFa8806d7Events = fa8806d7Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trusted73b46513Events, fa8806d7Boundary)
        : trusted73b46513Events
      // 第691–738行：协议 hash `31f8b204…`（场景 v5）下 C16–C18 真实 invocation b42cfc55（code 2f420a38，独立评审 FAIL）。
      // 按同一 armBindings 规则登记一段（690→738）；只加性认证，不改判。
      const b42cfc55Boundary = options.campaignMode === 'real'
        ? protocol.historicalC16B42cfc55Boundary : options.historicalC16B42cfc55Boundary
      const trustedB42cfc55Events = b42cfc55Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedFa8806d7Events, b42cfc55Boundary)
        : trustedFa8806d7Events
      // 第739–774行：协议 hash `4491c88d…`（场景 v5）下 C16–C18 真实 invocation 67a57c04（code b6bef1f3，C17-B 技术失败停发）。
      // 按同一 armBindings 规则登记一段（738→774）；只加性认证，不改判。
      const r67a57c04Boundary = options.campaignMode === 'real'
        ? protocol.historicalC1667a57c04Boundary : options.historicalC1667a57c04Boundary
      const trusted67a57c04Events = r67a57c04Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedB42cfc55Events, r67a57c04Boundary)
        : trustedB42cfc55Events
      // 第775–828行：协议 hash `1d7c737b…`（场景 v5）下 C16–C18 真实 invocation 2867cfa4（code 2147b95c，自动阶段七案通过，独立评审七案 PASS）。
      // 按同一 armBindings 规则登记一段（774→828）；只加性认证，不改判。
      const r2867cfa4Boundary = options.campaignMode === 'real'
        ? protocol.historicalC162867cfa4Boundary : options.historicalC162867cfa4Boundary
      const trusted2867cfa4Events = r2867cfa4Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trusted67a57c04Events, r2867cfa4Boundary)
        : trusted67a57c04Events
      // 第829–843行：协议 hash `7cf6e1ce…`（场景 v2）下 post-UI 真实 invocation ba2d34ab（baseline 2264390d + candidate a618c122，
      // candidate 首稿超上限而压缩未登记，reserve 前被拒后以 GENERATION_DRAFT_LENGTH_OUT_OF_RANGE 失败）。
      // 按同一 armBindings 规则登记一段（828→843，两臂）；只加性认证，不改判。
      const ba2d34abBoundary = options.campaignMode === 'real'
        ? protocol.historicalPostUiBa2d34abBoundary : options.historicalPostUiBa2d34abBoundary
      const trustedBa2d34abEvents = ba2d34abBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trusted2867cfa4Events, ba2d34abBoundary)
        : trusted2867cfa4Events
      // 第844–861行：协议 hash `08dbed9d…`（post-UI 场景 v3）下 post-UI 真实 invocation 1d0bdac3（baseline 2264390d + candidate 02e94787，
      // 自动阶段两臂通过，候选首稿在区间内、未触发压缩；盲评待独立裁定，记录于私有检查点）。按同一 armBindings 规则登记一段（843→861，两臂）；只加性认证，不改判。
      const r1d0bdac3Boundary = options.campaignMode === 'real'
        ? protocol.historicalPostUi1d0bdac3Boundary : options.historicalPostUi1d0bdac3Boundary
      const trusted1d0bdac3Events = r1d0bdac3Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedBa2d34abEvents, r1d0bdac3Boundary)
        : trustedBa2d34abEvents
      // 第862–909行：e9a39853 的 C16–C18 invocation ac3af420，共16次已结算请求；只登记物理历史，不作质量裁定。
      const ac3af420Boundary = options.campaignMode === 'real'
        ? protocol.historicalC16Ac3af420Boundary : options.historicalC16Ac3af420Boundary
      const trustedAc3af420Events = ac3af420Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trusted1d0bdac3Events, ac3af420Boundary)
        : trusted1d0bdac3Events
      // 第910–957行：98b63481 的 C16–C18 invocation a9552e67，共16次已结算请求；仅登记物理历史。
      const a9552e67Boundary = options.campaignMode === 'real'
        ? protocol.historicalC16A9552e67Boundary : options.historicalC16A9552e67Boundary
      const trustedA9552e67Events = a9552e67Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedAc3af420Events, a9552e67Boundary)
        : trustedAc3af420Events
      // 第958–1005行：613a55cd 的 C16–C18 invocation 63a44636，共16次已结算请求；仅登记物理历史。
      const r63a44636Boundary = options.campaignMode === 'real'
        ? protocol.historicalC1663a44636Boundary : options.historicalC1663a44636Boundary
      const trusted63a44636Events = r63a44636Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedA9552e67Events, r63a44636Boundary)
        : trustedA9552e67Events
      // 第1006–1041行：74d168a6 的 C16–C18 invocation a4d2b6ed，共12次已结算请求；仅登记物理历史。
      const a4d2b6edBoundary = options.campaignMode === 'real'
        ? protocol.historicalC16A4d2b6edBoundary : options.historicalC16A4d2b6edBoundary
      const trustedA4d2b6edEvents = a4d2b6edBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trusted63a44636Events, a4d2b6edBoundary)
        : trusted63a44636Events
      // 第1042–1080行：043b3dc3 的 C16–C18 invocation 0917fb36，共13次已结算请求；仅登记物理历史。
      const r0917fb36Boundary = options.campaignMode === 'real'
        ? protocol.historicalC160917fb36Boundary : options.historicalC160917fb36Boundary
      const trusted0917fb36Events = r0917fb36Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedA4d2b6edEvents, r0917fb36Boundary)
        : trustedA4d2b6edEvents
      // 第1081–1122行：5a8208dd 的 C16–C18 invocation 1aa5487e，共14次已结算请求；仅登记物理历史。
      const r1aa5487eBoundary = options.campaignMode === 'real'
        ? protocol.historicalC161aa5487eBoundary : options.historicalC161aa5487eBoundary
      const trusted1aa5487eEvents = r1aa5487eBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trusted0917fb36Events, r1aa5487eBoundary)
        : trusted0917fb36Events
      // 第1123–1158行：2e3500b8 的 C16–C18 invocation 9337909d，共12次已结算请求；仅登记物理历史。
      const r9337909dBoundary = options.campaignMode === 'real'
        ? protocol.historicalC169337909dBoundary : options.historicalC169337909dBoundary
      const trusted9337909dEvents = r9337909dBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trusted1aa5487eEvents, r9337909dBoundary)
        : trusted1aa5487eEvents
      const sharedInput7203443dBoundary = options.campaignMode === 'real'
        ? protocol.historicalSharedInput7203443dBoundary : options.historicalSharedInput7203443dBoundary
      const trustedSharedInput7203443dEvents = sharedInput7203443dBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trusted9337909dEvents, sharedInput7203443dBoundary)
        : trusted9337909dEvents
      const c1670407421Boundary = options.campaignMode === 'real'
        ? protocol.historicalC1670407421Boundary : options.historicalC1670407421Boundary
      const trustedC1670407421Events = c1670407421Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedSharedInput7203443dEvents, c1670407421Boundary)
        : trustedSharedInput7203443dEvents
      const d712808cBoundary = options.campaignMode === 'real'
        ? protocol.historicalC16D712808cBoundary : options.historicalC16D712808cBoundary
      const trustedD712808cEvents = d712808cBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedC1670407421Events, d712808cBoundary)
        : trustedC1670407421Events
      const r625bfda8Boundary = options.campaignMode === 'real'
        ? protocol.historicalC16625bfda8Boundary : options.historicalC16625bfda8Boundary
      const trusted625bfda8Events = r625bfda8Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedD712808cEvents, r625bfda8Boundary)
        : trustedD712808cEvents
      const d515b666Boundary = options.campaignMode === 'real'
        ? protocol.historicalC16D515b666Boundary : options.historicalC16D515b666Boundary
      const trustedD515b666Events = d515b666Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trusted625bfda8Events, d515b666Boundary) : trusted625bfda8Events
      const a763f510Boundary = options.campaignMode === 'real'
        ? protocol.historicalC16A763f510Boundary : options.historicalC16A763f510Boundary
      const trustedA763f510Events = a763f510Boundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedD515b666Events, a763f510Boundary) : trustedD515b666Events
      const e41a3f0aBoundary = options.campaignMode === 'real'
        ? protocol.historicalBoundedRevisionE41a3f0aBoundary : options.historicalBoundedRevisionE41a3f0aBoundary
      const trustedE41a3f0aEvents = e41a3f0aBoundary
        ? validateHistoricalSupersessionBoundary(rawLedger, trustedA763f510Events, e41a3f0aBoundary) : trustedA763f510Events
      // 绑定校验的 phase / caseId / operation 全部取自协议本身：阶段必须先存在、
      // caseId 必须在该阶段登记、operation 必须是该阶段登记的 operation id。
      // 未登记 operations 的阶段在这里 fail closed。
      // 阶段决定首选分配桶：early 阶段用 early*，post-UI 重跑用 postUi*；
      // 同一 slot 的重复发送或已超出计划样本量的发送归入失败/修复余量。
      // ADR 0019 已移除硬上限：allocation 只分类和汇报，从不拒绝发送。
      const allocationFor = binding => {
        const occupied = [...reserved.values()].filter(row => statuses.get(row.attemptId) !== 'cancel')
        if (binding.phase === 'shared-input-diagnostic') {
          if (occupied.some(row => row.binding.phase === binding.phase)) fail('SHARED_INPUT_DIAGNOSTIC_ALREADY_DISPATCHED')
          return 'nonQualificationDiagnostic'
        }
        if (binding.phase === 'bounded-revision-diagnostic') {
          const prior = occupied.filter(row => row.binding.phase === binding.phase)
          const matches = prior.filter(row => row.binding.operation === binding.operation)
          if (prior.some(row => row.binding.invocationId !== binding.invocationId
            || row.binding.diagnosticInputHash !== binding.diagnosticInputHash)
            || prior.length >= BOUNDED_REVISION_DIAGNOSTIC.maxPhysicalRequests
            || matches.length >= (binding.actual.purpose === 'refine-from-review' ? 1 : 2)
            || binding.actual.purpose === 'review-chapter' && matches.length !== 0
            || binding.actual.purpose === 'review-chapter-rebuild' && (matches.length !== 1
              || matches[0].binding.actual.purpose !== 'review-chapter'))
            fail('BOUNDED_REVISION_DIAGNOSTIC_ALREADY_DISPATCHED')
          return 'nonQualificationDiagnostic'
        }
        const slot = value => `${value.milestone}:${value.phase}:${value.caseId}:${value.arm}:${value.operation}`
        const suffix = { 'early-budget': 'Budget', 'early-context': 'Context', 'early-review': 'Review' }[binding.phase]
        if (!suffix && !['full', 'c16-c18'].includes(binding.phase)) fail('INVALID_CAMPAIGN_BINDING')
        const primary = ['full', 'c16-c18'].includes(binding.phase)
          ? protocol.phases[binding.phase].operations.find(operation => operation.id === binding.operation).allocation
          : `${binding.milestone === 'early' ? 'early' : 'postUi'}${suffix}`
        const repeatedSlot = occupied.some(row => slot(row.binding) === slot(binding))
        const primaryUsed = occupied.filter(row => row.allocation === primary).length
        return !repeatedSlot && primaryUsed < protocol.allocation[primary]
          ? primary : 'failedRetryRepairReviewReserve'
      }
      for (const [index, row] of events.entries()) {
        if (row.type === 'reserve') {
          const frozen = index < trustedHistoricalEvents
          const superseded = index >= trustedHistoricalEvents && index < trustedE41a3f0aEvents
          validateCampaignBinding(row.binding, { campaignMode: options.campaignMode, protocol, historical: frozen || superseded })
          if (!frozen && !superseded && row.allocation !== allocationFor(row.binding)) fail('CAMPAIGN_ALLOCATION_MISMATCH')
          reserved.set(row.attemptId, row)
        }
        statuses.set(row.attemptId, row.type)
      }
      if (event.type === 'reserve') {
        validateCampaignBinding(event.binding, { campaignMode: options.campaignMode, protocol })
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
export const developmentLedgerPath = (root, phase) => path.join(CACHE, `synthetic-ledger-${path.basename(root)}-${phase}.jsonl`)

export function main(argv) {
  let [command = 'help', ...rest] = argv
  if (['help', '--help', '-h'].includes(command)) return { usage: 'node scripts/quality-modernization-run.mjs <freeze-targets|development-synthetic|shared-input-diagnostic|baseline-probe|dry-run|early-budget|early-context|early-review|full|c16-c18> --targets <json> [--milestone early|post-ui|final] [--mode synthetic|real] [--physical-ledger <existing d103 ledger, real only>]; shared-input-diagnostic: --diagnostic-input <frozen private JSON> --mode synthetic|real [--targets <frozen targets> | --baseline-root <baseline> --output <new private targets>] ; freeze-targets/development-synthetic: --baseline-root <existing worktree> --output <new private targets.json> [--model-id <safely provisioned id>] [--scenario early-budget|early-context|early-review|full|c16-c18 (development-synthetic only; default early-budget)]', physicalModelRequests: 0 }
  if (command.startsWith('--')) { rest = argv; command = 'phase-options' }
  const args = {}
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]
    if (key === '--dry-run') { if (args[key]) fail('INVALID_ARGUMENT'); args[key] = true; continue }
    if (!['--targets', '--milestone', '--mode', '--baseline-root', '--output', '--model-id', '--protocol', '--phase', '--scenario', '--physical-ledger', '--diagnostic-input'].includes(key) || !rest[i + 1] || args[key]) fail('INVALID_ARGUMENT')
    args[key] = rest[++i]
  }
  if (command === 'phase-options') command = args['--phase'] || fail('INVALID_PHASE')
  if (args['--protocol'] && path.resolve(args['--protocol']) !== path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')) fail('PROTOCOL_PATH_MISMATCH')
  const protocol = read(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json'))
  if (command === 'shared-input-diagnostic') {
    const registration = selectPhase(protocol, command, 'diagnostic')
    if (!args['--diagnostic-input'] || !['real', 'synthetic'].includes(args['--mode'])
      || (args['--mode'] === 'real') !== Boolean(args['--physical-ledger'])) fail('SHARED_INPUT_DIAGNOSTIC_ARGUMENTS_REQUIRED')
    const inputPath = real(args['--diagnostic-input'])
    if (!inside(real(path.join(ROOT, '.runtime', '.cache')), inputPath)) fail('SHARED_INPUT_DIAGNOSTIC_INPUT_PATH')
    const input = read(inputPath)
    const syntheticBody = { model: registration.model.modelName, messages: input.messages,
      temperature: registration.model.temperature, max_tokens: registration.actualMaxTokens,
      enable_thinking: true, reasoning_effort: 'max', stream: true, stream_options: { include_usage: true } }
    assertSharedInputDiagnostic(registration, input, { arm: 'candidate', model: registration.model, body: syntheticBody, reserved: 0 })
    const prepared = args['--targets'] ? null : args['--mode'] === 'synthetic' && args['--baseline-root'] && args['--output']
      ? createProductionTargets(args['--baseline-root'], args['--output'], { development: true }) : fail('SHARED_INPUT_DIAGNOSTIC_TARGET_REQUIRED')
    const targets = prepared?.targets ?? read(args['--targets'])
    const original = targets.candidate
    if (!original || original.arm !== 'candidate' || args['--mode'] === 'real' && (original.developmentOnly || !original.modelId)) fail('SHARED_INPUT_DIAGNOSTIC_TARGET_INVALID')
    if (!original.developmentOnly) inspectTarget(original)
    const ledgerPath = args['--mode'] === 'real' ? validatePhysicalLedger(args['--physical-ledger'])
      : path.join(CACHE, `synthetic-ledger-shared-input-${randomUUID()}.jsonl`)
    const invocationId = randomUUID(), shortId = invocationId.slice(0, 8)
    const roots = Object.fromEntries(Object.entries(original.roots).map(([key, directory]) => [key, path.join(directory, shortId)]))
    const isolationRoot = path.join(original.isolationRoot, 'invocations', invocationId)
    for (const directory of [isolationRoot, ...Object.values(roots)]) {
      if (fs.existsSync(directory)) fail('INVOCATION_DIRECTORY_COLLISION')
      fs.mkdirSync(directory, { recursive: true })
    }
    if (args['--mode'] === 'real') copyIsolatedRealModelConfig(original, roots)
    const target = { ...original, isolationRoot, roots, declaredIsolationRoot: original.isolationRoot, declaredRoots: original.roots }
    const evidenceRoot = path.join(CACHE, `shared-input-${invocationId}`)
    fs.mkdirSync(evidenceRoot, { recursive: false })
    const common = { target, invocationId, mode: args['--mode'], phase: command, milestone: 'diagnostic',
      caseId: registration.caseIds[0], sceneId: '场景1', chapterNumber: 1, operations: registration.operations,
      protocolRevision: currentProtocolBinding().protocolRevision, protocolHash: currentProtocolBinding().protocolHash,
      semanticPath: path.join(ROOT, protocol.fixturePath), templatesPath: path.join(evidenceRoot, 'candidate-templates.json'),
      ledgerPath, evidenceRoot, driverHash: productionBridgeHash(), diagnosticInputPath: inputPath,
      diagnosticMessagesSha256: input.messagesSha256, diagnosticOriginalMessagesSha256: input.originalMessagesSha256,
      development: args['--mode'] === 'synthetic' }
    const result = withLedgerReconciliation(ledgerPath, args['--mode'], () => {
      const preparedReceipt = runProductionBridge({ ...common, action: 'prepare' })
      const executed = runProductionBridge({ ...common, action: 'execute', parityHash: preparedReceipt.physicalProject.parityHash })
      if (executed.attempts.length !== 1 || executed.physicalModelRequests + executed.syntheticDispatches !== 1)
        fail('SHARED_INPUT_DIAGNOSTIC_ONE_REQUEST_REQUIRED')
      return executed
    })
    return { status: 'diagnostic-only', qualityQualification: 'not-run', physicalModelRequests: result.physicalModelRequests,
      syntheticDispatches: result.syntheticDispatches, invocationId, inputPath, inputSha256: hash(fs.readFileSync(inputPath)),
      ledgerPath, evidenceRoot, receiptPath: result.receiptPath, outputPath: result.operations[0].outputPath,
      originalMessagesSha256: input.originalMessagesSha256, messagesSha256: input.messagesSha256,
      actual: result.attempts[0].binding.actual, finishReason: result.ownerTerminal.finishReason }
  }
  if (['freeze-targets', 'development-synthetic'].includes(command)) {
    if (!args['--baseline-root'] || !args['--output'] || args['--mode'] === 'real') fail('TARGET_PREPARATION_ARGUMENTS_REQUIRED')
    if (command === 'freeze-targets' && args['--scenario']) fail('INVALID_ARGUMENT')
    const prepared = createProductionTargets(args['--baseline-root'], args['--output'], { development: command === 'development-synthetic', modelId: args['--model-id'] })
    if (command === 'freeze-targets') return prepared
    // 零模型开发路径只跑已登记的场景；默认仍是 early-budget，逐字保持原有行为。
    // 它永远只产出 development-only-unfrozen 收据，不构成冻结目标资格。
    const phase = args['--scenario'] ?? 'early-budget'
    const scenario = productionScenario(phase, args['--milestone'] ?? PHASE_SCENARIOS[phase]?.milestone)
    if (!scenario) fail('PHASE_PRODUCTION_ADAPTER_NOT_INTEGRATED')
    const selection = selectPhase(protocol, phase, args['--milestone'] ?? scenario.milestone)
    assertScenarioMatchesProtocol(selection, scenario, path.join(ROOT, protocol.fixturePath))
    const developmentLedger = developmentLedgerPath(prepared.root, phase)
    if (fs.existsSync(developmentLedger)) fail('DEVELOPMENT_LEDGER_COLLISION')
    const result = withLedgerReconciliation(developmentLedger, 'synthetic', () => runProductionPhasePair(prepared.targets, { phase, development: true, mode: 'synthetic', milestone: selection.milestone,
      scenarioRevision: selection.scenarioRevision, selectionDifference: selection.selectionDifference, attemptPolicy: selection.attemptPolicy, evaluationPolicy: selection.evaluationPolicy, order: protocol.order,
      forwardReasoning: forwardReasoningFor(protocol, phase, selection.milestone),
      forwardQualificationWindow: forwardQualificationWindowFor(protocol, phase, selection.milestone),
      ...currentProtocolBinding(),
      semanticPath: path.join(ROOT, protocol.fixturePath), templatesPath: path.join(prepared.root, 'baseline-templates.json'), ledgerPath: developmentLedger }))
    fs.writeFileSync(path.join(prepared.root, `development-receipt-${phase}.json`), JSON.stringify(result, null, 2))
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
    const selection = selectPhase(protocol, phase, args['--milestone'] || PHASE_SCENARIOS[phase]?.milestone || 'early')
    const scenario = productionScenario(phase, selection.milestone)
    if (!scenario) return { status: 'blocked', code: 'PHASE_PRODUCTION_ADAPTER_NOT_INTEGRATED', selection, physicalModelRequests: 0 }
    assertScenarioMatchesProtocol(selection, scenario, path.join(ROOT, protocol.fixturePath))
    let diagnosticInputPath
    if (phase === 'bounded-revision-diagnostic') {
      if (!args['--diagnostic-input']) fail('BOUNDED_REVISION_INPUT_REQUIRED')
      diagnosticInputPath = real(args['--diagnostic-input'])
      if (!inside(real(path.join(ROOT, '.runtime/.cache')), diagnosticInputPath)) fail('BOUNDED_REVISION_INPUT_PATH')
      readBoundedRevisionSource(diagnosticInputPath)
    }
    const mode = command === 'dry-run' || args['--dry-run'] ? 'synthetic' : args['--mode']
    if (!['synthetic', 'real'].includes(mode)) fail('EXPLICIT_PROVIDER_MODE_REQUIRED')
    if (mode === 'real' && (!targets.baseline.modelId || !targets.candidate.modelId)) fail('FROZEN_SAFE_MODEL_REQUIRED')
    if ((mode === 'real') !== Boolean(args['--physical-ledger'])) fail('PHYSICAL_LEDGER_ARGUMENT_MISMATCH')
    const pairLedgerPath = mode === 'real' ? validatePhysicalLedger(args['--physical-ledger']) : null
    const evidenceRoot = fs.mkdtempSync(path.join(CACHE, `s07-${mode}-`))
    const ledgerPath = pairLedgerPath ?? path.join(evidenceRoot, 'synthetic-ledger.jsonl')
    // 真实或合成的成对执行失败时先对账：子进程被杀不会执行桥内结算，
    // 只有调用方还活着，这是保证每次发送都有终态的最后一道。
    const result = withLedgerReconciliation(ledgerPath, mode, () => runProductionPhasePair(targets, { phase, mode, milestone: selection.milestone,
      scenarioRevision: selection.scenarioRevision, selectionDifference: selection.selectionDifference, attemptPolicy: selection.attemptPolicy, evaluationPolicy: selection.evaluationPolicy, order: protocol.order,
      forwardReasoning: forwardReasoningFor(protocol, phase, selection.milestone),
      forwardQualificationWindow: forwardQualificationWindowFor(protocol, phase, selection.milestone),
      diagnosticInputPath,
      ...currentProtocolBinding(), semanticPath: path.join(ROOT, protocol.fixturePath),
      templatesPath: path.join(evidenceRoot, 'baseline-templates.json'), ledgerPath }))
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
export const exitCodeForStatus = status => status === 'blocked' ? 2 : status === 'failed' ? 1
  : ['pending-independent-oracle-review', 'pending-independent-diagnostic-oracle-review'].includes(status) ? 3 : 0
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = main(process.argv.slice(2)); console.log(JSON.stringify(result, null, 2)); process.exitCode = exitCodeForStatus(result.status) }
  catch (error) { console.error(JSON.stringify({ status: 'blocked', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_OR_UNAVAILABLE_INPUT', physicalModelRequests: null, note: 'Inspect the retained campaign/target receipts; no unverified zero-call claim.' })); process.exitCode = 2 }
}
