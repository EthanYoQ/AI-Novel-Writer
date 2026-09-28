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
import { parseFinalizedCharacterStateResponse } from '../../../src/shared/finalized-continuity'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const prose = '林岚走进了北塔。'

function fixture(dispatch?: GenerationRunServiceDependencies['dispatch'], options: { content?: string; writingLanguage?: 'en-US' } = {}) {
  const content = options.content ?? prose
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/finalization-generation-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  prepareCanonicalStorageFixture(root)
  let db = new Database(path.join(root,'.ai-novel','project.db'))
  vi.mocked(getProjectDb).mockReturnValue(db)
  db.exec("INSERT INTO characters(name,character_id,cs_provenance) VALUES('林岚','character-lan','{}')")
  db.exec("INSERT INTO project_core(id,project_name) VALUES('main','合成定稿'); INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔'); INSERT INTO contents(id,body) VALUES(1,'旧稿'); INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,2)")
  if (options.writingLanguage) db.prepare("UPDATE project_core SET writing_language=? WHERE id='main'").run(options.writingLanguage)
  FinalizationRepository.commit({ finalizationId: 'finalized-1', draftId: 1, chapterNumber: 1, chapterTitle: '北塔',
    content, contentHash: textHash(content), contentRevision: 1, targetFileName: '第一章.txt' })
  const characterId = db.prepare("SELECT character_id FROM characters WHERE name='林岚'").pluck().get() as string
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
    apiKey: 'synthetic-fixture-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'],
    capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const response = (updates = [{ characterId, currentState: { location: '北塔' }, evidence: { start: 0, end: content.length, text: content } }]) => JSON.stringify({ updates })
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

const splitProse='林岚在记录末尾写下核查安排。\n\n林岚更正记录：核查仍未开始，原定安排等待雨停。'
const joinedQuote='林岚在记录末尾写下核查安排。林岚更正记录：核查仍未开始，原定安排等待雨停。'
const lastUserMessage=(request:unknown)=>{
 const messages=(request as {task:{messages:{role:string;content:unknown}[]}}).task.messages
 const content=messages.filter(message=>message.role==='user').at(-1)?.content
 return typeof content==='string'?content:JSON.stringify(content)
}
async function splitEvidenceRun(writingLanguage?:'en-US',replies:((characterId:string)=>unknown)[]=[]){
 const f=fixture(undefined,{content:splitProse,writingLanguage})
 for(const reply of replies)f.dispatch.mockImplementationOnce(async(_request,options)=>{
  const value=reply(f.characterId);options.onVisible({kind:'delta',text:typeof value==='string'?value:JSON.stringify(value)});return {finishReason:'stop',usage:null}})
 const slot:FinalizationGenerationSlot={source:f.prepared.context.source,stepKey:'character_cards'}
 const handle=f.owner.beginFinalizationGeneration({slot,modelId:'synthetic'}).view.handle
 const result=await f.owner.executeFinalizationGeneration({handle})
 return Object.assign(f,{slot,handle,result})
}
const joined=(offsets:boolean)=>(characterId:string)=>({updates:[{characterId,currentState:{location:'记录室'},evidence:offsets?{start:0,end:joinedQuote.length,text:joinedQuote}:{text:joinedQuote}}]})
const single=(characterId:string)=>({updates:[{characterId,currentState:{location:'记录室'},evidence:{text:'林岚更正记录：核查仍未开始，原定安排等待雨停。'}}]})

it('characters初始提示要求evidence为单一连续片段（中英）',async()=>{
 const zh=await splitEvidenceRun(undefined,[single])
 expect(lastUserMessage(zh.dispatch.mock.calls[0]![0])).toContain('不得跨段落或空行拼接')
 const en=await splitEvidenceRun('en-US',[single])
 expect(lastUserMessage(en.dispatch.mock.calls[0]![0])).toContain('never join sentences across paragraphs or blank lines')
})

