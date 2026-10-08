import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { test } from 'vitest'
import { createOperationDispatchGate, draftRecoveryState, structuredRecoveryState, structuredRequestRange,
  productionScenario, PHASE_SCENARIOS } from '../quality-modernization-driver.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const policy = productionScenario('early-budget', 'post-ui').attemptPolicy
const draft = policy.draftRecovery
const owner = (purpose, index, extra = {}) => ({ attemptId: `a${index}`, runId: 'run', rootActionId: 'root',
  projectId: 'project', epoch: 'epoch', purpose, ...extra })
const reply = (purpose, output, finishReason = 'stop') => ({ purpose, output, finishReason })
const replayDraft = (values, extra = {}) => draftRecoveryState(values, { policy: draft, targetUnits: 900,
  arm: 'candidate', ...extra }, value => value)
const initial = (finish = 'stop') => reply('chapter-draft', '甲'.repeat(500), finish)
const continuation = (count = 400, finish = 'stop') => reply('chapter-draft-continuation', '乙'.repeat(count), finish)

test('short stop and length allow existing continuation; a normal in-range stop does not', () => {
  for (const finish of ['stop', 'length']) {
    assert.deepEqual(replayDraft([initial(finish)]).next, ['chapter-draft-continuation'])
    assert.equal(replayDraft([initial(finish), continuation()]).complete, true)
  }
  assert.throws(() => replayDraft([reply('chapter-draft', '甲'.repeat(900)), continuation()]), /SEQUENCE_INVALID/)
  assert.throws(() => replayDraft([initial('content_filter'), continuation()]), /UNSETTLED/)
})

test('one no-progress length recovery discards duplicate bytes; repeated no-progress exhausts', () => {
  const duplicate = reply('chapter-draft-continuation', '甲'.repeat(500), 'length')
  const first = replayDraft([initial('length'), duplicate])
  assert.equal(first.text, '甲'.repeat(500))
  assert.deepEqual(first.next, ['chapter-draft-no-progress-recovery'])
  assert.equal(replayDraft([initial('length'), duplicate, reply('chapter-draft-no-progress-recovery', '乙'.repeat(400))]).complete, true)
  const failed = replayDraft([initial('length'), duplicate, reply('chapter-draft-no-progress-recovery', '甲'.repeat(500), 'length')])
  assert.equal(failed.complete, false)
  assert.deepEqual(failed.next, [])
  assert.throws(() => replayDraft([initial(), reply('chapter-draft-no-progress-recovery', '乙'.repeat(400))]), /SEQUENCE_INVALID/)
})

test('continuation then one compression binds final visible replacement; baseline retains its original thresholds', () => {
  const values = [initial(), continuation(900)]
  assert.deepEqual(replayDraft(values).next, ['chapter-draft-condense'])
  const condensed = reply('chapter-draft-condense', '<think>hidden</think>' + '丙'.repeat(900))
  const result = replayDraft([...values, condensed])
  assert.equal(result.complete, true)
  assert.equal(result.text, '丙'.repeat(900))
  assert.throws(() => replayDraft([...values, condensed, condensed]), /SEQUENCE_INVALID/)
  assert.throws(() => replayDraft([...values, condensed], { arm: 'baseline' }), /SEQUENCE_INVALID/)
  assert.deepEqual(replayDraft([reply('chapter-draft', '甲'.repeat(650))], { arm: 'baseline' }).next, ['chapter-draft-continuation'])
  assert.deepEqual(replayDraft([reply('chapter-draft', '甲'.repeat(650))]).next, [])
  const overlong = [...values, reply('chapter-draft-condense', '丙'.repeat(1300))]
  const current = { protocolRevision: 's14b-candidate-only-three-rounds-v1' }
  assert.equal(replayDraft(overlong, current).complete, true)
  assert.equal(replayDraft(overlong).complete, false)
  assert.equal(replayDraft(values, current).complete, false)
  assert.throws(() => replayDraft([...values, reply('chapter-draft-condense', '丙'.repeat(1300), 'length')], current), /CONDENSE_INCOMPLETE/)
})

