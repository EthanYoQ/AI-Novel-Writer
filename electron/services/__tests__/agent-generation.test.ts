import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { MAIN_GENERATION_POLICY } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { getProjectDb } from '../../database'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'

vi.mock('../../database', () => ({ getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn(() => null) }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const prose = '林岚走进北塔，灯火照亮了石阶。'.repeat(20)
import type { AgentGenerationInput } from '../../../src/shared/agent-generation'
function fixture(dispatch?: GenerationRunServiceDependencies['dispatch']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/agent-owner-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  let db = new Database(path.join(root, 'project.db'))
  vi.mocked(getProjectDb).mockReturnValue(db)
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.exec("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','合成审稿',100); INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔');")
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(prose)
  db.exec("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,280)")
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const spy = vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch ?? (async (_request, options) => { options.onVisible({ kind: 'delta', text: '我会检查。<tool_call>{"name":"read_project_state","arguments":{}}</tool_call>' }); return { finishReason: 'stop', usage: null } }))
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: () => JSON.stringify({key:'assistant_writing_identity',content:'冻结的合成提示词',systemRole:'写作助手'}) }
  const makeOwner = (epoch: string) => createMainGenerationOwner({ database: db, projectId: 'project', epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: spy,
    buildBinding: (selection, modelReceipt) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch, modelReceipt, policy: MAIN_GENERATION_POLICY, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt, MAIN_GENERATION_POLICY).binding })
  const owner = makeOwner('epoch-1')
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const reopenStorage = () => { owner.suspendForProjectClose(); db.close(); db = new Database(path.join(root, 'project.db')); deps.db = db; vi.mocked(getProjectDb).mockReturnValue(db); const next=makeOwner('epoch-2'); cleanup.unshift(()=>next.suspendForProjectClose()); return next }
  const input: AgentGenerationInput = {mode:'planning',uiLocale:'zh-CN',historyMessages:[],userMessage:'帮我检查项目',tools:['read_project_state','start_workflow','propose_novel_config','propose_chapter_blueprint'].map(name=>({name,description:'合成工具',inputSchema:{type:'object'},requiresConfirmation:true,isReadOnly:false,source:'builtin'}))}
  const request={uiActionNonce:'作者动作',modelId:model.id,input}
  const begin=()=>owner.agents.begin(request)
  const round=async()=>{const start=begin();return owner.agents.executeRound({handle:start.handle,index:0})}
  return {get db(){return db},owner,spy,request,begin,round,reopenStorage}
}