it('characters跨空行拼接证据：修复消息给出连续片段规则，合法单句后提交',async()=>{
 const f=await splitEvidenceRun(undefined,[joined(true),single])
 expect(f.dispatch).toHaveBeenCalledTimes(2)
 const repair=lastUserMessage(f.dispatch.mock.calls[1]![0])
 expect(repair).toContain('不得跨段落或空行拼接')
 expect(repair).toContain('省略 start/end')
 expect(repair).not.toContain('上一份回答未满足要求的 JSON 结构或原文证据校验')
 expect(repair).not.toContain(joinedQuote)
 expect(f.owner.commitFinalizationGeneration({handle:f.handle,artifact:f.artifactOf(f.result)})).toMatchObject({success:true,applied:1})
})

it('characters英文项目证据修复消息为英文',async()=>{
 const f=await splitEvidenceRun('en-US',[joined(false),single])
 const repair=lastUserMessage(f.dispatch.mock.calls[1]![0])
 expect(repair).toContain('never join sentences across paragraphs or blank lines')
 expect(repair).toContain('omit start/end')
 expect(repair).not.toMatch(/[一-鿿]/)
})

it('characters三次跨段拼接证据仍封顶拒写，事实门不放宽',async()=>{
 const f=await splitEvidenceRun(undefined,[joined(true),joined(false),joined(false)])
 expect(f.dispatch).toHaveBeenCalledTimes(3)
 expect(lastUserMessage(f.dispatch.mock.calls[2]![0])).toContain('不得跨段落或空行拼接')
 expect(()=>f.owner.commitFinalizationGeneration({handle:f.handle,artifact:f.artifactOf(f.result)})).toThrow(/FINALIZED_CHARACTER_EVIDENCE_/)
 expect(f.owner.readFinalizationGeneration({slot:f.slot})?.effect).toBeUndefined()
 expect(f.db.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).not.toBe('记录室')
})

it('characters JSON结构错误仍给通用修复说明',async()=>{
 const f=await splitEvidenceRun(undefined,[()=>'{"updates": [',single])
 const repair=lastUserMessage(f.dispatch.mock.calls[1]![0])
 expect(repair).toContain('上一份回答未满足要求的 JSON 结构或原文证据校验')
 expect(repair).not.toContain('不得跨段落或空行拼接')
})

// Replays the observed template-following shape: name instead of characterId, no evidence, all fields, newCharacters.
const templateShaped=()=>({updates:[{name:'林岚',currentState:{location:'记录室',powerLevel:'未变',physicalState:'疲惫',mentalState:'警觉',keyItems:'记录本',recentEvents:'更正记录',updatedAtChapter:1}}],newCharacters:[{name:'守夜人',role:'minor',currentState:{location:'北塔'}}]})

it('characters缺evidence按独立错误码拒绝，结构错误码不变',async()=>{
 const f=await splitEvidenceRun(undefined,[single])
 const identity=f.prepared.context
 expect(()=>parseFinalizedCharacterStateResponse(JSON.stringify(templateShaped()),identity)).toThrow('FINALIZED_CHARACTER_EVIDENCE_MISSING')
 expect(()=>parseFinalizedCharacterStateResponse(JSON.stringify({updates:[{characterId:f.characterId,currentState:{location:'记录室'},evidence:'林岚'}]}),identity)).toThrow('FINALIZED_CHARACTER_EVIDENCE_MISSING')
 expect(()=>parseFinalizedCharacterStateResponse(JSON.stringify({updates:[{characterId:f.characterId,evidence:{text:'林岚'}}]}),identity)).toThrow('FINALIZED_CHARACTER_UPDATE_INVALID')
 expect(()=>parseFinalizedCharacterStateResponse('{"updates":[null]}',identity)).toThrow('FINALIZED_CHARACTER_UPDATE_INVALID')
})

it('characters缺evidence：修复消息点名缺失字段并要求保留有据更新，合法后提交',async()=>{
 const f=await splitEvidenceRun(undefined,[templateShaped,single])
 expect(f.dispatch).toHaveBeenCalledTimes(2)
 const repair=lastUserMessage(f.dispatch.mock.calls[1]![0])
 expect(repair).toContain('上一份回答的更新项缺少 evidence')
 expect(repair).toContain('不要因缺少 evidence 而返回空列表')
 expect(repair).toContain('characterId')
 expect(repair).toContain('删除 newCharacters')
 expect(repair).not.toContain('上一份回答未满足要求的 JSON 结构或原文证据校验')
 expect(repair).not.toContain('不得跨段落或空行拼接')
 expect(repair).not.toContain('守夜人')
 expect(f.owner.commitFinalizationGeneration({handle:f.handle,artifact:f.artifactOf(f.result)})).toMatchObject({success:true,applied:1})
})

