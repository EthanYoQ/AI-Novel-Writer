import { buildEditorInlineContext, editorInlineTask } from '../editor-inline-generation'
import { composePromptSystemRole, getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import type { EditorInlineContext } from '../../../src/shared/editor-inline-generation'
import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { getProjectDb, getCurrentProjectPath } from '../../database'
import { generationOutputContract } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const prose = '林岚走进北塔，灯火照亮了石阶。'.repeat(20)
function fixture(dispatch?: GenerationRunServiceDependencies['dispatch']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/editor-owner-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  prepareCanonicalStorageFixture(root)
  vi.mocked(getCurrentProjectPath).mockReturnValue(root)
  let db = new Database(path.join(root, '.ai-novel', 'project.db'))
  vi.mocked(getProjectDb).mockReturnValue(db)

  db.exec("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','合成审稿',100); INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔');")
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(prose)
  db.exec("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,280)")
  let model: ModelProfile | null = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const spy = vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch ?? (async (_request, options) => { options.onVisible({ kind: 'delta', text: '我会检查。<tool_call>{"name":"read_project_state","arguments":{}}</tool_call>' }); return { finishReason: 'stop', usage: null } }))
  let templateBody='固定作者模板 {{edit_instruction}}：{{selected_text}}'
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: (key: string) => JSON.stringify({key,content:templateBody,systemRole:'写作助手'}) }
  const makeOwner = (epoch: string) => createMainGenerationOwner({ database: db, projectId: 'project', epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: spy,
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch, modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  const owner = makeOwner('epoch-1')
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const reopenStorage = () => { owner.suspendForProjectClose(); db.close(); db = new Database(path.join(root, '.ai-novel', 'project.db')); deps.db = db; vi.mocked(getProjectDb).mockReturnValue(db); const next=makeOwner('epoch-2'); cleanup.unshift(()=>next.suspendForProjectClose()); return next }
  return {get db(){return db},owner,spy,reopenStorage,changeTemplate:()=>{templateBody='后来模板 {{selected_text}}'},removeModel:()=>{model=null}}
}

import { createHash } from 'node:crypto'
const input={action:'refine' as const,documentText:'甲😀林岚\r\n乙',from:1,to:5,selectedText:'😀林岚'}
const request={input,modelId:'synthetic',uiActionNonce:'作者润色'}
it('main实际模板与UTF16原文hash冻结，不把草稿声称为canonical',()=>{
 const f=fixture(),recovery=f.owner.beginEditorInline(request)
 expect(recovery.context).toMatchObject({...input,kind:'author-draft',documentHash:createHash('sha256').update(input.documentText).digest('hex'),template:{key:'edit_selected_text',content:'固定作者模板 {{edit_instruction}}：{{selected_text}}'}})
 expect(f.spy).not.toHaveBeenCalled()
 expect(()=>f.owner.beginEditorInline({...request,input:{...input,from:2}})).toThrow()
})
it('运行侧页的可恢复列表把选区建议列为选区恢复，不当作单章候选',async()=>{
 const f=fixture(),recovery=f.owner.beginEditorInline(request)
 await f.owner.executeEditorInline(recovery.view.handle)
 const list=f.reopenStorage().listRecovery()
 expect(list.editors.map(item=>item.view.handle.runId)).toEqual([recovery.view.handle.runId])
 expect(list).toMatchObject({drafts:[],planning:[],reviews:[],partial:false})
})
it('同nonce不同作者输入拒绝，generic begin/execute不能绕过editor owner',async()=>{
 const f=fixture(),recovery=f.owner.beginEditorInline(request)
 expect(()=>f.owner.beginEditorInline({...request,input:{...input,action:'expand'}})).toThrow()
 expect(()=>f.owner.begin({operation:'editor-inline',uiActionNonce:'伪造',modelId:'synthetic',promptKeys:['edit_selected_text'],skillStages:[],selectedDraftIds:[],selectedFinalizedDraftIds:[],output:'visible-text'})).toThrow()
 await expect(f.owner.execute({handle:recovery.view.handle,invocationNonce:'伪请求',task:{purpose:'editor-ai-refine',output:'visible-text',messages:[]}})).rejects.toThrow()
 expect(f.spy).not.toHaveBeenCalled()
})
it.each(['stop','unknown'] as const)('%s并发只发一次，重开改变模板删除模型仍读原候选',async mode=>{
 let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve})
 const f=fixture(async(_r,o)=>{await pending;o.onVisible({kind:'delta',text:'林岚停下脚步。'});if(mode==='unknown')throw new Error('合成网络中断');return {finishReason:'stop',usage:null}})
 const recovery=f.owner.beginEditorInline(request),handle=recovery.view.handle
 const a=f.owner.executeEditorInline(handle),b=f.owner.executeEditorInline(handle)
 release();const receipt=await a;expect(await b).toEqual(receipt)
 expect(f.spy).toHaveBeenCalledTimes(1)
 expect(JSON.stringify(f.spy.mock.calls[0]![0])).toContain('固定作者模板')
 expect(JSON.stringify(f.spy.mock.calls[0]![0])).toContain(input.selectedText)
 f.changeTemplate();f.removeModel();const next=f.reopenStorage()
 const read=next.readEditorInlineRecovery(handle)
 expect(read.modelId).toBe('synthetic');expect(read.context).toEqual(recovery.context)
 const replay=await next.executeEditorInline(handle)
 expect(replay.run.artifacts).toEqual(receipt.run.artifacts)
 expect(replay.outcome.status).toBe(receipt.outcome.status)
 expect(f.spy).toHaveBeenCalledTimes(1)
})
it('取消后晚回调不回写，未发送取消拒绝dispatch',async()=>{
 let release!:()=>void,started!:()=>void
 const pending=new Promise<void>(resolve=>{release=resolve}),visible=new Promise<void>(resolve=>{started=resolve})
 const f=fixture(async(_r,o)=>{started();await pending;o.onVisible({kind:'delta',text:'取消后的文字'});return {finishReason:'stop',usage:null}})
 const handle=f.owner.beginEditorInline(request).view.handle
 const running=f.owner.executeEditorInline(handle);await visible
 f.owner.cancel(handle);release();await running
 expect(f.owner.read(handle).artifacts.every(item=>!item.text.includes('取消后的文字'))).toBe(true)
 const second=f.owner.beginEditorInline({...request,uiActionNonce:'第二作者动作'}).view.handle
 f.owner.cancel(second);await expect(f.owner.executeEditorInline(second)).rejects.toThrow()
 expect(f.spy).toHaveBeenCalledTimes(1)
})