describe('Agent actual owner 与文件 SQLite',()=>{
 it.each(['xml','json'])('仅visible进入artifact，%s工具协议保存为attempt控制元数据',async format=>{
  const raw=format==='xml'?'可见回答。<tool_call>{"name":"read_project_state","arguments":{"section":"core"}}</tool_call>':JSON.stringify({name:'read_project_state',arguments:{section:'core'}})
  const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:raw});return {finishReason:'stop',usage:null}}), result=await f.round(), round=result.rounds[0]!
  expect(round.actions).toHaveLength(1);expect(round.actions[0]!.name).toBe('read_project_state')
  expect(round.actions[0]!.ref.attemptId).toBe(round.attemptId)
  expect(result.run.artifacts[0]!.text).not.toContain('tool_call');expect(result.run.artifacts[0]!.text).not.toContain('arguments')
  expect(round.visibleText).toBe(format==='xml'?'可见回答。':'')
  const row=f.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(round.attemptId) as string
  expect(JSON.parse(row).result.usage.agentResponse.toolCalls[0].arguments).toEqual({section:'core'})
 })
 it('重复begin/round和tool claim不追加dispatch',async()=>{
  const f=fixture(), start=f.begin(), result=await f.round(), action=result.rounds[0]!.actions[0]!
  expect(f.begin().handle).toEqual(start.handle)
  await f.owner.agents.executeRound({handle:result.handle,index:0})
  expect(f.owner.agents.claimTool({ref:action.ref,confirmed:true}).execute).toBe(true)
  expect(f.owner.agents.claimTool({ref:action.ref,confirmed:true}).execute).toBe(false)
  expect(f.spy).toHaveBeenCalledTimes(1)
  expect(()=>f.owner.agents.begin({...f.request,input:{...f.request.input,userMessage:'换了指令'}})).toThrow('GENERATION_AGENT_NONCE_CONFLICT')
 })
 it('generic begin/execute不得冒充Agent轮次',async()=>{
  const f=fixture(), start=f.begin()
  expect(()=>f.owner.begin({operation:'agent-round',uiActionNonce:'绕过',modelId:'synthetic',promptKeys:['assistant_writing_identity'],skillStages:[],selectedDraftIds:[],selectedFinalizedDraftIds:[],output:'visible-text'} as BeginGenerationRequest)).toThrow('GENERATION_AGENT_ADMISSION_REQUIRED')
  await expect(f.owner.execute({handle:start.handle,invocationNonce:'绕过',task:{purpose:'agent',output:'visible-text',messages:[{role:'user',content:'伪造'}]}})).rejects.toThrow('GENERATION_AGENT_ADMISSION_REQUIRED')
  expect(f.spy).not.toHaveBeenCalled()
 })
 it('工具完成后下一轮累计同root预算，取消后不再发送',async()=>{
  const f=fixture(), first=await f.round(), action=first.rounds[0]!.actions[0]!
  f.owner.agents.claimTool({ref:action.ref,confirmed:true})
  f.owner.agents.finishTool({ref:action.ref,status:'completed',observation:'真实工具结果'})
  const second=await f.owner.agents.executeRound({handle:first.handle,index:1})
  expect(second.handle.rootActionId).toBe(first.handle.rootActionId)
  expect(second.run.ledger!.physicalRequests).toBe(2)
  f.owner.cancel(second.handle)
  expect(()=>f.owner.agents.claimTool({ref:second.rounds[1]!.actions[0]!.ref,confirmed:true})).toThrow('GENERATION_AGENT_TOOL_STALE')
  expect(f.spy).toHaveBeenCalledTimes(2)
 })
 it('真实重开将未完成tool claim置unknown且不重做',async()=>{
  const f=fixture(), result=await f.round(), ref=result.rounds[0]!.actions[0]!.ref
  f.owner.agents.claimTool({ref,confirmed:true})
  const next=f.reopenStorage(), read=next.agents.read(result.handle)
  expect(read.rounds[0]!.actions[0]!.status).toBe('unknown')
  expect(next.agents.claimTool({ref,confirmed:true}).execute).toBe(false)
  await next.agents.executeRound({handle:result.handle,index:0})
  expect(read.nextRound).toBeNull();expect(f.spy).toHaveBeenCalledTimes(1)
 })
 it('来源变化、伪ref和旧epoch的pending工具拒绝',async()=>{
  const f=fixture(), result=await f.round(), ref=result.rounds[0]!.actions[0]!.ref
  expect(()=>f.owner.agents.claimTool({ref:{...ref,toolCallId:'伪造'},confirmed:true})).toThrow('GENERATION_AGENT_TOOL_IDENTITY_MISMATCH')
  f.db.exec("UPDATE project_core SET global_guidance='作者修改'")
  expect(()=>f.owner.agents.claimTool({ref,confirmed:true})).toThrow('GENERATION_AGENT_TOOL_STALE')
  const next=f.reopenStorage()
  expect(()=>next.agents.claimTool({ref,confirmed:true})).toThrow('GENERATION_AGENT_TOOL_STALE')
 })
 it('工作流registration从实际tool args稳定推导parent与model',async()=>{
  const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'<tool_call>{"name":"start_workflow","arguments":{"workflow":"generate_draft","chapter_number":2}}</tool_call>'});return {finishReason:'stop',usage:null}})
  const result=await f.round(), ref=result.rounds[0]!.actions[0]!.ref
  expect(()=>f.owner.agents.registerWorkflow(ref)).toThrow('GENERATION_AGENT_WORKFLOW_NOT_AUTHORIZED')
  f.owner.agents.claimTool({ref,confirmed:true})
  const registration=f.owner.agents.registerWorkflow(ref)
  expect(registration).toMatchObject({workflow:'generate_draft',chapterNumber:2,parentHandle:result.handle,modelId:'synthetic',state:'registered'})
  expect(f.owner.agents.registerWorkflow(ref)).toEqual(registration)
 })
 it('只有config完成后才派生作者确认的blueprint动作',async()=>{
  const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'<tool_call>{"name":"propose_novel_config","arguments":{"changes":{"genre":"玄幻"}}}</tool_call>'});return {finishReason:'stop',usage:null}})
  const result=await f.round(), ref=result.rounds[0]!.actions[0]!.ref
  const proposals=[{name:'propose_chapter_blueprint' as const,arguments:{chapter_number:1,changes:{title:'作者新标题'}}}]
  f.owner.agents.claimTool({ref,confirmed:true,authorBlueprintProposals:proposals})
  expect(f.owner.agents.read(result.handle).rounds[0]!.actions).toHaveLength(1)
  expect(()=>f.owner.agents.finishTool({ref,status:'completed',observation:'假完成'})).toThrow('GENERATION_AGENT_DOMAIN_EFFECT_REQUIRED')
  f.owner.agents.commitDomainTool(ref)
  expect(f.db.prepare("SELECT genre FROM project_core WHERE id='main'").pluck().get()).toBe('玄幻')
  f.owner.agents.finishTool({ref,status:'completed',observation:'配置已保存'})
  const actions=f.owner.agents.read(result.handle).rounds[0]!.actions
  expect(actions).toHaveLength(2);expect(actions[1]).toMatchObject({name:'propose_chapter_blueprint',arguments:proposals[0]!.arguments,status:'pending'})
  expect(actions[1]!.ref.toolCallId).toContain(':author:0')
 })
})