it('characters英文项目缺evidence修复消息为英文',async()=>{
 const f=await splitEvidenceRun('en-US',[templateShaped,single])
 const repair=lastUserMessage(f.dispatch.mock.calls[1]![0])
 expect(repair).toContain('At least one update had no evidence object')
 expect(repair).toContain('instead of returning an empty list because evidence was missing')
 expect(repair).toContain('remove newCharacters')
 expect(repair).not.toContain('never join sentences across paragraphs or blank lines')
 expect(repair).not.toMatch(/[一-鿿]/)
})

it('characters缺evidence三次仍封顶拒写',async()=>{
 const f=await splitEvidenceRun(undefined,[templateShaped,templateShaped,templateShaped])
 expect(f.dispatch).toHaveBeenCalledTimes(3)
 expect(lastUserMessage(f.dispatch.mock.calls[2]![0])).toContain('上一份回答的更新项缺少 evidence')
 expect(()=>f.owner.commitFinalizationGeneration({handle:f.handle,artifact:f.artifactOf(f.result)})).toThrow('FINALIZED_CHARACTER_EVIDENCE_MISSING')
 expect(f.owner.readFinalizationGeneration({slot:f.slot})?.effect).toBeUndefined()
})

it('characters初始提示以最终合同覆盖模板示例（中英）',async()=>{
 const zh=lastUserMessage((await splitEvidenceRun(undefined,[single])).dispatch.mock.calls[0]![0])
 expect(zh).toContain('【最终输出合同，覆盖上文【输出格式（JSON）】】')
 expect(zh.indexOf('【最终输出合同')).toBeLessThan(zh.indexOf('只返回一个 JSON 对象'))
 const en=lastUserMessage((await splitEvidenceRun('en-US',[single])).dispatch.mock.calls[0]![0])
 expect(en).toContain('[Final output contract: this overrides the [JSON output contract] above]')
 expect(en).toContain("that card's exact characterId")
 expect(en.indexOf('[Final output contract')).toBeLessThan(en.indexOf('Return one JSON object'))
})

it('characters最终合同要求每个update含recentEvents，且与渲染端副本一致（中英）',async()=>{
 const zh=lastUserMessage((await splitEvidenceRun(undefined,[single])).dispatch.mock.calls[0]![0])
 const en=lastUserMessage((await splitEvidenceRun('en-US',[single])).dispatch.mock.calls[0]![0])
 expect(zh).toContain('每个 update 必须填写 recentEvents（本章中该角色最重要的事件，50字以内）')
 expect(zh).toContain('location 只写地点，不写事件或进度')
 expect(zh).toContain('只返回一个 JSON 对象：{"updates":[{"characterId":"冻结名单中的精确ID","currentState":{"recentEvents":"本章事件","location":"新地点"},"evidence":{"text":"原文精确引用"}}]}')
 expect(zh).not.toContain('只列出实际变化的字段')
 expect(en).toContain("Every update must include recentEvents (this character's most important event in this chapter, within 50 words)")
 expect(en).toContain('location is a place, never an event or progress')
 expect(en).toContain('Return one JSON object: {"updates":[{"characterId":"exact ID from the frozen list","currentState":{"recentEvents":"this chapter\'s event","location":"new place"},"evidence":{"text":"exact source quote"}}]}')
 expect(en).not.toContain('list only the fields that actually changed')
 const renderer=fs.readFileSync(path.resolve('src/services/workflows/commands/finalize-chapter.command.ts'),'utf8')
 for(const [message,prefix] of [[zh,'【最终输出合同'],[en,'[Final output contract']] as const){
  const contract=message.slice(message.indexOf(prefix))
  expect(renderer).toContain(`'${contract.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}'`)
 }
})