const note='把林岚改成第一人称，语气更冷'
const noted={...request,uiActionNonce:'作者按意见改',input:{...input,action:'instruct' as const,instruction:note}}
it.each([
 ['缺少意见',{...input,action:'instruct'}],
 ['意见为空白',{...input,action:'instruct',instruction:' \n '}],
 ['意见不是字符串',{...input,action:'instruct',instruction:42}],
 ['意见超过2000字',{...input,action:'instruct',instruction:'冷'.repeat(2001)}],
 ['其他动作带意见',{...input,action:'refine',instruction:note}],
 ['动作不是字符串',{...input,action:['refine']}],
])('%s时拒绝开始运行',(_name,bad)=>{
 const f=fixture()
 expect(()=>f.owner.beginEditorInline({...request,input:bad as never})).toThrow('GENERATION_EDITOR_INPUT_INVALID')
 expect(f.spy).not.toHaveBeenCalled()
})
it('意见里的 $$、$& 与模板占位按字面进入模型请求',async()=>{
 const f=fixture(async()=>({finishReason:'stop',usage:null}))
 const instruction='价格写成 $$5，保留 $& 与 {{selected_text}} 原样'
 const handle=f.owner.beginEditorInline({...noted,input:{...noted.input,instruction}}).view.handle
 await f.owner.executeEditorInline(handle)
 const {task}=f.spy.mock.calls[0]![0] as {task:{messages:{role:string;content:string}[]}}
 const user=task.messages.find(m=>m.role==='user')!.content
 expect(user).toContain(instruction)
 expect(user.split(input.selectedText)).toHaveLength(2)
})
it('意见恰好2000字可以开始运行',()=>{
 const f=fixture(),instruction='冷'.repeat(2000)
 expect(f.owner.beginEditorInline({...noted,input:{...noted.input,instruction}}).context).toMatchObject({action:'instruct',instruction})
})
it('作者意见进入模型请求，并随运行冻结到重开之后',async()=>{
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'我停下脚步。'});return {finishReason:'stop',usage:null}})
 const handle=f.owner.beginEditorInline(noted).view.handle
 await f.owner.executeEditorInline(handle)
 const sent=JSON.stringify(f.spy.mock.calls[0]![0])
 expect(sent).toContain(note)
 expect(sent).toContain(input.selectedText)
 const next=f.reopenStorage()
 expect(next.readEditorInlineRecovery(handle).context).toMatchObject({action:'instruct',instruction:note,selectedText:input.selectedText})
 expect(()=>next.beginEditorInline({...noted,input:{...noted.input,instruction:'改成对话'}})).toThrow()
})

const systemOf=(context:EditorInlineContext)=>editorInlineTask(context).messages.find(m=>m.role==='system')!.content
it.each([
 ['zh-CN','改成第一人称',['保留要求冲突','以作者意见为准','没提到','照常保留']],
 ['en-US','Rewrite it in first person',['conflicts with the preservation','follow the note','does not mention','keep']],
] as const)('%s 按意见改时，系统规则让作者意见压过内置模板的保留视角要求',(language,instruction,rule)=>{
 const template=getBuiltinPromptTemplate('edit_selected_text',language)!
 const system=systemOf(buildEditorInlineContext({...input,action:'instruct',instruction},language,template))
 expect(system).toContain(template.systemRole!)
 for(const phrase of rule) expect(system).toContain(phrase)
 for(const action of ['refine','expand','continue','dialogue'] as const){
  const fixed=systemOf(buildEditorInlineContext({...input,action},language,template))
  expect(fixed).toBe(composePromptSystemRole(template,language))
 }
})

it.each([
 ['zh-CN','【不可变系统合同】',['下文合同','最新的作者明确事实']],
 ['en-US','[Immutable system contract]',['the contract below','newest explicit author fact']],
] as const)('%s 按意见删掉选区里的事实时，规则明确压过下文合同的明确事实条，合同本身逐字不变',(language,heading,rule)=>{
 const template=getBuiltinPromptTemplate('edit_selected_text',language)!
 const system=systemOf(buildEditorInlineContext({...input,action:'instruct',instruction:'删掉银镯这个细节'},language,template))
 const [role,contract]=system.split(heading)
 for(const phrase of rule) expect(role).toContain(phrase)
 expect(contract).toBe(composePromptSystemRole(template,language).split(heading)[1])
})
