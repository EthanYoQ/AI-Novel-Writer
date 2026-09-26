import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { MAIN_GENERATION_POLICY } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { getProjectDb } from '../../database'
import { textHash } from '../../repositories/generation-run-repository'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import type { MainGenerationExecuteReceipt } from '../../../src/services/generation/generation-runtime'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const prose = '林岚走进了北塔。'

function fixture(dispatch?: GenerationRunServiceDependencies['dispatch']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/finalization-generation-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  prepareCanonicalStorageFixture(root)
  let db = new Database(path.join(root,'.ai-novel','project.db'))
  vi.mocked(getProjectDb).mockReturnValue(db)
  db.exec("INSERT INTO characters(name,character_id,cs_provenance) VALUES('林岚','character-lan','{}')")
  db.exec("INSERT INTO project_core(id,project_name) VALUES('main','合成定稿'); INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔'); INSERT INTO contents(id,body) VALUES(1,'旧稿'); INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,2)")
  FinalizationRepository.commit({ finalizationId: 'finalized-1', draftId: 1, chapterNumber: 1, chapterTitle: '北塔',
    content: prose, contentHash: textHash(prose), contentRevision: 1, targetFileName: '第一章.txt' })
  const characterId = db.prepare("SELECT character_id FROM characters WHERE name='林岚'").pluck().get() as string
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
    apiKey: 'synthetic-fixture-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'],
    capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const response = (updates = [{ characterId, currentState: { location: '北塔' }, evidence: { start: 0, end: prose.length, text: prose } }]) => JSON.stringify({ updates })
  const dispatchSpy = vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch ?? (async (_request, options) => {
    options.onVisible({ kind: 'delta', text: response() }); return { finishReason: 'stop', usage: null }
  }))
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: (key: string) => JSON.stringify({key,systemRole:'合成定稿编辑',content:'正文：{{chapter_content}} 角色：{{existing_cards_json}}'}) }
  let current = true
  const makeOwner = (epoch: string) => createMainGenerationOwner({ database: db, projectId: 'project', epoch,
    assertCurrent: () => { if (!current) throw new Error('GENERATION_EPOCH_STALE') },
    leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: dispatchSpy,
    buildBinding: (selection, modelReceipt) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch,
      modelReceipt, policy: MAIN_GENERATION_POLICY, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt, MAIN_GENERATION_POLICY).binding,
  })
  const owner=makeOwner('epoch')
  const reopen=()=>{owner.suspendForProjectClose();db.close();db=new Database(path.join(root,'.ai-novel','project.db'));deps.db=db;vi.mocked(getProjectDb).mockReturnValue(db);const next=makeOwner('epoch-2');cleanup.unshift(()=>next.suspendForProjectClose());return next}
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const prepared = owner.readFinalizedCharacterContext(1)
  const selection: BeginGenerationRequest = { operation: 'finalized-character-state', uiActionNonce: 'extract', modelId: model.id, chapterNumber: 1,
    selectedDraftIds: [], selectedFinalizedDraftIds: [1], promptKeys: ['character_state_update'], skillStages: [], output: 'structured-data',
    finalizedCharacterContextId: prepared.contextId, authorInputs: [{ id: 'finalized-character-context', text: JSON.stringify(prepared.context) }] }
  const task = { purpose: 'finalized-character-state', output: 'structured-data' as const, messages: [{ role: 'user' as const, content: '从冻结正文和角色 ID 提取状态。' }] }
  const artifactOf = (receipt: MainGenerationExecuteReceipt) => {
    const artifact = receipt.run.artifacts.at(-1)!
    return { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash }
  }
  const run = async () => {
    const view = owner.begin(selection)
    const receipt = await owner.execute({ handle: view.handle, invocationNonce: 'extract-1', task })
    return { handle: view.handle, artifact: artifactOf(receipt), contextId: prepared.contextId }
  }
  return { owner, get db(){return db}, reopen, selection, prepared, characterId, dispatch: dispatchSpy, response, run, task, artifactOf, invalidate: () => { current = false } }
}

it('准备fixture：实际outbox和冻结角色来源，不调用模型',()=>{
 const f=fixture()
 expect(f.prepared.context.source).toMatchObject({draftId:1,finalizationId:'finalized-1',contentHash:textHash(prose)})
 expect(f.prepared.context.characters[0]?.characterId).toBe(f.characterId)
 expect(f.db.prepare('SELECT content_snapshot FROM finalization_outbox').pluck().get()).toBe(prose)
 expect(f.dispatch).not.toHaveBeenCalled()
})

