import { afterEach, expect, it, vi } from 'vitest'
import { runFinalizationGeneration } from '../finalization-generation'
const session = { projectId: '项目', leaseId: '会话', projectPath: 'C:/合成定稿' }
const source = { finalizationId: '定稿', draftId: 1, chapterNumber: 1, contentHash: 'a'.repeat(64) }
const slot = { source, stepKey: 'chapter_notes' as const }
const handle = { projectId: '项目', epoch: '原会话', rootActionId: '原根', runId: '原运行' }
const candidate = { ...handle, artifactId: '原候选', revision: 3, textHash: 'b'.repeat(64), text: '原要点', status: 'completed', compositionEligible: true }
const view = { handle, artifacts: [candidate], status: 'completed', ledger: { physicalRequests: 1 } }
const stored = { view, attemptCount: 1, modelId: '原模型', context: { slot }, sourceStatus: 'current' }
const effect = { success: true, stepKey: 'chapter_notes', chapterNotes: '原要点', factCount: 1, blueprintUpdated: true }
afterEach(() => vi.unstubAllGlobals())
function setup(invoke: ReturnType<typeof vi.fn>) { vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } }); return { session, slot, modelId: vi.fn(() => '新模型'), cancelled: () => false } }
it('已 ACK effect 只读回放，不解析模型或重做正式写入', async () => {
 const invoke = vi.fn(async () => ({ ...stored, sourceStatus: 'conflict', effect }))
 const options = setup(invoke)
 await expect(runFinalizationGeneration(options)).resolves.toEqual(effect)
 expect(options.modelId).not.toHaveBeenCalled()
 expect(invoke.mock.calls).toHaveLength(1)
})
it('原完整候选仅提交原 artifact，不重建 task/model/预算', async () => {
 const invoke = vi.fn(async (channel: string, request: unknown) => {
  if (channel === 'finalization-generation:read') return stored
  expect(channel).toBe('finalization-generation:commit')
  expect(request).toEqual({ handle, artifact: { artifactId: candidate.artifactId, revision: 3, textHash: candidate.textHash } })
  return effect
 })
 const options = setup(invoke)
 await expect(runFinalizationGeneration(options)).resolves.toEqual(effect)
 expect(options.modelId).not.toHaveBeenCalled()
})
it.each(['unknown', 'failed'])('%s 原角色候选不可重发或提交', async status => {
 const characterSlot = { ...slot, stepKey: 'character_cards' as const }
 const invoke = vi.fn(async () => ({ ...stored, context: { slot: characterSlot }, view: { ...view, artifacts: [{ ...candidate, status, compositionEligible: false }] } }))
 await expect(runFinalizationGeneration({ ...setup(invoke), slot: characterSlot })).rejects.toThrow('FINALIZATION_GENERATION_ARTIFACT_REQUIRED')
 expect(invoke).toHaveBeenCalledTimes(1)
})
it('旧角色坏 JSON stop 候选交由 main 有界修复，仅提交最后有效候选', async () => {
 const characterSlot = { ...slot, stepKey: 'character_cards' as const }
 const repaired = { ...candidate, artifactId: '修复候选', text: '{"updates":[]}', textHash: 'c'.repeat(64) }
 const characterEffect = { success: true, stepKey: 'character_cards' }
 const invoke = vi.fn(async (channel: string, request: unknown) => {
  if (channel === 'finalization-generation:read') return { ...stored, context: { slot: characterSlot }, view: { ...view, artifacts: [{ ...candidate, text: '{bad' }] } }
  if (channel === 'finalization-generation:execute') return { run: { ...view, artifacts: [candidate, repaired] }, outcome: { status: 'completed', finishReason: 'stop' } }
  expect(channel).toBe('finalization-generation:commit')
  expect(request).toEqual({ handle, artifact: { artifactId: repaired.artifactId, revision: repaired.revision, textHash: repaired.textHash } })
  return characterEffect
 })
 const options = { ...setup(invoke), slot: characterSlot }
 await expect(runFinalizationGeneration(options)).resolves.toEqual(characterEffect)
 expect(options.modelId).not.toHaveBeenCalled()
 expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['finalization-generation:read', 'finalization-generation:execute', 'finalization-generation:commit'])
})
it('仅缺失 slot 才 begin；实际新请求不携带 renderer facts/task', async () => {
 const invoke = vi.fn(async (channel: string, request: unknown) => {
  if (channel === 'finalization-generation:read') return null
  if (channel === 'finalization-generation:begin') { expect(request).toEqual({ slot, modelId: '新模型' }); return { ...stored, attemptCount: 0, view: { ...view, artifacts: [], ledger: { physicalRequests: 9 } } } }
  if (channel === 'finalization-generation:execute') { expect(request).toEqual({ handle }); return { run: view, outcome: { status: 'completed', finishReason: 'stop' } } }
  if (channel === 'finalization-generation:commit') return effect
  throw new Error(channel)
 })
 await expect(runFinalizationGeneration(setup(invoke))).resolves.toEqual(effect)
 expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['finalization-generation:read', 'finalization-generation:begin', 'finalization-generation:execute', 'finalization-generation:commit'])
})
it('取消晚到 begin 会取消原 main run，不执行', async () => {
 let cancelled = false
 const invoke = vi.fn(async (channel: string) => {
  if (channel === 'finalization-generation:read') return null
  if (channel === 'finalization-generation:begin') { cancelled = true; return stored }
  if (channel === 'finalization-generation:cancel') return view
  throw new Error(channel)
 })
 await expect(runFinalizationGeneration({ ...setup(invoke), cancelled: () => cancelled })).rejects.toThrow('GENERATION_WORKFLOW_CANCELLED')
 expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['finalization-generation:read', 'finalization-generation:begin', 'finalization-generation:cancel'])
})
it('提交失败后同 slot 重试仅提交原候选，不消耗新请求', async () => {
 let commits = 0
 const invoke = vi.fn(async (channel: string) => {
  if (channel === 'finalization-generation:read') return stored
  if (channel === 'finalization-generation:commit') { if (++commits === 1) throw new Error('synthetic-write-failure'); return effect }
  throw new Error(channel)
 })
 const options = setup(invoke)
 await expect(runFinalizationGeneration(options)).rejects.toThrow('synthetic-write-failure')
 await expect(runFinalizationGeneration(options)).resolves.toEqual(effect)
 expect(options.modelId).not.toHaveBeenCalled()
 expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['finalization-generation:read', 'finalization-generation:commit', 'finalization-generation:read', 'finalization-generation:commit'])
})
it('即使有 ACK 也拒绝串用别的 finalization source', async () => {
 const invoke = vi.fn(async () => ({ ...stored, context: { slot: { ...slot, source: { ...source, finalizationId: '别的定稿' } } }, effect }))
 await expect(runFinalizationGeneration(setup(invoke))).rejects.toThrow('FINALIZATION_GENERATION_IDENTITY_MISMATCH')
 expect(invoke).toHaveBeenCalledTimes(1)
})
