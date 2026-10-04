import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { MAIN_GENERATION_POLICY } from '../main-generation-plan'
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
    buildBinding: (selection, modelReceipt) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch, modelReceipt, policy: MAIN_GENERATION_POLICY, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt, MAIN_GENERATION_POLICY).binding })
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