import type { FinalizationGenerationSlot } from '../../../src/shared/finalization-generation'
async function generated(stepKey:FinalizationGenerationSlot['stepKey']='chapter_notes',finishReason='stop') {
 const f=fixture(stepKey==='chapter_notes'?async(_r,o)=>{o.onVisible({kind:'delta',text:'林岚进入北塔。'});return {finishReason,usage:null}}:undefined)
 const slot={source:f.prepared.context.source,stepKey}
 const recovery=f.owner.beginFinalizationGeneration({slot,modelId:'synthetic'})
 const receipt=await f.owner.executeFinalizationGeneration({handle:recovery.view.handle})
 return Object.assign(f,{slot,recovery,receipt,commitRequest:{handle:recovery.view.handle,artifact:f.artifactOf(receipt)}})
}
it('notes与blueprint及ACK同TX，注入写失败全部回滚；重复ACK零写',async()=>{
 const f=await generated()
 const before=f.db.prepare('SELECT * FROM summary_snapshots').all(),usage=f.db.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get()
 f.db.exec("CREATE TRIGGER reject_notes BEFORE UPDATE OF notes ON blueprints BEGIN SELECT RAISE(ABORT,'合成蓝图写失败'); END")
 expect(()=>f.owner.commitFinalizationGeneration(f.commitRequest)).toThrow('合成蓝图写失败')
 expect(f.db.prepare('SELECT * FROM summary_snapshots').all()).toEqual(before)
 expect(f.db.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get()).toEqual(usage)
 f.db.exec('DROP TRIGGER reject_notes')
 const saved=f.owner.commitFinalizationGeneration(f.commitRequest)
 expect(saved).toMatchObject({success:true,stepKey:'chapter_notes',chapterNotes:'林岚进入北塔。',blueprintUpdated:true})
 expect(f.db.prepare('SELECT notes FROM blueprints').pluck().get()).toBe('林岚进入北塔。')
 const changes=f.db.prepare('SELECT total_changes()').pluck().get()
 expect(f.owner.commitFinalizationGeneration(f.commitRequest)).toEqual(saved)
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
 expect(f.dispatch).toHaveBeenCalledTimes(1)
})
it('characters原ACK跨重开保持计数，作者后改不被回读覆盖',async()=>{
 const f=await generated('character_cards')
 const saved=f.owner.commitFinalizationGeneration(f.commitRequest)
 expect(saved).toMatchObject({success:true,stepKey:'character_cards',applied:1})
 f.db.prepare('UPDATE characters SET cs_location=? WHERE character_id=?').run('作者后来地点',f.characterId)
 const next=f.reopen(),read=next.readFinalizationGeneration({slot:f.slot})
 expect(read?.context).toEqual(f.recovery.context)
 expect(read?.modelId).toBe('synthetic')
 expect(read?.effect).toEqual(saved)
 expect(next.commitFinalizationGeneration(f.commitRequest)).toEqual(saved)
 expect(f.db.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('作者后来地点')
 expect(f.dispatch).toHaveBeenCalledTimes(1)
})
it('未提交characters作者字段改变拒绝覆盖，保留artifact',async()=>{
 const f=await generated('character_cards')
 f.db.prepare('UPDATE characters SET cs_location=? WHERE character_id=?').run('作者新地点',f.characterId)
 expect(()=>f.owner.commitFinalizationGeneration(f.commitRequest)).toThrow()
 expect(f.db.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('作者新地点')
 expect(f.owner.read(f.commitRequest.handle).artifacts).toHaveLength(1)
})
it('stop未提交重开保持原context和artifact，伪handle拒绝',async()=>{
 const f=await generated(),next=f.reopen()
 expect(next.readFinalizationGeneration({slot:f.slot})?.context).toEqual(f.recovery.context)
 const replay=await next.executeFinalizationGeneration({handle:f.commitRequest.handle})
 expect(replay.run.artifacts).toEqual(f.receipt.run.artifacts)
 expect(()=>next.commitFinalizationGeneration({...f.commitRequest,handle:{...f.commitRequest.handle,rootActionId:'伪根'}})).toThrow()
 expect(next.commitFinalizationGeneration(f.commitRequest)).toMatchObject({success:true})
 expect(f.dispatch).toHaveBeenCalledTimes(1)
})
it('length不得formal commit，重开不重发',async()=>{
 const f=await generated('chapter_notes','length')
 expect(()=>f.owner.commitFinalizationGeneration(f.commitRequest)).toThrow()
 const next=f.reopen()
 await next.executeFinalizationGeneration({handle:f.commitRequest.handle})
 expect(next.readFinalizationGeneration({slot:f.slot})?.effect).toBeUndefined()
 expect(f.dispatch).toHaveBeenCalledTimes(1)
})
it('unknown保留原attempt，重开不得自动重发或产生effect',async()=>{
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'林岚进入北塔。'});throw new Error('合成发送结果未知')})
 const slot:FinalizationGenerationSlot={source:f.prepared.context.source,stepKey:'chapter_notes'}
 const handle=f.owner.beginFinalizationGeneration({slot,modelId:'synthetic'}).view.handle
 const receipt=await f.owner.executeFinalizationGeneration({handle})
 const next=f.reopen(),replay=await next.executeFinalizationGeneration({handle})
 expect(replay.run.artifacts).toEqual(receipt.run.artifacts)
 expect(next.readFinalizationGeneration({slot})?.effect).toBeUndefined()
 expect(f.dispatch).toHaveBeenCalledTimes(1)
 if(receipt.run.artifacts.length)expect(()=>next.commitFinalizationGeneration({handle,artifact:f.artifactOf(receipt)})).toThrow()
})