test('existing eight-attempt root budget includes reconcile; exhausted output cannot authorize another send', () => {
  const values = [initial('length'), ...Array.from({ length: 6 }, (_, index) =>
    reply('chapter-draft-continuation', String.fromCharCode(0x4e10 + index).repeat(300), 'length'))]
  assert.deepEqual(replayDraft(values, { arm: 'baseline', reconcileCount: 1 }).next, [])
  assert.throws(() => replayDraft([...values, continuation()], { arm: 'baseline', reconcileCount: 1 }), /SEQUENCE_INVALID/)
})

test('low-progress stop may cross the upper bound: dispatch and receipt replay agree on one compression', () => {
  const values = [reply('chapter-draft', '甲'.repeat(1050), 'length'), continuation(200)]
  assert.deepEqual(replayDraft(values).next, ['chapter-draft-condense'])
  assert.equal(replayDraft([...values, reply('chapter-draft-condense', '丙'.repeat(900))]).complete, true)
  assert.deepEqual(replayDraft([initial('length'), continuation(200)]).next, [])
  const duplicate = reply('chapter-draft-continuation', '甲'.repeat(500), 'length')
  const exhausted = [initial('length'), duplicate, reply('chapter-draft-no-progress-recovery', '甲'.repeat(500), 'length')]
  assert.deepEqual(replayDraft(exhausted).next, [])
  assert.throws(() => replayDraft([...exhausted, reply('chapter-draft-condense', '丙'.repeat(900))]), /SEQUENCE_INVALID/)
})

