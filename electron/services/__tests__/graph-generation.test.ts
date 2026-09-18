import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { MAIN_GENERATION_POLICY } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { generationOutputContract } from '../../../src/shared/generation-owner-contract'
import { getProjectDb } from '../../database'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { NarrativeThreadRepository } from '../../repositories/narrative-thread-repository'
import { textHash } from '../../repositories/generation-run-repository'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import type { GraphGenerationInput } from '../../../src/shared/graph-generation'

vi.mock('../../database', async original => ({...await original<typeof import('../../database')>(),getProjectDb:vi.fn()}))
const Database=createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup:(()=>void)[]=[]
afterEach(()=>{cleanup.splice(0).forEach(dispose=>dispose());vi.restoreAllMocks()})
const planOutput=JSON.stringify({candidates:[{title:'铜钥匙',type:'伏笔',targetStartChapter:1,targetEndChapter:3,authorIntent:'打开北塔'},{title:'钟声',type:'伏笔',targetStartChapter:1,targetEndChapter:4,authorIntent:'找到钟楼'}]})
function fixture(dispatch?:GenerationRunServiceDependencies['dispatch']) {
 const base=path.resolve('.runtime/.cache/novel-quality-modernization/graph-owner-tests');fs.mkdirSync(base,{recursive:true})
 const root=fs.mkdtempSync(path.join(base,'项目-'));prepareCanonicalStorageFixture(root)
 const file=path.join(root,'.ai-novel','project.db');let db=new Database(file);vi.mocked(getProjectDb).mockReturnValue(db)
 db.exec("INSERT INTO project_core(id,project_name,total_chapters,synopsis) VALUES('main','铜钥匙',10,'寻找北塔'); INSERT INTO blueprints(chapter_number,title,key_events) VALUES(1,'雨夜','发现铜钥匙'); INSERT INTO contents(id,body) VALUES(1,'原稿'); INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,2)")
 const prose='林岚找到铜钥匙，听见钟声。'
 FinalizationRepository.commit({finalizationId:'定稿1',draftId:1,chapterNumber:1,chapterTitle:'雨夜',content:prose,contentHash:textHash(prose),contentRevision:1,targetFileName:'第一章.txt'})
 const plan=NarrativeThreadRepository.createPlan({title:'铜钥匙',type:'伏笔',targetStartChapter:1,targetEndChapter:3,authorIntent:'打开北塔'},db)
 let model:ModelProfile|null={id:'synthetic',name:'合成模型',provider:'openai',protocol:'openai',modelName:'gpt-4.1',apiKey:'fixture-only',baseUrl:'https://api.openai.com/v1',temperature:0.7,maxTokens:2048,purposes:['generation'],capabilities:{contextWindowTokens:32768,maxOutputTokens:2048,reasoning:false,structuredOutput:true,usage:true}}
 const spy=vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch??(async(_request,options)=>{options.onVisible({kind:'delta',text:planOutput});return {finishReason:'stop',usage:null}}))
 const deps={db,projectStorageRoot:root,globalDataRoot:root,readBuiltinPrompt:(key:string)=>JSON.stringify({key,systemRole:'图谱编辑',content:'合成模板'})}
 const make=(epoch:string)=>createMainGenerationOwner({database:db,projectId:'project',epoch,assertCurrent:()=>{},leases:new ModelExecutionLeaseRegistry({loadModel:()=>model}),loadModel:()=>model,dispatch:spy,
  buildBinding:(selection,receipt)=>buildGenerationSourceBinding(deps,{...selection,projectId:'project',epoch,modelReceipt:receipt,policy:MAIN_GENERATION_POLICY,outputContract:generationOutputContract(selection)}).binding,
  rebuildBinding:(previous,receipt)=>rebuildGenerationSourceBinding(deps,previous,epoch,receipt,MAIN_GENERATION_POLICY).binding})
 const owner=make('epoch-1');const owners=[owner]
 cleanup.push(()=>{owners.forEach(item=>item.suspendForProjectClose());db.close();fs.rmSync(root,{recursive:true,force:true})})
 return {owner,get db(){return db},spy,plan,begin:(input:GraphGenerationInput={kind:'plan',chapterNumber:1})=>owner.beginGraphGeneration({input,modelId:'synthetic',uiActionNonce:'图谱动作'}),
  removeModel:()=>{model=null},reopen:()=>{owners.at(-1)!.suspendForProjectClose();db.close();db=new Database(file);deps.db=db;vi.mocked(getProjectDb).mockReturnValue(db);const next=make('epoch-2');owners.push(next);return next}}
}
it('专属main构造实际task，generic begin/execute不能伪装图谱',async()=>{
 const f=fixture(),recovery=f.begin()
 expect(recovery.view.operation).toBe('narrative-thread-plan-candidate')
 expect(()=>f.owner.begin({operation:'narrative-thread-plan-candidate',uiActionNonce:'伪动作',modelId:'synthetic',promptKeys:['graph-plan'],skillStages:[],output:'structured-data',selectedDraftIds:[],selectedFinalizedDraftIds:[]})).toThrow('GENERATION_GRAPH_ADMISSION_REQUIRED')
 await expect(f.owner.execute({handle:recovery.view.handle,invocationNonce:'伪请求',task:{purpose:'narrative-thread-plan-candidate',output:'structured-data',messages:[{role:'user',content:'伪正文'}]}})).rejects.toThrow('GENERATION_GRAPH_ADMISSION_REQUIRED')
 const result=await f.owner.executeGraphGeneration({handle:recovery.view.handle})
 expect(result.run.artifacts).toHaveLength(1)
 const request=f.spy.mock.calls[0]![0] as {task:{messages:{content:string}[]}}
 expect(request.task.messages[1]!.content).toContain('发现铜钥匙')
 expect(f.spy).toHaveBeenCalledTimes(1)
})
it('图谱root不授权generic child或复制context的restart',()=>{
 const f=fixture(),handle=f.begin().view.handle
 const selection={operation:'author-test',uiActionNonce:'旁路',modelId:'synthetic',promptKeys:['graph-plan'],skillStages:[],output:'structured-data' as const,selectedDraftIds:[],selectedFinalizedDraftIds:[]}
 const changes=f.db.prepare('SELECT total_changes()').pluck().get()
 expect(()=>f.owner.begin({...selection,parentRootActionId:handle.rootActionId})).toThrow('GENERATION_GRAPH_CHILD_FORBIDDEN')
 expect(()=>f.owner.restart(handle,selection)).toThrow('GENERATION_GRAPH_ADMISSION_REQUIRED')
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
 expect(f.spy).not.toHaveBeenCalled()
})
it('并发join只发一次，重开删模型仍原artifact；相同nonce保持原模型且不同input拒绝',async()=>{
 let release!:()=>void,started!:()=>void
 const pending=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve})
 const f=fixture(async(_request,options)=>{started();await pending;options.onVisible({kind:'delta',text:planOutput});return {finishReason:'stop',usage:null}}),recovery=f.begin(),handle=recovery.view.handle
 const first=f.owner.executeGraphGeneration({handle});await entered;const second=f.owner.executeGraphGeneration({handle});release()
 const [a,b]=await Promise.all([first,second]);expect(a.run.artifacts).toEqual(b.run.artifacts);expect(f.spy).toHaveBeenCalledTimes(1)
 f.removeModel();const next=f.reopen()
 expect((await next.executeGraphGeneration({handle})).run.artifacts).toEqual(a.run.artifacts)
 expect(next.beginGraphGeneration({input:{kind:'plan',chapterNumber:1},modelId:'新默认模型',uiActionNonce:'图谱动作'}).modelId).toBe('synthetic')
 expect(()=>next.beginGraphGeneration({input:{kind:'plot'},modelId:'synthetic',uiActionNonce:'图谱动作'})).toThrow('GENERATION_NONCE_CONFLICT')
 expect(f.spy).toHaveBeenCalledTimes(1)
})
it('确认两候选同TX回执，原ACK在作者修改后只读，生成mutation已封存',async()=>{
 const f=fixture(),handle=f.begin().view.handle;await f.owner.executeGraphGeneration({handle})
 const read=f.owner.readGraphGeneration({handle}),artifact=read.artifact!
 expect(f.db.prepare('SELECT COUNT(*) FROM narrative_thread_plans').pluck().get()).toBe(1)
 const saved=f.owner.confirmGraphGeneration({handle,artifact,index:0})
 expect(f.owner.confirmGraphGeneration({handle,artifact,index:1})).toMatchObject({success:true,index:1,kind:'plan'})
 const changes=f.db.prepare('SELECT total_changes()').pluck().get()
 expect(()=>f.owner.discardCandidate(handle,artifact.artifactId)).toThrow('GENERATION_GRAPH_EFFECT_SEALED')
 expect(()=>f.owner.composeVisible(handle,[artifact.artifactId],artifact.textHash)).toThrow('GENERATION_GRAPH_EFFECT_SEALED')
 await expect(f.owner.resume(handle)).rejects.toThrow('GENERATION_GRAPH_EFFECT_SEALED')
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
 f.db.exec("UPDATE blueprints SET title='作者后来改动'")
 const next=f.reopen(),before=f.db.prepare('SELECT total_changes()').pluck().get()
 expect(next.confirmGraphGeneration({handle,artifact,index:0})).toEqual(saved)
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(before)
})
it('event同run连续确认不会把本次event当外部源变化，外部变更仍拒',async()=>{
 const output=JSON.stringify({candidates:[{type:'planted',evidence:'铜钥匙',reason:'发现'},{type:'progressing',evidence:'钟声',reason:'推进'}]})
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:output});return {finishReason:'stop',usage:null}}),handle=f.begin({kind:'event',planId:1,draftId:1}).view.handle
 await f.owner.executeGraphGeneration({handle});const artifact=f.owner.readGraphGeneration({handle}).artifact!
 f.owner.confirmGraphGeneration({handle,artifact,index:0})
 expect(f.owner.readGraphGeneration({handle}).sourceStatus).toBe('current')
 expect(f.owner.confirmGraphGeneration({handle,artifact,index:1})).toMatchObject({success:true,kind:'event'})
 expect(f.spy).toHaveBeenCalledTimes(1)
})
it.each(['unknown','length','bad-json'] as const)('%s保留原文且不修复/不自动重发/不采用',async mode=>{
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'坏JSON'});if(mode==='unknown')throw new Error('合成网络未知');return {finishReason:mode==='length'?'length':'stop',usage:null}}),handle=f.begin().view.handle
 const result=await f.owner.executeGraphGeneration({handle});expect(result.run.artifacts).toHaveLength(1)
 const next=f.reopen();await next.executeGraphGeneration({handle})
 expect(next.readGraphGeneration({handle}).result).toBeUndefined()
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it('来源变化与伪artifact拒绝采用，写入失败回滚effect和计划',async()=>{
 const f=fixture(),handle=f.begin().view.handle;await f.owner.executeGraphGeneration({handle})
 const artifact=f.owner.readGraphGeneration({handle}).artifact!
 expect(()=>f.owner.confirmGraphGeneration({handle,artifact:{...artifact,textHash:'0'.repeat(64)},index:0})).toThrow('GENERATION_GRAPH_ARTIFACT_INVALID')
 const before=f.db.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get()
 f.db.exec("CREATE TRIGGER reject_graph_ack BEFORE UPDATE OF usage_receipt_json ON generation_attempts BEGIN SELECT RAISE(ABORT,'合成ACK写失败'); END")
 expect(()=>f.owner.confirmGraphGeneration({handle,artifact,index:0})).toThrow('合成ACK写失败')
 expect(f.db.prepare('SELECT COUNT(*) FROM narrative_thread_plans').pluck().get()).toBe(1)
 expect(f.db.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get()).toBe(before)
 f.db.exec("DROP TRIGGER reject_graph_ack; UPDATE blueprints SET title='作者改蓝图'")
 expect(()=>f.owner.confirmGraphGeneration({handle,artifact,index:0})).toThrow('GENERATION_SOURCE_CHANGED')
 expect(f.owner.readGraphGeneration({handle}).view.artifacts).toHaveLength(1)
})

