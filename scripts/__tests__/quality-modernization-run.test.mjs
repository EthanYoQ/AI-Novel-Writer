import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { ROOT, PLANNED_CALL_ALLOCATION, CAMPAIGN_ID, campaignIdFor, hash, buildFixtureExports, validatePair, selectPhase, updateLedger, main, inspectTarget, freezeEnvironment, fixedStartup, validateFrozenExecution, runnerAdapterHash, assertCommittedProductionFiles } from '../quality-modernization-run.mjs'
import { COMMAND_PROBES, selectOwnerDispatch, productionBridgeHash, PHASE_SCENARIOS, createAttemptSupervisor, measurePromptBytes, BRIDGE_SETTLEMENT_DEADLINE_MS } from '../quality-modernization-driver.mjs'
import Database from 'better-sqlite3'

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
  assert.equal(Object.values(protocol.allocation).reduce((a, b) => a + b, 0), protocol.plannedCallAllocation)
  for (const phase of ['early-budget', 'early-context', 'early-review']) assert.equal(selectPhase(protocol, phase, 'post-ui').milestone, 'post-ui')
  assert.equal(selectPhase(protocol, 'full', 'final').caseIds.length, 9)
  assert.equal(protocol.phases['early-budget'].operations.reduce((n, op) => n + op.minimumCalls, 0), 4)
  assert.equal(protocol.allocation.postUiBudget, 4)
  // 生产桥只接线已登记的场景；每个场景的 caseId 与 operation id 必须逐字等于协议。
  for (const phase of ['early-budget', 'early-context']) {
    assert.equal(PHASE_SCENARIOS[phase].caseId, protocol.phases[phase].caseIds[0])
    assert.deepEqual(PHASE_SCENARIOS[phase].operations.map(operation => operation.id),
      protocol.phases[phase].operations.map(operation => operation.id))
  }
  assert.equal(PHASE_SCENARIOS['early-review'], undefined)
  assert.equal(PHASE_SCENARIOS.full, undefined)
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