it('notes后characters沿同root原模型，attemptCount只统计本阶段',async()=>{
 const f=await generated()
 f.owner.commitFinalizationGeneration(f.commitRequest)
 const slot:FinalizationGenerationSlot={source:f.slot.source,stepKey:'character_cards'}
 const child=f.owner.beginFinalizationGeneration({slot,modelId:'different-current-default'})
 expect(child.view.handle.rootActionId).toBe(f.recovery.view.handle.rootActionId)
 expect(child.modelId).toBe(f.recovery.modelId)
 expect(child.attemptCount).toBe(0)
 f.dispatch.mockImplementationOnce(async(_request,options)=>{options.onVisible({kind:'delta',text:f.response()});return {finishReason:'stop',usage:null}})
 const result=await f.owner.executeFinalizationGeneration({handle:child.view.handle})
 expect(f.owner.commitFinalizationGeneration({handle:child.view.handle,artifact:f.artifactOf(result)})).toMatchObject({success:true,stepKey:'character_cards',applied:1})
 expect(f.owner.readFinalizationGeneration({slot})?.attemptCount).toBe(1)
 expect(f.owner.readFinalizationGeneration({slot:f.slot})?.attemptCount).toBe(1)
 expect(result.run.ledger?.physicalRequests).toBe(2)
 expect(f.dispatch).toHaveBeenCalledTimes(2)
})

it('notes ACK封存后resume、compose、discard、restart全部拒绝且零写',async()=>{
 const f=await generated(),saved=f.owner.commitFinalizationGeneration(f.commitRequest)
 const changes=f.db.prepare('SELECT total_changes()').pluck().get()
 await expect(f.owner.resume(f.commitRequest.handle)).rejects.toThrow('GENERATION_FINALIZATION_EFFECT_SEALED')
 expect(()=>f.owner.composeVisible(f.commitRequest.handle,[f.commitRequest.artifact.artifactId],f.commitRequest.artifact.textHash)).toThrow('GENERATION_FINALIZATION_EFFECT_SEALED')
 expect(()=>f.owner.discardCandidate(f.commitRequest.handle,f.commitRequest.artifact.artifactId)).toThrow('GENERATION_FINALIZATION_EFFECT_SEALED')
 expect(()=>f.owner.restart(f.commitRequest.handle,f.selection)).toThrow('GENERATION_FINALIZATION_EFFECT_SEALED')
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
 expect(f.owner.readFinalizationGeneration({slot:f.slot})?.effect).toEqual(saved)
 expect(f.dispatch).toHaveBeenCalledTimes(1)
})

it('slot重复打开沿原模型原run，伪来源和伪epoch不获授权',async()=>{
 const f=await generated()
 const before=f.db.prepare('SELECT total_changes()').pluck().get()
 const reopened=f.owner.beginFinalizationGeneration({slot:f.slot,modelId:'另一个默认模型'})
 expect(reopened.view.handle).toEqual(f.recovery.view.handle)
 expect(reopened.modelId).toBe('synthetic')
 const forged={...f.slot,source:{...f.slot.source,contentHash:textHash('另一个正文')}}
 expect(f.owner.readFinalizationGeneration({slot:forged})).toBeNull()
 expect(()=>f.owner.beginFinalizationGeneration({slot:forged,modelId:'synthetic'})).toThrow()
 await expect(f.owner.executeFinalizationGeneration({handle:{...f.commitRequest.handle,epoch:'伪epoch'}})).rejects.toThrow()
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(before)
 expect(f.dispatch).toHaveBeenCalledTimes(1)
})