it('plot只在显式确认后写快照，重复ACK不覆盖作者后来快照',async()=>{
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'{}'});return {finishReason:'stop',usage:null}}),handle=f.begin({kind:'plot'}).view.handle
 await f.owner.executeGraphGeneration({handle});const read=f.owner.readGraphGeneration({handle})
 expect(read.result?.kind).toBe('plot')
 expect(f.db.prepare('SELECT plot_tree_snapshot FROM project_core').pluck().get()).toBe('')
 const request={handle,artifact:read.artifact!,index:0},saved=f.owner.confirmGraphGeneration(request)
 expect(saved).toMatchObject({kind:'plot',success:true})
 f.db.prepare('UPDATE project_core SET plot_tree_snapshot=?').run('作者后来快照')
 expect(f.owner.confirmGraphGeneration(request)).toEqual(saved)
 expect(f.db.prepare('SELECT plot_tree_snapshot FROM project_core').pluck().get()).toBe('作者后来快照')
})

it('在途取消后无候选采用，0attempt取消不发送',async()=>{
 let release!:()=>void,started!:()=>void
 const wait=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve})
 const f=fixture(async(_r,o)=>{started();await wait;o.onVisible({kind:'delta',text:planOutput});return {finishReason:'stop',usage:null}}),handle=f.begin().view.handle
 const pending=f.owner.executeGraphGeneration({handle});await entered;f.owner.cancelGraphGeneration({handle});release();await pending.catch(()=>undefined)
 expect(f.spy).toHaveBeenCalledTimes(1)
 const recovery=f.owner.readGraphGeneration({handle})
 expect(recovery.view.artifacts.every(item=>!item.text)).toBe(true)
 const second=f.owner.beginGraphGeneration({input:{kind:'plan',chapterNumber:1},modelId:'synthetic',uiActionNonce:'另一个动作'}).view.handle
 f.owner.cancelGraphGeneration({handle:second})
 await expect(f.owner.executeGraphGeneration({handle:second})).rejects.toThrow()
 expect(f.spy).toHaveBeenCalledTimes(1)
})
