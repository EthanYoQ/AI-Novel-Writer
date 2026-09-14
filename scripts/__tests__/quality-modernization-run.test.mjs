import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, CAP, hash, buildFixtureExports, validatePair, selectPhase, updateLedger, main, inspectTarget, freezeEnvironment, fixedStartup, validateFrozenExecution, runnerAdapterHash } from '../quality-modernization-run.mjs'
import { COMMAND_PROBES } from '../quality-modernization-driver.mjs'

const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/novel-quality-modernization/semantic-source.json')))
const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')))
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
  assert.equal(receipt.negativeCases, 15)
})
function pair() {
  const exports = buildFixtureExports(source)
  return { targets: { baseline: { arm: 'baseline', codeSha: 'a'.repeat(40), fixture: exports.legacy }, candidate: { arm: 'candidate', codeSha: 'b'.repeat(40), subjectSha: 'b'.repeat(40), fixture: exports.canonical } }, observed: [{ sourceHash: 'a', repositoryRoot: '/甲', roots: ['/甲数据'] }, { sourceHash: 'b', repositoryRoot: '/乙', roots: ['/乙数据'] }] }
}
test('help不触文件、模型或启动目标；参数拒绝', () => {
  assert.equal(main(['help']).physicalModelRequests, 0)
  assert.throws(() => main(['full', '--execute', 'yes']), /INVALID_ARGUMENT/)
})
test('三乘三两臂与原80帽含post-UI备份预留', () => {
  assert.equal(source.scenes.length, 3)
  assert.equal(source.scenes.flatMap(s => s.chapters).length * 2, 18)
  assert.equal(Object.values(protocol.allocation).reduce((a, b) => a + b, 0), CAP)
  for (const phase of ['early-budget', 'early-context', 'early-review']) assert.equal(selectPhase(protocol, phase, 'post-ui').milestone, 'post-ui')
  assert.equal(selectPhase(protocol, 'full', 'final').caseIds.length, 9)
  assert.equal(protocol.phases['early-budget'].operations.reduce((n, op) => n + op.minimumCalls, 0), 4)
  assert.equal(protocol.allocation.postUiBudget, 4)
  assert.throws(() => selectPhase(protocol, 'full', 'early'), /MISMATCH/)
  assert.ok(source.deterministicCases.C16.length >= 10 && source.deterministicCases.C17.length >= 10)
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
test('账本未知不释放、重试新attempt、80帽、重复/并发/残记录拒绝', () => {
  const parent = path.join(ROOT, '.runtime/.cache/novel-quality-modernization')
  fs.mkdirSync(parent, { recursive: true })
  const dir = fs.mkdtempSync(path.join(parent, 'ledger-test-'))
  const file = path.join(dir, 'ledger.jsonl')
  const binding = { arm: 'baseline', codeSha: 'a'.repeat(40), parityId: 'b'.repeat(64) }
  try {
    updateLedger(file, { type: 'reserve', attemptId: '取消前', binding })
    updateLedger(file, { type: 'cancel', attemptId: '取消前' })
    for (let i = 0; i < CAP; i++) {
      updateLedger(file, { type: 'reserve', attemptId: `请求${i}`, binding })
      updateLedger(file, { type: 'dispatch', attemptId: `请求${i}` })
      updateLedger(file, { type: i === 0 ? 'unknown' : 'settle', attemptId: `请求${i}` })
    }
    assert.throws(() => updateLedger(file, { type: 'reserve', attemptId: '超额', binding }), /CAP_EXHAUSTED/)
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
