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



import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'


vi.mock('../../database', async original => ({...await original<typeof import('../../database')>(),getProjectDb:vi.fn()}))
const Database=createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup:(()=>void)[]=[]
afterEach(()=>{cleanup.splice(0).forEach(dispose=>dispose());vi.restoreAllMocks()})
const validOutput=JSON.stringify({schemaVersion:1,entries:[{name:'林岚',role:'protagonist',gender:'女',age:'成年',appearance:'黑发',personality:'沉稳',background:'旅人',abilities:'观察',motivation:'找钥匙',relationships:[],arc:'找到真相',notes:'旧资料'}]})
it.each(['payload-hash','operation-id','created-id'] as const)('旧名单历史采用回执校验原实际身份批准：%s',async field=>{
 const f=fixture(),handle=f.begin().view.handle
 await f.owner.executeLegacyRosterGeneration({handle})
 const artifact=f.owner.readLegacyRosterGeneration({handle}).artifact!,batch=f.owner.stageLegacyRosterGeneration({handle,artifact})
 const request={proposalBatchId:batch.proposalBatchId,expectedRevision:batch.revision,operationId:'证明原批准',selections:batch.items.map(item=>({selectionKey:item.selectionKey,action:'create' as const}))}
 f.owner.approveCharacterProposal(request)
 if(field==='payload-hash') f.db.prepare('UPDATE character_identity_approvals SET payload_hash=? WHERE operation_id=?').run('0'.repeat(64),request.operationId)
 else {
  const saved=JSON.parse(f.db.prepare('SELECT receipt_json FROM character_identity_approvals WHERE operation_id=?').pluck().get(request.operationId) as string)
  if(field==='operation-id') saved.approval.operationId='别的批准'
  else saved.created[0].characterId='伪身份'
  f.db.prepare('UPDATE character_identity_approvals SET receipt_json=? WHERE operation_id=?').run(JSON.stringify(saved),request.operationId)
 }
 const changes=f.db.prepare('SELECT total_changes()').pluck().get()
 expect(()=>f.owner.approveCharacterProposal(request)).toThrow('CHARACTER_PROPOSAL_APPROVAL_INVALID')
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
})
it('旧名单全部暂不采用不会清空待修复状态或伪造完成',async()=>{
 const f=fixture(),handle=f.begin().view.handle
 await f.owner.executeLegacyRosterGeneration({handle})
 const artifact=f.owner.readLegacyRosterGeneration({handle}).artifact!,batch=f.owner.stageLegacyRosterGeneration({handle,artifact})
 expect(()=>f.owner.approveCharacterProposal({proposalBatchId:batch.proposalBatchId,expectedRevision:batch.revision,operationId:'暂不采用',selections:batch.items.map(item=>({selectionKey:item.selectionKey,action:'keep-unresolved' as const}))})).toThrow('CHARACTER_APPROVAL_SELECTION_REQUIRED')
 expect(f.db.prepare('SELECT migration_state FROM character_roster_meta').pluck().get()).toBe('legacy_markdown_pending')
 expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
})
function fixture(dispatch?:GenerationRunServiceDependencies['dispatch']) {
 const base=path.resolve('.runtime/.cache/novel-quality-modernization/legacy-owner-tests');fs.mkdirSync(base,{recursive:true})
 const root=fs.mkdtempSync(path.join(base,'项目-'));prepareCanonicalStorageFixture(root)
 const file=path.join(root,'.ai-novel','project.db');let db=new Database(file);vi.mocked(getProjectDb).mockReturnValue(db)
 db.exec("INSERT INTO project_core(id,project_name,total_chapters,synopsis) VALUES('main','铜钥匙',10,'寻找北塔'); INSERT INTO blueprints(chapter_number,title,key_events) VALUES(1,'雨夜','发现铜钥匙'); INSERT INTO contents(id,body) VALUES(1,'原稿'); INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,2)")
 db.prepare("UPDATE character_roster_meta SET migration_state='legacy_markdown_pending',legacy_markdown=?" ).run('  # 林岚\r\n旧角色资料。  ')
 let model:ModelProfile|null={id:'synthetic',name:'合成模型',provider:'openai',protocol:'openai',modelName:'gpt-4.1',apiKey:'fixture-only',baseUrl:'https://api.openai.com/v1',temperature:0.7,maxTokens:2048,purposes:['generation'],capabilities:{contextWindowTokens:32768,maxOutputTokens:2048,reasoning:false,structuredOutput:true,usage:true}}
 const spy=vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch??(async(_request,options)=>{options.onVisible({kind:'delta',text:validOutput});return {finishReason:'stop',usage:null}}))
 const deps={db,projectStorageRoot:root,globalDataRoot:root,readBuiltinPrompt:(key:string)=>JSON.stringify({key,systemRole:'图谱编辑',content:'合成模板'})}
 const make=(epoch:string)=>createMainGenerationOwner({database:db,projectId:'project',epoch,assertCurrent:()=>{},leases:new ModelExecutionLeaseRegistry({loadModel:()=>model}),loadModel:()=>model,dispatch:spy,
  buildBinding:(selection,receipt)=>buildGenerationSourceBinding(deps,{...selection,projectId:'project',epoch,modelReceipt:receipt,policy:MAIN_GENERATION_POLICY,outputContract:generationOutputContract(selection)}).binding,
  rebuildBinding:(previous,receipt)=>rebuildGenerationSourceBinding(deps,previous,epoch,receipt,MAIN_GENERATION_POLICY).binding})
 const owner=make('epoch-1');const owners=[owner]
 cleanup.push(()=>{owners.forEach(item=>item.suspendForProjectClose());db.close();fs.rmSync(root,{recursive:true,force:true})})
 return {owner,get db(){return db},spy,begin:()=>owner.beginLegacyRosterGeneration({modelId:'synthetic',uiActionNonce:'旧名单修复'}),
  removeModel:()=>{model=null},reopen:()=>{owners.at(-1)!.suspendForProjectClose();db.close();db=new Database(file);deps.db=db;vi.mocked(getProjectDb).mockReturnValue(db);const next=make('epoch-2');owners.push(next);return next}}
}
it('旧名单专属main读真实原文，generic入口/child/restart拒绝，stage不写角色',async()=>{
 const f=fixture(),handle=f.begin().view.handle
 const generic={operation:'legacy-character-roster-repair',uiActionNonce:'伪入口',modelId:'synthetic',promptKeys:['legacy-roster'],skillStages:[],output:'structured-data' as const,selectedDraftIds:[],selectedFinalizedDraftIds:[]}
 expect(()=>f.owner.begin(generic)).toThrow('GENERATION_LEGACY_ADMISSION_REQUIRED')
 expect(()=>f.owner.begin({...generic,operation:'author-test',parentRootActionId:handle.rootActionId})).toThrow('GENERATION_LEGACY_CHILD_FORBIDDEN')
 expect(()=>f.owner.restart(handle,{...generic,operation:'author-test'})).toThrow('GENERATION_LEGACY_ADMISSION_REQUIRED')
 await expect(f.owner.execute({handle,invocationNonce:'伪nonce',task:{purpose:'legacy-character-roster-repair',output:'structured-data',messages:[{role:'user',content:'伪资料'}]}})).rejects.toThrow('GENERATION_LEGACY_ADMISSION_REQUIRED')
 await f.owner.executeLegacyRosterGeneration({handle})
 const read=f.owner.readLegacyRosterGeneration({handle})
 expect(read.context.source.rawLegacy).toBe('  # 林岚\r\n旧角色资料。  ')
 const proposal=f.owner.stageLegacyRosterGeneration({handle,artifact:read.artifact!})
 expect(proposal.status).toBe('pending-approval')
 expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
 expect(f.spy).toHaveBeenCalledTimes(1)
 const changes=f.db.prepare('SELECT total_changes()').pluck().get()
 expect(f.owner.stageLegacyRosterGeneration({handle,artifact:read.artifact!})).toEqual(proposal)
 expect(()=>f.owner.discardCandidate(handle,read.artifact!.artifactId)).toThrow('GENERATION_LEGACY_EFFECT_SEALED')
 await expect(f.owner.resume(handle)).rejects.toThrow('GENERATION_LEGACY_EFFECT_SEALED')
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
})
it('initial length两次replacement再syntax repair同run共6请求，原stage task不累加套娃',async()=>{
 const outputs=[['初始截断','length'],['再次截断','length'],['{坏语法','stop'],['修复截断','length'],['再修复截断','length'],[validOutput,'stop']]
 let index=0
 const f=fixture(async(_r,o)=>{const [text,finishReason]=outputs[index++]!;o.onVisible({kind:'delta',text});return {finishReason,usage:null}}),handle=f.begin().view.handle
 const result=await f.owner.executeLegacyRosterGeneration({handle})
 expect(f.spy).toHaveBeenCalledTimes(6);expect(result.run.artifacts).toHaveLength(6)
 expect(f.db.prepare('SELECT invocation_nonce FROM generation_attempts ORDER BY rowid').pluck().all()).toEqual(['legacy:initial:0','legacy:initial:1','legacy:initial:2','legacy:repair:0','legacy:repair:1','legacy:repair:2'])
 const tasks=f.spy.mock.calls.map(call=>(call[0] as {task:{messages:{content:string}[]}}).task)
 expect(tasks[2]!.messages[1]!.content).not.toContain('初始截断')
 expect(tasks[5]!.messages[1]!.content).not.toContain('\n修复截断\n')
 expect(f.owner.readLegacyRosterGeneration({handle}).artifact).toBeDefined()
 f.removeModel();const next=f.reopen();await next.executeLegacyRosterGeneration({handle})
 expect(next.beginLegacyRosterGeneration({modelId:'后来的默认模型',uiActionNonce:'旧名单修复'}).modelId).toBe('synthetic')
 expect(f.spy).toHaveBeenCalledTimes(6)
})
it.each(['semantic','unknown','length','syntax'] as const)('%s无效不会无限repair或重开发送',async mode=>{
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:mode==='semantic'?'{"schemaVersion":1,"entries":[]}':'坏JSON'});if(mode==='unknown')throw new Error('合成网络未知');return {finishReason:mode==='length'?'length':'stop',usage:null}}),handle=f.begin().view.handle
 await f.owner.executeLegacyRosterGeneration({handle})
 const expected=mode==='syntax'?2:mode==='length'?3:1
 expect(f.spy).toHaveBeenCalledTimes(expected)
 expect(f.owner.readLegacyRosterGeneration({handle}).artifact).toBeUndefined()
 const next=f.reopen();await next.executeLegacyRosterGeneration({handle})
 expect(f.spy).toHaveBeenCalledTimes(expected)
 expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
})
it('丢stage ACK重开原proposal可读，来源变化阻新stage，作者原文不覆盖',async()=>{
 const f=fixture(),handle=f.begin().view.handle;await f.owner.executeLegacyRosterGeneration({handle})
 const artifact=f.owner.readLegacyRosterGeneration({handle}).artifact!,proposal=f.owner.stageLegacyRosterGeneration({handle,artifact})
 f.db.exec("UPDATE character_roster_meta SET legacy_markdown='作者后来原文'")
 const next=f.reopen(),changes=f.db.prepare('SELECT total_changes()').pluck().get()
 expect(next.stageLegacyRosterGeneration({handle,artifact})).toEqual(proposal)
 expect(next.readLegacyRosterGeneration({handle})).toMatchObject({sourceStatus:'conflict',proposal})
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
 expect(f.db.prepare('SELECT legacy_markdown FROM character_roster_meta').pluck().get()).toBe('作者后来原文')
})
it('新repair前作者修改来源或取消不再派发，坏JSON原片保留',async()=>{
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'{坏语法'});f.db.exec("UPDATE character_roster_meta SET legacy_markdown='作者修改'");return {finishReason:'stop',usage:null}}),handle=f.begin().view.handle
 await expect(f.owner.executeLegacyRosterGeneration({handle})).rejects.toThrow('GENERATION_SOURCE_CHANGED')
 expect(f.spy).toHaveBeenCalledTimes(1)
 expect(f.owner.readLegacyRosterGeneration({handle}).view.artifacts).toHaveLength(1)
})
it('旧epoch候选显式批准后只写静态ID事实，动态状态保raw且ACK不重写作者后改',async()=>{
 const payload=JSON.parse(validOutput)
 payload.entries[0].currentState={location:'北塔',powerLevel:'普通',physicalState:'健康',mentalState:'冷静',keyItems:'铜钥匙',recentEvents:'抵达',updatedAtChapter:0}
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:JSON.stringify(payload)});return {finishReason:'stop',usage:null}}),handle=f.begin().view.handle
 await f.owner.executeLegacyRosterGeneration({handle})
 const artifact=f.owner.readLegacyRosterGeneration({handle}).artifact!,proposal=f.owner.stageLegacyRosterGeneration({handle,artifact})
 const next=f.reopen(),request={proposalBatchId:proposal.proposalBatchId,expectedRevision:proposal.revision,operationId:'作者采用',selections:proposal.items.map(item=>({selectionKey:item.selectionKey,action:'create' as const}))}
 expect(proposal.items[0]?.rawValue).toMatchObject({currentState:{location:'北塔'}})
 const approved=next.approveCharacterProposal(request)
 expect(approved.batch.status).toBe('approved')
 expect(f.db.prepare('SELECT name,cs_location FROM characters').get()).toEqual({name:'林岚',cs_location:''})
 f.db.exec("UPDATE characters SET name='作者后改'")
 const changes=f.db.prepare('SELECT total_changes()').pluck().get()
 expect(next.approveCharacterProposal(request)).toEqual(approved)
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
 expect(f.spy).toHaveBeenCalledTimes(1)
})
it('取消在途已知length不再请求replacement',async()=>{
 let release!:()=>void,started!:()=>void
 const wait=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve})
 const f=fixture(async(_r,o)=>{started();await wait;o.onVisible({kind:'delta',text:'截断'});return {finishReason:'length',usage:null}}),handle=f.begin().view.handle
 const pending=f.owner.executeLegacyRosterGeneration({handle});await entered;f.owner.cancelLegacyRosterGeneration({handle});release();await pending.catch(()=>undefined)
 expect(f.spy).toHaveBeenCalledTimes(1)
 expect(f.owner.readLegacyRosterGeneration({handle}).artifact).toBeUndefined()
})
it('并发execute跨syntaxrepair仍只有两次派发',async()=>{
 let release!:()=>void,started!:()=>void,calls=0
 const wait=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve})
 const f=fixture(async(_r,o)=>{if(calls++===0){started();await wait;o.onVisible({kind:'delta',text:'坏JSON'})}else o.onVisible({kind:'delta',text:validOutput});return {finishReason:'stop',usage:null}}),handle=f.begin().view.handle
 const first=f.owner.executeLegacyRosterGeneration({handle});await entered;const second=f.owner.executeLegacyRosterGeneration({handle});release()
 const [a,b]=await Promise.all([first,second])
 expect(a.run.artifacts).toEqual(b.run.artifacts);expect(f.spy).toHaveBeenCalledTimes(2)
})
it('既有卡片采用经owner真实source无模型，不能进入Markdown模型分支',()=>{
 const f=fixture()
 f.db.exec("INSERT INTO characters(character_id,name) VALUES('原ID','林岚'); UPDATE character_roster_meta SET migration_state='legacy_cards_preserved'")
 const source=f.owner.readLegacyRosterSource()
 expect(()=>f.begin()).toThrow('LEGACY_ROSTER_MODEL_SOURCE_REQUIRED')
 const receipt=f.owner.adoptLegacyCards({operationId:'直接采用',expectedRevision:source.snapshot.revision,expectedIdentityRevision:source.identityRevision,expectedFactsHash:source.factsHash,expectedLegacyHash:source.legacyHash})
 expect(receipt).toMatchObject({success:true,activeIds:['原ID'],snapshot:{status:'ready'}})
 expect(f.spy).not.toHaveBeenCalled()
})