test('campaign保留后续阶段额度，unknown与修复占原22余量且不能换账', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/campaign-test-'))
  const file = path.join(dir, 'synthetic-ledger.jsonl')
  const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'baseline', codeSha: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64), phase: 'early-budget', milestone: 'early', caseId: '场景1/1', operation: '指定范围生成' }
  const record = event => updateLedger(file, event, { campaignMode: 'synthetic' })
  const issue = (id, value = binding) => { record({ type: 'reserve', attemptId: id, binding: value }); record({ type: 'dispatch', attemptId: id }); record({ type: 'unknown', attemptId: id }) }
  try {
    issue('first')
    for (let i = 0; i < 22; i++) issue(`repair${i}`)
    assert.throws(() => issue('steals-future-capacity'), /ALLOCATION_EXHAUSTED/)
    issue('still-available-primary-draft', { ...binding, operation: '900单位正文' })
    issue('still-available-post-ui', { ...binding, milestone: 'post-ui' })
    assert.throws(() => updateLedger(path.join(dir, 'other-real.jsonl'), { type: 'reserve', attemptId: 'new', binding: { ...binding, mode: 'real' } }, { campaignMode: 'real' }), /PATH_MISMATCH/)
    assert.throws(() => record({ type: 'cancel', attemptId: 'first' }), /TRANSITION/)
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(rows.filter(row => row.allocation === 'failedRetryRepairReviewReserve').length, 22)
    rows[0].allocation = 'postUiBudget'; fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n')
    assert.throws(() => record({ type: 'reserve', attemptId: 'tampered', binding }), /ALLOCATION_MISMATCH/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('early-context 按协议取 caseId/operation，额度走 earlyContext/postUiContext', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/context-campaign-test-'))
  const file = path.join(dir, 'synthetic-ledger.jsonl')
  const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'baseline', codeSha: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
    phase: 'early-context', milestone: 'early', caseId: '场景2/2', operation: '长设定第二章正文' }
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
    assert.throws(() => record({ type: 'reserve', attemptId: 'wrong-phase', binding: { ...binding, phase: 'full', caseId: '场景2/2' } }), /INVALID_CAMPAIGN_BINDING/)
    assert.throws(() => record({ type: 'reserve', attemptId: 'wrong-early-budget-op', binding: { ...binding, phase: 'early-budget', caseId: '场景1/1', operation: '长设定第二章正文' } }), /INVALID_CAMPAIGN_BINDING/)
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

test('超时守护为已 dispatch 的发送补写 unknown：只写一次、绝不退款、不伪造未发送', async () => {
  // 桥测试的 120s 超时是进程内计时器：不投信号、不跑 finally。供应商卡住时，
  // 「等流结束再写终态」永远等不到，账本只剩 reserve+dispatch。守护必须自己到点收尾。
  const dir = fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/guard-test-'))
  const file = path.join(dir, 'synthetic-ledger.jsonl')
  const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'baseline', codeSha: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64), driverHash: productionBridgeHash(), parityId: 'c'.repeat(64),
    phase: 'early-context', milestone: 'early', caseId: '场景2/2', operation: '长设定第二章正文' }
  try {
    const record = event => updateLedger(file, event, { campaignMode: 'synthetic' })
    const supervisor = createAttemptSupervisor({ record, deadlineMs: 50 })
    const stalled = new AbortController()
    // 取消发生在 dispatch 之前的预留：它必须保持「未发送」，不被守护伪造成已发送。
    record({ type: 'reserve', attemptId: 'cancelled-before-dispatch', binding })
    record({ type: 'cancel', attemptId: 'cancelled-before-dispatch' })
    record({ type: 'reserve', attemptId: 'stalled', binding })
    record({ type: 'dispatch', attemptId: 'stalled' })
    supervisor.watch('stalled', stalled)
    assert.equal(supervisor.openAttempts(), 1)
    // 供应商卡住：这里什么都不 resolve，只有守护到点。等待远超过期时间。
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(supervisor.expired(), true)
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(rows.filter(row => row.attemptId === 'stalled').map(row => row.type), ['reserve', 'dispatch', 'unknown'])
    assert.equal(supervisor.openAttempts(), 0)
    // 先把 unknown 落账，再 abort 让等待方失败。
    assert.equal(stalled.signal.aborted, true)
    // 幂等：晚到的终态不能改写同一次发送，也不能再多落一行。
    const before = fs.readFileSync(file, 'utf8')
    assert.equal(supervisor.terminal('stalled', 'settle', { finishReason: 'stop' }), false)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    // dispatch 过的发送只能是 settle/unknown：不能取消释放，也不能重开同一 attempt。
    assert.throws(() => record({ type: 'cancel', attemptId: 'stalled' }), /TRANSITION/)
    assert.throws(() => record({ type: 'reserve', attemptId: 'stalled', binding }), /INVALID_RESERVATION/)
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
  // 守护预算必须短于桥测试超时，否则超时仍会先杀进程。
  const driver = fs.readFileSync(path.join(ROOT, 'scripts/quality-modernization-driver.mjs'), 'utf8')
  const bridgeTimeoutMs = Number(/testTimeout:\s*(\d+)/.exec(driver)[1])
  const fixtureTimeoutMs = Number(/test\([\s\S]*\},\s*([\d_]+)\)$/.exec(fixture.trim())[1].replace(/_/g, ''))
  assert.ok(Number.isFinite(bridgeTimeoutMs) && Number.isFinite(fixtureTimeoutMs))
  assert.ok(BRIDGE_SETTLEMENT_DEADLINE_MS < bridgeTimeoutMs && BRIDGE_SETTLEMENT_DEADLINE_MS < fixtureTimeoutMs,
    `守护预算 ${BRIDGE_SETTLEMENT_DEADLINE_MS} 必须短于桥超时 ${bridgeTimeoutMs}/${fixtureTimeoutMs}`)
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
