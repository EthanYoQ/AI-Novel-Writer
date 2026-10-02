import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it, vi } from 'vitest'
vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
import { assertShortOutlineRecovery, generate, prepare } from '../draft-generation-startup-acceptance.mjs'
import { countDraftUnits, draftTargetUnitRange } from '../../src/shared/draft-units'

const hash = text => createHash('sha256').update(text).digest('hex')
const expected = { artifactId: 'outline-artifact', text: '先走到灯塔，再询问守塔人。', promptHash: hash('outline-input'),
  initialDraftTask: { purpose: 'chapter-draft', output: 'visible-text', messages: [
    { role: 'system', content: '原系统提示' }, { role: 'user', content: '原正文和细纲组合提示' },
  ] } }
const recovery = () => ({ attemptedPurposes: ['chapter-draft-short-outline', 'chapter-draft'], draftShortOutline: {
  artifactIds: [expected.artifactId], completedOutput: expected.text, promptHash: expected.promptHash,
  initialDraftTask: structuredClone(expected.initialDraftTask),
} })

it('reopen evidence rejects missing or changed persisted outline identity', () => {
  assertShortOutlineRecovery(recovery(), expected, true)
  for (const mutate of [
    value => { delete value.draftShortOutline },
    value => { value.draftShortOutline.artifactIds = ['replacement'] },
    value => { value.draftShortOutline.completedOutput += '新增计划' },
    value => { value.draftShortOutline.promptHash = hash('changed-input') },
    value => { value.attemptedPurposes.push('chapter-draft-short-outline') },
  ]) {
    const value = recovery(); mutate(value)
    assert.throws(() => assertShortOutlineRecovery(value, expected, true))
  }
})

it('prose execution consumes the exact recovered task and composes only the prose artifact on the same root', async () => {
  const previousWindow = globalThis.window
  const handle = { runId: 'run', rootActionId: 'original-root' }
  const prose = Array.from({ length: 80 }, (_, index) => `林岚数到第${index + 1}块青石，仍能看见灯塔上的微光。`).join('\n')
  let physicalRequests = 2
  const calls = []
  globalThis.window = { aiNovelAPI: { invoke: async (channel, ...args) => {
    calls.push(channel)
    if (channel === 'generation:execute') {
      assert.deepEqual(args[0].task, expected.initialDraftTask)
      assert.deepEqual(args[0].handle, handle)
      return { outcome: { finishReason: 'length', receipt: { visibleArtifact: { artifactId: 'prose' } } }, run: { handle, ledger: { physicalRequests }, artifacts: [
        { artifactId: 'prose', status: 'failed', compositionEligible: true },
      ] } }
    }
    if (channel === 'generation:compose-visible') {
      assert.deepEqual(args.slice(0, 4), [handle, ['prose'], hash(prose), 'draft-visible-v1'])
      return { text: prose, textHash: hash(prose) }
    }
    assert.equal(channel, 'generation:read-context')
    return recovery()
  } } }
  try {
    const page = { evaluate: (callback, input) => callback(input) }
    assert.deepEqual(await generate(page, {}, { handle, expected, chapterNumber: 1 }), {
      handle, expectedCompositionHash: hash(prose), chapterNumber: 1, source: 'write',
    })
    assert.deepEqual(calls, ['generation:execute', 'generation:compose-visible', 'generation:read-context'])
    physicalRequests = 1
    await assert.rejects(generate(page, {}, { handle, expected, chapterNumber: 1 }))
  } finally { globalThis.window = previousWindow }
})

it('reopen evidence requires the original full draft task only after prose starts', () => {
  const before = recovery()
  before.attemptedPurposes.pop()
  delete before.draftShortOutline.initialDraftTask
  assertShortOutlineRecovery(before, expected, false)
  assert.throws(() => assertShortOutlineRecovery(before, expected, true))
  for (const mutate of [
    task => { task.messages[0].content += 'changed' },
    task => { task.messages[1].content += 'changed' },
    task => { task.reasoningStage = 'planning' },
  ]) {
    const value = recovery(); mutate(value.draftShortOutline.initialDraftTask)
    assert.throws(() => assertShortOutlineRecovery(value, expected, true))
  }
})

it('startup preparation consumes captured sources through production material and outline helpers', async () => {
  const previousWindow = globalThis.window
  const prepared = { preparationId: 'prepared-native-context', knowledgeSnapshot: { items: [
    { documentId: 'knowledge-native-id', fileName: '灯塔.md', score: 1, text: '灯塔在北岸。' },
  ] }, selectedDrafts: [{ draftId: 7, chapterNumber: 1, version: 3, content: '林岚走到北岸。', contentHash: hash('林岚走到北岸。') }] }
  globalThis.window = { aiNovelAPI: { invoke: async channel => {
    assert.equal(channel, 'generation:prepare-draft-context')
    return prepared
  } } }
  try {
    const result = await prepare({ evaluate: (callback, input) => callback(input) },
      { projectId: 'project', leaseId: 'lease' }, 2, [7])
    assert.equal(result.selection.preparationId, prepared.preparationId)
    const decision = result.selection.materialDecision
    assert.equal(decision.promptHash, hash(result.sourcePrompt))
    assert.equal(decision.shortOutlinePromptHash, hash(result.outlineTask.messages[0].content))
    assert.equal(result.outlineTask.purpose, 'chapter-draft-short-outline')
    assert.ok(decision.included.some(item => item.sourceId === 'candidate:7' && item.revision === 3 && item.required))
    assert.ok(decision.included.some(item => item.sourceId === 'author:required'))
    assert.ok(decision.included.some(item => item.sourceId === 'reference:0'))
    assert.ok(result.sourcePrompt.includes('林岚走到北岸。'))
    assert.ok(result.sourcePrompt.includes('灯塔在北岸。'))
    const fixtureProse = Array.from({ length: 80 }, (_, index) => `林岚数到第${index + 1}块青石，仍能看见灯塔上的微光。`).join('\n')
    const target = Number(result.selection.authorInputs.find(input => input.id === 'draft:target-units').text)
    assert.ok(countDraftUnits(fixtureProse) <= draftTargetUnitRange(target).maximum, 'synthetic prose must pass the unchanged production length gate')
  } finally { globalThis.window = previousWindow }
})