test('dispatch requires settled immutable evidence and same run/root/project/epoch before reserve', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.runtime/.cache/h5-gate-'))
  try {
    const first = owner('chapter-draft', 0), next = owner('chapter-draft-continuation', 1)
    const outputPath = path.join(dir, 'first.txt'), output = '甲'.repeat(500)
    fs.writeFileSync(outputPath, output)
    const attemptId = `candidate:${first.attemptId}`, binding = { operation: '900单位正文', actual: first }
    const evidence = { attempt: { attemptId, binding, outputPath, visibleTextHash: hash(output) }, ownerArtifactHash: hash(output),
      events: [{ type: 'reserve', attemptId, binding }, { type: 'dispatch', attemptId }, { type: 'settle', attemptId, finishReason: 'stop' }] }
    const create = (proof = evidence) => createOperationDispatchGate({ draftRecovery: { policy: draft, arm: 'candidate', targetUnits: 900 },
      readPrimaryEvidence: () => proof })
    const gate = create(); gate('900单位正文', first); gate('900单位正文', next)
    for (const key of ['runId', 'rootActionId', 'projectId', 'epoch', 'attemptId']) {
      const changed = create(); changed('900单位正文', first)
      assert.throws(() => changed('900单位正文', { ...next, [key]: key === 'attemptId' ? first.attemptId : 'different' }), /MODEL_REQUEST_REJECTED/)
    }
    for (const proof of [{ ...evidence, events: evidence.events.slice(0, 2) }, { ...evidence, ownerArtifactHash: hash('wrong') }]) {
      const changed = create(proof); changed('900单位正文', first)
      assert.throws(() => changed('900单位正文', next), /MODEL_REQUEST_REJECTED/)
    }
    fs.appendFileSync(outputPath, '改')
    const changed = create(); changed('900单位正文', first)
    assert.throws(() => changed('900单位正文', next), /MODEL_REQUEST_REJECTED/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

const blueprint = number => ({ chapterNumber: number, title: '章节', role: '开篇', purpose: '寻找证据', keyEvents: '发现线索',
  characters: ['林澄'], relationships: [], suspenseHook: '日期错位', userGuidance: '' })
const structured = (range, values, purpose = 'chapter-blueprint-directory', finishReason = 'stop') => ({ structuredRange: range,
  purpose, output: JSON.stringify({ blueprints: values }), finishReason })
const replayStructure = (attempts, range = [1]) => structuredRecoveryState(attempts, { chapterNumbers: range }, value => value)

test('existing one-to-five chapter directories preserve the request range, raw bytes and order', () => {
  for (let count = 1; count <= 5; count++) {
    const range = Array.from({ length: count }, (_, index) => index + 3)
    const attempt = structured(range, range.map(blueprint)), before = JSON.stringify(attempt)
    const requested = []
    const options = { chapterNumbers: range, decode: (output, scope) => {
      requested.push({ output, scope: [...scope] })
    } }
    assert.deepEqual(structuredRecoveryState([], options, value => value).next,
      { range, purpose: 'chapter-blueprint-directory' })
    assert.equal(structuredRecoveryState([attempt], options, value => value).complete, true)
    assert.deepEqual(requested, [{ output: attempt.output, scope: range }])
    assert.equal(JSON.stringify(attempt), before)
  }
})

test('complete long blueprint is accepted and truncated blueprint retains its original bytes during compact recovery', () => {
  const over = { ...blueprint(1), keyEvents: '超'.repeat(1201) }
  assert.equal(replayStructure([structured([1], [over])]).complete, true)
  const failed = structured([1], [over], 'chapter-blueprint-directory', 'length'), original = failed.output
  assert.deepEqual(replayStructure([failed]).next, { range: [1], purpose: 'chapter-blueprint-directory:compact-single:chapter-1' })
  const replacement = structured([1], [blueprint(1)], 'chapter-blueprint-directory:compact-single:chapter-1')
  assert.equal(replayStructure([failed, replacement]).complete, true)
  assert.equal(failed.output, original)
  assert.throws(() => replayStructure([failed, { ...replacement, output: failed.output, finishReason: 'length' }]), /EXHAUSTED/)
  assert.throws(() => replayStructure([structured([1], [blueprint(1)]), replacement]), /SEQUENCE_INVALID/)
})

test('multi-chapter failures split depth-first within production maxCalls and reject wrong range/order', () => {
  const bad = structured([1, 2, 3], [], 'chapter-blueprint-directory', 'length')
  const first = structured([1], [blueprint(1)]), second = structured([2, 3], [blueprint(2), blueprint(3)])
  assert.equal(replayStructure([bad], [1, 2, 3]).maxCalls, 9)
  assert.equal(replayStructure([bad, first, second], [1, 2, 3]).complete, true)
  assert.throws(() => replayStructure([bad, second, first], [1, 2, 3]), /SEQUENCE_INVALID/)
  assert.throws(() => replayStructure([bad, first, second, second], [1, 2, 3]), /SEQUENCE_INVALID/)
})

test('syntax repair preserves evidence and request ranges are parsed from actual product prompts', () => {
  const complete = structured([1], [blueprint(1)])
  const malformed = { ...complete, output: complete.output.slice(0, -1) }
  assert.equal(replayStructure([malformed]).next.purpose, 'chapter-blueprint-directory:structured-syntax-repair')
  const repair = { ...complete, purpose: 'chapter-blueprint-directory:structured-syntax-repair' }
  assert.equal(replayStructure([malformed, repair]).complete, true)
  assert.throws(() => replayStructure([malformed, { ...repair, output: repair.output.replace('发现线索', '凭空改写') }]), /EVIDENCE_CHANGED/)
  assert.deepEqual(structuredRequestRange('生成第1章到第3章', 'chapter-blueprint-directory'), [1, 2, 3])
  assert.deepEqual(structuredRequestRange('本次必须且只能完整返回以下 chapterNumber：2、3。', repair.purpose), [2, 3])
  assert.deepEqual(structuredRequestRange('', 'chapter-blueprint-directory:compact-single:chapter-3'), [3])
  assert.throws(() => structuredRequestRange('没有范围', 'chapter-blueprint-directory'), /RANGE_MISSING/)
  assert.equal(PHASE_SCENARIOS.full.attemptPolicy.structuredRecovery.maxCompactFallbacksPerChapter, 1)
})