it('characters坏JSON仅同run修复一次，原坏artifact保留且重开合法结果不再请求',async()=>{
 const f=fixture()
 f.dispatch.mockImplementationOnce(async(_request,options)=>{options.onVisible({kind:'delta',text:'{"updates": ['});return {finishReason:'stop',usage:null}})
 const slot:FinalizationGenerationSlot={source:f.prepared.context.source,stepKey:'character_cards'}
 const recovery=f.owner.beginFinalizationGeneration({slot,modelId:'synthetic'})
 const result=await f.owner.executeFinalizationGeneration({handle:recovery.view.handle})
 expect(f.dispatch).toHaveBeenCalledTimes(2)
 expect(result.run.handle).toEqual(recovery.view.handle)
 expect(result.run.artifacts.map(item=>item.text)).toEqual(['{"updates": [',f.response()])
 const attempts=f.db.prepare('SELECT run_id,invocation_nonce FROM generation_attempts ORDER BY rowid').all()
 expect(attempts).toEqual([{run_id:recovery.view.handle.runId,invocation_nonce:'finalization:0'},{run_id:recovery.view.handle.runId,invocation_nonce:'finalization:1'}])
 const next=f.reopen()
 const cached=await next.executeFinalizationGeneration({handle:recovery.view.handle})
 expect(cached.run.artifacts).toEqual(result.run.artifacts)
 expect(next.readFinalizationGeneration({slot})?.modelId).toBe('synthetic')
 expect(next.commitFinalizationGeneration({handle:recovery.view.handle,artifact:f.artifactOf(cached)})).toMatchObject({success:true,applied:1})
 expect(f.dispatch).toHaveBeenCalledTimes(2)
})

it('characters连续三次坏JSON封顶，重开保留三候选不再请求',async()=>{
 const f=fixture(async(_request,options)=>{options.onVisible({kind:'delta',text:'坏的角色JSON'});return {finishReason:'stop',usage:null}})
 const slot:FinalizationGenerationSlot={source:f.prepared.context.source,stepKey:'character_cards'}
 const handle=f.owner.beginFinalizationGeneration({slot,modelId:'synthetic'}).view.handle
 const result=await f.owner.executeFinalizationGeneration({handle})
 expect(f.dispatch).toHaveBeenCalledTimes(3)
 expect(result.run.artifacts).toHaveLength(3)
 expect(f.db.prepare('SELECT invocation_nonce FROM generation_attempts ORDER BY rowid').pluck().all()).toEqual(['finalization:0','finalization:1','finalization:2'])
 const next=f.reopen(),cached=await next.executeFinalizationGeneration({handle})
 expect(cached.run.artifacts).toEqual(result.run.artifacts)
 expect(()=>next.commitFinalizationGeneration({handle,artifact:f.artifactOf(cached)})).toThrow()
 expect(next.readFinalizationGeneration({slot})?.effect).toBeUndefined()
 expect(f.dispatch).toHaveBeenCalledTimes(3)
})

it('characters首请求在途取消后不发JSON修复请求',async()=>{
 let release!:()=>void,started!:()=>void
 const pending=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve})
 const f=fixture(async(_request,options)=>{started();await pending;options.onVisible({kind:'delta',text:'坏的角色JSON'});return {finishReason:'stop',usage:null}})
 const slot:FinalizationGenerationSlot={source:f.prepared.context.source,stepKey:'character_cards'}
 const handle=f.owner.beginFinalizationGeneration({slot,modelId:'synthetic'}).view.handle
 const executing=f.owner.executeFinalizationGeneration({handle})
 await entered
 f.owner.cancelFinalizationGeneration({handle})
 release()
 await executing.catch(()=>undefined)
 expect(f.dispatch).toHaveBeenCalledTimes(1)
 expect(f.owner.readFinalizationGeneration({slot})?.effect).toBeUndefined()
 expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(1)
})

it.each(['length','unknown'] as const)('characters %s坏JSON不能触发修复或重开发送',async mode=>{
 const f=fixture(async(_request,options)=>{options.onVisible({kind:'delta',text:'{"updates": ['});if(mode==='unknown')throw new Error('发送结果未知');return {finishReason:'length',usage:null}})
 const slot:FinalizationGenerationSlot={source:f.prepared.context.source,stepKey:'character_cards'}
 const handle=f.owner.beginFinalizationGeneration({slot,modelId:'synthetic'}).view.handle
 const result=await f.owner.executeFinalizationGeneration({handle})
 expect(f.dispatch).toHaveBeenCalledTimes(1)
 const next=f.reopen(),cached=await next.executeFinalizationGeneration({handle})
 expect(cached.run.artifacts).toEqual(result.run.artifacts)
 expect(next.readFinalizationGeneration({slot})?.effect).toBeUndefined()
 expect(f.dispatch).toHaveBeenCalledTimes(1)
})