it('provider发送后unknown真实重开仍不重发',async()=>{
 const f=fixture(async()=>{throw new Error('合成发送后断线')}), result=await f.round()
 expect(result.rounds[0]!.status).toBe('unknown')
 const next=f.reopenStorage()
 const retry=await next.agents.executeRound({handle:result.handle,index:0})
 expect(retry.rounds[0]!.status).toBe('unknown');expect(f.spy).toHaveBeenCalledTimes(1)
})
it('取消后late provider正文不成为artifact或工具动作',async()=>{
 let deliver: (()=>void)|undefined
 const f=fixture((_r,o)=>new Promise(resolve=>{deliver=()=>{o.onVisible({kind:'delta',text:'迟到正文<tool_call>{"name":"read_project_state","arguments":{}}</tool_call>'});resolve({finishReason:'stop',usage:null})}}))
 const start=f.begin(), pending=f.owner.agents.executeRound({handle:start.handle,index:0})
 await vi.waitFor(()=>expect(deliver).toBeTypeOf('function'))
 f.owner.cancel(start.handle);deliver!();await pending
 const read=f.owner.agents.read(start.handle)
 expect(read.rounds[0]!.visibleText).toBe('');expect(read.rounds[0]!.actions).toEqual([])
 expect(read.run.status).toBe('cancelled');expect(f.spy).toHaveBeenCalledTimes(1)
})

it('registered child 同root计账且伪parent/缺registration拒绝',async()=>{
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'<tool_call>{"name":"start_workflow","arguments":{"workflow":"generate_blueprint"}}</tool_call>'});return {finishReason:'stop',usage:null}})
 const result=await f.round(),ref=result.rounds[0]!.actions[0]!.ref
 f.owner.agents.claimTool({ref,confirmed:true});const registration=f.owner.agents.registerWorkflow(ref)
 const selection: BeginGenerationRequest={operation:'chapter-blueprint-directory',uiActionNonce:'子流程',modelId:'synthetic',promptKeys:['directory'],skillStages:[],selectedDraftIds:[],selectedFinalizedDraftIds:[],output:'structured-data',parentRootActionId:result.handle.rootActionId,agentWorkflowRegistrationId:registration.registrationId}
 expect(()=>f.owner.begin({...selection,parentRootActionId:'伪造父动作'})).toThrow('GENERATION_AGENT_CHILD_NOT_AUTHORIZED')
 expect(()=>f.owner.begin({...selection,agentWorkflowRegistrationId:undefined})).toThrow('GENERATION_AGENT_REGISTRATION_REQUIRED')
 const child=f.owner.begin(selection)
 expect(child.handle.rootActionId).toBe(result.handle.rootActionId)
 expect(f.owner.begin({...selection,uiActionNonce:'重复工具返回'}).handle).toEqual(child.handle)
 await f.owner.execute({handle:child.handle,invocationNonce:'子请求',task:{purpose:'directory',output:'structured-data',messages:[{role:'user',content:'子任务'}]}})
 expect(f.owner.read(child.handle).ledger!.physicalRequests).toBe(2)
 expect(f.owner.agents.read(result.handle).rounds[0]!.actions[0]!.workflow?.childHandles).toEqual([child.handle])
})

async function configAction() {
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'<tool_call>{"name":"propose_novel_config","arguments":{"changes":{"genre":"玄幻"}}}</tool_call>'});return {finishReason:'stop',usage:null}})
 f.db.exec("INSERT INTO blueprints(chapter_number,title) VALUES(2,'第二章')")
 const recovery=await f.round(),ref=recovery.rounds[0]!.actions[0]!.ref
 return Object.assign(f,{recovery,ref})
}
it('实际config及两次blueprint effect推进可信来源，下一轮同root读取新事实',async()=>{
 const f=await configAction()
 const selections=[1,2].map(chapter=>({name:'propose_chapter_blueprint' as const,arguments:{chapter_number:chapter,changes:{title:`作者确认第${chapter}章`}}}))
 f.owner.agents.claimTool({ref:f.ref,confirmed:true,authorBlueprintProposals:selections})
 f.owner.agents.commitDomainTool(f.ref)
 expect(f.owner.agents.read(f.recovery.handle).sourceStatus).toBe('current')
 f.owner.agents.finishTool({ref:f.ref,status:'completed',observation:'配置已保存'})
 const actions=f.owner.agents.read(f.recovery.handle).rounds[0]!.actions
 for(const action of actions.slice(1)) {
  expect(f.owner.agents.claimTool({ref:action.ref,confirmed:true}).execute).toBe(true)
  const receipt=f.owner.agents.commitDomainTool(action.ref)
  expect(receipt.kind).toBe('blueprint')
  f.owner.agents.finishTool({ref:action.ref,status:'completed',observation:'蓝图已保存'})
  expect(f.owner.agents.read(f.recovery.handle).sourceStatus).toBe('current')
 }
 expect(f.db.prepare('SELECT title FROM blueprints ORDER BY chapter_number').pluck().all()).toEqual(['作者确认第1章','作者确认第2章'])
 const next=await f.owner.agents.executeRound({handle:f.recovery.handle,index:1})
 expect(next.handle.rootActionId).toBe(f.recovery.handle.rootActionId)
 expect(next.run.ledger!.physicalRequests).toBe(2)
 const binding=JSON.parse(f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(next.handle.runId) as string)
 expect(binding.sourceManifest.agentContext.initialMessages[0].content).toContain('玄幻')
})
it('外部配置改变后拒绝config commit且保留作者值',async()=>{
 const f=await configAction();f.owner.agents.claimTool({ref:f.ref,confirmed:true})
 f.db.exec("UPDATE project_core SET genre='作者外部编辑'")
 expect(()=>f.owner.agents.commitDomainTool(f.ref)).toThrow('GENERATION_AGENT_DOMAIN_TOOL_NOT_AUTHORIZED')
 expect(f.db.prepare('SELECT genre FROM project_core').pluck().get()).toBe('作者外部编辑')
})
it('可信effect之后外部蓝图改动仍拒绝后续claim',async()=>{
 const f=await configAction()
 f.owner.agents.claimTool({ref:f.ref,confirmed:true,authorBlueprintProposals:[{name:'propose_chapter_blueprint',arguments:{chapter_number:1,changes:{title:'建议标题'}}}]})
 f.owner.agents.commitDomainTool(f.ref);f.owner.agents.finishTool({ref:f.ref,status:'completed',observation:'配置已保存'})
 const child=f.owner.agents.read(f.recovery.handle).rounds[0]!.actions[1]!
 f.db.exec("UPDATE blueprints SET title='作者外部蓝图' WHERE chapter_number=1")
 expect(()=>f.owner.agents.claimTool({ref:child.ref,confirmed:true})).toThrow('GENERATION_AGENT_TOOL_STALE')
})
it('effect回执写入失败回滚实际config和source transition，重试仅一次写',async()=>{
 const f=await configAction();f.owner.agents.claimTool({ref:f.ref,confirmed:true})
 const before=f.db.prepare('SELECT * FROM project_core').get(), usage=f.db.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get()
 f.db.exec("CREATE TRIGGER synthetic_effect_failure BEFORE UPDATE OF usage_receipt_json ON generation_attempts BEGIN SELECT RAISE(ABORT,'synthetic effect failure'); END")
 expect(()=>f.owner.agents.commitDomainTool(f.ref)).toThrow('synthetic effect failure')
 expect(f.db.prepare('SELECT * FROM project_core').get()).toEqual(before)
 expect(f.db.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get()).toEqual(usage)
 f.db.exec('DROP TRIGGER synthetic_effect_failure')
 expect(f.owner.agents.commitDomainTool(f.ref).kind).toBe('config')
})
it('config effect丢ACK真实重开回读原收据，不重复写或dispatch',async()=>{
 const f=await configAction();f.owner.agents.claimTool({ref:f.ref,confirmed:true})
 const receipt=f.owner.agents.commitDomainTool(f.ref)
 const next=f.reopenStorage()
 f.db.exec("CREATE TRIGGER reject_replayed_config BEFORE UPDATE ON project_core BEGIN SELECT RAISE(ABORT,'replayed config write'); END")
 const recovery=next.agents.read(f.recovery.handle)
 expect(recovery.rounds[0]!.actions[0]!.status).toBe('completed')
 expect(next.agents.claimTool({ref:f.ref,confirmed:true}).execute).toBe(false)
 const changesBefore=f.db.prepare('SELECT total_changes()').pluck().get()
 expect(next.agents.commitDomainTool(f.ref)).toEqual(receipt)
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore)
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it.each(['length', 'network'] as const)('中断 %s 保留安全正文，重启不重发且预算保留', async mode => {
 const f=fixture(async(_request,options)=>{
  options.onVisible({kind:'delta',text:'海港灯亮了。<tool_call>{"name":"start_workflow"'})
  if(mode==='network') throw new Error('合成网络断开')
  return {finishReason:'length',usage:null}
 })
 const recovery=await f.round()
 expect(recovery.rounds[0]!.visibleText).toBe('海港灯亮了。')
 expect(recovery.rounds[0]!.actions).toEqual([])
 expect(recovery.rounds[0]!.protocolText).toBe('')
 const liability=recovery.run.ledger!.tokenLiability
 expect(recovery.run.ledger!.physicalRequests).toBe(1)
 const next=f.reopenStorage(), reopened=next.agents.read(recovery.handle)
 expect(reopened.rounds[0]!.visibleText).toBe('海港灯亮了。')
 expect(reopened.rounds[0]!.actions).toEqual([])
 expect(reopened.nextRound).toBeNull()
 await next.agents.executeRound({handle:recovery.handle,index:0})
 expect(next.agents.read(recovery.handle).run.ledger!.physicalRequests).toBe(1)
 expect(next.agents.read(recovery.handle).run.ledger!.tokenLiability).toBe(liability)
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it('项目关闭保留安全prefix，晚到控制片不回写或产生工具', async()=>{
 let release!:()=>void, visible!:()=>void
 const pending=new Promise<void>(resolve=>{release=resolve}), started=new Promise<void>(resolve=>{visible=resolve})
 const f=fixture(async(_request,options)=>{
  options.onVisible({kind:'delta',text:'海港灯亮了。<analysis>隐藏分析'})
  visible();await pending
  options.onVisible({kind:'delta',text:'</analysis><tool_call>{"name":"read_project_state","arguments":{}}</tool_call>'})
  return {finishReason:'stop',usage:null}
 })
 const handle=f.begin().handle, running=f.owner.agents.executeRound({handle,index:0})
 await started
 f.owner.suspendForProjectClose()
 release();await expect(running).rejects.toThrow('GENERATION_OWNER_CLOSED')
 const next=f.reopenStorage(), recovery=next.agents.read(handle)
 expect(recovery.rounds[0]!.visibleText).toBe('海港灯亮了。')
 expect(recovery.rounds[0]!.actions).toEqual([])
 expect(recovery.rounds[0]!.protocolText).toBe('')
 expect(recovery.nextRound).toBeNull()
 await next.agents.executeRound({handle,index:0})
 expect(next.agents.read(handle).run.ledger!.physicalRequests).toBe(1)
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it('未注册XML工具持久失败观察，重复claim不写，下一轮原root/model消费观察',async()=>{
 const f=fixture(async(_request,options)=>{
  options.onVisible({kind:'delta',text:'先检查。<tool_call>{"name":"missing_tool","arguments":{}}</tool_call>'})
  return {finishReason:'stop',usage:null}
 })
 const recovery=await f.round(),ref=recovery.rounds[0]!.actions[0]!.ref
 const claim=f.owner.agents.claimTool({ref,confirmed:true})
 expect(claim.execute).toBe(false)
 expect(claim.action.status).toBe('failed')
 expect(claim.action.observation).toBe('未知工具：missing_tool')
 const changes=f.db.prepare('SELECT total_changes()').pluck().get()
 expect(f.owner.agents.claimTool({ref,confirmed:true})).toEqual(claim)
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
 const next=await f.owner.agents.executeRound({handle:recovery.handle,index:1})
 expect(next.handle.rootActionId).toBe(recovery.handle.rootActionId)
 expect(next.modelId).toBe(recovery.modelId)
 expect(next.run.ledger!.physicalRequests).toBe(2)
 expect(JSON.stringify(f.spy.mock.calls[1]![0])).toContain(claim.action.observation!)
 expect(f.spy).toHaveBeenCalledTimes(2)
})
